var myIndex = -1;
var tick = 0;

function cheb(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax > bx ? ax - bx : bx - ax;
  const dy = ay > by ? ay - by : by - ay;
  return dx > dy ? dx : dy;
}

function sign(n: number): number {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

function pickAdjacent(u: Unit, site: Site): { x: number; y: number } {
  let dx = sign(u.x - site.x);
  let dy = sign(u.y - site.y);
  if (dx === 0 && dy === 0) {
    dx = 1;
    dy = 0;
  }
  return { x: site.x + dx, y: site.y + dy };
}

function deliver(u: Unit, myBases: Site[]): void {
  let best: Site | null = null;
  let bestD = 999999;
  for (let i = 0; i < myBases.length; i += 1) {
    const b = myBases[i];
    if (b === undefined) continue;
    const d = cheb(u.x, u.y, b.x, b.y);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  if (best === null) return;
  if (bestD === 1) {
    transfer(u.id);
    return;
  }
  const adj = pickAdjacent(u, best);
  moveTo(u.id, adj.x, adj.y);
}

function gather(u: Unit, myResourceSites: Site[]): void {
  let best: Site | null = null;
  let bestD = 999999;
  for (let i = 0; i < myResourceSites.length; i += 1) {
    const s = myResourceSites[i];
    if (s === undefined) continue;
    const d = cheb(u.x, u.y, s.x, s.y);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  if (best === null) return;
  if (bestD === 1) {
    harvest(u.id, best.id);
    return;
  }
  const adj = pickAdjacent(u, best);
  moveTo(u.id, adj.x, adj.y);
}

function actWorker(u: Unit, myBases: Site[], myResourceSites: Site[], neutralResourceSites: Site[]): void {
  for (let i = 0; i < myBases.length; i += 1) {
    const b = myBases[i];
    if (b !== undefined && u.x === b.x && u.y === b.y) {
      const adj = pickAdjacent(u, b);
      moveTo(u.id, adj.x, adj.y);
      return;
    }
  }
  if (u.carrying >= 20 && myBases.length > 0) {
    deliver(u, myBases);
    return;
  }
  if (myResourceSites.length > 0 && u.carrying < 20) {
    gather(u, myResourceSites);
    return;
  }
  if (u.carrying > 0 && myBases.length > 0) {
    deliver(u, myBases);
    return;
  }
  if (neutralResourceSites.length > 0) {
    const idx = u.id % neutralResourceSites.length;
    const target = neutralResourceSites[idx];
    if (target === undefined) return;
    if (u.x === target.x && u.y === target.y) return;
    moveTo(u.id, target.x, target.y);
    return;
  }
}

function actCombat(
  u: Unit,
  myBases: Site[],
  enemyUnits: Unit[],
  urgentEnemies: Unit[],
  neutralResourceSites: Site[],
  enemyBases: Site[]
): void {
  for (let i = 0; i < myBases.length; i += 1) {
    const b = myBases[i];
    if (b !== undefined && u.x === b.x && u.y === b.y) {
      const adj = pickAdjacent(u, b);
      moveTo(u.id, adj.x, adj.y);
      return;
    }
  }
  const range = u.type === "ranged" ? 2 : 1;
  if (urgentEnemies.length > 0) {
    let best: Unit | null = null;
    let bestD = 999999;
    for (let i = 0; i < urgentEnemies.length; i += 1) {
      const e = urgentEnemies[i];
      if (e === undefined) continue;
      const d = cheb(u.x, u.y, e.x, e.y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (best !== null) {
      if (bestD <= range) {
        attack(u.id, best.id);
        return;
      }
      moveTo(u.id, best.x, best.y);
      return;
    }
  }
  let nearest: Unit | null = null;
  let nearestD = 7;
  for (let i = 0; i < enemyUnits.length; i += 1) {
    const e = enemyUnits[i];
    if (e === undefined) continue;
    const d = cheb(u.x, u.y, e.x, e.y);
    if (d < nearestD) {
      nearestD = d;
      nearest = e;
    }
  }
  if (nearest !== null) {
    if (nearestD <= range) {
      attack(u.id, nearest.id);
      return;
    }
    moveTo(u.id, nearest.x, nearest.y);
    return;
  }
  if (neutralResourceSites.length > 0) {
    const idx = u.id % neutralResourceSites.length;
    const target = neutralResourceSites[idx];
    if (target === undefined) return;
    if (u.x === target.x && u.y === target.y) return;
    moveTo(u.id, target.x, target.y);
    return;
  }
  if (enemyBases.length > 0) {
    let best: Site | null = null;
    let bestD = 999999;
    for (let i = 0; i < enemyBases.length; i += 1) {
      const b = enemyBases[i];
      if (b === undefined) continue;
      const d = cheb(u.x, u.y, b.x, b.y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (best !== null) {
      if (bestD === 0) return;
      moveTo(u.id, best.x, best.y);
      return;
    }
  }
}

function loop(): void {
  const me = getMyIndex();
  const units = getObjectsByType("unit");
  const sites = getObjectsByType("site");
  const players = getObjectsByType("player");

  let myResources = 0;
  for (let i = 0; i < players.length; i += 1) {
    const p = players[i];
    if (p !== undefined && p.index === me) {
      myResources = p.resources;
      break;
    }
  }

  const myUnits: Unit[] = [];
  const enemyUnits: Unit[] = [];
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if (u === undefined) continue;
    if (u.owner === me) {
      myUnits.push(u);
    } else {
      enemyUnits.push(u);
    }
  }

  const myBases: Site[] = [];
  const myResourceSites: Site[] = [];
  const neutralResourceSites: Site[] = [];
  const enemyBases: Site[] = [];
  for (let i = 0; i < sites.length; i += 1) {
    const s = sites[i];
    if (s === undefined) continue;
    if (s.owner === me) {
      if (s.kind === "base") {
        myBases.push(s);
      } else if (s.kind === "resource" && s.remaining !== undefined && s.remaining > 0) {
        myResourceSites.push(s);
      }
    } else if (s.owner === -1 && s.kind === "resource") {
      neutralResourceSites.push(s);
    } else if (s.kind === "base" && s.owner !== me && s.owner !== -1) {
      enemyBases.push(s);
    }
  }

  const urgentEnemies: Unit[] = [];
  for (let i = 0; i < enemyUnits.length; i += 1) {
    const e = enemyUnits[i];
    if (e === undefined) continue;
    let near = false;
    for (let j = 0; j < myBases.length; j += 1) {
      const b = myBases[j];
      if (b !== undefined && cheb(e.x, e.y, b.x, b.y) <= 1) {
        near = true;
        break;
      }
    }
    if (near) urgentEnemies.push(e);
  }

  let workerCount = 0;
  let meleeCount = 0;
  for (let i = 0; i < myUnits.length; i += 1) {
    const u = myUnits[i];
    if (u === undefined) continue;
    if (u.type === "worker") {
      workerCount += 1;
    } else {
      meleeCount += 1;
    }
  }

  let targetWorkers = 0;
  if (myResourceSites.length > 0) {
    targetWorkers = myResourceSites.length * 2;
    if (targetWorkers < 4) targetWorkers = 4;
    if (targetWorkers > 10) targetWorkers = 10;
  }

  let remainingRes = myResources;
  for (let i = 0; i < myBases.length; i += 1) {
    const base = myBases[i];
    if (base === undefined || base.producing !== null) continue;
    if (meleeCount < 1 && remainingRes >= 8) {
      const res = spawnUnit(base.id, "melee");
      if (!isError(res)) {
        remainingRes -= 8;
        meleeCount += 1;
      }
    } else if (workerCount < targetWorkers && remainingRes >= 4) {
      const res = spawnUnit(base.id, "worker");
      if (!isError(res)) {
        remainingRes -= 4;
        workerCount += 1;
      }
    } else if (remainingRes >= 8) {
      const res = spawnUnit(base.id, "melee");
      if (!isError(res)) {
        remainingRes -= 8;
        meleeCount += 1;
      }
    }
  }

  for (let i = 0; i < myUnits.length; i += 1) {
    const u = myUnits[i];
    if (u === undefined) continue;
    if (u.type === "worker") {
      actWorker(u, myBases, myResourceSites, neutralResourceSites);
    } else {
      actCombat(u, myBases, enemyUnits, urgentEnemies, neutralResourceSites, enemyBases);
    }
  }
}