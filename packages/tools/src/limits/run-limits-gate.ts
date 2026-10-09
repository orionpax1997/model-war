/**
 * 门禁:**对局墙钟 / 快照拷贝占比 / 单季回放体量**(根脚本 `check:limits`)。
 *
 * ```
 * node --disable-warning=ExperimentalWarning \
 *   packages/tools/src/limits/run-limits-gate.ts \
 *   [--matches=N] [--seed=N] [--copy-inflate=N] [--volume-inflate=N] \
 *   [--season-matches=N] [--readings-out=<路径>] [--keep]
 * ```
 *
 * ── 它把 hld §12 的两条开放项收成可执行断言(不重构) ─────────────────────────
 *
 * - **#6 快照拷贝粒度**:`buildSnapshot`(深拷贝 + 深 freeze)与「只深拷贝」的差值,按「每 tick
 *   四席各拷一次」换算成整局的拷贝税,占**同一局墙钟**的比例必须 **< 10%** 即停。这条阈值不是
 *   优化目标,是**停止条件**:占比还在线内就不许为零拷贝去动快照结构(那会踩
 *   `snapshot/traversal-independence.test.ts` 钉住的「深 freeze 与 stateHash 规范化两次遍历不许合并」)。
 * - **#7 单季回放体量**:一个赛季(算例 N=5/M=3/K=5 → 75 局)的回放总量必须 **< 1 GiB**,
 *   且夜间一遍读完必须 **< 10 min**。超了就红,不做压缩 / 增量回放。
 *
 * ── 为什么这条门禁不是零构建 ─────────────────────────────────────────────────
 *
 * 它要 spawn 一次 `tsc -b`(工作区包的 `exports` 指向 `dist/`),然后**在同一个进程里**用真引擎
 * 跑真沙箱对局:同一批入库基准脚本(`benchmarks/<cell>/script.js`)、固定种子、入库地图与规则集。
 * 因此它归**按需→夜间**层,**不进** `check:quick` / `check` / `test` / `verify:fast`(零构建的
 * 性质不能破)。位置纪律由 `gates.test.ts` 的 `单局墙钟与快照回放门禁按需跑…` 盯着;正例与
 * 两侧反例在 `gates-slow.test.ts`。
 *
 * ── 引擎内部符号怎么拿(不新增依赖、不改引擎导出面) ────────────────────────
 *
 * `packages/tools` 按架构只依赖真源包 `@model-war/schema`(hld §3.2:`tsc -b` 会拦住未声明的包)。
 * 而本门禁要的 `runMatch` / `buildSnapshot` / `createQuickJsRunner` 与沙箱常量分别在
 * `@model-war/engine` 的主入口、两个内部 dist 模块与 `@model-war/schema` 的 dist 里。解法与
 * `check:selfproof` 动态 `import` 桩同源:**用绝对路径动态 import `dist`**(`import(变量)` 不经
 * tsc 解析,故不构成一条被声明的包边),不新开 import 面、不给 tools 加依赖。动态也顺带让
 * `tsc -b` 能排在装载之前——静态 import 会在模块装载期就去解析 `dist`,那是本门禁还没建好的东西。
 *
 * ── 反例用的两个开关(红 → 还原 → 绿) ────────────────────────────────────────
 *
 * `--copy-inflate=N` 把量到的拷贝差值按倍数放大(模拟「深 freeze 那一趟变贵」);`--volume-inflate=N`
 * 把单局回放体量按倍数放大(模拟「每 tick 载荷变胖」)。两者默认 1(不放大)。`gates-slow.test.ts`
 * 用它们现做现验:放大即红,去掉开关即绿。**它们只改断言里代入的那一笔量,不改任何仓库文件。**
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 仓库根 = 本文件上溯四级(`packages/tools/src/limits/`)。 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** 入库基准脚本登记册(与 `benchmarks/compile.ts` 同源,这里只列名;执行体是入库产物)。 */
const BENCHMARK_CELLS = [
  "cell-a-melee-pressure",
  "cell-b-expansion-economy",
  "cell-c-claim-no-harvest",
] as const;

const MAP_NAME = "open-clash";
const RULESET_VERSION = "v1";
const DEFAULT_SEED = 20260101;
/** 算例赛季规模(srs NFR-3 的 N=5/M=3/K=5 → 75 局)。 */
const DEFAULT_SEASON_MATCHES = 75;
/** #6 的停止条件:拷贝税占单局墙钟 < 10%。 */
const COPY_SHARE_LIMIT_PERCENT = 10;
/** #7 的停止条件:单季回放总量 < 1 GiB、夜间一遍读完 < 10 min。 */
const SEASON_BYTE_LIMIT = 1024 ** 3;
const NIGHTLY_READ_LIMIT_SECONDS = 600;
/** 每 tick 每席各构一次快照,四席串行共用一份(hld §4.5)。 */
const SNAPSHOTS_PER_TICK = 4;
/** 快照拷贝微基准的取样次数(与 `.scratch/engine-core/readings.md` 同口径,取中位)。 */
const COPY_SAMPLES = 5;

// ── 命令行 ──────────────────────────────────────────────────────────────────

type Options = {
  /** 采样局数(默认每舱一局)。 */
  readonly matches: number;
  readonly seed: number;
  readonly copyInflate: number;
  readonly volumeInflate: number;
  readonly seasonMatches: number;
  readonly readingsOut: string | null;
  readonly keep: boolean;
};

const positiveInt = (name: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数,收到 "${raw}"。`);
  }
  return parsed;
};

const positiveNumber = (name: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正数,收到 "${raw}"。`);
  }
  return parsed;
};

const parseArgs = (argv: readonly string[]): Options => {
  const valueOf = (prefix: string): string | undefined =>
    argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  return {
    matches: positiveInt("--matches", valueOf("--matches="), BENCHMARK_CELLS.length),
    seed: positiveInt("--seed", valueOf("--seed="), DEFAULT_SEED),
    copyInflate: positiveNumber("--copy-inflate", valueOf("--copy-inflate="), 1),
    volumeInflate: positiveNumber("--volume-inflate", valueOf("--volume-inflate="), 1),
    seasonMatches: positiveInt(
      "--season-matches",
      valueOf("--season-matches="),
      DEFAULT_SEASON_MATCHES,
    ),
    readingsOut: valueOf("--readings-out=") ?? null,
    keep: argv.includes("--keep"),
  };
};

// ── 小工具 ──────────────────────────────────────────────────────────────────

const quantileOf = (values: readonly number[], q: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? 0;
};

const medianOf = (values: readonly number[]): number => quantileOf(values, 0.5);
const meanOf = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};
const maxOf = (values: readonly number[]): number =>
  values.length === 0 ? 0 : Math.max(...values);

/** 快照六栏的形状投影(与 `snapshot/snapshot.ts` 的 `snapshotShapeOf` 逐栏一致)。 */
type SnapshotShape = {
  readonly tick: number;
  readonly size: number;
  readonly terrain: unknown;
  readonly players: unknown;
  readonly units: unknown;
  readonly sites: unknown;
};

const shapeOf = (state: SnapshotShape): unknown => ({
  tick: state.tick,
  size: state.size,
  terrain: state.terrain,
  players: state.players,
  units: state.units,
  sites: state.sites,
});

// ── 进程与构建 ──────────────────────────────────────────────────────────────

const TSC = join(repoRoot, "node_modules/typescript/bin/tsc");

const typecheck = (): string | null => {
  const result = spawnSync(process.execPath, [TSC, "-b", "--pretty", "false"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return result.status === 0 ? null : `tsc -b 失败:\n${result.stdout}${result.stderr}`;
};

// ── 引擎 dist 的动态装载 ────────────────────────────────────────────────────

type RunMatchParams = {
  readonly ruleset: unknown;
  readonly map: unknown;
  readonly seed: number;
  readonly head: unknown;
  readonly players: readonly unknown[];
  readonly runners: readonly unknown[];
  readonly budget: unknown;
  readonly sink: { readonly write: (line: string) => void };
};

type RunMatchResult =
  | {
      readonly status: "completed";
      readonly tickCount: number;
      readonly finalState: SnapshotShape;
    }
  | { readonly status: "uncertain-timeout"; readonly tick: number };

type EngineModules = {
  readonly runMatch: (params: RunMatchParams) => RunMatchResult;
  readonly buildSnapshot: (state: unknown) => unknown;
  readonly createQuickJsRunner: (options: {
    readonly wasm: WebAssembly.Module;
    readonly runtimeCode: string;
    readonly scriptCode: string;
    readonly seat: number;
  }) => Promise<{ readonly runner: unknown; readonly dispose: () => void }>;
  readonly WASI_CLOCK_MS: number;
  readonly WASI_TIMEZONE_OFFSET_MINUTES: number;
  readonly WASI_RANDOM_FILL: string;
  /** 沙箱常量(真源在 `@model-war/schema`,与引擎侧各取所需;这里只取本门禁读的那几个)。 */
  readonly quickjsWasiVersion: string;
  readonly wasmPath: string;
  readonly runtimeArtifactPath: string;
  readonly runtimeHash: string;
};

const loadEngine = async (): Promise<EngineModules> => {
  const dist = (relative: string): Promise<Record<string, unknown>> =>
    import(pathToFileURL(join(repoRoot, relative)).href);
  const schema = await dist("packages/schema/dist/index.js");
  const index = await dist("packages/engine/dist/index.js");
  const snapshot = await dist("packages/engine/dist/snapshot/snapshot.js");
  const quickjs = await dist("packages/engine/dist/runner/quickjs.js");
  return {
    runMatch: index["runMatch"] as EngineModules["runMatch"],
    buildSnapshot: snapshot["buildSnapshot"] as EngineModules["buildSnapshot"],
    createQuickJsRunner: quickjs["createQuickJsRunner"] as EngineModules["createQuickJsRunner"],
    WASI_CLOCK_MS: quickjs["WASI_CLOCK_MS"] as number,
    WASI_TIMEZONE_OFFSET_MINUTES: quickjs["WASI_TIMEZONE_OFFSET_MINUTES"] as number,
    WASI_RANDOM_FILL: quickjs["WASI_RANDOM_FILL"] as string,
    quickjsWasiVersion: schema["QUICKJS_WASI_VERSION"] as string,
    wasmPath: schema["QUICKJS_WASI_WASM_PATH"] as string,
    runtimeArtifactPath: schema["SANDBOX_RUNTIME_ARTIFACT_PATH"] as string,
    runtimeHash: schema["SANDBOX_RUNTIME_HASH"] as string,
  };
};

// ── 采样 ────────────────────────────────────────────────────────────────────

type MatchSample = {
  readonly cell: string;
  readonly seed: number;
  readonly status: string;
  readonly ticks: number;
  readonly wallMs: number;
  readonly replayBytes: number;
  readonly buildSnapshotMs: number;
  readonly cloneMs: number;
};

type SampledMatch = { readonly sample: MatchSample; readonly replayText: string };

/** 每局用哪一舱、哪颗种子:三舱轮转,种子逐局递增(样本可复现)。 */
const planOf = (options: Options): readonly { cell: string; seed: number }[] =>
  Array.from({ length: options.matches }, (_, index) => ({
    cell: BENCHMARK_CELLS[index % BENCHMARK_CELLS.length] as string,
    seed: options.seed + index,
  }));

const runSample = async (
  engine: EngineModules,
  plan: { readonly cell: string; readonly seed: number },
  wasm: WebAssembly.Module,
  runtimeCode: string,
  ruleset: unknown,
  map: unknown,
): Promise<SampledMatch> => {
  const scriptCode = readFileSync(join(repoRoot, "benchmarks", plan.cell, "script.js"), "utf8");
  const seats = await Promise.all(
    [0, 1, 2, 3].map((seat) => engine.createQuickJsRunner({ wasm, runtimeCode, scriptCode, seat })),
  );
  const lines: string[] = [];
  try {
    const players = [0, 1, 2, 3].map((seat) => ({
      model: plan.cell,
      archiveRef: `bench/${plan.cell}/s${String(plan.seed)}/${String(seat)}`,
      seat,
    }));
    const started = performance.now();
    const result = engine.runMatch({
      ruleset,
      map,
      seed: plan.seed,
      head: {
        runner: "quickjs",
        timezoneOffset: "+00:00",
        mapHash: "e".repeat(64),
        quickjsWasiVersion: engine.quickjsWasiVersion,
        sandboxRuntimeHash: engine.runtimeHash,
        wasiClock: String(engine.WASI_CLOCK_MS),
        wasiRandomFill: engine.WASI_RANDOM_FILL,
        wasiTimezoneOffset: String(engine.WASI_TIMEZONE_OFFSET_MINUTES),
      },
      players,
      runners: seats.map((seat) => seat.runner),
      budget: {},
      sink: { write: (line) => lines.push(line) },
    });
    const wallMs = performance.now() - started;
    const replayBytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, 0);

    let buildSnapshotMs = 0;
    let cloneMs = 0;
    let ticks = 0;
    if (result.status === "completed") {
      ticks = result.tickCount;
      const finalState = result.finalState;
      const buildSamples: number[] = [];
      const cloneSamples: number[] = [];
      for (let sample = 0; sample < COPY_SAMPLES; sample += 1) {
        let start = performance.now();
        engine.buildSnapshot(finalState);
        buildSamples.push(performance.now() - start);
        start = performance.now();
        structuredClone(shapeOf(finalState));
        cloneSamples.push(performance.now() - start);
      }
      buildSnapshotMs = medianOf(buildSamples);
      cloneMs = medianOf(cloneSamples);
    }
    return {
      sample: {
        cell: plan.cell,
        seed: plan.seed,
        status: result.status,
        ticks,
        wallMs,
        replayBytes,
        buildSnapshotMs,
        cloneMs,
      },
      replayText: lines.join("\n"),
    };
  } finally {
    for (const seat of seats) {
      seat.dispose();
    }
  }
};

// ── 判据 ────────────────────────────────────────────────────────────────────

type LimitsReport = {
  readonly samples: readonly MatchSample[];
  readonly wallP50Ms: number;
  readonly wallMeanMs: number;
  readonly wallWorstMs: number;
  readonly buildSnapshotMedianMs: number;
  readonly cloneMedianMs: number;
  readonly copyCostMs: number;
  readonly copySharePercent: number;
  readonly copyPass: boolean;
  readonly perMatchMeanBytes: number;
  readonly seasonBytes: number;
  readonly seasonSizePass: boolean;
  readonly readRateBytesPerSec: number;
  readonly seasonReadSeconds: number;
  readonly seasonReadPass: boolean;
  readonly pass: boolean;
};

/**
 * 读一遍的速率(bytes/s):把样本里最大的那份回放写到临时文件,连读若干次取速率。
 * 口径与「夜间一遍读完」一致——读的是磁盘上的回放字节,不是内存里的数组。
 */
const measureReadRate = (largestReplay: string, workDir: string): number => {
  const path = join(workDir, "largest-replay.jsonl");
  writeFileSync(path, largestReplay, "utf8");
  const bytes = Buffer.byteLength(largestReplay, "utf8");
  const rounds = 20;
  const started = performance.now();
  for (let round = 0; round < rounds; round += 1) {
    readFileSync(path);
  }
  const seconds = (performance.now() - started) / 1000;
  return seconds > 0 ? (bytes * rounds) / seconds : Number.POSITIVE_INFINITY;
};

const buildReport = (
  samples: readonly MatchSample[],
  options: Options,
  workDir: string,
  largestReplay: string,
): LimitsReport => {
  const walls = samples.map((sample) => sample.wallMs);
  // 「每 tick 四席各一次快照」把每局的拷贝税换算出来:4 × tick × (深拷贝+freeze − 只深拷贝)。
  const copyCostTotal = samples.reduce(
    (sum, sample) =>
      sum + SNAPSHOTS_PER_TICK * sample.ticks * (sample.buildSnapshotMs - sample.cloneMs),
    0,
  );
  const wallTotal = walls.reduce((sum, value) => sum + value, 0);
  const copySharePercent =
    wallTotal > 0
      ? ((copyCostTotal * options.copyInflate) / wallTotal) * 100
      : Number.POSITIVE_INFINITY;

  const perMatchMeanBytes =
    meanOf(samples.map((sample) => sample.replayBytes)) * options.volumeInflate;
  const seasonBytes = options.seasonMatches * perMatchMeanBytes;
  const readRateBytesPerSec = measureReadRate(largestReplay, workDir);
  const seasonReadSeconds =
    readRateBytesPerSec > 0 ? seasonBytes / readRateBytesPerSec : Number.POSITIVE_INFINITY;

  const copyPass = copySharePercent < COPY_SHARE_LIMIT_PERCENT;
  const seasonSizePass = seasonBytes < SEASON_BYTE_LIMIT;
  const seasonReadPass = seasonReadSeconds < NIGHTLY_READ_LIMIT_SECONDS;

  return {
    samples,
    wallP50Ms: medianOf(walls),
    wallMeanMs: meanOf(walls),
    wallWorstMs: maxOf(walls),
    buildSnapshotMedianMs: medianOf(samples.map((sample) => sample.buildSnapshotMs)),
    cloneMedianMs: medianOf(samples.map((sample) => sample.cloneMs)),
    copyCostMs: copyCostTotal,
    copySharePercent,
    copyPass,
    perMatchMeanBytes,
    seasonBytes,
    seasonSizePass,
    readRateBytesPerSec,
    seasonReadSeconds,
    seasonReadPass,
    pass: copyPass && seasonSizePass && seasonReadPass,
  };
};

// ── 报告 ────────────────────────────────────────────────────────────────────

const fixed = (value: number, digits: number): string => value.toFixed(digits);
const mib = (bytes: number): string => fixed(bytes / 1024 ** 2, 1);

const machineConfig = (): Record<string, string | number> => ({
  node: process.version,
  platform: `${platform()} ${release()}`,
  arch: arch(),
  cpus: cpus().length,
});

const renderReport = (
  options: Options,
  report: LimitsReport,
  machine: Record<string, string | number>,
): string => {
  const lines: string[] = [];
  const cells = [...new Set(report.samples.map((sample) => sample.cell))];
  const seeds = report.samples.map((sample) => sample.seed);
  lines.push("limits 门禁:对局墙钟 + 快照拷贝占比 + 单季回放体量(真引擎、真沙箱、单进程逐局)");
  lines.push(
    `环境:Node ${String(machine["node"])} / ${String(machine["platform"])} / ${String(machine["arch"])} / ${String(machine["cpus"])} cpus`,
  );
  lines.push(
    `样本:${String(report.samples.length)} 局(基准舱 ${cells.join("/")},种子 ${String(seeds[0] ?? 0)}..${String(seeds.at(-1) ?? 0)}),执行体为 benchmarks/<cell>/script.js`,
  );
  lines.push(
    `单局墙钟(ms):p50=${fixed(report.wallP50Ms, 1)} 均值=${fixed(report.wallMeanMs, 1)} 最坏=${fixed(report.wallWorstMs, 1)}`,
  );
  lines.push(
    `#6 快照拷贝:buildSnapshot 中位 ${fixed(report.buildSnapshotMedianMs, 3)} ms、只深拷贝中位 ${fixed(report.cloneMedianMs, 3)} ms;` +
      `整局拷贝税 ${fixed(report.copyCostMs, 1)} ms(4 席 × tick × Δ)占单局墙钟 ${fixed(report.copySharePercent, 2)}%(阈值 < ${String(COPY_SHARE_LIMIT_PERCENT)}%)→ ${report.copyPass ? "绿" : "**红**"}`,
  );
  lines.push(
    `#7 单季回放:单局均值 ${mib(report.perMatchMeanBytes)} MiB;${String(options.seasonMatches)} 局合计 ${mib(report.seasonBytes)} MiB` +
      `(阈值 < ${mib(SEASON_BYTE_LIMIT)} MiB)→ ${report.seasonSizePass ? "绿" : "**红**"};` +
      `读一遍 ${fixed(report.seasonReadSeconds, 3)} s(速率 ${mib(report.readRateBytesPerSec)} MiB/s,阈值 < ${String(NIGHTLY_READ_LIMIT_SECONDS)} s)→ ${report.seasonReadPass ? "绿" : "**红**"}`,
  );
  if (options.copyInflate !== 1 || options.volumeInflate !== 1) {
    lines.push(
      `反例开关:--copy-inflate=${String(options.copyInflate)}、--volume-inflate=${String(options.volumeInflate)}(默认 1)`,
    );
  }
  lines.push(`limits 门禁:${report.pass ? "绿" : "红"}`);
  return lines.join("\n");
};

// ── 入口 ────────────────────────────────────────────────────────────────────

const main = async (argv: readonly string[]): Promise<number> => {
  const options = parseArgs(argv);
  const buildFailure = typecheck();
  if (buildFailure !== null) {
    process.stderr.write(`${buildFailure}\n`);
    process.stdout.write("limits 门禁:红(tsc -b 没通过)\n");
    return 1;
  }

  const scratch = mkdtempSync(join(tmpdir(), "model-war-limits-"));
  try {
    const engine = await loadEngine();
    const wasm = await WebAssembly.compile(readFileSync(join(repoRoot, engine.wasmPath)));
    const runtimeCode = readFileSync(join(repoRoot, engine.runtimeArtifactPath), "utf8");
    const rulesetText = readFileSync(join(repoRoot, "rulesets", `${RULESET_VERSION}.json`), "utf8");
    const mapText = readFileSync(join(repoRoot, "maps", `${MAP_NAME}.json`), "utf8");
    const ruleset = JSON.parse(rulesetText) as unknown;
    const map = JSON.parse(mapText) as unknown;

    const samples: MatchSample[] = [];
    let largestReplay = "";
    for (const plan of planOf(options)) {
      const sampled = await runSample(engine, plan, wasm, runtimeCode, ruleset, map);
      samples.push(sampled.sample);
      if (
        Buffer.byteLength(sampled.replayText, "utf8") >= Buffer.byteLength(largestReplay, "utf8")
      ) {
        largestReplay = sampled.replayText;
      }
      // 逐个稳定输出进度,长跑时能看出卡在哪(门禁默认只 3 局,读数是 30+ 局)。
      process.stdout.write(
        `  第 ${String(samples.length)} 局:${plan.cell} 种子 ${String(plan.seed)} → ${sampled.sample.status},` +
          `tick ${String(sampled.sample.ticks)},墙钟 ${fixed(sampled.sample.wallMs, 1)} ms,回放 ${mib(sampled.sample.replayBytes)} MiB\n`,
      );
    }

    const report = buildReport(samples, options, scratch, largestReplay);
    const machine = machineConfig();
    process.stdout.write(`${renderReport(options, report, machine)}\n`);

    if (options.readingsOut !== null) {
      const outPath = join(repoRoot, options.readingsOut);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${JSON.stringify({ machine, options, report }, null, 2)}\n`, "utf8");
      process.stdout.write(`读数已落盘 ${options.readingsOut}\n`);
    }
    return report.pass ? 0 : 1;
  } finally {
    if (options.keep) {
      process.stdout.write(`临时目录保留在 ${scratch}\n`);
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
};

process.exitCode = await main(process.argv.slice(2));
