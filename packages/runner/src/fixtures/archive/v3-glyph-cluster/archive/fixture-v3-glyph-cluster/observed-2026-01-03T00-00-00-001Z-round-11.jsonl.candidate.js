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
    var enemyBases = [];
    var neutralBases = [];
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
    var myMelee = 0;
    var myRanged = 0;
    var myCavalry = 0;
    for (var ci = 0; ci < myUnits.length; ci++) {
        const u = myUnits[ci];
        if (!u)
            continue;
        if (u.type === "worker")
            myWorkers++;
        else if (u.type === "melee")
            myMelee++;
        else if (u.type === "ranged")
            myRanged++;
        else if (u.type === "cavalry")
            myCavalry++;
    }
    var myMilitary = myMelee + myRanged + myCavalry;
    var harvestableMines = 0;
    for (var mi = 0; mi < myResSites.length; mi++) {
        const ms = myResSites[mi];
        if (ms && ms.remaining !== undefined && ms.remaining > 0)
            harvestableMines++;
    }
    var desiredWorkers = 4;
    if (harvestableMines > 0)
        desiredWorkers = harvestableMines * 2 + 1;
    if (desiredWorkers < 4)
        desiredWorkers = 4;
    if (desiredWorkers > 12)
        desiredWorkers = 12;
    // If we have no bases we can't produce; if no workers but can afford one later logic irrelevant here.
    // Production
    for (var bi = 0; bi < myBases.length; bi++) {
        const b = myBases[bi];
        if (!b)
            continue;
        if (b.producing !== null)
            continue;
        if (myWorkers === 0 && myResources >= 4) {
            spawnUnit(b.id, "worker");
            myResources -= 4;
            myWorkers++;
            continue;
        }
        if (myWorkers < desiredWorkers && myResources >= 4) {
            spawnUnit(b.id, "worker");
            myResources -= 4;
            myWorkers++;
            continue;
        }
        // keep a small guard ratio early
        if (myMilitary < 2 && myResources >= 8) {
            spawnUnit(b.id, "melee");
            myResources -= 8;
            myMilitary++;
            myMelee++;
            continue;
        }
        if (myResources >= 8) {
            // mostly melee, occasional ranged if rich
            if (myResources >= 20 && myRanged < (myMelee >> 2) && myRanged < 6) {
                spawnUnit(b.id, "ranged");
                myResources -= 12;
                myMilitary++;
                myRanged++;
            }
            else {
                spawnUnit(b.id, "melee");
                myResources -= 8;
                myMilitary++;
                myMelee++;
            }
            continue;
        }
        if (myResources >= 4 && myWorkers < desiredWorkers + 2) {
            spawnUnit(b.id, "worker");
            myResources -= 4;
            myWorkers++;
            continue;
        }
    }
    // Unit actions
    for (var ui2 = 0; ui2 < myUnits.length; ui2++) {
        const u = myUnits[ui2];
        if (!u)
            continue;
        if (u.type === "worker") {
            workerAct(u, me, myBases, myResSites, neutralSites, enemySites, enemyUnits);
        }
        else {
            militaryAct(u, me, myBases, myResSites, neutralSites, enemySites, neutralBases, enemyBases, neutralResSites, enemyResSites, enemyUnits);
        }
    }
}
function onAnySite(u, sites) {
    for (var i = 0; i < sites.length; i++) {
        const s = sites[i];
        if (s && s.x === u.x && s.y === u.y)
            return s;
    }
    return null;
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
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1],
    ];
    for (var i = 0; i < dirs.length; i++) {
        const d = dirs[i];
        if (!d)
            continue;
        const r = move(u.id, d[0], d[1]);
        if (!isError(r))
            return true;
    }
    return false;
}
function nearestOwnedMine(u, myResSites) {
    var best = null;
    var bestD = 0;
    for (var i = 0; i < myResSites.length; i++) {
        const s = myResSites[i];
        if (!s)
            continue;
        if (s.remaining === undefined || s.remaining <= 0)
            continue;
        const d = getRange(u.x, u.y, s.x, s.y);
        if (best === null || d < bestD) {
            best = s;
            bestD = d;
        }
    }
    return best;
}
function nearestBaseSite(u, myBases) {
    var best = null;
    var bestD = 0;
    for (var i = 0; i < myBases.length; i++) {
        const s = myBases[i];
        if (!s)
            continue;
        const d = getRange(u.x, u.y, s.x, s.y);
        if (best === null || d < bestD) {
            best = s;
            bestD = d;
        }
    }
    return best;
}
function nearestCaptureForWorker(u, neutralResSites, neutralSites, enemyResSites) {
    var best = null;
    var bestScore = 0;
    function consider(s, pri) {
        const d = getRange(u.x, u.y, s.x, s.y);
        const score = pri * 10000 + d;
        if (best === null || score < bestScore) {
            best = s;
            bestScore = score;
        }
    }
    for (var i = 0; i < neutralResSites.length; i++) {
        const s = neutralResSites[i];
        if (s)
            consider(s, 0);
    }
    for (var j = 0; j < neutralSites.length; j++) {
        const s2 = neutralSites[j];
        if (s2 && s2.kind === "base")
            consider(s2, 1);
    }
    for (var k = 0; k < enemyResSites.length; k++) {
        const s3 = enemyResSites[k];
        if (s3)
            consider(s3, 2);
    }
    return best;
}
function workerAct(u, me, myBases, myResSites, neutralSites, enemySites, enemyUnits) {
    if (isOnOwnedBase(u, myBases)) {
        // step off to unblock production/spawn; cannot transfer while on base tile
        tryMoveOff(u);
        return;
    }
    // If standing on a non-owned site, stay to capture (passive). Workers can't fight.
    if (onAnySite(u, neutralSites) || onAnySite(u, enemySites)) {
        return;
    }
    // Deliver when full
    if (u.carrying >= 20) {
        const base = nearestBaseSite(u, myBases);
        if (base) {
            const d = getRange(u.x, u.y, base.x, base.y);
            if (d === 1) {
                transfer(u.id);
                return;
            }
            moveTo(u.id, base.x, base.y);
            return;
        }
    }
    // Harvest if adjacent to a good owned mine
    var mine = nearestOwnedMine(u, myResSites);
    if (mine) {
        const d = getRange(u.x, u.y, mine.x, mine.y);
        if (d === 1) {
            if (u.carrying < 20) {
                harvest(u.id, mine.id);
                return;
            }
        }
        else if (d === 0) {
            // standing on own mine tile is bad for harvesting; move off
            tryMoveOff(u);
            return;
        }
        else {
            moveTo(u.id, mine.x, mine.y);
            return;
        }
    }
    // No mine to harvest from
    if (u.carrying > 0) {
        const base2 = nearestBaseSite(u, myBases);
        if (base2) {
            const d2 = getRange(u.x, u.y, base2.x, base2.y);
            if (d2 === 1) {
                transfer(u.id);
                return;
            }
            moveTo(u.id, base2.x, base2.y);
            return;
        }
    }
    // Try to expand: capture neutral resource/base or enemy resource
    var neutralRes = [];
    var enemyRes = [];
    for (var i = 0; i < neutralSites.length; i++) {
        const s = neutralSites[i];
        if (s && s.kind === "resource")
            neutralRes.push(s);
    }
    for (var j = 0; j < enemySites.length; j++) {
        const s2 = enemySites[j];
        if (s2 && s2.kind === "resource")
            enemyRes.push(s2);
    }
    const cap = nearestCaptureForWorker(u, neutralRes, neutralSites, enemyRes);
    if (cap) {
        moveTo(u.id, cap.x, cap.y);
        return;
    }
    // fallback: move toward any enemy site
    var bestES = null;
    var bestESD = 0;
    for (var k = 0; k < enemySites.length; k++) {
        const es = enemySites[k];
        if (!es)
            continue;
        const d3 = getRange(u.x, u.y, es.x, es.y);
        if (bestES === null || d3 < bestESD) {
            bestES = es;
            bestESD = d3;
        }
    }
    if (bestES)
        moveTo(u.id, bestES.x, bestES.y);
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
        // lower score is better
        const score = typePri * 100000 + e.hp * 100 + d;
        if (best === null || score < bestScore) {
            best = e;
            bestScore = score;
        }
    }
    return best;
}
function enemyStandingOnSite(s, enemyUnits) {
    for (var i = 0; i < enemyUnits.length; i++) {
        const e = enemyUnits[i];
        if (e && e.x === s.x && e.y === s.y)
            return true;
    }
    return false;
}
function siteThreatenedByProgress(s, me) {
    return s.progressOwner !== -1 && s.progressOwner !== me && s.progress > 0;
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
    // 0: defend own bases under immediate capture/threat
    for (var i = 0; i < myBases.length; i++) {
        const b = myBases[i];
        if (!b)
            continue;
        if (enemyStandingOnSite(b, enemyUnits) || siteThreatenedByProgress(b, me)) {
            consider(b, 0);
        }
    }
    // 1: enemy bases
    for (var j = 0; j < enemyBases.length; j++) {
        const eb = enemyBases[j];
        if (eb)
            consider(eb, 1);
    }
    // 2: neutral bases
    for (var k = 0; k < neutralBases.length; k++) {
        const nb = neutralBases[k];
        if (nb)
            consider(nb, 2);
    }
    // 3: defend own resource sites under threat
    for (var m = 0; m < myResSites.length; m++) {
        const r = myResSites[m];
        if (!r)
            continue;
        if (enemyStandingOnSite(r, enemyUnits) || siteThreatenedByProgress(r, me)) {
            consider(r, 3);
        }
    }
    // 4: neutral resources
    for (var n = 0; n < neutralResSites.length; n++) {
        const nr = neutralResSites[n];
        if (nr)
            consider(nr, 4);
    }
    // 5: enemy resources
    for (var p = 0; p < enemyResSites.length; p++) {
        const er = enemyResSites[p];
        if (er)
            consider(er, 5);
    }
    // 6: any other enemy site
    for (var q = 0; q < enemySites.length; q++) {
        const es = enemySites[q];
        if (es)
            consider(es, 6);
    }
    // 7: any neutral site
    for (var t = 0; t < neutralSites.length; t++) {
        const ns = neutralSites[t];
        if (ns)
            consider(ns, 7);
    }
    return best;
}
function militaryAct(u, me, myBases, myResSites, neutralSites, enemySites, neutralBases, enemyBases, neutralResSites, enemyResSites, enemyUnits) {
    // If on my base, prioritize getting off (after possible attack)
    if (isOnOwnedBase(u, myBases)) {
        const t0 = findAttackTarget(u, enemyUnits);
        if (t0) {
            attack(u.id, t0.id);
            return;
        }
        tryMoveOff(u);
        return;
    }
    // Attack if possible (can attack while standing on capture site)
    const target = findAttackTarget(u, enemyUnits);
    if (target) {
        attack(u.id, target.id);
        return;
    }
    // Stay to capture if on a non-owned site
    if (onAnySite(u, neutralSites) || onAnySite(u, enemySites)) {
        return;
    }
    // Move toward strategic goal
    const goal = chooseMilitaryGoal(u, me, myBases, myResSites, neutralSites, enemySites, neutralBases, enemyBases, neutralResSites, enemyResSites, enemyUnits);
    if (goal) {
        moveTo(u.id, goal.x, goal.y);
        return;
    }
    // Fallback: move to nearest enemy unit
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
    if (bestE) {
        moveTo(u.id, bestE.x, bestE.y);
    }
}
