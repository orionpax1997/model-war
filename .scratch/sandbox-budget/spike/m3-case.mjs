// M3 worker:单个失控用例在独立子进程跑(trap 可能拖垮进程 — 拖垮本身就是数据)
// 用法:node m3-case.mjs <case>
import { createVm, ev, getGlobal, errInfo, hr, us, QuickJS, wasmModule, guestFn } from './lib.mjs';

const kase = process.argv[2];
const out = {};

async function probeReuse(vm) {
  try { return { eval: ev(vm, '1 + 2'), pendingJobs: vm.executePendingJobs(), mem: !!vm.getMemoryUsage() }; }
  catch (e) { return { error: errInfo(e) }; }
}

async function deepCase(opts) {
  const vm = await createVm(opts);
  let hostErr = null;
  const t0 = hr();
  try {
    ev(vm, `(() => {
      globalThis.__c = null;
      function f(n) { return f(n + 1) }
      try { f(0) } catch (e) { globalThis.__c = e.name + '|' + e.message; }
      globalThis.__after = 1;
    })()`);
  } catch (e) { hostErr = errInfo(e); }
  out.recursionMs = (Number(hr() - t0) / 1e6).toFixed(0);
  out.hostErr = hostErr;
  out.guestCaught = getGlobal(vm, '__c') ?? 'NO (吞不掉)';
  out.guestContinued = getGlobal(vm, '__after') ?? 'NO';
  out.reuse = await probeReuse(vm);
  try { vm.dispose(); } catch {}
  return out;
}

async function rebuildCase() {
  // 合成 runtime bundle(~20KB)与选手脚本(~5KB),量化重建(重载脚本)代价
  const runtimeSrc = 'globalThis.__rt = {};\n' + Array.from({ length: 200 }, (_, i) =>
    `function helper${i}(a, b) { let x = a + b; for (let i = 0; i < 10; i++) x = (x + i) | 0; return x }`).join('\n');
  const scriptSrc = Array.from({ length: 50 }, (_, i) =>
    `function tactic${i}(a) { return a * ${i} }`).join('\n') + '\nfunction loop() { return 1 }';
  const samples = { create: [], evalRt: [], evalScript: [], firstCall: [], bytecodeVariant: [] };
  const R = 15;
  for (let r = 0; r < R; r++) {
    let t0 = hr();
    const vm = await QuickJS.create({ wasm: wasmModule });
    samples.create.push(Number(hr() - t0) / 1000);
    t0 = hr();
    vm.evalCode(runtimeSrc, 'runtime.js').dispose();
    samples.evalRt.push(Number(hr() - t0) / 1000);
    t0 = hr();
    vm.evalCode(scriptSrc, 'script.js').dispose();
    samples.evalScript.push(Number(hr() - t0) / 1000);
    const loop = vm.global.getProp('loop');
    t0 = hr();
    vm.callFunction(loop, vm.undefined).dispose();
    samples.firstCall.push(Number(hr() - t0) / 1000);
    loop.dispose();
    vm.dispose();
  }
  // 字节码缓存变体:compile 一次(不计时),重建时只 evalBytecode
  const scratch = await QuickJS.create({ wasm: wasmModule });
  const rtBc = scratch.compile(runtimeSrc, 'runtime.js');
  const scBc = scratch.compile(scriptSrc, 'script.js');
  scratch.dispose();
  for (let r = 0; r < R; r++) {
    const t0 = hr();
    const vm = await QuickJS.create({ wasm: wasmModule });
    vm.evalBytecode(rtBc).dispose();
    vm.evalBytecode(scBc).dispose();
    const loop = vm.global.getProp('loop');
    vm.callFunction(loop, vm.undefined).dispose();
    loop.dispose();
    vm.dispose();
    samples.bytecodeVariant.push(Number(hr() - t0) / 1000);
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const fmt = (v) => (v / 1000).toFixed(2) + 'ms';
  out.medianUs = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, fmt(med(v))]));
  out.totalSourceVariant = fmt(med(samples.create) + med(samples.evalRt) + med(samples.evalScript) + med(samples.firstCall));
  out.totalBytecodeVariant = fmt(med(samples.bytecodeVariant));
  out.runtimeKb = Math.round(runtimeSrc.length / 1024);
  out.scriptKb = Math.round(scriptSrc.length / 1024);
  return out;
}

switch (kase) {
  case 'deep-default': await deepCase({}); break;
  case 'deep-guard-off': await deepCase({ maxStackSize: 0 }); break;
  case 'deep-max-stack': await deepCase({ maxStackSize: 512 * 1024 }); break;
  case 'loop-nointerrupt': {
    const vm = await createVm({});
    ev(vm, '(() => { while (true) {} })()'); // 不应返回 — 由编排进程杀
    out.unexpected = 'returned';
    break;
  }
  case 'rebuild': await rebuildCase(); break;
  default: out.error = 'unknown case ' + kase;
}
console.log('RESULT: ' + JSON.stringify(out));
