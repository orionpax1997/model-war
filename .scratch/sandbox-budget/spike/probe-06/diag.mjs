// /tmp/qjs-probe/diag.mjs — diagnostic: per-alloc overhead
import { readFile } from 'node:fs/promises';
import { QuickJS } from '/home/qingtian/workspace/model-war/.scratch/sandbox-budget/spike/node_modules/quickjs-wasi/dist/index.js';

const SPIKE = '/home/qingtian/workspace/model-war/.scratch/sandbox-budget/spike';
const wasmBytes = await readFile(`${SPIKE}/node_modules/quickjs-wasi/quickjs.wasm`);
const wasmModule = await WebAssembly.compile(wasmBytes);

async function createVm(opts = {}) {
  return QuickJS.create({ wasm: wasmModule, ...opts });
}

function ev(vm, code) { return vm.evalCode(code).dispose(); }
function memRaw(vm) { return vm.getMemoryUsage(); }

async function main() {
  const vm = await createVm({ memoryLimit: 8 * 1024 * 1024 });

  console.log('=== per-alloc overhead diagnostic ===');
  console.log('baseline:', memRaw(vm).mallocSize, memRaw(vm).memoryUsedSize);

  // single array push
  ev(vm, 'globalThis.__a = new Array(1000).fill(0);');
  console.log('after 1 array push (8KB):', memRaw(vm).mallocSize, memRaw(vm).memoryUsedSize);

  // another single push
  ev(vm, 'globalThis.__a.push(new Array(1000).fill(0));');
  console.log('after 2 array pushes:', memRaw(vm).mallocSize, memRaw(vm).memoryUsedSize);

  // evalCode overhead only (no allocation in the script beyond the call)
  ev(vm, '1 + 1;');
  console.log('after eval trivial:', memRaw(vm).mallocSize, memRaw(vm).memoryUsedSize);

  // 100 arrays, single script
  ev(vm, `(() => { for (let i = 0; i < 100; i++) globalThis.__a.push(new Array(1000).fill(0)); })();`);
  console.log('after +100 arrays in one script:', memRaw(vm).mallocSize, memRaw(vm).memoryUsedSize);

  // 100 arrays, 100 separate evalCode calls
  for (let i = 0; i < 100; i++) ev(vm, `globalThis.__a.push(new Array(1000).fill(0));`);
  console.log('after +100 arrays in 100 separate scripts:', memRaw(vm).mallocSize, memRaw(vm).memoryUsedSize);

  // inspect an array's class to understand its memory layout
  const cls = memRaw(vm);
  console.log('\ncurrent state:');
  console.log('  mallocSize:', cls.mallocSize, 'memoryUsedSize:', cls.memoryUsedSize);
  console.log('  atomCount:', cls.atomCount, 'objCount:', cls.objCount);
  console.log('  arrayCount:', cls.arrayCount, 'fastArrayCount:', cls.fastArrayCount);
  console.log('  fastArrayElements:', cls.fastArrayElements);
  console.log('  binaryObjectCount:', cls.binaryObjectCount, 'binaryObjectSize:', cls.binaryObjectSize);
  console.log('  objSize:', cls.objSize, 'atomSize:', cls.atomSize);

  vm.dispose();
}

main().catch(e => { console.error(e); process.exit(1); });