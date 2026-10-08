import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { MapDefinition } from "@model-war/schema";
import {
  QUICKJS_WASI_WASM_PATH,
  SANDBOX_RUNTIME_ARTIFACT_PATH,
  SANDBOX_RUNTIME_HASH,
} from "@model-war/schema";

/**
 * 命令行的外部可观察行为只有两件:帮助信息列出哪几条子命令,以及未实现的子命令怎么退。
 *
 * 断言对象是**打好的单文件产物**,不是 `src/index.ts` 里的内部函数——改了内部结构而
 * 让这些断言失效,就是坏断言(见 spec《Testing Decisions》)。所以这里跑真实的 bundle。
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const mapPath = fileURLToPath(new URL("../../../maps/open-clash.json", import.meta.url));

const COMMANDS = ["gen", "run", "match", "replay", "verify", "map-lint"] as const;

/**
 * 尚未落地的子命令。`gen` / `map-lint` / `replay` / `match` / `verify` 不在其中:五者已实现,
 * 被下面各自那组断言盯着。这张名单会随实现推进缩短——把一条命令搬出这张名单是"它有断言了"的信号。
 */
const UNIMPLEMENTED = ["run"] as const;

let bundle = "";
let scratch = "";
let poolSeq = 0;
let seq = 0;

const run = (args: readonly string[]) =>
  spawnSync(process.execPath, [bundle, ...args], { cwd: repoRoot, encoding: "utf8" });

beforeAll(async () => {
  // 各包的 exports 指向 dist/,先让类型闸门把 dist 备齐。增量构建是空操作(实测 ~0.1s)。
  const typecheck = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url)),
      "-b",
      "--pretty",
      "false",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  expect(typecheck.status, `tsc -b 失败:\n${typecheck.stdout}${typecheck.stderr}`).toBe(0);

  scratch = mkdtempSync(`${tmpdir()}/modelwar-cli-`);
  bundle = `${scratch}/modelwar.mjs`;
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: bundle,
  });
});

afterAll(() => {
  rmSync(scratch, { force: true, recursive: true });
});

/**
 * 在临时目录里造一个地图池并返回它的路径。
 *
 * `map-lint` 现在收的是**目录**,而 `maps/` 里只有一张图(池级判据要求至少 3 张,三张真图是
 * 票 05 的活),所以进程级断言得自己造池。造法与 `pool-lint.test.ts` 同源:沿用落库那张图的点位,
 * 墙从它的候选变体轨道里取——那 8 条轨道实测一格不压点位、天生四重对称。
 * 当了墙的轨道同时从候选清单里剔掉(`slotsOf`):夹具里 `orbitIndexes` 就是那张图**用掉**了
 * 哪几条候选轨道,它一进 `writePool`,地形与候选清单就一起由它决定,两处不可能再分叉。
 */
const writePool = (
  maps: readonly {
    name: string;
    orbitIndexes?: readonly number[];
    terrain?: string[];
    patch?: Record<string, unknown>;
  }[],
): string => {
  // 目录名带序号:同一个临时根下造两个池时不会互相覆盖(否则断言顺序一变就读到别人的文件)。
  poolSeq += 1;
  const dir = join(scratch, `pool-${poolSeq}`);
  mkdirSync(dir, { recursive: true });
  const source = openMap();
  for (const map of maps) {
    const indexes = map.orbitIndexes ?? [];
    const terrain = map.terrain ?? terrainWithOrbits(source, indexes);
    writeFileSync(
      join(dir, `${map.name}.json`),
      JSON.stringify({
        ...source,
        ...slotsOf(source, indexes),
        terrain,
        name: map.name,
        ...map.patch,
      }),
    );
  }
  return dir;
};

/**
 * 候选清单里剔掉「已经被画成墙」的轨道。
 *
 * 夹具把候选轨道填进地形当墙用,而候选清单的语义是「种子可以往这里填墙」——两处同时留着
 * 同一组格子就是一条死格,新判据 `variant-slot-on-wall` 会把这张夹具图判失败。
 * 剔掉它们是让夹具自洽,不是给判据开口子:真图 `maps/*.json` 早已满足这条。
 */
const slotsOf = (source: MapDefinition, used: readonly number[]): Record<string, unknown> => ({
  variantSlots: source.variantSlots.filter((_, index) => !used.includes(index)),
});

/** 落库那张开阔对攻图(进程级断言的原料;它本身是合规的)。 */
const openMap = (): MapDefinition => JSON.parse(readFileSync(mapPath, "utf8"));

/** 把候选变体轨道填进地形:第 `indexes` 几条。先清空原有墙,免得两图共享墙格。 */
const terrainWithOrbits = (source: MapDefinition, indexes: readonly number[]): string[] => {
  const rows = source.terrain.map((row) => row.replaceAll("#", ".").split(""));
  for (const index of indexes) {
    for (const [x, y] of source.variantSlots[index] ?? []) {
      const row = rows[y];
      if (row !== undefined) row[x] = "#";
    }
  }
  return rows.map((row) => row.join(""));
};

it("帮助信息列出全部六条子命令", () => {
  const result = run(["--help"]);
  expect(result.status).toBe(0);
  for (const command of COMMANDS) {
    expect(result.stdout).toContain(`modelwar ${command}`);
  }
});

it("未知子命令非零退出", () => {
  const result = run(["not-a-command"]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("未知子命令");
});

it("六条子命令都登记在册(帮助之外的入口也存在)", () => {
  for (const command of COMMANDS) {
    const result = run([command, "--help"]);
    expect(result.status, `${command} --help 应当成功`).toBe(0);
    expect(result.stdout).toContain(`modelwar ${command}`);
  }
});

it.each(UNIMPLEMENTED)("未实现的 %s 显式失败,不静默返回成功", (command) => {
  const result = run([command]);
  expect(result.status).not.toBe(0);
  // 退出码非零还不够:必须是"未实现"这条路径,而不是别处的崩溃。
  expect(result.stderr).toContain("未实现");
});

it("`gen` 不再是「未实现」:帮助里列出 --config / --root / --model", () => {
  // 用户故事 24。`commandHelpText` 不展开处理器私有选项,故三个串只能来自登记的 `usage`。
  const help = run(["gen", "--help"]);
  expect(help.status).toBe(0);
  for (const option of ["--config", "--root", "--model"]) {
    expect(help.stdout, `gen --help 应含 ${option}`).toContain(option);
  }
});

it("`gen` 缺 --config 时非零退出,不走「未实现」那条路径", () => {
  const result = run(["gen"]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).not.toContain("未实现");
  expect(result.stderr).toContain("--config");
});

it("`map-lint` 不再走「未实现」那条路径", () => {
  const dir = writePool([
    { name: "pool-a", orbitIndexes: [0] },
    { name: "pool-b", orbitIndexes: [1, 2] },
    { name: "pool-c", orbitIndexes: [3] },
  ]);
  const result = run(["map-lint", dir]);
  expect(result.stderr).not.toContain("未实现");
  // 三张图合规(三张真图是票 05 的活,这里造的是同一套点位下的最小合规池),所以这一跑必须放行。
  expect(result.stdout).toContain("通过");
  expect(result.status).toBe(0);
});

it("`map-lint` 对不合法的地图池非零退出(退出码由处理器返回,不是 index.ts 给的)", () => {
  // 断言对象是退出码本身:`index.ts` 调完处理器无条件 `return 0`,处理器没有返回值通道,
  // 所以「非零退出」这条只能靠处理器把退出码一路返回到顶层。这里用一张改坏的图钉住它。
  const source = openMap();
  const rows = terrainWithOrbits(source, [0]);
  rows[0] = `${".".repeat(3)}#${".".repeat((rows[0]?.length ?? 0) - 4)}`;
  const dir = writePool([
    { name: "pool-a", orbitIndexes: [0], terrain: rows },
    { name: "pool-b", orbitIndexes: [1, 2] },
    { name: "pool-c", orbitIndexes: [3] },
  ]);
  const result = run(["map-lint", dir]);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain("地形未四重旋转对称");
});

it("`map-lint` 拿到一个不存在的目录时非零退出", () => {
  // 「目录不存在」这一格:不给它一句明确的失败,调用方会把「没查」读成「通过」。
  const result = run(["map-lint", join(scratch, "no-such-pool")]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("读不到目录");
});

it("`map-lint` 拿到一个空目录时判失败(而不是静默通过)", () => {
  const dir = join(scratch, "pool-empty");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitkeep"), "");
  const result = run(["map-lint", dir]);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain("地图池里没有地图");
});

const writeReplay = (lines: readonly unknown[]): string => {
  const path = join(scratch, `replay-${String(seq++)}.jsonl`);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return path;
};

it("`replay` 不再走「未实现」那条路径:渲染器住在 replay 包(provider 登记的包)", () => {
  const path = writeReplay([
    {
      type: "meta",
      schemaVersion: 1,
      ruleset: "v1",
      quickjsWasiVersion: null,
      sandboxRuntimeHash: null,
      wasiClock: null,
      wasiRandomFill: null,
      timezoneOffset: "+08:00",
      mapHash: "a".repeat(64),
      seed: 7,
      players: [{ model: "alpha", archiveRef: "archive/alpha/r1", seat: 0 }],
      runner: "stub",
    },
    {
      type: "tick",
      tick: 0,
      players: [],
      units: [],
      sites: [],
      events: [],
      stateHash: "c".repeat(64),
    },
  ]);
  const result = run(["replay", path]);
  expect(result.stderr).not.toContain("未实现");
  expect(result.status).toBe(0);
  // 「runner 栏读不出来」的反例:这一条红,而后果是有人拿桩跑的读数当座位轮换的结论。
  expect(result.stdout).toContain("runner stub");
});

it("`replay` 读不到文件或缺参时按装载期拒跑退 1,不静默返回成功", () => {
  // 静默 0 的反例:这两条一起红——自动化流程把「没跑成」读成「跑通了」。
  expect(run(["replay", join(scratch, "no-such-replay.jsonl")]).status).toBe(1);
  expect(run(["replay"]).status).toBe(1);
});

it("`--version` 报的版本与 apps/cli/package.json 一致", () => {
  // index.ts 里的 CLI_VERSION 是写死的(打包后不读盘),而"与 package.json 同步"这句
  // 光写在注释里没有任何东西在盯。这里把它变成断言:改了一边不改另一边,这条会红。
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const result = run(["--version"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`modelwar ${manifest.version} `);
});

// ── `match`:装载 → 校验 → 跑一局 → 写回放 → 映射退出码 ──────────────────────────

const sha256Hex = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");
// 真沙箱 runtime 的实测哈希 = 入库产物字节的 sha256(真源在 `@model-war/schema`,由 check:runtime 盯住)。
const sandboxRuntimeHash = SANDBOX_RUNTIME_HASH;

/**
 * 在临时目录里造一份**合法**的对局输入(4 份存档三件套 + input.json)。
 * 存档与 input 写在同一个 `root` 下,`archivePath` 按仓库根相对(hld §7.4 的拓扑)。
 * 造完返回 input.json 的路径。
 */
const writeMatchInput = (
  options: {
    readonly tamper?:
      | "mapSha"
      | "scriptSha"
      | "metaSha"
      | "ruleset"
      | "dropArchive"
      | "sandboxHash";
    /** 用一份**真实基准脚本**当四席的执行体(目录名,如 `cell-a-melee-pressure`)。
     * 给了它就覆盖默认的 `function loop(){ return []; }` 夹具。 */
    readonly cell?: string;
    /** 用一段自定义 `script.js` 当执行体(四席相同);与 `cell` 互斥,二选一。 */
    readonly script?: string;
  } = {},
): string => {
  const root = mkdtempSync(`${scratch}/root-`);
  const mapBytes = readFileSync(mapPath);
  const mapSha = options.tamper === "mapSha" ? "d".repeat(64) : sha256Hex(mapBytes);

  // 执行体:默认空转夹具;给了基准目录就读它的**入库产物**(`script.js` 是真沙箱跑的那份),
  // 给了自定义脚本就用它。基准脚本走 CLI 公开面(而不是引擎内部 API)正是本票要的端到端那条。
  const defaultScript = `function loop(){ return []; }\n`;
  const scriptJs =
    options.script ??
    (options.cell === undefined
      ? defaultScript
      : readFileSync(join(repoRoot, "benchmarks", options.cell, "script.js"), "utf8"));
  const scriptTs =
    options.cell === undefined
      ? defaultScript
      : readFileSync(join(repoRoot, "benchmarks", options.cell, "script.ts"), "utf8");

  const models = ["alpha", "beta", "gamma", "delta"];
  const archives = models.map((model, seat) => {
    const archivePath = `archive/${model}/r1`;
    const dir = join(root, archivePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "script.js"), scriptJs);
    writeFileSync(join(dir, "script.ts"), scriptTs);
    const scriptSha = sha256Hex(scriptJs);
    const meta = {
      model,
      modelVersion: "snapshot-1",
      generatedAt: "2026-01-01T00:00:00Z",
      protocolRounds: 1,
      prompts: [`prompt ${model}`],
      generationLog: [`generated ${model}`],
      ruleset: "v1",
      validation: { passed: true, errors: [] },
      tscVersion: "7.0.2",
      scriptSha256: scriptSha,
      sandboxRuntimeHash:
        options.tamper === "sandboxHash" && seat === 0 ? "0".repeat(64) : sandboxRuntimeHash,
    };
    const metaBytes = `${JSON.stringify(meta, null, 2)}\n`;
    writeFileSync(join(dir, "meta.json"), metaBytes);
    const recordedScript =
      options.tamper === "scriptSha" && seat === 0 ? "e".repeat(64) : scriptSha;
    const recordedMeta =
      options.tamper === "metaSha" && seat === 0 ? "f".repeat(64) : sha256Hex(metaBytes);
    return { archivePath, scriptSha256: recordedScript, metaSha256: recordedMeta };
  });

  if (options.tamper === "dropArchive") {
    rmSync(join(root, archives[2]?.archivePath ?? "", "script.js"), { force: true });
  }

  const input = {
    archives,
    map: "open-clash",
    mapSha256: mapSha,
    seed: 20260101,
    ruleset: options.tamper === "ruleset" ? "v2" : "v1",
  };
  const runDir = join(root, "runs", "r1", "matches", "c0");
  mkdirSync(runDir, { recursive: true });
  const inputPath = join(runDir, "input.json");
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  // 地图按名复制到 root,让 --root 找得到;规则集也复制一份(装载期从 root 读它)。
  mkdirSync(join(root, "maps"), { recursive: true });
  writeFileSync(join(root, "maps", "open-clash.json"), mapBytes);
  mkdirSync(join(root, "rulesets"), { recursive: true });
  writeFileSync(
    join(root, "rulesets", "v1.json"),
    readFileSync(fileURLToPath(new URL("../../../rulesets/v1.json", import.meta.url))),
  );

  // 真沙箱把 runtime bundle 与 wasm 当**安装根下的资源**读(路径真源在 `@model-war/schema`);
  // 物化进临时 root,于是 `--root` 就是这一局的安装根,测试不必依赖仓库根的 node_modules 布局。
  const artifactPath = join(root, SANDBOX_RUNTIME_ARTIFACT_PATH);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, readFileSync(join(repoRoot, SANDBOX_RUNTIME_ARTIFACT_PATH)));
  const wasmPath = join(root, QUICKJS_WASI_WASM_PATH);
  mkdirSync(dirname(wasmPath), { recursive: true });
  writeFileSync(wasmPath, readFileSync(join(repoRoot, QUICKJS_WASI_WASM_PATH)));

  return inputPath;
};

it(
  "`match` 跑完一整场到超时,退出 0,回放落盘且能被 `replay` 渲染(真沙箱)",
  { timeout: 120_000 },
  () => {
    const inputPath = writeMatchInput();
    const runDir = join(inputPath, "..");
    const root = inputPath.slice(0, inputPath.indexOf("/runs/"));
    const result = run(["match", inputPath, "--root", root]);
    // 「规则内结果一律 0」:超时是**合法结果**,不是失败。
    expect(result.status, result.stderr).toBe(0);
    const replayPath = join(runDir, "replay.jsonl");
    const lines = readFileSync(replayPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].type).toBe("meta");
    // 真沙箱:runner 是 quickjs,五个沙箱栏都是真值(不是 null)。
    expect(lines[0].runner).toBe("quickjs");
    expect(lines[0].sandboxRuntimeHash).toBe(sandboxRuntimeHash);
    expect(lines[0].quickjsWasiVersion).toBeTruthy();
    expect(lines[0].wasiClock).toBeTruthy();
    expect(lines[0].wasiRandomFill).toBeTruthy();
    expect(lines[0].wasiTimezoneOffset).toBeTruthy();
    expect(lines.at(-1).type).toBe("result");
    // 600 tick + meta + result。
    expect(lines).toHaveLength(602);
    // 回放能渲染:第二条命令看得到画面。
    const shown = run(["replay", replayPath]);
    expect(shown.status).toBe(0);
    expect(shown.stdout).toContain("runner quickjs");
  },
);

/**
 * `--root` 写在位置参数**前面**也要能跑。
 *
 * 反例:把参数摘取写成 `args.filter((arg) => !arg.startsWith("-"))`,`--root` 的**值**
 * 不以 `-` 开头,于是它被当成位置参数、`positional[0]` 成了根目录——一个目录被拿去
 * `JSON.parse`。用法串把 `<input.json>` 写在前面只是惯例,参数顺序不该决定命令能不能跑。
 */
it("`match` 的 `--root` 写在 <input.json> 前面也能跑,退出 0", { timeout: 120_000 }, () => {
  const inputPath = writeMatchInput();
  const root = inputPath.slice(0, inputPath.indexOf("/runs/"));
  const result = run(["match", "--root", root, inputPath]);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(inputPath, "..", "replay.jsonl"), "utf8")).not.toBe("");
});

it("`match` 装载期拒跑一律退 1:缺档 / 哈希不符 / 规则集版本不一致,一条都不静默 0", () => {
  for (const tamper of [
    "dropArchive",
    "scriptSha",
    "metaSha",
    "mapSha",
    "ruleset",
    // 存档 meta 记的沙箱 runtime hash 与本仓入库产物不符:拒跑,不静默换。
    "sandboxHash",
  ] as const) {
    const inputPath = writeMatchInput({ tamper });
    const root = inputPath.slice(0, inputPath.indexOf("/runs/"));
    const result = run(["match", inputPath, "--root", root]);
    expect(result.status, `${tamper} 应当按装载期拒跑退 1,stderr:\n${result.stderr}`).toBe(1);
  }
  // 缺参也退 1(不是 0,也不是别的)。
  expect(run(["match"]).status).toBe(1);
  // 读不到输入文件也退 1。
  expect(run(["match", join(scratch, "no-such-input.json")]).status).toBe(1);
});

it("`match` 不再走「未实现」那条路径:处理器住在 CLI 的 match 模块", { timeout: 120_000 }, () => {
  const inputPath = writeMatchInput();
  const root = inputPath.slice(0, inputPath.indexOf("/runs/"));
  const result = run(["match", inputPath, "--root", root]);
  expect(result.stderr).not.toContain("未实现");
});

// ── `verify`:按 input.json 重新执行 → 逐 tick hash 比对 ───────────────────────

/** 跑一局拿到回放路径与它的 root。返回 `[replayPath, root]`。 */
const matchToReplay = (): readonly [string, string] => {
  const inputPath = writeMatchInput();
  const root = inputPath.slice(0, inputPath.indexOf("/runs/"));
  const matched = run(["match", inputPath, "--root", root]);
  expect(matched.status, matched.stderr).toBe(0);
  return [join(inputPath, "..", "replay.jsonl"), root];
};

/** 读回放为可改的对象数组,改完写回同一个目录(verify 按 `dirname(replay)/input.json` 找输入)。 */
const editReplay = (
  replayPath: string,
  mutate: (lines: Record<string, unknown>[]) => void,
): void => {
  const lines = readFileSync(replayPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  mutate(lines);
  writeFileSync(replayPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
};

it(
  "`verify` 按 input.json 重新执行:match → verify 逐 tick 一致,退出 0",
  { timeout: 120_000 },
  () => {
    const [replayPath, root] = matchToReplay();
    const verified = run(["verify", replayPath, "--root", root]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain("逐项一致");
  },
);

it("`verify` 读不到回放或缺参时按装载期拒跑退 1", () => {
  expect(run(["verify", join(scratch, "no-such-replay.jsonl")]).status).toBe(1);
  expect(run(["verify"]).status).toBe(1);
});

it(
  "`verify` 改回放里一个数字即红:改一个 tick 的 stateHash(与自己载荷不符)退 1",
  { timeout: 120_000 },
  () => {
    const [replayPath, root] = matchToReplay();
    editReplay(replayPath, (lines) => {
      const tick = lines[1];
      if (tick === undefined) {
        throw new Error("回放没有 tick 行");
      }
      // 改最后一位:stateHash 不再等于它自己载荷的摘要。
      const hash = String(tick["stateHash"]);
      tick["stateHash"] = `${hash.slice(0, -1)}${hash.endsWith("0") ? "1" : "0"}`;
    });
    expect(run(["verify", replayPath, "--root", root]).status).toBe(1);
  },
);

it("`verify` 改末行 result 的一个数字即红,退 1", { timeout: 120_000 }, () => {
  const [replayPath, root] = matchToReplay();
  editReplay(replayPath, (lines) => {
    const result = lines.at(-1);
    const rankings = result?.["rankings"];
    if (result === undefined || !Array.isArray(rankings)) {
      throw new Error("回放没有末行 result");
    }
    rankings[0] = Number(rankings[0]) + 1;
  });
  expect(run(["verify", replayPath, "--root", root]).status).toBe(1);
});

it(
  "`verify` 核 meta 的运行时 hash 与本次执行是否一致:不一致即报错退 1,不静默换",
  { timeout: 120_000 },
  () => {
    const [replayPath, root] = matchToReplay();
    editReplay(replayPath, (lines) => {
      const meta = lines[0];
      if (meta === undefined) {
        throw new Error("回放没有 meta 行");
      }
      // 形状仍合法(64 位十六进制),但与本次产物 hash 不同。
      meta["sandboxRuntimeHash"] = "0".repeat(64);
    });
    const verified = run(["verify", replayPath, "--root", root]);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain("sandboxRuntimeHash");
  },
);

it(
  "`verify` 核 meta 的执行方式:存档写 stub 与本次真沙箱不符即退 1,不静默换",
  { timeout: 120_000 },
  () => {
    const [replayPath, root] = matchToReplay();
    editReplay(replayPath, (lines) => {
      const meta = lines[0];
      if (meta === undefined) {
        throw new Error("回放没有 meta 行");
      }
      // 形状仍合法(stub 那一支要求五个沙箱栏全为 null),但与本次真沙箱执行不符。
      meta["runner"] = "stub";
      for (const field of [
        "quickjsWasiVersion",
        "sandboxRuntimeHash",
        "wasiClock",
        "wasiRandomFill",
        "wasiTimezoneOffset",
      ]) {
        meta[field] = null;
      }
    });
    const verified = run(["verify", replayPath, "--root", root]);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain("执行方式不一致");
  },
);

// ── 真实基准脚本:CLI 公开面完整跑通(match 写回放 → verify 复算) ─────────────────

/**
 * 本票要求「至少一份**真实基准脚本**」走 CLI 公开面(`match` 写回放、`verify` 复算)全绿。
 * 它**不是**夹具脚本、**不是**桩:夹具脚本只用得到极少几个注入面符号,而真实基准脚本要用
 * 完整注入面——它能跑通,就是「注入面铺全」那张票的独立证据(见 spec《Solution》)。
 * 执行体取 `benchmarks/<舱>/script.js` 这份**入库产物**(真沙箱编译执行的那一份)。
 */
it(
  "真实基准脚本 cell-a:match 写回放 → verify 复算一致,退出 0(真沙箱)",
  { timeout: 120_000 },
  () => {
    const inputPath = writeMatchInput({ cell: "cell-a-melee-pressure" });
    const root = inputPath.slice(0, inputPath.indexOf("/runs/"));
    const matched = run(["match", inputPath, "--root", root]);
    expect(matched.status, matched.stderr).toBe(0);

    const replayPath = join(inputPath, "..", "replay.jsonl");
    const lines = readFileSync(replayPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // 真沙箱的一整场:meta 在前、600 个 tick、末行 result。
    expect(lines[0]?.["type"]).toBe("meta");
    expect(lines[0]?.["runner"]).toBe("quickjs");
    expect(lines.at(-1)?.["type"]).toBe("result");
    expect(lines.length).toBeGreaterThan(2);

    // 复算:按 input.json 重新执行,逐 tick 与末行都一致。
    const verified = run(["verify", replayPath, "--root", root]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain("逐项一致");
  },
);

/**
 * 三份基准脚本作为夹具在真沙箱里各跑完整场:**含 `cell-c`**。
 *
 * `cell-c`(占点不采集)在真规则下**不累积占领进度**——它的占领机制是猜的(契约 §5 未排期),
 * 那笔账归「占领契约补齐」节点,不是本 feature 的缺口(spec《Out of Scope》)。本票要证的是
 * 它**仍能跑完**(产出合法 result 行),不假装它不存在,也不被它拖住。
 */
const BENCHMARK_CELLS = [
  "cell-a-melee-pressure",
  "cell-b-expansion-economy",
  "cell-c-claim-no-harvest",
] as const;

it.each(BENCHMARK_CELLS)(
  "真实基准脚本 %s 作为夹具在真沙箱里跑完整场,退出 0",
  { timeout: 120_000 },
  (cell) => {
    const inputPath = writeMatchInput({ cell });
    const root = inputPath.slice(0, inputPath.indexOf("/runs/"));
    const matched = run(["match", inputPath, "--root", root]);
    // 「跑完整场」的判据 = 产出了一份合法的末行 result(规则内结果一律 0)。
    expect(matched.status, matched.stderr).toBe(0);
    const lines = readFileSync(join(inputPath, "..", "replay.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]?.["type"]).toBe("meta");
    expect(lines[0]?.["runner"]).toBe("quickjs");
    expect(lines.at(-1)?.["type"]).toBe("result");
  },
);

// ── 退出码表:引擎故障(2)在真沙箱上的一次实证 ────────────────────────────────

it("`match` 遇到引擎故障(真沙箱宿主 RangeError)退 2,不静默 0", { timeout: 120_000 }, () => {
  // 深递归栈溢出实测为 host 侧 `RangeError: Maximum call stack size exceeded`
  // (`isJSException: false`,见 hld §5.0 第 2 行):它既不是 guest 可捕获异常、也不在判罚轨,
  // 而是引擎故障 → 退出码 2(stderr 另给一行 JSON)。
  const inputPath = writeMatchInput({
    script: "function loop(){ return (function f(){ return f(); })(); }\n",
  });
  const root = inputPath.slice(0, inputPath.indexOf("/runs/"));
  const result = run(["match", inputPath, "--root", root]);
  expect(result.status, result.stderr).toBe(2);
  expect(result.stderr).toContain("引擎故障");
});
