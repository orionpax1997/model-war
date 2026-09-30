// run-worker.mjs —— 并行跑批的工作进程（run-all.mjs fork 它）。
//   node run-worker.mjs <jobs.json> <out.json>
// jobs.json 是 buildMatrices() 的输出切片；每个进程独立跑自己的切片，互不共享状态
// （同种子逐 tick 确定性已在 selftest 里验过，所以与串行跑批结果逐字一致）。

import fs from 'node:fs';
import { runMatrix } from './harness.mjs';

const [jobsPath, outPath] = process.argv.slice(2);
const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
const results = runMatrix(jobs);
fs.writeFileSync(outPath, JSON.stringify(results));
process.stdout.write(`worker done: ${results.length} matches\n`);
