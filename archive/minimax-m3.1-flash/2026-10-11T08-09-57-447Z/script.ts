type ScriptUnitType = "worker" | "melee" | "ranged" | "cavalry";

type ScriptUnit = {
  id: number;
  owner: number;
  type: ScriptUnitType;
  x: number;
  y: number;
  carrying: number;
};

type ScriptOrder = {
  type: ScriptUnitType;
  remainingTicks: number;
};

type ScriptSite = {
  id: number;
  kind: "base" | "resource";
  x: number;
  y: number;
  owner: number;
  remaining?: number;
  producing: ScriptOrder | null;
};

type CallBudget = {
  left: number;
};

function loop(): void {
  const calls: CallBudget = { left: 760 };

  const me = getMyIndex();
  calls.left -= 1;
  const tick = getTick();
  calls.left -= 1;

  const players = getObjectsByType("player");
  calls.left -= 1;
  const mePlayer = players[me];
  if (mePlayer === undefined || !mePlayer.alive) {
    return;
  }

  const allUnits = getObjectsByType("unit");
  calls.left -= 1;
  const allSites = getObjectsByType("site");
  calls.left -= 1;

  const activeOwners: boolean[] = [false, false, false, false];
  for (let i = 0; i < players.length; i += 1) {
    const player = players[i];
    if (player !== undefined) {
      setOwnerFlag(activeOwners, player.index, player.alive);
    }
  }

  const workers: ScriptUnit[] = [];
  const military: ScriptUnit[] = [];
  const enemyMilitary: ScriptUnit[] = [];
  const enemyWorkers: ScriptUnit[] = [];
  const enemyMilitaryCounts: number[] = [0, 0, 0, 0];

  for (let i = 0; i < allUnits.length; i += 1) {
    const unit = allUnits[i];
    if (unit === undefined) {
      continue;
    }
    if (unit.owner === me) {
      if (unit.type === "worker") {
        workers.push(unit);
      } else {
        military.push(unit);
      }
    } else if (ownerFlag(activeOwners, unit.owner)) {
      if (unit.type === "worker") {
        enemyWorkers.push(unit);
      } else {
        enemyMilitary.push(unit);
        incrementOwnerCount(enemyMilitaryCounts, unit.owner);
      }
    }
  }

  const myBases: ScriptSite[] = [];
  const myResources: ScriptSite[] = [];
  const neutralResources: ScriptSite[] = [];
  const enemyBases: ScriptSite[] = [];

  for (let i = 0; i < allSites.length; i += 1) {
    const site = allSites[i];
    if (site === undefined) {
      continue;
    }
    if (site.owner === me) {
      if (site.kind === "base") {
        myBases.push(site);
      } else {
        myResources.push(site);
      }
    } else if (site.owner === -1) {
      if (site.kind === "resource") {
        neutralResources.push(site);
      }
    } else if (site.kind === "base" && ownerFlag(activeOwners, site.owner)) {
      enemyBases.push(site);
    }
  }

  workers.sort((a, b) => a.id - b.id);
  military.sort((a, b) => a.id - b.id);
  myResources.sort((a, b) => a.id - b.id);
  myBases.sort((a, b) => a.id - b.id);
  neutralResources.sort((a, b) => a.id - b.id);

  const mines: ScriptSite[] = [];
  for (let i = 0; i < myResources.length; i += 1) {
    const site = myResources[i];
    if (site !== undefined && (site.remaining === undefined || site.remaining > 0)) {
      mines.push(site);
    }
  }

  const alertMilitary: ScriptUnit[] = [];
  const alertWorkers: ScriptUnit[] = [];
  for (let i = 0; i < enemyMilitary.length; i += 1) {
    const enemy = enemyMilitary[i];
    if (enemy !== undefined && enemyMenacesProtected(enemy, workers, myResources, myBases)) {
      alertMilitary.push(enemy);
    }
  }
  for (let i = 0; i < enemyWorkers.length; i += 1) {
    const enemy = enemyWorkers[i];
    if (enemy !== undefined && enemyMenacesProtected(enemy, workers, myResources, myBases)) {
      alertWorkers.push(enemy);
    }
  }

  enemyBases.sort((a, b) => {
    const aCount = ownerCount(enemyMilitaryCounts, a.owner);
    const bCount = ownerCount(enemyMilitaryCounts, b.owner);
    return aCount - bCount || a.id - b.id;
  });

  let weakestEnemyMilitary = 999;
  for (let i = 0; i < 4; i += 1) {
    if (i !== me && ownerFlag(activeOwners, i)) {
      const count = ownerCount(enemyMilitaryCounts, i);
      if (count < weakestEnemyMilitary) {
        weakestEnemyMilitary = count;
      }
    }
  }

  const homeAlert = alertMilitary.length > 0 || alertWorkers.length > 0;

  produceUnits(
    mePlayer.resources,
    myBases,
    workers,
    military,
    mines,
    neutralResources,
    homeAlert,
    calls
  );

  for (let i = 0; i < workers.length; i += 1) {
    const worker = workers[i];
    if (worker === undefined) {
      continue;
    }
    manageWorker(
      worker,
      mines,
      neutralResources,
      myBases,
      enemyBases,
      enemyMilitary,
      calls
    );
  }

  for (let i = 0; i < military.length; i += 1) {
    const unit = military[i];
    if (unit === undefined) {
      continue;
    }
    manageMilitary(
      unit,
      i,
      military.length,
      enemyMilitary,
      enemyWorkers,
      alertMilitary,
      alertWorkers,
      neutralResources,
      myResources,
      myBases,
      enemyBases,
      weakestEnemyMilitary,
      tick,
      calls
    );
  }
}

function setOwnerFlag(flags: boolean[], owner: number, value: boolean): void {
  if (owner >= 0 && owner < 4) {
    flags[owner] = value;
  }
}

function ownerFlag(flags: boolean[], owner: number): boolean {
  if (owner < 0 || owner >= 4) {
    return false;
  }
  const value = flags[owner];
  return value === true;
}

function incrementOwnerCount(counts: number[], owner: number): void {
  if (owner >= 0 && owner < 4) {
    counts[owner] = ownerCount(counts, owner) + 1;
  }
}

function ownerCount(counts: number[], owner: number): number {
  if (owner < 0 || owner >= 4) {
    return 0;
  }
  const value = counts[owner];
  return value === undefined ? 0 : value;
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax > bx ? ax - bx : bx - ax;
  const dy = ay > by ? ay - by : by - ay;
  return dx > dy ? dx : dy;
}

function enemyMenacesProtected(
  enemy: ScriptUnit,
  workers: ScriptUnit[],
  resources: ScriptSite[],
  bases: ScriptSite[]
): boolean {
  for (let i = 0; i < workers.length; i += 1) {
    const worker = workers[i];
    if (worker !== undefined && distance(enemy.x, enemy.y, worker.x, worker.y) <= 3) {
      return true;
    }
  }
  for (let i = 0; i < resources.length; i += 1) {
    const site = resources[i];
    if (site !== undefined && distance(enemy.x, enemy.y, site.x, site.y) <= 4) {
      return true;
    }
  }
  for (let i = 0; i < bases.length; i += 1) {
    const base = bases[i];
    if (base !== undefined && distance(enemy.x, enemy.y, base.x, base.y) <= 4) {
      return true;
    }
  }
  return false;
}

function nearestEnemyInRadius(
  unit: ScriptUnit,
  enemies: ScriptUnit[],
  radius: number
): ScriptUnit | null {
  let best: ScriptUnit | null = null;
  let bestDistance = 0;
  for (let i = 0; i < enemies.length; i += 1) {
    const enemy = enemies[i];
    if (enemy === undefined) {
      continue;
    }
    const d = distance(unit.x, unit.y, enemy.x, enemy.y);
    if (d <= radius && (best === null || d < bestDistance || (d === bestDistance && enemy.id < best.id))) {
      best = enemy;
      bestDistance = d;
    }
  }
  return best;
}

function nearestEnemy(unit: ScriptUnit, enemies: ScriptUnit[]): ScriptUnit | null {
  let best: ScriptUnit | null = null;
  let bestDistance = 0;
  for (let i = 0; i < enemies.length; i += 1) {
    const enemy = enemies[i];
    if (enemy === undefined) {
      continue;
    }
    const d = distance(unit.x, unit.y, enemy.x, enemy.y);
    if (best === null || d < bestDistance || (d === bestDistance && enemy.id < best.id)) {
      best = enemy;
      bestDistance = d;
    }
  }
  return best;
}

function nearestSite(unit: ScriptUnit, sites: ScriptSite[]): ScriptSite | null {
  let best: ScriptSite | null = null;
  let bestDistance = 0;
  for (let i = 0; i < sites.length; i += 1) {
    const site = sites[i];
    if (site === undefined) {
      continue;
    }
    const d = distance(unit.x, unit.y, site.x, site.y);
    if (best === null || d < bestDistance || (d === bestDistance && site.id < best.id)) {
      best = site;
      bestDistance = d;
    }
  }
  return best;
}

function unitRange(unit: ScriptUnit): number {
  return unit.type === "ranged" ? 2 : 1;
}

function unitCost(type: ScriptUnitType): number {
  if (type === "worker") {
    return 4;
  }
  if (type === "melee") {
    return 8;
  }
  if (type === "ranged") {
    return 12;
  }
  return 16;
}

function ringX(slot: number): number {
  if (slot === 0 || slot === 4 || slot === 6) {
    return -1;
  }
  if (slot === 2 || slot === 5 || slot === 7) {
    return 1;
  }
  return 0;
}

function ringY(slot: number): number {
  if (slot === 1 || slot === 6 || slot === 7) {
    return 1;
  }
  if (slot === 3 || slot === 4 || slot === 5) {
    return -1;
  }
  return 0;
}

function chooseNeighbor(
  site: ScriptSite,
  salt: number,
  calls: CallBudget
): { x: number; y: number } {
  if (calls.left <= 9) {
    return { x: site.x, y: site.y };
  }

  let start = (site.id * 5 + salt * 3) % 8;
  if (start < 0) {
    start += 8;
  }

  for (let i = 0; i < 8; i += 1) {
    const slot = (start + i) % 8;
    const x = site.x + ringX(slot);
    const y = site.y + ringY(slot);
    const terrain = getTerrainAt(x, y);
    calls.left -= 1;
    if (terrain === "plain") {
      return { x: x, y: y };
    }
  }
  return { x: site.x, y: site.y };
}

function issueMove(unitId: number, x: number, y: number, calls: CallBudget): void {
  if (calls.left <= 0) {
    return;
  }
  moveTo(unitId, x, y);
  calls.left -= 1;
}

function issueAttack(unitId: number, targetId: number, calls: CallBudget): void {
  if (calls.left <= 0) {
    return;
  }
  attack(unitId, targetId);
  calls.left -= 1;
}

function issueHarvest(unitId: number, siteId: number, calls: CallBudget): void {
  if (calls.left <= 0) {
    return;
  }
  harvest(unitId, siteId);
  calls.left -= 1;
}

function issueTransfer(unitId: number, calls: CallBudget): void {
  if (calls.left <= 0) {
    return;
  }
  transfer(unitId);
  calls.left -= 1;
}

function useNearestBase(
  worker: ScriptUnit,
  bases: ScriptSite[],
  calls: CallBudget
): boolean {
  const base = nearestSite(worker, bases);
  if (base === null) {
    return false;
  }

  const d = distance(worker.x, worker.y, base.x, base.y);
  if (d === 1) {
    if (worker.carrying > 0) {
      issueTransfer(worker.id, calls);
    }
    return true;
  }

  const target = chooseNeighbor(base, worker.id + 37, calls);
  issueMove(worker.id, target.x, target.y, calls);
  return true;
}

function manageWorker(
  worker: ScriptUnit,
  mines: ScriptSite[],
  neutralResources: ScriptSite[],
  bases: ScriptSite[],
  enemyBases: ScriptSite[],
  enemyMilitary: ScriptUnit[],
  calls: CallBudget
): void {
  const inDanger = nearestEnemyInRadius(worker, enemyMilitary, 2) !== null;

  if (inDanger && worker.carrying > 0 && useNearestBase(worker, bases, calls)) {
    return;
  }
  if (inDanger && worker.carrying === 0 && bases.length > 0) {
    useNearestBase(worker, bases, calls);
    return;
  }

  if (bases.length === 0 && neutralResources.length > 0) {
    const target = nearestSite(worker, neutralResources);
    if (target !== null) {
      if (distance(worker.x, worker.y, target.x, target.y) !== 0) {
        issueMove(worker.id, target.x, target.y, calls);
      }
      return;
    }
  }

  if (bases.length === 0 && enemyBases.length > 0) {
    const target = nearestSite(worker, enemyBases);
    if (target !== null) {
      if (distance(worker.x, worker.y, target.x, target.y) !== 0) {
        issueMove(worker.id, target.x, target.y, calls);
      }
      return;
    }
  }

  if (worker.carrying >= 20) {
    if (bases.length > 0) {
      useNearestBase(worker, bases, calls);
      return;
    }
    const target = nearestSite(worker, enemyBases);
    if (target !== null) {
      if (distance(worker.x, worker.y, target.x, target.y) !== 0) {
        issueMove(worker.id, target.x, target.y, calls);
      }
    }
    return;
  }

  if (mines.length > 0) {
    let index = worker.id % mines.length;
    if (index < 0) {
      index += mines.length;
    }
    const mine = mines[index];
    if (mine === undefined) {
      return;
    }
    const d = distance(worker.x, worker.y, mine.x, mine.y);
    if (d === 1) {
      issueHarvest(worker.id, mine.id, calls);
    } else {
      const target = chooseNeighbor(mine, worker.id, calls);
      issueMove(worker.id, target.x, target.y, calls);
    }
    return;
  }

  if (worker.carrying > 0 && useNearestBase(worker, bases, calls)) {
    return;
  }

  if (neutralResources.length > 0) {
    const target = nearestSite(worker, neutralResources);
    if (target !== null) {
      if (distance(worker.x, worker.y, target.x, target.y) !== 0) {
        issueMove(worker.id, target.x, target.y, calls);
      }
      return;
    }
  }

  if (enemyBases.length > 0) {
    const target = nearestSite(worker, enemyBases);
    if (target !== null) {
      if (distance(worker.x, worker.y, target.x, target.y) !== 0) {
        issueMove(worker.id, target.x, target.y, calls);
      }
      return;
    }
  }

  if (bases.length > 0) {
    useNearestBase(worker, bases, calls);
  }
}

function holdControlledPoint(
  unit: ScriptUnit,
  ordinal: number,
  resources: ScriptSite[],
  bases: ScriptSite[],
  calls: CallBudget
): void {
  if (resources.length > 0) {
    let index = ordinal % resources.length;
    if (index < 0) {
      index += resources.length;
    }
    const resource = resources[index];
    if (resource !== undefined && distance(unit.x, unit.y, resource.x, resource.y) !== 0) {
      issueMove(unit.id, resource.x, resource.y, calls);
    }
    return;
  }

  if (bases.length > 0) {
    let index = ordinal % bases.length;
    if (index < 0) {
      index += bases.length;
    }
    const base = bases[index];
    if (base === undefined) {
      return;
    }
    const d = distance(unit.x, unit.y, base.x, base.y);
    if (d !== 0 && d !== 1) {
      const target = chooseNeighbor(base, unit.id + 71, calls);
      issueMove(unit.id, target.x, target.y, calls);
    } else if (d === 0) {
      const target = chooseNeighbor(base, unit.id + 71, calls);
      issueMove(unit.id, target.x, target.y, calls);
    }
  }
}

function conductSiege(
  unit: ScriptUnit,
  base: ScriptSite,
  enemyMilitary: ScriptUnit[],
  enemyWorkers: ScriptUnit[],
  calls: CallBudget
): void {
  let defender = nearestEnemyInRadius(unit, enemyMilitary, 3);
  if (defender !== null) {
    if (distance(unit.x, unit.y, defender.x, defender.y) <= unitRange(unit)) {
      issueAttack(unit.id, defender.id, calls);
    } else {
      issueMove(unit.id, defender.x, defender.y, calls);
    }
    return;
  }

  defender = nearestEnemyInRadius(unit, enemyWorkers, 2);
  if (defender !== null) {
    if (distance(unit.x, unit.y, defender.x, defender.y) <= unitRange(unit)) {
      issueAttack(unit.id, defender.id, calls);
    } else {
      issueMove(unit.id, defender.x, defender.y, calls);
    }
    return;
  }

  if (distance(unit.x, unit.y, base.x, base.y) !== 0) {
    issueMove(unit.id, base.x, base.y, calls);
  }
}

function manageMilitary(
  unit: ScriptUnit,
  ordinal: number,
  armySize: number,
  enemyMilitary: ScriptUnit[],
  enemyWorkers: ScriptUnit[],
  alertMilitary: ScriptUnit[],
  alertWorkers: ScriptUnit[],
  neutralResources: ScriptSite[],
  controlledResources: ScriptSite[],
  bases: ScriptSite[],
  enemyBases: ScriptSite[],
  weakestEnemyMilitary: number,
  tick: number,
  calls: CallBudget
): void {
  const range = unitRange(unit);

  let close = nearestEnemyInRadius(unit, enemyMilitary, range);
  if (close !== null) {
    issueAttack(unit.id, close.id, calls);
    return;
  }

  close = nearestEnemyInRadius(unit, enemyWorkers, range);
  if (close !== null) {
    issueAttack(unit.id, close.id, calls);
    return;
  }

  let defender = nearestEnemy(unit, alertMilitary);
  if (defender === null) {
    defender = nearestEnemy(unit, alertWorkers);
  }
  if (defender !== null) {
    if (distance(unit.x, unit.y, defender.x, defender.y) <= range) {
      issueAttack(unit.id, defender.id, calls);
    } else {
      issueMove(unit.id, defender.x, defender.y, calls);
    }
    return;
  }

  let claimerCount = 0;
  if (tick >= 18 && armySize >= 3 && neutralResources.length > 0) {
    claimerCount = Math.min(
      neutralResources.length,
      Math.max(1, Math.floor(armySize / 3))
    );
  }

  if (ordinal < claimerCount) {
    const target = neutralResources[ordinal];
    if (target !== undefined && distance(unit.x, unit.y, target.x, target.y) !== 0) {
      issueMove(unit.id, target.x, target.y, calls);
    }
    return;
  }

  if (
    tick >= 45 &&
    armySize >= 5 &&
    enemyBases.length > 0 &&
    weakestEnemyMilitary < armySize
  ) {
    const attackerCount = armySize >= 9
      ? armySize - 3
      : Math.max(1, Math.floor(armySize / 2));
    if (ordinal < attackerCount) {
      let targetIndex = ordinal % enemyBases.length;
      if (targetIndex < 0) {
        targetIndex += enemyBases.length;
      }
      const targetBase = enemyBases[targetIndex];
      if (targetBase !== undefined) {
        conductSiege(unit, targetBase, enemyMilitary, enemyWorkers, calls);
        return;
      }
    }
  }

  holdControlledPoint(unit, ordinal, controlledResources, bases, calls);
}

function produceUnits(
  initialBudget: number,
  bases: ScriptSite[],
  workers: ScriptUnit[],
  military: ScriptUnit[],
  mines: ScriptSite[],
  neutralResources: ScriptSite[],
  homeAlert: boolean,
  calls: CallBudget
): void {
  if (bases.length === 0) {
    return;
  }

  let budget = initialBudget;
  let workerCommitted = workers.length;
  let militaryCommitted = military.length;

  for (let i = 0; i < bases.length; i += 1) {
    const base = bases[i];
    if (base === undefined || base.producing === null) {
      continue;
    }
    if (base.producing.type === "worker") {
      workerCommitted += 1;
    } else {
      militaryCommitted += 1;
    }
  }

  let workerTarget = 4 + bases.length * 2;
  if (workerTarget > 12) {
    workerTarget = 12;
  }
  if (mines.length === 0) {
    workerTarget = neutralResources.length > 0 ? Math.min(workerTarget, 4) : 0;
  }

  for (let i = 0; i < bases.length; i += 1) {
    const base = bases[i];
    if (base === undefined || base.producing !== null || calls.left <= 4) {
      continue;
    }

    let makeWorker = workerCommitted < workerTarget;
    let type: ScriptUnitType;

    if (homeAlert && militaryCommitted === 0 && workerCommitted >= 2) {
      makeWorker = false;
      type = "melee";
    } else if (makeWorker) {
      type = "worker";
    } else {
      type = (militaryCommitted + 1) % 4 === 0 ? "ranged" : "melee";
    }

    if (makeWorker && budget < 4 && budget >= 8) {
      makeWorker = false;
      type = "melee";
    }
    if (!makeWorker && type === "ranged" && budget < 12 && budget >= 8) {
      type = "melee";
    }

    const cost = unitCost(type);
    if (budget < cost) {
      continue;
    }

    const result = spawnUnit(base.id, type);
    calls.left -= 1;
    const failed = isError(result);
    calls.left -= 1;

    if (failed) {
      errCode(result);
      calls.left -= 1;
      continue;
    }

    budget -= cost;
    if (type === "worker") {
      workerCommitted += 1;
    } else {
      militaryCommitted += 1;
    }
  }
}