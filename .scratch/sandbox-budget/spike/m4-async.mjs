// M4 异步排空:executePendingJobs 语义与不排空的跨 tick 残留后果
import { createVm, ev, getGlobal, errInfo, say, guestFn } from './lib.mjs';

const vm = await createVm({});

// ---- M4.1 基本语义:排空返回值与推进 ----
ev(vm, `(() => {
  globalThis.n = 0;
  Promise.resolve().then(() => { n += 1 }).then(() => { n += 1 });
})()`);
say('M4.1.afterEval', { n: getGlobal(vm, 'n'), jobsExecuted: vm.executePendingJobs(), nAfterDrain: getGlobal(vm, 'n'), secondDrain: vm.executePendingJobs() });

// ---- M4.2 不排空:evalCode/callFunction 会不会隐式推进 job ----
ev(vm, '(() => { globalThis.m = 0; Promise.resolve().then(() => { m += 1 }); })()');
const loop = guestFn(vm, 'tick', '', 'globalThis.tickCount = (globalThis.tickCount || 0) + 1;');
for (let t = 0; t < 3; t++) vm.callFunction(loop, vm.undefined).dispose();
say('M4.2.noDrain3Ticks', { m: getGlobal(vm, 'm'), note: 'callFunction/evalCode 不隐式推进 job' });
ev(vm, '0'); // 再来一次 evalCode 也不推进
say('M4.2.afterExtraEval', { m: getGlobal(vm, 'm'), jobsExecuted: vm.executePendingJobs(), mAfterDrain: getGlobal(vm, 'm') });

// ---- M4.3 排空是否级联(job 里再排队 job) ----
ev(vm, `(() => {
  globalThis.a = 0; globalThis.b = 0;
  Promise.resolve().then(() => { a += 1; Promise.resolve().then(() => { b += 1 }); });
})()`);
const jobs1 = vm.executePendingJobs();
const a1 = getGlobal(vm, 'a'), b1 = getGlobal(vm, 'b');
const jobs2 = vm.executePendingJobs();
say('M4.3.cascade', { drain1Jobs: jobs1, aAfterDrain1: a1, bAfterDrain1: b1, drain2Jobs: jobs2, bAfterDrain2: getGlobal(vm, 'b') });

// ---- M4.4 跨 tick 残留的实际后果:intent 提交时序 ----
ev(vm, `(() => {
  globalThis.intents = [];
  globalThis.tick = function (id) { intents.push('sync-' + id); return intents.length };
  Promise.resolve().then(() => { intents.push('late-from-tick0') });
  Promise.resolve().then(() => { Promise.resolve().then(() => { intents.push('late-late') }); });
})()`);
const tick = vm.global.getProp('tick');
for (let t = 1; t <= 3; t++) { vm.callFunction(tick, vm.undefined, vm.newNumber(t)).dispose(); }
const intentsBeforeDrain = getGlobal(vm, 'intents');
const drainJobs = vm.executePendingJobs();
const drainJobs2 = vm.executePendingJobs();
say('M4.4.crossTickResidue', { intentsBeforeDrain, intentsAfterDrain: getGlobal(vm, 'intents'), drainJobs, drainJobs2 });
tick.dispose();

// ---- M4.5 永不 settle 的 Promise / unhandled rejection ----
ev(vm, '(() => { new Promise(() => {}); Promise.reject(new Error("boom")); })()');
say('M4.5.pendingForever', { jobs: vm.executePendingJobs(), note: '未配置 onUnhandledRejection 时拒绝不炸宿主' });
const vm2 = await createVm({ onUnhandledRejection: (p, r, isHandled) => { outRej.push({ isHandled }); } });
const outRej = [];
ev(vm2, '(() => { Promise.reject(new Error("boom")); })()');
vm2.executePendingJobs();
say('M4.5.withRejectionHandler', { events: outRej });
vm2.dispose();

vm.dispose();
