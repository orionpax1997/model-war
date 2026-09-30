// run-all.mjs —— 桩模拟器一键跑批：矩阵 → 取证数据 → 自动证据表。
//
//   node --disable-warning=ExperimentalWarning run-all.mjs                # 全量（3 个夹具变体，1120 场）
//   node --disable-warning=ExperimentalWarning run-all.mjs --quick        # 小样本冒烟
//   node --disable-warning=ExperimentalWarning run-all.mjs --jobs=4       # 限制并行度
//   node --disable-warning=ExperimentalWarning run-all.mjs --matrix=M1   # 只跑某个矩阵
//   node --disable-warning=ExperimentalWarning run-all.mjs --variant=center-fortress@64
//   node --disable-warning=ExperimentalWarning run-all.mjs --serial      # 不 fork（调试用）
//   node --disable-warning=ExperimentalWarning run-all.mjs --tables-only  # 只用已有 matches.json 重算表格
//   node --disable-warning=ExperimentalWarning run-all.mjs --out=data-rerun-200        # 换产物目录（票 09 复跑）
//   node --disable-warning=ExperimentalWarning run-all.mjs --set resourcePerSite=200   # 覆盖参数（走 STUB_SET）
//   node --disable-warning=ExperimentalWarning run-all.mjs --set USE_CAVALRY=false --matrix=M7
//
// 产物：data/matches.json（逐场）、data/duels.json（C1~C7 + 速度消融）、data/tables.md（自动证据表）、
//       data/manifest.json（跑批口径：脚本 hash / 注入改写 / 夹具变体 / 并行度 / 参数覆盖）。
// results.md 的判读由人写（它拥有"成立/失衡"的结论），数字一律引用本目录的生成物。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildMatrices, runMatrix, SCRIPTS, VARIANTS } from './harness.mjs';
import { runAllDuels } from './duels.mjs';
import { buildTables } from './tables.mjs';
import { mirrorPatchList } from './mirror.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
// --out=<dir>：换产物目录（票 09 的复跑用 data-rerun-200，08 的 data/ 原样保留作证据源）
const outDir = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length) ?? 'data';
const DATA = path.join(HERE, outDir);
// 每次跑批一个独立 tmp 目录：并发跑两批时互不删对方的中间文件
const TMP = path.join(DATA, `.tmp-${process.pid}`);

// --set key=value（可重复；也接受 --set key=value 的分词写法）：写进 STUB_SET，
// ruleset.mjs 读它覆盖参数、探针读它拿宿主注入。只接受标量/布尔；键名不做白名单
// （throwaway 桩），但会原样记进 manifest.json。
const argvSet = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--set') { argvSet.push(`--set=${argv[i + 1] ?? ''}`); i++; continue; }
  if (argv[i].startsWith('--set=')) argvSet.push(argv[i]);
}
const setOverrides = {};
for (const a of argvSet) {
  const kv = a.slice('--set='.length);
  const i = kv.indexOf('=');
  if (i < 0) throw new Error(`--set needs key=value, got: ${a}`);
  const k = kv.slice(0, i).trim();
  const raw = kv.slice(i + 1).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`--set bad key: ${k}`);
  setOverrides[k] = (raw === 'true' ? true : raw === 'false' ? false : /^-?\d+$/.test(raw) ? Number(raw) : raw);
}
if (Object.keys(setOverrides).length > 0) process.env.STUB_SET = JSON.stringify(setOverrides);
const quick = argv.includes('--quick');
const serial = argv.includes('--serial');
const only = argv.find((a) => a.startsWith('--matrix='))?.split('=')[1] ?? null;
const tablesOnly = argv.includes('--tables-only');
const jobsOpt = Number(argv.find((a) => a.startsWith('--jobs='))?.split('=')[1] ?? 0) || Math.max(1, os.cpus().length - 2);
const variants = [argv.find((a) => a.startsWith('--variant='))?.split('=')[1] ?? null].filter(Boolean);
const variantList = variants.length > 0 ? variants : VARIANTS;

if (tablesOnly) {
  // 只重算自动表：口径改动不需要重跑 1168 场
  const results = JSON.parse(fs.readFileSync(path.join(DATA, 'matches.json'), 'utf8'));
  const duels = JSON.parse(fs.readFileSync(path.join(DATA, 'duels.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(DATA, 'tables.md'), buildTables(results, duels, manifest));
  console.log(`[run-all] 仅重算表格：${results.length} 场 → ${outDir}/tables.md`);
  process.exit(0);
}

let jobs = buildMatrices({ variants: quick ? [VARIANTS[0]] : variantList });
if (quick) {
  // 冒烟：每种矩阵形态各 1 场（同一 seed），只为验证流水线不炸
  const seen = new Set();
  jobs = jobs.filter((j) => {
    const key = j.id.split('/').slice(0, 3).join('/');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
if (only) jobs = jobs.filter((j) => j.id.startsWith(`${only}/`));

await run();

async function run() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  console.log(`[run-all] ${jobs.length} 场对局｜夹具变体：${[...new Set(jobs.map((j) => `${j.variant}@${j.size}`))].join(', ')}｜并行度：${serial ? 1 : jobsOpt}`);
  const t0 = Date.now();

  const results = serial
    ? runMatrix(jobs, { onMatch: (r, i) => progress(i + 1, jobs.length, t0, r) })
    : await runParallel(jobs, t0);

  const duels = runAllDuels();
  const manifest = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    quick,
    setOverrides,
    outDir,
    variants: [...new Set(results.map((r) => r.meta.variant))],
    jobs: results.length,
    parallel: serial ? 1 : jobsOpt,
    seeds: [...new Set(jobs.map((j) => j.seed))].sort((a, b) => a - b),
    mirrorPatches: mirrorPatchList(),
    scripts: Object.fromEntries(Object.entries(SCRIPTS).map(([k, v]) => [k, {
      cell: v.cell,
      model: v.model,
      strategy: v.strategy,
      file: path.relative(HERE, v.file),
      sha256: sha256(v.file),
      inject: v.inject ?? null,
    }])),
  };

  fs.writeFileSync(path.join(DATA, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(DATA, 'matches.json'), JSON.stringify(results));
  fs.writeFileSync(path.join(DATA, 'duels.json'), JSON.stringify(duels, null, 1));
  fs.writeFileSync(path.join(DATA, 'tables.md'), buildTables(results, duels, manifest));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`[run-all] 完成：${results.length} 场 + 对拼实验，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`[run-all] 产物：${path.relative(process.cwd(), DATA)}/{manifest,matches,duels}.json, tables.md`);
  if (Object.keys(setOverrides).length > 0) console.log(`[run-all] 参数覆盖：${JSON.stringify(setOverrides)}`);
}

function runParallel(all, t0) {
  return new Promise((resolve, reject) => {
    // 轮转切片：保证每个 worker 的负载混合了各矩阵与各种子（避免某片全是超时局）
    const shards = Array.from({ length: Math.min(jobsOpt, all.length) }, () => []);
    all.forEach((j, i) => shards[i % shards.length].push(j));
    const live = shards.filter((s) => s.length > 0);
    let done = 0;
    const out = [];
    let failed = false;
    live.forEach((shard, si) => {
      const jf = path.join(TMP, `jobs-${si}.json`);
      const of = path.join(TMP, `out-${si}.json`);
      fs.writeFileSync(jf, JSON.stringify(shard));
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(HERE, 'run-worker.mjs'), jf, of], { stdio: ['ignore', 'ignore', 'inherit'] });
      child.on('close', (code) => {
        if (failed) return;
        if (code !== 0) { failed = true; reject(new Error(`worker ${si} exited ${code}`)); return; }
        // worker 刚 close 时文件系统可能还没把内容刷出来（极端负载下偶发 ENOENT/半写）
        const part = JSON.parse(readWithRetry(of));
        out.push(...part);
        done += 1;
        progress(done, live.length, t0, part[part.length - 1], `批次 ${done}/${live.length}`);
        if (done === live.length) {
          // 保持原始 job 顺序，便于 results.md 里按矩阵/种子引用
          const order = new Map(all.map((j, i) => [j.id, i]));
          resolve(out.sort((a, b) => order.get(a.id) - order.get(b.id)));
        }
      });
    });
  });
}

function readWithRetry(p, tries = 20) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try { return fs.readFileSync(p, 'utf8'); } catch (err) { last = err; }
    // 同步退避：等文件系统把缓冲刷出来
    const until = Date.now() + 250;
    while (Date.now() < until) { /* spin 250ms */ }
  }
  throw last;
}

function progress(done, total, t0, r, label) {  if (done % 20 !== 0 && done !== total) return;
  const el = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`  ${label ?? `${done}/${total} 场`}（${el}s）… ${r ? `${r.id} → ${r.outcome.reason}/${r.outcome.winner ?? '-'}@${r.outcome.tick}` : ''}`);
}

function sha256(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
