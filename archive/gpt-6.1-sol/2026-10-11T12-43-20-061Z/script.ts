var mySeat = -1;

type BotPoint = { x: number; y: number };

type BotBudget = {
  calls: number;
  comparisons: number;
  occupied: { [key: string]: number };
  reserved: { [key: string]: number };
};

function botDistance(a: BotPoint, b: BotPoint): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function botResult(result: void | ErrResult): boolean {
  if (isError(result)) {
    const code = errCode(result);
    if (code === ERR_NOT_ENOUGH_RESOURCES) {
      return false;
    }
    return false;
  }
  return true;
}

function botMove(
  unit: Unit,
  target: BotPoint,
  budget: BotBudget,
): void {
  if (
    budget.calls >= 560 ||
    (unit.x === target.x && unit.y === target.y)
  ) {
    return;
  }
  budget.calls += 1;
  botResult(moveTo(unit.id, target.x, target.y));
}

function botEdge(
  unit: Unit,
  site: Site,
  budget: BotBudget,
): void {
  if (budget.calls >= 540) {
    return;
  }

  let bestX = unit.x;
  let bestY = unit.y;
  let bestScore = 1000000;

  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const x = site.x + dx;
      const y = site.y + dy;
      const key = x + ":" + y;
      const occupant = budget.occupied[key];
      if (
        (occupant !== undefined && occupant !== unit.id) ||
        budget.reserved[key] !== undefined
      ) {
        continue;
      }
      const score = Math.max(
        Math.abs(unit.x - x),
        Math.abs(unit.y - y),
      );
      if (score >= bestScore) {
        continue;
      }
      budget.calls += 1;
      if (getTerrainAt(x, y) !== "plain") {
        continue;
      }
      bestScore = score;
      bestX = x;
      bestY = y;
    }
  }

  if (bestScore !== 1000000) {
    budget.reserved[bestX + ":" + bestY] = unit.id;
    botMove(unit, { x: bestX, y: bestY }, budget);
  }
}

function loop(): void {
  if (mySeat < 0) {
    mySeat = getMyIndex();
  }

  const tick = getTick();
  const players = getObjectsByType("player");
  let money = 0;
  let alive = false;

  for (let i = 0; i < players.length && i < 4; i += 1) {
    const player = players[i];
    if (player !== undefined && player.index === mySeat) {
      money = player.resources;
      alive = player.alive;
      break;
    }
  }
  if (!alive) {
    return;
  }

  const units = getObjectsByType("unit");
  const sites = getObjectsByType("site");
  const mine: Unit[] = [];
  const enemies: Unit[] = [];
  const bases: Site[] = [];
  const minerals: Site[] = [];
  const objectives: Site[] = [];

  const budget: BotBudget = {
    calls: 5,
    comparisons: 0,
    occupied: {},
    reserved: {},
  };

  let workers = 0;
  let fighters = 0;
  let pendingWorkers = 0;
  let remainingResources = 0;

  for (let i = 0; i < units.length && i < 320; i += 1) {
    const unit = units[i];
    if (unit === undefined) {
      continue;
    }
    budget.occupied[unit.x + ":" + unit.y] = unit.id;
    if (unit.owner === mySeat) {
      mine.push(unit);
      if (unit.type === "worker") {
        workers += 1;
      } else {
        fighters += 1;
      }
    } else {
      enemies.push(unit);
    }
  }

  for (let i = 0; i < sites.length && i < 96; i += 1) {
    const site = sites[i];
    if (site === undefined) {
      continue;
    }
    if (site.owner !== mySeat) {
      if (objectives.length < 32) {
        objectives.push(site);
      }
    } else if (site.kind === "base") {
      if (bases.length < 8) {
        bases.push(site);
      }
      if (
        site.producing !== null &&
        site.producing.type === "worker"
      ) {
        pendingWorkers += 1;
      }
    } else if (
      site.remaining !== undefined &&
      site.remaining > 0 &&
      minerals.length < 24
    ) {
      minerals.push(site);
      remainingResources += site.remaining;
    }
  }

  const assignedMines: { [id: number]: number } = {};
  const assignedObjectives: { [id: number]: number } = {};
  const allocatedDamage: { [id: number]: number } = {};

  const start = mine.length === 0 ? 0 : tick % mine.length;
  const enemyStart = enemies.length === 0 ? 0 : tick % enemies.length;

  for (
    let step = 0;
    step < mine.length && step < 64 && budget.calls < 520;
    step += 1
  ) {
    const unit = mine[(start + step) % mine.length];
    if (unit === undefined) {
      continue;
    }

    let home: Site | null = null;
    let homeDistance = 1000000;

    for (let b = 0; b < bases.length; b += 1) {
      const base = bases[b];
      if (base === undefined) {
        continue;
      }
      const d = botDistance(unit, base);
      if (d < homeDistance) {
        home = base;
        homeDistance = d;
      }
    }

    let nearestEnemy: Unit | null = null;
    let enemyDistance = 1000000;
    let nearestThreat: Unit | null = null;
    let threatDistance = 1000000;
    let attackTarget: Unit | null = null;
    let attackScore = -1000000;
    const range = unit.type === "ranged" ? 2 : 1;
    const damage = unit.type === "melee" ? 3 : 2;

    if (budget.comparisons < 1100) {
      for (
        let e = 0;
        e < enemies.length &&
        e < 24 &&
        budget.comparisons < 1100;
        e += 1
      ) {
        const enemy = enemies[(enemyStart + e) % enemies.length];
        if (enemy === undefined) {
          continue;
        }
        budget.comparisons += 1;
        const d = botDistance(unit, enemy);

        if (d < enemyDistance) {
          nearestEnemy = enemy;
          enemyDistance = d;
        }
        if (enemy.type !== "worker" && d < threatDistance) {
          nearestThreat = enemy;
          threatDistance = d;
        }

        if (unit.type === "worker" || d > range) {
          continue;
        }
        const outstanding =
          enemy.hp - (allocatedDamage[enemy.id] || 0);
        let score = 30 - enemy.hp;
        if (enemy.type === "worker") {
          score += 16;
        } else if (enemy.type === "ranged") {
          score += 12;
        }
        if (outstanding > 0 && outstanding <= damage) {
          score += 40;
        } else if (outstanding <= 0) {
          score -= 100;
        }
        if (score > attackScore) {
          attackScore = score;
          attackTarget = enemy;
        }
      }
    }

    if (attackTarget !== null) {
      budget.calls += 1;
      const d = getRange(
        unit.x,
        unit.y,
        attackTarget.x,
        attackTarget.y,
      );
      if (d <= range) {
        budget.calls += 1;
        if (botResult(attack(unit.id, attackTarget.id))) {
          allocatedDamage[attackTarget.id] =
            (allocatedDamage[attackTarget.id] || 0) + damage;
        }
        continue;
      }
    }

    if (unit.type === "worker") {
      if (
        home !== null &&
        unit.carrying > 0 &&
        homeDistance <= 1
      ) {
        budget.calls += 1;
        const d = getRange(unit.x, unit.y, home.x, home.y);
        if (d <= 1) {
          budget.calls += 1;
          botResult(transfer(unit.id));
          continue;
        }
      }

      if (nearestThreat !== null && threatDistance <= 2) {
        const dx = unit.x > nearestThreat.x
          ? 1
          : unit.x < nearestThreat.x ? -1 : 0;
        const dy = unit.y > nearestThreat.y
          ? 1
          : unit.y < nearestThreat.y ? -1 : 0;
        const x = unit.x + dx;
        const y = unit.y + dy;
        const key = x + ":" + y;

        if (
          (dx !== 0 || dy !== 0) &&
          budget.occupied[key] === undefined &&
          budget.reserved[key] === undefined
        ) {
          budget.calls += 1;
          if (getTerrainAt(x, y) === "plain") {
            budget.reserved[key] = unit.id;
            budget.calls += 1;
            botResult(move(unit.id, dx, dy));
            continue;
          }
        }
        if (home !== null && homeDistance > 1) {
          botEdge(unit, home, budget);
        }
        continue;
      }

      if (unit.carrying >= 20 && home !== null) {
        botEdge(unit, home, budget);
        continue;
      }

      let mineral: Site | null = null;
      let mineralScore = 1000000;

      for (
        let m = 0;
        m < minerals.length &&
        budget.comparisons < 1500;
        m += 1
      ) {
        const site = minerals[m];
        if (site === undefined) {
          continue;
        }
        budget.comparisons += 1;
        const assigned = assignedMines[site.id] || 0;
        const score =
          botDistance(unit, site) * 3 + assigned * 7;
        if (assigned < 5 && score < mineralScore) {
          mineral = site;
          mineralScore = score;
        }
      }

      if (mineral !== null) {
        assignedMines[mineral.id] =
          (assignedMines[mineral.id] || 0) + 1;
        budget.calls += 1;
        const d = getRange(
          unit.x,
          unit.y,
          mineral.x,
          mineral.y,
        );
        if (d <= 1) {
          budget.calls += 1;
          botResult(harvest(unit.id, mineral.id));
        } else {
          botEdge(unit, mineral, budget);
        }
        continue;
      }

      if (unit.carrying > 0 && home !== null) {
        botEdge(unit, home, budget);
        continue;
      }
    } else if (nearestEnemy !== null && enemyDistance <= 4) {
      botMove(unit, nearestEnemy, budget);
      continue;
    }

    let objective: Site | null = null;
    let objectiveScore = 1000000;

    for (
      let s = 0;
      s < objectives.length &&
      budget.comparisons < 1800;
      s += 1
    ) {
      const site = objectives[s];
      if (site === undefined) {
        continue;
      }
      budget.comparisons += 1;
      const d = botDistance(unit, site);
      let score =
        d * 4 + (assignedObjectives[site.id] || 0) * 24;

      if (site.kind === "base") {
        score -= bases.length === 0 ? 100 : 10;
      }
      if (site.owner === -1) {
        score -= 6;
      }
      if (site.progressOwner === mySeat) {
        score -= site.progress * 2;
      }
      if (d === 0) {
        score -= 200;
      }
      if (
        budget.occupied[site.x + ":" + site.y] !== undefined &&
        d !== 0
      ) {
        score += 24;
      }
      if (score < objectiveScore) {
        objective = site;
        objectiveScore = score;
      }
    }

    if (objective !== null) {
      assignedObjectives[objective.id] =
        (assignedObjectives[objective.id] || 0) + 1;
      botMove(unit, objective, budget);
    } else if (home !== null && homeDistance === 0) {
      botEdge(unit, home, budget);
    } else if (
      unit.type !== "worker" &&
      nearestEnemy !== null
    ) {
      botMove(unit, nearestEnemy, budget);
    }
  }

  let desiredWorkers = Math.min(10, minerals.length * 3);
  if (remainingResources < 80 || tick >= 440) {
    desiredWorkers = Math.min(desiredWorkers, 2);
  }

  for (let b = 0; b < bases.length && budget.calls < 600; b += 1) {
    const base = bases[b];
    if (base === undefined || base.producing !== null) {
      continue;
    }

    let type: UnitType = "melee";
    let cost = 8;

    if (
      workers + pendingWorkers < desiredWorkers &&
      (workers + pendingWorkers === 0 ||
        fighters >= workers + pendingWorkers - 1)
    ) {
      type = "worker";
      cost = 4;
    }

    if (money < cost) {
      if (
        money >= 4 &&
        workers + pendingWorkers < desiredWorkers
      ) {
        type = "worker";
        cost = 4;
      } else {
        continue;
      }
    }

    budget.calls += 1;
    if (botResult(spawnUnit(base.id, type))) {
      money -= cost;
      if (type === "worker") {
        pendingWorkers += 1;
      } else {
        fighters += 1;
      }
    }
  }
}