var myIndex = -1;
var pickX = -1;
var pickY = -1;

function loop(): void {
  myIndex = getMyIndex();
  const tick = getTick();
  const me = myIndex;

  const players = getObjectsByType("player");
  const minePlayer = players[me];
  if (minePlayer === undefined || minePlayer.alive === false) {
    return;
  }

  const sites = getObjectsByType("site");
  const allUnits = getObjectsByType("unit");

  const myUnits: Unit[] = [];
  const enemies: Unit[] = [];
  const unitCells: { [key: string]: boolean } = {};
  const blockedCells: { [key: string]: boolean } = {};
  const terrainCache: { [key: string]: string } = {};

  for (let i = 0; i < allUnits.length; i += 1) {
    const u = allUnits[i];
    if (u === undefined) {
      continue;
    }
    const key = cellKey(u.x, u.y);
    unitCells[key] = true;
    blockedCells[key] = true;
    if (u.owner === me) {
      myUnits.push(u);
    } else if (u.owner >= 0) {
      enemies.push(u);
    }
  }

  for (let i = 0; i < sites.length; i += 1) {
    const s = sites[i];
    if (s === undefined) {
      continue;
    }
    blockedCells[cellKey(s.x, s.y)] = true;
  }

  const myBases: Site[] = [];
  const myResources: Site[] = [];
  const myActiveRes: Site[] = [];
  const neutralBases: Site[] = [];
  const neutralResources: Site[] = [];
  const enemyBases: Site[] = [];
  const enemyResources: Site[] = [];

  let primaryBase: Site | null = null;
  let focusX = 0;
  let focusY = 0;

  for (let i = 0; i < sites.length; i += 1) {
    const s = sites[i];
    if (s === undefined) {
      continue;
    }
    if (s.owner === me) {
      if (s.kind === "base") {
        myBases.push(s);
        if (primaryBase === null || s.id < primaryBase.id) {
          primaryBase = s;
        }
      } else {
        myResources.push(s);
        if (siteRemaining(s) > 0) {
          myActiveRes.push(s);
        }
      }
    } else if (s.owner === -1) {
      if (s.kind === "base") {
        neutralBases.push(s);
      } else {
        neutralResources.push(s);
      }
    } else {
      if (s.kind === "base") {
        enemyBases.push(s);
      } else {
        enemyResources.push(s);
      }
    }
  }

  if (primaryBase !== null) {
    focusX = primaryBase.x;
    focusY = primaryBase.y;
  } else if (myUnits.length > 0) {
    const u0 = myUnits[0];
    if (u0 !== undefined) {
      focusX = u0.x;
      focusY = u0.y;
    }
  }

  let workerCount = 0;
  let meleeCount = 0;
  let rangedCount = 0;
  for (let i = 0; i < myUnits.length; i += 1) {
    const u = myUnits[i];
    if (u === undefined) {
      continue;
    }
    if (u.type === "worker") {
      workerCount += 1;
    } else if (u.type === "melee") {
      meleeCount += 1;
    } else if (u.type === "ranged") {
      rangedCount += 1;
    }
  }
  let militaryCount = myUnits.length - workerCount;

  let threat = 0;
  for (let i = 0; i < enemies.length; i += 1) {
    const e = enemies[i];
    if (e === undefined) {
      continue;
    }
    if (primaryBase !== null && cheb(e.x, e.y, primaryBase.x, primaryBase.y) <= 6) {
      threat += 1;
      continue;
    }
    let near = false;
    for (let j = 0; j < myBases.length; j += 1) {
      const b = myBases[j];
      if (b !== undefined && cheb(e.x, e.y, b.x, b.y) <= 3) {
        near = true;
      }
    }
    if (!near) {
      for (let j = 0; j < myResources.length; j += 1) {
        const r = myResources[j];
        if (r !== undefined && cheb(e.x, e.y, r.x, r.y) <= 3) {
          near = true;
        }
      }
    }
    if (near) {
      threat += 1;
    }
  }

  const resourceTarget = 8;
  const baseTarget = 2;
  const ownedActiveRes = myActiveRes.length;
  const ownedBases = myBases.length;

  let workerTarget = 8;
  if (tick >= 40) {
    workerTarget = ownedActiveRes * 2;
    if (workerTarget < 4) {
      workerTarget = 4;
    }
    if (workerTarget > 10) {
      workerTarget = 10;
    }
  }
  if (tick >= 180) {
    workerTarget = ownedActiveRes * 2 + 2;
    if (workerTarget < 4) {
      workerTarget = 4;
    }
    if (workerTarget > 12) {
      workerTarget = 12;
    }
  }

  let militaryTarget = 0;
  if (tick >= 45) {
    militaryTarget = 2;
  }
  if (tick >= 90) {
    militaryTarget = 4;
  }
  if (tick >= 150) {
    militaryTarget = 6;
  }
  if (tick >= 240) {
    militaryTarget = 9;
  }
  if (tick >= 360) {
    militaryTarget = 12;
  }
  if (tick >= 480) {
    militaryTarget = 16;
  }
  if (threat > 0) {
    militaryTarget += 2;
  }

  let workerCaptureSiteId = -1;
  let bestCaptureDist = 0;
  for (let i = 0; i < sites.length; i += 1) {
    const s = sites[i];
    if (s === undefined) {
      continue;
    }
    if (s.owner !== me && s.kind === "resource" && s.progressOwner === me && s.progress > 0) {
      const d = cheb(focusX, focusY, s.x, s.y);
      if (workerCaptureSiteId === -1 || d < bestCaptureDist) {
        workerCaptureSiteId = s.id;
        bestCaptureDist = d;
      }
    }
  }

  if (workerCaptureSiteId === -1 && (workerCount > ownedActiveRes || ownedActiveRes === 0)) {
    const needRes = ownedActiveRes < resourceTarget;
    const needBase = ownedBases < baseTarget || ownedBases === 0;
    let target: Site | null = null;

    if (needRes) {
      target = nearestSafeSite(neutralResources, focusX, focusY, enemies, 3, true);
      if (target === null) {
        target = nearestSafeSite(enemyResources, focusX, focusY, enemies, 3, true);
      }
    }

    if (target === null && needBase) {
      target = nearestSafeSite(neutralBases, focusX, focusY, enemies, 3, false);
      if (target === null && ownedBases === 0) {
        target = nearestSite(enemyBases, focusX, focusY, false);
      }
    }

    if (target !== null) {
      workerCaptureSiteId = target.id;
    }
  }

  let militaryCaptureSiteId = -1;
  bestCaptureDist = 0;
  for (let i = 0; i < sites.length; i += 1) {
    const s = sites[i];
    if (s === undefined) {
      continue;
    }
    if (s.owner !== me && s.kind === "base" && s.progressOwner === me && s.progress > 0) {
      const d = cheb(focusX, focusY, s.x, s.y);
      if (militaryCaptureSiteId === -1 || d < bestCaptureDist) {
        militaryCaptureSiteId = s.id;
        bestCaptureDist = d;
      }
    }
  }

  if (militaryCaptureSiteId === -1 && tick >= 150 && militaryCount >= 5) {
    let target = nearestSite(enemyBases, focusX, focusY, false);
    if (target === null) {
      target = nearestSite(enemyResources, focusX, focusY, false);
    }
    if (target !== null) {
      militaryCaptureSiteId = target.id;
    }
  }

  if (militaryCaptureSiteId === -1 && ownedBases < baseTarget && tick >= 80 && militaryCount >= 3) {
    const target = nearestSafeSite(neutralBases, focusX, focusY, enemies, 3, false);
    if (target !== null) {
      militaryCaptureSiteId = target.id;
    }
  }

  if (militaryCaptureSiteId === -1 && tick >= 180 && militaryCount >= 6) {
    let target = nearestSite(neutralBases, focusX, focusY, false);
    if (target === null) {
      target = nearestSite(neutralResources, focusX, focusY, false);
    }
    if (target !== null) {
      militaryCaptureSiteId = target.id;
    }
  }

  let captureWorkerId = -1;
  if (workerCaptureSiteId >= 0) {
    const target = findSiteById(sites, workerCaptureSiteId);
    if (target !== null) {
      let haveWorker = false;
      let bestWorkerDist = 0;
      for (let i = 0; i < myUnits.length; i += 1) {
        const u = myUnits[i];
        if (u === undefined || u.type !== "worker") {
          continue;
        }
        if (u.carrying !== 0) {
          continue;
        }
        const d = cheb(u.x, u.y, target.x, target.y);
        if (!haveWorker || d < bestWorkerDist) {
          haveWorker = true;
          bestWorkerDist = d;
          captureWorkerId = u.id;
        }
      }
    }
  }

  if (militaryCaptureSiteId === workerCaptureSiteId && captureWorkerId >= 0) {
    militaryCaptureSiteId = -1;
  }

  let strikeSlots = 0;
  if (militaryCaptureSiteId >= 0) {
    if (militaryCount >= 8) {
      strikeSlots = 3;
    } else if (militaryCount >= 5) {
      strikeSlots = 2;
    } else if (militaryCount >= 1) {
      strikeSlots = 1;
    }
  }

  let res = minePlayer.resources;
  for (let i = 0; i < myBases.length; i += 1) {
    const base = myBases[i];
    if (base === undefined || base.producing !== null) {
      continue;
    }
    if (unitCells[cellKey(base.x, base.y)] === true) {
      continue;
    }

    const needWorker = workerCount < workerTarget;
    const needMilitary = militaryCount < militaryTarget || threat > 0;
    let spawnType: UnitType = "melee";
    let chosen = false;

    if (needWorker && res >= 4 && (!needMilitary || res < 8 || (tick < 40 && threat === 0))) {
      spawnType = "worker";
      chosen = true;
    } else if (needMilitary) {
      if (meleeCount > 0 && rangedCount * 2 < meleeCount && res >= 12) {
        spawnType = "ranged";
        chosen = true;
      } else if (res >= 8) {
        spawnType = "melee";
        chosen = true;
      } else if (needWorker && res >= 4) {
        spawnType = "worker";
        chosen = true;
      }
    }

    if (!chosen && res >= 8) {
      spawnType = "melee";
      chosen = true;
    } else if (!chosen && res >= 4 && (workerCount < workerTarget || ownedActiveRes < resourceTarget)) {
      spawnType = "worker";
      chosen = true;
    }

    if (!chosen) {
      continue;
    }

    const result = spawnUnit(base.id, spawnType);
    if (isError(result)) {
      const code = errCode(result);
      if (code === ERR_NOT_ENOUGH_RESOURCES) {
        continue;
      }
      continue;
    }

    if (spawnType === "worker") {
      res -= 4;
      workerCount += 1;
    } else if (spawnType === "ranged") {
      res -= 12;
      rangedCount += 1;
      militaryCount += 1;
    } else {
      res -= 8;
      meleeCount += 1;
      militaryCount += 1;
    }
  }

  let strikeAssigned = 0;
  for (let i = 0; i < myUnits.length; i += 1) {
    const u = myUnits[i];
    if (u === undefined) {
      continue;
    }

    const isCaptureWorker = u.type === "worker" && u.id === captureWorkerId;
    const isStrike = u.type !== "worker" && militaryCaptureSiteId >= 0 && strikeAssigned < strikeSlots;
    if (isStrike) {
      strikeAssigned += 1;
    }

    if (u.type === "worker") {
      handleWorker(u, me, myBases, myActiveRes, sites, enemies, blockedCells, terrainCache, workerCaptureSiteId, isCaptureWorker, primaryBase);
    } else {
      handleMilitary(u, tick, myBases, enemies, sites, blockedCells, terrainCache, militaryCaptureSiteId, isStrike, primaryBase);
    }
  }
}

function handleWorker(
  u: Unit,
  me: number,
  myBases: Site[],
  myActiveRes: Site[],
  sites: Site[],
  enemies: Unit[],
  blocked: { [key: string]: boolean },
  cache: { [key: string]: string },
  workerCaptureSiteId: number,
  isCaptureWorker: boolean,
  primaryBase: Site | null
): void {
  if (isOnOwnBase(u, myBases)) {
    if (moveOffBase(u, blocked, cache)) {
      return;
    }
  }

  const foe = nearestEnemy(u.x, u.y, enemies, true);
  if (foe !== null && cheb(u.x, u.y, foe.x, foe.y) <= 2) {
    if (pickFleeCell(u, foe, blocked, cache)) {
      moveStep(u.id, pickX, pickY);
      return;
    }
    const dx = u.x - foe.x;
    const dy = u.y - foe.y;
    let mx = 0;
    let my = 0;
    if (dx > 0) {
      mx = 1;
    } else if (dx < 0) {
      mx = -1;
    }
    if (dy > 0) {
      my = 1;
    } else if (dy < 0) {
      my = -1;
    }
    if (mx !== 0 || my !== 0) {
      moveStep(u.id, mx, my);
    }
    return;
  }

  if (isCaptureWorker && workerCaptureSiteId >= 0) {
    const target = findSiteById(sites, workerCaptureSiteId);
    if (target !== null) {
      if (u.x === target.x && u.y === target.y) {
        return;
      }
      moveTo(u.id, target.x, target.y);
      return;
    }
  }

  const needDeliver = u.carrying >= 20 || (u.carrying > 0 && myActiveRes.length === 0);
  if (needDeliver) {
    if (myBases.length > 0) {
      const base = nearestSite(myBases, u.x, u.y, false);
      if (base !== null) {
        const d = cheb(u.x, u.y, base.x, base.y);
        if (d === 1) {
          transfer(u.id);
          return;
        }
        if (pickFreeAdjacent(base.x, base.y, blocked, cache, u.id, -1, -1, false)) {
          moveTo(u.id, pickX, pickY);
          return;
        }
        return;
      }
    }
    if (u.carrying >= 20) {
      return;
    }
  }

  if (myActiveRes.length > 0) {
    const site = nearestSite(myActiveRes, u.x, u.y, false);
    if (site !== null) {
      const d = cheb(u.x, u.y, site.x, site.y);
      if (d === 1) {
        harvest(u.id, site.id);
        return;
      }

      let preferX = -1;
      let preferY = -1;
      let usePrefer = false;
      if (myBases.length > 0) {
        const b = nearestSite(myBases, site.x, site.y, false);
        if (b !== null) {
          preferX = b.x;
          preferY = b.y;
          usePrefer = true;
        }
      }

      if (pickFreeAdjacent(site.x, site.y, blocked, cache, u.id, preferX, preferY, usePrefer)) {
        moveTo(u.id, pickX, pickY);
        return;
      }
    }
  }

  if (primaryBase !== null && cheb(u.x, u.y, primaryBase.x, primaryBase.y) > 1) {
    if (pickFreeAdjacent(primaryBase.x, primaryBase.y, blocked, cache, u.id, -1, -1, false)) {
      moveTo(u.id, pickX, pickY);
      return;
    }
  }
}

function handleMilitary(
  u: Unit,
  tick: number,
  myBases: Site[],
  enemies: Unit[],
  sites: Site[],
  blocked: { [key: string]: boolean },
  cache: { [key: string]: string },
  militaryCaptureSiteId: number,
  isStrike: boolean,
  primaryBase: Site | null
): void {
  if (isOnOwnBase(u, myBases)) {
    if (moveOffBase(u, blocked, cache)) {
      return;
    }
  }

  const foe = nearestEnemy(u.x, u.y, enemies, false);
  const r = unitRange(u);

  if (foe !== null && cheb(u.x, u.y, foe.x, foe.y) <= 4) {
    if (cheb(u.x, u.y, foe.x, foe.y) <= r) {
      attack(u.id, foe.id);
    } else {
      moveTo(u.id, foe.x, foe.y);
    }
    return;
  }

  if (isStrike && militaryCaptureSiteId >= 0) {
    const target = findSiteById(sites, militaryCaptureSiteId);
    if (target !== null) {
      if (u.x === target.x && u.y === target.y) {
        if (foe !== null && cheb(u.x, u.y, foe.x, foe.y) <= r) {
          attack(u.id, foe.id);
        }
        return;
      }

      const occupant = findUnitAt(target.x, target.y, enemies);
      if (occupant !== null && cheb(u.x, u.y, occupant.x, occupant.y) <= r) {
        attack(u.id, occupant.id);
        return;
      }

      moveTo(u.id, target.x, target.y);
      return;
    }
  }

  if (primaryBase !== null) {
    const d = cheb(u.x, u.y, primaryBase.x, primaryBase.y);
    if (d <= 1) {
      return;
    }
    if (pickFreeAdjacent(primaryBase.x, primaryBase.y, blocked, cache, u.id + tick, -1, -1, false)) {
      moveTo(u.id, pickX, pickY);
      return;
    }
  }

  if (foe !== null) {
    if (cheb(u.x, u.y, foe.x, foe.y) <= r) {
      attack(u.id, foe.id);
    } else {
      moveTo(u.id, foe.x, foe.y);
    }
  }
}

function moveStep(unitId: number, dx: number, dy: number): void {
  if (dx < -1 || dx > 1 || dy < -1 || dy > 1) {
    return;
  }
  if (dx === -1) {
    if (dy === -1) {
      move(unitId, -1, -1);
    } else if (dy === 0) {
      move(unitId, -1, 0);
    } else {
      move(unitId, -1, 1);
    }
  } else if (dx === 0) {
    if (dy === -1) {
      move(unitId, 0, -1);
    } else if (dy === 0) {
      move(unitId, 0, 0);
    } else {
      move(unitId, 0, 1);
    }
  } else {
    if (dy === -1) {
      move(unitId, 1, -1);
    } else if (dy === 0) {
      move(unitId, 1, 0);
    } else {
      move(unitId, 1, 1);
    }
  }
}

function cheb(ax: number, ay: number, bx: number, by: number): number {
  let dx = ax - bx;
  if (dx < 0) {
    dx = -dx;
  }
  let dy = ay - by;
  if (dy < 0) {
    dy = -dy;
  }
  return dx > dy ? dx : dy;
}

function siteRemaining(s: Site): number {
  if (s.kind !== "resource") {
    return 0;
  }
  const r = s.remaining;
  if (r === undefined) {
    return 0;
  }
  return r;
}

function findSiteById(sites: Site[], id: number): Site | null {
  for (let i = 0; i < sites.length; i += 1) {
    const s = sites[i];
    if (s !== undefined && s.id === id) {
      return s;
    }
  }
  return null;
}

function findUnitAt(x: number, y: number, units: Unit[]): Unit | null {
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if (u !== undefined && u.x === x && u.y === y) {
      return u;
    }
  }
  return null;
}

function nearestSite(sites: Site[], x: number, y: number, needRemaining: boolean): Site | null {
  let best: Site | null = null;
  let bestDist = 0;
  for (let i = 0; i < sites.length; i += 1) {
    const s = sites[i];
    if (s === undefined) {
      continue;
    }
    if (needRemaining && siteRemaining(s) <= 0) {
      continue;
    }
    const d = cheb(x, y, s.x, s.y);
    if (best === null || d < bestDist || (d === bestDist && s.id < best.id)) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

function nearestSafeSite(sites: Site[], x: number, y: number, enemies: Unit[], radius: number, needRemaining: boolean): Site | null {
  let best: Site | null = null;
  let bestDist = 0;
  for (let i = 0; i < sites.length; i += 1) {
    const s = sites[i];
    if (s === undefined) {
      continue;
    }
    if (needRemaining && siteRemaining(s) <= 0) {
      continue;
    }
    if (enemyNearSite(s, enemies, radius)) {
      continue;
    }
    const d = cheb(x, y, s.x, s.y);
    if (best === null || d < bestDist || (d === bestDist && s.id < best.id)) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

function enemyNearSite(site: Site, enemies: Unit[], radius: number): boolean {
  for (let i = 0; i < enemies.length; i += 1) {
    const e = enemies[i];
    if (e !== undefined && cheb(site.x, site.y, e.x, e.y) <= radius) {
      return true;
    }
  }
  return false;
}

function nearestEnemy(x: number, y: number, enemies: Unit[], militaryOnly: boolean): Unit | null {
  let best: Unit | null = null;
  let bestDist = 0;
  for (let i = 0; i < enemies.length; i += 1) {
    const e = enemies[i];
    if (e === undefined) {
      continue;
    }
    if (militaryOnly && e.type === "worker") {
      continue;
    }
    const d = cheb(x, y, e.x, e.y);
    if (best === null || d < bestDist || (d === bestDist && e.id < best.id)) {
      best = e;
      bestDist = d;
    }
  }
  return best;
}

function unitRange(u: Unit): number {
  if (u.type === "ranged") {
    return 2;
  }
  return 1;
}

function isOnOwnBase(u: Unit, bases: Site[]): boolean {
  for (let i = 0; i < bases.length; i += 1) {
    const b = bases[i];
    if (b !== undefined && b.x === u.x && b.y === u.y) {
      return true;
    }
  }
  return false;
}

function cellKey(x: number, y: number): string {
  return x + ":" + y;
}

function cachedTerrain(x: number, y: number, cache: { [key: string]: string }): string {
  const key = cellKey(x, y);
  const v = cache[key];
  if (v !== undefined) {
    return v;
  }
  const t = getTerrainAt(x, y);
  cache[key] = t;
  return t;
}

function cellFreeForStand(x: number, y: number, blocked: { [key: string]: boolean }, cache: { [key: string]: string }): boolean {
  if (cachedTerrain(x, y, cache) !== "plain") {
    return false;
  }
  if (blocked[cellKey(x, y)] === true) {
    return false;
  }
  return true;
}

function pickFreeAdjacent(
  cx: number,
  cy: number,
  blocked: { [key: string]: boolean },
  cache: { [key: string]: string },
  seed: number,
  preferX: number,
  preferY: number,
  usePrefer: boolean
): boolean {
  let s = seed % 8;
  if (s < 0) {
    s += 8;
  }

  let found = false;
  let bestScore = 0;
  pickX = -1;
  pickY = -1;

  for (let i = 0; i < 8; i += 1) {
    let j = i + s;
    if (j >= 8) {
      j -= 8;
    }

    let dx = 0;
    let dy = 0;
    if (j === 0) {
      dx = -1;
      dy = -1;
    } else if (j === 1) {
      dx = -1;
      dy = 0;
    } else if (j === 2) {
      dx = -1;
      dy = 1;
    } else if (j === 3) {
      dx = 0;
      dy = -1;
    } else if (j === 4) {
      dx = 0;
      dy = 1;
    } else if (j === 5) {
      dx = 1;
      dy = -1;
    } else if (j === 6) {
      dx = 1;
      dy = 0;
    } else {
      dx = 1;
      dy = 1;
    }

    const nx = cx + dx;
    const ny = cy + dy;
    if (!cellFreeForStand(nx, ny, blocked, cache)) {
      continue;
    }

    let score = 1;
    if (usePrefer) {
      const d = cheb(nx, ny, preferX, preferY);
      score = 100 - d;
    }

    if (!found || score > bestScore) {
      found = true;
      bestScore = score;
      pickX = nx;
      pickY = ny;
    }
  }

  return found;
}

function pickFleeCell(u: Unit, foe: Unit, blocked: { [key: string]: boolean }, cache: { [key: string]: string }): boolean {
  let found = false;
  let bestScore = 0;
  pickX = -1;
  pickY = -1;

  for (let i = 0; i < 8; i += 1) {
    let dx = 0;
    let dy = 0;
    if (i === 0) {
      dx = -1;
      dy = -1;
    } else if (i === 1) {
      dx = -1;
      dy = 0;
    } else if (i === 2) {
      dx = -1;
      dy = 1;
    } else if (i === 3) {
      dx = 0;
      dy = -1;
    } else if (i === 4) {
      dx = 0;
      dy = 1;
    } else if (i === 5) {
      dx = 1;
      dy = -1;
    } else if (i === 6) {
      dx = 1;
      dy = 0;
    } else {
      dx = 1;
      dy = 1;
    }

    const nx = u.x + dx;
    const ny = u.y + dy;
    if (!cellFreeForStand(nx, ny, blocked, cache)) {
      continue;
    }

    const d = cheb(nx, ny, foe.x, foe.y);
    const score = d * 10;
    if (!found || score > bestScore) {
      found = true;
      bestScore = score;
      pickX = nx;
      pickY = ny;
    }
  }

  return found;
}

function moveOffBase(u: Unit, blocked: { [key: string]: boolean }, cache: { [key: string]: string }): boolean {
  if (pickFreeAdjacent(u.x, u.y, blocked, cache, u.id, -1, -1, false)) {
    moveStep(u.id, pickX, pickY);
    return true;
  }
  return false;
}