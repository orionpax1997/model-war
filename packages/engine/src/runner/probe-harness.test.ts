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
  QUICKJS_WASI_VERSION,
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
const honestScenarios = fullSample ? FULL_HONEST_SCENARIOS : [DEFAULT_HONEST_SCENARIO];

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
      budget: {},
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
  ].join("\n");
};

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
