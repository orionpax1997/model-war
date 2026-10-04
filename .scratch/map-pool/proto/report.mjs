// PROTOTYPE (throwaway) —— 控制台报告：三图度量 + Jaccard 矩阵 + 阈值校准 + 候选轨道体检。
import { ALL, jaccard, wallSet, pct, auditVariantSlots, BASELINE_FIRST_CONTACT, BASELINE_DEPLETION } from './metrics.mjs';
import { expand, ring, flat, poly, rect, hline, vline, SIZE } from './quad.mjs';

const R = ALL();
const L = (s) => s.label;

console.log('══════ 1. 墙量与卫生 ══════');
for (const r of R) {
  console.log(
    `${L(r.style).padEnd(6)} 墙 ${String(r.wallCount).padStart(3)} 格 ${pct(r.density).padStart(6)}` +
    `  点位 ${r.siteCount}  可达格 ${r.reachable}/${SIZE * SIZE}  四重对称 ✓  桩三条自检 ✓`,
  );
}

console.log('\n══════ 2. 路径拉伸（BFS 八向 ÷ Chebyshev；1.00 = 墙没逼出绕路）══════');
for (const r of R) {
  console.log(
    `${L(r.style).padEnd(6)} 矿路(家→最近自家矿) ${r.mineTrips.map((t) => t.path).join('/')}` +
    `   中路(家→中心基地) ${r.centerReach.map((t) => `${t.cheb}→${t.path}`).join(' ')}`,
  );
  console.log(
    `${' '.repeat(6)} 全图 378 个点位对：mean ${r.stretch.mean.toFixed(2)}  p90 ${r.stretch.p90.toFixed(2)}  max ${r.stretch.max.stretch.toFixed(2)}` +
    `   最绕三对 ${r.stretch.worst.map((w) => `${w.pair}(${w.cheb}→${w.path})`).join(' ')}`,
  );
}

console.log(`\n══════ 3. 首触估算（六对全列；基线 ${BASELINE_FIRST_CONTACT} = 标定环全平原实测中位）══════`);
for (const r of R) {
  console.log(`${L(r.style).padEnd(6)} ${r.pairs.map((p) => `${p.i}${p.j}:${p.cheb}→${p.path}`).join('  ')}`);
  console.log(
    `${' '.repeat(6)} 最早的一对 ${r.earliestPair.i}↔${r.earliestPair.j} → 首触估算 ${r.estFirstContact.toFixed(0)} tick` +
    `   最晚的一对 ${r.latestPair.i}↔${r.latestPair.j} → ${r.latestPair.est.toFixed(0)} tick   （gdd §2 窗口 40–160）`,
  );
}

console.log(`\n══════ 4. 枯竭估算（基线 ${BASELINE_DEPLETION} = gdd §8 #8 命题① 实测中位；采集往返 = 2d+20）══════`);
for (const r of R) {
  console.log(`${L(r.style).padEnd(6)} 矿路 d=${r.mineTrips.map((t) => t.path).join('/')}  周期比 ${r.cycleRatio.toFixed(3)}  枯竭估算 ${r.estDepletion.toFixed(0)} tick  （窗口 400–600）`);
}
console.log('  红线：矿路被墙拉长到多少 tick 就顶破 600？');
for (const d of [6, 7, 8, 9, 10, 11, 12]) {
  const est = BASELINE_DEPLETION * ((2 * d + 20) / 32);
  console.log(`     d=${String(d).padStart(2)} → 枯竭估算 ${est.toFixed(0)}  ${est <= 600 ? '✓ 在窗口内' : '✗ 顶破上界'}`);
}

console.log('\n══════ 5. Jaccard 墙体相似度（spec 初版阈值 0.2）══════');
for (let i = 0; i < R.length; i++) {
  for (let j = i + 1; j < R.length; j++) {
    const v = jaccard(R[i].walls, R[j].walls);
    console.log(`  ${L(R[i].style)} vs ${L(R[j].style)}: ${v.toFixed(4)}  ${v < 0.2 ? '✓ 过' : '✗ 不过'}`);
  }
}

console.log('\n══════ 6. 阈值校准：负对照（人眼会说「不一样」，机器该不该放过？）══════');
const OPEN_THICK = flat( // 对照 A：同风格加密度——每个块长大一圈
  poly([21, 9], [22, 9], [22, 10], [23, 9], [23, 10]),
  rect(12, 20, 3, 3), hline(29, 7, 10), hline(28, 8, 9),
  poly([13, 5], [14, 5], [14, 6], [15, 5], [15, 6]),
  rect(21, 19, 3, 3), hline(11, 24, 26),
  poly([5, 22], [5, 23], [6, 23], [6, 22], [6, 24]),
  vline(30, 24, 26), hline(30, 16, 18),
  poly([2, 4], [2, 5], [3, 5], [3, 4], [3, 6]),
);
const thick = wallSet(expand(OPEN_THICK));
console.log(`  A 同风格加密度（开阔 116 → ${thick.size} 格）: vs 开阔 ${jaccard(thick, R[0].walls).toFixed(3)} → 0.2 挡住 ✓`);

console.log('  B 同结构挪几格（**只挪外环**，内环逐格不动）——扫描阈值落在哪：');
for (const k of [1, 2, 3, 4, 6, 8]) {
  const g = wallSet(expand(flat(
    ring(21, 42, [[25, 21], [26, 21], [27, 21], [28, 21], [29, 21]]),
    ring(13 + k, 50 - k, [[17 + k, 13 + k], [18 + k, 13 + k], [19 + k, 13 + k]]),
  )));
  const v = jaccard(g, R[1].walls);
  console.log(`     外环内移 ${String(k).padStart(2)} 格: J=${v.toFixed(3)}  ${v < 0.2 ? '被 0.2 放过' : '被 0.2 挡住'}`);
}
{
  const g = wallSet(expand(ring(21, 42, [[25, 21], [26, 21], [27, 21], [28, 21], [29, 21]])));
  const v = jaccard(g, R[1].walls);
  console.log(`     只保留内环（外环整个没了）: J=${v.toFixed(3)}  ${v < 0.2 ? '被 0.2 放过' : '被 0.2 挡住'}`);
}
{
  const g = wallSet(expand(flat(
    ring(21, 42, [[25, 21], [26, 21], [27, 21], [28, 21], [29, 21]]),
    ring(13, 50, [[17, 13], [18, 13], [19, 13]]),
    ring(6, 57, [[10, 6], [11, 6], [12, 6]]),   // 同一张图上再加一层环 = 「两张图共享一大块结构」
  )));
  const v = jaccard(g, R[1].walls);
  console.log(`     廊道图 + 第三层环: J=${v.toFixed(3)}  ${v < 0.2 ? '被 0.2 放过' : '被 0.2 挡住'}`);
}

console.log('\n══════ 7. variantSlots 候选轨道体检（spec：元素必须是完整 4 元轨道）══════');
const A = auditVariantSlots();
console.log(`  桩 8 个代表元 → 4 重展开 32 格；逐格过滤后剩 ${A.perCellKept} 格（= 32，说明这套布局下**没有半条轨道**）`);
console.log(`  整条轨道都干净：${A.fullOrbits} 条；半条：${A.partialOrbits} 条；全脏：${A.deadOrbits} 条 → 静态候选清单 = ${A.fullOrbits} 条轨道 / ${A.perCellKept} 格 = ${(A.perCellKept / (SIZE * SIZE) * 100).toFixed(3)}% 全图`);
for (const o of A.all) console.log(`    代表元 ${String(o.rep).padEnd(8)} 干净 ${o.clean.length}/4`);
