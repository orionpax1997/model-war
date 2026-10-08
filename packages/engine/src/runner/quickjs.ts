/**
 * `QuickJsRunner`:执行器缝的**真实沙箱**适配器(票 03 的第一枚 tracer bullet)。
 *
 * ── 缝不变:仍然恰好两个方法 ──
 *
 * 建 VM、铺注入面、**删掉 setup 与桥**、灌座位与规则面、释放——全部发生在**工厂**里,不在
 * `SeatRunner` 上。
 * 交出去的执行器只有 `setSnapshot` / `drainIntents` 两条方法(与 `StubRunner` 逐字同形),
 * 所以结算管线认不出它收的是桩还是真 VM。VM 的生命周期归组装层:工厂返回 `{ runner, dispose }`,
 * 谁建的谁释放。
 *
 * ── 为什么吃字节/字面量、不做磁盘 I/O ──
 *
 * engine 的运行时代码除 `node:crypto` 外禁一切 `node:*`(hld §2.2.8)。wasm 字节(或已编译的
 * `WebAssembly.Module`)、runtime bundle 字节、脚本字面量都由**组装层**读盘后传进来
 * (hld §5.1:wasm 字节由 runner 层读盘传入 engine)。本模块一次读盘都没有。
 *
 * ── 三件套是构造选项,不是每 tick 的决定 ──
 *
 * 冻钟是 `wasi` 对 `clock_time_get` 的覆盖(写回固定纳秒值),`Math.random()` 的种子就来自这次
 * 读钟;随机字节是 `wasi` 对 `random_get` 的覆盖(固定填充);时区是构造选项 `timezoneOffset`。
 * 三者只能建 VM 时定一次,所以它们不是对局参数,而是工程常量——同一份脚本因此在对局内、跨 VM、
 * 跨重跑三个维度上得到同一序列。
 *
 * ── 载入次序与删桥 ──
 *
 * 灌一次性 setup `{ seat, ruleset }` 到 `__setSnapshot` 这个名字下 → `evalCode(runtimeCode)` 建 API 面
 * (runtime 在载入时把 setup 读进闭包,并把同一名字换成每 tick 的桥函数;`getMyIndex()` 由它自己铺)
 * → 取两个桥的函数 handle → 从全局删掉两个桥 → `evalCode(scriptCode)` 载入脚本(入口名固定
 * `function loop()`)。
 * 每 tick:`__setSnapshot(snapshot)` → `loop()` → `executePendingJobs()` 排空到不动点 →
 * `__drainIntents()`。删干净了的断言是「脚本按 `__` 前缀枚举为空」,而宿主仍能经函数 handle 调桥。
 *
 * ── 排空到不动点为什么必须在 drain 之前 ──
 *
 * 单 tick 是同步的,但脚本可以用 `Promise.resolve().then(…)` 把一条意图推迟到一个 job 里。
 * 不排空,这条意图就会留到下一 tick 才被交回——**意图跨 tick 残留**。`runLoop` 与
 * `pumpJobs` 分成两步暴露(而非在 `drainIntents` 里一把梭),正是为了给这条反例留一个
 * 能弄红的入口:见 `quickjs.test.ts`。
 *
 * ── 双计数与墙钟(票 07/09):宿主 authored 的纯整数计数 + 抽样读钟 ──
 *
 * 控制流事件计数用 `QuickJS.create({ interruptHandler })` 装一个宿主闭包计数器:WASM 侧每
 * `INTERRUPT_EVENT_GRANULARITY` 次控制流事件(循环回边/调用/返回)调一次,回调**每次只做整数
 * 自增与整数比较**,不分配;墙钟按 `WALL_CLOCK_SAMPLE_INTERVAL` **抽样读**(每若干次回调读一次
 * `performance.now()`,不是每次)——这是 hld §5.3「回调内不得放**每次**都做的重活;时钟按抽样读」
 * 的落点。计数状态只能住宿主闭包——`interruptHandler` 建 VM 后改不了(没有 setter)。本 tick
 * 进入时归零,累计值在闭包内。
 *
 * API 调用计数**在 guest 运行时里**自增(hld §4.5:action/查询函数做「收集 + 界检查 + API 计数
 * 自增」),经**同一次 `__drainIntents()` 返回载荷**带回宿主(返回结构 `{ intents, apiCalls }`),
 * 宿主拿 `apiCallTickLimit` 比较后裁决。不新增桥调用、不做每次 API 调用的跨边界计数。
 *
 * **超限的后果**:
 * - 事件 / API 两轨超限 → 只作废该座位本 tick 的意图(单位原地待命),不中断其他三方与
 *   引擎;产出一条 `tripped` 观测(轨名 = 预算键名),经步 0 落成 `count-exception-tick` 变更。
 * - guest 未吞掉的异常(脚本 `throw` / 引用已删的宿主桥 / 调未定义的 action…) → **同样只作废
 *   该座位本 tick 的意图并计一次异常**(`tripped` 观测的轨名是 `UNCAUGHT_EXCEPTION_TRACK`),
 *   **不再原样重抛成整场 `engine-crash`**;VM 续用、记忆保留。
 * - 墙钟软限 → **只产一条 `wall-clock-soft` 观测**,不判罚、不进回放。
 * - 墙钟硬超时 → 中断本 tick,交回故障位 `uncertain-timeout`,整场走**作废而非判罚**那条轨。
 *
 * 本 tick 的计数在进入下一 tick 时重置;`exceptionTicks` 却是跨 tick 单调递增、不清零的。
 *
 * ── 内存判据(票 08):读数,不是异常 ──
 *
 * 判据锚定在宿主**可直接测量**的量上,与 guest 的异常可见性无关:guest 可以把内存超限转成的
 * 异常 `try/catch` 吞掉,那时宿主全程无感知——靠异常披露那条路是死的。所以每 tick 的次序是
 * `loop()` → `pumpJobs()` → **强制 `runGC()` 之后**读 `getMemoryUsage().mallocSize`
 * (存活堆口径,与 `memoryLimit` 同一记账口径;不是更低的 `memoryUsedSize`、也不是 `objCount`)
 * → 组装观测 → `__drainIntents()`。
 *
 * 三层阈值:
 * - **分配上限**(硬):`memoryLimit`,VM 构造选项,超限转成 guest 可见的 `InternalError`;
 * - **判罚线**(硬):`memoryTickCeiling`,读数**达**它即一条 `tripped` 观测(经步 0 累加
 *   `exceptionTicks`);
 * - **软阈值**(观测):`MEMORY_SOFT_THRESHOLD_RATIO × memoryTickCeiling`,只发一条
 *   `memory-pressure` 观测、不判罚。它是判罚线的**推导项**,不是独立参数键。
 *
 * **已接受的残余**:tick 内瞬时借满分配上限、随即自行释放的分配**不触发判据**。这不是漏判——
 * 读的是 tick 末强制回收**之后**的存活堆,那一刻它已不可达。契约面同一条陈述见
 * `packages/schema/src/script-outcome.ts`「tick 内瞬时触顶后自行释放的分配不判」。
 *
 * **强制回收不是免费动作**:它每 tick 一次,顶替的正是「靠自动 GC 恰好在读数前回收」那条
 * 不可靠的路(自动 `gcThreshold` 保留默认,不动它——关了它只会把读数推高、更容易误踩判罚线)。
 * 这条开销进性能标定的考量,它的读数由 `quickjs.test.ts` 里那条「强制回收开销」用例记录在案。
 */

import { QuickJS, type JSValueHandle, type MemoryUsage } from "quickjs-wasi";
import { MEMORY_SOFT_THRESHOLD_RATIO, type Ruleset } from "@model-war/replay";

import type { Intent } from "../processor/intents.js";
import type { PlayerIndex, Snapshot } from "../world/state.js";
import {
  HOST_BRIDGE_DRAIN_INTENTS,
  HOST_BRIDGE_SET_SNAPSHOT,
  type Observation,
  type SeatRunner,
} from "./index.js";

/** 冻钟的固定读数:十进制毫秒。三件套之一,取值是工程常量(见 spec《WASI 三件套与回放 meta》)。 */
export const WASI_CLOCK_MS = 1_700_000_000_000;

/** 时区偏移:十进制分钟(UTC = 0)。三件套之一。`Date` 与 `getTimezoneOffset()` 由它决定。 */
export const WASI_TIMEZONE_OFFSET_MINUTES = 0;

/** 随机字节固定填充的**单字节值**。三件套之一(见本模块头注)。 */
const WASI_RANDOM_FILL_BYTE = 0x00;

/**
 * `random_get` 的固定字节填充:**十六进制、不带 `0x` 前缀**。回放 meta 的 `wasiRandomFill` 栏取它。
 *
 * 由单字节值推出(而不是另写一个字面量字符串),于是「覆盖写进去的字节」与「写回放 meta 的字串」
 * 不可能分叉。`quickjs-wasi` 默认的 `random_get` 走宿主 WebCrypto(**非确定**),所以必须显式覆盖。
 */
export const WASI_RANDOM_FILL = WASI_RANDOM_FILL_BYTE.toString(16).padStart(2, "0");

/** 脚本入口的固定名字。载入之后引擎只调它(`function loop()`)。 */
export const SCRIPT_ENTRY = "loop";

/** 建 VM 的输入:字节或已编译的 Module,再加上三件套里的两件(钟由 `clockMs` 定)。 */
export type QuickJsVmOptions = {
  /** wasm 字节或已编译的 `WebAssembly.Module`。四 VM 复用同一个 Module 是推荐形态。 */
  readonly wasm: WebAssembly.Module | ArrayBufferView | ArrayBuffer;
  /** 冻钟读数(毫秒)。缺席取 `WASI_CLOCK_MS`。 */
  readonly clockMs?: number;
  /** 时区偏移(分钟)。缺席取 `WASI_TIMEZONE_OFFSET_MINUTES`。 */
  readonly timezoneOffsetMinutes?: number;
  /** VM 线性内存分配上限(字节)。缺席即不设上限(预算机制归票 07/08)。 */
  readonly memoryLimit?: number;
  /**
   * 控制流事件计数的上限(次/本 tick)。**只能在构造时装**:计数回调是 `QuickJS.create` 的选项,
   * 建 VM 后没有 setter,所以计数状态住在闭包里。缺席即本轨不启用——连回调都不装,不计数、
   * 不中断。组装层读键清单的 `calibration.state`,未定值就不传这个字段(引擎不认识「未定值」)。
   */
  readonly eventTickLimit?: number;
  /**
   * 单 tick 墙钟软限(ms)。缺席即本轨不启用(不读钟)。软限**只产一条 `wall-clock-soft`
   * 观测、不判罚、不进回放**(spec《双重计数与墙钟》)。
   */
  readonly wallClockSoftLimit?: number;
  /**
   * 墙钟硬超时(ms)。缺席即本轨不启用。超时中断本 tick 并交回故障位 `uncertain-timeout`,
   * 使整场作废(不判负)——它是防宿主卡死的最后一道防线。
   */
  readonly wallClockHardTimeout?: number;
};

/** 控制流事件计数的粒度:WASM 侧每这么多次控制流事件(循环回边/调用/返回)触发一次回调。 */
export const INTERRUPT_EVENT_GRANULARITY = 5000;

/**
 * 墙钟按抽样读的间隔:每这么多次**回调**读一次时钟(回调本身是每 `INTERRUPT_EVENT_GRANULARITY`
 * 次控制流事件一次)。
 *
 * 这是 hld §5.3「回调内不得放**每次**都做的重活;时钟按抽样读」的落点:一次 `performance.now()`
 * 比一次整数自增贵得多,而墙钟只观测不判罚——粒度粗一点不损失任何结论。量级取 20:以 5000/回调
 * 的粒度计,每 10 万次控制流事件才读一次钟,对短脚本几乎免费,对死循环足够密(毫秒级)。
 */
export const WALL_CLOCK_SAMPLE_INTERVAL = 20;

/** 控制流事件计数的轨名(与规则集预算键同名;`tripped` 观测与变更都带它)。 */
export const EVENT_TRACK = "eventTickLimit";

/** API 调用计数的轨名。 */
export const API_CALL_TRACK = "apiCallTickLimit";

/** 墙钟软限的轨名(与规则集预算键同名;观测行的 `kind` 是 `wall-clock-soft`)。 */
export const WALL_CLOCK_TRACK = "wallClockSoftLimit";

/**
 * 宿主侧的 tick 计数状态。字段全是整数/布尔:计数回调内只做整数自增与整数比较,
 * 时钟按抽样读(见 `WALL_CLOCK_SAMPLE_INTERVAL`)。
 *
 * **计数状态只能住宿主闭包**:`interruptHandler` 是 `QuickJS.create()` 的构造选项,建 VM 后
 * 没有 setter。快照进、意图出那两次桥不承载计数状态。
 */
export type TickCounter = {
  /** 控制流事件计数的上限;缺席即本轨不启用(不比较)。 */
  readonly eventLimit: number | undefined;
  /** 墙钟软限(ms);缺席即本轨不启用。 */
  readonly softLimit: number | undefined;
  /** 墙钟硬超时(ms);缺席即本轨不启用。 */
  readonly hardLimit: number | undefined;
  eventCount: number;
  eventTripped: boolean;
  armed: boolean;
  /** 本 tick 开始时的墙钟读数(ms);`beginTick` 时取一次。 */
  tickStart: number;
  /** 距上一次读钟已过了几次回调。 */
  sinceSample: number;
  /** 软限在本 tick 内**首次**被越过时的读数(ms);`-1` 表示未越过。 */
  softValue: number;
  /** 本 tick 是否被墙钟硬超时截停。 */
  hardTimedOut: boolean;
};

export const createTickCounter = (options: {
  readonly eventLimit: number | undefined;
  readonly softLimit: number | undefined;
  readonly hardLimit: number | undefined;
}): TickCounter => ({
  eventLimit: options.eventLimit,
  softLimit: options.softLimit,
  hardLimit: options.hardLimit,
  eventCount: 0,
  eventTripped: false,
  armed: false,
  tickStart: 0,
  sinceSample: 0,
  softValue: -1,
  hardTimedOut: false,
});

/**
 * 计数回调。**每次调用的动作只有整数自增与整数比较**;时钟按 `WALL_CLOCK_SAMPLE_INTERVAL`
 * 抽样读(不是每次)——这是 hld §5.3 那条硬要求的落点。
 *
 * WASM 侧每 `INTERRUPT_EVENT_GRANULARITY` 次控制流事件调它一次;返回 `true` 即中断本 tick
 * (WASM 侧抛 host `JSException: InternalError: interrupted`)。计数只在本 tick **armed** 期间
 * 发生——`loop()` 与 job 排空之外(runtime 载入、`__setSnapshot` 的 guest 代码)不计。
 *
 * 硬超时与事件计数都用同一个 `true` 中断本 tick;区分靠 `hardTimedOut` 标志——前者使整场作废
 * (`uncertain-timeout`),后者只是一条 `tripped` 观测。
 */
export const tickCounterHandler = (counter: TickCounter): boolean => {
  if (!counter.armed) {
    return false;
  }
  counter.eventCount += INTERRUPT_EVENT_GRANULARITY;
  // 墙钟:每 `WALL_CLOCK_SAMPLE_INTERVAL` 次回调才读一次钟(不是每次)。软限只记读数,硬超时截停。
  if (counter.softLimit !== undefined || counter.hardLimit !== undefined) {
    counter.sinceSample += 1;
    if (counter.sinceSample >= WALL_CLOCK_SAMPLE_INTERVAL) {
      counter.sinceSample = 0;
      const elapsed = performance.now() - counter.tickStart;
      if (counter.hardLimit !== undefined && elapsed >= counter.hardLimit) {
        counter.hardTimedOut = true;
        return true;
      }
      if (
        counter.softLimit !== undefined &&
        counter.softValue < 0 &&
        elapsed >= counter.softLimit
      ) {
        counter.softValue = elapsed;
      }
    }
  }
  if (counter.eventLimit !== undefined && counter.eventCount >= counter.eventLimit) {
    counter.eventTripped = true;
    return true;
  }
  return false;
};

/** VM 加它的那条闭包钩:会话层需要经 `counter` 开合本 tick 的计数闸门与读回读数。 */
type SandboxVmHandle = {
  readonly vm: QuickJS;
  readonly counter: TickCounter;
};

/**
 * 建一个被三件套钉住的 VM,并随口把计数闭包交出去。
 *
 * 计数回调只有在构造时才能装上,所以「三条轨里任一条启用时」才装它(全不启用连回调都不装,零开销)。
 */
const createSandboxVmWithCounter = async (options: QuickJsVmOptions): Promise<SandboxVmHandle> => {
  const clockMs = options.clockMs ?? WASI_CLOCK_MS;
  const counter = createTickCounter({
    eventLimit: options.eventTickLimit,
    softLimit: options.wallClockSoftLimit,
    hardLimit: options.wallClockHardTimeout,
  });
  // 事件计数 / 墙钟软限 / 墙钟硬超时三条轨共用同一个回调:任一条启用就装它。
  const anyTrackEnabled =
    options.eventTickLimit !== undefined ||
    options.wallClockSoftLimit !== undefined ||
    options.wallClockHardTimeout !== undefined;
  const vm = await QuickJS.create({
    wasm: options.wasm,
    timezoneOffset: options.timezoneOffsetMinutes ?? WASI_TIMEZONE_OFFSET_MINUTES,
    ...(options.memoryLimit === undefined ? {} : { memoryLimit: options.memoryLimit }),
    // 三条轨全不启用时不装回调:不计数、不读钟,也不付那份每次调用的税。
    ...(anyTrackEnabled ? { interruptHandler: () => tickCounterHandler(counter) } : {}),
    // 冻钟:覆盖 `clock_time_get`,写回固定纳秒值。`Math.random()` 的 xorshift 种子就取自这里,
    // 所以「冻钟」同时钉住了随机源——三件套里的两件是同一件事的两面。
    wasi: (memory: WebAssembly.Memory) => ({
      clock_time_get: (_clockId: number, _precision: number, resultPtr: number): number => {
        new DataView(memory.buffer).setBigUint64(resultPtr, BigInt(clockMs) * 1_000_000n, true);
        return 0;
      },
      // 随机源不靠宿主 WebCrypto(那是非确定的):ALL 覆盖为固定字节填充。WASI libc 启动期的
      // `arc4random`/`getentropy` 与将来若加载的扩展都走这里,于是整场对局完全确定。
      random_get: (bufPtr: number, bufLen: number): number => {
        new Uint8Array(memory.buffer, bufPtr, bufLen).fill(WASI_RANDOM_FILL_BYTE);
        return 0;
      },
    }),
  });
  return { vm, counter };
};

/** 建一个被三件套钉住的 VM。**只有本模块与测试用**;测试也经它拿到真实配置(见 `quickjs.test.ts`)。 */
export const createSandboxVm = async (options: QuickJsVmOptions): Promise<QuickJS> =>
  (await createSandboxVmWithCounter(options)).vm;

/** 内存判据的轨名。观测的 `track` 用它,与规则集里的预算键同名。 */
export const MEMORY_TRACK = "memoryTickCeiling";

/**
 * 「`loop()` 抛异常」这条**计异常轨**的轨名。
 *
 * ── 为什么它不是一个预算键 ──
 *
 * 其余三条计异常轨的轨名都是规则集预算键(有可标定的上限):事件计数 / API 计数 / 内存判罚线。
 * 本轨没有可标定的上限——**任一未被脚本吞掉的 guest 异常本身就已达阈**(脚本自己 `throw`、
 * 引用已删的宿主桥、调未定义的 action、访问未暴露字段),所以它不随预算配置开关,只在
 * `tripped` 观测里露面。它仍走**同一条写入口**:`tripped` → 步 0 的 `count-exception-tick`
 * 变更;观测的 `value` / `limit` 因此都取 `1`(这一次抛异常既是一次读数,也已是阈值本身)。
 */
export const UNCAUGHT_EXCEPTION_TRACK = "uncaughtException";

/**
 * 一次 VM 会话的操作面:`createQuickJsRunner` 是它在 `SeatRunner` 上的适配。
 *
 * 生命周期(`dispose`)归工厂,VM 的**读数与回收**进这两条方法:`runGC` / `memoryUsage` 是宿主
 * 侧的动作,不经过 guest、不改 guest 可见状态。
 */
export type SandboxSession = {
  /** 把这一 tick 的快照交进 guest(经 `__setSnapshot`)。 */
  readonly setSnapshot: (snapshot: Snapshot) => void;
  /** 只调脚本入口 `loop()`,不排 job。 */
  readonly runLoop: () => void;
  /** 把待处理 job 排空到不动点,返回执行数(0 = 干净)。 */
  readonly pumpJobs: () => number;
  /** 经 `__drainIntents()` 取回这一 tick 的意图与 API 调用计数(票 07 的返回载荷加栏)。 */
  readonly drainIntents: () => DrainedGuest;
  /** 开始本 tick 的计数(归零并 arm,记下墙钟起点)。三条轨均未启用时是一次空操作。 */
  readonly beginTick: () => void;
  /** 结束本 tick 的计数(disarm),返回本 tick 的三类读数(见 `TickReadings`)。 */
  readonly endTick: () => TickReadings;
  /** 强制一次垃圾回收。判据读数取在它**之后**(见本模块头注《内存判据》)。 */
  readonly runGC: () => void;
  /** 读 VM 当前的内存占用快照。字段见 `MemoryUsage`;判据用的是 `mallocSize`(存活堆口径)。 */
  readonly memoryUsage: () => MemoryUsage;
  /**
   * 在 guest 里求一段表达式并 dump 回宿主。测试与自检用(不入缝):API 面的名字集合对不对、
   * 有没有 `__*` 残留、某个调用会不会抛。
   */
  readonly probe: (code: string) => unknown;
  /** 释放 VM 与所有保留的 handle。 */
  readonly dispose: () => void;
};

/** `__drainIntents()` 载荷:意图加本 tick 的 API 调用计数(票 07)。 */
export type DrainedGuest = {
  readonly intents: readonly Intent[];
  readonly apiCalls: number;
};

/** 一个 tick 的三类读数:事件计数截停 / 墙钟软限首越读数 / 墙钟硬超时。 */
export type TickReadings = {
  /** 本 tick 是否被控制流事件计数截停。 */
  readonly eventTripped: boolean;
  /** 本 tick 的控制流事件计数读数。 */
  readonly eventCount: number;
  /** 软限本 tick 首次越过的读数(ms);未越过为 `-1`。 */
  readonly softValue: number;
  /** 本 tick 是否被墙钟硬超时截停。 */
  readonly hardTimedOut: boolean;
};

/** 开一次沙箱会话的完整输入。 */
export type QuickJsSessionOptions = QuickJsVmOptions & {
  /** runtime bundle 的 IIFE 源码(由组装层读盘/构建后传入)。 */
  readonly runtimeCode: string;
  /** 参赛脚本源码(单文件自包含,入口名固定 `function loop()`)。 */
  readonly scriptCode: string;
  /** 本 VM 服务哪个座位:经建 VM 时的一次性 setup 载荷灌入,由 guest 的 `getMyIndex()` 读。 */
  readonly seat: PlayerIndex;
  /**
   * 这一局的规则集(`raw`),建 VM 时随一次性 setup 灌进 guest 供判据读射程/造价/携带上限。
   *
   * **缺席即判据降级**:要读规则面的那两条判据(射程/资金)跳过,交回引擎终裁。组装层拿到了
   * 已校验的规则集,【应当】把它传进来;它缺席时脚本仍能跑完对局,只是少了那两条即时反馈。
   */
  readonly ruleset?: Ruleset;
};

/**
 * 开一次会话:建 VM → 灌 setup → 载 runtime → 取桥 handle → 删桥 → 载脚本 → 取入口 handle。
 *
 * 载入期任一步抛异常都在这里把 VM 释放掉再抛出去:半个初始化好的 VM 不该漏出去,
 * 更不该在异常路径上把 `dispose` 变成调用方的义务。
 */
export const openSandbox = async (options: QuickJsSessionOptions): Promise<SandboxSession> => {
  const { vm, counter } = await createSandboxVmWithCounter(options);
  try {
    // 一次性 setup 载荷:座位 + 规则面。**在 runtime 载入之前**先放在 `__setSnapshot` 这个名字下;
    // runtime 载入时把它读进闭包,并立刻把同一个名字换成每 tick 的桥函数。这样不必新增一个只出现
    // 一次的注入名(那会给 tools 的构建面添一处与并行票的耦合),而名字仍由 `HOST_BRIDGE_*` 常量拼出。
    vm.setProp(
      vm.global,
      HOST_BRIDGE_SET_SNAPSHOT,
      vm.hostToHandle({
        seat: options.seat,
        ...(options.ruleset === undefined ? {} : { ruleset: options.ruleset }),
      }),
    );
    vm.evalCode(options.runtimeCode, "<sandbox-runtime>").dispose();

    // 桥在脚本之前取 handle、之后从全局删。名字由 `HOST_BRIDGE_*` 常量拼(见 runner/index.ts)。
    const setSnapshotHandle = vm.global.getProp(HOST_BRIDGE_SET_SNAPSHOT);
    const drainIntentsHandle = vm.global.getProp(HOST_BRIDGE_DRAIN_INTENTS);

    // 删两个桥:脚本执行前把两个 `__*` 全局摘掉。仍以常量为准拼出删除表达式,不手写字面量。
    vm.evalCode(
      `delete globalThis[${JSON.stringify(HOST_BRIDGE_SET_SNAPSHOT)}];` +
        `delete globalThis[${JSON.stringify(HOST_BRIDGE_DRAIN_INTENTS)}];`,
      "<delete-bridges>",
    ).dispose();

    vm.evalCode(options.scriptCode, "<script>").dispose();
    const loopHandle = vm.global.getProp(SCRIPT_ENTRY);

    let disposed = false;
    const dispose = (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      loopHandle.dispose();
      setSnapshotHandle.dispose();
      drainIntentsHandle.dispose();
      vm.dispose();
    };

    return {
      setSnapshot: (snapshot) => {
        // 参数 handle 是**调用方拥有、必须释放**的(`hostToHandle` 交回一个独立 handle,
        // `callFunction` 不会替我们释放参数);只释放返回值会让每 tick 漏掉一份快照连同它引用
        // 的整棵 guest 对象图。`consume` 在 `fn` 返回/抛出后都释放,故参数与返回值各释放一次。
        vm.hostToHandle(snapshot).consume((handle) =>
          vm.callFunction(setSnapshotHandle, vm.undefined, handle).dispose(),
        );
      },
      runLoop: () => {
        vm.callFunction(loopHandle, vm.undefined).dispose();
      },
      pumpJobs: () => vm.executePendingJobs(),
      runGC: () => vm.runGC(),
      memoryUsage: () => vm.getMemoryUsage(),
      probe: (code) => vm.evalCode(code).consume((handle: JSValueHandle) => vm.dump(handle)),
      drainIntents: () =>
        vm
          .callFunction(drainIntentsHandle, vm.undefined)
          .consume((handle: JSValueHandle) => vm.dump(handle)) as DrainedGuest,
      beginTick: () => {
        counter.eventCount = 0;
        counter.eventTripped = false;
        counter.hardTimedOut = false;
        counter.softValue = -1;
        counter.sinceSample = 0;
        // 本 tick 的墙钟起点每 tick 取一次(回调里按抽样读的是与它的**差值**)。
        counter.tickStart = performance.now();
        counter.armed = true;
      },
      endTick: () => {
        counter.armed = false;
        return {
          eventTripped: counter.eventTripped,
          eventCount: counter.eventCount,
          softValue: counter.softValue,
          hardTimedOut: counter.hardTimedOut,
        };
      },
      dispose,
    };
  } catch (error) {
    vm.dispose();
    throw error;
  }
};

/** `createQuickJsRunner` 的输入:在会话输入上加上内存判据的阈值。 */
export type QuickJsRunnerOptions = QuickJsSessionOptions & {
  /**
   * 内存判据的判罚线(bytes,tick 末存活堆读数)。**缺席即本轨不启用**:`loop()` 之外不强制回收、
   * 不产观测、不判负。组装层读键清单的 `calibration.state`,未定值就不传这个字段——引擎不认识
   * 「未定值」这个概念(spec《未定值与预算配置》)。
   */
  readonly memoryTickCeiling?: number;
  /**
   * 软阈系数:软阈 = 该系数 × `memoryTickCeiling`,只发 `memory-pressure` 观测、不判罚。
   * 缺席取真源包的 `MEMORY_SOFT_THRESHOLD_RATIO`。它是**推导项、不是规则集参数键**,这一栏
   * 存在的唯一理由是给组装层一个显式覆写点,不是为了把它变成第二个要标定的数。
   */
  readonly softThresholdRatio?: number;
  /**
   * 单 tick API 调用计数上限(次/tick)。**缺席即本轨不启用**:不比较、不产观测、不判负。
   *
   * 计数**在 guest 侧自增**(hld §4.5),经 `__drainIntents()` 的返回载荷回来;本选项只在宿主
   * 侧做那一次阈值判定。组装层读键清单的 `calibration.state`,未定值就不传这个字段。
   */
  readonly apiCallTickLimit?: number;
};

/** 工厂的交回:缝上的执行器 + 它的释放。**建与释放都归调用方**(组装层)。 */
export type QuickJsRunnerHandle = {
  readonly runner: SeatRunner;
  readonly dispose: () => void;
};

/**
 * 造一个由真 VM 服务的座位执行器。
 *
 * 每 tick 的次序由 `drainIntents` 一次走完:arm 计数与墙钟起点 → `loop()` → 排空到不动点 →
 * (**本轨启用时**)强制回收后读存活堆、组装内存观测 → `__drainIntents()`(带 API 调用计数)
 * → 三条计数轨(事件 / API / 墙钟)各判一次。
 *
 * **硬超时是一例外**:墙钟硬超时中断本 tick 并交回故障位 `uncertain-timeout`,整场作废
 * (不判罚、不累加异常)。事件 / API 两轨超限则只作废**该座位本 tick** 的意图,不中断其它三方与
 * 引擎;guest 未吞掉的异常同路——中止本 tick、计一次异常,同样不中断其它三方与引擎、不重建 VM。
 * 阈值判定不在 guest 侧,guest 吞不吞异常都改不了读数。
 */
export const createQuickJsRunner = async (
  options: QuickJsRunnerOptions,
): Promise<QuickJsRunnerHandle> => {
  const session = await openSandbox(options);
  const eventTickLimit = options.eventTickLimit;
  const apiCallTickLimit = options.apiCallTickLimit;
  const wallClockSoftLimit = options.wallClockSoftLimit;
  const ceiling = options.memoryTickCeiling;
  // 软阈是判罚线的派生量(向下取整到字节),不是独立参数:系数缺席取真源常数。
  const softThreshold =
    ceiling === undefined
      ? undefined
      : Math.floor((options.softThresholdRatio ?? MEMORY_SOFT_THRESHOLD_RATIO) * ceiling);

  const runner: SeatRunner = {
    setSnapshot: session.setSnapshot,
    drainIntents: () => {
      // 计数与墙钟:本 tick 进入时归零并 arm、记下墙钟起点,`loop()` + 排空之后 disarm。
      // 回调只能在构造时装,计数状态住宿主闭包;这里只开合闸门与读回读数。
      session.beginTick();
      let readings: TickReadings;
      // 本 tick 是否有**未被吞掉**的 guest 异常(`loop()` / job 里抛的)。有它即本 tick 计一次异常。
      let uncaught = false;
      try {
        session.runLoop();
        session.pumpJobs();
        readings = session.endTick();
      } catch {
        readings = session.endTick();
        // 「本轨截停 / 硬超时」各有出口(事件轨 / 故障位),不当成 guest 异常;其余的抛出
        // (脚本自己 `throw`、引用已删桥、调未定义 action…)归本 tick 的一次异常计数,不再原样
        // 冒给宿主变成整场 `engine-crash`(hld §5.2 第一行)。
        if (!readings.eventTripped && !readings.hardTimedOut) {
          uncaught = true;
        }
      }
      if (readings.hardTimedOut) {
        // 墙钟硬超时:**作废而非判罚**。中断本 tick、交回故障位;不产观测、不累加异常。
        // VM 不重建(hld §5.2 的注脚);本场由 `runMatch` 标 `uncertain-timeout` 后作废。
        return { intents: [], observations: [], fault: "uncertain-timeout" };
      }
      if (readings.eventTripped) {
        if (eventTickLimit === undefined) {
          // 不可能:未启用本轨时回调恒返回 false,不会 tripped。出现即是引擎缺陷,响亮地失败。
          throw new Error("事件计数被截停但本轨未启用——引擎故障");
        }
        // 事件计数截停:本 tick 该座位意图全部作废(单位原地待命),不排 drain。VM 续用、记忆保留。
        return {
          intents: [],
          observations: [
            {
              kind: "tripped",
              track: EVENT_TRACK,
              value: readings.eventCount,
              limit: eventTickLimit,
            },
          ],
        };
      }
      if (uncaught) {
        // guest 未吞掉的异常:本 tick 该座位 intents 全部作废(单位原地待命),计一次异常。
        // 「中止本 tick」是这条轨的语义:不排 drain、不判内存 / API——故它**不与任何轨叠加**
        // (事件轨同样早退;内存与 API 两条只在脚本正常返回时才可能同 tick 各计一次)。
        // VM 续用、模块级记忆保留(不重建),下一 tick 从原处继续(本 tick 的部分 intent 由下一
        // tick 的 `__setSnapshot` 清空,故不会跨 tick 残留)。
        return {
          intents: [],
          observations: [{ kind: "tripped", track: UNCAUGHT_EXCEPTION_TRACK, value: 1, limit: 1 }],
        };
      }
      const observations: Observation[] = [];
      // 墙钟软限:只披露、不罚。读数落成整数毫秒(观测不参与判罚,取整不改变任何结论)。
      if (wallClockSoftLimit !== undefined && readings.softValue >= 0) {
        observations.push({
          kind: "wall-clock-soft",
          track: WALL_CLOCK_TRACK,
          value: Math.floor(readings.softValue),
          limit: wallClockSoftLimit,
        });
      }
      if (ceiling !== undefined && softThreshold !== undefined) {
        // 读数取在「本 tick 的脚本执行结束处」:排空到不动点之后、`__drainIntents()` 之前,
        // 且必须先强制回收——读的是**存活堆**(`mallocSize`),与分配上限同一记账口径。
        // tick 内瞬时借满后已释放的分配在这里已不可达,因此不判(已接受的残余,不是漏判)。
        session.runGC();
        const value = session.memoryUsage().mallocSize;
        if (value >= ceiling) {
          observations.push({ kind: "tripped", track: MEMORY_TRACK, value, limit: ceiling });
        } else if (value >= softThreshold) {
          observations.push({
            kind: "memory-pressure",
            track: MEMORY_TRACK,
            value,
            limit: softThreshold,
          });
        }
      }
      const drained = session.drainIntents();
      if (apiCallTickLimit !== undefined && drained.apiCalls >= apiCallTickLimit) {
        // API 轰炸:超限只作废该座位本 tick 的意图(单位原地待命),不中断其它三方与引擎。
        // guest 吞不吞异常都一样——计数是宿主 authored 的普通整数,guest 改不了。
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
  return { runner, dispose: session.dispose };
};
