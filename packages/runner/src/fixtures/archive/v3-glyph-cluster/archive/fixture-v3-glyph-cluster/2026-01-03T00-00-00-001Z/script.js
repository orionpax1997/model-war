"use strict";
var ME = -1;
function loop() {
    if (ME < 0)
        ME = getMyIndex();
    const me = ME;
    const units = getObjectsByType("unit");
    const sites = getObjectsByType("site");
    const players = getObjectsByType("player");
    var myResources = 0;
    for (var pi = 0; pi < players.length; pi++) {
        const p = players[pi];
        if (p && p.index === me) {
            myResources = p.resources;
            break;
        }
    }
    var myUnits = [];
    var enemyUnits = [];
    for (var ui = 0; ui < units.length; ui++) {
        const u = units[ui];
        if (!u)
            continue;
        if (u.owner === me)
            myUnits.push(u);
        else
            enemyUnits.push(u);
    }
    var myBases = [];
    var myResSites = [];
    var neutralSites = [];
    var enemySites = [];
    var neutralBases = [];
    var enemyBases = [];
    var neutralResSites = [];
    var enemyResSites = [];
    for (var si = 0; si < sites.length; si++) {
        const s = sites[si];
        if (!s)
            continue;
        if (s.owner === me) {
            if (s.kind === "base")
                myBases.push(s);
            else
                myResSites.push(s);
        }
        else if (s.owner === -1) {
            neutralSites.push(s);
            if (s.kind === "base")
                neutralBases.push(s);
            else
                neutralResSites.push(s);
        }
        else {
            enemySites.push(s);
            if (s.kind === "base")
                enemyBases.push(s);
            else
                enemyResSites.push(s);
        }
    }
    var myWorkers = 0;
    var myMilitary = 0;
    for (var ci = 0; ci < myUnits.length; ci++) {
        const u = myUnits[ci];
        if (!u)
            continue;
        if (u.type === "worker")
            myWorkers++;
        else
            myMilitary++;
    }
    var harvestableMines = 0;
    for (var mi = 0; mi < myResSites.length; mi++) {
        const ms = myResSites[mi];
        if (ms && ms.remaining !== undefined && ms.remaining > 0)
            harvestableMines++;
    }
    var desiredWorkers = 4;
    if (harvestableMines > 0)
        desiredWorkers = harvestableMines * 2;
    if (desiredWorkers < 3)
        desiredWorkers = 3;
    if (desiredWorkers > 10)
        desiredWorkers = 10;
    // Production: prioritize economy and a minimum army
    for (var bi = 0; bi < myBases.length; bi++) {
        const b = myBases[bi];
        if (!b || b.producing !== null)
            continue;
        if (myWorkers === 0 && myResources >= 4) {
            spawnUnit(b.id, "worker");
            myResources -= 4;
            myWorkers++;
            continue;
        }
        if (myWorkers < 2 && myResources >= 4) {
            spawnUnit(b.id, "worker");
            myResources -= 4;
            myWorkers++;
            continue;
        }
        if (myMilitary < 1 && myResources >= 8 && myWorkers >= 1) {
            spawnUnit(b.id, "melee");
            myResources -= 8;
            myMilitary++;
            continue;
        }
        if (myWorkers < desiredWorkers && myResources >= 4 && myWorkers <= myMilitary + 4) {
            spawnUnit(b.id, "worker");
            myResources -= 4;
            myWorkers++;
            continue;
        }
        if (myResources >= 8) {
            spawnUnit(b.id, "melee");
            myResources -= 8;
            myMilitary++;
            continue;
        }
        if (myWorkers < desiredWorkers && myResources >= 4) {
            spawnUnit(b.id, "worker");
            myResources -= 4;
            myWorkers++;
            continue;
        }
    }
    // Actions
    for (var ai = 0; ai < myUnits.length; ai++) {
        const u = myUnits[ai];
        if (!u)
            continue;
        if (u.type === "worker") {
            workerAct(u, me, myBases, myResSites, neutralSites, enemySites, neutralResSites, enemyResSites);
        }
        else {
            militaryAct(u, me, myBases, myResSites, neutralSites, enemySites, neutralBases, enemyBases, neutralResSites, enemyResSites, enemyUnits);
        }
    }
}
function isOnSiteList(u, arr) {
    for (var i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (s && s.x === u.x && s.y === u.y)
            return true;
    }
    return false;
}
function isOnOwnedBase(u, myBases) {
    for (var i = 0; i < myBases.length; i++) {
        const b = myBases[i];
        if (b && b.x === u.x && b.y === u.y)
            return true;
    }
    return false;
}
function tryMoveOff(u) {
    const dirs = [
        [1, 0], [0, 1], [-1, 0], [0, -1],
        [1, 1], [-1, 1], [1, -1], [-1, -1],
    ];
    for (var i = 0; i < dirs.length; i++) {
        const d = dirs[i];
        if (!d)
            continue;
        if (!isError(move(u.id, d[0], d[1])))
            return true;
    }
    return false;
}
function nearestSite(u, arr, pred) {
    var best = null;
    var bestD = 0;
    for (var i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (!s || !pred(s))
            continue;
        const d = getRange(u.x, u.y, s.x, s.y);
        if (best === null || d < bestD) {
            best = s;
            bestD = d;
        }
    }
    return best;
}
function nearestBase(u, myBases) {
    return nearestSite(u, myBases, function () { return true; });
}
function nearestHarvestableMine(u, myResSites) {
    return nearestSite(u, myResSites, function (s) {
        return s.remaining !== undefined && s.remaining > 0;
    });
}
function workerAct(u, me, myBases, myResSites, neutralSites, enemySites, neutralResSites, enemyResSites) {
    if (isOnOwnedBase(u, myBases)) {
        // Unblock production; cannot transfer while standing on base tile
        tryMoveOff(u);
        return;
    }
    // Capture by standing on non-owned site (passive). Workers can't fight.
    if (isOnSiteList(u, neutralSites) || isOnSiteList(u, enemySites)) {
        return;
    }
    // Opportunistic transfer if adjacent to any owned base and carrying
    if (u.carrying > 0) {
        var adjBase = null;
        for (var bi = 0; bi < myBases.length; bi++) {
            const b = myBases[bi];
            if (b && getRange(u.x, u.y, b.x, b.y) === 1) {
                adjBase = b;
                break;
            }
        }
        if (adjBase) {
            transfer(u.id);
            return;
        }
    }
    // Deliver when full
    if (u.carrying >= 20) {
        const base = nearestBase(u, myBases);
        if (base) {
            moveTo(u.id, base.x, base.y);
            return;
        }
    }
    // Harvest from owned mine
    const mine = nearestHarvestableMine(u, myResSites);
    if (mine) {
        const d = getRange(u.x, u.y, mine.x, mine.y);
        if (d === 1 && u.carrying < 20) {
            harvest(u.id, mine.id);
            return;
        }
        if (d === 0) {
            tryMoveOff(u);
            return;
        }
        moveTo(u.id, mine.x, mine.y);
        return;
    }
    // No mine: deliver if carrying anything
    if (u.carrying > 0) {
        const base2 = nearestBase(u, myBases);
        if (base2) {
            moveTo(u.id, base2.x, base2.y);
            return;
        }
    }
    // Expand: capture neutral resource first, then neutral base, then enemy resource
    const cap = nearestSite(u, neutralResSites, function () { return true; }) ||
        nearestSite(u, neutralSites, function (s) { return s.kind === "base"; }) ||
        nearestSite(u, enemyResSites, function () { return true; }) ||
        nearestSite(u, neutralSites, function () { return true; }) ||
        nearestSite(u, enemySites, function () { return true; });
    if (cap) {
        moveTo(u.id, cap.x, cap.y);
        return;
    }
}
function attackRangeOf(t) {
    if (t === "ranged")
        return 2;
    if (t === "melee" || t === "cavalry")
        return 1;
    return 0;
}
function findAttackTarget(u, enemyUnits) {
    const ar = attackRangeOf(u.type);
    if (ar <= 0)
        return null;
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < enemyUnits.length; i++) {
        const e = enemyUnits[i];
        if (!e)
            continue;
        const d = getRange(u.x, u.y, e.x, e.y);
        if (d > ar)
            continue;
        var typePri = 3;
        if (e.type === "worker")
            typePri = 0;
        else if (e.type === "ranged")
            typePri = 1;
        else if (e.type === "cavalry")
            typePri = 2;
        else
            typePri = 2; // melee
        const score = typePri * 100000 + e.hp * 100 + d;
        if (best === null || score < bestScore) {
            best = e;
            bestScore = score;
        }
    }
    return best;
}
function enemyOnSite(s, enemyUnits) {
    for (var i = 0; i < enemyUnits.length; i++) {
        const e = enemyUnits[i];
        if (e && e.x === s.x && e.y === s.y)
            return true;
    }
    return false;
}
function siteThreatened(s, me, enemyUnits) {
    if (enemyOnSite(s, enemyUnits))
        return true;
    if (s.progressOwner !== -1 && s.progressOwner !== me && s.progress > 0)
        return true;
    return false;
}
function chooseMilitaryGoal(u, me, myBases, myResSites, neutralSites, enemySites, neutralBases, enemyBases, neutralResSites, enemyResSites, enemyUnits) {
    var best = null;
    var bestScore = 0;
    function consider(s, pri) {
        const d = getRange(u.x, u.y, s.x, s.y);
        const score = pri * 100000 + d;
        if (best === null || score < bestScore) {
            best = s;
            bestScore = score;
        }
    }
    // Defend own bases
    for (var i = 0; i < myBases.length; i++) {
        const b = myBases[i];
        if (b && siteThreatened(b, me, enemyUnits))
            consider(b, 0);
    }
    // Take enemy bases
    for (var j = 0; j < enemyBases.length; j++) {
        const eb = enemyBases[j];
        if (eb)
            consider(eb, 1);
    }
    // Take neutral bases
    for (var k = 0; k < neutralBases.length; k++) {
        const nb = neutralBases[k];
        if (nb)
            consider(nb, 2);
    }
    // Defend own resources
    for (var m = 0; m < myResSites.length; m++) {
        const r = myResSites[m];
        if (r && siteThreatened(r, me, enemyUnits))
            consider(r, 3);
    }
    // Take neutral resources
    for (var n = 0; n < neutralResSites.length; n++) {
        const nr = neutralResSites[n];
        if (nr)
            consider(nr, 4);
    }
    // Take enemy resources
    for (var p = 0; p < enemyResSites.length; p++) {
        const er = enemyResSites[p];
        if (er)
            consider(er, 5);
    }
    // Other enemy sites
    for (var q = 0; q < enemySites.length; q++) {
        const es = enemySites[q];
        if (es)
            consider(es, 6);
    }
    // Other neutral sites
    for (var t = 0; t < neutralSites.length; t++) {
        const ns = neutralSites[t];
        if (ns)
            consider(ns, 7);
    }
    return best;
}
function militaryAct(u, me, myBases, myResSites, neutralSites, enemySites, neutralBases, enemyBases, neutralResSites, enemyResSites, enemyUnits) {
    if (isOnOwnedBase(u, myBases)) {
        const t0 = findAttackTarget(u, enemyUnits);
        if (t0) {
            attack(u.id, t0.id);
            return;
        }
        tryMoveOff(u);
        return;
    }
    // Attack enemies in range whenever possible (including while standing on a capture site)
    const target = findAttackTarget(u, enemyUnits);
    if (target) {
        attack(u.id, target.id);
        return;
    }
    // Stay to capture if on a non-owned site
    if (isOnSiteList(u, neutralSites) || isOnSiteList(u, enemySites)) {
        return;
    }
    const goal = chooseMilitaryGoal(u, me, myBases, myResSites, neutralSites, enemySites, neutralBases, enemyBases, neutralResSites, enemyResSites, enemyUnits);
    if (goal) {
        moveTo(u.id, goal.x, goal.y);
        return;
    }
    // Fallback: nearest enemy unit
    var bestE = null;
    var bestED = 0;
    for (var i = 0; i < enemyUnits.length; i++) {
        const e = enemyUnits[i];
        if (!e)
            continue;
        const d = getRange(u.x, u.y, e.x, e.y);
        if (bestE === null || d < bestED) {
            bestE = e;
            bestED = d;
        }
    }
    if (bestE)
        moveTo(u.id, bestE.x, bestE.y);
}
