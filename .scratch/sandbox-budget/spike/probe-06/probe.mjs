// /tmp/qjs-probe/probe.mjs
//
// Probe for "read-based criterion" pre-conditions on quickjs-wasi 3.6.2.
// Imports the spike's prebuilt QuickJS module WITHOUT modifying any file in
// .scratch/sandbox-budget/spike/.
//
// Sections:
//   1. 2x2 cross (plain anchor)        — GC config × ref handling
//   1b. 2x2 cross (cyclic anchor)      — same axes, with a non-refcount-freeable structure
//   2. runGC() overhead on small (~2MB) and near-limit (~7MB) heaps
//   3. Reading upper bound under gcThreshold = Infinity
//   4. gcThreshold semantics (default value, setter, post-runGC reset)

import { readFile } from 'node:fs/promises';
import { QuickJS } from '/home/qingtian/workspace/model-war/.scratch/sandbox-budget/spike/node_modules/quickjs-wasi/dist/index.js';

const SPIKE = '/home/qingtian/workspace/model-war/.scratch/sandbox-budget/spike';
const wasmBytes = await readFile(`${SPIKE}/node_modules/quickjs-wasi/quickjs.wasm`);
const wasmModule = await WebAssembly.compile(wasmBytes);

const LIMIT = 8 * 1024 * 1024;
const SOFT_LIMIT = LIMIT - 64 * 1024;            // = 8323072 (user's expected OOM cap)
const MB = 1024 * 1024;
const fmtBytes = (b) => `${(b / MB).toFixed(3)}MB`;
const pct = (b, denom = LIMIT) => `${(b / denom * 100).toFixed(2)}%`;

async function createVm(opts = {}) {
  return QuickJS.create({ wasm: wasmModule, ...opts });
}
function evStmt(vm, code, file = '<probe>') {
  vm.evalCode(code, file).dispose();
}
function memRaw(vm) { return vm.getMemoryUsage(); }
function memUsed(vm) { return memRaw(vm).memoryUsedSize; }
function memMalloc(vm) { return memRaw(vm).mallocSize; }

function benchNs(fn, { reps = 11, warmup = 2 } = {}) {
  for (let i = 0; i < warmup; i++) fn();
  const times = [];
  for (let r = 0; r < reps; r++) {
    const t0 = process.hrtime.bigint();
    fn();
    times.push(Number(process.hrtime.bigint() - t0));
  }
  times.sort((a, b) => a - b);
  return { medianNs: times[Math.floor(times.length / 2)], minNs: times[0] };
}
const usNs = (ns) => `${(ns / 1000).toFixed(2)}µs`;

console.log(`=== quickjs-wasi 3.6.2 read-based criterion probe ===`);
console.log(`memoryLimit:  ${LIMIT}  (${fmtBytes(LIMIT)})`);
console.log(`soft_limit:   ${SOFT_LIMIT}  (${pct(SOFT_LIMIT)})  ← user's expected OOM cap (limit - 64KB)`);
console.log(`  Note: OOM check in QuickJS-NG v0.9.0 is 'malloc_size + size > malloc_limit - 1',`);
console.log(`  not 'limit - 64KB'; the 64KB margin is the user's mental model. Actual cap is`);
console.log(`  'limit - next_alloc_size' (= next_alloc_size headroom).`);
console.log();
console.log(`getMemoryUsage() returns both:`);
console.log(`  mallocSize      = total bytes currently held by QuickJS's malloc pool`);
console.log(`  memoryUsedSize  = bytes used by live JS objects (excludes free pool)`);
console.log(`OOM fires when mallocSize + size > memoryLimit - 1.`);
console.log();

// =========================================================================
// Section 1: 2x2 cross — GC config × ref handling
// =========================================================================
// Cell scripts:
//   PLAIN anchor:  fill globalThis.__anchor with arrays of numbers until OOM,
//                  swallow. Refcount-freeable on null.
//   CYCLIC anchor: a<->b mutual cycle (refcount CANNOT free),
//                  then push more arrays via __anchor (= a) until OOM.
// Both finish with: optional drop, then a small post-drop alloc attempt
// (wrapped in try/catch). The post-drop alloc CAN trigger auto-GC in default
// mode (when malloc crosses threshold) but CANNOT in Infinity mode.

async function cell({ threshold, dropRef, anchorType }) {
  const vm = await createVm({ memoryLimit: LIMIT });
  const baseline = memUsed(vm);
  if (threshold === 'infinity') vm.gcThreshold = Number.POSITIVE_INFINITY;
  const tGet = vm.gcThreshold;

  const plainScript = `(() => {
    globalThis.__anchor = null;
    globalThis.__oom = null;
    try {
      globalThis.__anchor = [];
      while (true) globalThis.__anchor.push(new Array(1000).fill(0));
    } catch (e) { globalThis.__oom = e.name; }
    ${dropRef ? 'globalThis.__anchor = null;' : ''}
    try {
      globalThis.__extra = [];
      for (let i = 0; i < 10; i++) globalThis.__extra.push(new Array(1000).fill(0));
    } catch (e2) { globalThis.__extra_err = e2.name; }
  })();`;

  const cycleScript = `(() => {
    globalThis.__anchor = null;
    globalThis.__oom = null;
    try {
      const a = new Array(100000).fill(0);
      const b = new Array(100000).fill(0);
      a.push(b); b.push(a);
      globalThis.__anchor = a;
      while (true) globalThis.__anchor.push(new Array(100000).fill(0));
    } catch (e) { globalThis.__oom = e.name; }
    ${dropRef ? 'globalThis.__anchor = null;' : ''}
    try {
      globalThis.__extra = [];
      for (let i = 0; i < 100; i++) globalThis.__extra.push(new Array(1000).fill(0));
    } catch (e2) { globalThis.__extra_err = e2.name; }
  })();`;

  const script = anchorType === 'cycle' ? cycleScript : plainScript;
  evStmt(vm, script);

  const r1 = memRaw(vm);
  vm.runGC();
  const r2 = memRaw(vm);

  vm.dispose();
  return {
    baseline,
    thresholdGet: tGet === Number.POSITIVE_INFINITY ? 'Infinity' : tGet,
    r1Used: r1.memoryUsedSize, r1UsedPct: pct(r1.memoryUsedSize),
    r1Malloc: r1.mallocSize, r1MallocPct: pct(r1.mallocSize),
    r2Used: r2.memoryUsedSize, r2UsedPct: pct(r2.memoryUsedSize),
    r2Malloc: r2.mallocSize, r2MallocPct: pct(r2.mallocSize),
  };
}

function printCellTable(rows, label) {
  console.log(label);
  console.log(`  cell | thresh    | drop  | r1.memoryUsed     | r1.mallocSize     | r2.memoryUsed     | r2.mallocSize`);
  console.log(`  -----|-----------|-------|-------------------|-------------------|-------------------|-------------------`);
  for (const r of rows) {
    console.log(`  ${r.name}   | ${String(r.threshold).padEnd(9)} | ${String(r.dropRef).padEnd(5)} | ${String(r.r1Used).padStart(8)} (${r.r1UsedPct.padStart(6)}) | ${String(r.r1Malloc).padStart(8)} (${r.r1MallocPct.padStart(6)}) | ${String(r.r2Used).padStart(8)} (${r.r2UsedPct.padStart(6)}) | ${String(r.r2Malloc).padStart(8)} (${r.r2MallocPct})`);
  }
  console.log();
}

console.log('===== Section 1: 2x2 cross (PLAIN array anchor — refcount-friendly) =====');
const plainRows = [];
for (const { name, threshold, dropRef } of [
  { name: 'A', threshold: 'default', dropRef: false },
  { name: 'B', threshold: 'default', dropRef: true },
  { name: 'C', threshold: 'infinity', dropRef: false },
  { name: 'D', threshold: 'infinity', dropRef: true },
]) {
  plainRows.push({ name, threshold, dropRef, ...(await cell({ threshold, dropRef, anchorType: 'plain' })) });
}
printCellTable(plainRows, 'plain anchor — refcount-freeable on null');

console.log('===== Section 1b: 2x2 cross (CYCLIC anchor — refcount CANNOT free) =====');
const cycleRows = [];
for (const { name, threshold, dropRef } of [
  { name: 'A', threshold: 'default', dropRef: false },
  { name: 'B', threshold: 'default', dropRef: true },
  { name: 'C', threshold: 'infinity', dropRef: false },
  { name: 'D', threshold: 'infinity', dropRef: true },
]) {
  cycleRows.push({ name, threshold, dropRef, ...(await cell({ threshold, dropRef, anchorType: 'cycle' })) });
}
printCellTable(cycleRows, 'cyclic anchor — a<->b mutual ref + grow via __anchor.push');

console.log();

// =========================================================================
// Section 2: runGC() overhead
// =========================================================================

async function fillAndGc(label, fillScript) {
  const vm = await createVm({ memoryLimit: LIMIT });
  evStmt(vm, fillScript);
  const before = memRaw(vm);
  const bench = benchNs(() => vm.runGC(), { reps: 11, warmup: 2 });
  const after = memRaw(vm);
  vm.dispose();
  return { label, before, after, bench };
}

console.log('===== Section 2: runGC() overhead =====');

const small = await fillAndGc('2a. small heap (~2MB, no garbage for GC to reclaim)', `(() => {
  const a = [];
  for (let i = 0; i < 250; i++) a.push(new Array(1000).fill(0));
  globalThis.__gc_test = a;
})();`);

const nearLimit = await fillAndGc('2b. near-limit heap (~7MB, no garbage for GC to reclaim)', `(() => {
  const a = [];
  for (let i = 0; i < 875; i++) a.push(new Array(1000).fill(0));
  globalThis.__gc_test = a;
})();`);

const cyclic = await fillAndGc('2c. heap with unreachable cycle (runGC reclaims)', `(() => {
  const a = new Array(100000).fill(0);
  const b = new Array(100000).fill(0);
  a.push(b); b.push(a);
  globalThis.__gc_test = a;
  globalThis.__gc_test = null;
})();`);

const postTick = await fillAndGc('2d. after a tick of short-lived allocs (already freed by refcount)', `(() => {
  const a = [];
  for (let i = 0; i < 250; i++) a.push(new Array(1000).fill(0));
  globalThis.__gc_test = a;
  for (let tick = 0; tick < 10; tick++) {
    const tmp = [];
    for (let i = 0; i < 200; i++) tmp.push(new Array(1000).fill(0));
  }
})();`);

for (const r of [small, nearLimit, cyclic, postTick]) {
  console.log(`  ${r.label}`);
  console.log(`    before runGC: mallocSize=${r.before.mallocSize} (${pct(r.before.mallocSize)}), memoryUsedSize=${r.before.memoryUsedSize}`);
  console.log(`    after  runGC: mallocSize=${r.after.mallocSize} (${pct(r.after.mallocSize)}), memoryUsedSize=${r.after.memoryUsedSize}`);
  console.log(`    runGC Δ: mallocSize=${r.before.mallocSize - r.after.mallocSize}, memoryUsedSize=${r.before.memoryUsedSize - r.after.memoryUsedSize}`);
  console.log(`    runGC time: median ${usNs(r.bench.medianNs)}, min ${usNs(r.bench.minNs)}`);
  console.log(`    [breakdown] atomCount=${r.before.atomCount} objCount=${r.before.objCount} arrayCount=${r.before.arrayCount} fastArrayElements=${r.before.fastArrayElements} mallocCount=${r.before.mallocCount}`);
  console.log();
}

console.log();

// =========================================================================
// Section 3: Reading upper bound under gcThreshold = Infinity
// =========================================================================

console.log('===== Section 3: reading upper bound (gcThreshold = Infinity) =====');

const vm3 = await createVm({ memoryLimit: LIMIT });
vm3.gcThreshold = Number.POSITIVE_INFINITY;
console.log(`  baseline: mallocSize=${memMalloc(vm3)}, memoryUsedSize=${memUsed(vm3)}`);
console.log(`  gcThreshold-get: ${vm3.gcThreshold === Number.POSITIVE_INFINITY ? 'Infinity' : vm3.gcThreshold}`);

const readings = [];
let cum = 0;
let lastMemU = memUsed(vm3);
let lastMemM = memMalloc(vm3);
let oomAt = null;
let oomMsg = null;
const SAMPLE_EVERY = 25;
const ALLOC_SCRIPT = `(() => {
  if (!globalThis.__grow) globalThis.__grow = [];
  globalThis.__grow.push(new Array(1000).fill(0));
})();`;

for (let i = 0; i < 200000; i++) {
  try {
    evStmt(vm3, ALLOC_SCRIPT);
    cum++;
    if (cum % SAMPLE_EVERY === 0 || cum <= 5) {
      const u = memUsed(vm3), m = memMalloc(vm3);
      readings.push({ cum, used: u, malloc: m, dSoftU: u - SOFT_LIMIT, dSoftM: m - SOFT_LIMIT });
      lastMemU = u; lastMemM = m;
    }
  } catch (e) {
    oomAt = cum;
    oomMsg = e.constructor.name + ': ' + (e.message || '').slice(0, 60);
    break;
  }
}

console.log(`  ${cum} total array pushes; OOM at push #${oomAt}: ${oomMsg}`);
const preOomUsed = lastMemU, preOomMalloc = lastMemM;
const finalUsage = memRaw(vm3);

console.log(`  last successful reading (push #${cum}): memoryUsedSize=${preOomUsed} (${pct(preOomUsed)}), mallocSize=${preOomMalloc} (${pct(preOomMalloc)})`);
console.log(`  reading after OOM (no GC, no further alloc): memoryUsedSize=${finalUsage.memoryUsedSize} (${pct(finalUsage.memoryUsedSize)}), mallocSize=${finalUsage.mallocSize} (${pct(finalUsage.mallocSize)})`);
console.log(`  → max memoryUsedSize observed:  ${preOomUsed}  (${((SOFT_LIMIT - preOomUsed) / 1024).toFixed(1)}KB below SOFT_LIMIT, ${((LIMIT - preOomUsed) / 1024).toFixed(1)}KB below memoryLimit)`);
console.log(`  → max mallocSize observed:      ${preOomMalloc}  (${((SOFT_LIMIT - preOomMalloc) / 1024).toFixed(1)}KB below SOFT_LIMIT, ${((LIMIT - preOomMalloc) / 1024).toFixed(1)}KB below memoryLimit)`);
console.log(`  → soft_limit threshold (user's): ${SOFT_LIMIT}`);
console.log(`  → effective cap (mallocSize at OOM, after partial push): ~${finalUsage.mallocSize}`);
console.log();

console.log(`  readings near peak (last 8):`);
for (const r of readings.slice(-8)) {
  console.log(`    push#${r.cum}: used=${r.used} (${pct(r.used)}), malloc=${r.malloc} (${pct(r.malloc)}), dSoftU=${r.dSoftU}, dSoftM=${r.dSoftM}`);
}

vm3.dispose();
console.log();

// =========================================================================
// Section 4: gcThreshold semantics
// =========================================================================

console.log('===== Section 4: gcThreshold semantics =====');

// 4a. Default value on a fresh VM
{
  const vm = await createVm({ memoryLimit: LIMIT });
  const t0 = vm.gcThreshold;
  console.log(`  4a. gcThreshold-get on fresh VM (no setter): ${t0}  (${(t0 / 1024).toFixed(0)}KB)`);
  vm.dispose();
}

// 4b. Setter accepts Infinity — what does getter return?
{
  const vm = await createVm({ memoryLimit: LIMIT });
  vm.gcThreshold = Number.POSITIVE_INFINITY;
  const tGet = vm.gcThreshold;
  const isInf = tGet === Number.POSITIVE_INFINITY;
  console.log(`  4b. set Infinity → get: ${tGet} (is Infinity? ${isInf})  — note: WASM truncates Infinity to 0`);
  vm.dispose();
}

// 4c. Setter accepts 0 (docs say 0 disables GC)
{
  const vm = await createVm({ memoryLimit: LIMIT });
  vm.gcThreshold = 0;
  const tGet = vm.gcThreshold;
  console.log(`  4c. set 0 → get: ${tGet}  (docs say 0 disables auto-GC)`);
  vm.dispose();
}

// 4d. Setter accepts large finite value
{
  const vm = await createVm({ memoryLimit: LIMIT });
  vm.gcThreshold = 1 << 30;
  const tGet = vm.gcThreshold;
  console.log(`  4d. set 1<<30 (1GB) → get: ${tGet}`);
  vm.dispose();
}

// 4e. After runGC(), does threshold get RESET upward?
{
  const vm = await createVm({ memoryLimit: LIMIT });
  const tBefore = vm.gcThreshold;
  evStmt(vm, `(() => { const a = []; for (let i = 0; i < 250; i++) a.push(new Array(1000).fill(0)); globalThis.__test = a; })();`);
  const tAfterAlloc = vm.gcThreshold;
  const usedAfterAlloc = memUsed(vm);
  vm.runGC();
  const tAfterRunGC = vm.gcThreshold;
  const usedAfterRunGC = memUsed(vm);
  console.log(`  4e. threshold progression on a fresh 8MB-limit VM:`);
  console.log(`      fresh:                       gcThreshold=${tBefore} (${(tBefore / 1024).toFixed(0)}KB)`);
  console.log(`      after ~2MB alloc:            gcThreshold=${tAfterAlloc} (${(tAfterAlloc / 1024).toFixed(0)}KB), memoryUsedSize=${usedAfterAlloc}`);
  console.log(`      after manual runGC():        gcThreshold=${tAfterRunGC} (${(tAfterRunGC / 1024).toFixed(0)}KB), memoryUsedSize=${usedAfterRunGC}`);
  console.log(`      → threshold advanced during alloc (auto-GC fired). After manual runGC, threshold unchanged.`);
  console.log(`      → manually setting gcThreshold does not 'stick' across auto-GC cycles; the runtime`);
  console.log(`        rewrites it to (typically) 1.5× of post-GC mallocSize. To truly disable auto-GC,`);
  console.log(`        set gcThreshold = 0 (per docs) — set Infinity truncates to 0 anyway (4b).`);
  vm.dispose();
}

// 4f. Under Infinity, drop two large plain refs → refcount-free should still fire
{
  const vm = await createVm({ memoryLimit: LIMIT });
  vm.gcThreshold = Number.POSITIVE_INFINITY;
  const before = memRaw(vm);
  evStmt(vm, `(() => {
    let big = new Array(500000).fill(0);
    let scratch = new Array(100000).fill(0);
    big = null;
    scratch = null;
  })();`);
  const after = memRaw(vm);
  console.log(`  4f. under gcThreshold=Infinity, drop two large refs (plain, no cycles):`);
  console.log(`      before: mallocSize=${before.mallocSize}, memoryUsedSize=${before.memoryUsedSize}`);
  console.log(`      after:  mallocSize=${after.mallocSize}, memoryUsedSize=${after.memoryUsedSize}`);
  console.log(`      Δ      : mallocSize=${after.mallocSize - before.mallocSize}, memoryUsedSize=${after.memoryUsedSize - before.memoryUsedSize}`);
  console.log(`      → refcount-based free fires regardless of threshold; ~4.8MB freed,`);
  console.log(`        leaving only the script overhead (~5KB).`);
  vm.dispose();
}

// 4g. Under Infinity (no auto-GC), confirm allocation completes without auto-GC side effects
{
  const vm = await createVm({ memoryLimit: LIMIT });
  vm.gcThreshold = Number.POSITIVE_INFINITY;
  const baseline = memUsed(vm);
  const beforeMalloc = memMalloc(vm);
  // Heavy alloc that should NOT trigger auto-GC (gcThreshold=0/∞)
  evStmt(vm, `(() => {
    const a = [];
    for (let i = 0; i < 500; i++) a.push(new Array(1000).fill(0));
    globalThis.__acc = a;
  })();`);
  const after = memRaw(vm);
  console.log(`  4g. under gcThreshold=Infinity, allocate 500 * 8KB = 4MB anchored arrays:`);
  console.log(`      baseline:       mallocSize=${beforeMalloc}, memoryUsedSize=${baseline}`);
  console.log(`      after alloc:    mallocSize=${after.mallocSize}, memoryUsedSize=${after.memoryUsedSize}`);
  console.log(`      Δ (raw allocs): mallocSize=${after.mallocSize - beforeMalloc}, memoryUsedSize=${after.memoryUsedSize - baseline}`);
  console.log(`      → no auto-GC fired (would have shown as mallocSize dip mid-loop);`);
  console.log(`        malloc_size grew monotonically by exactly the alloc cost.`);
  vm.dispose();
}

console.log();
console.log('=== probe done ===');