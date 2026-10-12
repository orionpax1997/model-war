// script.ts — 1v1v1v1 RTS bot

const WORKER_COST = 4;
const MELEE_COST = 8;
const CARRY_LIMIT = 20;
const MAX_WORKERS = 4;

type Dir = readonly [number, number];
const DIRS: readonly Dir[] = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
  [1, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
];

function loop(): void {
  const me = getMyIndex();
  const players = getObjectsByType("player");
  const mePlayer = players[me];
  if (mePlayer === undefined) return;
  if (!mePlayer.alive) return;

  const resources = mePlayer.resources;

  const myUnits = getObjectsByType("unit", { owner: me });
  const allUnits = getObjectsByType("unit");
  const allSites = getObjectsByType("site");

  // Partition sites
  const myBases: Site[] = [];
  const myResSites: Site[] = [];
  const captureTargets: Site[] = [];
  for (let i = 0; i < allSites.length; i += 1) {
    const s = allSites[i];
    if (s === undefined) continue;
    if (s.owner === me) {
      if (s.kind === "base") myBases.push(s);
      else myResSites.push(s);
    } else {
      captureTargets.push(s);
    }
  }

  // Partition units
  const enemies: Unit[] = [];
  const myWorkers: Unit[] = [];
  const myFighters: Unit[] = [];
  for (let i = 0; i < allUnits.length; i += 1) {
    const u = allUnits[i];
    if (u === undefined) continue;
    if (u.owner !== me) enemies.push(u);
    else if (u.type === "worker") myWorkers.push(u);
    else myFighters.push(u);
  }

  // Production
  const workerCount = myWorkers.length;
  const fighterCount = myFighters.length;
  for (let i = 0; i < myBases.length; i += 1) {
    const base = myBases[i];
    if (base === undefined) continue;
    if (base.producing !== null) continue;

    if (workerCount < MAX_WORKERS && workerCount < fighterCount + 2 && resources >= WORKER_COST) {
      spawnUnit(base.id, "worker");
    } else if (resources >= MELEE_COST) {
      spawnUnit(base.id, "melee");
    } else if (workerCount < MAX_WORKERS && resources >= WORKER_COST) {
      spawnUnit(base.id, "worker");
    }
  }

  // Worker actions
  for (let i = 0; i < myWorkers.length; i += 1) {
    const w = myWorkers[i];
    if (w === undefined) continue;
    doWorker(w, myBases, myResSites, myUnits);
  }

  // Fighter actions
  for (let i = 0; i < myFighters.length; i += 1) {
    const f = myFighters[i];
    if (f === undefined) continue;
    doFighter(f, enemies, captureTargets);
  }
}

function doWorker(w: Unit, bases: Site[], resSites: Site[], myUnits: Unit[]): void {
  if (w.carrying >= CARRY_LIMIT) {
    if (bases.length === 0) return;
    const base = nearestSite(w.x, w.y, bases);
    if (base === null) return;
    const bd = getRange(w.x, w.y, base.x, base.y);
    if (bd <= 1) {
      transfer(w.id);
      return;
    }
    moveTo(w.id, base.x, base.y);
    return;
  }

  if (resSites.length === 0) return;

  // Already harvesting? idle.
  for (let i = 0; i < resSites.length; i += 1) {
    const s = resSites[i];
    if (s === undefined) continue;
    if (getRange(w.x, w.y, s.x, s.y) <= 1) return;
  }

  const target = nearestSite(w.x, w.y, resSites);
  if (target === null) return;

  for (let i = 0; i < DIRS.length; i += 1) {
    const dir = DIRS[i];
    if (dir === undefined) continue;
    const tx = target.x + dir[0];
    const ty = target.y + dir[1];
    if (getTerrainAt(tx, ty) !== "plain") continue;
    let taken = false;
    for (let j = 0; j < myUnits.length; j += 1) {
      const u = myUnits[j];
      if (u === undefined) continue;
      if (u.id !== w.id && u.x === tx && u.y === ty) {
        taken = true;
        break;
      }
    }
    if (taken) continue;
    moveTo(w.id, tx, ty);
    return;
  }

  moveTo(w.id, target.x, target.y);
}

function doFighter(f: Unit, enemies: Unit[], captureTargets: Site[]): void {
  // Choose nearest enemy, slightly preferring workers.
  let nearest: Unit | null = null;
  let nearestDist = 0;
  let nearestScore = 0;
  for (let i = 0; i < enemies.length; i += 1) {
    const e = enemies[i];
    if (e === undefined) continue;
    const d = getRange(f.x, f.y, e.x, e.y);
    const bonus = e.type === "worker" ? 1 : 0;
    const score = d - bonus;
    if (nearest === null || score < nearestScore) {
      nearest = e;
      nearestDist = d;
      nearestScore = score;
    }
  }

  if (nearest !== null && nearestDist <= 1) {
    attack(f.id, nearest.id);
    return;
  }

  // Close enemy: chase it.
  if (nearest !== null && nearestDist <= 2) {
    moveTo(f.id, nearest.x, nearest.y);
    return;
  }

  // Otherwise pick a capture target.
  let captureTarget: Site | null = null;
  let captureScore = 0;
  for (let i = 0; i < captureTargets.length; i += 1) {
    const s = captureTargets[i];
    if (s === undefined) continue;
    const d = getRange(f.x, f.y, s.x, s.y);
    const kindBonus = s.kind === "resource" ? 0 : 4;
    const ownerPenalty = s.owner >= 0 ? 3 : 0;
    const score = d + kindBonus + ownerPenalty;
    if (captureTarget === null || score < captureScore) {
      captureTarget = s;
      captureScore = score;
    }
  }

  if (captureTarget !== null) {
    moveTo(f.id, captureTarget.x, captureTarget.y);
    return;
  }

  if (nearest !== null) {
    moveTo(f.id, nearest.x, nearest.y);
  }
}

function nearestSite(ax: number, ay: number, sites: readonly Site[]): Site | null {
  let best: Site | null = null;
  let bestDist = 0;
  for (let i = 0; i < sites.length; i += 1) {
    const s = sites[i];
    if (s === undefined) continue;
    const d = getRange(ax, ay, s.x, s.y);
    if (best === null || d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}
