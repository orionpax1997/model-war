// script.ts — rules-v1, strategy A (爆兵压制)
//
// Self-contained single file. No imports/exports, no host bridges, integers only.
//
// Plan:
//   - seat comes only from getMyIndex(); kept as one module-level number
//   - keep a tiny worker floor, then spend everything else on melee
//   - read each base's producing first; order only when the line is empty
//   - exactly one unit-level intent per unit per tick: harvest/transfer for
//     workers, attack-or-advance for combat units; otherwise press a point

var myIndex = -1;

function loop() {
  if (myIndex < 0) {
    myIndex = getMyIndex();
  }
  const me = getMyIndex();

  const players = getObjectsByType("player");
  const myRow = players[me];
  if (myRow === undefined) {
    return;
  }

  const myUnits = getObjectsByType("unit", { owner: me });
  const myBases = getObjectsByType("site", { owner: me, kind: "base" });
  const mySites = getObjectsByType("site", { owner: me, kind: "resource" });
  const allUnits = getObjectsByType("unit");
  const allSites = getObjectsByType("site");

  // ---- production: read the line, order only if it is empty ----
  let workerCount = 0;
  for (let i = 0; i < myUnits.length; i += 1) {
    const u = myUnits[i];
    if (u === undefined) {
      continue;
    }
    if (u.type === "worker") {
      workerCount += 1;
    }
  }
  for (let i = 0; i < myBases.length; i += 1) {
    const b = myBases[i];
    if (b === undefined) {
      continue;
    }
    if (b.producing !== null && b.producing.type === "worker") {
      workerCount += 1;
    }
  }

  let budget = myRow.resources;
  const targetWorkers = 2;
  for (let i = 0; i < myBases.length; i += 1) {
    const base = myBases[i];
    if (base === undefined) {
      continue;
    }
    if (base.producing !== null) {
      continue;
    }
    if (budget < 4) {
      continue;
    }
    let buildType: "worker" | "melee" | "ranged" | "cavalry" = "melee";
    if (workerCount < targetWorkers) {
      buildType = "worker";
    }
    const cost = costOf(buildType);
    if (budget < cost) {
      continue;
    }
    const order = spawnUnit(base.id, buildType);
    if (isError(order)) {
      const code = errCode(order);
      if (code === ERR_NOT_ENOUGH_RESOURCES) {
        continue;
      }
    } else {
      budget -= cost;
      if (buildType === "worker") {
        workerCount += 1;
      }
    }
  }

  // ---- one unit-level intent per unit ----
  for (let i = 0; i < myUnits.length; i += 1) {
    const u = myUnits[i];
    if (u === undefined) {
      continue;
    }
    if (u.type === "worker") {
      actWorker(u, mySites, myBases);
    } else {
      actCombat(u, allUnits, allSites);
    }
  }
}

/** Unit cost in the value table: 4 / 8 / 12 / 16. */
function costOf(t: "worker" | "melee" | "ranged" | "cavalry"): number {
  if (t === "worker") {
    return 4;
  }
  if (t === "melee") {
    return 8;
  }
  if (t === "ranged") {
    return 12;
  }
  return 16;
}

/** Attack reach in the value table: only the ranged unit gets 2. */
function attackRangeOf(t: "worker" | "melee" | "ranged" | "cavalry"): number {
  if (t === "ranged") {
    return 2;
  }
  return 1;
}

/** Chebyshev distance, integer only; the same number getRange reports. */
function cheb(ax: number, ay: number, bx: number, by: number): number {
  let dx = ax - bx;
  if (dx < 0) {
    dx = -dx;
  }
  let dy = ay - by;
  if (dy < 0) {
    dy = -dy;
  }
  if (dx > dy) {
    return dx;
  }
  return dy;
}

/** Nearest own base, or null when no base is left. */
function nearestBase(
  ux: number,
  uy: number,
  bases: readonly { id: number; x: number; y: number }[],
): { id: number; x: number; y: number } | null {
  let found = false;
  let bestId = -1;
  let bestX = 0;
  let bestY = 0;
  let bestD = 0;
  for (let i = 0; i < bases.length; i += 1) {
    const b = bases[i];
    if (b === undefined) {
      continue;
    }
    const d = cheb(ux, uy, b.x, b.y);
    if (!found || d < bestD) {
      found = true;
      bestD = d;
      bestId = b.id;
      bestX = b.x;
      bestY = b.y;
    }
  }
  if (!found) {
    return null;
  }
  return { id: bestId, x: bestX, y: bestY };
}

/** Nearest own resource site that still has ore, or null. */
function nearestResource(
  ux: number,
  uy: number,
  sites: readonly { id: number; x: number; y: number; remaining?: number }[],
): { id: number; x: number; y: number } | null {
  let found = false;
  let bestId = -1;
  let bestX = 0;
  let bestY = 0;
  let bestD = 0;
  for (let i = 0; i < sites.length; i += 1) {
    const s = sites[i];
    if (s === undefined) {
      continue;
    }
    if (s.remaining !== undefined && s.remaining <= 0) {
      continue;
    }
    const d = cheb(ux, uy, s.x, s.y);
    if (!found || d < bestD) {
      found = true;
      bestD = d;
      bestId = s.id;
      bestX = s.x;
      bestY = s.y;
    }
  }
  if (!found) {
    return null;
  }
  return { id: bestId, x: bestX, y: bestY };
}

/** Nearest site this player does not own, or null; used to press points. */
function nearestNonOwned(
  ux: number,
  uy: number,
  sites: readonly { id: number; x: number; y: number; owner: number }[],
  owner: number,
): { id: number; x: number; y: number } | null {
  let found = false;
  let bestId = -1;
  let bestX = 0;
  let bestY = 0;
  let bestD = 0;
  for (let i = 0; i < sites.length; i += 1) {
    const s = sites[i];
    if (s === undefined) {
      continue;
    }
    if (s.owner === owner) {
      continue;
    }
    const d = cheb(ux, uy, s.x, s.y);
    if (!found || d < bestD) {
      found = true;
      bestD = d;
      bestId = s.id;
      bestX = s.x;
      bestY = s.y;
    }
  }
  if (!found) {
    return null;
  }
  return { id: bestId, x: bestX, y: bestY };
}

/** A worker either fills up at an owned site or delivers adjacent to a base. */
function actWorker(
  u: { id: number; x: number; y: number; carrying: number },
  sites: readonly { id: number; x: number; y: number; remaining?: number }[],
  bases: readonly { id: number; x: number; y: number }[],
): void {
  if (u.carrying >= 20) {
    const base = nearestBase(u.x, u.y, bases);
    if (base === null) {
      return;
    }
    if (cheb(u.x, u.y, base.x, base.y) <= 1) {
      const result = transfer(u.id);
      if (isError(result)) {
        const code = errCode(result);
        if (code === ERR_INVALID_UNIT) {
          return;
        }
      }
      return;
    }
    const moved = moveTo(u.id, base.x, base.y);
    if (isError(moved)) {
      const code = errCode(moved);
      if (code === ERR_INVALID_UNIT) {
        return;
      }
    }
    return;
  }

  const site = nearestResource(u.x, u.y, sites);
  if (site === null) {
    return;
  }
  if (cheb(u.x, u.y, site.x, site.y) <= 1) {
    const result = harvest(u.id, site.id);
    if (isError(result)) {
      const code = errCode(result);
      if (code === ERR_INVALID_UNIT) {
        return;
      }
    }
    return;
  }
  const moved = moveTo(u.id, site.x, site.y);
  if (isError(moved)) {
    const code = errCode(moved);
    if (code === ERR_INVALID_UNIT) {
      return;
    }
  }
}

/** A combat unit attacks what is in reach, else closes in, else presses a point. */
function actCombat(
  u: {
    id: number;
    x: number;
    y: number;
    type: "worker" | "melee" | "ranged" | "cavalry";
    owner: number;
  },
  allUnits: readonly { id: number; x: number; y: number; owner: number }[],
  allSites: readonly { id: number; x: number; y: number; owner: number }[],
): void {
  let foundEnemy = false;
  let enemyId = -1;
  let enemyX = 0;
  let enemyY = 0;
  let enemyD = 0;
  for (let i = 0; i < allUnits.length; i += 1) {
    const v = allUnits[i];
    if (v === undefined) {
      continue;
    }
    if (v.owner === u.owner) {
      continue;
    }
    const d = cheb(u.x, u.y, v.x, v.y);
    if (!foundEnemy || d < enemyD) {
      foundEnemy = true;
      enemyD = d;
      enemyId = v.id;
      enemyX = v.x;
      enemyY = v.y;
    }
  }

  if (foundEnemy) {
    if (enemyD <= attackRangeOf(u.type)) {
      const result = attack(u.id, enemyId);
      if (isError(result)) {
        const code = errCode(result);
        if (code === ERR_INVALID_UNIT) {
          return;
        }
      }
      return;
    }
    const moved = moveTo(u.id, enemyX, enemyY);
    if (isError(moved)) {
      const code = errCode(moved);
      if (code === ERR_INVALID_UNIT) {
        return;
      }
    }
    return;
  }

  const site = nearestNonOwned(u.x, u.y, allSites, u.owner);
  if (site === null) {
    return;
  }
  if (cheb(u.x, u.y, site.x, site.y) === 0) {
    return;
  }
  const moved = moveTo(u.id, site.x, site.y);
  if (isError(moved)) {
    const code = errCode(moved);
    if (code === ERR_INVALID_UNIT) {
      return;
    }
  }
}
