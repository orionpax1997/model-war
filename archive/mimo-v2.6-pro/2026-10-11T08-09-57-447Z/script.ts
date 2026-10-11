type TUnit = {
  id: number;
  owner: number;
  type: string;
  x: number;
  y: number;
  hp: number;
  carrying: number;
};

type TSite = {
  id: number;
  kind: string;
  x: number;
  y: number;
  owner: number;
  progressOwner: number;
  progress: number;
  remaining?: number;
  producing: { type: string; remainingTicks: number } | null;
};

var seat: number = -1;

var foeId: number = -1;
var foeX: number = 0;
var foeY: number = 0;
var foeD: number = 0;

function dist(ax: number, ay: number, bx: number, by: number): number {
  let dx = ax - bx;
  let dy = ay - by;
  if (dx < 0) {
    dx = -dx;
  }
  if (dy < 0) {
    dy = -dy;
  }
  return dx > dy ? dx : dy;
}

function nbx(k: number): number {
  let r = k % 8;
  if (r < 0) {
    r = r + 8;
  }
  if (r === 3 || r === 7) {
    return 0;
  }
  return r < 3 ? 1 : -1;
}

function nby(k: number): number {
  let r = k % 8;
  if (r < 0) {
    r = r + 8;
  }
  if (r === 1 || r === 5) {
    return 0;
  }
  return r >= 2 && r <= 4 ? 1 : -1;
}

function sortSites(arr: TSite[]): void {
  for (let i = 1; i < arr.length; i += 1) {
    const v = arr[i];
    if (v === undefined) {
      continue;
    }
    let j = i - 1;
    while (j >= 0) {
      const w = arr[j];
      if (w === undefined) {
        break;
      }
      if (w.id <= v.id) {
        break;
      }
      arr[j + 1] = w;
      j = j - 1;
    }
    arr[j + 1] = v;
  }
}

function nearestSiteIndex(u: TUnit, list: TSite[]): number {
  let best = -1;
  let bestD = 0;
  for (let i = 0; i < list.length; i += 1) {
    const s = list[i];
    if (s === undefined) {
      continue;
    }
    const d = dist(u.x, u.y, s.x, s.y);
    if (best === -1 || d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

function scanFoeNear(u: TUnit, foes: TUnit[], lim: number): void {
  foeId = -1;
  foeX = 0;
  foeY = 0;
  foeD = lim;
  for (let i = 0; i < foes.length; i += 1) {
    const f = foes[i];
    if (f === undefined) {
      continue;
    }
    const d = dist(u.x, u.y, f.x, f.y);
    if (d > foeD) {
      continue;
    }
    if (d < foeD) {
      foeId = f.id;
      foeX = f.x;
      foeY = f.y;
      foeD = d;
      continue;
    }
    if (foeId < 0 || f.id < foeId) {
      foeId = f.id;
      foeX = f.x;
      foeY = f.y;
      foeD = d;
    }
  }
}

function scanFoeThreat(u: TUnit, foes: TUnit[], flags: number[]): void {
  foeId = -1;
  foeX = 0;
  foeY = 0;
  foeD = 9999;
  for (let i = 0; i < foes.length; i += 1) {
    const f = foes[i];
    if (f === undefined) {
      continue;
    }
    const d = dist(u.x, u.y, f.x, f.y);
    let lim = 6;
    const fl = flags[i];
    if (fl === 1) {
      lim = 18;
    }
    if (d > lim) {
      continue;
    }
    if (d < foeD) {
      foeId = f.id;
      foeX = f.x;
      foeY = f.y;
      foeD = d;
      continue;
    }
    if (d === foeD && (foeId < 0 || f.id < foeId)) {
      foeId = f.id;
      foeX = f.x;
      foeY = f.y;
      foeD = d;
    }
  }
}

function pickSpot(u: TUnit, s: TSite, tick: number, bases: TSite[]): number {
  let k = (u.id + tick) % 8;
  for (let n = 0; n < 8; n += 1) {
    const tx = s.x + nbx(k);
    const ty = s.y + nby(k);
    let bad = 0;
    for (let b = 0; b < bases.length; b += 1) {
      const bs = bases[b];
      if (bs === undefined) {
        continue;
      }
      if (bs.x === tx && bs.y === ty) {
        bad = 1;
      }
    }
    if (bad === 0) {
      return k;
    }
    k = (k + 1) % 8;
  }
  return (u.id + tick) % 8;
}

function goDeliver(u: TUnit, bases: TSite[], tick: number): void {
  const bi = nearestSiteIndex(u, bases);
  if (bi < 0) {
    return;
  }
  const b = bases[bi];
  if (b === undefined) {
    return;
  }
  const d = dist(u.x, u.y, b.x, b.y);
  if (d === 1) {
    transfer(u.id);
    return;
  }
  const k = pickSpot(u, b, tick, bases);
  moveTo(u.id, b.x + nbx(k), b.y + nby(k));
}

function goFlee(u: TUnit, bases: TSite[], tick: number): void {
  const bi = nearestSiteIndex(u, bases);
  if (bi < 0) {
    return;
  }
  const b = bases[bi];
  if (b === undefined) {
    return;
  }
  const d = dist(u.x, u.y, b.x, b.y);
  if (d === 1) {
    if (u.carrying > 0) {
      transfer(u.id);
    }
    return;
  }
  const k = pickSpot(u, b, tick + 2, bases);
  moveTo(u.id, b.x + nbx(k), b.y + nby(k));
}

function goClaim(u: TUnit, s: TSite): void {
  if (u.x === s.x && u.y === s.y) {
    return;
  }
  moveTo(u.id, s.x, s.y);
}

function loop(): void {
  if (seat < 0) {
    seat = getMyIndex();
  }
  const me = seat;
  const tick = getTick();

  const players = getObjectsByType("player");
  let money = 0;
  let alive = false;
  for (let i = 0; i < players.length; i += 1) {
    const p = players[i];
    if (p === undefined) {
      continue;
    }
    if (p.index === me) {
      money = p.resources;
      alive = p.alive;
    }
  }
  if (!alive) {
    return;
  }

  const sites = getObjectsByType("site");
  const myBases: TSite[] = [];
  const mySites: TSite[] = [];
  const myMines: TSite[] = [];
  const neutralSites: TSite[] = [];
  const enemySites: TSite[] = [];
  for (let i = 0; i < sites.length; i += 1) {
    const s = sites[i];
    if (s === undefined) {
      continue;
    }
    if (s.owner === me) {
      mySites.push(s);
      if (s.kind === "base") {
        myBases.push(s);
      } else {
        const rem = s.remaining;
        if (rem !== undefined && rem > 0) {
          myMines.push(s);
        }
      }
    } else if (s.owner === -1) {
      neutralSites.push(s);
    } else {
      enemySites.push(s);
    }
  }
  sortSites(myBases);
  sortSites(myMines);
  sortSites(neutralSites);
  sortSites(enemySites);

  const units = getObjectsByType("unit");
  const myWorkers: TUnit[] = [];
  const myArmy: TUnit[] = [];
  const foes: TUnit[] = [];
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if (u === undefined) {
      continue;
    }
    if (u.owner === me) {
      if (u.type === "worker") {
        myWorkers.push(u);
      } else {
        myArmy.push(u);
      }
    } else {
      foes.push(u);
    }
  }

  const threatFlags: number[] = [];
  for (let i = 0; i < foes.length; i += 1) {
    const f = foes[i];
    let flag = 0;
    if (f !== undefined) {
      for (let j = 0; j < mySites.length; j += 1) {
        const s = mySites[j];
        if (s === undefined) {
          continue;
        }
        if (dist(f.x, f.y, s.x, s.y) <= 3) {
          flag = 1;
        }
      }
    }
    threatFlags.push(flag);
  }

  const buildWorker = myWorkers.length < 12 ? 1 : 0;
  for (let i = 0; i < myBases.length; i += 1) {
    const base = myBases[i];
    if (base === undefined) {
      continue;
    }
    if (base.producing !== null) {
      continue;
    }
    if (buildWorker === 1) {
      if (money >= 4) {
        const r = spawnUnit(base.id, "worker");
        if (!isError(r)) {
          money = money - 4;
        }
      }
    } else if (money >= 8) {
      if (money >= 12 && (base.id + tick) % 4 === 0) {
        const r2 = spawnUnit(base.id, "ranged");
        if (!isError(r2)) {
          money = money - 12;
        }
      } else {
        const r3 = spawnUnit(base.id, "melee");
        if (!isError(r3)) {
          money = money - 8;
        }
      }
    }
  }

  const targets: TSite[] = [];
  for (let i = 0; i < neutralSites.length; i += 1) {
    const s = neutralSites[i];
    if (s === undefined) {
      continue;
    }
    targets.push(s);
  }
  let pushPhase = 0;
  if (tick >= 240) {
    pushPhase = 1;
  }
  if (neutralSites.length === 0 && myArmy.length >= 10) {
    pushPhase = 1;
  }
  if (pushPhase === 1) {
    for (let i = 0; i < enemySites.length; i += 1) {
      const s = enemySites[i];
      if (s === undefined) {
        continue;
      }
      targets.push(s);
    }
  }

  const mineCount = myMines.length;
  const targetCount = targets.length;

  for (let i = 0; i < myWorkers.length; i += 1) {
    const u = myWorkers[i];
    if (u === undefined) {
      continue;
    }

    if (u.carrying >= 20) {
      goDeliver(u, myBases, tick);
      continue;
    }

    scanFoeNear(u, foes, 2);
    if (foeId >= 0) {
      goFlee(u, myBases, tick);
      continue;
    }

    if (myWorkers.length >= 8 && neutralSites.length > 0 && u.id % 6 === 0) {
      const ni = nearestSiteIndex(u, neutralSites);
      if (ni >= 0) {
        const ns = neutralSites[ni];
        if (ns !== undefined) {
          goClaim(u, ns);
        }
      }
      continue;
    }

    if (mineCount > 0) {
      const m = myMines[u.id % mineCount];
      if (m === undefined) {
        continue;
      }
      const md = dist(u.x, u.y, m.x, m.y);
      if (md === 1) {
        harvest(u.id, m.id);
      } else {
        const k = pickSpot(u, m, tick, myBases);
        moveTo(u.id, m.x + nbx(k), m.y + nby(k));
      }
      continue;
    }

    if (targetCount > 0) {
      const s = targets[u.id % targetCount];
      if (s === undefined) {
        continue;
      }
      goClaim(u, s);
    }
  }

  const claimed: number[] = [];
  for (let i = 0; i < targetCount; i += 1) {
    claimed.push(0);
  }

  for (let i = 0; i < myArmy.length; i += 1) {
    const u = myArmy[i];
    if (u === undefined) {
      continue;
    }

    scanFoeThreat(u, foes, threatFlags);
    if (foeId >= 0) {
      const rng = u.type === "ranged" ? 2 : 1;
      if (foeD <= rng) {
        attack(u.id, foeId);
      } else {
        moveTo(u.id, foeX, foeY);
      }
      continue;
    }

    let best = -1;
    let bestD = 0;
    for (let t = 0; t < targetCount; t += 1) {
      const flag = claimed[t];
      if (flag === 1) {
        continue;
      }
      const s = targets[t];
      if (s === undefined) {
        continue;
      }
      const d = dist(u.x, u.y, s.x, s.y);
      if (best === -1 || d < bestD) {
        best = t;
        bestD = d;
      }
    }
    if (best >= 0) {
      claimed[best] = 1;
      const s2 = targets[best];
      if (s2 === undefined) {
        continue;
      }
      goClaim(u, s2);
      continue;
    }

    const list = pushPhase === 1 ? enemySites : targets;
    const li = nearestSiteIndex(u, list);
    if (li >= 0) {
      const s3 = list[li];
      if (s3 !== undefined) {
        goClaim(u, s3);
      }
      continue;
    }

    for (let b = 0; b < myBases.length; b += 1) {
      const bs = myBases[b];
      if (bs === undefined) {
        continue;
      }
      if (u.x === bs.x && u.y === bs.y) {
        moveTo(u.id, u.x + nbx(u.id + tick), u.y + nby(u.id + tick));
        break;
      }
    }
  }
}