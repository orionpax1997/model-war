// ============================================================
// 四方 RTS 盲写参赛脚本 v1（初版，未改一字）
// 策略取向：C 农民海
// 自认候选：B（自标记）
// 轮转方向假设：值大者胜（(tick + playerIndex) mod 4 大者先）
// ============================================================

type UnitType = 'worker' | 'melee' | 'ranged' | 'cavalry';

type UnitView = {
  id: number; owner: number; type: UnitType;
  x: number; y: number; hp: number; carrying: number;
};

type SiteView = {
  id: number; kind: 'base' | 'resource';
  x: number; y: number; owner: number;
  progressOwner: number; progress: number; remaining?: number;
};

// ---- 数值常量（rules.md §10，全整数） ----
const K_WORKER_COST = 4;
const K_WORKER_SPAWN = 2;
const K_CARRY_LIMIT = 20;
const K_CAPTURE_TICKS = 10;
const K_TICK_LIMIT = 600;
const K_WORKER_CAP = 40;
const K_FAR = 1000000;

const K_DIRS8: number[][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [-1, -1], [1, -1], [-1, 1]
];

// ---- 模块级记忆（只存数值 id / 数值） ----
let myIndex = -1;                       // 候选 B 自标记识别结果
let markState = 0;                      // 0 未标记 / 1 已发标记待观察 / 2 完成
let markIds: number[] = [];
let markTX: number[] = [];
let markTY: number[] = [];
let baseReady: Map<number, number> = new Map();  // baseId -> 下次可下单 tick
let goalOf: Map<number, number> = new Map();     // unitId -> siteId
let roleOf: Map<number, number> = new Map();     // unitId -> 1 采集 / 2 占领

// ---------- 自标记（候选 B） ----------
function beginMark(): void {
  markIds = [];
  markTX = [];
  markTY = [];
  const all = getObjectsByType('unit');
  for (let i = 0; i < all.length; i++) {
    const u = all[i] as UnitView;
    const d = K_DIRS8[u.id % 8];
    const tx = u.x + d[0];
    const ty = u.y + d[1];
    if (getTerrainAt(tx, ty) !== 'plain') continue;
    markIds.push(u.id);
    markTX.push(tx);
    markTY.push(ty);
    move(u.id, d[0] as -1 | 0 | 1, d[1] as -1 | 0 | 1);
  }
  markState = 1;
}

function endMark(): boolean {
  let found = -1;
  for (let i = 0; i < markIds.length; i++) {
    const o = getObjectById(markIds[i]);
    if (!o) continue;
    const u = o as UnitView;
    if (u.x === markTX[i] && u.y === markTY[i]) {
      found = u.owner;
      break;
    }
  }
  markIds = [];
  markTX = [];
  markTY = [];
  if (found >= 0) {
    myIndex = found;
    markState = 2;
    return true;
  }
  markState = 0;
  return false;
}

// ---------- 小工具 ----------
function nearestBase(bases: SiteView[], x: number, y: number): SiteView | null {
  let best: SiteView | null = null;
  let bd = K_FAR;
  for (let i = 0; i < bases.length; i++) {
    const d = getRange(x, y, bases[i].x, bases[i].y);
    if (d < bd) { bd = d; best = bases[i]; }
  }
  return best;
}

function nearestSite(list: SiteView[], x: number, y: number): SiteView | null {
  let best: SiteView | null = null;
  let bd = K_FAR;
  for (let i = 0; i < list.length; i++) {
    const d = getRange(x, y, list[i].x, list[i].y);
    if (d < bd) { bd = d; best = list[i]; }
  }
  return best;
}

function openAdjacent(sx: number, sy: number): number[] {
  for (let i = 0; i < K_DIRS8.length; i++) {
    const x = sx + K_DIRS8[i][0];
    const y = sy + K_DIRS8[i][1];
    if (getTerrainAt(x, y) === 'plain') return [x, y];
  }
  return [sx, sy];
}

// ---------- 入口 ----------
function loop(): void {
  if (myIndex < 0) {
    if (markState === 0) { beginMark(); return; }
    if (markState === 1) { if (!endMark()) return; }
    if (myIndex < 0) return;
  }

  const tick = getTick();

  const unitsRaw = getObjectsByType('unit', { owner: myIndex as 0 | 1 | 2 | 3 });
  const myWorkers: UnitView[] = [];
  for (let i = 0; i < unitsRaw.length; i++) {
    const u = unitsRaw[i] as UnitView;
    if (u.type === 'worker') myWorkers.push(u);
  }

  const sitesRaw = getObjectsByType('site');
  const myBases: SiteView[] = [];
  const capturable: SiteView[] = [];
  const harvestSpots: SiteView[] = [];
  for (let i = 0; i < sitesRaw.length; i++) {
    const s = sitesRaw[i] as SiteView;
    if (s.kind === 'base' && s.owner === myIndex) {
      myBases.push(s);
    }
    if (s.kind === 'resource' && s.owner === myIndex) {
      if (s.remaining === undefined || s.remaining > 0) harvestSpots.push(s);
    } else if (s.owner !== myIndex) {
      capturable.push(s);
    }
  }

  // ---- 生产：农民海 ----
  for (let i = 0; i < myBases.length; i++) {
    const b = myBases[i];
    const ready = baseReady.get(b.id);
    if (ready !== undefined && tick < ready) continue;
    if (myWorkers.length >= K_WORKER_CAP) continue;
    const r = spawnUnit(b.id, 'worker');
    if (typeof r !== 'string') baseReady.set(b.id, tick + K_WORKER_SPAWN + 1);
  }

  // ---- 目标表 ----
  const capById: Map<number, SiteView> = new Map();
  for (let i = 0; i < capturable.length; i++) capById.set(capturable[i].id, capturable[i]);
  const harById: Map<number, SiteView> = new Map();
  for (let i = 0; i < harvestSpots.length; i++) harById.set(harvestSpots[i].id, harvestSpots[i]);

  const liveSet: Map<number, number> = new Map();
  for (let i = 0; i < myWorkers.length; i++) liveSet.set(myWorkers[i].id, 1);

  // 清理失效目标
  const gk = Array.from(goalOf.keys());
  for (let i = 0; i < gk.length; i++) {
    const uid = gk[i];
    if (!liveSet.has(uid)) { goalOf.delete(uid); roleOf.delete(uid); continue; }
    const sid = goalOf.get(uid) as number;
    const role = roleOf.get(uid);
    if (role === 2 && !capById.has(sid)) { goalOf.delete(uid); roleOf.delete(uid); }
    if (role === 1 && !harById.has(sid)) { goalOf.delete(uid); roleOf.delete(uid); }
  }

  // 占领认领表（每点一人）
  const claim: Map<number, number> = new Map();
  const gk2 = Array.from(goalOf.keys());
  for (let i = 0; i < gk2.length; i++) {
    const uid = gk2[i];
    if (roleOf.get(uid) === 2) claim.set(goalOf.get(uid) as number, uid);
  }

  // 给空闲农民派活：先占点，再采集
  for (let i = 0; i < myWorkers.length; i++) {
    const u = myWorkers[i];
    if (goalOf.has(u.id)) continue;
    let best: SiteView | null = null;
    let bd = K_FAR;
    for (let j = 0; j < capturable.length; j++) {
      const s = capturable[j];
      if (claim.has(s.id)) continue;
      const d = getRange(u.x, u.y, s.x, s.y);
      if (d < bd) { bd = d; best = s; }
    }
    if (best !== null) {
      goalOf.set(u.id, best.id);
      roleOf.set(u.id, 2);
      claim.set(best.id, u.id);
      continue;
    }
    const h = nearestSite(harvestSpots, u.x, u.y);
    if (h !== null) {
      goalOf.set(u.id, h.id);
      roleOf.set(u.id, 1);
    }
  }

  // ---- 下达最终意图（每单位一 tick 一条） ----
  for (let i = 0; i < myWorkers.length; i++) {
    const u = myWorkers[i];

    if (u.carrying >= K_CARRY_LIMIT) {
      const b = nearestBase(myBases, u.x, u.y);
      if (b !== null) {
        if (getRange(u.x, u.y, b.x, b.y) === 1) {
          transfer(u.id);
        } else {
          const adj = openAdjacent(b.x, b.y);
          moveTo(u.id, adj[0], adj[1]);
        }
        continue;
      }
    }

    const role = roleOf.get(u.id);
    const gid = goalOf.get(u.id);
    if (role === undefined || gid === undefined) {
      const e = nearestSite(capturable, u.x, u.y);
      if (e !== null) moveTo(u.id, e.x, e.y);
      continue;
    }

    const site = getObjectById(gid) as SiteView | null;
    if (!site) { goalOf.delete(u.id); roleOf.delete(u.id); continue; }

    if (role === 2) {
      if (u.x === site.x && u.y === site.y) continue; // 站定占领
      moveTo(u.id, site.x, site.y);
    } else {
      if (getRange(u.x, u.y, site.x, site.y) === 1) {
        harvest(u.id, site.id);
      } else {
        const adj = openAdjacent(site.x, site.y);
        moveTo(u.id, adj[0], adj[1]);
      }
    }
  }
}
