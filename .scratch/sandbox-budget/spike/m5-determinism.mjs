// M5 确定性冻结:WASI 覆盖后 Date/Math.random 在 tick / VM / 重跑 三个维度的一致性
// (重跑维度由 run-all.sh 跑两遍本脚本 diff FROZEN_* 行)
import { createVm, ev, say } from './lib.mjs';
import { createHash } from 'node:crypto';

const FIXED_MS = 1_700_000_000_000n;
const fixedWasi = (memory) => ({
  clock_time_get(_clockId, _precision, resultPtr) {
    new DataView(memory.buffer).setBigUint64(resultPtr, FIXED_MS * 1_000_000n, true);
    return 0;
  },
  random_get(bufPtr, bufLen) {
    new Uint8Array(memory.buffer, bufPtr, bufLen).fill(0x42);
    return 0;
  },
});

const PROBE = `JSON.stringify({
  now: Date.now(),
  t: new Date().getTime(),
  tz: new Date().getTimezoneOffset(),
  iso: new Date().toISOString(),
  hms: new Date().getHours() + ':' + new Date().getMinutes(),
  rnd: [Math.random(), Math.random(), Math.random()],
})`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ---- M5.1 冻结 VM:逐 tick(中间真实等待 50ms)。Date 字段须恒定;rnd 序列会前进但可复现 ----
const vm1 = await createVm({ wasi: fixedWasi, timezoneOffset: 0 });
const ticks = [];
for (let t = 0; t < 3; t++) { ticks.push(ev(vm1, PROBE)); await sleep(50); }
const dateFields = (s) => { const { rnd, ...rest } = JSON.parse(s); return JSON.stringify(rest); };
say('M5.1.frozenDateStablePerTick', ticks.every((x) => dateFields(x) === dateFields(ticks[0])));
say('M5.1.frozenTickSample', ticks[0]);

// ---- M5.2 逐 VM:第二个 VM 同参数 → 完整 3-tick 转写一致(含 PRNG 序列) ----
const vm2 = await createVm({ wasi: fixedWasi, timezoneOffset: 0 });
const ticks2 = [];
for (let t = 0; t < 3; t++) { ticks2.push(ev(vm2, PROBE)); await sleep(50); }
say('M5.2.secondVmTranscriptIdentical', JSON.stringify(ticks2) === JSON.stringify(ticks));

// ---- M5.3 逐次重跑:输出确定性摘要(run-all.sh 跑两遍 diff) ----
console.log('FROZEN_DIGEST: ' + sha(JSON.stringify([ticks, ticks2])));
console.log('FROZEN_PROBE: ' + ticks[0]);

// ---- M5.4 PRNG 行为细节:序列前进但跨 VM/跨重跑复现;performance.now() 同样冻结 ----
{
  const p = JSON.parse(ticks[0]);
  say('M5.4.prngAdvancesWithinVm', new Set(p.rnd).size === 3);
  say('M5.4.prngSequenceSample', p.rnd);
  say('M5.4.performanceNowFrozen', ev(vm1, 'performance.now()') === ev(vm2, 'performance.now()'));
  say('M5.4.performanceNowSample', ev(vm1, 'performance.now()'));
}

// ---- M5.5 对照组:不覆盖(默认 'host' 时钟/时区) ----
{
  const ctl = await createVm({});
  const a = ev(ctl, PROBE);
  await sleep(50);
  const b = ev(ctl, PROBE);
  const pa = JSON.parse(a), pb = JSON.parse(b);
  say('M5.5.controlClockAdvances', pa.now !== pb.now);
  say('M5.5.controlTzIsHost', pa.tz);
  ctl.dispose();
}

vm1.dispose();
vm2.dispose();
