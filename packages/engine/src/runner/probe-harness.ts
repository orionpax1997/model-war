/**
 * 预算标定探针的**仪表化座位执行器**(缝 A:引擎侧「读数测试 + `MW_READINGS_DIR` 落盘」约定)。
 *
 * ── 它是什么,不是什么 ──
 *
 * 它逐条**镜像** `createQuickJsRunner.drainIntents` 的每 tick 次序
 * (`beginTick → loop → pumpJobs → endTick → runGC → memoryUsage → drainIntents`),
 * 只在中间多记一笔读数;**不改任何判定**——交回载荷里 `observations` 恒为空,没有一条轨会因为
 * 这条探针而截停或放行。它与真执行器的唯一区别是「无条件测量」:内存判据只在
 * `memoryTickCeiling` 启用时才强制回收并读堆,而探针量的是读数本身,不受判定开关约束。
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

import type { Ruleset } from "@model-war/replay";

import type { PlayerIndex } from "../world/state.js";
import type { RunnerOutput, SeatRunner } from "./index.js";
import { INTERRUPT_EVENT_GRANULARITY, openSandbox, type TickReadings } from "./quickjs.js";

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
      // 早退分支与真执行器同构(见 `createQuickJsRunner`),交回载荷不带观测:探针不判定。
      if (tick.hardTimedOut) {
        return { intents: [], observations: [], fault: "uncertain-timeout" };
      }
      if (tick.eventTripped) {
        return { intents: [], observations: [] };
      }
      return { intents: drained.intents, observations: [] };
    },
  };

  return { runner, readings, dispose: session.dispose };
};
