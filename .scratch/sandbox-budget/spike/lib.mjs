// spike 公共工具(throwaway,不进 packages/)
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { QuickJS } from 'quickjs-wasi';

export { QuickJS };

const wasmPath = fileURLToPath(import.meta.resolve('quickjs-wasi/quickjs.wasm'));
export const wasmBytes = await readFile(wasmPath);
// 预编译,四 VM 复用同一 WebAssembly.Module(hld §5.1 的实际形态)
export const wasmModule = await WebAssembly.compile(wasmBytes);

export async function createVm(opts = {}) {
  return QuickJS.create({ wasm: wasmModule, ...opts });
}

/** 求值并 dump 结果(自动释放 handle)。guest 抛异常时 host 侧抛 JSException。 */
export function ev(vm, code, filename = '<spike>') {
  return vm.evalCode(code, filename).consume((h) => vm.dump(h));
}

/** 取 guest 全局变量 dump(注意:vm.getProp 的 key 必须是 handle,字符串键会静默失败)。 */
export function getGlobal(vm, name) {
  return vm.global.getProp(name).consume((h) => vm.dump(h));
}

/** host 侧异常的可比对描述。 */
export function errInfo(e) {
  const info = {
    ctor: e?.constructor?.name ?? String(e),
    name: e?.name ?? null,
    message: String(e?.message ?? e).slice(0, 200),
    isJSException: typeof e?.dispose === 'function',
  };
  try { if (typeof e?.dispose === 'function') e.dispose(); } catch {}
  return info;
}

export function say(key, value) {
  console.log(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

export function hr() { return process.hrtime.bigint(); }
export function usSince(t0) { return Number(hr() - t0) / 1000; }

/** 跑 reps 轮取中位数,返回每次 fn() 的耗时(ns)。 */
export function benchNs(fn, { reps = 5, iters = 1, warmup = 1 } = {}) {
  for (let i = 0; i < warmup; i++) fn();
  const times = [];
  for (let r = 0; r < reps; r++) {
    const t0 = hr();
    for (let i = 0; i < iters; i++) fn();
    times.push(Number(hr() - t0) / iters);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)], min: times[0] };
}

export const us = (ns) => `${(ns / 1000).toFixed(3)}µs`;

/** 造一个 guest 函数 handle:(function name(args){ body }) */
export function guestFn(vm, name, args, body) {
  return vm.evalCode(`(function ${name}(${args}) { ${body} })`, `<fn:${name}>`);
}
