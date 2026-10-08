/**
 * 赛季调度器:并发子进程池 + 退出码驱动的异常重跑/剔除(hld §8.1 / §8.3 / §9,票 06 → 07)。
 *
 * ── 这一票把「串行」换成「并发池」 ────────────────────────────────────────
 *
 * 票 06 走通了端到端窄路(物化 → spawn → 读末行 → 写报告)。票 07 把那条 `for … await` 换成
 * **信号量池**:并发上限 = `season.concurrency ?? min(cpus().length, 8)`,每局一个
 * `modelwar match <input.json> --root <root>` 子进程,各自写进自己的 `<matchDir>`,互不干扰。
 * 池完成顺序不确定 ⇒ 写盘前**按 `(comboIndex, mapIndex, seedIndex)` 排序**,保证并发度 1 与 N
 * 产出**逐字节相同**的 `report.json`。
 *
 * ── 只认退出码:重跑、剔除、赛季级中止 ──────────────────────────────────
 *
 * 子进程成败**只看退出码**(真源 `apps/cli/src/exit-codes.ts`),不解析 stdout 判成败。分流
 * (分类集中在 `classifyExitCode`,所有站点共用一处):
 *   - `0`(EXIT_OK)→ 读回放末行 `result`,入报告。规则内结果(胜/负/超时/淘汰、内存判负、
 *     带异常出局的席位)一律是 0,**绝不被崩溃条款误判**。
 *   - `2`(engine-crash)/ `3`(nondeterministic-timeout)→ **重跑一次**;再触发同码 → 记入
 *     `matchIssues[]`(`excludedFromRanking: true`)并**排除出排名**(报告里仍含这一条,不静默丢弃)。
 *   - `1`(装载/用法)/ `4`(内部错)→ **赛季级中止**,打印 stderr 后按该码返回(不静默剔除;
 *     装载期错误本应在物化前拦住)。
 *   - `null`(被信号杀)+ **其它未在码表里的非零码** → 同样**赛季级中止**。判据:信号终止或
 *     未知码既不携带「引擎故障/超时」这一可重跑语义(故不进重跑轨),也不能安全地折算成「这局
 *     无效但赛季照跑」(那会把一个坏环境伪装成「成功赛季 + 全进问题清单」)。故按赛季级失败中止。
 *   - **子进程无法启动**(`deps.spawnMatch` 抛错,如 ENOENT/权限) → 赛季级中止:一个启不来的
 *     可执行文件对每一局都必然失败,不是某局的偶发异常。
 *
 * **不另造超时阈值**:不确定超时完全由子进程退出码 3 表达(它复用规则集里 `wallClockHardTimeout`
 * 的既有口径),调度器不设父级墙钟看门狗、不硬编码任何毫秒数。
 *
 * ── 码 0 的内存披露:读 `observations.jsonl`,不改排名 ──────────────────────
 *
 * 内存超限判负是**正常结果**(exit 0),按 spec/hld §8.4 要在「对局问题清单」里**披露**。码 0 的
 * 局因此额外读同目录的 `observations.jsonl`(有 `kind: "memory-pressure"` 即在 `matchIssues[]`
 * 追加一条 `reason: "memory-pressure"`、`excludedFromRanking: false` 的披露条目——它**仍计入
 * 排名**)。读观测文件是解释性的最佳努力:文件缺失/读不动都不改变该局「成功」的判定。
 *
 * **不用回放的 `players[i].exceptionTicks` 作信号**:它把内存 / API / 未捕获异常 / 事件四条轨的
 * 触限混在一起,单看判不出是不是内存(`tripped` 观测不入 `observations.jsonl`,见 schema 的
 * `observation-line.ts` 头注);内存压力的精确持久化信号只有 `memory-pressure` 观测行。
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
 * 本文件 import `@model-war/schema` / `@model-war/replay`(读回放与观测行)与 node 内建
 * (`node:crypto` / `node:fs` / `node:path` / `node:child_process` / `node:os`)。**不得 import
 * engine**(hld §3.2);也不新增 `runner → gen` 的边(故 `sha256Hex` / `runIdOf` / YAML 子集读取器
 * 在 runner 内各留一份私有实现)。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseReplay, readLinesOf } from "@model-war/replay";
import {
  type JsonValue,
  type MatchInput,
  type MatchInputArchive,
  type MatchInputArchives,
} from "@model-war/schema";
import { enumerateMatchUps, type MatchUp } from "./enumerate.js";
import { DEFAULT_RANK_POINTS, perMatchScores, rankSeason, type MatchStanding } from "./ranker.js";
import type { MatchIssue, MatchIssueReason, SeasonMatchReport, SeasonReport } from "./reporter.js";
import { readFailureRecords, writeReportArtifacts, writeReportJson } from "./reporter.js";
import { loadSeasonConfig, type SeasonConfig } from "./season-config.js";

/** 正常退出(与 `apps/cli/src/exit-codes.ts` 的 `EXIT_OK` 同值;runner 不 import CLI,故本地定型)。 */
const EXIT_OK = 0;

/** 赛季级失败(装载、规则版本不一致、子进程 1 / 4 / null / 未知码中止)。 */
const EXIT_FAILED = 1;

/** 引擎崩溃(与 `apps/cli/src/exit-codes.ts` 的 `EXIT_ENGINE_FAULT` 同值)。重跑一次。 */
const EXIT_ENGINE_FAULT = 2;

/** 不确定超时(与 `apps/cli/src/exit-codes.ts` 的 `EXIT_NONDETERMINISTIC_TIMEOUT` 同值)。重跑一次。 */
const EXIT_NONDETERMINISTIC_TIMEOUT = 3;

/** 其它内部错(与 `apps/cli/src/exit-codes.ts` 的 `EXIT_INTERNAL` 同值)。赛季级中止。 */
const EXIT_INTERNAL = 4;

/** 并发上限缺省:`min(cpus().length, 8)`(hld §8.1;与自证门 `min(6, cpus-2)` 是两回事)。 */
const DEFAULT_MAX_CONCURRENCY = 8;

/** 对局输入 `input.json` 的键集与**书写序**(须与 `MatchInput` / `REQUIRED_KEYS` 逐字一致)。 */
const INPUT_KEYS = ["archives", "map", "mapSha256", "seed", "ruleset"] as const;

/** 存档拓扑里的两个文件名(真源在 `packages/gen/src/archive.ts`,runner 不得 import gen,故写字面量)。 */
const SCRIPT_PRODUCT_NAME = "script.js";
const META_NAME = "meta.json";

/** `report.json` 的形状(`SeasonReport` / `SeasonMatchReport` / `MatchIssue`)住在 `./reporter.js`。 */

/** `scheduleSeason` 的注入缝:子进程执行一局,只回退出码(一局可能被调两次:首发 + 重跑一次)。 */
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

/** 一局的执行结局。 */
type AttemptResult =
  | {
      readonly kind: "completed";
      readonly rankings: readonly number[];
      readonly reason: string;
      /** 该局是否读到 `observations.jsonl` 的 `memory-pressure` 披露(码 0 的正常结果)。 */
      readonly memoryPressure: boolean;
    }
  | { readonly kind: "problem"; readonly reason: MatchIssueReason; readonly exitCode: number }
  | { readonly kind: "abort"; readonly exitCode: number; readonly message: string };

/** 入报告的一局(中止不会落进 `outcomes`,故意窄化掉 abort 分支)。 */
type SettledOutcome = Exclude<AttemptResult, { kind: "abort" }>;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** sha256(小写十六进制)。与 `packages/gen/src/archive.ts` 的同名 helper 逐字同义(各留一份,不跨包)。 */
const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** 时间戳形态的 `runId`:`:` / `.` 换成 `-`,让它能直接当目录名(与 gen 的 `runIdOf` 同款)。 */
const runIdOf = (at: Date): string => at.toISOString().replaceAll(":", "-").replace(".", "-");

/**
 * 赛季级中止的返回码:`1` / `4` 原样透出;`null`(信号)与未知码折成 `1`。
 *
 * `null` / 未知码进不了重跑轨(见文件头注的判据),也不该被折成「这局无效、赛季照跑」,
 * 故与 1 / 4 一样中止——返回一个非零码即可,取 `EXIT_FAILED` 是因为它没有更具体的中止语义。
 */
const abortExitCode = (code: number | null): number =>
  code === EXIT_FAILED || code === EXIT_INTERNAL ? code : EXIT_FAILED;

/** 退出码的唯一分类器(重跑轨 / 赛季级中止 / 成功的判据只此一处,所有站点共用)。 */
type ExitClassification =
  | { readonly kind: "ok" }
  | { readonly kind: "rerun"; readonly code: number; readonly reason: MatchIssueReason }
  | { readonly kind: "abort"; readonly code: number | null; readonly exitCode: number };

/**
 * 把一个退出码分成三态:`ok`(码 0,入报告)/ `rerun`(码 2 / 3,先重跑一次,再触发入问题清单并
 * 排除出排名)/ `abort`(其余:1 / 4 / null / 未知码,赛季级中止)。
 *
 * 原始码一并带出:消息要显示「被信号终止(null)」,重跑轨要把码原样写进 `matchIssues[].exitCode`。
 */
const classifyExitCode = (code: number | null): ExitClassification => {
  if (code === EXIT_OK) {
    return { kind: "ok" };
  }
  if (code === EXIT_ENGINE_FAULT) {
    return { kind: "rerun", code, reason: "engine-crash" };
  }
  if (code === EXIT_NONDETERMINISTIC_TIMEOUT) {
    return { kind: "rerun", code, reason: "nondeterministic-timeout" };
  }
  return { kind: "abort", code, exitCode: abortExitCode(code) };
};

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

/** 每个对局的座位数(四方对称,与 `enumerate.js` 同值;本地定型避免跨模块耦合)。 */
const SEAT_COUNT = 4;

/** 把回放末行的 `rankings` 收窄成 4 元组;长度不符即抛错(不静默截断 / 补齐)。 */
const fourRankings = (
  matchId: string,
  rankings: readonly number[],
): readonly [number, number, number, number] => {
  const [first, second, third, fourth] = rankings;
  if (
    rankings.length !== SEAT_COUNT ||
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined
  ) {
    throw new Error(`对局 ${matchId} 的 rankings 长度须为 ${SEAT_COUNT},实际 ${rankings.length}`);
  }
  return [first, second, third, fourth];
};

/** 把一局收成 `rankSeason` 要的 `standings`:座位 i 上的参赛者拿 `rankings[i]` 的名次。 */
const standingsInMatch = (
  seats: readonly [string, string, string, string],
  rankings: readonly [number, number, number, number],
): readonly MatchStanding[] => seats.map((player, seat) => ({ player, rank: rankings[seat] ?? 0 }));

/**
 * 读回放末行的 `result`,只取名次与终局原因。
 *
 * 经 `@model-war/replay` 的 `parseReplay` 读入(与渲染器、NFR-2 复算链同一条读入端,spec《回放
 * 读入端(最小面)》);空回放 / 坏行由 `parseReplay` 抛 `ReplayReadError`,末行不是 `result`
 * 则在此报错——不静默取个空结果。
 */
const readResult = (
  replayPath: string,
): { readonly rankings: readonly number[]; readonly reason: string } => {
  const last = parseReplay(replayPath).at(-1);
  if (last === undefined || last.type !== "result") {
    throw new Error(`回放 ${replayPath} 末行不是 result 行(读不到名次)`);
  }
  return { rankings: last.rankings, reason: last.reason };
};

/** 一局的目录与输入路径(`<outputDir>/matches/<comboId>-<map>-s<seedIndex>/`)。 */
const matchLocation = (
  outputDir: string,
  matchUp: MatchUp,
): { matchDir: string; inputPath: string } => {
  const matchDir = join(outputDir, "matches", matchDirName(matchUp));
  return { matchDir, inputPath: join(matchDir, "input.json") };
};

/**
 * 执行一局:物化 `input.json` → spawn → **只认退出码**分流 → (必要时)重跑一次。
 *
 * 物化发生在 spawn 之前且只一次;每局一个目录,重跑复用同一路径(子进程重写 `replay.jsonl`),
 * 局与局之间无共享文件、互不干扰。
 *
 * `deps.spawnMatch` 抛错(子进程无法启动)不在此处吞掉——由调用方定为赛季级中止。
 */
const runMatchUp = async (
  root: string,
  outputDir: string,
  matchUp: MatchUp,
  deps: SeasonSchedulerDeps,
): Promise<AttemptResult> => {
  const { matchDir, inputPath } = matchLocation(outputDir, matchUp);
  mkdirSync(matchDir, { recursive: true });
  writeFileSync(inputPath, `${JSON.stringify(materializeInput(root, matchUp), null, 2)}\n`);

  const name = matchDirName(matchUp);
  const first = classifyExitCode((await deps.spawnMatch(inputPath)).code);
  if (first.kind === "ok") {
    return completedOf(matchDir);
  }
  if (first.kind === "abort") {
    return abortOf(name, first);
  }

  // 首发踩中 2 / 3 → 重跑**一次**。
  const second = classifyExitCode((await deps.spawnMatch(inputPath)).code);
  if (second.kind === "ok") {
    return completedOf(matchDir);
  }
  if (second.kind === "abort") {
    return abortOf(name, second);
  }
  return { kind: "problem", reason: second.reason, exitCode: second.code };
};

/** 观测行的 `kind`(只从对象形态里取;观测文件的形状校验不归调度器)。 */
const observationKindOf = (line: JsonValue): unknown =>
  typeof line === "object" && line !== null && !Array.isArray(line)
    ? Reflect.get(line, "kind")
    : undefined;

/**
 * 该局是否读到 `observations.jsonl` 的 `memory-pressure` 披露(码 0 的正常结果)。
 *
 * 观测文件是**解释性**产物:缺失 / 读不动都不改变「该局成功」的判定,故这里吞掉读盘错误、返回
 * `false`。`modelwar match` 只在有观测时才落盘,没有文件 = 没有披露。
 */
const hasMemoryPressure = (matchDir: string): boolean => {
  const path = join(matchDir, "observations.jsonl");
  if (!existsSync(path)) {
    return false;
  }
  try {
    return readLinesOf(path).some((line) => observationKindOf(line) === "memory-pressure");
  } catch {
    return false;
  }
};

/** 码 0:读回放末行 `result`,收成一条成功局(并带上内存披露标志)。 */
const completedOf = (matchDir: string): AttemptResult => {
  const result = readResult(join(matchDir, "replay.jsonl"));
  return {
    kind: "completed",
    rankings: result.rankings,
    reason: result.reason,
    memoryPressure: hasMemoryPressure(matchDir),
  };
};

/** 赛季级中止(码 1 / 4 / null / 未知码):原样透出 `classifyExitCode` 判定的中止码与原始码。 */
const abortOf = (
  name: string,
  abort: Extract<ExitClassification, { kind: "abort" }>,
): AttemptResult => {
  const shown = abort.code === null ? "被信号终止(null)" : String(abort.code);
  return {
    kind: "abort",
    exitCode: abort.exitCode,
    message: `对局 ${name} 退出码 ${shown},赛季中止`,
  };
};

/**
 * 赛季调度(可测核心):装载配置 → 规则版本前置拒绝 → 枚举 → **并发池**逐局物化并 spawn
 * (退出码 2 / 3 重跑一次、再触发则入问题清单)→ 按确定序写报告。
 *
 * 返回进程退出码:整季跑通(含有问题清单但不中止)= 0;规则版本不一致 / 任一局触发码 1、4、
 * null 或未知码 / 子进程无法启动 = 相应的非零码(见 `abortExitCode`)。
 *
 * `deps.spawnMatch` 是执行一局的注入缝,单测用可控桩替换。
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

  // 并发上限:季赛覆写优先,否则 `min(cpus, 8)`(hld §8.1)。
  const concurrency = season.concurrency ?? Math.min(cpus().length, DEFAULT_MAX_CONCURRENCY);

  // ── 并发池:worker 们各自从队列取局;完成顺序不定,靠下面的排序保证确定性 ──
  const outcomes = new Map<MatchUp, SettledOutcome>();
  const state: { abort?: { readonly exitCode: number; readonly message: string } } = {};
  const queue = [...matchUps];

  const worker = async (): Promise<void> => {
    while (state.abort === undefined) {
      const matchUp = queue.shift();
      if (matchUp === undefined) {
        return;
      }
      let attempt: AttemptResult;
      try {
        attempt = await runMatchUp(root, outputDir, matchUp, deps);
      } catch (cause) {
        // 子进程无法启动(ENOENT / 权限 / 资源耗尽):对每一局都必然失败,归赛季级中止。
        state.abort = {
          exitCode: EXIT_FAILED,
          message: `对局 ${matchDirName(matchUp)} 子进程无法启动:${messageOf(cause)}`,
        };
        return;
      }
      if (attempt.kind === "abort") {
        state.abort = { exitCode: attempt.exitCode, message: attempt.message };
        return;
      }
      outcomes.set(matchUp, attempt);
    }
  };

  // 空赛季不开 worker;`Math.max(1, …)` 保证即使 `cpus()` 为 0 也至少有 worker 推进队列。
  const workerCount = queue.length === 0 ? 0 : Math.max(1, Math.min(concurrency, queue.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (state.abort !== undefined) {
    process.stderr.write(
      `modelwar run: ${state.abort.message}(码 1 / 4 为赛季级失败;2 / 3 重跑后仍触发则入问题清单而不中止)\n`,
    );
    return state.abort.exitCode;
  }

  // ── 确定性重组:按 `(comboIndex, mapIndex, seedIndex)` 升序,与池完成顺序解耦 ──
  // 这正是 `comboId` / `map` / `seed` 三键的数值形态(`comboId` = `c<comboIndex>`);用数值下标
  // 而非词法比较,是因为 `c10` 词法上排在 `c2` 之前。
  const settled = matchUps
    .map((matchUp) => ({ matchUp, outcome: outcomes.get(matchUp) }))
    .filter(
      (entry): entry is { matchUp: MatchUp; outcome: SettledOutcome } =>
        entry.outcome !== undefined,
    )
    .sort(
      (left, right) =>
        left.matchUp.comboIndex - right.matchUp.comboIndex ||
        left.matchUp.mapIndex - right.matchUp.mapIndex ||
        left.matchUp.seedIndex - right.matchUp.seedIndex,
    );

  const rankPoints = season.rankPoints ?? DEFAULT_RANK_POINTS;

  // ── 逐局入报告:成功局进 matches(含每座位得分),剔除的失败局进 matchIssues ──
  const matches: SeasonMatchReport[] = [];
  const matchIssues: MatchIssue[] = [];
  for (const { matchUp, outcome } of settled) {
    const inputPath = relative(root, matchLocation(outputDir, matchUp).inputPath);
    const matchId = matchDirName(matchUp);
    if (outcome.kind === "problem") {
      // 剔除的失败局:不进 matches、不进均分分母,但保留在问题清单(不静默丢弃)。
      matchIssues.push({
        matchId,
        inputPath,
        comboId: matchUp.comboId,
        mapIndex: matchUp.mapIndex,
        seedIndex: matchUp.seedIndex,
        map: matchUp.map,
        seed: matchUp.seed,
        reason: outcome.reason,
        exitCode: outcome.exitCode,
        rerunCount: 1,
        excludedFromRanking: true,
      });
      continue;
    }
    const rankings = fourRankings(matchId, outcome.rankings);
    const standings = standingsInMatch(matchUp.seats, rankings);
    matches.push({
      matchId,
      inputPath,
      comboId: matchUp.comboId,
      mapIndex: matchUp.mapIndex,
      seedIndex: matchUp.seedIndex,
      map: matchUp.map,
      seed: matchUp.seed,
      seats: matchUp.seats,
      rankings,
      reason: outcome.reason,
      perMatchScores: perMatchScores(matchId, standings, rankPoints),
    });
    if (outcome.memoryPressure) {
      // 码 0 的内存披露:仍是正常结果(已进 matches、计入排名),只在问题清单里披露,
      // 故 `excludedFromRanking: false`。
      matchIssues.push({
        matchId,
        inputPath,
        comboId: matchUp.comboId,
        mapIndex: matchUp.mapIndex,
        seedIndex: matchUp.seedIndex,
        map: matchUp.map,
        seed: matchUp.seed,
        reason: "memory-pressure",
        exitCode: EXIT_OK,
        rerunCount: 0,
        excludedFromRanking: false,
      });
    }
  }

  // ── 排名由纯函数 `rankSeason` 一次算出(有效局数由它计,报告侧不另算一遍) ──
  const standings = rankSeason(
    matches.map((match) => ({
      matchId: match.matchId,
      standings: standingsInMatch(match.seats, match.rankings),
    })),
    { players: season.participants, rankPoints },
  );

  const report: SeasonReport = {
    runId,
    ruleset: season.ruleset,
    masterSeed: season.masterSeed,
    rankPoints,
    matches,
    standings,
    // 校验失败名单:扫 archive/<slug>/failed-*.json(模型没拿到参赛资格;票 09)。
    validationFailures: readFailureRecords(root),
    matchIssues,
  };
  writeReportJson(join(outputDir, "report.json"), report);
  // 人类面产物:每局一篇 narrative/<对局>.md + 一份 report.md(票 09)。
  writeReportArtifacts(outputDir, report);
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
