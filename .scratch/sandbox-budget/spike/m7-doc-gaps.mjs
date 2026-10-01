// M7 文档未承诺项补测(票「quickjs-wasi 语义核查」的可直接测部分):
// moduleLoader 缺省行为、默认全局面、.so 扩展未加载的实际空缺
import { createVm, ev, errInfo, say, QuickJS } from './lib.mjs';

void QuickJS;
const vm = await createVm({});

// ---- M7.1 全局面盘点(不加载 .so 时) ----
const PRESENCE = ['URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Headers', 'Request', 'Response',
  'crypto', 'structuredClone', 'fetch', 'require', 'process', 'console', 'setTimeout', 'setInterval',
  'queueMicrotask', 'eval', 'Date', 'Math', 'Promise', 'Proxy', 'WeakRef', 'Atomics', 'SharedArrayBuffer',
  'WebAssembly', 'Intl', 'performance'];
const presence = ev(vm, `JSON.stringify({ ${PRESENCE.map((n) => `${n}: typeof ${n}`).join(', ')} })`);
say('M7.1.globals', presence);
say('M7.1.dateTzDefault', ev(vm, 'new Date().getTimezoneOffset()'));
say('M7.1.evalWorks', ev(vm, 'eval("1 + 1")'));

// ---- M7.2 moduleLoader 缺省:import 的实际报错 ----
for (const [name, code, flags] of [
  ['staticImport', 'import x from "std"; x', undefined],
  ['dynamicImport', 'import("std")', undefined],
  ['importMeta', 'import.meta', undefined],
]) {
  let r = null;
  try { r = ev(vm, code, `<${name}>`); } catch (e) { r = 'ERR ' + JSON.stringify(errInfo(e)); }
  say(`M7.2.${name}`, r ?? 'returned');
}
// 模块模式缺 loader
{
  const { EvalFlags } = await import('quickjs-wasi');
  let r = null;
  try {
    const h = vm.evalCode('export const a = 1', 'mod.js', EvalFlags.TYPE_MODULE);
    vm.executePendingJobs();
    r = 'returned promise handle: ' + vm.typeof(h);
    h.dispose();
  } catch (e) { r = 'ERR ' + JSON.stringify(errInfo(e)); }
  say('M7.2.moduleModeNoLoader', r);
}

// ---- M7.3 语法错误后 VM 续用 ----
{
  let r = null;
  try { ev(vm, 'function ('); } catch (e) { r = errInfo(e); }
  say('M7.3.syntaxError', r);
  say('M7.3.vmUsableAfterSyntaxError', ev(vm, '2 + 2') === 4);
}
vm.dispose();
