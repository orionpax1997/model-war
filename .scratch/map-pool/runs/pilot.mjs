// pilot.mjs —— 票 06 第一段：三张带墙真图 × 农民海经济剖面的小批试点。
//
// 跑法（口径与标定环同源，只换地图）：
//   cd .scratch/rules-calibration/sim && node --disable-warning=ExperimentalWarning selftest.mjs   # 硬前置
//   cd .scratch/map-pool/runs && node --disable-warning=ExperimentalWarning pilot.mjs
//
// 为什么脚本住在 map-pool/runs 而不是 sim/：产物与结论归本 feature 的复验，而桩的
// `sim/data` 与 `sim/data-rerun-200` 是标定环的存档，不动它（见 AGENTS 与 README「丢掉桩、留下数据」）。
// 桩侧只改了 `harness.mjs` 的 `matchArgsOf` 一个函数（+ `map.mjs` 给 makeLcg 加 export），
// 跑批/重放同源的那条性质不变。
//
// 口径（必须与记录一起读）：
//   - `resourcePerSite=200`：与标定环 479 那条基线同参数（479 出自 data-rerun-200，manifest 记着这个覆盖）。
//     不设这个覆盖，储量回到 125、枯竭会整体前移 ~160 tick，比的就不是同一件事了。
//   - 农民海探针 farm6/farm8（每方 6/8 农），四方同脚本自战，mirror 注入座位（与 M5 同）。
//   - 种子 4 颗（11/23/41/71），与 harness 的 SEEDS_PROBE 同集合。变体填充 50%，逐槽位独立判定。
//   - 「采空中位」= `depletion.ticks.p100`（全图储量 100% 采空的 tick），与标定环 479 同一定义。
//   - 「首触」= `timeline.firstContact`（任意敌对单位 Chebyshev ≤ 2 的首个 tick），与标定环 34 同一定义。
//   - 对照组（无墙夹具 `center-fortress@64`，点位布局与三张真图逐格相同）在本进程里**同批重跑**，
//     这样「与基线的差」是同一次会话、同一份代码下的差，而不是拿存档表的旧数来减。
//
// 已知口径分歧（不在本段修，记录在 findings.md）：
//   1. 起始编队：桩 `START_UNITS` 的偏移经 `sc()` 在 size=64 下缩成 (2,0)/(0,2)，
//      真图 JSON 声明的是 (1,0)/(0,1)（票 05 票面口径）。真图走绝对坐标不经 `sc()`，不是 bug，但两者不一致。
//   2. 首触验收带：spec 与票面是 [0,48]；`harness.mjs` 的 WINDOWS.firstContact 写的是 [40,160]。
//      本记录一律按**票面 [0,48]** 判读。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// ruleset.mjs 在**模块加载时**读 STUB_SET，所以覆盖必须在 import harness 之前写进 env。
if (!process.env.STUB_SET) process.env.STUB_SET = JSON.stringify({ resourcePerSite: 200 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM = path.resolve(HERE, '../../rules-calibration/sim');
const REPO = path.resolve(HERE, '../../..');

const { runMatrix, mapFromJson } = await import(path.join(SIM, 'harness.mjs'));
const { RULESET } = await import(path.join(SIM, 'ruleset.mjs'));
const { assertFourFoldSymmetry, assertSiteInvariants, assertConnectivity } = await import(path.join(SIM, 'map.mjs'));

const MAP_NAMES = ['open-clash', 'corridor-split', 'fortress-core'];
const PROBES = ['farmer6', 'farmer8'];
const SEEDS = [11, 23, 41, 71];
const FIXTURE_BASELINE = { variant: 'center-fortress', size: 64 };   // 无墙对照，点位布局与三图逐格相同
const OUT = HERE;

// ---------------------------------------------------------------- 形状体检

const lint = [];
for (const name of MAP_NAMES) {
  const file = path.join(REPO, 'maps', `${name}.json`);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = mapFromJson(json, SEEDS[0]);
  const report = {
    name,
    file: path.relative(REPO, file),
    sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    size: map.size,
    wallsInJson: json.terrain.join('').split('#').length - 1,
    wallsAfterVariantFill: map.terrain.join('').split('wall').length - 1,
    variantSlotsInJson: json.variantSlots.length,
    sites: assertSiteInvariants(map),
    fourFold: 'ok',
    reachableCells: assertConnectivity(map),
  };
  assertFourFoldSymmetry(map);
  lint.push(report);
  console.log(`[pilot] 体检 ${name}：墙 ${report.wallsInJson}→${report.wallsAfterVariantFill} 格（seed ${SEEDS[0]}）｜点位 ${report.sites.sites} 个｜可达 ${report.reachableCells} 格｜四重对称 ok`);
}

// ---------------------------------------------------------------- 跑批

const jobs = [];
for (const name of MAP_NAMES) {
  for (const probe of PROBES) {
    for (const seed of SEEDS) {
      jobs.push({
        id: `P1/${name}/${probe}-mines1/s${seed}`,
        seatScripts: [probe, probe, probe, probe],
        seed,
        mirror: true,
        size: 64,
        variant: name,                                  // 只为让 meta.variant / id 读起来可辨
        mapFile: path.join(REPO, 'maps', `${name}.json`),
        label: `${probe}-mines1`,
      });
    }
  }
}
// 无墙对照组：同探针、同种子、点位逐格相同，差别只在「terrain 全平原 + 夹具自己的变体槽」
for (const probe of PROBES) {
  for (const seed of SEEDS) {
    jobs.push({
      id: `P0/fixture/${probe}-mines1/s${seed}`,
      seatScripts: [probe, probe, probe, probe],
      seed,
      mirror: true,
      size: FIXTURE_BASELINE.size,
      variant: FIXTURE_BASELINE.variant,
      mapOpts: { ownedMineOrbits: 1 },
      label: `${probe}-mines1`,
    });
  }
}

console.log(`[pilot] 跑 ${jobs.length} 场（三图 × ${PROBES.join('/')} × ${SEEDS.length} 种子 + 无墙对照 ${PROBES.length * SEEDS.length} 场）…`);
const t0 = Date.now();
const results = runMatrix(jobs);
console.log(`[pilot] 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------- 汇总

function median(xs) {
  const v = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (v.length === 0) return null;
  return v.length % 2 === 1 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}
function stats(xs) {
  const v = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  return {
    n: v.length,
    min: v[0] ?? null,
    p25: v.length ? v[Math.floor((v.length - 1) * 0.25)] : null,
    median: v.length ? median(v) : null,
    p75: v.length ? v[Math.floor((v.length - 1) * 0.75)] : null,
    max: v[v.length - 1] ?? null,
  };
}

const groups = new Map();
for (const r of results) {
  const g = r.id.split('/').slice(0, 3).join('/');
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(r);
}

const rows = [];
for (const [g, rs] of groups) {
  rows.push({
    group: g,
    matches: rs.length,
    depletionP25: stats(rs.map((r) => r.depletion.ticks.p25)),
    depletionP50: stats(rs.map((r) => r.depletion.ticks.p50)),
    depletionP75: stats(rs.map((r) => r.depletion.ticks.p75)),
    depletionP100: stats(rs.map((r) => r.depletion.ticks.p100)),
    firstContact: stats(rs.map((r) => r.timeline.firstContact)),
    remainingEndPct: stats(rs.map((r) => r.depletion.remainingEndPct)),
    deliveredMean: Math.round(rs.reduce((a, r) => a + r.players.reduce((b, p) => b + p.delivered, 0), 0) / rs.length),
    outcomeTicks: rs.map((r) => r.outcome.tick),
    outcomeReasons: [...new Set(rs.map((r) => r.outcome.reason))],
    totalResources: rs[0].depletion.total,
    workersEnd: rs[0].players.map((p) => p.unitsByTypeEnd.w),
  });
}
rows.sort((a, b) => a.group.localeCompare(b.group));

const manifest = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  setOverrides: JSON.parse(process.env.STUB_SET),
  rulesetVersion: RULESET.rulesetVersion,
  probes: PROBES,
  seeds: SEEDS,
  fixtureBaseline: FIXTURE_BASELINE,
  maps: lint,
  note: '带 resourcePerSite=200 才能与标定环的 479 基线比；口径分歧见 findings.md',
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'pilot-matches.json'), JSON.stringify(results));
fs.writeFileSync(path.join(OUT, 'pilot-summary.json'), JSON.stringify({ manifest, rows }, null, 1));
fs.writeFileSync(path.join(OUT, 'pilot-manifest.json'), JSON.stringify(manifest, null, 2));

// ---- 表格（人读的部分）
const fmt = (s) => (s === null ? '—' : s.n === 0 ? '—' : `${s.median}（${s.min}–${s.max}）`);
const lines = [];
lines.push('# 票 06 第一段试点：带墙真图 × 农民海经济剖面');
lines.push('');
lines.push('口径见 `pilot.mjs` 头注。要点：`resourcePerSite=200`（同 479 基线）、4 种子、变体填充 50%、');
lines.push('「采空」= 全图储量 100% 采空的 tick（`depletion.ticks.p100`）、「首触」= 敌对单位 Chebyshev ≤ 2 的首个 tick。');
lines.push('括号里是 min–max。P0 = 无墙夹具对照（本进程同批重跑），P1 = 三张带墙真图。');
lines.push('');
lines.push('| 组 | 场 | 采空(p100) 中位 | 75% | 50% | 结束剩余% | 首触 中位 | 全场交付均值 | 结局 |');
lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---|');
for (const r of rows) {
  lines.push(`| ${r.group} | ${r.matches} | ${fmt(r.depletionP100)} | ${fmt(r.depletionP75)} | ${fmt(r.depletionP50)} | ${fmt(r.remainingEndPct)} | ${fmt(r.firstContact)} | ${r.deliveredMean} | ${r.outcomeReasons.join('/')}@${[...new Set(r.outcomeTicks)].join('/')} |`);
}
lines.push('');
lines.push('## 地图体检');
lines.push('');
lines.push('| 图 | 墙格(声明/seed 填充后) | 变体候选轨道 | 点位 | 可达格 | 四重对称 |');
lines.push('|---|---:|---:|---:|---:|---|');
for (const l of lint) {
  lines.push(`| ${l.name} | ${l.wallsInJson} / ${l.wallsAfterVariantFill} | ${l.variantSlotsInJson} | ${l.sites.sites} | ${l.reachableCells} | ok |`);
}
lines.push('');
lines.push('产物：`pilot-matches.json`（逐场）、`pilot-summary.json`（本表的机读版）、`pilot-manifest.json`（口径与地图 sha256）。');
fs.writeFileSync(path.join(OUT, 'pilot-tables.md'), lines.join('\n'));
console.log(lines.join('\n'));