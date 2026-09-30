// M2 内存上限:memoryLimit 超限的表现、可捕获性、VM 续用
import { createVm, ev, getGlobal, errInfo, say, hr } from './lib.mjs';

const LIMIT = 8 * 1024 * 1024;
const ALLOC_LOOP = `(() => {
  const a = [];
  for (let i = 0; i < 200000; i++) a.push(new Array(1000).fill(i));
  globalThis.__ok = true; // 走到这里说明 limit 没生效
})()`;

// ---- M2.1 guest 侧 try/catch 包住分配失败 ----
{
  const vm = await createVm({ memoryLimit: LIMIT });
  say('M2.1.baselineMemory', vm.getMemoryUsage());
  let hostErr = null;
  try {
    ev(vm, `(() => {
      globalThis.__c = null;
      try { ${ALLOC_LOOP} } catch (e) { globalThis.__c = e.name + '|' + e.message; }
      globalThis.__after = 1;
    })()`);
  } catch (e) { hostErr = errInfo(e); }
  say('M2.1.guestTryCatch', { hostErr, caught: getGlobal(vm, '__c') ?? 'NO (吞不掉)', afterRan: getGlobal(vm, '__after') ?? 'NO', limitReached: !getGlobal(vm, '__ok') });
  // VM 续用:GC 后小分配 + 常规执行
  vm.runGC();
  say('M2.1.vmUsableAfterOOM', { eval: ev(vm, '1 + 2'), smallAlloc: ev(vm, 'new Array(10000).fill(7).length') === 10000 });
  say('M2.1.memoryAfterGC', vm.getMemoryUsage());
  vm.dispose();
}

// ---- M2.2 host 侧异常形态(guest 不捕获) + VM 续用 ----
{
  const vm = await createVm({ memoryLimit: LIMIT });
  let hostErr = null;
  const t0 = hr();
  try { ev(vm, ALLOC_LOOP); } catch (e) { hostErr = errInfo(e); }
  say('M2.2.hostErr', { ...hostErr, msAfterStart: (Number(hr() - t0) / 1e6).toFixed(0) });
  vm.runGC();
  say('M2.2.vmUsableAfterOOM', { eval: ev(vm, '1 + 2'), smallAlloc: ev(vm, 'new Array(10000).fill(7).length') === 10000 });
  // OOM 后能否再次触顶(反复 OOM 是否积累损伤)
  let again = null;
  try { ev(vm, ALLOC_LOOP); } catch (e) { again = errInfo(e); }
  vm.runGC();
  say('M2.2.repeatOOM', { err: again, evalAfter: ev(vm, '3 + 4') });
  say('M2.2.memoryAfterAll', vm.getMemoryUsage());
  vm.dispose();
}

// ---- M2.3 边界值:limit 恰好够用时的行为 + 无 limit 对照(供"触发情况披露"设计) ----
{
  const vm = await createVm({ memoryLimit: LIMIT });
  // 中等分配(~1MB)应当成功
  let ok = null, err = null;
  try { ok = ev(vm, '(() => { const a = []; for (let i = 0; i < 200; i++) a.push(new Array(1000).fill(i)); return a.length })()'); } catch (e) { err = errInfo(e); }
  say('M2.3.mediumAlloc200kElems', { result: ok, err });
  vm.dispose();
}
