/**
 * 赛季调度器:第一场端到端(串行)赛季(hld §8.1 / §8.3 / §9,票 06)。
 *
 * ── 这一票走通的窄路 ──────────────────────────────────────────────────────
 *
 * `modelwar run --config season.yaml` 第一次真的跑起来:读 `season.yaml`(票 05 的
 * `loadSeasonConfig`)→ 规则版本**前置拒绝** → `enumerateMatchUps` 枚举对局 → 逐局把输入
 * **物化**成 `input.json` → spawn 一个 `modelwar match <input.json>` 子进程执行该局 →
 * 读回放末行拿到名次 → 产出最小 `report.json`。
 *
 * ── 为什么这里只有「串行」而没有并发池 ────────────────────────────────────
 *
 * 票 06 只要「第一场端到端赛季跑得通」,零并发(一个 `for … await`)就够。并发上限
 * (`min(cpus, 8)`)、退出码 2/3 的**重跑一次 / 剔除**、问题清单,全归票 07;
 * 本文件把那三处**留出来但不实现**,免得后来者以为漏了(见下面 `TODO(票 07)`)。
 *
 * ── 「只认退出码」与异常路径的最小行为 ────────────────────────────────────
 *
 * 子进程成败**只看退出码**(真源 `apps/cli/src/exit-codes.ts`:0 正常 / 1 装载期 / 2 引擎故障 /
 * 3 不确定超时 / 4 内部错),不解析 stdout 判成败。票 06 的最小口径:
 *   - `0` → 读回放末行 `result`,入报告;
 *   - 非 `0` → 打印 stderr 并**以非零退出中止整季**(不静默忽略)。
 * 票 07 会把 2 / 3 从「中止」改成「重跑一次 → 再触发则记入问题清单、排除出排名」,并把 1 / 4
 * 固定为赛季级中止。本票先把「非零绝不静默」这条底线立住。
 *
 * ── 规则版本隔离是**前置拒绝**,不是报告分组 ─────────────────────────────
 *
 * 赛季声明单一 `ruleset`;启动即逐参赛者读 `archive/<slug>/<runId>/meta.json` 的 `ruleset`
 * 字段,任一与赛季声明不一致 → stderr 报错 + 退出码 1,不在同一份报告里分版本分节
 * (spec《规则版本隔离(前置拒绝,非分组)》,复用 FR-10 AC2 的拒跑口径)。
 *
 * **这里只比对 `meta.ruleset` 这一个字段**:完整校验(逐座位哈希、缺档、规则集三处一致、
 * 沙箱 runtime hash)仍由 `modelwar match` 子进程的装载段(退 1)承担——那是 `validateArchiveMeta`
 * 的唯一生产调用点,runner 的依赖面(`@model-war/schema` + node 内建)拿不到 `apps/cli` 的 ajv
 * 校验栈。本文件是「前置拒绝」的那一道,不是「完整校验」的第二份实现。
 *
 * ── 依赖方向 ──────────────────────────────────────────────────────────────
 *
 * 本文件只 import `@model-war/schema` 与 node 内建(`node:crypto` / `node:fs` / `node:path` /
 * `node:child_process` / `node:os`)。**不得 import engine**;也不新增 `runner → gen` 的边
 * (故 `sha256Hex` / `runIdOf` / YAML 子集读取器在 runner 内各留一份私有实现)。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  type MatchInput,
  type MatchInputArchive,
  type MatchInputArchives,
} from "@model-war/schema";
import { enumerateMatchUps, type MatchUp } from "./enumerate.js";
import { loadSeasonConfig, type SeasonConfig } from "./season-config.js";

/** 正常退出(与 `apps/cli/src/exit-codes.ts` 的 `EXIT_OK` 同值;runner 不 import CLI,故本地定型)。 */
const EXIT_OK = 0;

/** 赛季级失败(装载、规则版本不一致、子进程非零中止)。 */
const EXIT_FAILED = 1;

/** 其它内部错(与 `apps/cli/src/exit-codes.ts` 的 `EXIT_INTERNAL` 同值)。 */
const EXIT_INTERNAL = 4;

/** 对局输入 `input.json` 的键集与**书写序**(须与 `MatchInput` / `REQUIRED_KEYS` 逐字一致)。 */
const INPUT_KEYS = ["archives", "map", "mapSha256", "seed", "ruleset"] as const;

/** 存档拓扑里的两个文件名(真源在 `packages/gen/src/archive.ts`,runner 不得 import gen,故写字面量)。 */
const SCRIPT_PRODUCT_NAME = "script.js";
const META_NAME = "meta.json";

/** 一局对局跑完后入报告的最小一行。 */
export type ReportedMatch = {
  /** 组合标识 `c<k>`。 */
  readonly comboId: string;
  /** 地图标识。 */
  readonly map: string;
  /** 写进 `input.json` 的确定性派生种子。 */
  readonly seed: number;
  /** `input.json` 相对赛季根(`root`)的路径,供复算。 */
  readonly inputPath: string;
  /** 回放末行 `result.rankings`,下标即座位。 */
  readonly rankings: readonly number[];
  /** 回放末行 `result.reason`。 */
  readonly reason: string;
};

/**
 * 最小 `report.json`:每局的输入引用 + 结果(票 06 只到这一步)。
 * 每模型总分 / 有效局数 / 失败名单 / 问题清单归票 07 与票 08,本形状随它们扩展。
 */
export type SeasonReport = {
  readonly runId: string;
  readonly ruleset: string;
  readonly matches: readonly ReportedMatch[];
};

/** `scheduleSeason` 的注入缝:子进程执行一局,只回退出码(票 07 在这里换真并发池)。 */
export type SeasonSchedulerDeps = {
  /** 执行一局;`inputPath` 是已物化的 `input.json` 绝对路径。只认返回的退出码(null = 被信号杀)。 */
  readonly spawnMatch: (inputPath: string) => Promise<{ readonly code: number | null }>;
};

/** `scheduleSeason` 的入参:赛季根 + `--config` 的取值(`--config` 相对根)。 */
export type ScheduleSeasonOptions = {
  readonly root: string;
  readonly configPath: string;
  /** 当前时刻(测试可注入);缺省 `() => new Date()`。runId 与 outputDir 的默认值都由它定。 */
  readonly now?: () => Date;
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** sha256(小写十六进制)。与 `packages/gen/src/archive.ts` 的同名 helper 逐字同义(各留一份,不跨包)。 */
const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** 时间戳形态的 `runId`:`:` / `.` 换成 `-`,让它能直接当目录名(与 gen 的 `runIdOf` 同款)。 */
const runIdOf = (at: Date): string => at.toISOString().replaceAll(":", "-").replace(".", "-");

/** 读文件为 utf8;失败时把路径写进消息(不吞原因)。 */
const readText = (filePath: string): string => {
  try {
    return readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new Error(`读不到 ${filePath}:${messageOf(cause)}`);
  }
};

/**
 * 规则版本前置拒绝:逐个参赛者读 `meta.json` 的 `ruleset`,返回第一条与赛季声明不一致的
 * 说明(路径 + 声明值 + 期望值);全一致则返回 `undefined`。
 *
 * 读不到 `meta.json`(存档不存在 / 半截产物)也在此拦下——存在性检查是豁免不了的。
 */
const findRulesetMismatch = (root: string, season: SeasonConfig): string | undefined => {
  for (const archivePath of season.participants) {
    const metaPath = join(root, archivePath, META_NAME);
    const source = readText(metaPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (cause) {
      throw new Error(`存档元数据 ${metaPath} 不是合法 JSON:${messageOf(cause)}`);
    }
    const recorded =
      typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "ruleset") : undefined;
    if (recorded !== season.ruleset) {
      return (
        `${archivePath} 的 meta.ruleset = ${JSON.stringify(recorded)},` +
        `与赛季声明的 ${JSON.stringify(season.ruleset)} 不一致`
      );
    }
  }
  return undefined;
};

/** 地图池缺省:`<root>/maps/` 下全部 `*.json` 的 slug,升序(确定性)。 */
const defaultMapPool = (root: string): readonly string[] => {
  const dir = join(root, "maps");
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch (cause) {
    throw new Error(`读不到地图目录 ${dir}:${messageOf(cause)}`);
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
};

/** 一个座位上的存档引用:路径 + `script.js` / `meta.json` 的实测哈希。 */
const archiveOf = (root: string, archivePath: string): MatchInputArchive => ({
  archivePath,
  scriptSha256: sha256Hex(readFileSync(join(root, archivePath, SCRIPT_PRODUCT_NAME))),
  metaSha256: sha256Hex(readFileSync(join(root, archivePath, META_NAME))),
});

/**
 * 把一局对局物化成 `input.json` 的五键对象。
 *
 * 键序 = `REQUIRED_KEYS` 序(`archives` / `map` / `mapSha256` / `seed` / `ruleset`);
 * **座位由 `archives` 的下标承载**,轮换已在 `enumerateMatchUps` 里算好。
 * 序列化前自查键集**恰为五项**——多写一个赛季字段即抛错,不让 `input.json` 长成第二个 `season.yaml`。
 */
const materializeInput = (root: string, matchUp: MatchUp): MatchInput => {
  const [seat0, seat1, seat2, seat3] = matchUp.seats;
  const archives: MatchInputArchives = [
    archiveOf(root, seat0),
    archiveOf(root, seat1),
    archiveOf(root, seat2),
    archiveOf(root, seat3),
  ];
  const mapSha256 = sha256Hex(readFileSync(join(root, "maps", `${matchUp.map}.json`)));

  // 书写序即契约序:archives / map / mapSha256 / seed / ruleset。
  const input = {
    archives,
    map: matchUp.map,
    mapSha256,
    seed: matchUp.seed,
    ruleset: matchUp.ruleset,
  };

  const keys = Object.keys(input);
  if (keys.length !== INPUT_KEYS.length || !INPUT_KEYS.every((key, index) => keys[index] === key)) {
    throw new Error(
      `input.json 键集必须恰为 [${INPUT_KEYS.join(", ")}],实际 [${keys.join(", ")}]` +
        "(对局输入不含任何赛季字段)",
    );
  }
  return input;
};

/** 每局目录名:`<comboId>-<map>-s<seedIndex>`(确定性;座位号不进名字,轮换已由枚举定死)。 */
const matchDirName = (matchUp: MatchUp): string =>
  `${matchUp.comboId}-${matchUp.map}-s${matchUp.seedIndex}`;

/** 读回放末行的 `result`,只取名次与终局原因;形状不对即抛错(不静默取个空结果)。 */
const readResult = (
  replayPath: string,
): { readonly rankings: readonly number[]; readonly reason: string } => {
  const last = readText(replayPath).trimEnd().split("\n").at(-1);
  if (last === undefined || last.length === 0) {
    throw new Error(`回放 ${replayPath} 为空,读不到末行 result`);
  }
  let line: unknown;
  try {
    line = JSON.parse(last);
  } catch (cause) {
    throw new Error(`回放 ${replayPath} 末行不是合法 JSON:${messageOf(cause)}`);
  }
  const type = typeof line === "object" && line !== null ? Reflect.get(line, "type") : undefined;
  const rankings =
    typeof line === "object" && line !== null ? Reflect.get(line, "rankings") : undefined;
  const reason =
    typeof line === "object" && line !== null ? Reflect.get(line, "reason") : undefined;
  if (type !== "result" || !Array.isArray(rankings) || typeof reason !== "string") {
    throw new Error(`回放 ${replayPath} 末行不是合法 result 行(type=${JSON.stringify(type)})`);
  }
  return { rankings: rankings.map((value) => Number(value)), reason };
};

/**
 * 赛季调度(可测核心):装载配置 → 规则版本前置拒绝 → 枚举 → 逐局物化并 spawn → 写报告。
 *
 * 返回进程退出码:整季跑通 = 0,规则版本不一致或任一局非零退出 = 1(票 07 细化 1 / 4 中止与
 * 2 / 3 重跑)。`deps.spawnMatch` 是执行一局的注入缝,单测用可控桩替换。
 */
export const scheduleSeason = async (
  options: ScheduleSeasonOptions,
  deps: SeasonSchedulerDeps,
): Promise<number> => {
  const root = resolve(options.root);
  const season = loadSeasonConfig(resolve(root, options.configPath));

  // ── 规则版本前置拒绝(先于任何物化 / 子进程) ──
  const mismatch = findRulesetMismatch(root, season);
  if (mismatch !== undefined) {
    process.stderr.write(
      `modelwar run: 存档规则版本不一致:${mismatch};赛季拒跑(规则版本隔离,不分版本分节)\n`,
    );
    return EXIT_FAILED;
  }

  const maps = season.maps ?? defaultMapPool(root);
  const matchUps = enumerateMatchUps({
    participants: season.participants,
    maps,
    seeds: season.seeds,
    masterSeed: season.masterSeed,
  });

  const now = options.now ?? (() => new Date());
  const runId = runIdOf(now());
  const outputDir = resolve(root, season.outputDir ?? join("runs", runId));

  const reported: ReportedMatch[] = [];
  for (const matchUp of matchUps) {
    const matchDir = join(outputDir, "matches", matchDirName(matchUp));
    mkdirSync(matchDir, { recursive: true });
    const inputPath = join(matchDir, "input.json");
    const input = materializeInput(root, matchUp);
    writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);

    // ── 串行执行(票 07 换并发池 + 重跑/剔除) ──
    const { code } = await deps.spawnMatch(inputPath);
    if (code !== EXIT_OK) {
      process.stderr.write(
        `modelwar run: 对局 ${matchDirName(matchUp)} 退出码 ${String(code)},赛季中止` +
          "(码 1 / 4 为赛季级失败,码 2 / 3 的重跑与剔除归票 07)\n",
      );
      // 票 06 的最小口径:1 / 4 原样透出(它们是赛季级失败);2 / 3 的重跑归票 07,这里先按
      // 赛季中止处理(退 1)——绝不静默忽略非零。
      return code === EXIT_FAILED || code === EXIT_INTERNAL ? code : EXIT_FAILED;
    }

    const result = readResult(join(matchDir, "replay.jsonl"));
    reported.push({
      comboId: matchUp.comboId,
      map: matchUp.map,
      seed: matchUp.seed,
      inputPath: relative(root, inputPath),
      rankings: result.rankings,
      reason: result.reason,
    });
  }

  // TODO(票 07):并发池、退出码 2 / 3 的重跑一次与问题清单、1 / 4 的赛季级中止、(票 08)ranker 记账与报告扩展。
  const report: SeasonReport = {
    runId,
    ruleset: season.ruleset,
    matches: reported,
  };
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return EXIT_OK;
};

/** `run` 的两个选项;`-h/--help` 已由 CLI 路由层拦截,不进处理器。 */
type RunArgs = {
  readonly root: string | undefined;
  readonly config: string | undefined;
};

/**
 * 解析 `run` 的参数:只认 `--root` / `--config`,**任何位置参数都报错**
 * (照 `packages/gen/src/run.ts` 的 `parseGenArgs`)。`--config` 缺值也报错。
 */
const parseRunArgs = (args: readonly string[]): RunArgs => {
  const parsed: { root: string | undefined; config: string | undefined } = {
    root: undefined,
    config: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || !arg.startsWith("-")) {
      throw new Error(`run 不接受位置参数:${String(arg)}`);
    }
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`${arg} 缺值`);
    }
    index += 1;
    if (arg === "--root") {
      parsed.root = value;
    } else if (arg === "--config") {
      parsed.config = value;
    } else {
      throw new Error(`未知参数:${arg}`);
    }
  }
  return parsed;
};

/**
 * 默认的子进程执行缝:`spawn(process.execPath, [binPath, "match", inputPath, "--root", root])`。
 *
 * `binPath` = `process.argv[1]`(ESM 单文件 bin 下就是 `dist/modelwar.mjs`)——**这是注入点**:
 * runner 的 vitest 单测里 `argv[1]` 是 vitest 自身,故单测用 `deps.spawnMatch` 桩或指向假 bin,
 * 不依赖真实 CLI。
 */
const spawnMatchProcess = (
  binPath: string,
  root: string,
  inputPath: string,
): Promise<{ readonly code: number | null }> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [binPath, "match", inputPath, "--root", root], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code }));
  });

/** 处理器错误的统一出口:`modelwar run: <msg>` + 退出码 1。 */
const writeFailure = (message: string): number => {
  process.stderr.write(`modelwar run: ${message}\n`);
  return EXIT_FAILED;
};

/**
 * CLI 处理器(`commands.ts` 登记的导出名)。薄壳:解析 `--config` / `--root` → 根解析
 * (默认 cwd,`--config` 相对根,**不加载 `.env`**)→ 注入默认 `binPath` 与真实 spawn →
 * 调 `scheduleSeason`。
 *
 * 用法错 / 配置或装载出错 → 明确报错 + 非零退出(不静默返回成功)。退出码由本函数返回
 * (不走 `process.exitCode`,理由见 `apps/cli/src/commands.ts` 的 `CommandHandler` 注释)。
 */
export const runSeason = async (args: readonly string[]): Promise<number> => {
  let parsed: RunArgs;
  try {
    parsed = parseRunArgs(args);
  } catch (cause) {
    return writeFailure(messageOf(cause));
  }
  if (parsed.config === undefined) {
    return writeFailure("缺 --config <season.yaml>(用法:modelwar run --config season.yaml)");
  }

  const root = resolve(parsed.root ?? process.cwd());
  // `run` 不联网、不需要凭证,故**不加载 <root>/.env**(与 `gen` 的差别;spec 明写)。
  const binPath = process.argv[1];
  if (binPath === undefined) {
    return writeFailure("无法定位 modelwar 可执行路径(process.argv[1] 缺失)");
  }

  try {
    return await scheduleSeason(
      { root, configPath: parsed.config },
      { spawnMatch: (inputPath) => spawnMatchProcess(binPath, root, inputPath) },
    );
  } catch (cause) {
    return writeFailure(messageOf(cause));
  }
};
