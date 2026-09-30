// M3 失控行为编排:每用例独立子进程 + 超时击杀,捕获 crash/signal/trap 后果与重建代价
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { say } from './lib.mjs';

const CASES = [
  { name: 'deep-default', timeout: 10000 },
  { name: 'deep-guard-off', timeout: 10000 },
  { name: 'deep-max-stack', timeout: 10000 },
  { name: 'loop-nointerrupt', timeout: 3000 }, // 死循环无 handler → 只能靠硬超时杀
  { name: 'rebuild', timeout: 60000 },
];

const worker = fileURLToPath(new URL('./m3-case.mjs', import.meta.url));

for (const c of CASES) {
  const r = spawnSync(process.execPath, [worker, c.name], { timeout: c.timeout, encoding: 'utf8' });
  const status = r.error && r.error.code === 'ETIMEDOUT' ? `TIMEOUT(killed after ${c.timeout}ms)` : `exit=${r.status}${r.signal ? ' signal=' + r.signal : ''}`;
  const m = r.stdout?.match(/RESULT: (.*)/);
  say(`M3.${c.name}.status`, status);
  if (m) say(`M3.${c.name}.data`, m[1]);
  if (r.stderr) say(`M3.${c.name}.stderrHead`, r.stderr.split('\n').slice(0, 3).join(' | ').slice(0, 300));
}
