// M6 跨边界开销:A 载荷型桥(__setSnapshot/__drainIntents 型)vs B 逐函数注入型
import { createVm, ev, say, benchNs, us, guestFn } from './lib.mjs';

const vm = await createVm({});
let snapshotBytes = 0, drainBytes = 0, apiCalls = 0;
// A 型桥:host 函数吞入 guest 字符串(记录长度即返回)
const setSnapshot = vm.newFunction('__setSnapshot', (s) => { snapshotBytes += s.toString().length; return vm.undefined; });
const drainIntents = vm.newFunction('__drainIntents', (s) => { drainBytes += s.toString().length; return vm.undefined; });
vm.setProp(vm.global, '__setSnapshot', setSnapshot);
vm.setProp(vm.global, '__drainIntents', drainIntents);
// B 型:逐函数注入的小查询
const apiQ = vm.newFunction('api_q', (h) => { apiCalls++; return vm.newNumber(h.toNumber() * 2); });
vm.setProp(vm.global, 'api_q', apiQ);

ev(vm, `(() => {
  globalThis.gq = function (i) { return i * 2 };           // guest 内部纯函数(对照)
  globalThis.tick0 = function () { let x = 1; return x };  // 空 tick:纯 callFunction 蹦床
  globalThis.tickA = function (snap, drain) { __setSnapshot(snap); __drainIntents(drain); return 0 };
  globalThis.tickB = function (k) { let s = 0; for (let i = 0; i < k; i++) s += api_q(i); return s };
  globalThis.tickBg = function (k) { let s = 0; for (let i = 0; i < k; i++) s += gq(i); return s };
  globalThis.tickRet = function (snap) { return JSON.stringify([1, 2, 3, snap.length]) };
})()`);
const fns = {};
for (const n of ['tick0', 'tickA', 'tickB', 'tickBg', 'tickRet']) fns[n] = vm.global.getProp(n);

const call = (fn, ...args) => vm.callFunction(fn, vm.undefined, ...args).consume(() => {});
const callRet = (fn, ...args) => vm.callFunction(fn, vm.undefined, ...args).consume((h) => h.toString());

// ---- M6.1 基线:callFunction 空 tick 蹦床 ----
const base = benchNs(() => call(fns.tick0), { reps: 5, iters: 2000 });
say('M6.1.emptyTickTrampoline', us(base.median));

// ---- M6.2 A 型:载荷型双桥,快照粒度 × intents 粒度 ----
const SNAP_SIZES = [1, 16, 64]; // KB
const DRAIN_COUNTS = [0, 10, 100];
const snapCache = Object.fromEntries(SNAP_SIZES.map((kb) => [kb, 'x'.repeat(kb * 1024)]));
const drainCache = Object.fromEntries(DRAIN_COUNTS.map((d) => [d, JSON.stringify(Array.from({ length: d }, (_, i) => ({ type: 'move', unit: i, x: i, y: i, target: i }))) ]));
for (const kb of SNAP_SIZES) {
  for (const d of DRAIN_COUNTS) {
    const snapH = vm.newString(snapCache[kb]);
    const drainH = vm.newString(drainCache[d]);
    const r = benchNs(() => call(fns.tickA, snapH, drainH), { reps: 5, iters: 200 });
    say(`M6.2.A.tickUs.snap${kb}KB.drain${d}`, us(r.median));
    snapH.dispose(); drainH.dispose();
  }
}
// 快照作为 callFunction 返回值/参数往返(带解析形态的粗对照)
{
  const snapH = vm.newString(snapCache[16]);
  const r = benchNs(() => callRet(fns.tickRet, snapH), { reps: 5, iters: 2000 });
  say('M6.2.A.stringArgReturnRoundtrip16KBArg', us(r.median));
  snapH.dispose();
}

// ---- M6.3 B 型:逐函数注入 × 调用密度;对照 guest 纯函数 ----
for (const k of [1, 10, 100, 1000, 10000]) {
  const iters = Math.max(2, Math.min(2000, Math.floor(200_000 / k)));
  const kH = vm.newNumber(k);
  const rB = benchNs(() => call(fns.tickB, kH), { reps: 5, iters });
  const rG = benchNs(() => call(fns.tickBg, kH), { reps: 5, iters });
  kH.dispose();
  const perCallB = (rB.median - base.median) / k;
  const perCallG = (rG.median - base.median) / k;
  say(`M6.3.B.k${k}`, { tickUs: us(rB.median), guestFnTickUs: us(rG.median), perHostCallUs: us(perCallB - perCallG) });
}

for (const fn of Object.values(fns)) fn.dispose();
vm.dispose();
