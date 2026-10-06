/**
 * 五条沙箱行为探针的公共手段:装 VM、求值、读异常。
 *
 * 这一层刻意**不 import 引擎**(`packages/engine/**`):探针直接驱动 `quickjs-wasi` 的 VM,
 * 断言的是 hld §5.0 那五条**关于运行时本身**的行为,而不是引擎的任何内部结构。因此引擎内部重构
 * (缝怎么改、载荷怎么加栏)不会让探针变红;反过来,探针红了就说明运行时行为真的变了。
 *
 * 用根 `node_modules` 里那份 `quickjs-wasi@3.6.2`(`constants.ts` 记着版本),wasm 字节从
 * 包的 `quickjs.wasm` 子路径导出解析——`WebAssembly.compile` 一次,所有 VM 复用同一个 Module。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { QuickJS } from "quickjs-wasi";

const require = createRequire(import.meta.url);

const wasmPath = require.resolve("quickjs-wasi/quickjs.wasm");

let compiled: WebAssembly.Module | undefined;

/** 载入并缓存预编译的 wasm Module(四 VM 复用同一份,与 hld §5.1 的实际形态一致)。 */
export const loadWasmModule = async (): Promise<WebAssembly.Module> => {
  if (compiled === undefined) {
    compiled = await WebAssembly.compile(readFileSync(wasmPath));
  }
  return compiled;
};

/** host 侧异常的可比对描述;`isJSException` 的判据与 hld §5.0 表里那条一字不差。 */
export type ErrInfo = {
  readonly ctor: string;
  readonly name: string;
  readonly message: string;
  readonly isJSException: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * 读出一个 host 侧异常的关键字段并**释放它的 handle**。
 *
 * `isJSException: typeof e?.dispose === "function"` 正是 hld §5.0 结论 ② 的判据:
 * 深递归栈溢出是 host 侧 `RangeError`(没有 `dispose`),而中断与内存超限是 `JSException`
 * (有 `dispose`)——两者的分界就在这一个布尔上。
 */
/**
 * 把一个 `unknown` 落成可读文本。**不对 `unknown` 直接 `String()`**——那会把对象打印成
 * `[object Object]`(lint 的 `no-base-to-string` 正是拦这个)。字符串原样返回,原始值直接转,
 * 其余走 `JSON.stringify`。
 */
const textOf = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value) ?? "";
};

export const errInfo = (error: unknown): ErrInfo => {
  const name = isRecord(error) && typeof error["name"] === "string" ? error["name"] : "";
  const message = textOf((isRecord(error) ? error["message"] : error) ?? error);
  const ctor =
    isRecord(error) && isRecord(error["constructor"]) ? textOf(error["constructor"]["name"]) : "";
  const dispose = isRecord(error) ? error["dispose"] : undefined;
  const info: ErrInfo = {
    ctor: ctor === "" ? textOf(error) : ctor,
    name,
    message: message.slice(0, 200),
    isJSException: typeof dispose === "function",
  };
  if (typeof dispose === "function") {
    try {
      (dispose as () => void)();
    } catch {
      // 释放失败不影响已读出的信息;探针断言的是异常形态,不是回收本身。
    }
  }
  return info;
};

/** 一次求值的结果:成功带值,失败带异常描述。 */
export type EvalOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: ErrInfo };

/** 求值并 dump(自动释放 handle);guest 抛异常时 host 侧收 `JSException`。 */
export const tryEval = (vm: QuickJS, code: string, filename = "<probe>"): EvalOutcome => {
  try {
    const value = vm.evalCode(code, filename).consume((handle) => vm.dump(handle));
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: errInfo(error) };
  }
};

/** 求值并断言不抛;抛了就把异常原样传出去,让探针自己报。 */
export const evalValue = (vm: QuickJS, code: string, filename = "<probe>"): unknown => {
  const outcome = tryEval(vm, code, filename);
  if (!outcome.ok) {
    throw new Error(`求值 ${filename} 意外抛异常:${outcome.error.name}: ${outcome.error.message}`);
  }
  return outcome.value;
};
