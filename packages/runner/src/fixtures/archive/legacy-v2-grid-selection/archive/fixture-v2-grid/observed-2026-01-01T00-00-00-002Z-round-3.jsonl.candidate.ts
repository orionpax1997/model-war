var myIndex = -1;

function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax > bx ? ax - bx : bx - ax;
  const dy = ay > by ? ay - by : by - ay;
  return dx > dy ? dx : dy;
}

function offX(k: number): number {
  const t = k % 8;
  if (t === 0) return 1;
  if (t === 1) return 1;
  if (t === 2) return 0;
  if (t === 3) return -1;
  if (t === 4) return -1;
  if (t === 5) return -1;
  if (t === 6) return 0;
  return 1;
}

function offY(k: number): number {
  const t = k % 8;
  if (t === 0) return 0;
  if (t === 1) return 1;
  if (t === 2) return 1;
  if (t === 3) return 1;
  if (t === 4) return 0;
  if (t === 5) return -1;
  if (t === 6) return -1;
  return -1;
}

function stepOff(u: Unit, b: Site): void {
  const k = u.id % 8;
  moveTo(u.id, b.x + offX(k), b.y + offY(k));
}

function nearestBase(u: Unit, bases: Site[]): Site | null {
  let best: Site | null = null;
  let bestD = 999999;
  for (let i = 0; i < bases.length; i += 1) {
    const b = bases[i];
    if (b === undefined) continue;
    const d = dist(u.x, u.y, b.x, b.y);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

function deliver(u: Unit, bases: Site[]): void {
  const b = nearestBase(u, bases);
  if (b === null) return;
  const d = dist(u.x, u.y, b.x, b.y);
  if (d <= 1) {
    transfer(u.id);
    return;
  }
  moveTo(u.id, b.x, b.y);
}

function actWorker(u: Unit, myBases: Site[], myMines: Site[]): void {
  if (u.carrying >= 20) {
    deliver(u, myBases);
    return;
  }
  for (let i = 0; i < myBases.length; i += 1) {
    const b = myBases[i];
    if (b === undefined) continue;
    if (u.x === b.x && u.y === b.y) {
      stepOff(u, b);
      return;
    }
  }
  let best: Site | null = null;
  let bestD = 999999;
  for (let i = 0; i < myMines.length; i += 1) {
    const s = myMines[i];
    if (s === undefined) continue;
    const d = dist(u.x, u.y, s.x, s.y);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  if (best !== null) {
    if (bestD <= 1) {
      harvest(u.id, best.id);
      return;
    }
    moveTo(u.id, best.x, best.y);
    return;
  }
  if (u.carrying > 0) {
    deliver(u, myBases);
  }
}

function actFight(u: Unit, foe: Unit): void {
  const range = u.type === "ranged" ? 2 : 1;
  const d = dist(u.x, u.y, foe.x, foe.y);
  if (d <= range) {
    attack(u.id, foe.id);
    return;
  }
  moveTo(u.id, foe.x, foe.y);
}

function actCapture(u: Unit, s: Site): void {
  if (u.x === s.x && u.y === s.y) {
    return;
  }
  moveTo(u.id, s.x, s.y);
}

function loop(): void {
  if (myIndex < 0) {
    myIndex = getMyIndex();
  }
  const me = myIndex;

  const units = getObjectsByType("unit");
  const sites = getObjectsByType("site");
  const players = getObjectsByType("player");

  let myResources = 0;
  for (let i = 0; i < players.length; i += 1) {
    const p = players[i];
    if (p === undefined) continue;
    if (p.index === me) {
      myResources = p.resources;
      break;
    }
  }

  const myUnits: Unit[] = [];
  const foeUnits: Unit[] = [];
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if (u === undefined) continue;
    if (u.owner === me) {
      myUnits.push(u);
    } else {
      foeUnits.push(u);
    }
  }

  const myBases: Site[] = [];
  const myMines: Site[] = [];
  const neutralMines: Site[] = [];
  const foeBases: Site[] = [];
  const foeMines: Site[] = [];
  for (let i = 0; i < sites.length; i += 1) {
    const s = sites[i];
    if (s === undefined) continue;
    if (s.kind === "base") {
      if (s.owner === me) {
        myBases.push(s);
      } else if (s.owner >= 0) {
        foeBases.push(s);
      }
    } else {
      if (s.owner === me) {
        if (s.remaining !== undefined && s.remaining > 0) {
          myMines.push(s);
        }
      } else if (s.owner === -1) {
        neutralMines.push(s);
      } else {
        foeMines.push(s);
      }
    }
  }

  const captureTargets: Site[] = [];
  for (let i = 0; i < neutralMines.length; i += 1) {
    const s = neutralMines[i];
    if (s !== undefined) captureTargets.push(s);
  }
  for (let i = 0; i < foeBases.length; i += 1) {
    const s = foeBases[i];
    if (s !== undefined) captureTargets.push(s);
  }
  for (let i = 0; i < foeMines.length; i += 1) {
    const s = foeMines[i];
    if (s !== undefined) captureTargets.push(s);
  }

  const freeTargets: Site[] = [];
  for (let i = 0; i < captureTargets.length; i += 1) {
    const s = captureTargets[i];
    if (s === undefined) continue;
    let occupied = false;
    for (let j = 0; j < myUnits.length; j += 1) {
      const u = myUnits[j];
      if (u === undefined) continue;
      if (u.x === s.x && u.y === s.y) {
        occupied = true;
        break;
      }
    }
    if (!occupied) freeTargets.push(s);
  }

  let hasHome = false;
  let homeX = 0;
  let homeY = 0;
  if (myBases.length > 0) {
    const b0 = myBases[0];
    if (b0 !== undefined) {
      homeX = b0.x;
      homeY = b0.y;
      hasHome = true;
    }
  }

  let threat: Unit | null = null;
  if (hasHome) {
    let bestD = 7;
    for (let i = 0; i < foeUnits.length; i += 1) {
      const f = foeUnits[i];
      if (f === undefined) continue;
      const d = dist(homeX, homeY, f.x, f.y);
      if (d < bestD) {
        bestD = d;
        threat = f;
      }
    }
  }

  let workerCount = 0;
  let combatCount = 0;
  for (let i = 0; i < myUnits.length; i += 1) {
    const u = myUnits[i];
    if (u === undefined) continue;
    if (u.type === "worker") {
      workerCount += 1;
    } else {
      combatCount += 1;
    }
  }

  let pool = myResources;
  for (let i = 0; i < myBases.length; i += 1) {
    const base = myBases[i];
    if (base === undefined) continue;
    if (base.producing !== null) continue;
    if (workerCount < 5 && pool >= 4 && (combatCount >= 1 || workerCount < 2)) {
      const res = spawnUnit(base.id, "worker");
      if (!isError(res)) {
        pool -= 4;
        workerCount += 1;
      }
      continue;
    }
    if (pool >= 8) {
      const res = spawnUnit(base.id, "melee");
      if (!isError(res)) {
        pool -= 8;
        combatCount += 1;
      }
      continue;
    }
    if (workerCount < 5 && pool >= 4) {
      const res = spawnUnit(base.id, "worker");
      if (!isError(res)) {
        pool -= 4;
        workerCount += 1;
      }
    }
  }

  let combatSeen = 0;
  for (let i = 0; i < myUnits.length; i += 1) {
    const u = myUnits[i];
    if (u === undefined) continue;
    if (u.type === "worker") {
      actWorker(u, myBases, myMines);
      continue;
    }

    let onBase = false;
    for (let j = 0; j < myBases.length; j += 1) {
      const b = myBases[j];
      if (b === undefined) continue;
      if (u.x === b.x && u.y === b.y) {
        stepOff(u, b);
        onBase = true;
        break;
      }
    }
    if (onBase) continue;

    let onTarget = false;
    if (threat === null) {
      for (let j = 0; j < captureTargets.length; j += 1) {
        const s = captureTargets[j];
        if (s === undefined) continue;
        if (u.x === s.x && u.y === s.y) {
          onTarget = true;
          break;
        }
      }
    }
    if (onTarget) continue;

    if (threat !== null) {
      actFight(u, threat);
      continue;
    }

    if (freeTargets.length > 0) {
      const t = freeTargets[combatSeen % freeTargets.length];
      combatSeen += 1;
      if (t !== undefined) {
        actCapture(u, t);
      }
      continue;
    }

    let bestFoe: Unit | null = null;
    let bestFD = 999999;
    for (let j = 0; j < foeUnits.length; j += 1) {
      const f = foeUnits[j];
      if (f === undefined) continue;
      const d = dist(u.x, u.y, f.x, f.y);
      if (d < bestFD) {
        bestFD = d;
        bestFoe = f;
      }
    }
    if (bestFoe !== null) {
      actFight(u, bestFoe);
    }
  }
}