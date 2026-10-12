var myIdx = -1;
var CARRY_LIMIT = 20;
var DXS = [1, 1, 0, -1, -1, -1, 0, 1];
var DYS = [0, 1, 1, 1, 0, -1, -1, -1];

type Pt = { id: number; x: number; y: number };

function cheb(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax > bx ? ax - bx : bx - ax;
  const dy = ay > by ? ay - by : by - ay;
  return dx > dy ? dx : dy;
}

function nearest(from: Pt, list: Pt[]): Pt | null {
  let best: Pt | null = null;
  let bestD = 1000000;
  for (let i = 0; i < list.length; i += 1) {
    const p = list[i];
    if (p === undefined) {
      continue;
    }
    const d = cheb(from.x, from.y, p.x, p.y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function costOf(t: string): number {
  if (t === "worker") {
    return 4;
  }
  if (t === "melee") {
    return 8;
  }
  if (t === "ranged") {
    return 12;
  }
  return 16;
}

function freeNeighbor(cx: number, cy: number, salt: number): Pt | null {
  for (let k = 0; k < 8; k += 1) {
    const i = (salt + k) % 8;
    const dx = DXS[i];
    const dy = DYS[i];
    if (dx === undefined || dy === undefined) {
      continue;
    }
    const nx = cx + dx;
    const ny = cy + dy;
    if (getTerrainAt(nx, ny) === "plain") {
      return { id: -1, x: nx, y: ny };
    }
  }
  return null;
}

function approach(u: Pt, tx: number, ty: number): void {
  const n = freeNeighbor(tx, ty, u.id);
  if (n !== null) {
    moveTo(u.id, n.x, n.y);
  }
}

function loop(): void {
  if (myIdx < 0) {
    myIdx = getMyIndex();
  }
  const me = myIdx;
  const tick = getTick();

  const players = getObjectsByType("player");
  let gold = 0;
  for (let i = 0; i < players.length; i += 1) {
    const p = players[i];
    if (p !== undefined && p.index === me) {
      gold = p.resources;
    }
  }

  const units = getObjectsByType("unit");
  const sites = getObjectsByType("site");

  const mine = units.filter((u) => u.owner === me);
  const foes = units.filter((u) => u.owner !== me);
  const myWorkers = mine.filter((u) => u.type === "worker");
  const foeWorkers = foes.filter((u) => u.type === "worker");
  const fighters = mine.filter((u) => u.type !== "worker");

  const myBases = sites.filter((s) => s.kind === "base" && s.owner === me);
  const myRes = sites.filter(
    (s) => s.kind === "resource" && s.owner === me && s.remaining !== undefined && s.remaining > 0,
  );
  const capTargets = sites.filter((s) => s.owner !== me);

  let wN = myWorkers.length;
  let mN = mine.filter((u) => u.type === "melee").length;
  let rN = mine.filter((u) => u.type === "ranged").length;
  let cN = mine.filter((u) => u.type === "cavalry").length;

  let want = 4 + myRes.length * 2;
  if (want > 12) {
    want = 12;
  }

  // 生产:每条空闲产线至多下一单
  let spend = 0;
  for (let i = 0; i < myBases.length; i += 1) {
    const b = myBases[i];
    if (b === undefined || b.producing !== null) {
      continue;
    }
    const cash = gold - spend;
    let pick: "worker" | "melee" | "ranged" | "cavalry" | "" = "";
    if (wN < want && cash >= 4) {
      pick = "worker";
    } else if (cN < 2 && tick >= 80 && cash >= 16) {
      pick = "cavalry";
    } else if (rN * 2 < mN && cash >= 12) {
      pick = "ranged";
    } else if (cash >= 8) {
      pick = "melee";
    }
    if (pick === "") {
      continue;
    }
    const r = spawnUnit(b.id, pick);
    if (!isError(r)) {
      spend += costOf(pick);
      if (pick === "worker") {
        wN += 1;
      } else if (pick === "melee") {
        mN += 1;
      } else if (pick === "ranged") {
        rN += 1;
      } else {
        cN += 1;
      }
    }
  }

  // 农民:满载回基地交付,否则去己方资源点采集
  for (let i = 0; i < myWorkers.length; i += 1) {
    const w = myWorkers[i];
    if (w === undefined) {
      continue;
    }
    if (w.carrying >= CARRY_LIMIT) {
      const nb = nearest(w, myBases);
      if (nb !== null) {
        if (cheb(w.x, w.y, nb.x, nb.y) === 1) {
          transfer(w.id);
        } else {
          approach(w, nb.x, nb.y);
        }
      }
      continue;
    }
    const site = nearest(w, myRes);
    if (site === null) {
      continue;
    }
    if (cheb(w.x, w.y, site.x, site.y) === 1) {
      harvest(w.id, site.id);
    } else {
      approach(w, site.x, site.y);
    }
  }

  // 战斗单位:有敌就打或追,无敌则去占领未控制的点位
  for (let i = 0; i < fighters.length; i += 1) {
    const f = fighters[i];
    if (f === undefined) {
      continue;
    }
    const rng = f.type === "ranged" ? 2 : 1;
    const pool = f.type === "cavalry" && foeWorkers.length > 0 ? foeWorkers : foes;
    const en = nearest(f, pool);
    if (en !== null) {
      const d = cheb(f.x, f.y, en.x, en.y);
      if (f.type === "cavalry" || d <= 6) {
        if (d <= rng) {
          attack(f.id, en.id);
        } else {
          moveTo(f.id, en.x, en.y);
        }
        continue;
      }
    }
    const tgt = nearest(f, capTargets);
    if (tgt !== null && (tgt.x !== f.x || tgt.y !== f.y)) {
      moveTo(f.id, tgt.x, tgt.y);
    }
  }
}
