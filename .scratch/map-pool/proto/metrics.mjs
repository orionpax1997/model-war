// PROTOTYPE (throwaway) —— 三张墙图的度量：路径拉伸、首触估算、Jaccard。
//
// 判读口径（都不依赖桩的对局内核，纯几何）：
//   - 路径拉伸 stretch = BFS(八向，墙不可走) / Chebyshev(直线)。1.0 = 无墙；>1 = 墙逼出来的绕路。
//   - 首触估算 = 无墙基线实测 34 tick（results-rerun.md line 35，center-fortress@64 全平原）
//                 + (最近两家的 BFS 路径 − 直线)/2。分母 2 的理由：首触判据是「两军 Chebyshev ≤ 2」，
//                 两边对进时每 tick 各走 1 格，路径多出来的格子由双方各走一半。**这是估算不是实测**。
//   - 枯竭估算 = 无墙基线实测 479 tick（gdd §8 #8 命题①） × (2d+20)/(2d_plain+20)，
//                 d = 家到最近自家矿的 BFS 路径，20 = carryLimit/harvestRate 的一次满载采集。
//                 墙只加长往返，采集段不变，所以这是一阶正确的缩放。

import { buildStyled, STYLES, SIZE, rot, orbit4 } from './quad.mjs';
import { assertFourFoldSymmetry, assertSiteInvariants, assertConnectivity } from '../../rules-calibration/sim/map.mjs';
import { chebyshev } from '../../rules-calibration/sim/ruleset.mjs';

const BASELINE_FIRST_CONTACT = 34;  // results-rerun.md: center-fortress@64 全平原实测中位
const BASELINE_DEPLETION = 479;      // gdd §8 #8 命题① 实测中位
const BASELINE_MINE_D = 6;           // 全平原下家到最近自家矿的 Chebyshev

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** 从若干源格出发的八向 BFS（墙不可走），返回 Int16Array（-1 = 不可达） */
function bfs(grid, sources) {
  const dist = new Int16Array(SIZE * SIZE).fill(-1);
  const q = [];
  for (const [x, y] of sources) {
    dist[y * SIZE + x] = 0;
    q.push([x, y]);
  }
  for (let head = 0; head < q.length; head++) {
    const [x, y] = q[head];
    const d = dist[y * SIZE + x];
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
      if (grid[ny][nx] === '#') continue;
      const k = ny * SIZE + nx;
      if (dist[k] !== -1) continue;
      dist[k] = d + 1;
      q.push([nx, ny]);
    }
  }
  return dist;
}

function pathBetween(grid, from, to) {
  const dist = bfs(grid, [from]);
  const d = dist[to[1] * SIZE + to[0]];
  return d === -1 ? Infinity : d;
}

/** 墙格集合（供 Jaccard 用） */
export function wallSet(grid) {
  const out = new Set();
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (grid[y][x] === '#') out.add(`${x},${y}`);
  return out;
}

export function jaccard(a, b) {
  let inter = 0;
  for (const k of a) if (b.has(k)) inter++;
  return inter / (a.size + b.size - inter);
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;

export function measure(styleKey) {
  const { map, style, grid, sites, spawnUnits } = buildStyled(styleKey);

  // 桩的三条自检直接复用（地形换成我们画的，点位仍是桩的）
  assertFourFoldSymmetry(map);
  const inv = assertSiteInvariants(map);
  const reach = assertConnectivity(map);

  const homes = sites.filter((s) => s.kind === 'base' && s.owner >= 0);
  const mines = sites.filter((s) => s.kind === 'resource');
  const key = (s) => `${s.x},${s.y}`;

  // 1) 家 → 最近自家矿（经济命脉：采集往返）
  const mineTrips = homes.map((h) => {
    const own = mines.filter((m) => m.owner === h.owner);
    let best = null;
    for (const m of own) {
      const d = pathBetween(grid, [h.x, h.y], [m.x, m.y]);
      const cheb = chebyshev(h.x, h.y, m.x, m.y);
      if (!best || d < best.path) best = { mine: [m.x, m.y], path: d, cheb };
    }
    return { owner: h.owner, ...best };
  });

  // 2) 最近的两家：出生格对出生格的 BFS 路径（首触代理量）
  const spawns = [0, 1, 2, 3].map((p) => spawnUnits.filter((u) => u.owner === p).map((u) => [u.x, u.y]));
  const pairs = [];
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      let best = Infinity;
      let bestCh = Infinity;
      for (const a of spawns[i]) {
        for (const b of spawns[j]) {
          const d = pathBetween(grid, a, b);
          if (d < best) best = d;
          const c = chebyshev(a[0], a[1], b[0], b[1]);
          if (c < bestCh) bestCh = c;
        }
      }
      pairs.push({ i, j, path: best, cheb: bestCh });
    }
  }
  const closest = pairs.reduce((a, b) => (b.path < a.path ? b : a));

  // 3) 中路推进成本：家 → 最近的那个中心中立基地（争夺战场的入场费）
  const centerBases = sites.filter((s) => s.kind === 'base' && s.owner < 0 && Math.max(Math.abs(s.x - 31.5), Math.abs(s.y - 31.5)) < 8);
  const centerReach = homes.map((h) => {
    let best = null;
    for (const c of centerBases) {
      const d = pathBetween(grid, [h.x, h.y], [c.x, c.y]);
      if (!best || d < best.path) best = { to: [c.x, c.y], path: d, cheb: chebyshev(h.x, h.y, c.x, c.y) };
    }
    return { owner: h.owner, ...best };
  });

  // 4) 全图点位对的路径拉伸（地图整体的「机动税」，比单条矿路更能代表对局节奏）
  const stretches = [];
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const a = sites[i];
      const b = sites[j];
      const d = pathBetween(grid, [a.x, a.y], [b.x, b.y]);
      const c = chebyshev(a.x, a.y, b.x, b.y);
      if (c === 0) continue;
      stretches.push({ pair: `${key(a)}->${key(b)}`, path: d, cheb: c, stretch: d / c });
    }
  }
  stretches.sort((x, y) => y.stretch - x.stretch);
  const mean = stretches.reduce((acc, s) => acc + s.stretch, 0) / stretches.length;
  const p90 = stretches[Math.floor(stretches.length * 0.1)].stretch;

  const avgMineD = mineTrips.reduce((acc, t) => acc + t.path, 0) / mineTrips.length;
  const cycle = (d) => 2 * d + 20; // 往返 + 一次满载采集
  const estDepletion = BASELINE_DEPLETION * (cycle(avgMineD) / cycle(BASELINE_MINE_D));
  // 首触：取六对里「估算最早」的那一对（两家对进，各走一半路径）
  const pairEstimates = pairs.map((p) => ({ ...p, est: BASELINE_FIRST_CONTACT + (p.path - p.cheb) / 2 }));
  const earliest = pairEstimates.reduce((a, b) => (b.est < a.est ? b : a));
  const latest = pairEstimates.reduce((a, b) => (b.est > a.est ? b : a));

  const walls = wallSet(grid);
  return {
    style, key: styleKey, map, grid, sites, spawnUnits, walls,
    wallCount: walls.size,
    density: walls.size / (SIZE * SIZE),
    reachable: reach,
    siteCount: inv.sites,
    siteList: sites,
    mineTrips,
    centerReach,
    closestPair: closest,
    pairs: pairEstimates,
    earliestPair: earliest,
    latestPair: latest,
    stretch: { mean, p90, max: stretches[0], worst: stretches.slice(0, 3) },
    estFirstContact: earliest.est,
    estFirstContactRange: [earliest.est, latest.est],
    estDepletion,
    cycleRatio: cycle(avgMineD) / cycle(BASELINE_MINE_D),
  };
}

export const ALL = () => STYLES.map((s) => measure(s.key));

/**
 * variantSlots 体检（spec 要求「元素是一条完整四重轨道的 4 个坐标对」）：
 * 桩的 8 个代表元按 4 重展开后逐格过滤「点位八邻域」，会留下**半条轨道**——那不是合法槽位。
 * 这里报两件事：逐格过滤剩多少格（桩口径 20），以及整条轨道都干净的有几条（spec 口径）。
 */
export function auditVariantSlots() {
  const { sites, spawnUnits } = buildStyled('open');
  const BASE_GRID = 40;
  const reps = [[2, 2], [9, 2], [2, 16], [2, 28], [16, 2], [24, 2], [37, 10], [37, 25]];
  const k = SIZE / BASE_GRID;
  const forbidden = new Set();
  for (const s of [...sites, ...spawnUnits]) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) forbidden.add(`${s.x + dx},${s.y + dy}`);
  }
  const orbits = reps.map(([rx, ry]) => {
    const cells = orbit4(Math.round(rx * k), Math.round(ry * k));
    return { rep: [Math.round(rx * k), Math.round(ry * k)], cells, clean: cells.filter(([x, y]) => !forbidden.has(`${x},${y}`)) };
  });
  const full = orbits.filter((o) => o.clean.length === 4);
  return {
    perCellKept: orbits.reduce((acc, o) => acc + o.clean.length, 0),
    fullOrbits: full.length,
    partialOrbits: orbits.filter((o) => o.clean.length > 0 && o.clean.length < 4).length,
    deadOrbits: orbits.filter((o) => o.clean.length === 0).length,
    full,
    all: orbits,
  };
}

export { bfs, pathBetween, chebyshev, pct, BASELINE_FIRST_CONTACT, BASELINE_DEPLETION, rot };
