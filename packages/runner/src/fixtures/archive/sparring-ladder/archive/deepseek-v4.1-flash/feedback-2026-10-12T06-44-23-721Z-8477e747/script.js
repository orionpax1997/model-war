"use strict";
var myIndex = -1;
var fighterTargets = {};
function loop() {
    if (myIndex < 0) {
        myIndex = getMyIndex();
    }
    var me = myIndex;
    var allSites = getObjectsByType("site");
    var allUnits = getObjectsByType("unit");
    var allPlayers = getObjectsByType("player");
    var mine = allPlayers[me];
    var resources = 0;
    if (mine !== undefined) {
        resources = mine.resources;
    }
    var myUnits = [];
    for (var ui = 0; ui < allUnits.length; ui += 1) {
        var u = allUnits[ui];
        if (u !== undefined && u.owner === me) {
            myUnits.push(u);
        }
    }
    var myBases = [];
    var myResources = [];
    for (var si = 0; si < allSites.length; si += 1) {
        var s = allSites[si];
        if (s === undefined)
            continue;
        if (s.owner === me) {
            if (s.kind === "base") {
                myBases.push(s);
            }
            else if (s.kind === "resource") {
                myResources.push(s);
            }
        }
    }
    var workerCount = 0;
    for (var wi = 0; wi < myUnits.length; wi += 1) {
        if (myUnits[wi].type === "worker") {
            workerCount += 1;
        }
    }
    var remainingRes = resources;
    for (var bi = 0; bi < myBases.length; bi += 1) {
        var base = myBases[bi];
        if (base.producing !== null)
            continue;
        if (workerCount < 3 && remainingRes >= 4) {
            var r1 = spawnUnit(base.id, "worker");
            if (!isError(r1)) {
                remainingRes -= 4;
                workerCount += 1;
            }
        }
        else if (remainingRes >= 8) {
            var r2 = spawnUnit(base.id, "melee");
            if (!isError(r2)) {
                remainingRes -= 8;
            }
        }
    }
    for (var mi = 0; mi < myUnits.length; mi += 1) {
        var unit = myUnits[mi];
        if (unit.type === "worker") {
            commandWorker(unit, me, myBases, myResources, allUnits);
        }
        else {
            commandFighter(unit, me, allSites, allUnits);
        }
    }
}
function commandWorker(w, me, myBases, myResources, allUnits) {
    if (w.carrying >= 20) {
        if (myBases.length === 0)
            return;
        var bestBase = null;
        var bestD = 99999;
        for (var i = 0; i < myBases.length; i += 1) {
            var b = myBases[i];
            var d = getRange(w.x, w.y, b.x, b.y);
            if (d < bestD) {
                bestD = d;
                bestBase = b;
            }
        }
        if (bestBase === null)
            return;
        if (bestD === 1) {
            transfer(w.id);
            return;
        }
        var adj = findAdjacentFree(bestBase.x, bestBase.y, allUnits, w.id % 8);
        if (adj !== null) {
            moveTo(w.id, adj.x, adj.y);
        }
        return;
    }
    if (myResources.length === 0)
        return;
    var bestRes = null;
    var bestDR = 99999;
    for (var j = 0; j < myResources.length; j += 1) {
        var r = myResources[j];
        if (r.remaining !== undefined && r.remaining <= 0)
            continue;
        var dr = getRange(w.x, w.y, r.x, r.y);
        if (dr < bestDR) {
            bestDR = dr;
            bestRes = r;
        }
    }
    if (bestRes === null)
        return;
    if (bestDR === 1) {
        harvest(w.id, bestRes.id);
        return;
    }
    var adj2 = findAdjacentFree(bestRes.x, bestRes.y, allUnits, w.id % 8);
    if (adj2 !== null) {
        moveTo(w.id, adj2.x, adj2.y);
    }
}
function commandFighter(u, me, allSites, allUnits) {
    var tid = fighterTargets[u.id];
    var target = null;
    if (tid !== undefined && tid >= 0) {
        var obj = getObjectById(tid);
        if (obj !== null && obj.kind === "site" && obj.owner !== me) {
            target = obj;
        }
        else {
            delete fighterTargets[u.id];
        }
    }
    if (target === null) {
        var newTarget = chooseTarget(u, allSites, me);
        if (newTarget === null) {
            return;
        }
        fighterTargets[u.id] = newTarget.id;
        target = newTarget;
    }
    var d = getRange(u.x, u.y, target.x, target.y);
    if (d === 0) {
        var enemyId = findAdjacentEnemy(u, allUnits, me);
        if (enemyId >= 0) {
            attack(u.id, enemyId);
        }
        return;
    }
    var blockerId = -1;
    for (var i = 0; i < allUnits.length; i += 1) {
        var ou = allUnits[i];
        if (ou === undefined)
            continue;
        if (ou.x === target.x && ou.y === target.y && ou.owner !== me) {
            blockerId = ou.id;
            break;
        }
    }
    if (blockerId >= 0 && d <= 1) {
        attack(u.id, blockerId);
        return;
    }
    moveTo(u.id, target.x, target.y);
}
function chooseTarget(u, allSites, me) {
    var best = null;
    var bestD = 99999;
    for (var i = 0; i < allSites.length; i += 1) {
        var s = allSites[i];
        if (s === undefined)
            continue;
        if (s.owner !== -1)
            continue;
        if (s.kind !== "base")
            continue;
        var d = getRange(u.x, u.y, s.x, s.y);
        if (d < bestD) {
            bestD = d;
            best = s;
        }
    }
    if (best !== null)
        return best;
    best = null;
    bestD = 99999;
    for (var j = 0; j < allSites.length; j += 1) {
        var s2 = allSites[j];
        if (s2 === undefined)
            continue;
        if (s2.owner !== -1)
            continue;
        if (s2.kind !== "resource")
            continue;
        var d2 = getRange(u.x, u.y, s2.x, s2.y);
        if (d2 < bestD) {
            bestD = d2;
            best = s2;
        }
    }
    if (best !== null)
        return best;
    best = null;
    bestD = 99999;
    for (var k = 0; k < allSites.length; k += 1) {
        var s3 = allSites[k];
        if (s3 === undefined)
            continue;
        if (s3.owner === me || s3.owner === -1)
            continue;
        if (s3.kind !== "base")
            continue;
        var d3 = getRange(u.x, u.y, s3.x, s3.y);
        if (d3 < bestD) {
            bestD = d3;
            best = s3;
        }
    }
    if (best !== null)
        return best;
    best = null;
    bestD = 99999;
    for (var m = 0; m < allSites.length; m += 1) {
        var s4 = allSites[m];
        if (s4 === undefined)
            continue;
        if (s4.owner === me || s4.owner === -1)
            continue;
        if (s4.kind !== "resource")
            continue;
        var d4 = getRange(u.x, u.y, s4.x, s4.y);
        if (d4 < bestD) {
            bestD = d4;
            best = s4;
        }
    }
    return best;
}
function findAdjacentFree(x, y, allUnits, offset) {
    var ddx = [-1, 0, 1, -1, 1, -1, 0, 1];
    var ddy = [-1, -1, -1, 0, 0, 1, 1, 1];
    for (var k = 0; k < 8; k += 1) {
        var idx = (offset + k) % 8;
        var dxv = ddx[idx];
        var dyv = ddy[idx];
        if (dxv === undefined || dyv === undefined)
            continue;
        var nx = x + dxv;
        var ny = y + dyv;
        if (getTerrainAt(nx, ny) !== "plain")
            continue;
        var occupied = false;
        for (var ui = 0; ui < allUnits.length; ui += 1) {
            var ou = allUnits[ui];
            if (ou === undefined)
                continue;
            if (ou.x === nx && ou.y === ny) {
                occupied = true;
                break;
            }
        }
        if (!occupied) {
            return { x: nx, y: ny };
        }
    }
    return null;
}
function findAdjacentEnemy(u, allUnits, me) {
    for (var i = 0; i < allUnits.length; i += 1) {
        var ou = allUnits[i];
        if (ou === undefined)
            continue;
        if (ou.owner !== me && getRange(u.x, u.y, ou.x, ou.y) <= 1) {
            return ou.id;
        }
    }
    return -1;
}
