var mySeat = -1;

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax >= bx ? ax - bx : bx - ax;
  const dy = ay >= by ? ay - by : by - ay;
  return dx >= dy ? dx : dy;
}

function nearestOwnedMine(
  unit: { x: number; y: number },
  sites: readonly {
    id: number;
    kind: "base" | "resource";
    owner: number;
    x: number;
    y: number;
    remaining?: number;
  }[],
  me: number,
): {
  id: number;
  kind: "base" | "resource";
  owner: number;
  x: number;
  y: number;
  remaining?: number;
} | null {
  let best: {
    id: number;
    kind: "base" | "resource";
    owner: number;
    x: number;
    y: number;
    remaining?: number;
  } | null = null;
  let bestDistance = 0;

  for (let i = 0; i < sites.length; i += 1) {
    const site = sites[i];
    if (
      site === undefined ||
      site.kind !== "resource" ||
      site.owner !== me ||
      site.remaining === undefined ||
      site.remaining <= 0
    ) {
      continue;
    }

    const distance = chebyshev(unit.x, unit.y, site.x, site.y);
    if (
      best === null ||
      distance < bestDistance ||
      (distance === bestDistance && site.id < best.id)
    ) {
      best = site;
      bestDistance = distance;
    }
  }

  return best;
}

function nearestUnownedResource(
  unit: { x: number; y: number },
  sites: readonly {
    id: number;
    kind: "base" | "resource";
    owner: number;
    x: number;
    y: number;
    progressOwner: number;
    progress: number;
    remaining?: number;
  }[],
  me: number,
): {
  id: number;
  kind: "base" | "resource";
  owner: number;
  x: number;
  y: number;
  progressOwner: number;
  progress: number;
  remaining?: number;
} | null {
  let best: {
    id: number;
    kind: "base" | "resource";
    owner: number;
    x: number;
    y: number;
    progressOwner: number;
    progress: number;
    remaining?: number;
  } | null = null;
  let bestDistance = 0;
  let bestProgress = false;

  for (let i = 0; i < sites.length; i += 1) {
    const site = sites[i];
    if (site === undefined || site.kind !== "resource" || site.owner === me) {
      continue;
    }

    const distance = chebyshev(unit.x, unit.y, site.x, site.y);
    const hasOurProgress = site.progressOwner === me;
    if (
      best === null ||
      (hasOurProgress && !bestProgress) ||
      (hasOurProgress === bestProgress &&
        (distance < bestDistance ||
          (distance === bestDistance && site.id < best.id)))
    ) {
      best = site;
      bestDistance = distance;
      bestProgress = hasOurProgress;
    }
  }

  return best;
}

function nearestObjective(
  unit: { x: number; y: number },
  sites: readonly {
    id: number;
    kind: "base" | "resource";
    owner: number;
    x: number;
    y: number;
    progressOwner: number;
    progress: number;
  }[],
  me: number,
): {
  id: number;
  kind: "base" | "resource";
  owner: number;
  x: number;
  y: number;
  progressOwner: number;
  progress: number;
} | null {
  let best: {
    id: number;
    kind: "base" | "resource";
    owner: number;
    x: number;
    y: number;
    progressOwner: number;
    progress: number;
  } | null = null;
  let bestDistance = 0;
  let bestProgress = false;
  let bestResource = false;

  for (let i = 0; i < sites.length; i += 1) {
    const site = sites[i];
    if (site === undefined || site.owner === me) {
      continue;
    }

    const distance = chebyshev(unit.x, unit.y, site.x, site.y);
    const hasOurProgress = site.progressOwner === me;
    const isResource = site.kind === "resource";
    if (
      best === null ||
      (hasOurProgress && !bestProgress) ||
      (hasOurProgress === bestProgress &&
        (isResource && !bestResource ||
          (isResource === bestResource &&
            (distance < bestDistance ||
              (distance === bestDistance && site.id < best.id)))))
    ) {
      best = site;
      bestDistance = distance;
      bestProgress = hasOurProgress;
      bestResource = isResource;
    }
  }

  return best;
}

function bestAdjacentTile(
  unit: { id: number; x: number; y: number },
  target: { x: number; y: number },
  units: readonly { id: number; x: number; y: number }[],
): { x: number; y: number } | null {
  let bestAny: { x: number; y: number; distance: number } | null = null;
  let bestFree: { x: number; y: number; distance: number } | null = null;

  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }

      const x = target.x + dx;
      const y = target.y + dy;
      if (getTerrainAt(x, y) !== "plain") {
        continue;
      }

      const distance = chebyshev(unit.x, unit.y, x, y);
      const candidate = { x: x, y: y, distance: distance };

      if (
        bestAny === null ||
        distance < bestAny.distance ||
        (distance === bestAny.distance &&
          (x < bestAny.x || (x === bestAny.x && y < bestAny.y)))
      ) {
        bestAny = candidate;
      }

      let occupied = false;
      for (let i = 0; i < units.length; i += 1) {
        const other = units[i];
        if (
          other !== undefined &&
          other.id !== unit.id &&
          other.x === x &&
          other.y === y
        ) {
          occupied = true;
          break;
        }
      }

      if (
        !occupied &&
        (bestFree === null ||
          distance < bestFree.distance ||
          (distance === bestFree.distance &&
            (x < bestFree.x || (x === bestFree.x && y < bestFree.y))))
      ) {
        bestFree = candidate;
      }
    }
  }

  const chosen = bestFree !== null ? bestFree : bestAny;
  if (chosen === null) {
    return null;
  }
  return { x: chosen.x, y: chosen.y };
}

function nearestBase(
  unit: { x: number; y: number },
  bases: readonly { id: number; x: number; y: number }[],
): { id: number; x: number; y: number } | null {
  let best: { id: number; x: number; y: number } | null = null;
  let bestDistance = 0;

  for (let i = 0; i < bases.length; i += 1) {
    const base = bases[i];
    if (base === undefined) {
      continue;
    }

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

function nearestAttackTarget(
  unit: { x: number; y: number; type: string },
  foes: readonly {
    id: number;
    owner: number;
    type: string;
    x: number;
    y: number;
    hp: number;
  }[],
): number {
  const attackRange = unit.type === "ranged" ? 2 : 1;
  let bestId = -1;
  let bestScore = 0;

  for (let i = 0; i < foes.length; i += 1) {
    const foe = foes[i];
    if (foe === undefined) {
      continue;
    }

    const distance = getRange(unit.x, unit.y, foe.x, foe.y);
    if (distance > attackRange) {
      continue;
    }

    const score =
      distance * 100 +
      (foe.type === "worker" ? 0 : 40) +
      foe.hp;

    if (bestId < 0 || score < bestScore || (score === bestScore && foe.id < bestId)) {
      bestId = foe.id;
      bestScore = score;
    }
  }

  return bestId;
}

function returnWorkerToBase(
  unit: { id: number; x: number; y: number; carrying: number },
  bases: readonly { id: number; x: number; y: number }[],
  units: readonly { id: number; x: number; y: number }[],
): void {
  const base = nearestBase(unit, bases);
  if (base === null) {
    return;
  }

  if (getRange(unit.x, unit.y, base.x, base.y) === 1) {
    transfer(unit.id);
    return;
  }

  const adjacent = bestAdjacentTile(unit, base, units);
  if (
    adjacent !== null &&
    (adjacent.x !== unit.x || adjacent.y !== unit.y)
  ) {
    moveTo(unit.id, adjacent.x, adjacent.y);
  }
}

function loop(): void {
  if (mySeat < 0) {
    mySeat = getMyIndex();
  }

  const me = mySeat;
  const players = getObjectsByType("player");
  const mine = players[me];
  if (mine === undefined || !mine.alive) {
    return;
  }

  const units = getObjectsByType("unit");
  const sites = getObjectsByType("site");
  const bases = getObjectsByType("site", { owner: me, kind: "base" });
  const foes: {
    id: number;
    owner: number;
    type: string;
    x: number;
    y: number;
    hp: number;
  }[] = [];

  let workerCount = 0;
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (unit === undefined) {
      continue;
    }
    if (unit.owner !== me) {
      foes.push(unit);
    } else if (unit.type === "worker") {
      workerCount += 1;
    }
  }

  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (unit === undefined || unit.owner !== me) {
      continue;
    }

    if (unit.type === "worker") {
      if (unit.carrying >= 20) {
        returnWorkerToBase(unit, bases, units);
        continue;
      }

      const mineSite = nearestOwnedMine(unit, sites, me);
      if (mineSite !== null) {
        if (getRange(unit.x, unit.y, mineSite.x, mineSite.y) === 1) {
          harvest(unit.id, mineSite.id);
        } else {
          const adjacent = bestAdjacentTile(unit, mineSite, units);
          if (
            adjacent !== null &&
            (adjacent.x !== unit.x || adjacent.y !== unit.y)
          ) {
            moveTo(unit.id, adjacent.x, adjacent.y);
          }
        }
        continue;
      }

      if (unit.carrying > 0) {
        returnWorkerToBase(unit, bases, units);
        continue;
      }

      const resourceTarget = nearestUnownedResource(unit, sites, me);
      if (
        resourceTarget !== null &&
        (resourceTarget.x !== unit.x || resourceTarget.y !== unit.y)
      ) {
        moveTo(unit.id, resourceTarget.x, resourceTarget.y);
      }
      continue;
    }

    const attackTarget = nearestAttackTarget(unit, foes);
    if (attackTarget >= 0) {
      attack(unit.id, attackTarget);
      continue;
    }

    const objective = nearestObjective(unit, sites, me);
    if (
      objective !== null &&
      (objective.x !== unit.x || objective.y !== unit.y)
    ) {
      moveTo(unit.id, objective.x, objective.y);
    }
  }

  let activeResourceCount = 0;
  for (let i = 0; i < sites.length; i += 1) {
    const site = sites[i];
    if (
      site !== undefined &&
      site.kind === "resource" &&
      site.owner === me &&
      site.remaining !== undefined &&
      site.remaining > 0
    ) {
      activeResourceCount += 1;
    }
  }

  let desiredWorkers = activeResourceCount * 2;
  if (desiredWorkers < 4) {
    desiredWorkers = 4;
  }
  if (desiredWorkers > 10) {
    desiredWorkers = 10;
  }

  let budget = mine.resources;
  let plannedWorkers = workerCount;
  for (let i = 0; i < bases.length; i += 1) {
    const base = bases[i];
    if (base === undefined || base.producing !== null) {
      continue;
    }

    if (plannedWorkers < desiredWorkers) {
      if (budget >= 4) {
        spawnUnit(base.id, "worker");
        budget -= 4;
        plannedWorkers += 1;
      }
    } else if (budget >= 8) {
      spawnUnit(base.id, "melee");
      budget -= 8;
    }
  }
}