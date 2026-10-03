// PROTOTYPE (throwaway) —— 廊道图的门位/门宽三方案对比（一次性试验，定完就删）。
import { expand, ring, flat, poly, rect, hline, vline, buildStyled, SIZE } from './quad.mjs';
import { bfs, pathBetween, chebyshev, wallSet, jaccard } from './metrics.mjs';

const variants = {
  'C1 内环偏心口 3 格（现版）': flat(ring(21, 42, [[26, 21], [27, 21], [28, 21]]), ring(13, 50, [[17, 13], [18, 13], [19, 13]])),
  'C2 内环偏心口 5 格': flat(ring(21, 42, [[25, 21], [26, 21], [27, 21], [28, 21], [29, 21]]), ring(13, 50, [[17, 13], [18, 13], [19, 13]])),
  'C3 内环对口 3 格（正同心）': flat(ring(21, 42, [[31, 21], [32, 21], [33, 21]]), ring(13, 50, [[17, 13], [18, 13], [19, 13]])),
  'C4 两环都偏心但口宽 5 格': flat(ring(21, 42, [[25, 21], [26, 21], [27, 21], [28, 21], [29, 21]]), ring(13, 50, [[15, 13], [16, 13], [17, 13], [18, 13], [19, 13]])),
  'C5 两环都对口 3 格（正靶心）': flat(ring(21, 42, [[31, 21], [32, 21], [33, 21]]), ring(13, 50, [[30, 13], [31, 13], [32, 13]])),
};

const { sites, spawnUnits } = buildStyled('open');
const homes = sites.filter((s) => s.kind === 'base' && s.owner >= 0);
const mines = sites.filter((s) => s.kind === 'resource');
const centers = sites.filter((s) => s.kind === 'base' && s.owner < 0 && Math.max(Math.abs(s.x - 31.5), Math.abs(s.y - 31.5)) < 8);
const lanes = sites.filter((s) => s.kind === 'base' && s.owner < 0 && Math.max(Math.abs(s.x - 31.5), Math.abs(s.y - 31.5)) >= 8);

for (const [name, shapes] of Object.entries(variants)) {
  const grid = expand(shapes);
  const mid = homes.map((h) => {
    let best = Infinity;
    for (const c of centers) best = Math.min(best, pathBetween(grid, [h.x, h.y], [c.x, c.y]));
    return best;
  });
  const laneToInner = lanes.map((l) => {
    let best = Infinity;
    for (const m of mines) if (m.owner < 0) best = Math.min(best, pathBetween(grid, [l.x, l.y], [m.x, m.y]));
    return best;
  });
  const spawns = [0, 1, 2, 3].map((p) => spawnUnits.filter((u) => u.owner === p).map((u) => [u.x, u.y]));
  const pairs = [];
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    let best = Infinity;
    for (const a of spawns[i]) for (const b of spawns[j]) best = Math.min(best, pathBetween(grid, a, b));
    pairs.push(`${i}${j}:${best}`);
  }
  const stretches = [];
  for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) {
    const a = sites[i]; const b = sites[j];
    const c = chebyshev(a.x, a.y, b.x, b.y);
    if (c === 0) continue;
    stretches.push(pathBetween(grid, [a.x, a.y], [b.x, b.y]) / c);
  }
  stretches.sort((x, y) => y - x);
  const mean = stretches.reduce((s, v) => s + v, 0) / stretches.length;
  console.log(
    `${name.padEnd(24)} 墙 ${String(wallSet(grid).size).padStart(3)}  中路 ${mid.join('/')}  边路→内矿 ${laneToInner.join('/')}` +
    `  stretch mean ${mean.toFixed(2)} p90 ${stretches[Math.floor(stretches.length * 0.1)].toFixed(2)} max ${stretches[0].toFixed(2)}  六对 ${pairs.join(' ')}`,
  );
}

console.log('\n最绕的三对（看是哪一对在拉高 max）：');
for (const [name, shapes] of Object.entries(variants)) {
  const grid = expand(shapes);
  const list = [];
  for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) {
    const a = sites[i]; const b = sites[j];
    const c = chebyshev(a.x, a.y, b.x, b.y);
    if (c === 0) continue;
    list.push({ p: `${a.x},${a.y}->${b.x},${b.y}`, c, d: pathBetween(grid, [a.x, a.y], [b.x, b.y]) });
  }
  list.sort((x, y) => (y.d / y.c) - (x.d / x.c));
  console.log(`  ${name.padEnd(24)} ` + list.slice(0, 3).map((w) => `${w.p} ${w.c}→${w.d}`).join('   '));
}
