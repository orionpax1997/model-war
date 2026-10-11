var myIndex = -1;

const WORKER_TARGET = 6;
const CARRY_LIMIT = 20;
const WORKER_COST = 4;
const MELEE_COST = 8;

function cheb(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax >= bx ? ax - bx : bx - ax;
  const dy = ay >= by ? ay - by : by - ay;
  return dx >= dy ? dx : dy;
}

function parkAdjacent(sx: number, sy: number, rot: number): { x: number; y: number } | null {
  const dxs = [1, -1, 0, 0, 1, 1, -1, -1];
  const dys = [0, 0, 1, -1, 1, -1, 1, -1];
  const start = rot % 8;
  for (let i = 0; i < 8; i += 1) {
    const k = (start + i) % 8;
    const ddx = dxs[k];
    const ddy = dys[k];
    if (ddx === undefined || ddy === undefined) {
      continue;
    }
    const nx = sx + ddx;
    const ny = sy + ddy;
    if (getTerrainAt(nx, ny) === "plain") {
      return { x: nx, y: ny };
    }
  }
  return null;
}

function stepOffToAdjacent(u: any, sx: number, sy: number): void {
  const p = parkAdjacent(sx, sy, u.id);
  if (p !== null) {
    moveTo(u.id, p.x, p.y);
  }
}

function nearestIndex(px: number, py: number, list: any[]): number {
  let best = -1;
  let bestD = 0;
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i];
    if (t === undefined) {
      continue;
    }
    const d = cheb(px, py, t.x, t.y);
    if (best === -1 || d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

function deliver(u: any, myBases: any[]): void {
  const bi = nearestIndex(u.x, u.y, myBases);
  if (bi === -1) {
    return;
  }
  const b = myBases[bi];
  if (b === undefined) {
    return;
  }
  const d = cheb(u.x, u.y, b.x, b.y);
  if (d === 1) {
    const r = transfer(u.id);
    if (isError(r)) {
      moveTo(u.id, b.x, b.y);
    }
    return;
  }
  if (d === 0) {
    stepOffToAdjacent(u, b.x, b.y);
    return;
  }
  const p = parkAdjacent(b.x, b.y, u.id);
  if (p !== null) {
    moveTo(u.id, p.x, p.y);
  } else {
    moveTo(u.id, b.x, b.y);
  }
}

function workerLogic(u: any, wIdx: number, myRes: any[], neutralRes: any[], myBases: any[]): void {
  if (u.carrying >= CARRY_LIMIT) {
    deliver(u, myBases);
    return;
  }
  if (myRes.length > 0) {
    const site = myRes[wIdx % myRes.length];
    if (site !== undefined) {
      const d = cheb(u.x, u.y, site.x, site.y);
      if (d === 0) {
        stepOffToAdjacent(u, site.x, site.y);
        return;
      }
      if (d === 1) {
        const r = harvest(u.id, site.id);
        if (isError(r)) {
          moveTo(u.id, site.x, site.y);
        }
        return;
      }
      moveTo(u.id, site.x, site.y);
      return;
    }
  }
  if (neutralRes.length > 0) {
    const t = neutralRes[wIdx % neutralRes.length];
    if (t !== undefined) {
      if (cheb(u.x, u.y, t.x, t.y) === 0) {
        return;
      }
      moveTo(u.id, t.x, t.y);
      return;
    }
  }
  if (u.carrying > 0) {
    deliver(u, myBases);
  }
}

function soldierLogic(
  u: any,
  idx: number,
  enemies: any[],
  neutralRes: any[],
  enemyBases: any[],
  myBases: any[],
  soldiers: number,
  tick: number,
): void {
  const ei = nearestIndex(u.x, u.y, enemies);
  if (ei !== -1) {
    const e = enemies[ei];
    if (e !== undefined) {
      const d = cheb(u.x, u.y, e.x, e.y);
      if (d <= 1) {
        attack(u.id, e.id);
        return;
      }
      if (d <= 3) {
        moveTo(u.id, e.x, e.y);
        return;
      }
    }
  }
  if (neutralRes.length > 0) {
    const t = neutralRes[idx % neutralRes.length];
    if (t !== undefined) {
      if (cheb(u.x, u.y, t.x, t.y) === 0) {
        return;
      }
      moveTo(u.id, t.x, t.y);
      return;
    }
  }
  if (enemyBases.length > 0 && (soldiers >= 4 || tick > 300)) {
    const bi = nearestIndex(u.x, u.y, enemyBases);
    const b = enemyBases[bi];
    if (b !== undefined) {
      moveTo(u.id, b.x, b.y);
      return;
    }
  }
  const hi = nearestIndex(u.x, u.y, myBases);
  if (hi !== -1) {
    const b = myBases[hi];
    if (b !== undefined) {
      const d = cheb(u.x, u.y, b.x, b.y);
      if (d > 1) {
        const p = parkAdjacent(b.x, b.y, u.id);
        if (p !== null) {
          moveTo(u.id, p.x, p.y);
        }
      }
    }
  }
}

function loop() {
  if (myIndex < 0) {
    myIndex = getMyIndex();
  }
  const me = myIndex;
  const players = getObjectsByType("player");
  const meRow = players[me];
  if (meRow === undefined) {
    return;
  }
  if (meRow.alive === false) {
    return;
  }
  let money = meRow.resources;
  const tick = getTick();

  const allSites = getObjectsByType("site");
  const allUnits = getObjectsByType("unit");

  const myBases: any[] = [];
  const myRes: any[] = [];
  const neutralRes: any[] = [];
  const enemyBases: any[] = [];
  for (let i = 0; i < allSites.length; i += 1) {
    const s = allSites[i];
    if (s === undefined) {
      continue;
    }
    if (s.kind === "base") {
      if (s.owner === me) {
        myBases.push(s);
      } else if (s.owner >= 0) {
        enemyBases.push(s);
      }
    } else if (s.kind === "resource") {
      if (s.owner === me) {
        if (s.remaining !== undefined && s.remaining > 0) {
          myRes.push(s);
        }
      } else if (s.owner === -1) {
        if (s.remaining !== undefined && s.remaining > 0) {
          neutralRes.push(s);
        }
      }
    }
  }

  const myUnits: any[] = [];
  const enemies: any[] = [];
  let workers = 0;
  let soldiers = 0;
  for (let i = 0; i < allUnits.length; i += 1) {
    const u = allUnits[i];
    if (u === undefined) {
      continue;
    }
    if (u.owner === me) {
      myUnits.push(u);
      if (u.type === "worker") {
        workers += 1;
      } else {
        soldiers += 1;
      }
    } else {
      enemies.push(u);
    }
  }

  for (let i = 0; i < myBases.length; i += 1) {
    const b = myBases[i];
    if (b === undefined) {
      continue;
    }
    if (b.producing !== null) {
      continue;
    }
    if (workers < WORKER_TARGET) {
      if (money >= WORKER_COST) {
        const r = spawnUnit(b.id, "worker");
        if (isError(r) === false) {
          money -= WORKER_COST;
          workers += 1;
        }
      }
    } else if (money >= MELEE_COST) {
      const r = spawnUnit(b.id, "melee");
      if (isError(r) === false) {
        money -= MELEE_COST;
        soldiers += 1;
      }
    }
  }

  let wIdx = 0;
  let soldierIdx = 0;
  for (let i = 0; i < myUnits.length; i += 1) {
    const u = myUnits[i];
    if (u === undefined) {
      continue;
    }
    if (u.type === "worker") {
      workerLogic(u, wIdx, myRes, neutralRes, myBases);
      wIdx += 1;
    } else {
      soldierLogic(u, soldierIdx, enemies, neutralRes, enemyBases, myBases, soldiers, tick);
      soldierIdx += 1;
    }
  }
}