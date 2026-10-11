var myIndex = -1;

type UnitT = { id: number; owner: number; type: string; x: number; y: number; hp: number; carrying: number; };
type SiteT = { id: number; kind: string; x: number; y: number; owner: number; progressOwner: number; progress: number; remaining?: number; producing: { type: string; remainingTicks: number } | null; };

function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax > bx ? ax - bx : bx - ax;
  const dy = ay > by ? ay - by : by - ay;
  return dx > dy ? dx : dy;
}

function loop() {
  const me = getMyIndex();
  myIndex = me;

  const players = getObjectsByType("player");
  const myP = players[me];
  if (myP === undefined) return;
  if (!myP.alive) return;

  const allSites = getObjectsByType("site");
  const allUnits = getObjectsByType("unit");

  const myBases: SiteT[] = [];
  const myResources: SiteT[] = [];
  const neutralSites: SiteT[] = [];
  const myUnits: UnitT[] = [];
  const enemies: UnitT[] = [];
  let workerCount = 0;

  for (let i = 0; i < allSites.length; i += 1) {
    const s = allSites[i];
    if (s === undefined) continue;
    if (s.owner === me) {
      if (s.kind === "base") myBases.push(s);
      else if (s.kind === "resource") myResources.push(s);
    } else if (s.owner === -1) {
      neutralSites.push(s);
    }
  }

  for (let i = 0; i < allUnits.length; i += 1) {
    const u = allUnits[i];
    if (u === undefined) continue;
    if (u.owner === me) {
      myUnits.push(u);
      if (u.type === "worker") workerCount += 1;
    } else {
      enemies.push(u);
    }
  }

  // Production: workers to 6 first, then melee.
  let localRes = myP.resources;
  let localWorkers = workerCount;

  for (let i = 0; i < myBases.length; i += 1) {
    const b = myBases[i];
    if (b === undefined) continue;
    if (b.producing !== null) continue;

    if (localWorkers < 6 && localRes >= 4) {
      const r = spawnUnit(b.id, "worker");
      if (!isError(r)) {
        localRes -= 4;
        localWorkers += 1;
      }
    } else if (localRes >= 8) {
      const r = spawnUnit(b.id, "melee");
      if (!isError(r)) {
        localRes -= 8;
      }
    }
  }

  // Threat detection: enemy near any of my bases.
  let threatX = -1;
  let threatY = -1;
  let threatId = -1;
  let threatDist = 9999;

  for (let bi = 0; bi < myBases.length; bi += 1) {
    const base = myBases[bi];
    if (base === undefined) continue;
    for (let ei = 0; ei < enemies.length; ei += 1) {
      const e = enemies[ei];
      if (e === undefined) continue;
      const d = dist(base.x, base.y, e.x, e.y);
      if (d <= 8 && d < threatDist) {
        threatDist = d;
        threatX = e.x;
        threatY = e.y;
        threatId = e.id;
      }
    }
  }

  // Unit actions.
  for (let i = 0; i < myUnits.length; i += 1) {
    const u = myUnits[i];
    if (u === undefined) continue;
    if (u.type === "worker") {
      handleWorker(u, myBases, myResources, threatX, threatY);
    } else {
      handleMilitary(u, enemies, neutralSites, threatX, threatY, threatId);
    }
  }
}

function handleWorker(
  u: UnitT,
  bases: SiteT[],
  resources: SiteT[],
  threatX: number,
  threatY: number
): void {
  let atBase = false;
  let nbX = -1;
  let nbY = -1;
  let nbDist = 9999;

  for (let i = 0; i < bases.length; i += 1) {
    const b = bases[i];
    if (b === undefined) continue;
    const d = dist(u.x, u.y, b.x, b.y);
    if (d <= 1) atBase = true;
    if (d < nbDist) {
      nbDist = d;
      nbX = b.x;
      nbY = b.y;
    }
  }

  // Flee toward base if threat is very close and base is farther than threat.
  if (threatX >= 0 && nbX >= 0) {
    const td = dist(u.x, u.y, threatX, threatY);
    if (td <= 3 && nbDist > td) {
      moveTo(u.id, nbX, nbY);
      return;
    }
  }

  let atRes = false;
  let nrId = -1;
  let nrX = -1;
  let nrY = -1;
  let nrDist = 9999;

  for (let i = 0; i < resources.length; i += 1) {
    const r = resources[i];
    if (r === undefined) continue;
    if (r.remaining !== undefined && r.remaining <= 0) continue;
    const d = dist(u.x, u.y, r.x, r.y);
    if (d <= 1) atRes = true;
    if (d < nrDist) {
      nrDist = d;
      nrId = r.id;
      nrX = r.x;
      nrY = r.y;
    }
  }

  if (u.carrying >= 20) {
    if (atBase) {
      transfer(u.id);
    } else if (nbX >= 0) {
      moveTo(u.id, nbX, nbY);
    }
  } else if (atRes && nrId >= 0) {
    harvest(u.id, nrId);
  } else if (u.carrying > 0 && atBase) {
    transfer(u.id);
  } else if (nrX >= 0) {
    moveTo(u.id, nrX, nrY);
  } else if (u.carrying > 0 && nbX >= 0) {
    moveTo(u.id, nbX, nbY);
  }
}

function handleMilitary(
  u: UnitT,
  enemies: UnitT[],
  neutralSites: SiteT[],
  threatX: number,
  threatY: number,
  threatId: number
): void {
  const attackRange = u.type === "ranged" ? 2 : 1;

  // Find nearest enemy.
  let eId = -1;
  let ex = -1;
  let ey = -1;
  let ed = 9999;

  for (let i = 0; i < enemies.length; i += 1) {
    const e = enemies[i];
    if (e === undefined) continue;
    const d = dist(u.x, u.y, e.x, e.y);
    if (d < ed) {
      ed = d;
      eId = e.id;
      ex = e.x;
      ey = e.y;
    }
  }

  // Attack if in range.
  if (eId >= 0 && ed <= attackRange) {
    const r = attack(u.id, eId);
    if (isError(r) && ex >= 0) {
      moveTo(u.id, ex, ey);
    }
    return;
  }

  // Find best capture target; detect if already standing on one.
  let onCapture = false;
  let capX = -1;
  let capY = -1;
  let capDist = 9999;

  for (let i = 0; i < neutralSites.length; i += 1) {
    const nr = neutralSites[i];
    if (nr === undefined) continue;
    if (u.x === nr.x && u.y === nr.y) onCapture = true;
    let d = dist(u.x, u.y, nr.x, nr.y);
    if (nr.kind === "base") d -= 5;
    if (nr.progressOwner === myIndex) d -= nr.progress;
    if (nr.progressOwner !== myIndex && nr.progressOwner !== -1) d += 1000;
    if (d < capDist) {
      capDist = d;
      capX = nr.x;
      capY = nr.y;
    }
  }

  // On capture site: hold unless a close enemy needs engagement.
  if (onCapture) {
    if (eId >= 0 && ed <= 4) {
      moveTo(u.id, ex, ey);
      return;
    }
    return;
  }

  // Defend if a threat is near a base and I'm within response range.
  if (threatId >= 0 && threatX >= 0) {
    const td = dist(u.x, u.y, threatX, threatY);
    if (td <= 12) {
      moveTo(u.id, threatX, threatY);
      return;
    }
  }

  // Head toward the best capture target.
  if (capX >= 0) {
    moveTo(u.id, capX, capY);
    return;
  }

  // No capture target: approach nearest enemy.
  if (eId >= 0) {
    moveTo(u.id, ex, ey);
  }
}