var myIndex = -1;
var defenderId = -1;

function dCheb(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax > bx ? ax - bx : bx - ax;
  const dy = ay > by ? ay - by : by - ay;
  return dx > dy ? dx : dy;
}

function sgn(n: number): number {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

function adjToward(ux: number, uy: number, sx: number, sy: number): { x: number; y: number } {
  let dx = sgn(ux - sx);
  let dy = sgn(uy - sy);
  if (dx === 0 && dy === 0) {
    dx = 1;
    dy = 0;
  }
  return { x: sx + dx, y: sy + dy };
}

function freeAdjacent(sx: number, sy: number, units: Unit[], selfId: number): { x: number; y: number } | null {
  const dxs: number[] = [1, 1, 0, -1, -1, -1, 0, 1];
  const dys: number[] = [0, 1, 1, 1, 0, -1, -1, -1];
  for (let i = 0; i < 8; i += 1) {
    const ddx = dxs[i];
    const ddy = dys[i];
    if (ddx === undefined || ddy === undefined) continue;
    const tx = sx + ddx;
    const ty = sy + ddy;
    if (getTerrainAt(tx, ty) !== "plain") continue;
    let occ = false;
    for (let j = 0; j < units.length; j += 1) {
      const o = units[j];
      if (o === undefined) continue;
      if (o.id !== selfId && o.x === tx && o.y === ty) {
        occ = true;
        break;
      }
    }
    if (!occ) return { x: tx, y: ty };
  }
  return null;
}

function stepOffBase(u: Unit, myBases: Site[], units: Unit[]): boolean {
  for (let i = 0; i < myBases.length; i += 1) {
    const b = myBases[i];
    if (b === undefined) continue;
    if (u.x === b.x && u.y === b.y) {
      const t = freeAdjacent(b.x, b.y, units, u.id);
      if (t !== null) moveTo(u.id, t.x, t.y);
      return true;
    }
  }
  return false;
}

function deliverWorker(u: Unit, myBases: Site[]): void {
  let best: Site | null = null;
  let bestD = 999999;
  for (let i = 0; i < myBases.length; i += 1) {
    const b = myBases[i];
    if (b === undefined) continue;
    const d = dCheb(u.x, u.y, b.x, b.y);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  if (best === null) return;
  if (bestD <= 1) {
    transfer(u.id);
    return;
  }
  const t = adjToward(u.x, u.y, best.x, best.y);
  moveTo(u.id, t.x, t.y);
}

function harvestWorker(u: Unit, myMines: Site[], units: Unit[]): void {
  let best: Site | null = null;
  let bestD = 999999;
  for (let i = 0; i < myMines.length; i += 1) {
    const m = myMines[i];
    if (m === undefined) continue;
    const d = dCheb(u.x, u.y, m.x, m.y);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  if (best === null) return;
  if (bestD === 0) {
    const t = freeAdjacent(best.x, best.y, units, u.id);
    if (t !== null) moveTo(u.id, t.x, t.y);
    return;
  }
  if (bestD === 1) {
    harvest(u.id, best.id);
    return;
  }
  const t = adjToward(u.x, u.y, best.x, best.y);
  moveTo(u.id, t.x, t.y);
}

function actWorker(u: Unit, myBases: Site[], myMines: Site[], units: Unit[]): void {
  if (stepOffBase(u, myBases, units)) return;
  if (u.carrying >= 20 && myBases.length > 0) {
    deliverWorker(u, myBases);
    return;
  }
  if (myMines.length > 0) {
    harvestWorker(u, myMines, units);
    return;
  }
  if (u.carrying > 0 && myBases.length > 0) {
    deliverWorker(u, myBases);
  }
}

function attackNearest(u: Unit, foes: Unit[]): void {
  let best: Unit | null = null;
  let bestD = 999999;
  for (let i = 0; i < foes.length; i += 1) {
    const f = foes[i];
    if (f === undefined) continue;
    const d = dCheb(u.x, u.y, f.x, f.y);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  if (best === null) return;
  if (bestD <= 1) {
    attack(u.id, best.id);
    return;
  }
  moveTo(u.id, best.x, best.y);
}

function actDefender(u: Unit, myBases: Site[], foes: Unit[], units: Unit[]): void {
  if (myBases.length === 0) {
    attackNearest(u, foes);
    return;
  }
  const base = myBases[0];
  if (base === undefined) return;
  if (u.x === base.x && u.y === base.y) {
    const t = freeAdjacent(base.x, base.y, units, u.id);
    if (t !== null) moveTo(u.id, t.x, t.y);
    return;
  }
  for (let i = 0; i < foes.length; i += 1) {
    const f = foes[i];
    if (f === undefined) continue;
    if (dCheb(u.x, u.y, f.x, f.y) <= 1) {
      attack(u.id, f.id);
      return;
    }
  }
  let threat: Unit | null = null;
  let threatD = 999999;
  for (let i = 0; i < foes.length; i += 1) {
    const f = foes[i];
    if (f === undefined) continue;
    const d = dCheb(f.x, f.y, base.x, base.y);
    if (d < threatD) {
      threatD = d;
      threat = f;
    }
  }
  if (threat !== null && threatD <= 4) {
    moveTo(u.id, threat.x, threat.y);
    return;
  }
  const dBase = dCheb(u.x, u.y, base.x, base.y);
  if (dBase > 2) {
    const t = adjToward(u.x, u.y, base.x, base.y);
    moveTo(u.id, t.x, t.y);
  }
}

function actAttacker(
  u: Unit,
  myBases: Site[],
  neutralMines: Site[],
  foeSites: Site[],
  foes: Unit[],
  units: Unit[]
): void {
  if (stepOffBase(u, myBases, units)) return;

  for (let i = 0; i < foes.length; i += 1) {
    const f = foes[i];
    if (f === undefined) continue;
    if (dCheb(u.x, u.y, f.x, f.y) <= 1) {
      attack(u.id, f.id);
      return;
    }
  }

  for (let i = 0; i < neutralMines.length; i += 1) {
    const s = neutralMines[i];
    if (s !== undefined && u.x === s.x && u.y === s.y) return;
  }
  for (let i = 0; i < foeSites.length; i += 1) {
    const s = foeSites[i];
    if (s !== undefined && u.x === s.x && u.y === s.y) return;
  }

  let bestSite: Site | null = null;
  let bestD = 999999;
  for (let i = 0; i < neutralMines.length; i += 1) {
    const s = neutralMines[i];
    if (s === undefined) continue;
    let occ = false;
    for (let j = 0; j < units.length; j += 1) {
      const o = units[j];
      if (o === undefined) continue;
      if (o.id !== u.id && o.owner === u.owner && o.x === s.x && o.y === s.y) {
        occ = true;
        break;
      }
    }
    if (occ) continue;
    const d = dCheb(u.x, u.y, s.x, s.y);
    if (d < bestD) {
      bestD = d;
      bestSite = s;
    }
  }

  if (bestSite === null) {
    for (let i = 0; i < foeSites.length; i += 1) {
      const s = foeSites[i];
      if (s === undefined) continue;
      let occ = false;
      for (let j = 0; j < units.length; j += 1) {
        const o = units[j];
        if (o === undefined) continue;
        if (o.id !== u.id && o.owner === u.owner && o.x === s.x && o.y === s.y) {
          occ = true;
          break;
        }
      }
      if (occ) continue;
      const d = dCheb(u.x, u.y, s.x, s.y);
      if (d < bestD) {
        bestD = d;
        bestSite = s;
      }
    }
  }

  if (bestSite !== null) {
    moveTo(u.id, bestSite.x, bestSite.y);
    return;
  }

  attackNearest(u, foes);
}

function loop(): void {
  if (myIndex < 0) myIndex = getMyIndex();
  const me = myIndex;

  const units = getObjectsByType("unit");
  const sites = getObjectsByType("site");
  const players = getObjectsByType("player");

  let myRes = 0;
  for (let i = 0; i < players.length; i += 1) {
    const p = players[i];
    if (p === undefined) continue;
    if (p.index === me) {
      myRes = p.resources;
      break;
    }
  }

  const myUnits: Unit[] = [];
  const foeUnits: Unit[] = [];
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if (u === undefined) continue;
    if (u.owner === me) myUnits.push(u);
    else foeUnits.push(u);
  }

  const myBases: Site[] = [];
  const myMines: Site[] = [];
  const neutralMines: Site[] = [];
  const foeSites: Site[] = [];
  for (let i = 0; i < sites.length; i += 1) {
    const s = sites[i];
    if (s === undefined) continue;
    if (s.kind === "base") {
      if (s.owner === me) myBases.push(s);
      else if (s.owner >= 0) foeSites.push(s);
    } else {
      if (s.owner === me) {
        const rem = s.remaining;
        if (rem !== undefined && rem > 0) myMines.push(s);
      } else if (s.owner === -1) {
        neutralMines.push(s);
      } else {
        foeSites.push(s);
      }
    }
  }

  let workerCount = 0;
  let meleeCount = 0;
  for (let i = 0; i < myUnits.length; i += 1) {
    const u = myUnits[i];
    if (u === undefined) continue;
    if (u.type === "worker") workerCount += 1;
    else meleeCount += 1;
  }

  let dvValid = false;
  for (let i = 0; i < myUnits.length; i += 1) {
    const u = myUnits[i];
    if (u === undefined) continue;
    if (u.id === defenderId && u.type !== "worker") {
      dvValid = true;
      break;
    }
  }
  if (!dvValid) {
    defenderId = -1;
    for (let i = 0; i < myUnits.length; i += 1) {
      const u = myUnits[i];
      if (u === undefined) continue;
      if (u.type !== "worker") {
        defenderId = u.id;
        break;
      }
    }
  }

  let pool = myRes;
  for (let i = 0; i < myBases.length; i += 1) {
    const base = myBases[i];
    if (base === undefined) continue;
    if (base.producing !== null) continue;

    if (meleeCount < 1 && pool >= 8) {
      const r = spawnUnit(base.id, "melee");
      if (!isError(r)) {
        pool -= 8;
        meleeCount += 1;
      }
      continue;
    }
    if (workerCount < 4 && pool >= 4) {
      const r = spawnUnit(base.id, "worker");
      if (!isError(r)) {
        pool -= 4;
        workerCount += 1;
      }
      continue;
    }
    if (meleeCount < 3 && pool >= 8) {
      const r = spawnUnit(base.id, "melee");
      if (!isError(r)) {
        pool -= 8;
        meleeCount += 1;
      }
      continue;
    }
    if (workerCount < 5 && pool >= 4) {
      const r = spawnUnit(base.id, "worker");
      if (!isError(r)) {
        pool -= 4;
        workerCount += 1;
      }
      continue;
    }
    if (pool >= 8) {
      const r = spawnUnit(base.id, "melee");
      if (!isError(r)) {
        pool -= 8;
        meleeCount += 1;
      }
      continue;
    }
  }

  for (let i = 0; i < myUnits.length; i += 1) {
    const u = myUnits[i];
    if (u === undefined) continue;
    if (u.type === "worker") {
      actWorker(u, myBases, myMines, units);
    } else if (u.id === defenderId) {
      actDefender(u, myBases, foeUnits, units);
    } else {
      actAttacker(u, myBases, neutralMines, foeSites, foeUnits, units);
    }
  }
}