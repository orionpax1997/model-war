/**
 * `QuickJsRunner`:执行器缝的**真实沙箱**适配器(票 03 的第一枚 tracer bullet)。
 *
 * ── 缝不变:仍然恰好两个方法 ──
 *
 * 建 VM、铺注入面、**删桥**、注入座位、释放——全部发生在**工厂**里,不在 `SeatRunner` 上。
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
 * 读钟;时区是构造选项 `timezoneOffset`。三者只能建 VM 时定一次,所以它们不是对局参数,而是
 * 工程常量——同一份脚本因此在对局内、跨 VM、跨重跑三个维度上得到同一序列。
 *
 * ── 载入次序与删桥 ──
 *
 * `evalCode(runtimeCode)` 建 API 面 → 取两个桥的函数 handle → 从全局**删掉**它们 →
 * 注入按座位的 `getMyIndex` → `evalCode(scriptCode)` 载入脚本(入口名固定 `function loop()`)。
 * 每 tick:`__setSnapshot(snapshot)` → `loop()` → `executePendingJobs()` 排空到不动点 →
 * `__drainIntents()`。删桥的断言是「脚本按 `__` 前缀枚举为空」,而宿主仍能经函数 handle 调桥。
 *
 * ── 排空到不动点为什么必须在 drain 之前 ──
 *
 * 单 tick 是同步的,但脚本可以用 `Promise.resolve().then(…)` 把一条意图推迟到一个 job 里。
 * 不排空,这条意图就会留到下一 tick 才被交回——**意图跨 tick 残留**。`runLoop` 与
 * `pumpJobs` 分成两步暴露(而非在 `drainIntents` 里一把梭),正是为了给这条反例留一个
 * 能弄红的入口:见 `quickjs.test.ts`。
 */

import { QuickJS, type JSValueHandle } from "quickjs-wasi";

import type { Intent } from "../processor/intents.js";
import type { PlayerIndex, Snapshot } from "../world/state.js";
import { HOST_BRIDGE_DRAIN_INTENTS, HOST_BRIDGE_SET_SNAPSHOT, type SeatRunner } from "./index.js";

/** 冻钟的固定读数:十进制毫秒。三件套之一,取值是工程常量(见 spec《WASI 三件套与回放 meta》)。 */
export const WASI_CLOCK_MS = 1_700_000_000_000;

/** 时区偏移:十进制分钟(UTC = 0)。三件套之一。`Date` 与 `getTimezoneOffset()` 由它决定。 */
export const WASI_TIMEZONE_OFFSET_MINUTES = 0;

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
};

/** 建一个被三件套钉住的 VM。**只有本模块用**;测试也经它拿到真实配置(见 `quickjs.test.ts`)。 */
export const createSandboxVm = (options: QuickJsVmOptions): Promise<QuickJS> => {
  const clockMs = options.clockMs ?? WASI_CLOCK_MS;
  return QuickJS.create({
    wasm: options.wasm,
    timezoneOffset: options.timezoneOffsetMinutes ?? WASI_TIMEZONE_OFFSET_MINUTES,
    ...(options.memoryLimit === undefined ? {} : { memoryLimit: options.memoryLimit }),
    // 冻钟:覆盖 `clock_time_get`,写回固定纳秒值。`Math.random()` 的 xorshift 种子就取自这里,
    // 所以「冻钟」同时钉住了随机源——三件套里的两件是同一件事的两面。
    wasi: (memory: WebAssembly.Memory) => ({
      clock_time_get: (_clockId: number, _precision: number, resultPtr: number): number => {
        new DataView(memory.buffer).setBigUint64(resultPtr, BigInt(clockMs) * 1_000_000n, true);
        return 0;
      },
    }),
  });
};

/** 一次 VM 会话的操作面:`createQuickJsRunner` 是它在 `SeatRunner` 上的适配。 */
export type SandboxSession = {
  /** 把这一 tick 的快照交进 guest(经 `__setSnapshot`)。 */
  readonly setSnapshot: (snapshot: Snapshot) => void;
  /** 只调脚本入口 `loop()`,不排 job。 */
  readonly runLoop: () => void;
  /** 把待处理 job 排空到不动点,返回执行数(0 = 干净)。 */
  readonly pumpJobs: () => number;
  /** 经 `__drainIntents()` 取回这一 tick 的意图。 */
  readonly drainIntents: () => readonly Intent[];
  /** 释放 VM 与所有保留的 handle。 */
  readonly dispose: () => void;
};

/** 开一次沙箱会话的完整输入。 */
export type QuickJsSessionOptions = QuickJsVmOptions & {
  /** runtime bundle 的 IIFE 源码(由组装层读盘/构建后传入)。 */
  readonly runtimeCode: string;
  /** 参赛脚本源码(单文件自包含,入口名固定 `function loop()`)。 */
  readonly scriptCode: string;
  /** 本 VM 服务哪个座位:`getMyIndex()` 按它注入常量函数。 */
  readonly seat: PlayerIndex;
};

/**
 * 开一次会话:建 VM → 载 runtime → 取桥 handle → 删桥 → 注入座位 → 载脚本 → 取入口 handle。
 *
 * 载入期任一步抛异常都在这里把 VM 释放掉再抛出去:半个初始化好的 VM 不该漏出去,
 * 更不该在异常路径上把 `dispose` 变成调用方的义务。
 */
export const openSandbox = async (options: QuickJsSessionOptions): Promise<SandboxSession> => {
  const vm = await createSandboxVm(options);
  try {
    vm.evalCode(options.runtimeCode, "<sandbox-runtime>").dispose();

    // 桥在脚本之前取 handle、之后从全局删。名字由 `HOST_BRIDGE_*` 常量拼(见 runner/index.ts)。
    const setSnapshotHandle = vm.global.getProp(HOST_BRIDGE_SET_SNAPSHOT);
    const drainIntentsHandle = vm.global.getProp(HOST_BRIDGE_DRAIN_INTENTS);

    // 删桥:脚本执行前把两个 `__*` 全局摘掉。仍以常量为准拼出删除表达式,不手写字面量。
    vm.evalCode(
      `delete globalThis[${JSON.stringify(HOST_BRIDGE_SET_SNAPSHOT)}];` +
        `delete globalThis[${JSON.stringify(HOST_BRIDGE_DRAIN_INTENTS)}];`,
      "<delete-bridges>",
    ).dispose();

    // 座位自认按座位注入常量函数(runtime 是同一串字节,座位只能由宿主绑)。
    const seatFn = vm.newFunction("getMyIndex", () => vm.newNumber(options.seat));
    vm.setProp(vm.global, "getMyIndex", seatFn);
    seatFn.dispose();

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
        vm.callFunction(setSnapshotHandle, vm.undefined, vm.hostToHandle(snapshot)).dispose();
      },
      runLoop: () => {
        vm.callFunction(loopHandle, vm.undefined).dispose();
      },
      pumpJobs: () => vm.executePendingJobs(),
      drainIntents: () =>
        vm
          .callFunction(drainIntentsHandle, vm.undefined)
          .consume((handle: JSValueHandle) => vm.dump(handle)) as readonly Intent[],
      dispose,
    };
  } catch (error) {
    vm.dispose();
    throw error;
  }
};

/** `createQuickJsRunner` 的输入:在会话输入上原样透传。 */
export type QuickJsRunnerOptions = QuickJsSessionOptions;

/** 工厂的交回:缝上的执行器 + 它的释放。**建与释放都归调用方**(组装层)。 */
export type QuickJsRunnerHandle = {
  readonly runner: SeatRunner;
  readonly dispose: () => void;
};

/**
 * 造一个由真 VM 服务的座位执行器。
 *
 * 每 tick 的次序由 `drainIntents` 一次走完:`loop()` → 排空到不动点 → `__drainIntents()`。
 * 本票没有观测事实可报,`observations` 恒为空数组(观测通道归票 09)。
 */
export const createQuickJsRunner = async (
  options: QuickJsRunnerOptions,
): Promise<QuickJsRunnerHandle> => {
  const session = await openSandbox(options);
  const runner: SeatRunner = {
    setSnapshot: session.setSnapshot,
    drainIntents: () => {
      session.runLoop();
      session.pumpJobs();
      return { intents: session.drainIntents(), observations: [] };
    },
  };
  return { runner, dispose: session.dispose };
};
