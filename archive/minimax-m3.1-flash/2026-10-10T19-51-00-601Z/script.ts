var claimWorkerOne = -1;
var claimTargetOne = -1;
var claimWorkerTwo = -1;
var claimTargetTwo = -1;
var claimWorkerThree = -1;
var claimTargetThree = -1;

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx > dy ? dx : dy;
}

function directionSign(value: number): number {
  if (value < 0) return -1;
  if (value > 0) return 1;
  return 0;
}

function unitCost(kind: UnitType): number {
  if (kind === "worker") return 4;
  if (kind === "melee") return 8;
  if (kind === "ranged") return 12;
  return 16;
}

function unitWeaponRange(kind: UnitType): number {
  if (kind === "ranged") return 2;
  return 1;
}

function findWorkerById(workers: Unit[], id: number): Unit | null {
  if (id < 0) return null;
  for (let i = 0; i < workers.length; i += 1) {
    const worker = workers[i];
    if (worker !== undefined && worker.id === id) return worker;
  }
  return null;
}

function findSiteById(sites: Site[], id: number): Site | null {
  if (id < 0) return null;
  for (let i = 0; i < sites.length; i += 1) {
    const site = sites[i];
    if (site !== undefined && site.id === id) return site;
  }
  return null;
}

function nearestBase(unit: Unit, bases: Site[]): Site | null {
  let best: Site | null = null;
  let bestDistance = 0;

  for (let i = 0; i < bases.length; i += 1) {
    const base = bases[i];
    if (base === undefined) continue;
    const distance = chebyshev(unit.x, unit.y, base.x, base.y);
    if (
      best === null ||
      distance < bestDistance ||
      (distance === bestDistance && base.id < best.id)
    ) {
      best = base;
      bestDistance = distance;
    }
  }
  return best;
}

function nearestEnemyAt(
  x: number,
  y: number,
  seed: number,
  enemies: Unit[],
  maxRange: number,
  tick: number,
): Unit | null {
  if (enemies.length === 0) return null;

  const scanCount = enemies.length < 12 ? enemies.length : 12;
  const start = (tick + seed) % enemies.length;
  let best: Unit | null = null;
  let bestDistance = 0;

  for (let i = 0; i < scanCount; i += 1) {
    const enemy = enemies[(start + i) % enemies.length];
    if (enemy === undefined) continue;
    const distance = chebyshev(x, y, enemy.x, enemy.y);
    if (distance > maxRange) continue;
    if (
      best === null ||
      distance < bestDistance ||
      (distance === bestDistance && enemy.hp < best.hp) ||
      (distance === bestDistance && enemy.hp === best.hp && enemy.id < best.id)
    ) {
      best = enemy;
      bestDistance = distance;
    }
  }
  return best;
}

function sendWorkerAdjacent(worker: Unit, pointX: number, pointY: number, tick: number): void {
  const offsetX = [-1, -1, -1, 0, 0, 1, 1, 1];
  const offsetY = [-1, 0, 1, -1, 1, -1, 0, 1];
  const towardX = directionSign(pointX - worker.x);
  const towardY = directionSign(pointY - worker.y);
  let start = 0;

  if (towardX === 0 && towardY === 0) {
    start = (tick + worker.id) % 8;
  } else {
    for (let i = 0; i < 8; i += 1) {
      if (offsetX[i] === towardX && offsetY[i] === towardY) {
        start = i;
        break;
      }
    }
  }

  for (let i = 0; i < 3; i += 1) {
    const direction = (start + i) % 8;
    const dx = offsetX[direction];
    const dy = offsetY[direction];
    if (dx === undefined || dy === undefined) continue;
    const targetX = worker.x + dx;
    const targetY = worker.y + dy;
    if (getTerrainAt(targetX, targetY) === "plain") {
      moveTo(worker.id, targetX, targetY);
      return;
    }
  }
}

function sendWorkerFlee(worker: Unit, base: Site | null, enemy: Unit): void {
  if (base !== null) {
    if (worker.x === base.x && worker.y === base.y) {
      sendWorkerAdjacent(worker, base.x, base.y, getTick());
    } else {
      moveTo(worker.id, base.x, base.y);
    }
    return;
  }

  const dx = directionSign(worker.x - enemy.x);
  const dy = directionSign(worker.y - enemy.y);
  const diagonalX = worker.x + dx;
  const diagonalY = worker.y + dy;

  if ((dx !== 0 || dy !== 0) && getTerrainAt(diagonalX, diagonalY) === "plain") {
    moveTo(worker.id, diagonalX, diagonalY);
    return;
  }
  if (dx !== 0 && getTerrainAt(diagonalX, worker.y) === "plain") {
    moveTo(worker.id, diagonalX, worker.y);
    return;
  }
  if (dy !== 0 && getTerrainAt(worker.x, diagonalY) === "plain") {
    moveTo(worker.id, worker.x, diagonalY);
  }
}

function deliverWorker(worker: Unit, bases: Site[], tick: number): void {
  const base = nearestBase(worker, bases);
  if (base === null) return;

  const distance = getRange(worker.x, worker.y, base.x, base.y);
  if (distance === 1) {
    transfer(worker.id);
  } else if (distance === 0) {
    sendWorkerAdjacent(worker, base.x, base.y, tick);
  } else {
    moveTo(worker.id, base.x, base.y);
  }
}

function isClaimWorker(workerId: number): boolean {
  return (
    workerId === claimWorkerOne ||
    workerId === claimWorkerTwo ||
    workerId === claimWorkerThree
  );
}

function clearClaimOne(): void {
  claimWorkerOne = -1;
  claimTargetOne = -1;
}

function clearClaimTwo(): void {
  claimWorkerTwo = -1;
  claimTargetTwo = -1;
}

function clearClaimThree(): void {
  claimWorkerThree = -1;
  claimTargetThree = -1;
}

function claimIsValid(
  workerId: number,
  targetId: number,
  workers: Unit[],
  sites: Site[],
  enemyCombat: Unit[],
  tick: number,
): boolean {
  const worker = findWorkerById(workers, workerId);
  const target = findSiteById(sites, targetId);
  if (worker === null || worker.type !== "worker") return false;
  if (target === null || target.kind !== "resource" || target.owner !== -1) return false;
  return nearestEnemyAt(worker.x, worker.y, worker.id, enemyCombat, 2, tick) === null;
}

function beginClaim(slot: number, workerId: number, targetId: number): void {
  if (slot === 0) {
    claimWorkerOne = workerId;
    claimTargetOne = targetId;
  } else if (slot === 1) {
    claimWorkerTwo = workerId;
    claimTargetTwo = targetId;
  } else {
    claimWorkerThree = workerId;
    claimTargetThree = targetId;
  }
}

function assignMineSite(
  worker: Unit,
  mines: Site[],
  assignmentCounts: number[],
  capacity: number,
  tick: number,
): Site | null {
  if (mines.length === 0) return null;

  const scanCount = mines.length < 12 ? mines.length : 12;
  const start = (tick + worker.id) % mines.length;
  let chosenIndex = -1;
  let chosenMine: Site | null = null;
  let bestDistance = 0;

  for (let pass = 0; pass < 2 && chosenMine === null; pass += 1) {
    for (let i = 0; i < scanCount; i += 1) {
      const index = (start + i) % mines.length;
      const mine = mines[index];
      const count = assignmentCounts[index];
      if (mine === undefined || count === undefined) continue;
      if (pass === 0 && count >= capacity) continue;

      const distance = chebyshev(worker.x, worker.y, mine.x, mine.y);
      if (
        chosenMine === null ||
        distance < bestDistance ||
        (distance === bestDistance && mine.id < chosenMine.id)
      ) {
        chosenIndex = index;
        chosenMine = mine;
        bestDistance = distance;
      }
    }
  }

  if (chosenMine === null) return null;
  const chosenCount = assignmentCounts[chosenIndex];
  if (chosenCount !== undefined) assignmentCounts[chosenIndex] = chosenCount + 1;
  return chosenMine;
}

function homeIsUnderPressure(bases: Site[], enemyCombat: Unit[], tick: number): boolean {
  for (let i = 0; i < bases.length; i += 1) {
    const base = bases[i];
    if (base === undefined) continue;
    if (nearestEnemyAt(base.x, base.y, base.id, enemyCombat, 4, tick) !== null) return true;
  }
  return false;
}

function chooseDefenseSite(
  ownSites: Site[],
  enemyUnits: Unit[],
  rally: Site | null,
  tick: number,
): Site | null {
  if (ownSites.length === 0) return null;

  const scanCount = ownSites.length < 80 ? ownSites.length : 80;
  const start = (tick * 3) % ownSites.length;
  const rallyX = rally === null ? 0 : rally.x;
  const rallyY = rally === null ? 0 : rally.y;
  let best: Site | null = null;
  let bestScore = 0;

  for (let i = 0; i < scanCount; i += 1) {
    const site = ownSites[(start + i) % ownSites.length];
    if (site === undefined) continue;

    const enemy = nearestEnemyAt(site.x, site.y, site.id, enemyUnits, 5, tick);
    let score = 0;

    if (enemy !== null) {
      score = chebyshev(site.x, site.y, enemy.x, enemy.y) * 20;
      score += chebyshev(rallyX, rallyY, site.x, site.y);
      if (enemy.x === site.x && enemy.y === site.y) score -= 40;
    } else if (site.progressOwner !== -1 && site.progress >= 7) {
      score = 30 - site.progress;
      score += chebyshev(rallyX, rallyY, site.x, site.y);
    } else {
      continue;
    }

    if (site.kind === "base") score -= 2;
    if (site.progressOwner !== -1) score -= 4;
    if (
      best === null ||
      score < bestScore ||
      (score === bestScore && site.id < best.id)
    ) {
      best = site;
      bestScore = score;
    }
  }
  return best;
}

function militarySiteHasFriendlyOccupant(site: Site, ownCombat: Unit[]): boolean {
  for (let i = 0; i < ownCombat.length; i += 1) {
    const unit = ownCombat[i];
    if (unit !== undefined && unit.x === site.x && unit.y === site.y) return true;
  }
  return false;
}

function chooseMilitaryTarget(
  me: number,
  enemySites: Site[],
  neutralResources: Site[],
  ownCombat: Unit[],
  enemyCombat: Unit[],
  combatCount: number,
  rally: Site | null,
  tick: number,
): Site | null {
  const candidates: Site[] = [];

  for (let i = 0; i < enemySites.length && candidates.length < 80; i += 1) {
    const site = enemySites[i];
    if (site !== undefined) candidates.push(site);
  }
  for (let i = 0; i < neutralResources.length && candidates.length < 96; i += 1) {
    const site = neutralResources[i];
    if (site !== undefined) candidates.push(site);
  }
  if (candidates.length === 0) return null;

  const firstCandidate = candidates[0];
  if (firstCandidate === undefined) return null;
  const rallyX = rally === null ? firstCandidate.x : rally.x;
  const rallyY = rally === null ? firstCandidate.y : rally.y;
  let best: Site | null = null;
  let bestScore = 0;

  for (let i = 0; i < candidates.length; i += 1) {
    const site = candidates[i];
    if (site === undefined) continue;
    if (
      site.id === claimTargetOne ||
      site.id === claimTargetTwo ||
      site.id === claimTargetThree
    ) {
      continue;
    }
    if (militarySiteHasFriendlyOccupant(site, ownCombat)) continue;

    let defenders = 0;
    if (enemyCombat.length > 0) {
      const defenderScan = enemyCombat.length < 12 ? enemyCombat.length : 12;
      const defenderStart = (tick + site.id) % enemyCombat.length;
      for (let j = 0; j < defenderScan; j += 1) {
        const enemy = enemyCombat[(defenderStart + j) % enemyCombat.length];
        if (enemy === undefined) continue;
        if (chebyshev(site.x, site.y, enemy.x, enemy.y) <= 3) defenders += 1;
      }
    }

    const required = 5 + defenders * 2;
    if (combatCount < required) continue;

    let score = defenders * 30;
    score += chebyshev(rallyX, rallyY, site.x, site.y);
    if (site.kind === "base") score += 18;
    if (site.owner === -1) score -= 4;
    if (site.progressOwner === me) score -= 15;
    if (site.kind === "resource" && site.remaining === 0) score += 8;

    if (
      best === null ||
      score < bestScore ||
      (score === bestScore && site.id < best.id)
    ) {
      best = site;
      bestScore = score;
    }
  }
  return best;
}

function nearestCombatTarget(
  unit: Unit,
  enemies: Unit[],
  maxRange: number,
  focusSite: Site | null,
  tick: number,
): Unit | null {
  if (enemies.length === 0) return null;

  const scanCount = enemies.length < 12 ? enemies.length : 12;
  const start = (tick + unit.id) % enemies.length;
  let best: Unit | null = null;
  let bestScore = 0;

  for (let i = 0; i < scanCount; i += 1) {
    const enemy = enemies[(start + i) % enemies.length];
    if (enemy === undefined) continue;
    const distance = chebyshev(unit.x, unit.y, enemy.x, enemy.y);
    if (distance > maxRange) continue;

    let score = distance * 10;
    if (focusSite !== null && enemy.x === focusSite.x && enemy.y === focusSite.y) score -= 3;
    if (
      best === null ||
      score < bestScore ||
      (score === bestScore && enemy.id < best.id)
    ) {
      best = enemy;
      bestScore = score;
    }
  }
  return best;
}

function chooseAttackTarget(
  unit: Unit,
  enemies: Unit[],
  range: number,
  focusSite: Site | null,
  tick: number,
): Unit | null {
  if (enemies.length === 0) return null;

  const scanCount = enemies.length < 12 ? enemies.length : 12;
  const start = (tick + unit.id) % enemies.length;
  let best: Unit | null = null;
  let bestScore = 0;

  for (let i = 0; i < scanCount; i += 1) {
    const enemy = enemies[(start + i) % enemies.length];
    if (enemy === undefined) continue;
    const distance = chebyshev(unit.x, unit.y, enemy.x, enemy.y);
    if (distance > range) continue;

    let score = enemy.hp * 4 + distance;
    if (enemy.type === "worker") score += 1000;
    if (focusSite !== null && enemy.x === focusSite.x && enemy.y === focusSite.y) score -= 20;
    if (
      best === null ||
      score < bestScore ||
      (score === bestScore && enemy.id < best.id)
    ) {
      best = enemy;
      bestScore = score;
    }
  }
  return best;
}

function sendCombatToSite(unit: Unit, site: Site | null): void {
  if (site === null) return;
  if (unit.x === site.x && unit.y === site.y) return;

  if (site.owner !== unit.owner) {
    const occupants = getObjectsByType("unit", { owner: unit.owner });
    const scanCount = occupants.length < 12 ? occupants.length : 12;
    for (let i = 0; i < scanCount; i += 1) {
      const other = occupants[i];
      if (other === undefined || other.id === unit.id || other.type === "worker") continue;
      if (other.x === site.x && other.y === site.y) return;
    }
  }

  if (unit.type === "ranged" && chebyshev(unit.x, unit.y, site.x, site.y) <= 2) return;
  moveTo(unit.id, site.x, site.y);
}

function actCombatUnit(
  unit: Unit,
  targetSite: Site | null,
  enemyCombat: Unit[],
  enemyUnits: Unit[],
  rally: Site | null,
  tick: number,
): void {
  const maxAggro = targetSite === null ? 4 : 6;
  let target = nearestCombatTarget(unit, enemyCombat, maxAggro, targetSite, tick);
  if (target === null) target = nearestEnemyAt(unit.x, unit.y, unit.id, enemyUnits, 2, tick);

  if (target !== null) {
    const range = unitWeaponRange(unit.type);
    let targetRange = getRange(unit.x, unit.y, target.x, target.y);

    if (targetRange <= range) {
      let victim = chooseAttackTarget(unit, enemyUnits, range, targetSite, tick);
      if (victim === null) victim = target;

      if (victim.id !== target.id) {
        targetRange = getRange(unit.x, unit.y, victim.x, victim.y);
      }

      if (unit.type === "ranged" && targetRange < 2 && rally !== null) {
        const currentDistance = chebyshev(unit.x, unit.y, victim.x, victim.y);
        const rallyDistance = chebyshev(rally.x, rally.y, victim.x, victim.y);
        if (
          rallyDistance > currentDistance &&
          (unit.x !== rally.x || unit.y !== rally.y)
        ) {
          moveTo(unit.id, rally.x, rally.y);
          return;
        }
      }

      attack(unit.id, victim.id);
      return;
    }

    moveTo(unit.id, target.x, target.y);
    return;
  }

  sendCombatToSite(unit, targetSite);
}

function loop(): void {
  const me = getMyIndex();
  const tick = getTick();
  const players = getObjectsByType("player");
  const minePlayer = players[me];
  if (minePlayer === undefined || !minePlayer.alive) return;

  const allUnits = getObjectsByType("unit");
  const allSites = getObjectsByType("site");
  const workers: Unit[] = [];
  const combat: Unit[] = [];
  const enemyUnits: Unit[] = [];
  const enemyCombat: Unit[] = [];

  for (let i = 0; i < allUnits.length; i += 1) {
    const unit = allUnits[i];
    if (unit === undefined) continue;
    if (unit.owner === me) {
      if (unit.type === "worker") workers.push(unit);
      else combat.push(unit);
    } else {
      enemyUnits.push(unit);
      if (unit.type !== "worker") enemyCombat.push(unit);
    }
  }

  const ownSites: Site[] = [];
  const ownBases: Site[] = [];
  const ownedResources: Site[] = [];
  const mineSites: Site[] = [];
  const enemySites: Site[] = [];
  const neutralResources: Site[] = [];

  for (let i = 0; i < allSites.length; i += 1) {
    const site = allSites[i];
    if (site === undefined) continue;

    if (site.owner === me) {
      ownSites.push(site);
      if (site.kind === "base") {
        ownBases.push(site);
      } else {
        ownedResources.push(site);
        if (site.remaining === undefined || site.remaining > 0) mineSites.push(site);
      }
    } else if (site.owner >= 0) {
      enemySites.push(site);
    } else if (site.kind === "resource") {
      neutralResources.push(site);
    }
  }

  let queuedWorkers = 0;
  let queuedMelee = 0;
  let queuedRanged = 0;
  let queuedCavalry = 0;
  const emptyBases: Site[] = [];

  for (let i = 0; i < ownBases.length; i += 1) {
    const base = ownBases[i];
    if (base === undefined) continue;
    const order = base.producing;

    if (order === null) {
      emptyBases.push(base);
    } else if (order.type === "worker") {
      queuedWorkers += 1;
    } else if (order.type === "melee") {
      queuedMelee += 1;
    } else if (order.type === "ranged") {
      queuedRanged += 1;
    } else {
      queuedCavalry += 1;
    }
  }

  let availableResources = minePlayer.resources;
  const desiredWorkers = 14;

  if (workers.length + queuedWorkers < desiredWorkers || workers.length === 0) {
    const base = emptyBases[0];
    if (base !== undefined && availableResources >= 4) {
      const result = spawnUnit(base.id, "worker");
      if (!isError(result)) availableResources -= 4;
    }
  } else {
    let rangedCount = 0;
    for (let i = 0; i < combat.length; i += 1) {
      const unit = combat[i];
      if (unit !== undefined && unit.type === "ranged") rangedCount += 1;
    }

    let futureCombat = combat.length + queuedMelee + queuedRanged + queuedCavalry;
    let futureRanged = rangedCount + queuedRanged;
    let ordersIssued = 0;

    for (let i = 0; i < emptyBases.length && ordersIssued < 2; i += 1) {
      const base = emptyBases[i];
      if (base === undefined) continue;

      let kind: UnitType = "melee";
      if (futureCombat >= 4 && futureRanged * 4 < futureCombat + 1) kind = "ranged";

      const cost = unitCost(kind);
      if (availableResources < cost) continue;

      const result = spawnUnit(base.id, kind);
      if (!isError(result)) {
        availableResources -= cost;
        ordersIssued += 1;
        futureCombat += 1;
        if (kind === "ranged") futureRanged += 1;
      }
    }
  }

  if (workers.length < 8) {
    clearClaimOne();
    clearClaimTwo();
    clearClaimThree();
  } else {
    if (workers.length < 10) clearClaimThree();
    if (workers.length < 12) clearClaimTwo();
  }

  if (!claimIsValid(claimWorkerOne, claimTargetOne, workers, allSites, enemyCombat, tick)) {
    clearClaimOne();
  }
  if (!claimIsValid(claimWorkerTwo, claimTargetTwo, workers, allSites, enemyCombat, tick)) {
    clearClaimTwo();
  }
  if (!claimIsValid(claimWorkerThree, claimTargetThree, workers, allSites, enemyCombat, tick)) {
    clearClaimThree();
  }

  if (
    claimWorkerTwo !== -1 &&
    (claimWorkerTwo === claimWorkerOne || claimTargetTwo === claimTargetOne)
  ) {
    clearClaimTwo();
  }
  if (
    claimWorkerThree !== -1 &&
    (claimWorkerThree === claimWorkerOne ||
      claimWorkerThree === claimWorkerTwo ||
      claimTargetThree === claimTargetOne ||
      claimTargetThree === claimTargetTwo)
  ) {
    clearClaimThree();
  }

  let claimCount = 0;
  if (claimWorkerOne !== -1) claimCount += 1;
  if (claimWorkerTwo !== -1) claimCount += 1;
  if (claimWorkerThree !== -1) claimCount += 1;

  let desiredClaims = 0;
  if (workers.length >= 14) desiredClaims = 3;
  else if (workers.length >= 11) desiredClaims = 2;
  else if (workers.length >= 9) desiredClaims = 1;

  if (
    claimCount < desiredClaims &&
    neutralResources.length > 0 &&
    !homeIsUnderPressure(ownBases, enemyCombat, tick)
  ) {
    const workerScan = workers.length < 40 ? workers.length : 40;
    let bestWorker: Unit | null = null;
    let bestTarget: Site | null = null;
    let bestScore = 0;

    for (let i = 0; i < workerScan; i += 1) {
      const worker = workers[i];
      if (
        worker === undefined ||
        worker.carrying !== 0 ||
        isClaimWorker(worker.id)
      ) {
        continue;
      }
      if (nearestEnemyAt(worker.x, worker.y, worker.id, enemyCombat, 2, tick) !== null) continue;

      const targetScan = neutralResources.length < 12 ? neutralResources.length : 12;
      const targetStart = (tick + worker.id) % neutralResources.length;

      for (let j = 0; j < targetScan; j += 1) {
        const target = neutralResources[(targetStart + j) % neutralResources.length];
        if (target === undefined) continue;
        if (
          target.id === claimTargetOne ||
          target.id === claimTargetTwo ||
          target.id === claimTargetThree
        ) {
          continue;
        }

        let defenders = 0;
        if (enemyCombat.length > 0) {
          const defenderScan = enemyCombat.length < 12 ? enemyCombat.length : 12;
          const defenderStart = (tick + target.id) % enemyCombat.length;
          for (let k = 0; k < defenderScan; k += 1) {
            const enemy = enemyCombat[(defenderStart + k) % enemyCombat.length];
            if (enemy === undefined) continue;
            if (chebyshev(target.x, target.y, enemy.x, enemy.y) <= 3) defenders += 1;
          }
        }

        let score = chebyshev(worker.x, worker.y, target.x, target.y) * 10;
        score += defenders * 30;
        if (target.remaining === 0) score += 20;

        if (
          bestWorker === null ||
          bestTarget === null ||
          score < bestScore
        ) {
          bestWorker = worker;
          bestTarget = target;
          bestScore = score;
        }
      }
    }

    if (bestWorker !== null && bestTarget !== null) {
      let slot = -1;
      if (claimWorkerOne === -1) slot = 0;
      else if (claimWorkerTwo === -1) slot = 1;
      else if (claimWorkerThree === -1) slot = 2;

      if (slot >= 0) {
        beginClaim(slot, bestWorker.id, bestTarget.id);
        claimCount += 1;
      }
    }
  }

  for (let i = 0; i < workers.length; i += 1) {
    const worker = workers[i];
    if (worker === undefined || !isClaimWorker(worker.id)) continue;

    let targetId = -1;
    if (worker.id === claimWorkerOne) targetId = claimTargetOne;
    else if (worker.id === claimWorkerTwo) targetId = claimTargetTwo;
    else targetId = claimTargetThree;

    const target = findSiteById(allSites, targetId);
    if (target !== null && (worker.x !== target.x || worker.y !== target.y)) {
      moveTo(worker.id, target.x, target.y);
    }
  }

  let harvestWorkerCount = 0;
  for (let i = 0; i < workers.length; i += 1) {
    const worker = workers[i];
    if (
      worker !== undefined &&
      !isClaimWorker(worker.id) &&
      worker.carrying < 20
    ) {
      harvestWorkerCount += 1;
    }
  }

  let assignmentCapacity = 1;
  if (mineSites.length > 0) {
    assignmentCapacity = Math.ceil(harvestWorkerCount / mineSites.length);
    if (assignmentCapacity < 1) assignmentCapacity = 1;
  }

  const assignmentCounts: number[] = [];
  for (let i = 0; i < mineSites.length; i += 1) assignmentCounts.push(0);

  const normalWorkerLimit = workers.length < 32 ? workers.length : 32;
  const workerStart =
    workers.length <= normalWorkerLimit ? 0 : (tick * 3) % workers.length;
  let normalWorkersIssued = 0;

  for (
    let checked = 0;
    checked < workers.length && normalWorkersIssued < normalWorkerLimit;
    checked += 1
  ) {
    const worker = workers[(workerStart + checked) % workers.length];
    if (worker === undefined || isClaimWorker(worker.id)) continue;
    normalWorkersIssued += 1;

    const nearbyEnemy = nearestEnemyAt(
      worker.x,
      worker.y,
      worker.id,
      enemyCombat,
      2,
      tick,
    );

    if (nearbyEnemy !== null) {
      const base = nearestBase(worker, ownBases);
      if (
        worker.carrying >= 20 &&
        base !== null &&
        getRange(worker.x, worker.y, base.x, base.y) === 1
      ) {
        transfer(worker.id);
      } else {
        sendWorkerFlee(worker, base, nearbyEnemy);
      }
      continue;
    }

    if (worker.carrying >= 20) {
      deliverWorker(worker, ownBases, tick);
      continue;
    }

    if (mineSites.length === 0) {
      if (worker.carrying > 0) {
        deliverWorker(worker, ownBases, tick);
      } else {
        const base = nearestBase(worker, ownBases);
        if (
          base !== null &&
          (worker.x !== base.x || worker.y !== base.y)
        ) {
          sendWorkerAdjacent(worker, base.x, base.y, tick);
        }
      }
      continue;
    }

    const mine = assignMineSite(
      worker,
      mineSites,
      assignmentCounts,
      assignmentCapacity,
      tick,
    );
    if (mine === null) continue;

    const distance = getRange(worker.x, worker.y, mine.x, mine.y);
    if (distance === 1) {
      harvest(worker.id, mine.id);
    } else {
      sendWorkerAdjacent(worker, mine.x, mine.y, tick);
    }
  }

  let rallySite: Site | null = null;
  const firstBase = ownBases[0];
  if (firstBase !== undefined) rallySite = firstBase;
  if (rallySite === null) {
    const firstResource = ownedResources[0];
    if (firstResource !== undefined) rallySite = firstResource;
  }

  const defenseSite = chooseDefenseSite(ownSites, enemyUnits, rallySite, tick);
  let militaryTarget: Site | null = null;

  if (workers.length >= 9 && combat.length >= 5) {
    militaryTarget = chooseMilitaryTarget(
      me,
      enemySites,
      neutralResources,
      combat,
      enemyCombat,
      combat.length,
      rallySite,
      tick,
    );
  }

  let activeDefenseSite = defenseSite;
  if (activeDefenseSite === null && militaryTarget !== null && rallySite !== null && combat.length >= 6) {
    activeDefenseSite = rallySite;
  }

  let defenderCount = 0;
  if (activeDefenseSite !== null) {
    if (combat.length >= 8) defenderCount = 3;
    else if (combat.length >= 4) defenderCount = 2;
    else defenderCount = 1;
  }

  const homeSites: Site[] = [];
  for (let i = 0; i < ownBases.length; i += 1) {
    const base = ownBases[i];
    if (base !== undefined) homeSites.push(base);
  }
  for (let i = 0; i < ownedResources.length; i += 1) {
    const resource = ownedResources[i];
    if (resource !== undefined) homeSites.push(resource);
  }

  const combatLimit = combat.length < 48 ? combat.length : 48;
  const combatStart =
    combat.length <= combatLimit ? 0 : (tick * 7) % combat.length;

  for (let i = 0; i < combatLimit; i += 1) {
    const unit = combat[(combatStart + i) % combat.length];
    if (unit === undefined) continue;

    let targetSite: Site | null = null;
    if (i < defenderCount && activeDefenseSite !== null) {
      targetSite = activeDefenseSite;
    } else if (militaryTarget !== null) {
      targetSite = militaryTarget;
    } else if (homeSites.length > 0) {
      const homeTarget = homeSites[i % homeSites.length];
      if (homeTarget !== undefined) targetSite = homeTarget;
    }

    actCombatUnit(
      unit,
      targetSite,
      enemyCombat,
      enemyUnits,
      rallySite,
      tick,
    );
  }
}