// ============================================================
// script.ts
// 策略取向：B 扩张运营
//   优先占资源点与扩张经济，攒够家底再转军事
// ============================================================

// ---- 跨 tick 记忆：只放数值 ----
var myIndexCached: number = -1;

// ---- 阈值（数值常量） ----
const TARGET_WORKERS = 6;
const TARGET_MELEE = 6;
const CARRY_LIMIT = 20;

// ---- 主循环 ----
function loop(): void {
  const me = getMyIndex();
  if (myIndexCached === -1) myIndexCached = me;

  // 本 tick 玩家状态（每 tick 重读，不缓存）
  const players = getObjectsByType("player");
  const mePlayer = players[me];
  if (mePlayer === undefined) return;
  if (!mePlayer.alive) return;
  const myRes: number = mePlayer.resources;

  // 本 tick 快照
  const myUnits = getObjectsByType("unit", { owner: me });
  const myBases = getObjectsByType("site", { owner: me, kind: "base" });
  const myResSites = getObjectsByType("site", { owner: me, kind: "resource" });
  const neutralSites = getObjectsByType("site", { owner: -1, kind: "resource" });

  // 预取敌方快照（按座位缓存一次，避免每个战斗单位重复查）
  const foeUnits: any[][] = [[], [], [], []];
  const foeBases: any[][] = [[], [], [], []];
  for (let p = 0; p < 4; p += 1) {
    if (p === me) continue;
    foeUnits[p] = getObjectsByType("unit", { owner: p });
    foeBases[p] = getObjectsByType("site", { owner: p, kind: "base" });
  }

  // 计数
  let workerN = 0;
  let meleeN = 0;
  for (let i = 0; i < myUnits.length; i += 1) {
    const u = myUnits[i];
    if (u === undefined) continue;
    if (u.type === "worker") workerN += 1;
    else if (u.type === "melee") meleeN += 1;
  }

  // ---- 生产：每个基地独立产线，先读 producing，空才下单 ----
  for (let i = 0; i < myBases.length; i += 1) {
    const base = myBases[i];
    if (base === undefined) continue;
    if (base.producing !== null) continue;

    let toSpawn: "worker" | "melee" | "ranged" | "cavalry" | null = null;
    if (workerN < TARGET_WORKERS && myRes >= 4) {
      toSpawn = "worker";
    } else if (meleeN < TARGET_MELEE && myRes >= 12) {
      toSpawn = "melee";
    } else if (myRes >= 16) {
      // 都达标后继续扩军
      toSpawn = "melee";
    }

    if (toSpawn === null) continue;
    spawnUnit(base.id, toSpawn);
  }

  // ---- 每个单位一条意图（每单位每 tick 最多一条单位级意图） ----
  for (let i = 0; i < myUnits.length; i += 1) {
    const u = myUnits[i];
    if (u === undefined) continue;
    if (u.type === "worker") {
      actWorker(u, myBases, myResSites, neutralSites, me);
    } else {
      actCombat(u, me, foeUnits, foeBases);
    }
  }
}

// ---- 农民行为：满载回家交付；空载找己方资源采集；没矿就去占中立 ----
function actWorker(
  u: any,
  myBases: any[],
  myResSites: any[],
  neutralSites: any[],
  me: number,
): void {
  // 满载：回家交付
  if (u.carrying >= CARRY_LIMIT) {
    const b = findClosestId(u.x, u.y, myBases);
    if (b === null) return;
    if (getRange(u.x, u.y, b.x, b.y) <= 1) {
      transfer(u.id);
    } else {
      moveTo(u.id, b.x, b.y);
    }
    return;
  }

  // 空载：找最近的己方有储量资源点
  const target = findOwnedWithRes(u.x, u.y, myResSites);
  if (target !== null) {
    if (getRange(u.x, u.y, target.x, target.y) <= 1) {
      harvest(u.id, target.id);
    } else {
      moveTo(u.id, target.x, target.y);
    }
    return;
  }

  // 没可采己方资源：去最近可占的中立资源点（仅当无人占或我在占）
  const cap = findCapturableNeutral(u.x, u.y, neutralSites, me);
  if (cap === null) return;
  if (getRange(u.x, u.y, cap.x, cap.y) <= 1) {
    // 站相邻格让进度累加：本 tick 不下任何动作
    return;
  }
  moveTo(u.id, cap.x, cap.y);
}

// ---- 战斗单位：射程内攻击，否则靠近敌人；无敌人则去最近敌方基地 ----
function actCombat(
  u: any,
  me: number,
  foeUnits: any[][],
  foeBases: any[][],
): void {
  // 找最近的敌方单位
  let foe: { id: number; x: number; y: number; dist: number } | null = null;
  for (let p = 0; p < 4; p += 1) {
    if (p === me) continue;
    const list = foeUnits[p];
    for (let i = 0; i < list.length; i += 1) {
      const f = list[i];
      if (f === undefined) continue;
      const d = getRange(u.x, u.y, f.x, f.y);
      if (foe === null || d < foe.dist) {
        foe = { id: f.id, x: f.x, y: f.y, dist: d };
      }
    }
  }

  // 射程：远程 2，其余 1
  const myRange = u.type === "ranged" ? 2 : 1;
  if (foe !== null && foe.dist <= myRange) {
    attack(u.id, foe.id);
    return;
  }
  if (foe !== null) {
    moveTo(u.id, foe.x, foe.y);
    return;
  }

  // 没敌人：去最近的敌方基地
  let foeBase: { x: number; y: number } | null = null;
  let foeBaseR = 0;
  for (let p = 0; p < 4; p += 1) {
    if (p === me) continue;
    const list = foeBases[p];
    for (let i = 0; i < list.length; i += 1) {
      const b = list[i];
      if (b === undefined) continue;
      const d = getRange(u.x, u.y, b.x, b.y);
      if (foeBase === null || d < foeBaseR) {
        foeBase = { x: b.x, y: b.y };
        foeBaseR = d;
      }
    }
  }
  if (foeBase !== null) moveTo(u.id, foeBase.x, foeBase.y);
}

// ---- 工具：最近对象 ----
function findClosestId(
  x: number,
  y: number,
  arr: any[],
): { x: number; y: number; id: number } | null {
  let best: { x: number; y: number; id: number } | null = null;
  let bestR = 0;
  for (let i = 0; i < arr.length; i += 1) {
    const s = arr[i];
    if (s === undefined) continue;
    const r = getRange(x, y, s.x, s.y);
    if (best === null || r < bestR) {
      best = s;
      bestR = r;
    }
  }
  return best;
}

function findOwnedWithRes(
  x: number,
  y: number,
  arr: any[],
): { x: number; y: number; id: number } | null {
  let best: { x: number; y: number; id: number } | null = null;
  let bestR = 0;
  for (let i = 0; i < arr.length; i += 1) {
    const s = arr[i];
    if (s === undefined) continue;
    if (s.remaining === undefined) continue;
    if (s.remaining <= 0) continue;
    const r = getRange(x, y, s.x, s.y);
    if (best === null || r < bestR) {
      best = { x: s.x, y: s.y, id: s.id };
      bestR = r;
    }
  }
  return best;
}

function findCapturableNeutral(
  x: number,
  y: number,
  arr: any[],
  me: number,
): { x: number; y: number; id: number } | null {
  let best: { x: number; y: number; id: number } | null = null;
  let bestR = 0;
  for (let i = 0; i < arr.length; i += 1) {
    const s = arr[i];
    if (s === undefined) continue;
    // 仅当无人占（-1）或正在被我这方占时考虑
    if (s.progressOwner !== -1 && s.progressOwner !== me) continue;
    const r = getRange(x, y, s.x, s.y);
    if (best === null || r < bestR) {
      best = { x: s.x, y: s.y, id: s.id };
      bestR = r;
    }
  }
  return best;
}
