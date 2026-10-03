// pilot-prop2.mjs —— 票 06 命题②：典型经济（4 份基准脚本）的实测消耗占比，三张真图 + 无墙夹具对照。
//
// 跑法：
//   cd /tmp/mw-ticket-06/.scratch/rules-calibration/sim && node --disable-warning=ExperimentalWarning selftest.mjs   # 硬前置，应 33 passed
//   cd /tmp/mw-ticket-06/.scratch/map-pool/runs && node --disable-warning=ExperimentalWarning pilot-prop2.mjs
//
// 命题②原文（gdd §8 #8 / handoff.md:71）：
//   「典型经济（4 份基准脚本实测吞吐，整局 ≈440）消耗不超过总储量的 1/4」
// 判据：consumed / total ≤ 25%。本仓 total = 16 矿 × resourcePerSite=200 = 3200，1/4 = 800。
//
// 为什么这批数可以与既有标定证据比较（本脚本的前提，结论在 prop2-tables.md）：
//   1. 桩、探针、脚本、变体填充机制全部与标定环同一份源码（只 import，不复制）；
//   2. 对局设置逐字取标定环 M1（镜像 4 方混战、rotate 4 个座位、SEEDS_PROBE 4 颗种子、
//      resourcePerSite=200、tickLimit=600、夹具 ownedMineOrbits 默认=1）；
//   3. 唯一的差别是地图来源：M1 用夹具 buildMap，本脚本的三张真图臂走 matchArgsOf 的 mapFile 分支。
//   → 所以「真图臂 vs 夹具臂」的差就是地图带来的差，可以直接与 gdd §8 #7/#8 记录的
//     「1336 场典型经济只走掉总储量 ~20%（旧值 21.8%）」比较。
//
// 三条口径（本脚本全程照此读数，不放宽）：
//   - **消耗（consumed）= total − depletion.remainingEnd**：全图储量被采走并离开资源点的量。
//     这与 gdd §8 #7「典型经济整局只消耗 ~20%」里的「消耗」同一定义（分母是 3200，不是 125×N）。
//   - **交付（delivered）** = Σ players[].delivered：送到自家基地的资源。标定环 tables §6.2
//     把它叫「全场交付合计」，是「实测吞吐」那句话的字面口径。交付 ≤ 消耗（差额 = 造兵花掉 + 在途携带）。
//   - **采获（harvested）** = Σ players[].harvests：只作为「消耗没有凭空蒸发」的自洽校验。
//   本脚本三者都报，但**判定用 consumed**——命题说的是「消耗总储量」。
//
// 锚点闸门：脚本先跑 M5/farmer6 四方自战（夹具），要求 p100 = 479、delivered = 3080。
// 不满足就中止并报错——因为票面禁止动探针，而这两格是当前受控锚点，漂了说明环境变了。
//
// 不动的东西：产品代码（apps/ packages/）、地图（maps/*.json）、探针（sim/probes/*）。本文件只读它们。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// ruleset.mjs 在**模块加载时**读 STUB_SET，覆盖必须在 import harness 之前写进 env。
if (!process.env.STUB_SET) process.env.STUB_SET = JSON.stringify({ resourcePerSite: 200 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM = path.resolve(HERE, '../../rules-calibration/sim');
const REPO = path.resolve(HERE, '../../..');

const { runMatrix, rotate, mapFromJson, SCRIPTS } = await import(path.join(SIM, 'harness.mjs'));
const { RULESET } = await import(path.join(SIM, 'ruleset.mjs'));

const MAP_NAMES = ['open-clash', 'corridor-split', 'fortress-core'];
// 票面口径：种子沿用 SEEDS_PROBE = [11,23,41,71]。
// PROP2_SEEDS 可覆盖成标定环的全 SEEDS（8 颗）做补充扫——主表不用它，补充扫单独出文件，
// 用途只有一个：把「最坏场」那条更严的判据的样本量从 64 场扩到 128 场。
const SEEDS = process.env.PROP2_SEEDS
  ? process.env.PROP2_SEEDS.split(',').map(Number)
  : [11, 23, 41, 71];                                // = harness.SEEDS_PROBE
const BASE_SCRIPTS = ['a', 'b', 'c', 'd'];            // harness.SCRIPTS 里的 4 份基准脚本（盲写模型脚本）
const FIXTURE = { variant: 'center-fortress', size: 64 };   // 无墙对照；点位布局与三张真图逐格相同
const OUT = process.env.PILOT_OUT ? path.resolve(process.env.PILOT_OUT) : HERE;

// ---------------------------------------------------------------- 锚点闸门（先夹具臂）

const ANCHOR = { p100: 479, delivered: 3080 };
const anchorJobs = SEEDS.map((seed) => ({
  id: `anchor/fixture/farmer6/s${seed}`,
  seatScripts: ['farmer6', 'farmer6', 'farmer6', 'farmer6'],
  seed, mirror: true, size: FIXTURE.size, variant: FIXTURE.variant,
  mapOpts: { ownedMineOrbits: 1 },
}));
const anchorRes = runMatrix(anchorJobs);
const anchorRows = anchorRes.map((r) => ({
  id: r.id,
  p100: r.depletion.ticks.p100,
  delivered: r.players.reduce((a, p) => a + p.delivered, 0),
  workerPeak: Math.max(...r.players.map((p) => p.workerPeak)),
}));
const anchorOk = anchorRows.every((a) => a.p100 === ANCHOR.p100 && a.delivered === ANCHOR.delivered);
console.log('[prop2] 锚点闸门 P0/fixture/farmer6：' + anchorRows.map((a) => `p100=${a.p100}/delivered=${a.delivered}/workerPeak=${a.workerPeak}`).join('，'));
if (!anchorOk) {
  console.error(`[prop2] 锚点漂移（期望 p100=${ANCHOR.p100}, delivered=${ANCHOR.delivered}）——环境与票面冻结的受控锚点不一致，拒绝继续。`);
  process.exit(2);
}
console.log('[prop2] 锚点逐字一致，0% 漂移，继续。');

// ---------------------------------------------------------------- 地图体检（记口径，不是判据）

const lint = [];
for (const name of MAP_NAMES) {
  const file = path.join(REPO, 'maps', `${name}.json`);
  const raw = fs.readFileSync(file);
  const json = JSON.parse(raw);
  const map = mapFromJson(json, SEEDS[0]);
  lint.push({
    name,
    file: path.relative(REPO, file),
    sha256: createHash('sha256').update(raw).digest('hex'),
    size: map.size,
    resourceSites: map.sites.filter((s) => s.kind === 'resource').length,
    ownedMinesPerSeat: [0, 1, 2, 3].map((p) => map.sites.filter((s) => s.kind === 'resource' && s.owner === p).length),
    wallsInJson: json.terrain.join('').split('#').length - 1,
    wallsAfterVariantFill: map.terrain.join('').split('wall').length - 1,
  });
  console.log(`[prop2] 体检 ${name}：资源点 ${lint.at(-1).resourceSites} 个（每方开局 ${lint.at(-1).ownedMinesPerSeat.join('/')}）｜墙 ${lint.at(-1).wallsInJson}→${lint.at(-1).wallsAfterVariantFill} 格｜sha256 ${lint.at(-1).sha256.slice(0, 12)}`);
}

// ---------------------------------------------------------------- 跑批：M1 口径，4 臂

const jobs = [];
for (const seats of rotate(BASE_SCRIPTS)) {
  for (const seed of SEEDS) {
    jobs.push({
      id: `P0/fixture/${seats.join('')}/s${seed}`,
      seatScripts: seats, seed, mirror: true,
      size: FIXTURE.size, variant: FIXTURE.variant,
      mapOpts: { ownedMineOrbits: 1 },
      label: 'fixture',
    });
    for (const name of MAP_NAMES) {
      jobs.push({
        id: `P1/${name}/${seats.join('')}/s${seed}`,
        seatScripts: seats, seed, mirror: true, size: 64, variant: name,
        mapFile: path.join(REPO, 'maps', `${name}.json`),
        label: name,
      });
    }
  }
}

console.log(`[prop2] 跑 ${jobs.length} 场（4 臂 × ${BASE_SCRIPTS.length} 座位轮转 × ${SEEDS.length} 种子，M1 口径）…`);
const t0 = Date.now();
const results = runMatrix(jobs);
console.log(`[prop2] 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------- 汇总

const QUOTA = 0.25;
const r1 = (x) => Math.round(x * 10) / 10;           // 表格里的百分比要一位小数（不 round 会出 10.399999999999999%）

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
    mean: v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null,
  };
}

const groups = new Map();
for (const r of results) {
  const g = r.id.split('/').slice(0, 2).join('/');
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(r);
}

const rows = [];
for (const [g, rs] of groups) {
  const total = rs[0].depletion.total;
  const quota = total * QUOTA;
  const consumedOf = (r) => r.depletion.total - r.depletion.remainingEnd;
  const deliveredOf = (r) => r.players.reduce((a, p) => a + p.delivered, 0);
  const harvestedOf = (r) => r.players.reduce((a, p) => a + p.harvests, 0);
  const consumed = rs.map(consumedOf);
  const over = consumed.filter((c) => c > quota).length;
  rows.push({
    group: g,
    matches: rs.length,
    total,
    quota,
    consumed: stats(consumed),
    consumedPct: stats(consumed.map((c) => r1((c / total) * 100))),
    delivered: stats(rs.map(deliveredOf)),
    harvested: stats(rs.map(harvestedOf)),
    overQuotaMatches: over,
    consumedVsHarvestedExact: rs.every((r) => consumedOf(r) === harvestedOf(r)),
    // 交付按席位归因：哪份基准脚本扛吞吐
    deliveredByScript: Object.fromEntries(BASE_SCRIPTS.map((k) => [
      k,
      r1(rs.reduce((a, r) => {
        const v = r.players.find((p) => p.script === k);
        return a + (v ? v.delivered : 0);
      }, 0) / rs.length),
    ])),
    outcomeReasons: Object.fromEntries([...new Set(rs.map((r) => r.outcome.reason))].map((x) => [x, rs.filter((r) => r.outcome.reason === x).length])),
    outcomeTicks: stats(rs.map((r) => r.outcome.tick)),
    depletionP100: stats(rs.map((r) => r.depletion.ticks.p100)),
    remainingEndPct: stats(rs.map((r) => r.depletion.remainingEndPct)),
  });
}
rows.sort((a, b) => a.group.localeCompare(b.group));

// 全局判定：每臂的中位与 max 都要 ≤ 1/4；同时报最坏场，避免中位数掩盖单场超标。
const consumedOf = (r) => r.depletion.total - r.depletion.remainingEnd;
const verdict = rows.map((r) => ({
  group: r.group,
  medianPass: r.consumed.median <= r.quota,
  maxPass: r.consumed.max <= r.quota,
  over: r.overQuotaMatches,
}));
// 全部场次（不分臂）的极值——「最坏场」这条判据的最终读数。
const allConsumed = results.map(consumedOf);
const batch = {
  matches: results.length,
  total: results[0].depletion.total,
  quota: results[0].depletion.total * QUOTA,
  consumed: stats(allConsumed),
  consumedPct: stats(allConsumed.map((c) => r1((c / results[0].depletion.total) * 100))),
  overQuotaMatches: allConsumed.filter((c) => c > results[0].depletion.total * QUOTA).length,
  consumedEqualsHarvestedEveryMatch: results.every(
    (r) => consumedOf(r) === r.players.reduce((a, p) => a + p.harvests, 0)),
};

const manifest = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  setOverrides: JSON.parse(process.env.STUB_SET),
  rulesetVersion: RULESET.rulesetVersion,
  tickLimit: RULESET.tickLimit,
  baseScripts: BASE_SCRIPTS.map((k) => ({ key: k, ...SCRIPTS[k] })),
  seeds: SEEDS,
  matrixCaliber: 'M1 逐字：mirror=true, rotate([a,b,c,d]) × SEEDS_PROBE, 夹具 ownedMineOrbits 默认=1',
  fixtureControl: FIXTURE,
  quota: { fraction: QUOTA, total: 3200, absolute: 800 },
  seeds: SEEDS,
  seedCaliber: SEEDS.join('/') === '11/23/41/71' ? 'SEEDS_PROBE（票面口径）' : 'SEEDS 全集（补充扫）',
  anchorGate: { expected: ANCHOR, observed: anchorRows, pass: anchorOk },
  maps: lint,
  metricCaliber: {
    consumed: 'depletion.total − depletion.remainingEnd（全图储量被采走的量）',
    delivered: 'Σ players[].delivered（送到自家基地的量 = 标定环 tables §6.2「全场交付合计」）',
    harvested: 'Σ players[].harvests（自洽校验用）',
    judged: 'consumed',
  },
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'prop2-matches.json'), JSON.stringify({ manifest, results }));
fs.writeFileSync(path.join(OUT, 'prop2-summary.json'), JSON.stringify({ manifest, rows, verdict, batch }, null, 1));

// ---- 表格（人读）
const f = (s) => (s === null ? '—' : `${s.median}（${s.min}–${s.max}）`);
const pct = (s) => (s === null ? '—' : `${r1(s.median)}%（${r1(s.min)}–${r1(s.max)}）`);
const lines = [];
lines.push('# 票 06 命题②：典型经济（4 份基准脚本 a/b/c/d）的消耗占比');
lines.push('');
lines.push(`口径：M1 逐字（镜像 4 方混战、座位轮转 4 份 × 种子 ${SEEDS.join('/')}、\`resourcePerSite=200\`、\`tickLimit=600\`）；`);
lines.push('**消耗** = 全图储量 − 终局剩余（= 采获量，两者逐场相等已校验）；**交付** = 送到自家基地的量。');
lines.push(`总量 3200（16 矿 × 200），1/4 = **800**。判定用消耗，括号是 min–max（${SEEDS.length} 种子 × 4 座位轮转）。`);
lines.push('');
lines.push('| 臂 | 场 | 消耗 中位(min–max) | 消耗占比 | 交付 中位(min–max) | 超 800 的场次 | 中位判定 | 最坏场判定 |');
lines.push('|---|---:|---:|---:|---:|---:|---|---|');
for (const r of rows) {
  const v = verdict.find((x) => x.group === r.group);
  lines.push(`| ${r.group} | ${r.matches} | ${f(r.consumed)} | ${pct(r.consumedPct)} | ${f(r.delivered)} | ${v.over}/${r.matches} | ${v.medianPass ? '过' : '**不过**'} | ${v.maxPass ? '过' : '**不过**'} |`);
}
lines.push('');
lines.push('## 全批（不分臂）极值 —— 「最坏场」这条更严的判据');
lines.push('');
lines.push(`| 场 | 总量 | 1/4 配额 | 消耗 min–max | 消耗占比 | 超配额场次 | 消耗≡采获（逐场） |`);
lines.push('|---:|---:|---:|---:|---:|---:|---|');
lines.push(`| ${batch.matches} | ${batch.total} | ${batch.quota} | ${batch.consumed.min}–${batch.consumed.max} | ${batch.consumedPct.min}%–${batch.consumedPct.max}% | ${batch.overQuotaMatches}/${batch.matches} | ${batch.consumedEqualsHarvestedEveryMatch ? '全部相等' : '有不等（异常）'} |`);
lines.push('');
lines.push('## 逐席位交付均值（谁扛吞吐）');
lines.push('');
lines.push('| 臂 | ' + BASE_SCRIPTS.map((k) => `\`${k}\``).join(' | ') + ' | 终局剩余% | 结局分布 |');
lines.push('|---|' + BASE_SCRIPTS.map(() => '---:').join('|') + '|---:|---|');
for (const r of rows) {
  lines.push(`| ${r.group} | ` + BASE_SCRIPTS.map((k) => r.deliveredByScript[k]).join(' | ')
    + ` | ${f(r.remainingEndPct)} | ` + Object.entries(r.outcomeReasons).map(([k, v]) => `${k}×${v}`).join('/') + `（tick ${f(r.outcomeTicks)}） |`);
}
lines.push('');
lines.push('## 锚点闸门');
lines.push('');
lines.push(`夹具 \`farmer6\` 四方自战（本进程同批重跑）：p100=${anchorRows.map((a) => a.p100).join('/')}、delivered=${anchorRows.map((a) => a.delivered).join('/')}、workerPeak=${anchorRows.map((a) => a.workerPeak).join('/')}`);
lines.push(`（期望 p100=479 / delivered=3080，逐字一致才继续跑本表）——${anchorOk ? '一致，0% 漂移' : '**漂移**'}。`);
lines.push('');
lines.push('产物：`prop2-matches.json`（逐场）、`prop2-summary.json`（本表的机读版）、`prop2-manifest` 内嵌于两者。');
fs.writeFileSync(path.join(OUT, 'prop2-tables.md'), lines.join('\n'));
console.log(lines.join('\n'));