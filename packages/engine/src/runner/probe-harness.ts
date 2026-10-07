/**
 * 预算标定探针的**仪表化座位执行器**(缝 A:引擎侧「读数测试 + `MW_READINGS_DIR` 落盘」约定)。
 *
 * ── 它是什么,不是什么 ──
 *
 * 它逐条**镜像** `createQuickJsRunner.drainIntents` 的每 tick 次序
 * (`beginTick → loop → pumpJobs → endTick → runGC → memoryUsage → drainIntents`),
 * 只在中间多记一笔读数。**不给出任何阈值时**它不改判定——交回载荷里 `observations` 恒为空,
 * 没有一条轨会因为这条探针而截停或放行(诚实量测);**给出阈值时**它与真执行器同构地判一次
 * (`tripped` 观测按同一套次序落地),此时它可直接当座位执行器塞进对局、驱动 `exceptionTicks`。
 * 它与真执行器的另一处区别是「无条件测量」:内存判据只在 `memoryTickCeiling` 启用时才强制回收
 * 并读堆,而探针量的是读数本身,不受判定开关约束。
 *
 * 它返回的是一个普通 `SeatRunner`(两个方法),因此可以直接当座位执行器塞进四人对局
 * (spec 缝 A);本模块不做磁盘 I/O,读盘与落盘留给 `*.test.ts`(引擎运行时源码禁 `node:*`)。
 *
 * ── 两个必须继承的坑(来自一次性 prototype `readings-probe.mjs`) ──
 *
 * ①**计数回调只在构造 VM 时装上**(`QuickJS.create` 的 `interruptHandler` 选项,建 VM 后没有
 *   setter)。不显式给一个事件上限,闭包计数器根本不建,`eventCount` 恒 0。所以这里的
 *   `eventTickLimit` 默认取 `NEVER_EVENT_LIMIT`;只读堆、且要与「内存判据(它只在事件 / 墙钟轨
 *   启用时才装回调)」对齐口径的探针,才显式传 `null` 把它关掉。
 * ②**wasm 侧的计数器跨调用不清零、有相位残留**,读数 5000 可能只是上一 tick 的残影。因此
 *   读数一律按**格数**记(`eventGrid = eventCount / INTERRUPT_EVENT_GRANULARITY`),原始
 *   `eventCount` 只作附栏,论证只用格数。
 */

import { MEMORY_SOFT_THRESHOLD_RATIO, type Ruleset } from "@model-war/replay";

import type { PlayerIndex, Snapshot } from "../world/state.js";
import type { Observation, RunnerOutput, SeatRunner } from "./index.js";
import {
  API_CALL_TRACK,
  EVENT_TRACK,
  INTERRUPT_EVENT_GRANULARITY,
  MEMORY_TRACK,
  createQuickJsRunner,
  openSandbox,
  type TickReadings,
} from "./quickjs.js";

/** 「本轨永不截停」的极大事件上限:它的唯一作用是让计数回调被装上(见头注坑①)。 */
export const NEVER_EVENT_LIMIT = Number.MAX_SAFE_INTEGER;

/** 一个 tick 的裸读数:**只记数,不判定**。 */
export type ProbeTickReading = {
  /** 本 tick 的快照 tick(由 `setSnapshot` 记下)。 */
  readonly tick: number;
  /** 宿主侧事件计数原值。恒为 `INTERRUPT_EVENT_GRANULARITY` 的整数倍;含相位残留。 */
  readonly eventCount: number;
  /** 事件读数的**格数**(`eventCount / INTERRUPT_EVENT_GRANULARITY`)。论证只用它。 */
  readonly eventGrid: number;
  /** 本 tick 的 API 调用计数(经 `__drainIntents()` 交回)。 */
  readonly apiCalls: number;
  /** tick 末强制回收之后的存活堆(bytes),与内存判据同口径。 */
  readonly mallocSize: number;
  /** 同一时刻的 `memoryUsedSize`(不含空闲池,只作对照,不作判据)。 */
  readonly memoryUsedSize: number;
  /** 同一时刻的活对象数(只作对照)。 */
  readonly objCount: number;
  /** `beginTick` 到 `endTick` 的墙钟(ms),即脚本自身的耗时(不含 tick 末强制回收)。 */
  readonly loopMs: number;
  /** 本 tick 是否被墙钟硬超时截停。 */
  readonly hardTimedOut: boolean;
  /** 本 tick 的 guest 异常消息(若是被截停而吞下的那一次);正常为 `null`。 */
  readonly error: string | null;
};

/** 开一条探针会话的输入:在会话输入之上把 `eventTickLimit` 变成可选(默认装回调)。 */
export type ProbeSeatOptions = {
  /** wasm 字节或已编译的 Module(四个座位可复用同一个 Module)。 */
  readonly wasm: WebAssembly.Module | ArrayBufferView | ArrayBuffer;
  /** runtime bundle 的 IIFE 源码。 */
  readonly runtimeCode: string;
  /** 参赛脚本源码(入口名固定 `function loop()`)。 */
  readonly scriptCode: string;
  /** 本 VM 服务哪个座位。 */
  readonly seat: PlayerIndex;
  /** 这一局的规则集(缺席即判据降级,与 `openSandbox` 同义)。 */
  readonly ruleset?: Ruleset;
  /** VM 线性内存分配上限(bytes)。缺席即不设上限。 */
  readonly memoryLimit?: number;
  /** 墙钟硬超时(ms)。缺席即本轨不启用。 */
  readonly wallClockHardTimeout?: number;
  /**
   * API 调用计数上限(次/tick)。给定时本探针与 `createQuickJsRunner` **同构**地判一次 API 轨
   * (`drained.apiCalls >= 上限` → 一条 `tripped` 观测);缺席即本轨不判。它是**探针用的有限上限**,
   * 不是一个建议阈值。
   */
  readonly apiCallTickLimit?: number;
  /**
   * 内存判罚线(bytes,tick 末存活堆 `mallocSize`)。给定时本探针与 `createQuickJsRunner` 同构地判
   * 一次内存轨(达线报 `tripped`、达软阈报 `memory-pressure`);缺席即本轨不判。**探针用它驱动内存轨。**
   */
  readonly memoryTickCeiling?: number;
  /** 软阈系数:软阈 = 该系数 × `memoryTickCeiling`。缺席取真源包的 `MEMORY_SOFT_THRESHOLD_RATIO`。 */
  readonly softThresholdRatio?: number;
  /**
   * 事件计数上限。
   *
   * - `undefined`(默认)取 `NEVER_EVENT_LIMIT`:装回调、拿事件读数(见头注坑①)。
   * - 数字:显式阈值(会被 `tickCounterHandler` 用来判截停)。
   * - `null`:**不装回调**——只读堆、且要与「内存判据」对齐口径时用(内存判据只在事件 / 墙钟
   *   轨启用时才装回调)。
   */
  readonly eventTickLimit?: number | null;
};

/** 一条探针座位:可当 `SeatRunner` 用,外加逐 tick 读数的实时数组与释放。 */
export type ProbeSeat = {
  readonly runner: SeatRunner;
  /** 逐 tick 读数。**实时数组**:每跑一 tick 追加一条,调用方拿到的就是同一份引用。 */
  readonly readings: readonly ProbeTickReading[];
  readonly dispose: () => void;
};

/**
 * 开一条仪表化会话。`dispose` 归调用方;交回的 `runner` 与 `createQuickJsRunner` 逐条同序。
 */
export const createProbeSeat = async (options: ProbeSeatOptions): Promise<ProbeSeat> => {
  // 判定阈值:给出时才判(与真执行器同一套次序);不给时观测恒空、纯量测。
  const judgeEventLimit =
    options.eventTickLimit === null ? undefined : (options.eventTickLimit ?? NEVER_EVENT_LIMIT);
  const ceiling = options.memoryTickCeiling;
  const softThreshold =
    ceiling === undefined
      ? undefined
      : Math.floor((options.softThresholdRatio ?? MEMORY_SOFT_THRESHOLD_RATIO) * ceiling);
  const apiCallTickLimit = options.apiCallTickLimit;
  const session = await openSandbox({
    wasm: options.wasm,
    runtimeCode: options.runtimeCode,
    scriptCode: options.scriptCode,
    seat: options.seat,
    ...(options.ruleset === undefined ? {} : { ruleset: options.ruleset }),
    ...(options.memoryLimit === undefined ? {} : { memoryLimit: options.memoryLimit }),
    ...(options.wallClockHardTimeout === undefined
      ? {}
      : { wallClockHardTimeout: options.wallClockHardTimeout }),
    ...(options.eventTickLimit === null
      ? {}
      : { eventTickLimit: options.eventTickLimit ?? NEVER_EVENT_LIMIT }),
  });
  let currentTick = -1;
  const readings: ProbeTickReading[] = [];

  const runner: SeatRunner = {
    setSnapshot: (snapshot) => {
      currentTick = snapshot.tick;
      session.setSnapshot(snapshot);
    },
    drainIntents: (): RunnerOutput => {
      session.beginTick();
      const started = performance.now();
      let tick: TickReadings;
      let error: string | null = null;
      try {
        session.runLoop();
        session.pumpJobs();
        tick = session.endTick();
      } catch (thrown) {
        tick = session.endTick();
        // 与真执行器同一条:只有「本轨截停 / 硬超时」才吞异常;别的异常原样冒给宿主。
        if (!tick.eventTripped && !tick.hardTimedOut) {
          throw thrown;
        }
        error = thrown instanceof Error ? thrown.message : String(thrown);
      }
      const loopMs = performance.now() - started;
      // 无条件测:判据只在 `memoryTickCeiling` 启用时才回收并读堆,探针量的是读数本身。
      session.runGC();
      const usage = session.memoryUsage();
      const drained = session.drainIntents();
      readings.push({
        tick: currentTick,
        eventCount: tick.eventCount,
        eventGrid: tick.eventCount / INTERRUPT_EVENT_GRANULARITY,
        apiCalls: drained.apiCalls,
        mallocSize: usage.mallocSize,
        memoryUsedSize: usage.memoryUsedSize,
        objCount: usage.objCount,
        loopMs,
        hardTimedOut: tick.hardTimedOut,
        error,
      });
      // 早退分支与真执行器同构(见 `createQuickJsRunner`);给出阈值时交回 `tripped` 观测,
      // 不给阈值时观测恒空——两种形态的次序完全一致,只是观测这一栏内容不同。
      if (tick.hardTimedOut) {
        return { intents: [], observations: [], fault: "uncertain-timeout" };
      }
      if (tick.eventTripped) {
        if (judgeEventLimit === undefined) {
          throw new Error("事件计数被截停但本轨未启用——引擎故障");
        }
        return {
          intents: [],
          observations: [
            { kind: "tripped", track: EVENT_TRACK, value: tick.eventCount, limit: judgeEventLimit },
          ],
        };
      }
      const observations: Observation[] = [];
      if (ceiling !== undefined) {
        if (usage.mallocSize >= ceiling) {
          observations.push({
            kind: "tripped",
            track: MEMORY_TRACK,
            value: usage.mallocSize,
            limit: ceiling,
          });
        } else if (softThreshold !== undefined && usage.mallocSize >= softThreshold) {
          observations.push({
            kind: "memory-pressure",
            track: MEMORY_TRACK,
            value: usage.mallocSize,
            limit: softThreshold,
          });
        }
      }
      if (apiCallTickLimit !== undefined && drained.apiCalls >= apiCallTickLimit) {
        observations.push({
          kind: "tripped",
          track: API_CALL_TRACK,
          value: drained.apiCalls,
          limit: apiCallTickLimit,
        });
        return { intents: [], observations };
      }
      return { intents: drained.intents, observations };
    },
  };

  return { runner, readings, dispose: session.dispose };
};

/** 一份最小快照:探针脚本不读状态;即使读,拿到的也是一个空世界。 */
export const emptySnapshot = (tick: number): Snapshot => ({
  tick,
  size: 0,
  terrain: [],
  players: [],
  units: [],
  sites: [],
});

/**
 * 死循环探针:只烧控制流事件(循环回边 + 调用 + 返回),**零 API、零分配**。
 * 截停它的只可能是事件计数轨(两条计数轨互为盲区的另一半见 API 轰炸探针);
 * 真实截停点是 `ceil(limit / 中断粒度) × 中断粒度`。
 */
export const EVENT_SPIN_PROBE_SCRIPT = [
  "function burn(n) { var acc = 0; for (var i = 0; i < n; i += 1) { acc = (acc + 1) % 7; } return acc; }",
  "function loop() { for (;;) { burn(1000); } }",
].join("\n");

/**
 * API 轰炸探针:一个 tick 内有界地打 `callsPerTick` 次查询 API,之后返回。
 *
 * **为什么必须有界**:API 调用计数在 guest 侧自增、只在 `loop()` 返回后经 `__drainIntents()`
 * 回到宿主才判——无限循环会让这条轨永远没有判定点,最后被墙钟硬超时截停。有界返回让
 * **API 计数轨**成为截停者。它只烧 API(不产生回边洪流),与死循环探针互为盲区。
 */
export const apiBombProbeScript = (callsPerTick: number): string =>
  [
    "function loop() {",
    `  for (var i = 0; i < ${String(callsPerTick)}; i += 1) { getTick(); }`,
    "}",
  ].join("\n");

/**
 * 撑内存探针:第一 tick 种下一大块跨 tick 存活的堆,之后一动不动地攥着。
 * 判据读数取在 tick 末强制回收之后,存活堆因此逐 tick 压在线之上——内存轨每 tick 触发一次。
 */
export const MEMORY_HOARD_PROBE_SCRIPT = [
  "var hoard = null;",
  "function loop() {",
  "  if (hoard === null) {",
  "    hoard = [];",
  "    for (var i = 0; i < 240000; i += 1) { hoard.push({ i: i }); }",
  "  }",
  "}",
].join("\n");

/**
 * 叠加探针:同一个 tick 里既攥住跨 tick 存活的堆(内存判罚线),又打满 API 调用(API 轨)。
 * 它用来量「同 tick 最多叠加两次异常」:内存与 API 两条轨都在 `tripped` 之前返回,故一次 tick
 * 落两条 `count-exception-tick`。事件轨不参与(它在内存 / API 之前早退)。
 */
export const MEMORY_API_PROBE_SCRIPT = [
  "var hoard = null;",
  "function loop() {",
  "  if (hoard === null) {",
  "    hoard = [];",
  "    for (var i = 0; i < 240000; i += 1) { hoard.push({ i: i }); }",
  "  }",
  "  for (var j = 0; j < 60000; j += 1) { getTick(); }",
  "}",
].join("\n");

/** 一条判定式探针跑一个 tick 的结论:**哪些轨截停了它、截停读数是多少、花了多久**。 */
export type BudgetProbeVerdict = {
  /** 本 tick 触限的轨(**真执行器** `createQuickJsRunner` 给的 `tripped` 观测,一条轨一项)。 */
  readonly trips: readonly { readonly track: string; readonly value: number }[];
  /** 本 tick 的墙钟(ms):只包住 `setSnapshot` → `drainIntents` 这一次调用,**不含建 VM**。 */
  readonly wallMs: number;
  /** 硬超时导致的整场作废(它看起来像「被抓住」,所以与 `trips` 分列)。 */
  readonly timedOut: boolean;
};

/**
 * 用**真执行器**跑一个 tick 的判定式预算探针(截停轨 / 读数 / 墙钟由它给出)。
 *
 * 它用 `createQuickJsRunner` 而不是 `createProbeSeat`:探针要的不是「量一笔读数」而是
 * 「这条轨到底截没截停它」,那件事的唯一权威是引擎自己的判定路径。探针阈值全是**有限上限**
 * (测试参数,不是建议值),所以截停者一定是一条计数 / 判罚轨,而不是墙钟硬超时。
 */
export const runBudgetProbeTick = async (options: {
  readonly wasm: WebAssembly.Module | ArrayBufferView | ArrayBuffer;
  readonly runtimeCode: string;
  readonly scriptCode: string;
  readonly seat?: PlayerIndex;
  readonly eventTickLimit?: number;
  readonly apiCallTickLimit?: number;
  readonly memoryTickCeiling?: number;
  readonly wallClockHardTimeout?: number;
}): Promise<BudgetProbeVerdict> => {
  const handle = await createQuickJsRunner({
    wasm: options.wasm,
    runtimeCode: options.runtimeCode,
    scriptCode: options.scriptCode,
    seat: options.seat ?? 0,
    ...(options.eventTickLimit === undefined ? {} : { eventTickLimit: options.eventTickLimit }),
    ...(options.apiCallTickLimit === undefined
      ? {}
      : { apiCallTickLimit: options.apiCallTickLimit }),
    ...(options.memoryTickCeiling === undefined
      ? {}
      : { memoryTickCeiling: options.memoryTickCeiling }),
    ...(options.wallClockHardTimeout === undefined
      ? {}
      : { wallClockHardTimeout: options.wallClockHardTimeout }),
  });
  try {
    handle.runner.setSnapshot(emptySnapshot(0));
    const started = performance.now();
    const output = handle.runner.drainIntents();
    const wallMs = performance.now() - started;
    const trips = output.observations
      .filter((observation) => observation.kind === "tripped")
      .map((observation) => ({ track: observation.track, value: observation.value }));
    return { trips, wallMs, timedOut: output.fault !== undefined };
  } finally {
    handle.dispose();
  }
};
