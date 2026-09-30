// map.mjs —— 桩模拟器的测试夹具地图（不是地图设计；坐标/点位数量归 gdd 开放项 #2 的地图票）。
//
// 约束（draft rules.md §1 点位不变量）：
//   - 四重旋转对称（绕中心 90° 旋转自洽）：terrain 与 sites 都必须满足；
//   - 每方恰好 1 个主基地（四象限对称）；
//   - 中立基地数量为 4 的倍数；资源点数量为 4 的倍数（内圈高危 + 外圈家门口）；
//   - 点位不在墙上；单格单单位。
// 种子变体：只做装饰性微扰（成组四重对称墙体填充），不改点位数量与布局（draft rules.md §1 / hld §7.3）。
//
// 尺寸 40×40 选型理由（证据口径，不是地图定案）：中心 2×2 基地块距家 ~10 tick、
// 边路中立基地距家 ~12 tick、外圈矿距家 4 tick —— 首次接触落在 tick 40–160 的设计窗口内。

// 尺寸选型（证据口径，不是地图定案）：夹具的坐标在 40×40 网格上声明，再按 `size/40` 整体缩放。
//   size=40：相邻两家 27 tick —— 首触必然落在 tick 30 附近，**达不到** gdd §2 的 40–160 窗口；
//   size=64：相邻两家 43 tick —— 首触落在 45–70，正是设计窗口。
// 两档都跑（见 harness 的矩阵维度 size），目的是把“窗口达不到”归因到地图尺寸而不是规则数值。
import { RULESET } from './ruleset.mjs';

export const MAP_SIZES = [40, 64];
export const BASE_GRID = 40;

// rot: 绕 (19.5,19.5) 旋转 90°，(x,y) -> (size-1-y, x)。四重对称的生成子。
function rot(x, y, size) {
  return [size - 1 - y, x];
}

// 点位以“轨道代表元”声明：给一个点，展开它的四重旋转轨道（4 格），自动保证四重对称。
// variant = 'center-fortress'（默认：中路 4 基地 + 边路 4 基地 = 8 个中立基地）
//         | 'open-four'（只有边路 4 个中立基地，中路只有资源点）——用于点位密度敏感性对照。
//
// 「外圈家门口安全矿」的夹具解读（见 README「夹具解读」）：前 ownedMineOrbits 圈资源点开局属各家
// （默认 1 圈 = 只给家门口那一圈）。否则 tick 0 无人有可采矿（规则要求先占领才有开采权），
// gdd §5「起始资金 + 起始农民，保证开局即可补经济」就不成立。
// 注意：轨道按声明顺序向外/向内排（[4,10] 距家 6、[12,12] 距家 11、[19,10] 距家 20），
// 所以 ownedMineOrbits=3 同时意味着“开局就拿到内圈高危矿”，不是单纯的资源变多。
const SITE_SEEDS_BY_VARIANT = {
  'center-fortress': [
    { kind: 'base', rep: [6, 6], initialOwners: [0, 1, 2, 3] },
    { kind: 'base', rep: [18, 4] },
    { kind: 'base', rep: [16, 16] },
    { kind: 'resource', rep: [4, 10] },
    { kind: 'resource', rep: [12, 12] },
    { kind: 'resource', rep: [19, 10] },
    { kind: 'resource', rep: [11, 16] },
  ],
  'open-four': [
    { kind: 'base', rep: [6, 6], initialOwners: [0, 1, 2, 3] },
    { kind: 'base', rep: [18, 4] },
    { kind: 'resource', rep: [4, 10] },
    { kind: 'resource', rep: [12, 12] },
    { kind: 'resource', rep: [19, 10] },
    { kind: 'resource', rep: [11, 16] },
  ],
};
export const MAP_VARIANTS = Object.keys(SITE_SEEDS_BY_VARIANT);
const DEFAULT_VARIANT = 'center-fortress';

// 起始编队（地图声明；每方 2 农民，坐标为相对自家基地的偏移，再按座位旋转，保证四重对称）
const START_UNITS = [
  { type: 'worker', offsets: [[1, 0], [0, 1]] },
];

// 装饰性变体槽位：8 个代表元 × 4 格轨道 = 32 个候选墙格，种子决定是否填。
const VARIANT_SLOT_REPS = [
  [2, 2], [9, 2], [2, 16], [2, 28],
  [16, 2], [24, 2], [37, 10], [37, 25],
];

// 变体填充率（种子 -> 每槽位独立判定）
const VARIANT_FILL_PERCENT = 50;

function orbitOf(x, y, size) {
  const cells = [];
  let cur = [x, y];
  for (let i = 0; i < 4; i++) {
    cells.push(cur);
    cur = rot(cur[0], cur[1], size);
  }
  return cells;
}

// 整数 LCG（hld §4.6：唯一 Random 在 engine 内、开局前一次性消费；2^31 模域内自乘不溢出 2^53）
function makeLcg(seed) {
  let s = (seed % 2147483646) + 1; // 落在 1..2147483646
  return () => {
    s = (s * 48271) % 2147483647;
    return s;
  };
}

export function buildMap(seed = 1, opts = {}) {
  const size = opts.size ?? 64;
  const variant = opts.variant ?? DEFAULT_VARIANT;
  const SITE_SEEDS = SITE_SEEDS_BY_VARIANT[variant];
  if (!SITE_SEEDS) throw new Error(`unknown map variant: ${variant}`);
  // 声明坐标在 40×40 基准网格上；缩放后对称性仍由“代表元 → 展开轨道”保证。
  const k = size / BASE_GRID;
  const sc = (v) => Math.round(v * k);
  // ownedMineOrbits：前 N 圈资源点开局属各家（1 = 只给家门口那一圈；2/3 = 票 03 的“开局该给几圈矿”扫描）
  const ownedMineOrbits = opts.ownedMineOrbits ?? 1;
  let mineOrbit = 0;
  const scaledSites = SITE_SEEDS.map((s) => {
    const out = { ...s, rep: [sc(s.rep[0]), sc(s.rep[1])] };
    if (s.kind === 'resource' && !s.initialOwners) {
      if (mineOrbit < ownedMineOrbits) out.initialOwners = [0, 1, 2, 3];
      mineOrbit += 1;
    }
    return out;
  });
  const scaledUnits = START_UNITS.map((d) => ({ ...d, offsets: d.offsets.map(([dx, dy]) => [sc(dx), sc(dy)]) }));
  const nextId = (() => { let n = 1; return () => n++; })();

  // --- terrain：全平原 ---
  const terrain = [];
  for (let y = 0; y < size; y++) terrain.push(new Array(size).fill('plain'));

  // --- sites ---
  // `initialOwners` 存在时按轨道次序（代表元起、逆时针方向）逐格指定主基地属主；
  // 这让"每方恰好 1 个主基地"与"四重旋转对称"同时成立。
  const sites = [];
  for (const seedDef of scaledSites) {
    const orbit = orbitOf(seedDef.rep[0], seedDef.rep[1], size);
    orbit.forEach(([x, y], idx) => {
      sites.push({
        id: nextId(),
        kind: seedDef.kind,
        x,
        y,
        owner: seedDef.initialOwners ? seedDef.initialOwners[idx] : -1,
        progressOwner: -1,
        progress: 0,
        // 单矿储量取 ruleset 的 `resourcePerSite`（票 09 复跑靠它生效）。原来这里写死 125，
        // 与 ruleset 的一致只是巧合：一旦用 --set resourcePerSite=200 复跑，
        // harness 会按 3200 算百分比而地图仍按 125 生成站点，枯竭时点全线失真。
        ...(seedDef.kind === 'resource' ? { remaining: opts.resourcePerSite ?? RULESET.resourcePerSite } : {}),
      });
    });
  }
  sites.sort((a, b) => a.id - b.id);

  // --- 起始单位（地图声明的编队）---
  // 以 0 号家为参考系建格，再沿轨道取第 p 格 —— 保证四方起始条件互为 90° 旋转（初始对等）。
  const spawnUnits = [];
  const homeRep = scaledSites[0].rep; // 主基地轨道代表元
  for (let p = 0; p < 4; p++) {
    for (const def of scaledUnits) {
      for (const off of def.offsets) {
        const orbit = orbitOf(homeRep[0] + off[0], homeRep[1] + off[1], size);
        const [x, y] = orbit[p];
        spawnUnits.push({ owner: p, type: def.type, x, y });
      }
    }
  }

  // --- 种子变体：成组四重对称墙体填充（装饰性微扰）---
  const rand = makeLcg(seed);
  const siteCells = new Set(sites.map((s) => `${s.x},${s.y}`));
  const unitCells = new Set(spawnUnits.map((u) => `${u.x},${u.y}`));
  // 夹具卫生：墙格不得是点位格、不得与点位相邻、不得压住起始单位格（否则改变点位可达性/初始条件对称性）
  const forbidden = new Set();
  for (const key of [...siteCells, ...unitCells]) {
    const [sx, sy] = key.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) forbidden.add(`${sx + dx},${sy + dy}`);
    }
  }
  const variantSlots = [];
  for (const [rx0, ry0] of VARIANT_SLOT_REPS) {
    const [rx, ry] = [sc(rx0), sc(ry0)];
    // 槽位是"整条轨道填或整条不填"——否则墙集合不再四重旋转自洽。
    const cells = orbitOf(rx, ry, size).filter(([x, y]) => !forbidden.has(`${x},${y}`));
    if (rand() % 100 < VARIANT_FILL_PERCENT) {
      for (const [x, y] of cells) terrain[y][x] = 'wall';
      if (cells.length > 0) variantSlots.push(cells);
    }
  }

  return {
    name: `stub-fixture-${size}/${variant}${ownedMineOrbits !== 1 ? `/mines${ownedMineOrbits}` : ''}`,
    variant,
    size,
    seed,
    terrain,
    sites,
    spawnUnits,
    variantSlots,
  };
}

// --- 夹具自检（selftest 调用；也是 map-lint 的 throwaway 版）---

export function assertFourFoldSymmetry(map) {
  const { size, terrain, sites } = map;
  const siteKey = (x, y) => sites.find((s) => s.x === x && s.y === y);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [rx, ry] = rot(x, y, size);
      if (terrain[y][x] !== terrain[ry][rx]) {
        throw new Error(`terrain not 4-fold symmetric at ${x},${y}: ${terrain[y][x]} vs ${terrain[ry][rx]}`);
      }
      const a = siteKey(x, y);
      const b = siteKey(rx, ry);
      if ((a ? a.kind : null) !== (b ? b.kind : null)) {
        throw new Error(`sites not 4-fold symmetric at ${x},${y}: kind ${a && a.kind} vs ${b && b.kind}`);
      }
      // 属主不属于地图对称类：旋转把 0 号家映射到 1 号家。要求“旋转 +1 座位”的对等关系。
      if (a && b && a.owner >= 0 && b.owner !== (a.owner + 1) % 4) {
        throw new Error(`initial ownership not seat-rotationally equal at ${x},${y}: ${a.owner} -> ${b.owner}`);
      }
    }
  }
}

export function assertSiteInvariants(map) {
  const { terrain, sites, spawnUnits } = map;
  const seen = new Set();
  for (const s of sites) {
    if (terrain[s.y][s.x] !== 'plain') throw new Error(`site ${s.id} on wall at ${s.x},${s.y}`);
    const key = `${s.x},${s.y}`;
    if (seen.has(key)) throw new Error(`site overlap at ${key}`);
    seen.add(key);
  }
  const bases = sites.filter((s) => s.kind === 'base');
  const perOwner = new Map();
  for (const b of bases) {
    if (b.owner >= 0) perOwner.set(b.owner, (perOwner.get(b.owner) ?? 0) + 1);
  }
  for (let p = 0; p < 4; p++) {
    if (perOwner.get(p) !== 1) throw new Error(`player ${p} must have exactly 1 home base, got ${perOwner.get(p) ?? 0}`);
  }
  const neutralBases = bases.filter((b) => b.owner === -1).length;
  const mines = sites.filter((s) => s.kind === 'resource').length;
  if (neutralBases % 4 !== 0) throw new Error(`neutral base count ${neutralBases} not multiple of 4`);
  if (mines % 4 !== 0) throw new Error(`resource site count ${mines} not multiple of 4`);
  // 夹具不变量：每方开局至少 1 个自家矿（否则 tick 0 无人能采集，与 gdd §5 起始条件矛盾）
  const ownedMines = new Map();
  for (const m of sites) {
    if (m.kind === 'resource' && m.owner >= 0) ownedMines.set(m.owner, (ownedMines.get(m.owner) ?? 0) + 1);
  }
  for (let p = 0; p < 4; p++) {
    if ((ownedMines.get(p) ?? 0) < 1) throw new Error(`player ${p} has no starting resource site`);
  }
  for (const u of spawnUnits) {
    if (terrain[u.y][u.x] !== 'plain') throw new Error(`spawn unit cell is wall at ${u.x},${u.y}`);
  }
  return { bases: bases.length, neutralBases, mines, sites: sites.length, ownedMines: Object.fromEntries(ownedMines) };
}

// 全图连通性（BFS，从 0,0 出发）：墙变体不得把点位或起始位隔断
export function assertConnectivity(map) {
  const { size, terrain, sites, spawnUnits } = map;
  const start = [0, 0];
  const seen = new Set([`${start[0]},${start[1]}`]);
  const q = [start];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (q.length > 0) {
    const [x, y] = q.pop();
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      if (terrain[ny][nx] !== 'plain') continue;
      const key = `${nx},${ny}`;
      if (seen.has(key)) continue;
      seen.add(key);
      q.push([nx, ny]);
    }
  }
  for (const s of sites) {
    if (!seen.has(`${s.x},${s.y}`)) throw new Error(`site ${s.id} unreachable (wall variant isolated it)`);
  }
  for (const u of spawnUnits) {
    if (!seen.has(`${u.x},${u.y}`)) throw new Error(`spawn cell ${u.x},${u.y} unreachable`);
  }
  return seen.size;
}
