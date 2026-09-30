// M1 中断计数:interruptHandler 触发粒度、回调开销、中断异常语义
// 全部 guest 代码用 IIFE 包裹,避免同一 VM 重复 eval 的全局 let 重声明
import { createVm, ev, getGlobal, errInfo, say, benchNs, us } from './lib.mjs';

// ---- M1.1 触发粒度判别:回调数对什么敏感 ----
const WORKLOADS = {
  // A: 单层循环 N 次迭代(每迭代 1 个回边),轻量体 ~6 opcodes
  light: (n) => `(() => { let x = 0; for (let i = 0; i < ${n}; i++) { x = (x + i) | 0 } globalThis.__x = x })()`,
  // B: 同 N 迭代,循环体 ~3 倍运算(区分"按指令"还是"按控制流事件")
  heavy: (n) => `(() => { let x = 0; for (let i = 0; i < ${n}; i++) { x = (x + i) | 0; x = (x ^ (x >>> 3)) | 0; x = (x + (x << 2)) | 0 } globalThis.__x = x })()`,
  // C: 外×内双层循环(每外迭代 ~11 个回边)
  nested: (n) => `(() => { let x = 0; const a = ${(n / 10) | 0}, b = 10; for (let i = 0; i < a; i++) { for (let j = 0; j < b; j++) { x = (x + j) | 0 } x = (x + i) | 0 } globalThis.__x = x })()`,
  // D: 无回边直线代码(展开 5 万条语句,~15 万 opcodes)
  unrolled: () => `(() => { let x = 0; ${'x = (x + 1) | 0;'.repeat(50_000)} globalThis.__x = x })()`,
  // E: 树形递归:2^22 ≈ 419 万次调用 + 同量返回,零回边
  tree: (n) => `(() => { function f(n) { if (n) { f(n - 1); f(n - 1) } return 0 } globalThis.__x = f(${n}) })()`,
};

async function countCallbacks(code) {
  let calls = 0;
  const vm = await createVm({ interruptHandler: () => { calls++; return false; } });
  ev(vm, code);
  vm.dispose();
  return calls;
}

const cLight200 = await countCallbacks(WORKLOADS.light(200_000));
const cLight1200 = await countCallbacks(WORKLOADS.light(1_200_000));
const cHeavy200 = await countCallbacks(WORKLOADS.heavy(200_000));
const cHeavy1200 = await countCallbacks(WORKLOADS.heavy(1_200_000));
const cNested = await countCallbacks(WORKLOADS.nested(1_200_000));
const cUnrolled = await countCallbacks(WORKLOADS.unrolled());
const cTree18 = await countCallbacks(WORKLOADS.tree(18));
const cTree22 = await countCallbacks(WORKLOADS.tree(22));
say('M1.1.rawCalls', { light200k: cLight200, light1200k: cLight1200, heavy200k: cHeavy200, heavy1200k: cHeavy1200, nested1200k: cNested, unrolled50kStmts: cUnrolled, tree2pow18: cTree18, tree2pow22: cTree22 });
say('M1.1.light.itersPerCb', (1_000_000 / (cLight1200 - cLight200)).toFixed(2));
say('M1.1.heavy.itersPerCb', (1_000_000 / (cHeavy1200 - cHeavy200)).toFixed(2));
say('M1.1.nested.backedgesPerCb', ((1.2e6 + 1.2e5) / cNested).toFixed(2));
say('M1.1.tree.callsPerCb.n18', (2 ** 18 / cTree18).toFixed(2));
say('M1.1.tree.callsPerCb.n22', (2 ** 22 / cTree22).toFixed(2));
say('M1.1.unrolled.callbacksPer150kOpcodes', cUnrolled);

// ---- M1.2 回调开销:两种回边密度 workload × handler 实现,轮转交错跑以抵消漂移 ----
const DENSE = `(() => { let x = 0; for (let i = 0; i < 10000; i++) { for (let j = 0; j < 5000; j++) { x = (x + j) | 0 } } globalThis.__x = x })()`;
// SPARSE: 同 ~50M 语句执行,仅 5 万回边(~10 次回调);与 DENSE 联立可分解"每次回调"与"每个回边"的开销
const SPARSE = `(() => { let x = 0; for (let i = 0; i < 50000; i++) { ${'x = (x + i) | 0;'.repeat(1000)} } globalThis.__x = x })()`;
{
  const counters = { empty: 0, count: 0, wallclock: 0, 'sparse-empty': 0 };
  const CONFIGS = [
    { key: 'dense.none', code: DENSE, opts: {} },
    { key: 'dense.empty', code: DENSE, opts: () => ({ interruptHandler: () => false }) },
    { key: 'dense.count', code: DENSE, opts: () => ({ interruptHandler: () => { counters.count++; return false; } }) },
    { key: 'dense.wallclock', code: DENSE, opts: () => ({ interruptHandler: () => { void Date.now(); return false; } }) },
    { key: 'sparse.none', code: SPARSE, opts: {} },
    { key: 'sparse.empty', code: SPARSE, opts: () => ({ interruptHandler: () => { counters['sparse-empty']++; return false; } }) },
  ];
  const times = Object.fromEntries(CONFIGS.map((c) => [c.key, []]));
  const vms = [];
  for (const c of CONFIGS) vms.push(await createVm(typeof c.opts === 'function' ? c.opts() : c.opts));
  const ROUNDS = 4;
  for (let r = 0; r < ROUNDS; r++) {
    for (let k = 0; k < CONFIGS.length; k++) {
      const c = CONFIGS[(k + r) % CONFIGS.length]; // 轮转抵消热漂移
      const t0 = process.hrtime.bigint();
      ev(vms[CONFIGS.indexOf(c)], c.code);
      times[c.key].push(Number(process.hrtime.bigint() - t0) / 1000);
    }
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const M = Object.fromEntries(Object.entries(times).map(([k, v]) => [k, med(v)]));
  say('M1.2.perRunUs', Object.fromEntries(Object.entries(M).map(([k, v]) => [k, us(v * 1000)])));
  say('M1.2.rawUs', times);
  const cbDense = counters.count / ROUNDS; // 每趟回调数(计数器含 warmup 前的 eval — 此处无 warmup)
  say('M1.2.callbacksPerRun.dense', cbDense);
  say('M1.2.callbacksPerRun.sparse', counters['sparse-empty'] / ROUNDS);
  say('M1.2.slowdownVsNone', { empty: (M['dense.empty'] / M['dense.none']).toFixed(3) + 'x', count: (M['dense.count'] / M['dense.none']).toFixed(3) + 'x', wallclock: (M['dense.wallclock'] / M['dense.none']).toFixed(3) + 'x', sparseEmpty: (M['sparse.empty'] / M['sparse.none']).toFixed(3) + 'x' });
  // 分解:delta = 回边数 × C_edge + 回调数 × C_cb
  const dS = M['sparse.empty'] - M['sparse.none'];
  const dD = M['dense.empty'] - M['dense.none'];
  const C_edge = dS / 50_000; // sparse 回调仅 ~10 次,忽略
  const C_cb = (dD - 50_000_000 * C_edge) / cbDense;
  say('M1.2.decomposed', { perBackedgeUs: (C_edge / 1000).toFixed(4) + 'µs', perCallbackUs: (C_cb / 1000).toFixed(3) + 'µs', wallclockBodyExtraUs: ((M['dense.wallclock'] - M['dense.count']) / cbDense / 1000).toFixed(3) + 'µs' });
  for (const vm of vms) vm.dispose();
}

// ---- M1.3 中断异常语义:guest 可捕获性 + VM 续用 ----
{
  let calls = 0, fired = false;
  const vm = await createVm({ interruptHandler: () => { calls++; if (calls >= 500 && !fired) { fired = true; return true; } return false; } });
  let hostErr = null;
  try {
    ev(vm, `(() => {
      globalThis.__m1 = 1;
      try { let i = 0; while (true) { i++; } } catch (e) { globalThis.__mc = 'CAUGHT:' + e.name + '|' + e.message; }
      globalThis.__m3 = 1;
    })()`);
  } catch (e) { hostErr = errInfo(e); }
  say('M1.3.hostErrOnInterrupt', hostErr);
  say('M1.3.guestMarkers', { beforeLoop: getGlobal(vm, '__m1'), catchRan: getGlobal(vm, '__mc') ?? 'NO (吞不掉)', afterLoop: getGlobal(vm, '__m3') ?? 'NO' });
  say('M1.3.vmUsableAfterInterrupt', ev(vm, '1 + 2') === 3);
  // 锁存 handler:到限后永久 true(与一次性对照,确认有无逃逸差异)
  let calls2 = 0;
  const vm2 = await createVm({ interruptHandler: () => { calls2++; return calls2 >= 500; } });
  let hostErr2 = null;
  try {
    ev(vm2, `(() => {
      globalThis.__n1 = 1;
      try { let i = 0; while (true) { i++; } } catch (e) { globalThis.__nc = 'CAUGHT:' + e.name; }
      globalThis.__n3 = 1;
    })()`);
  } catch (e) { hostErr2 = errInfo(e); }
  say('M1.3.latchedHandler', { hostErr: hostErr2, beforeLoop: getGlobal(vm2, '__n1'), catchRan: getGlobal(vm2, '__nc') ?? 'NO (吞不掉)', afterLoop: getGlobal(vm2, '__n3') ?? 'NO' });
  say('M1.3.vmUsableAfterLatchedInterrupt', ev(vm2, '1 + 2') === 3);
  vm2.dispose();
}
