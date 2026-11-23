var ME = -1;

function loop() {
  if (ME < 0) ME = getMyIndex();
  const me = ME as 0 | 1 | 2 | 3;

  const units = getObjectsByType("unit");
  const sites = getObjectsByType("site");
  const players = getObjectsByType("player");

  var myResCount = 0;
  for (var pi = 0; pi < players.length; pi++) {
    const p = players[pi];
    if (p && p.index === me) {
      myResCount = p.resources;
      break;
    }
  }

  var myUnits: Unit[] = [];
  var enemyUnits: Unit[] = [];
  for (var ui = 0; ui < units.length; ui++) {
    const u = units[ui];
    if (!u) continue;
    if (u.owner === me) myUnits.push(u);
    else enemyUnits.push(u);
  }

  var myBases: Site[] = [];
  var myResSites: Site[] = [];
  var neutralSites: Site[] = [];
  var enemySites: Site[] = [];
  for (var si = 0; si < sites.length; si++) {
    const s = sites[si];
    if (!s) continue;
    if (s.owner === me) {
      if (s.kind === "base") myBases.push(s);
      else myResSites.push(s);
    } else if (s.owner === -1) {
      neutralSites.push(s);
    } else {
      enemySites.push(s);
    }
  }

  var myWorkers = 0;
  var myMilitary = 0;
  for (var wi = 0; wi < myUnits.length; wi++) {
    const u = myUnits[wi];
    if (!u) continue;
    if (u.type === "worker") myWorkers++;
    else myMilitary++;
  }

  var harvestableMineCount = 0;
  for (var mi = 0; mi < myResSites.length; mi++) {
    const s = myResSites[mi];
    if (s && s.remaining !== undefined && s.remaining > 0) harvestableMineCount++;
  }

  // Production: keep economy alive, then build melee army
  var targetWorkers = 4;
  if (harvestableMineCount > 0) targetWorkers = harvestableMineCount * 2 + 2;
  if (targetWorkers < 4) targetWorkers = 4;
  if (targetWorkers > 14) targetWorkers = 14;
  if (myWorkers === 0 && myResCount < 4) targetWorkers = 0; // economic death, save nothing useful

  for (var bi = 0; bi < myBases.length; bi++) {
    const b = myBases[bi];
    if (!b) continue;
    if (b.producing !== null) continue;
    var spawned = false;
    if (myWorkers < targetWorkers && myResCount >= 4) {
      spawnUnit(b.id, "worker");
      myResCount -= 4;
      myWorkers++;
      spawned = true;
    } else if (myMilitary < myWorkers && myResCount >= 8) {
      // some protection
      spawnUnit(b.id, "melee");
      myResCount -= 8;
      myMilitary++;
      spawned = true;
    } else if (myResCount >= 8) {
      spawnUnit(b.id, "melee");
      myResCount -= 8;
      myMilitary++;
      spawned = true;
    } else if (myWorkers < targetWorkers + 1 && myResCount >= 4) {
      spawnUnit(b.id, "worker");
      myResCount -= 4;
      myWorkers++;
      spawned = true;
    }
    if (!spawned && myResCount >= 12) {
      spawnUnit(b.id, "ranged");
      myResCount -= 12;
    }
  }

  // Build quick lookup for units standing on my bases
  for (var ui2 = 0; ui2 < myUnits.length; ui2++) {
    const u = myUnits[ui2];
    if (!u) continue;

    var onMyBase: Site | null = null;
    for (var bi2 = 0; bi2 < myBases.length; bi2++) {
      const b = myBases[bi2];
      if (b && b.x === u.x && b.y === u.y) {
        onMyBase = b;
        break;
      }
    }

    if (u.type === "worker") {
      workerAct(u, onMyBase, myBases, myResSites, neutralSites, enemySites, enemyUnits, me);
    } else {
      militaryAct(u, onMyBase, myBases, myResSites, neutralSites, enemySites, enemyUnits, me);
    }
  }
}

function attackRangeOf(t: UnitType): number {
  if (t === "ranged") return 2;
  if (t === "melee" || t === "cavalry") return 1;
  return 0;
}

function stepOffBase(u: Unit): boolean {
  // try to move off base tile in a deterministic order
  const dirs = [
    [1, 0], [0, 1], [-1, 0], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ] as const;
  for (var i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    if (!d) continue;
    const r = move(u.id, d[0], d[1]);
    if (!isError(r)) return true;
  }
  return false;
}

function nearestSiteByRange(
  ux: number,
  uy: number,
  arr: Site[],
  pred: (s: Site) => boolean
): Site | null {
  var best: Site | null = null;
  var bestD = 0;
  for (var i = 0; i < arr.length; i++) {
    const s = arr[i];
    if (!s || !pred(s)) continue;
    const d = getRange(ux, uy, s.x, s.y);
    if (best === null || d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

function nearestBase(ux: number, uy: number, bases: Site[]): Site | null {
  return nearestSiteByRange(ux, uy, bases, function () { return true; });
}

function findAttackTarget(u: Unit, enemies: Unit[]): Unit | null {
  const ar = attackRangeOf(u.type);
  if (ar <= 0) return null;
  var best: Unit | null = null;
  var bestScore = 0;
  for (var i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e) continue;
    const d = getRange(u.x, u.y, e.x, e.y);
    if (d > ar) continue;
    // lower score better: prioritize workers, then low hp, then distance
    var typePri = 2;
    if (e.type === "worker") typePri = 0;
    else if (e.type === "ranged") typePri = 1;
    const score = typePri * 10000 + e.hp * 100 + d;
    if (best === null || score < bestScore) {
      best = e;
      bestScore = score;
    }
  }
  return best;
}

function enemyOnSite(site: Site, enemies: Unit[]): Unit | null {
  for (var i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (e && e.x === site.x && e.y === site.y) return e;
  }
  return null;
}

function workerAct(
  u: Unit,
  onMyBase: Site | null,
  myBases: Site[],
  myResSites: Site[],
  neutralSites: Site[],
  enemySites: Site[],
  enemyUnits: Unit[],
  me: number
) {
  // If standing on my base tile, prefer to step off unless we need to transfer (can't transfer from on-tile)
  // but stepping off is move intent; do it to unblock production/spawn.
  if (onMyBase) {
    // if carrying and adjacent logic doesn't apply on-tile, move off
    if (stepOffBase(u)) return;
  }

  // If standing on a capturable non-owned site, keep capturing unless threatened and can do something else?
  // capture is passive (no intent needed). But worker is vulnerable; still, capturing neutral resource is useful.
  // We'll allow standing if on neutral/enemy site tile.
  var standingOnForeignSite = false;
  for (var i = 0; i < neutralSites.length; i++) {
    const s = neutralSites[i];
    if (s && s.x === u.x && s.y === u.y) { standingOnForeignSite = true; break; }
  }
  if (!standingOnForeignSite) {
    for (var j = 0; j < enemySites.length; j++) {
      const s = enemySites[j];
      if (s && s.x === u.x && s.y === u.y) { standingOnForeignSite = true; break; }
    }
  }
  if (standingOnForeignSite) {
    // stay to capture (passive). No attack ability.
    // but if an enemy is adjacent? worker can't attack; maybe move away? probably better to keep capturing.
    return;
  }

  // Delivery mode
  if (u.carrying >= 20) {
    const b = nearestBase(u.x, u.y, myBases);
    if (b) {
      const d = getRange(u.x, u.y, b.x, b.y);
      if (d === 1) {
        transfer(u.id);
        return;
      }
      if (d === 0) {
        if (stepOffBase(u)) return;
      }
      moveTo(u.id, b.x, b.y);
      return;
    }
  }

  // Harvest mode: find owned resource with remaining
  const mine = nearestSiteByRange(u.x, u.y, myResSites, function (s) {
    return s.remaining !== undefined && s.remaining > 0;
  });
  if (mine) {
    const d = getRange(u.x, u.y, mine.x, mine.y);
    if (d === 1) {
      // if carrying full shouldn't happen here, but safe
      if (u.carrying < 20) {
        harvest(u.id, mine.id);
        return;
      }
    } else if (d === 0) {
      // standing on own resource site - shouldn't harvest, move off
      stepOffBaseLike(u);
      return;
    } else {
      // if carrying is high, maybe deliver first? 20 is cap; deliver at 20 handled above.
      // if close to full and base closer than mine roundtrip benefit unclear, keep simple.
      moveTo(u.id, mine.x, mine.y);
      return;
    }
  }

  // No harvestable owned mine: try to capture a neutral/enemy resource site, else deliver if carrying
  if (u.carrying > 0) {
    const b = nearestBase(u.x, u.y, myBases);
    if (b) {
      const d = getRange(u.x, u.y, b.x, b.y);
      if (d === 1) { transfer(u.id); return; }
      if (d > 1) { moveTo(u.id, b.x, b.y); return; }
    }
  }

  const capTarget = nearestCaptureSiteForWorker(u.x, u.y, neutralSites, enemySites);
  if (capTarget) {
    if (u.x === capTarget.x && u.y === capTarget.y) return; // capture
    moveTo(u.id, capTarget.x, capTarget.y);
    return;
  }

  // idle: move toward nearest enemy site or stay
  const es = nearestSiteByRange(u.x, u.y, enemySites, function () { return true; });
  if (es) moveTo(u.id, es.x, es.y);
}

function nearestCaptureSiteForWorker(ux: number, uy: number, neutralSites: Site[], enemySites: Site[]): Site | null {
  var best: Site | null = null;
  var bestScore = 0;
  for (var i = 0; i < neutralSites.length; i++) {
    const s = neutralSites[i];
    if (!s) continue;
    // prefer resource sites for economy
    var pri = s.kind === "resource" ? 0 : 1;
    const d = getRange(ux, uy, s.x, s.y);
    const score = pri * 10000 + d;
    if (best === null || score < bestScore) { best = s; bestScore = score; }
  }
  for (var j = 0; j < enemySites.length; j++) {
    const s = enemySites[j];
    if (!s) continue;
    var pri2 = s.kind === "resource" ? 2 : 3;
    const d2 = getRange(ux, uy, s.x, s.y);
    const score2 = pri2 * 10000 + d2;
    if (best === null || score2 < bestScore) { best = s; bestScore = score2; }
  }
  return best;
}

function stepOffBaseLike(u: Unit): void {
  const dirs = [
    [1, 0], [0, 1], [-1, 0], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ] as const;
  for (var i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    if (!d) continue;
    move(u.id, d[0], d[1]);
    return;
  }
}

function militaryAct(
  u: Unit,
  onMyBase: Site | null,
  myBases: Site[],
  myResSites: Site[],
  neutralSites: Site[],
  enemySites: Site[],
  enemyUnits: Unit[],
  me: number
) {
  // If on my base, step off to not block production (unless capturing? base is mine so capture doesn't progress)
  if (onMyBase) {
    // but maybe attack first if enemy adjacent on base approach? unlikely
    const t0 = findAttackTarget(u, enemyUnits);
    if (t0) { attack(u.id, t0.id); return; }
    if (stepOffBase(u)) return;
  }

  // Attack if possible
  const targetEnemy = findAttackTarget(u, enemyUnits);
  if (targetEnemy) {
    attack(u.id, targetEnemy.id);
    return;
  }

  // If standing on a site we want to capture (not owned by me), stay
  var onCaptureTarget = false;
  for (var i = 0; i < neutralSites.length; i++) {
    const s = neutralSites[i];
    if (s && s.x === u.x && s.y === u.y) { onCaptureTarget = true; break; }
  }
  if (!onCaptureTarget) {
    for (var j = 0; j < enemySites.length; j++) {
      const s = enemySites[j];
      if (s && s.x === u.x && s.y === u.y) { onCaptureTarget = true; break; }
    }
  }
  if (onCaptureTarget) {
    return; // capture passively
  }

  // Strategic move: prioritize capturing enemy bases > neutral bases > enemy/neutral resources > threatened own sites
  const goal = chooseMilitaryGoal(u, myBases, myResSites, neutralSites, enemySites, enemyUnits);
  if (goal) {
    moveTo(u.id, goal.x, goal.y);
    return;
  }

  // fallback: chase nearest enemy
  var bestE: Unit | null = null;
  var bestED = 0;
  for (var k = 0; k < enemyUnits.length; k++) {
    const e = enemyUnits[k];
    if (!e) continue;
    const d = getRange(u.x, u.y, e.x, e.y);
    if (bestE === null || d < bestED) { bestE = e; bestED = d; }
  }
  if (bestE) moveTo(u.id, bestE.x, bestE.y);
}

function chooseMilitaryGoal(
  u: Unit,
  myBases: Site[],
  myResSites: Site[],
  neutralSites: Site[],
  enemySites: Site[],
  enemyUnits: Unit[]
): Site | null {
  var best: Site | null = null;
  var bestScore = 0;

  function consider(s: Site, pri: number) {
    // if enemy standing on it, we must fight for tile; still target the site
    const d = getRange(u.x, u.y, s.x, s.y);
    const score = pri * 100000 + d;
    if (best === null || score < bestScore) {
      best = s;
      bestScore = score;
    }
  }

  // enemy bases (highest value: win condition / denies production)
  for (var i = 0; i < enemySites.length; i++) {
    const s = enemySites[i];
    if (s && s.kind === "base") consider(s, 0);
  }
  // neutral bases
  for (var i2 = 0; i2 < neutralSites.length; i2++) {
    const s2 = neutralSites[i2];
    if (s2 && s2.kind === "base") consider(s2, 1);
  }
  // threatened own sites: enemy progress on our site or enemy standing on it
  for (var i3 = 0; i3 < myBases.length; i3++) {
    const sb = myBases[i3];
    if (!sb) continue;
    if (enemyOnSite(sb, enemyUnits) || (sb.progressOwner !== -1 && sb.progressOwner !== sb.owner)) {
      consider(sb, 2);
    }
  }
  for (var i4 = 0; i4 < myResSites.length; i4++) {
    const sr = myResSites[i4];
    if (!sr) continue;
    if (enemyOnSite(sr, enemyUnits) || (sr.progressOwner !== -1 && sr.progressOwner !== sr.owner)) {
      consider(sr, 3);
    }
  }
  // neutral resource sites
  for (var i5 = 0; i5 < neutralSites.length; i5++) {
    const sn = neutralSites[i5];
    if (sn && sn.kind === "resource") consider(sn, 4);
  }
  // enemy resource sites
  for (var i6 = 0; i6 < enemySites.length; i6++) {
    const se = enemySites[i6];
    if (se && se.kind === "resource") consider(se, 5);
  }

  return best;
}
