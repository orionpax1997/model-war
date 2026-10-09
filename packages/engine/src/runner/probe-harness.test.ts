/**
 * 票 03:预算标定探针的骨架(缝 A:引擎侧「读数测试 + `MW_READINGS_DIR` 落盘」约定)与**两个量测探针**。
 * 票 04:在同一条骨架上加**三类预算探针**与**诚实侧基准读数**。
 *
 * ── 它交付什么 ──
 *
 * 票 03:①**分配上限的封顶**(`memoryLimit − 读出封顶`,以及它如何随分配形态变化);②**装 runtime
 * bundle 之后的存活堆基线**,与空 VM 基线(`EMPTY_VM_MALLOC_SIZE = 75128`)分列。
 * 票 04:③**死循环探针**与**API 轰炸探针**各自的「每毫秒能烧多少」与**截停它的是哪条轨**;
 * ④**三轨异常探针**:三条轨各被反复触发,产出 `exceptionTicks` 读数(并记下同 tick 最多叠加两次);
 * ⑤**诚实侧**:三份基准脚本在真引擎上跑出「每场每席峰值 → 全局最坏」(存活堆峰值、单 tick 与单局
 * 墙钟、API 峰值)。
 *
 * 本文件**只放数与测法、不放任何建议阈值**(取值是后续票的事)。
 *
 * ── 骨架来自哪 ──
 *
 * `packages/engine/src/runner/probe-harness.ts` 的 `createProbeSeat` 逐条镜像
 * `createQuickJsRunner` 的每 tick 次序、只在中间多记一笔读数(它的头注记着两个必须继承的坑)。
 * 判定式探针用 `runBudgetProbeTick`(它走**真执行器**,截停轨由引擎自己给出,不是探针重算的)。
 * 两者都长自一次性 prototype `.scratch/budget-calibration/prototype/readings-probe.mjs`。
 *
 * ── 规模:默认小,读数时按 env 放大 ──
 *
 * check 链上每跑一次都要便宜:默认样本很小(一个分配形态、1 MiB 上限、探针各 1 次、三轨各 3 tick、
 * 诚实侧一场),只在 `MW_READINGS_DIR` 设上时才展开(四个形态、8 MiB 上限、探针各 5 次、三轨各 8 tick、
 * 诚实侧三舱 × 三图 + 混编)。复现命令见 `readings.md` 与根 `package.json` 的 `probes:budget`。
 * **不设读数目录时零文件副作用**——落盘全在这一个闸门后面。
 *
 * ── 为什么不另写「读数等于某个数」的断言 ──
 *
 * 读数是交付物,断言由既有的执行器行为用例负责(见 `quickjs.test.ts`)。把读数的具体值写进
 * `expect` 只会把一次快照钉死成一条永远会漂的断言;本条只钉「探针真的跑完了、读数形状良好」。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, it } from "vitest";
import {
  MEMORY_SOFT_THRESHOLD_RATIO,
  QUICKJS_WASI_VERSION,
  RULESET_KEY_CATALOG,
  SANDBOX_RUNTIME_ARTIFACT_PATH,
  SANDBOX_RUNTIME_HASH,
  type MapDefinition,
  type Ruleset,
} from "@model-war/replay";

import { runMatch } from "../index.js";
import {
  EVENT_SPIN_PROBE_SCRIPT,
  MEMORY_API_PROBE_SCRIPT,
  MEMORY_HOARD_PROBE_SCRIPT,
  NEVER_EVENT_LIMIT,
  apiBombProbeScript,
  createProbeSeat,
  runBudgetProbeTick,
  type ProbeTickReading,
} from "./probe-harness.js";
import { stubRunner } from "./stub.js";
import {
  API_CALL_TRACK,
  EVENT_TRACK,
  INTERRUPT_EVENT_GRANULARITY,
  WASI_CLOCK_MS,
  WASI_RANDOM_FILL,
  WASI_TIMEZONE_OFFSET_MINUTES,
  createQuickJsRunner,
  createSandboxVm,
} from "./quickjs.js";
import { processTick } from "../processor/index.js";
import { loadRuleset, type RulesetView } from "../ruleset-loader/index.js";
import type { GameState, PlayerIndex, Site, Snapshot } from "../world/state.js";

/** 一份最小快照:探针脚本不读状态,骨架能把它交进 guest 即可。 */
const snapshotOf = (tick: number): Snapshot => ({
  tick,
  size: 0,
  terrain: [],
  players: [],
  units: [],
  sites: [],
});

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const wasmPath = fileURLToPath(import.meta.resolve("quickjs-wasi/quickjs.wasm"));
/** 被测运行时字节 = **入库产物**(不是现打的 bundle),这样读数才对得上 `SANDBOX_RUNTIME_HASH`。 */
const artifactPath = `${root}${SANDBOX_RUNTIME_ARTIFACT_PATH}`;

/** 诚实侧用的真规则集与地图(基准脚本按它们跑)。 */
const RULESET = JSON.parse(readFileSync(`${root}rulesets/v1.json`, "utf8")) as Ruleset;
const SEED = 20260101;
const CELLS = [
  "cell-a-melee-pressure",
  "cell-b-expansion-economy",
  "cell-c-claim-no-harvest",
] as const;
const MAPS = ["open-clash", "corridor-split", "fortress-core"] as const;

/** meta 行的执行器读数:真哈希 + 三件套(与 `sandbox.test.ts` 同形,只有哈希取真值)。 */
const head = {
  runner: "quickjs",
  timezoneOffset: "+00:00",
  mapHash: "e".repeat(64),
  quickjsWasiVersion: QUICKJS_WASI_VERSION,
  sandboxRuntimeHash: SANDBOX_RUNTIME_HASH,
  wasiClock: String(WASI_CLOCK_MS),
  wasiRandomFill: WASI_RANDOM_FILL,
  wasiTimezoneOffset: String(WASI_TIMEZONE_OFFSET_MINUTES),
} as const;

/** 空 VM 基线的冻结常量真源(引擎不能 import 工具包,只在读数里带指针)。 */
const FROZEN_EMPTY_VM_MALLOC_SIZE = 75_128;
const FROZEN_EMPTY_VM_SOURCE = "packages/tools/src/sandbox-probes/constants.ts:54";

/**
 * 三份基准产物的字节数(`benchmarks/<cell>/script.js`)。`scriptSizeLimit` 的下界依据是它们
 * 的最大值,与 `check:selfproof` 在占位期拿来做地板值的是同一批文件;现算而不抄 7579。
 */
const BENCHMARK_MAX_PRODUCT_BYTES = Math.max(
  ...CELLS.map((cell) => readFileSync(`${root}benchmarks/${cell}/script.js`).byteLength),
);

/** 样本规模:默认小,读数时按 env 放大。非法值退回默认,不静默取 0(与 `fixtures.test.ts` 同形)。 */
const envN = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** 读数落盘目录。**只有设了才写**——check 链上不该有文件副作用。 */
const readingsDir = process.env["MW_READINGS_DIR"];
const fullSample = readingsDir !== undefined;

/**
 * 复算模式(门禁 `check:budget-recheck` 设 `MW_BUDGET_RECHECK`):把**终值预算**真正装上
 * (探针与基准两侧),并把「终值仍自洽」变成断言——探针仍被截停、基准仍不被截停、终值推导与
 * 规则集逐键一致。**不改读数模式的规模与落盘语义**(默认 run 与 `probes:budget` 都不设它)。
 */
const recheckMode = process.env["MW_BUDGET_RECHECK"] !== undefined;
/**
 * 复算的**反例开关**(门禁的 `--tamper-probe` / `--tamper-baseline` 映射到这里):`probe` 让一条
 * 对抗探针不在终值轨上截停,`baseline` 把一条基准脚本用紧预算截停。两个值都只在复算模式下有意义。
 */
const recheckTamper = process.env["MW_RECHECK_TAMPER"] ?? null;

/** 分配上限探针用的 `memoryLimit`(字节)。 */
const capMemoryLimitBytes = envN("MW_CAP_LIMIT_BYTES", fullSample ? 8 << 20 : 1 << 20);
/** 分配形态轴:每次请求一块多少字节的 `Uint8Array`。默认只跑一档。 */
const capRequestBytes = fullSample ? [64 << 10, 256 << 10, 1 << 20, 4 << 20] : [64 << 10];
/** 装 bundle 之后的基线取几次读数(只报 min/max,不取均值)。 */
const baselineSamples = envN("MW_BASELINE_SAMPLES", fullSample ? 3 : 1);

/** 对抗探针:每次跑的次数(默认 1,读数时 5)、先跑几次预热丢弃、探针用的有限上限(测试参数,不是建议值)。 */
const probeSamples = envN("MW_PROBE_SAMPLES", fullSample ? 5 : 1);
const probeWarmup = envN("MW_PROBE_WARMUP", fullSample ? 3 : 0);
const spinProbeLimit = envN(
  "MW_SPIN_EVENT_LIMIT",
  (fullSample ? 10 : 4) * INTERRUPT_EVENT_GRANULARITY,
);
const apiBombCallsPerTick = envN("MW_API_BOMB_CALLS", fullSample ? 200_000 : 20_000);
/** 三轨异常探针反复触发的 tick 数。 */
const exceptionProbeTicks = envN("MW_EXCEPTION_TICKS", fullSample ? 8 : 3);

/** 诚实侧要跑的场次:默认只跑一场(便宜),读数时三舱 × 三图 + 混编。 */
const FULL_HONEST_SCENARIOS: readonly {
  readonly id: string;
  readonly map: string;
  readonly cells: readonly string[];
}[] = [
  ...CELLS.flatMap((cell) =>
    MAPS.map((map) => ({ id: `${cell}-${map}`, map, cells: [cell, cell, cell, cell] })),
  ),
  {
    id: "mixed-a-b-c-a-open-clash",
    map: "open-clash",
    cells: [CELLS[0], CELLS[1], CELLS[2], CELLS[0]],
  },
];
/** 默认只跑一场(便宜):cell-a 在 open-clash 上。 */
const DEFAULT_HONEST_SCENARIO = {
  id: `${CELLS[0]}-open-clash`,
  map: "open-clash",
  cells: [CELLS[0], CELLS[0], CELLS[0], CELLS[0]] as const,
};
/**
 * 复算只跑三份基准脚本各一场(同图同种子):判据是「终值下不被截停」与「推导仍自洽」,
 * 不取读数分布——三场足以覆盖三份脚本,也足以让终值推导的四个峰值不再退化。
 */
const RECHECK_HONEST_SCENARIOS: readonly {
  readonly id: string;
  readonly map: string;
  readonly cells: readonly string[];
}[] = CELLS.map((cell) => ({
  id: `${cell}-open-clash`,
  map: "open-clash",
  cells: [cell, cell, cell, cell],
}));
const honestScenarios = fullSample
  ? FULL_HONEST_SCENARIOS
  : recheckMode
    ? RECHECK_HONEST_SCENARIOS
    : [DEFAULT_HONEST_SCENARIO];

/** 预算组装的运行时字段(与 `apps/cli` 的 `BUDGET_FIELDS` 同口径;`scriptSizeLimit` 是编译期的事)。 */
const RUNTIME_BUDGET_FIELDS = [
  "exceptionTickLimit",
  "eventTickLimit",
  "apiCallTickLimit",
  "memoryLimit",
  "memoryTickCeiling",
  "wallClockSoftLimit",
  "wallClockHardTimeout",
] as const;
type RuntimeBudgetField = (typeof RUNTIME_BUDGET_FIELDS)[number];
type RuntimeBudget = Partial<Record<RuntimeBudgetField, number>>;

/**
 * 终值预算:只装键清单里 `calibration.state === "final"` 的轨——与组装层 `budgetOf` 同一判据
 * (不是「值是不是 0」;失效退回未定值时会自动把该轨摘下)。复算必须把**终值键真正装上**:
 * 诚实侧默认传空预算时,「不被截停」证明不了「终值下不被截停」。
 */
const finalBudgetOf = (ruleset: Ruleset): RuntimeBudget => {
  const budget: RuntimeBudget = {};
  for (const field of RUNTIME_BUDGET_FIELDS) {
    if (RULESET_KEY_CATALOG[field].calibration.state === "final") {
      budget[field] = ruleset[field];
    }
  }
  return budget;
};

const RECHECK_FINAL_KEYS = RUNTIME_BUDGET_FIELDS.filter(
  (field) => RULESET_KEY_CATALOG[field].calibration.state === "final",
);
const RECHECK_BUDGET = finalBudgetOf(RULESET);
/** 复算里诚实侧要装的预算:`--tamper-baseline` 把事件轨压到 1(基准当场被截停)。 */
const RECHECK_HONEST_BUDGET: RuntimeBudget =
  recheckTamper === "baseline" ? { ...RECHECK_BUDGET, eventTickLimit: 1 } : RECHECK_BUDGET;

/** 终值预算 → 探针座位选项(与 `apps/cli` 的 `budgetTracksOf` 同口径;缺席的轨不写)。 */
const seatBudgetOptions = (
  budget: RuntimeBudget,
): {
  readonly memoryLimit?: number;
  readonly wallClockHardTimeout?: number;
  readonly apiCallTickLimit?: number;
  readonly memoryTickCeiling?: number;
  readonly eventTickLimit?: number;
} => ({
  ...(budget.memoryLimit === undefined ? {} : { memoryLimit: budget.memoryLimit }),
  ...(budget.wallClockHardTimeout === undefined
    ? {}
    : { wallClockHardTimeout: budget.wallClockHardTimeout }),
  ...(budget.apiCallTickLimit === undefined ? {} : { apiCallTickLimit: budget.apiCallTickLimit }),
  ...(budget.memoryTickCeiling === undefined
    ? {}
    : { memoryTickCeiling: budget.memoryTickCeiling }),
  ...(budget.eventTickLimit === undefined ? {} : { eventTickLimit: budget.eventTickLimit }),
});

let wasmModule: WebAssembly.Module;
let runtimeCode: string;

beforeAll(async () => {
  wasmModule = await WebAssembly.compile(readFileSync(wasmPath));
  runtimeCode = readFileSync(artifactPath, "utf8");
});

// ── 通用小工具 ──────────────────────────────────────────────────────────────

const maxOf = (values: readonly number[]): number =>
  values.length === 0 ? 0 : Math.max(...values);

const quantileOf = (values: readonly number[], q: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? 0;
};

const medianOf = (values: readonly number[]): number => quantileOf(values, 0.5);

/** 空脚本(不装计数回调)跑一 tick、tick 末强制回收之后的存活堆读数,用作内存判罚线基线。 */
const measureLoadedRuntimeHeap = async (): Promise<number> => {
  const seat = await createProbeSeat({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: "function loop() {}",
    seat: 0,
    eventTickLimit: null,
  });
  try {
    seat.runner.setSnapshot(snapshotOf(0));
    seat.runner.drainIntents();
    return seat.readings[0]?.mallocSize ?? 0;
  } finally {
    seat.dispose();
  }
};

/** 四席各一个哨兵基地:没有它,空状态会在步 5 把所有席位淘汰掉,凭空多出状态变化。 */
const SEAT_BASES: readonly Site[] = [0, 1, 2, 3].map((seat) => ({
  id: 900 + seat,
  kind: "base",
  x: 900 + seat,
  y: 900,
  owner: seat as PlayerIndex,
  progressOwner: -1,
  progress: 0,
  producing: null,
}));

const makeProbeState = (): GameState => ({
  tick: 0,
  size: 8,
  terrain: Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => false)),
  players: [0, 1, 2, 3].map((index) => ({
    index: index as PlayerIndex,
    resources: 16,
    alive: true,
    exceptionTicks: 0,
  })),
  units: [],
  sites: SEAT_BASES,
  nextId: 100,
  outcome: null,
  eliminatedAtTick: [null, null, null, null],
  firstContactTick: null,
  economyDeadAtTick: [null, null, null, null],
});

// ── 票 03:两个量测探针 ─────────────────────────────────────────────────────

type CapShape = {
  readonly requestBytes: number;
  readonly chunksRetained: number;
  readonly observedCapBytes: number;
  readonly headroomBytes: number;
  readonly capRatioPpm: number;
  readonly eventGrid: number;
};

type Baseline = {
  readonly emptyVmMallocSize: number;
  readonly frozenEmptyVmMallocSize: number;
  readonly frozenEmptyVmSource: string;
  readonly loadedRuntimeMallocSamples: readonly number[];
  readonly samples: number;
};

const collected: {
  allocationCeiling?: { memoryLimitBytes: number; shapes: CapShape[] };
  aliveHeapBaseline?: Baseline;
  spinProbe?: ProbeRateReport;
  apiBombProbe?: ProbeRateReport;
  exceptionProbe?: ExceptionProbeReport;
  honestSide?: HonestSideReport;
} = {};

/**
 * 一次请求 `requestBytes` 字节并攥住,直到 guest 内捕获 `InternalError: out of memory` 后停手;
 * 把攥住的块数经一笔 `move` 交回(只为一个可读的「形态」说明,不参与任何判定)。
 */
const hoardScript = (requestBytes: number): string =>
  [
    "var hoard = [];",
    "function loop() {",
    "  if (hoard.length > 0) { return; }",
    "  for (;;) {",
    `    try { hoard.push(new Uint8Array(${String(requestBytes)})); } catch (_error) { break; }`,
    "  }",
    "  move(hoard.length, 0, 0);",
    "}",
  ].join("\n");

it("量测探针①:分配上限的封顶随分配形态变化(memoryLimit − 读出封顶)", async () => {
  const shapes: CapShape[] = [];
  for (const requestBytes of capRequestBytes) {
    const seat = await createProbeSeat({
      wasm: wasmModule,
      runtimeCode,
      scriptCode: hoardScript(requestBytes),
      seat: 0,
      memoryLimit: capMemoryLimitBytes,
      eventTickLimit: NEVER_EVENT_LIMIT,
    });
    try {
      seat.runner.setSnapshot(snapshotOf(0));
      const output = seat.runner.drainIntents();
      const reading = seat.readings[0];
      if (reading === undefined) {
        throw new Error("探针没有记下这一 tick 的读数");
      }
      const first = output.intents[0];
      const chunksRetained = first !== undefined && first.kind === "move" ? first.unitId : 0;
      shapes.push({
        requestBytes,
        chunksRetained,
        observedCapBytes: reading.mallocSize,
        headroomBytes: capMemoryLimitBytes - reading.mallocSize,
        capRatioPpm: Math.round((reading.mallocSize * 1_000_000) / capMemoryLimitBytes),
        eventGrid: reading.eventGrid,
      });
    } finally {
      seat.dispose();
    }
  }
  collected.allocationCeiling = { memoryLimitBytes: capMemoryLimitBytes, shapes };
  // 读数形状良好:每个形态都真的把堆顶到了 OOM 边界,封顶必然小于分配上限。
  expect(shapes).toHaveLength(capRequestBytes.length);
  for (const shape of shapes) {
    expect(shape.headroomBytes).toBeGreaterThan(0);
  }
});

it("量测探针②:装 runtime bundle 之后的存活堆基线(与空 VM 基线分列)", async () => {
  // 空 VM 基线:裸 VM(无 runtime、无脚本),与冻结常量同口径。
  const emptyVm = await createSandboxVm({ wasm: wasmModule });
  let emptyVmMallocSize: number;
  try {
    emptyVmMallocSize = emptyVm.getMemoryUsage().mallocSize;
  } finally {
    emptyVm.dispose();
  }

  // 装 runtime bundle 之后:入库产物 + 空脚本,每 tick 末强制回收之后的存活堆。
  // 这里显式传 `eventTickLimit: null`(不装计数回调),与内存判据的口径一致——内存轨启用时
  // 不装回调;分配封顶探针则装回调以同时记下事件格数。
  const loadedRuntimeMallocSamples: number[] = [];
  for (let sample = 0; sample < baselineSamples; sample++) {
    loadedRuntimeMallocSamples.push(await measureLoadedRuntimeHeap());
  }

  collected.aliveHeapBaseline = {
    emptyVmMallocSize,
    frozenEmptyVmMallocSize: FROZEN_EMPTY_VM_MALLOC_SIZE,
    frozenEmptyVmSource: FROZEN_EMPTY_VM_SOURCE,
    loadedRuntimeMallocSamples,
    samples: baselineSamples,
  };
  // 装 bundle 之后必然比空 VM 高;两个口径分列正是本条的目的。
  expect(emptyVmMallocSize).toBeGreaterThan(0);
  expect(Math.min(...loadedRuntimeMallocSamples)).toBeGreaterThan(0);
});

// ── 票 04:三类预算探针 ─────────────────────────────────────────────────────

type ProbeSampleReport = {
  readonly stoppedBy: string | null;
  readonly value: number | null;
  readonly wallMs: number;
  readonly perMs: number | null;
};

type ProbeRateReport = {
  readonly label: string;
  readonly stoppingTrack: string;
  readonly probeLimit: number;
  readonly samples: readonly ProbeSampleReport[];
  readonly perMsMin: number;
  readonly perMsMedian: number;
  readonly perMsMax: number;
};

type ExceptionTrackReport = {
  readonly script: string;
  readonly probeLimit: number;
  readonly totalExceptions: number;
  readonly perTick: readonly (readonly number[])[];
};

type ExceptionProbeReport = {
  readonly ticks: number;
  readonly tracks: {
    readonly eventTickLimit: ExceptionTrackReport;
    readonly memoryTickCeiling: ExceptionTrackReport;
    readonly apiCallTickLimit: ExceptionTrackReport;
  };
  readonly stacking: {
    readonly memoryAndApiPerTick: number;
    readonly eventEarlyReturnPerTick: number;
    readonly maxAdditionsPerTick: number;
    readonly note: string;
  };
};

type SeatPeaks = {
  readonly ticks: number;
  readonly eventGridPeak: number;
  readonly apiCallsPeak: number;
  readonly mallocSizePeak: number;
  readonly loopMsPeak: number;
};

type HonestMatch = {
  readonly id: string;
  readonly cells: readonly string[];
  readonly map: string;
  readonly status: string;
  readonly tickCount: number;
  readonly matchWallMs: number;
  readonly seatPeaks: readonly SeatPeaks[];
  /** 收官时四个座位的 `exceptionTicks`（终值预算下应恒为 0：没有一条轨触限）。 */
  readonly exceptionTicks: readonly number[];
};

type HonestSideReport = {
  readonly matches: readonly HonestMatch[];
  readonly globalWorst: {
    readonly eventGridPeak: number;
    readonly apiCallsPeak: number;
    readonly mallocSizePeak: number;
    readonly loopMsPeak: number;
    readonly matchWallMs: number;
  };
  readonly perTickEventGrid: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly sampleNote: string;
};

/** 一条判定式探针的读数(截停轨由真执行器给出;`perMs` = 烧了多少 / 本 tick 墙钟)。 */
const runProbeSamples = async (
  scriptCode: string,
  options: {
    readonly eventTickLimit?: number;
    readonly apiCallTickLimit?: number;
    readonly memoryTickCeiling?: number;
  },
): Promise<ProbeSampleReport[]> => {
  // 先跑几次预热丢弃:首次实例化 / 首次大量控制流会让 wasm 侧先冷跑,把它算进速率会系统性偏低。
  for (let warmup = 0; warmup < probeWarmup; warmup++) {
    await runBudgetProbeTick({
      wasm: wasmModule,
      runtimeCode,
      scriptCode,
      ...options,
    });
  }
  const samples: ProbeSampleReport[] = [];
  for (let sample = 0; sample < probeSamples; sample++) {
    const verdict = await runBudgetProbeTick({
      wasm: wasmModule,
      runtimeCode,
      scriptCode,
      ...options,
    });
    const tripped = verdict.trips[0] ?? null;
    samples.push({
      stoppedBy: tripped?.track ?? (verdict.timedOut ? "uncertain-timeout" : null),
      value: tripped?.value ?? null,
      wallMs: verdict.wallMs,
      perMs: tripped === null ? null : tripped.value / verdict.wallMs,
    });
  }
  return samples;
};

it("对抗探针①(死循环):只烧控制流事件,由事件计数轨截停,读出每毫秒能烧多少", async () => {
  const samples = await runProbeSamples(EVENT_SPIN_PROBE_SCRIPT, {
    eventTickLimit: spinProbeLimit,
  });
  // 被抓住必须指定轨名:它截停于事件计数轨,不是硬超时、也不是别的轨。
  for (const sample of samples) {
    expect(sample.stoppedBy).toBe(EVENT_TRACK);
    expect(sample.value).toBeGreaterThanOrEqual(spinProbeLimit);
    expect(sample.perMs).toBeGreaterThan(0);
  }
  const perMs = samples
    .map((sample) => sample.perMs)
    .filter((value): value is number => value !== null);
  collected.spinProbe = {
    label: "死循环探针(只烧控制流事件,零 API、零分配)",
    stoppingTrack: EVENT_TRACK,
    probeLimit: spinProbeLimit,
    samples,
    perMsMin: Math.min(...perMs),
    perMsMedian: medianOf(perMs),
    perMsMax: Math.max(...perMs),
  };
}, 120_000);

it("对抗探针②(API 轰炸):只烧 API 调用,由 API 计数轨截停,读出每毫秒能烧多少", async () => {
  const probeLimit = Math.floor(apiBombCallsPerTick / 4);
  const samples = await runProbeSamples(apiBombProbeScript(apiBombCallsPerTick), {
    apiCallTickLimit: probeLimit,
  });
  for (const sample of samples) {
    expect(sample.stoppedBy).toBe(API_CALL_TRACK);
    expect(sample.value).toBeGreaterThanOrEqual(probeLimit);
    expect(sample.perMs).toBeGreaterThan(0);
  }
  const perMs = samples
    .map((sample) => sample.perMs)
    .filter((value): value is number => value !== null);
  collected.apiBombProbe = {
    label: "API 轰炸探针(只烧 API 调用)",
    stoppingTrack: API_CALL_TRACK,
    probeLimit,
    samples,
    perMsMin: Math.min(...perMs),
    perMsMedian: medianOf(perMs),
    perMsMax: Math.max(...perMs),
  };
}, 120_000);

/** 反复触发一条轨:每 tick 赋一次异常计数,交回累计与逐 tick 序列。 */
const runExceptionTrack = async (
  scriptCode: string,
  options: {
    readonly eventTickLimit?: number;
    readonly memoryTickCeiling?: number;
    readonly apiCallTickLimit?: number;
  },
  view: RulesetView,
): Promise<{ totalExceptions: number; perTick: readonly (readonly number[])[] }> => {
  const handle = await createQuickJsRunner({
    wasm: wasmModule,
    runtimeCode,
    scriptCode,
    seat: 0,
    ...options,
  });
  try {
    const idle = stubRunner(() => []);
    let state = makeProbeState();
    const perTick: number[][] = [];
    for (let tick = 0; tick < exceptionProbeTicks; tick++) {
      state = processTick(
        state,
        [handle.runner, idle, idle, idle],
        view,
        { write: () => {} },
        undefined,
        {
          exceptionTickLimit: 999,
        },
      ).state;
      perTick.push(state.players.map((player) => player.exceptionTicks));
    }
    return { totalExceptions: state.players[0]?.exceptionTicks ?? 0, perTick };
  } finally {
    handle.dispose();
  }
};

it("三轨异常探针:三条轨各被反复触发,exceptionTicks 逐 tick 累加(经步 0 的唯一写入口)", async () => {
  const view = loadRuleset(RULESET);
  const heapBaseline = await measureLoadedRuntimeHeap();
  const memoryCeiling = heapBaseline + (1 << 20);
  const event = await runExceptionTrack(
    EVENT_SPIN_PROBE_SCRIPT,
    { eventTickLimit: 10 * INTERRUPT_EVENT_GRANULARITY },
    view,
  );
  const memory = await runExceptionTrack(
    MEMORY_HOARD_PROBE_SCRIPT,
    { memoryTickCeiling: memoryCeiling },
    view,
  );
  const api = await runExceptionTrack(apiBombProbeScript(2000), { apiCallTickLimit: 500 }, view);
  // 每条轨每 tick 恰触发一次 → 累计异常 = tick 数。
  expect(event.totalExceptions).toBe(exceptionProbeTicks);
  expect(memory.totalExceptions).toBe(exceptionProbeTicks);
  expect(api.totalExceptions).toBe(exceptionProbeTicks);
  collected.exceptionProbe = {
    ticks: exceptionProbeTicks,
    tracks: {
      eventTickLimit: {
        script: "EVENT_SPIN_PROBE_SCRIPT",
        probeLimit: 10 * INTERRUPT_EVENT_GRANULARITY,
        totalExceptions: event.totalExceptions,
        perTick: event.perTick,
      },
      memoryTickCeiling: {
        script: "MEMORY_HOARD_PROBE_SCRIPT",
        probeLimit: memoryCeiling,
        totalExceptions: memory.totalExceptions,
        perTick: memory.perTick,
      },
      apiCallTickLimit: {
        script: `apiBombProbeScript(2000)`,
        probeLimit: 500,
        totalExceptions: api.totalExceptions,
        perTick: api.perTick,
      },
    },
    // 叠加那条在下一个用例里跑,这里先放占位;下一个用例会补上。
    stacking: {
      memoryAndApiPerTick: 0,
      eventEarlyReturnPerTick: 0,
      maxAdditionsPerTick: 2,
      note: "",
    },
  };
}, 120_000);

it("三轨异常探针:同 tick 最多叠加两次(内存 + API 可叠,事件轨早退)", async () => {
  const view = loadRuleset(RULESET);
  const idle = stubRunner(() => []);
  const heapBaseline = await measureLoadedRuntimeHeap();
  const memoryCeiling = heapBaseline + (1 << 20);

  const exceptionsAfterOneTick = async (scriptCode: string, options: object): Promise<number> => {
    const handle = await createQuickJsRunner({
      wasm: wasmModule,
      runtimeCode,
      scriptCode,
      seat: 0,
      ...options,
    });
    try {
      const state = processTick(
        makeProbeState(),
        [handle.runner, idle, idle, idle],
        view,
        { write: () => {} },
        undefined,
        { exceptionTickLimit: 999 },
      ).state;
      return state.players[0]?.exceptionTicks ?? 0;
    } finally {
      handle.dispose();
    }
  };

  // 内存判罚线 + API 轨同时在同一个 tick 越限 → 同 tick 两条 tripped → 累计 +2。
  const stacked = await exceptionsAfterOneTick(MEMORY_API_PROBE_SCRIPT, {
    memoryTickCeiling: memoryCeiling,
    apiCallTickLimit: 500,
  });
  // 三条轨都设,但事件轨先截停、**早退**(不排内存 / API)→ 累计只 +1。
  const early = await exceptionsAfterOneTick(EVENT_SPIN_PROBE_SCRIPT, {
    eventTickLimit: 10 * INTERRUPT_EVENT_GRANULARITY,
    memoryTickCeiling: 0,
    apiCallTickLimit: 0,
  });
  expect(stacked).toBe(2);
  expect(early).toBe(1);
  const probe = collected.exceptionProbe;
  if (probe === undefined) {
    throw new Error("三轨异常探针没有先跑完");
  }
  collected.exceptionProbe = {
    ...probe,
    stacking: {
      memoryAndApiPerTick: stacked,
      eventEarlyReturnPerTick: early,
      maxAdditionsPerTick: 2,
      note:
        "同 tick 最多叠加两次:事件轨截停后立即早退(不排内存 / API 判定),故最多 +1;" +
        "内存判罚线与 API 轨可以在同一 tick 各报一条 tripped,故 (+内存, +API) 可叠到 +2。",
    },
  };
}, 120_000);

// ── 票 04:诚实侧(三份基准脚本在真引擎上跑) ────────────────────────────────

const peakOfSeat = (readings: readonly ProbeTickReading[]): SeatPeaks => ({
  ticks: readings.length,
  eventGridPeak: maxOf(readings.map((reading) => reading.eventGrid)),
  apiCallsPeak: maxOf(readings.map((reading) => reading.apiCalls)),
  mallocSizePeak: maxOf(readings.map((reading) => reading.mallocSize)),
  loopMsPeak: maxOf(readings.map((reading) => reading.loopMs)),
});

const runHonestMatch = async (scenario: {
  readonly id: string;
  readonly map: string;
  readonly cells: readonly string[];
}): Promise<{ match: HonestMatch; eventGrids: number[] }> => {
  const map = JSON.parse(readFileSync(`${root}maps/${scenario.map}.json`, "utf8")) as MapDefinition;
  const scripts = scenario.cells.map((cell) =>
    readFileSync(`${root}benchmarks/${cell}/script.js`, "utf8"),
  );
  const seats = await Promise.all(
    scripts.map((scriptCode, seat) =>
      createProbeSeat({
        wasm: wasmModule,
        runtimeCode,
        scriptCode,
        seat: seat as PlayerIndex,
        // 复算：把终值预算真装到探针座位上（缺席时保持今天「无阈值、纯量测」的读数形态）。
        ...(recheckMode ? seatBudgetOptions(RECHECK_HONEST_BUDGET) : {}),
      }),
    ),
  );
  try {
    const players = seats.map((_, seat) => ({
      model: scenario.cells[seat] ?? "unknown",
      archiveRef: `bench/${scenario.id}/${String(seat)}`,
      seat: seat as PlayerIndex,
    }));
    const started = performance.now();
    const result = runMatch({
      ruleset: RULESET,
      map,
      seed: SEED,
      head,
      players,
      runners: seats.map((seat) => seat.runner),
      budget: recheckMode ? RECHECK_HONEST_BUDGET : {},
      sink: { write: () => {} },
    });
    const matchWallMs = performance.now() - started;
    const eventGrids = seats.flatMap((seat) => seat.readings.map((reading) => reading.eventGrid));
    return {
      match: {
        id: scenario.id,
        cells: scenario.cells,
        map: scenario.map,
        status: result.status,
        tickCount: result.status === "completed" ? result.tickCount : result.tick,
        matchWallMs,
        seatPeaks: seats.map((seat) => peakOfSeat(seat.readings)),
        exceptionTicks:
          result.status === "completed"
            ? result.finalState.players.map((player) => player.exceptionTicks)
            : [],
      },
      eventGrids,
    };
  } finally {
    for (const seat of seats) {
      seat.dispose();
    }
  }
};

it("诚实侧:三份基准脚本在真引擎上跑出「每场每席峰值 → 全局最坏」", async () => {
  const matches: HonestMatch[] = [];
  const eventGrids: number[] = [];
  for (const scenario of honestScenarios) {
    const { match, eventGrids: grids } = await runHonestMatch(scenario);
    matches.push(match);
    eventGrids.push(...grids);
  }
  // 读数形状良好:每一场都跑到了收官、每个座位都有逐 tick 读数。
  for (const match of matches) {
    expect(match.status).toBe("completed");
    expect(match.tickCount).toBeGreaterThan(0);
    expect(match.matchWallMs).toBeGreaterThan(0);
    for (const peaks of match.seatPeaks) {
      expect(peaks.ticks).toBeGreaterThan(0);
      expect(peaks.mallocSizePeak).toBeGreaterThan(0);
    }
  }
  const globalWorst = {
    eventGridPeak: maxOf(matches.flatMap((match) => match.seatPeaks.map((p) => p.eventGridPeak))),
    apiCallsPeak: maxOf(matches.flatMap((match) => match.seatPeaks.map((p) => p.apiCallsPeak))),
    mallocSizePeak: maxOf(matches.flatMap((match) => match.seatPeaks.map((p) => p.mallocSizePeak))),
    loopMsPeak: maxOf(matches.flatMap((match) => match.seatPeaks.map((p) => p.loopMsPeak))),
    matchWallMs: maxOf(matches.map((match) => match.matchWallMs)),
  };
  collected.honestSide = {
    matches,
    globalWorst,
    perTickEventGrid: {
      p50: quantileOf(eventGrids, 0.5),
      p95: quantileOf(eventGrids, 0.95),
      max: maxOf(eventGrids),
    },
    sampleNote:
      "样本薄:三份基准脚本只覆盖两个模型档(commandcode/deepseek/deepseek-v4.1-flash 与 " +
      "minimax-cn/MiniMax-M3),其中 cell-c 的模型是**降级产物**(本机未配 Claude provider,按 J " +
      "的口径归 wizard)。三份脚本的策略标签只描述行为、不是能力评级,故诚实侧峰值只作量级参考, " +
      "不代表任何模型档的真实强度分布。",
  };
}, 900_000);

// ── 落盘(只有设了 `MW_READINGS_DIR` 才写) ──────────────────────────────────

const SCOPE =
  "各一次会话、无地图与规则集参与(探针脚本不读状态、不判据);读数取在 tick 末强制回收之后的存活堆 " +
  "mallocSize,与内存判据同口径。整数会随运行环境微动,量级稳定。";

const PROBE_SCOPE =
  "三类预算探针:对抗两条走真执行器 `runBudgetProbeTick`(截停轨由引擎给出),三轨异常探针经 " +
  "`processTick` 步 0 累加 `exceptionTicks`,诚实侧则用仪表化探针座位跑三份基准脚本。" +
  "事件读数一律按**格数**记(eventCount / 中断粒度),不按事件数记:wasm 侧计数器跨调用不清零、有相位残留。";

type Report = {
  readonly meta: {
    readonly sandboxRuntimeHash: string;
    readonly sandboxRuntimeArtifact: string;
    readonly quickjsWasiVersion: string;
    readonly interruptEventGranularity: number;
    /** 三份基准产物的最大字节数;`scriptSizeLimit` 的下界依据(与 `check:selfproof` 同一批文件)。 */
    readonly benchmarkMaxProductBytes: number;
    readonly rerunCommand: string;
    readonly scope: string;
    readonly probeScope: string;
  };
  readonly allocationCeiling: { readonly memoryLimitBytes: number; readonly shapes: CapShape[] };
  readonly aliveHeapBaseline: Baseline;
  readonly adversarialProbes: {
    readonly spin: ProbeRateReport;
    readonly apiBomb: ProbeRateReport;
  };
  readonly exceptionProbe: ExceptionProbeReport;
  readonly honestSide: HonestSideReport;
};

const buildReport = (): Report => {
  const allocationCeiling = collected.allocationCeiling;
  const aliveHeapBaseline = collected.aliveHeapBaseline;
  const spinProbe = collected.spinProbe;
  const apiBombProbe = collected.apiBombProbe;
  const exceptionProbe = collected.exceptionProbe;
  const honestSide = collected.honestSide;
  if (
    allocationCeiling === undefined ||
    aliveHeapBaseline === undefined ||
    spinProbe === undefined ||
    apiBombProbe === undefined ||
    exceptionProbe === undefined ||
    honestSide === undefined
  ) {
    throw new Error("探针没有跑完,读数不完整");
  }
  return {
    meta: {
      sandboxRuntimeHash: SANDBOX_RUNTIME_HASH,
      sandboxRuntimeArtifact: SANDBOX_RUNTIME_ARTIFACT_PATH,
      quickjsWasiVersion: QUICKJS_WASI_VERSION,
      interruptEventGranularity: INTERRUPT_EVENT_GRANULARITY,
      benchmarkMaxProductBytes: BENCHMARK_MAX_PRODUCT_BYTES,
      rerunCommand: "pnpm run probes:budget",
      scope: SCOPE,
      probeScope: PROBE_SCOPE,
    },
    allocationCeiling,
    aliveHeapBaseline,
    adversarialProbes: { spin: spinProbe, apiBomb: apiBombProbe },
    exceptionProbe,
    honestSide,
  };
};

// ── 终值推导(由读数按 spec《Implementation Decisions》第 1 条的规则代入)────────────────
//
// 这一段是**生成代码**,不是手写段落:它从上面的读数里重算每个已定稿预算键的终值。票 05 当时把
// 推导手写进了 `readings.md`,而重跑探针会把那份文件整个覆盖——所以推导必须留在这里。
// 终值的家仍是 `rulesets/v1.json`;这里渲染的是「读数 × 系数」的算式与代入结果,并核一次
// 它是否与规则集里的取值一致(不一致会把两者都写出来,而不是静默)。

/** 八个预算键的书写序(与键清单、`rulesets/v1.json` 一致)。 */
const BUDGET_KEY_NAMES = [
  "exceptionTickLimit",
  "eventTickLimit",
  "apiCallTickLimit",
  "memoryLimit",
  "memoryTickCeiling",
  "wallClockSoftLimit",
  "wallClockHardTimeout",
  "scriptSizeLimit",
] as const;

/** 向上取整到 `multiple` 的整数倍。 */
const roundUpTo = (value: number, multiple: number): number =>
  Math.ceil(value / multiple) * multiple;
/** 不小于 `value` 的最小 2 的幂。 */
const pow2AtLeast = (value: number): number => {
  let power = 1;
  while (power < value) {
    power *= 2;
  }
  return power;
};

/** 判罚线的峰值系数(取整到 64 KiB)。 */
const MEMORY_CEILING_PEAK_MULTIPLE = 2.5;
const MEMORY_CEILING_ROUND_BYTES = 64 * 1024;
/** 分配上限的两个下界系数:≥ 该系数 × 判罚线 / ≥ 该系数 × 诚实峰值。 */
const MEMORY_LIMIT_CEILING_FACTOR = 8;
const MEMORY_LIMIT_PEAK_FACTOR = 16;
/** 墙钟软限的观测机制下界(ms):读钟的粒度是每约 10 万控制流事件一次,低于它软限等于不存在。 */
const WALL_CLOCK_SOFT_FLOOR_MS = 50;
/** 硬超时相对软限 / 诚实单 tick 墙钟峰值的下界系数(取值调和见渲染末尾的注释)。 */
const WALL_CLOCK_HARD_SOFT_FACTOR = 20;
const WALL_CLOCK_HARD_PEAK_FACTOR = 200;
/** 体积上限相对基准产物最大值的下界系数。 */
const SCRIPT_SIZE_ARTIFACT_FACTOR = 4;

type Derivation = {
  readonly key: string;
  readonly rule: string;
  readonly reading: string;
  readonly arithmetic: string;
  readonly derived: number;
};

/** 把读数代入取值规则,重算已定稿与待定稿的预算键终值。 */
const derivationsOf = (report: Report): readonly Derivation[] => {
  const worst = report.honestSide.globalWorst;
  const stacking = report.exceptionProbe.stacking.maxAdditionsPerTick;
  const granularity = report.meta.interruptEventGranularity;
  const peak = worst.mallocSizePeak;
  const tickWallPeak = worst.loopMsPeak;

  const exceptionTickLimit = 1 + stacking;
  const eventTickLimit = (worst.eventGridPeak + 1) * granularity;
  const apiCallTickLimit = Math.ceil((worst.apiCallsPeak * 2) / 100) * 100;
  const memoryTickCeiling = roundUpTo(
    MEMORY_CEILING_PEAK_MULTIPLE * peak,
    MEMORY_CEILING_ROUND_BYTES,
  );
  const memoryLimit = pow2AtLeast(
    Math.max(MEMORY_LIMIT_CEILING_FACTOR * memoryTickCeiling, MEMORY_LIMIT_PEAK_FACTOR * peak),
  );
  // 软限的规则项是「20 × 诚实 p95」;读数里诚实单 tick 墙钟只记峰值(它是 p95 的上界),
  // 而它远低于机制下界 ÷ 20,所以 50 ms 那个机制下界总是主导。
  const wallClockSoftLimit = Math.max(
    WALL_CLOCK_SOFT_FLOOR_MS,
    WALL_CLOCK_HARD_SOFT_FACTOR * tickWallPeak,
  );
  const wallClockHardTimeout = pow2AtLeast(
    Math.max(
      WALL_CLOCK_HARD_SOFT_FACTOR * wallClockSoftLimit,
      WALL_CLOCK_HARD_PEAK_FACTOR * tickWallPeak,
    ),
  );
  const scriptSizeLimit = pow2AtLeast(
    SCRIPT_SIZE_ARTIFACT_FACTOR * report.meta.benchmarkMaxProductBytes,
  );

  return [
    {
      key: "exceptionTickLimit",
      rule: "容错 1 次 + 同 tick 最大叠加数",
      reading: `同 tick 最大叠加 = ${String(stacking)}(内存 + API 可叠;事件轨早退)`,
      arithmetic: `1 + ${String(stacking)}`,
      derived: exceptionTickLimit,
    },
    {
      key: "eventTickLimit",
      rule: "中断粒度的整数倍,取诚实全局峰值所在格的**下一格**",
      reading: `诚实事件格数峰值 = ${String(worst.eventGridPeak)} 格(p95 已满一格)`,
      arithmetic: `(${String(worst.eventGridPeak)} + 1) × ${String(granularity)}`,
      derived: eventTickLimit,
    },
    {
      key: "apiCallTickLimit",
      rule: "诚实全局峰值 × 2,向上取整到整百",
      reading: `诚实 API 峰值 = ${String(worst.apiCallsPeak)}`,
      arithmetic: `⌈${String(worst.apiCallsPeak)} × 2 ÷ 100⌉ × 100`,
      derived: apiCallTickLimit,
    },
    {
      key: "memoryTickCeiling",
      rule: "2.5 × 诚实存活堆峰值,向上取整到 64 KiB",
      reading: `诚实存活堆峰值 = ${String(peak)} bytes`,
      arithmetic: `⌈2.5 × ${String(peak)} ÷ 65536⌉ × 65536`,
      derived: memoryTickCeiling,
    },
    {
      key: "memoryLimit",
      rule: "2 的幂,≥ 8 × 判罚线且 ≥ 16 × 诚实峰值",
      reading:
        `8 × ${String(memoryTickCeiling)} = ${String(MEMORY_LIMIT_CEILING_FACTOR * memoryTickCeiling)}` +
        `;16 × ${String(peak)} = ${String(MEMORY_LIMIT_PEAK_FACTOR * peak)}`,
      arithmetic: `2^⌈log2 max(8 × ${String(memoryTickCeiling)}, 16 × ${String(peak)})⌉`,
      derived: memoryLimit,
    },
    {
      key: "wallClockSoftLimit",
      rule: "max(50 ms, 20 × 诚实单 tick 墙钟 p95)",
      reading:
        "观测机制下界 50 ms(读钟每约 10 万控制流事件一次,短脚本抽样不到)主导;" +
        "诚实单 tick 墙钟 p95 低于下界 ÷ 20",
      arithmetic: "max(50, 20 × p95)",
      derived: wallClockSoftLimit,
    },
    {
      key: "wallClockHardTimeout",
      rule: "2 的幂,≥ 20 × 软限且 ≥ 200 × 诚实单 tick 墙钟峰值",
      reading:
        `20 × 软限 ${String(wallClockSoftLimit)} = ${String(WALL_CLOCK_HARD_SOFT_FACTOR * wallClockSoftLimit)};` +
        "200 × 诚实单 tick 墙钟峰值远小、未主导",
      arithmetic: `2^⌈log2 max(20 × ${String(wallClockSoftLimit)}, 200 × peak)⌉`,
      derived: wallClockHardTimeout,
    },
    {
      key: "scriptSizeLimit",
      rule: "2 的幂,≥ 4 × 基准产物最大值",
      reading: `基准产物最大值 = ${String(report.meta.benchmarkMaxProductBytes)} bytes`,
      arithmetic: `2^⌈log2(4 × ${String(report.meta.benchmarkMaxProductBytes)})⌉`,
      derived: scriptSizeLimit,
    },
  ];
};

const renderReadingsMarkdown = (report: Report): string => {
  const capRows = report.allocationCeiling.shapes.map(
    (shape) =>
      `| ${String(shape.requestBytes)} | ${String(shape.chunksRetained)} | ${String(
        shape.observedCapBytes,
      )} | ${String(shape.headroomBytes)} | ${(shape.capRatioPpm / 10_000).toFixed(2)}% | ${String(
        shape.eventGrid,
      )} |`,
  );
  const loaded = report.aliveHeapBaseline.loadedRuntimeMallocSamples;
  const loadedMin = Math.min(...loaded);
  const loadedMax = Math.max(...loaded);

  const rateRow = (probe: ProbeRateReport): string =>
    `| ${probe.label} | \`${probe.stoppingTrack}\` | ${String(probe.probeLimit)} | ${String(
      probe.samples.length,
    )} | ${probe.perMsMedian.toFixed(1)} (${probe.perMsMin.toFixed(1)}–${probe.perMsMax.toFixed(
      1,
    )}) | ${probe.samples.map((sample) => `${sample.value ?? "-"}`).join(" / ")} |`;

  const honestRows = report.honestSide.matches.map((match) => {
    const peak = (select: (peaks: SeatPeaks) => number): number =>
      maxOf(match.seatPeaks.map(select));
    return `| ${match.id} | ${match.status} | ${String(match.tickCount)} | ${Math.round(
      match.matchWallMs,
    )} | ${String(peak((p) => p.eventGridPeak))} | ${String(peak((p) => p.apiCallsPeak))} | ${String(
      peak((p) => p.mallocSizePeak),
    )} | ${peak((p) => p.loopMsPeak).toFixed(2)} |`;
  });

  const trackRows = (
    [
      ["事件计数轨", report.exceptionProbe.tracks.eventTickLimit],
      ["内存判罚线", report.exceptionProbe.tracks.memoryTickCeiling],
      ["API 计数轨", report.exceptionProbe.tracks.apiCallTickLimit],
    ] as const
  ).map(
    ([label, track]) =>
      `| ${label} | ${String(track.probeLimit)} | ${String(
        report.exceptionProbe.ticks,
      )} | ${String(track.totalExceptions)} |`,
  );

  const grid = report.honestSide.perTickEventGrid;

  // 终值推导(生成代码):按读数重算已定稿预算键的终值,并与规则集取值对照。
  const derivations = derivationsOf(report);
  const derivationByKey = new Map(derivations.map((derivation) => [derivation.key, derivation]));
  const finalKeys = BUDGET_KEY_NAMES.filter(
    (key) => RULESET_KEY_CATALOG[key].calibration.state === "final",
  );
  const undeterminedKeyNames = BUDGET_KEY_NAMES.filter(
    (key) => RULESET_KEY_CATALOG[key].calibration.state !== "final",
  );
  const derivationRows = finalKeys.map((key) => {
    const declared = RULESET[key];
    const derivation = derivationByKey.get(key);
    if (derivation === undefined) {
      return `| \`${key}\` | (本键已定稿,但它的推导尚未并入渲染器) | — | — | **${String(declared)}** |`;
    }
    const finalCell =
      derivation.derived === declared
        ? `**${String(declared)}**`
        : `**${String(declared)}**(重算 ${String(derivation.derived)},与规则集不一致)`;
    return `| \`${key}\` | ${derivation.rule} | ${derivation.reading} | \`${derivation.arithmetic}\` | ${finalCell} |`;
  });
  const honestPeak = report.honestSide.globalWorst.mallocSizePeak;
  const tickWallPeak = report.honestSide.globalWorst.loopMsPeak;
  const derivedCeiling = derivationByKey.get("memoryTickCeiling")?.derived ?? 0;
  const derivedLimit = derivationByKey.get("memoryLimit")?.derived ?? 0;
  const derivedSoft = derivationByKey.get("wallClockSoftLimit")?.derived ?? 0;
  const derivedHard = derivationByKey.get("wallClockHardTimeout")?.derived ?? 0;
  const derivedSize = derivationByKey.get("scriptSizeLimit")?.derived ?? 0;
  const softThreshold = Math.floor(MEMORY_SOFT_THRESHOLD_RATIO * derivedCeiling);

  return [
    "# 预算标定探针读数(票 03:探针骨架 + 两个量测探针;票 04:三类预算探针 + 诚实侧基准)",
    "",
    "> 本文件**只放数与测法,不放任何建议阈值**——取值是后续票的事。",
    "",
    `复现命令:\`${report.meta.rerunCommand}\``,
    "",
    "## 口径与方法",
    "",
    `- 沙箱运行时哈希:\`${report.meta.sandboxRuntimeHash}\`(真值,来自 \`@model-war/replay\` 的`,
    `  \`SANDBOX_RUNTIME_HASH\`;被测字节 = 入库产物 \`${report.meta.sandboxRuntimeArtifact}\`)。`,
    `- quickjs-wasi \`${report.meta.quickjsWasiVersion}\`;中断粒度 \`INTERRUPT_EVENT_GRANULARITY = ${String(
      report.meta.interruptEventGranularity,
    )}\`。`,
    "- 探针骨架逐条镜像 `createQuickJsRunner` 的每 tick 次序",
    "  (`beginTick → loop → pumpJobs → endTick → runGC → memoryUsage → drainIntents`),不改任何判定;",
    "  判定式探针走 `runBudgetProbeTick`(真执行器),截停轨与截停读数由引擎自己给出。",
    "- 内存读数取在 tick 末 `runGC()` 之后的存活堆 `mallocSize`(与内存判据同口径)。",
    `- 事件读数一律按**格数**记(\`eventCount / ${String(
      report.meta.interruptEventGranularity,
    )}\`),不按事件数记:wasm 侧计数器跨调用不清零、有相位残留,按事件数记会把残影当读数。`,
    "- 事件读数只有在构造 VM 时显式给一个极大上限才拿得到(计数回调只能构造时装);量测探针给",
    "  `eventTickLimit = MAX_SAFE_INTEGER`,基线探针不装回调(与内存判据的口径一致)。",
    `- 作用域(量测探针):${report.meta.scope}`,
    `- 作用域(预算探针与诚实侧):${report.meta.probeScope}`,
    "",
    "## 探针①:分配上限的封顶",
    "",
    `\`memoryLimit = ${String(
      report.allocationCeiling.memoryLimitBytes,
    )}\` 字节。脚本每次请求一块 \`new Uint8Array(requestBytes)\` 并攥住,直到 guest 内捕获`,
    "`InternalError: out of memory` 后停手;「读出封顶」= 停手后 tick 末强制回收的存活堆读数。",
    "",
    "| 单次请求字节 | 攥住的块数 | 读出封顶(bytes) | memoryLimit − 封顶 | 封顶 / memoryLimit | 事件格数 |",
    "|---|---|---|---|---|---|",
    ...capRows,
    "",
    "**封顶随分配形态变化**:单次请求越小,能塞进的块越多、封顶越贴近 `memoryLimit`;单次请求越大,",
    "封顶越接近 `memoryLimit − 请求量`——最后一块塞不下时整块都记不上账,`memoryLimit − 封顶` 里",
    "就留下了那一整块的量级。这就是「分配上限 − 最大单次分配」那条夹逼上界没有可代入定值的原因。",
    "",
    "## 探针②:装 runtime bundle 之后的存活堆基线",
    "",
    "| 口径 | mallocSize 字节 |",
    "|---|---|",
    `| 空 VM(冻结常量 \`EMPTY_VM_MALLOC_SIZE\`,来源 \`${report.aliveHeapBaseline.frozenEmptyVmSource}\`) | ${String(
      report.aliveHeapBaseline.frozenEmptyVmMallocSize,
    )} |`,
    `| 空 VM(本探针同口径实测,\`createSandboxVm\`) | ${String(
      report.aliveHeapBaseline.emptyVmMallocSize,
    )} |`,
    `| 装 runtime bundle + 空脚本,每 tick 末 runGC 后(min/max,${String(
      report.aliveHeapBaseline.samples,
    )} 次) | ${String(loadedMin)} / ${String(loadedMax)} |`,
    "",
    "两个基线**分列**是这一条的目的:75,128 是「**空 VM**、没有 runtime bundle、没有脚本」的基线,",
    "而它的下一行才是「装 bundle 之后」的基线——两者的差就是运行时本身占的存活堆。",
    "",
    "## 对抗探针:两类计数轨各抓住一条命(「每毫秒能烧多少」与截停轨)",
    "",
    "| 探针 | 截停轨(引擎给) | 探针用上限(测试参数) | 次数 | 每毫秒烧多少(中位数与范围) | 各次截停读数 |",
    "|---|---|---|---|---|---|",
    rateRow(report.adversarialProbes.spin),
    rateRow(report.adversarialProbes.apiBomb),
    "",
    "两条探针互为盲区,这正是两条计数轨都必须存在的理由:死循环探针一个 API 都不调(烧的是控制流事件),",
    "API 轰炸探针不产生回边洪流(烧的是 API 调用)。**「被抓住」指定了轨名**:两者都截停于各自的计数轨,",
    "不是墙钟硬超时(探针给的是有限计数上限,不是硬超时)。",
    "",
    "「每毫秒烧多少」= 本 tick 截停读数 / 本 tick 墙钟(只含 `setSnapshot → drainIntents` 一次调用,不含建 VM)。",
    `预热丢弃 ${String(
      probeWarmup,
    )} 次:首次实例化 / 首次大量控制流会让 wasm 侧先冷跑,把它算进速率会系统性偏低。`,
    "",
    "## 三轨异常探针:三条轨各被反复触发,`exceptionTicks` 逐 tick 累加",
    "",
    `每条轨反复触发 ${String(report.exceptionProbe.ticks)} 个 tick,经步 0 把 \`tripped\` 观测落成`,
    "`count-exception-tick` 变更(唯一写入口)。每条轨每 tick 恰触发一次,故累计异常 = tick 数。",
    "",
    "| 轨 | 探针用上限(测试参数) | tick 数 | 累计 exceptionTicks |",
    "|---|---|---|---|",
    ...trackRows,
    "",
    "**同 tick 最多叠加两次**(这条事实单独记):事件轨截停后立即早退,不再判内存 / API,故一条 tick 里",
    `最多 +1;内存判罚线与 API 轨可以在同一 tick 各报一条 \`tripped\`,故可叠到 **+${String(
      report.exceptionProbe.stacking.maxAdditionsPerTick,
    )}**。本探针实测:`,
    "",
    `- 内存判罚线 + API 轨同时越限(叠加探针):同 tick 累计 **+${String(
      report.exceptionProbe.stacking.memoryAndApiPerTick,
    )}**。`,
    `- 三条轨都设、事件轨先截停(早退):同 tick 累计 **+${String(
      report.exceptionProbe.stacking.eventEarlyReturnPerTick,
    )}**。`,
    "",
    `> ${report.exceptionProbe.stacking.note}`,
    "",
    "## 诚实侧:三份基准脚本在真引擎上的「每场每席峰值 → 全局最坏」",
    "",
    "| 场次 | 状态 | tick | 单局墙钟 ms | 事件格数峰值 | API 峰值 | 存活堆峰值(bytes) | 单 tick 墙钟峰值 ms |",
    "|---|---|---|---|---|---|---|---|",
    ...honestRows,
    "",
    "**全局最坏(所有场次、所有座位的峰值里再取最坏):**",
    "",
    `- 存活堆峰值:**${String(report.honestSide.globalWorst.mallocSizePeak)}** 字节。`,
    `- API 调用峰值:**${String(report.honestSide.globalWorst.apiCallsPeak)}**。`,
    `- 事件格数峰值:**${String(report.honestSide.globalWorst.eventGridPeak)}** 格(= ${String(
      report.honestSide.globalWorst.eventGridPeak * report.meta.interruptEventGranularity,
    )} 次控制流事件)。`,
    `- 单 tick 墙钟峰值:**${report.honestSide.globalWorst.loopMsPeak.toFixed(2)}** ms。`,
    `- 单局墙钟最坏:**${Math.round(report.honestSide.globalWorst.matchWallMs)}** ms。`,
    "",
    "单局墙钟这一栏是**给节点 L 的输入指针**:NFR-3 的「对局平均墙钟 `X`」归 L 定(K 只交读数,不取值)。",
    "",
    `**诚实局事件读数的分布(逐 tick 格数):p50 = ${String(grid.p50)}、p95 = ${String(
      grid.p95,
    )}、max = ${String(grid.max)}。**`,
    "事件计数只能按**格数**记、不能按事件数记(相位残留):`eventCount / 中断粒度` 的有效分辨率是一整格,",
    "所以小于一格的取值彼此等价。**诚实局事件读数的 p95 已经填满一整格**——这一点是后续给事件轨取值时的",
    "直接约束,而不是一笔可以四舍五入的噪声。",
    "",
    "### 样本与风险(如实记录)",
    "",
    report.honestSide.sampleNote,
    "",
    "## 终值推导(由读数按规则代入;本节由渲染器生成)",
    "",
    "> 本节是**生成代码**产出的,不是手写:重跑 `pnpm run probes:budget` 会按同一批读数重算。",
    "> 终值的家仍是 `rulesets/v1.json`;这里渲染的是 spec《Implementation Decisions》第 1 条的",
    "> 取值规则与代入算式,并核对代入结果与规则集取值是否一致。",
    "",
    "| 键 | 取值规则 | 代入的读数 | 算式 | 终值(规则集) |",
    "|---|---|---|---|---|",
    ...derivationRows,
    "",
    undeterminedKeyNames.length === 0
      ? `本节覆盖**全部 ${String(finalKeys.length)} 个已定稿的预算键**;未定键集为空(票 07 收口)。`
      : `本节只覆盖**当前已定稿**的预算键(${String(finalKeys.length)} 个);仍未定稿的 ${String(
          undeterminedKeyNames.length,
        )} 个(\`${undeterminedKeyNames.join("、")}\`)待对应票落定后并入。`,
    "",
    "### 墙钟硬超时的取值调和(1024 ms vs 示范值 1000 ms)",
    "",
    "spec《Implementation Decisions》第 1 条的规则文本写「2 的幂,≥ 200 × 诚实单 tick 峰值,",
    "≥ 100 × 软限」,而它自己的代入示范值是 1000 ms——1000 既不是 2 的幂,也不 ≥ 100 × 50(= 5000)。",
    "能同时满足「2 的幂」「示范值约一秒」「§4『宁小勿大』的成本兜底口径」的唯一读法,是把",
    "「≥ 100 × 软限」读作「≥ 20 × 软限」之笔误(20 × 50 = 1000)。据此取值:",
    `\`wallClockHardTimeout\` = 满足 ≥ 20 × 软限与 ≥ 200 × 诚实单 tick 峰值的最小 2 的幂 = **${String(
      derivedHard,
    )} ms**。`,
    "不取 1000(非 2 的幂),也不盲目放大到 8192。",
    "",
    "墙钟两键与体积键的约束核对(与 `check:budget` 门禁同一组判据):",
    "",
    `- 硬超时 ≥ 20 × 软限:${String(derivedHard)} ≥ ${String(20 * derivedSoft)} → ${
      derivedHard >= 20 * derivedSoft ? "成立" : "**不成立**"
    }。`,
    `- 硬超时 ≥ 200 × 诚实单 tick 墙钟峰值且是 2 的幂:${
      200 * tickWallPeak <= derivedHard && (derivedHard & (derivedHard - 1)) === 0
        ? "成立"
        : "**不成立**"
    }。`,
    `- 体积上限 ≥ 基准产物最大值:${String(derivedSize)} ≥ ${String(
      report.meta.benchmarkMaxProductBytes,
    )} → ${derivedSize >= report.meta.benchmarkMaxProductBytes ? "成立" : "**不成立**"}。`,
    "",
    "内存两键的约束核对(与 `check:budget` 门禁同一组判据;两个「未定」不是一件事:",
    "**分配上限未定 = VM 不设任何上限;判罚线未定 = 该轨不启用**):",
    "",
    `- 软阈 = floor(${String(MEMORY_SOFT_THRESHOLD_RATIO)} × 判罚线 ${String(derivedCeiling)}) = **${String(
      softThreshold,
    )}**,${softThreshold > honestPeak ? "严格高于" : "**未**严格高于"}诚实存活堆峰值 ${String(
      honestPeak,
    )}。`,
    `- 判罚线 ≤ 分配上限的一半:${String(derivedCeiling)} ≤ ${String(Math.floor(derivedLimit / 2))} → ${
      derivedCeiling * 2 <= derivedLimit ? "成立" : "**不成立**"
    }。`,
    `- 分配上限 ≥ 8 × 判罚线:${String(derivedLimit)} ≥ ${String(
      8 * derivedCeiling,
    )} → ${derivedLimit >= 8 * derivedCeiling ? "成立" : "**不成立**"}。`,
    `- 0.8 × 判罚线 ≥ 1.5 × 诚实峰值:${String(Math.floor(MEMORY_SOFT_THRESHOLD_RATIO * derivedCeiling))} ≥ ${String(
      Math.ceil(1.5 * honestPeak),
    )} → ${MEMORY_SOFT_THRESHOLD_RATIO * derivedCeiling >= 1.5 * honestPeak ? "成立" : "**不成立**"}。`,
    "",
  ].join("\n");
};

// ── 复算（门禁 `check:budget-recheck`）：终值预算真装着，判失配语义与终值自洽 ────────
//
// 这三条只在 `MW_BUDGET_RECHECK` 设上时跑（默认 `test` 与 `probes:budget` 都不设它）。
// 「终值仍自洽」此前只渲染成 `readings.md` 的散文：推导与规则集不一致时没有任何断言会红。
// 这里把它变成可执行断言，并把诚实侧从空预算换成**终值预算**——空预算下没有一条轨启用，
// 「不被截停」证明不了任何事（spec 决策 6 的缺口）。

it.runIf(recheckMode)("复算:终值下三类探针必被截停", async () => {
  // 事件轨：死循环探针在终值事件上限上被截停。
  const spin = await runBudgetProbeTick({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: EVENT_SPIN_PROBE_SCRIPT,
    eventTickLimit: RULESET.eventTickLimit,
  });
  expect(
    spin.trips.some((trip) => trip.track === EVENT_TRACK),
    "死循环探针没有在终值事件轨上被截停",
  ).toBe(true);
  // API 轨：`--tamper-probe` 把上限抬到探针的燃烧量之上（它就不会被截停）。
  const apiLimit = recheckTamper === "probe" ? apiBombCallsPerTick + 1 : RULESET.apiCallTickLimit;
  const api = await runBudgetProbeTick({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: apiBombProbeScript(apiBombCallsPerTick),
    apiCallTickLimit: apiLimit,
  });
  expect(
    api.trips.some((trip) => trip.track === API_CALL_TRACK),
    "API 轰炸探针没有在终值 API 轨上被截停",
  ).toBe(true);
  // 三轨异常探针：三条轨各在终值上限上被反复触发，累计异常 = tick 数。
  const view = loadRuleset(RULESET);
  const eventTrack = await runExceptionTrack(
    EVENT_SPIN_PROBE_SCRIPT,
    { eventTickLimit: RULESET.eventTickLimit },
    view,
  );
  expect(eventTrack.totalExceptions, "事件计数轨在终值上限下没有被触发").toBe(exceptionProbeTicks);
  const memoryTrack = await runExceptionTrack(
    MEMORY_HOARD_PROBE_SCRIPT,
    { memoryTickCeiling: RULESET.memoryTickCeiling },
    view,
  );
  expect(memoryTrack.totalExceptions, "内存判罚线在终值上限下没有被触发").toBe(exceptionProbeTicks);
  const apiTrack = await runExceptionTrack(
    apiBombProbeScript(2000),
    { apiCallTickLimit: RULESET.apiCallTickLimit },
    view,
  );
  expect(apiTrack.totalExceptions, "API 计数轨在终值上限下没有被触发").toBe(exceptionProbeTicks);
});

it.runIf(recheckMode)("复算:终值预算下三份基准脚本必不被截停", () => {
  expect(RECHECK_FINAL_KEYS.length, "没有任何终值键——复算无从谈起（防假绿）").toBeGreaterThan(0);
  const honest = collected.honestSide;
  expect(honest, "诚实侧没有跑完，复算无从谈起").toBeDefined();
  if (honest === undefined) {
    return;
  }
  expect(honest.matches.length, "没有跑过任何一场基准脚本").toBeGreaterThan(0);
  for (const match of honest.matches) {
    expect(match.status, `${match.id} 在终值预算下没有跑完`).toBe("completed");
    expect(maxOf(match.exceptionTicks), `${match.id} 在终值预算下有轨触限（基准被截停）`).toBe(0);
  }
});

/**
 * 逐字相等断言**豁免**的键:墙钟两键的推导要用一次**负载敏感的墙钟读数**(`loopMsPeak`),
 * 在竞争的机器上会漂(终值取的是观测机制下界,而读数只要超过它的二十分之一就会把它顶掉)。
 * 它们的结构约束(2 的幂、硬 ≥ 20 × 软)由快门禁 `check:budget` 看着;行为侧(基准不被截停)
 * 由本门禁的另两条用例看着。其余六键的读数在固定脚本 / 图 / 种子下是确定值,故逐字相等。
 */
const RECHECK_DERIVATION_EXEMPT: readonly string[] = ["wallClockSoftLimit", "wallClockHardTimeout"];

it.runIf(recheckMode)("复算:终值推导与规则集逐键自洽", () => {
  const report = buildReport();
  const derivedByKey = new Map(
    derivationsOf(report).map((derivation) => [derivation.key, derivation]),
  );
  const finalKeys = BUDGET_KEY_NAMES.filter(
    (key) => RULESET_KEY_CATALOG[key].calibration.state === "final",
  );
  expect(finalKeys.length, "没有任何终值键——复算无从谈起（防假绿）").toBeGreaterThan(0);
  for (const key of finalKeys) {
    if (RECHECK_DERIVATION_EXEMPT.includes(key)) {
      continue;
    }
    const derivation = derivedByKey.get(key);
    expect(derivation, `终值键 ${key} 没有推导`).toBeDefined();
    expect(derivation?.derived, `${key} 的重算值与规则集不一致`).toBe(RULESET[key]);
  }
});

afterAll(() => {
  if (readingsDir === undefined) {
    return;
  }
  const report = buildReport();
  const dir = `${root}${readingsDir}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/readings.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(`${dir}/readings.md`, renderReadingsMarkdown(report), "utf8");
});
