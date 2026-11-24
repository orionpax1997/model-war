"use strict";
var myIndex = -1;
function loop() {
    if (myIndex < 0) {
        myIndex = getMyIndex();
    }
    var me = myIndex;
    var bases = getObjectsByType("site", { owner: me, kind: "base" });
    var workers = getObjectsByType("unit", { owner: me, type: "worker" });
    var myUnits = getObjectsByType("unit", { owner: me });
    for (var bi = 0; bi < bases.length; bi += 1) {
        var base = bases[bi];
        if (base === undefined)
            continue;
        if (base.producing !== null)
            continue;
        if (workers.length < 3) {
            spawnUnit(base.id, "worker");
        }
        else {
            spawnUnit(base.id, "melee");
        }
    }
    for (var ui = 0; ui < myUnits.length; ui += 1) {
        var u = myUnits[ui];
        if (u === undefined)
            continue;
        if (u.type === "worker") {
            commandWorker(u, me);
        }
        else {
            commandFighter(u, me);
        }
    }
}
function commandWorker(w, me) {
    if (w.carrying > 0) {
        var bases = getObjectsByType("site", { owner: me, kind: "base" });
        if (bases.length === 0)
            return;
        var bestBase = bases[0];
        if (bestBase === undefined)
            return;
        var bestD = getRange(w.x, w.y, bestBase.x, bestBase.y);
        for (var i = 1; i < bases.length; i += 1) {
            var b = bases[i];
            if (b === undefined)
                continue;
            var d = getRange(w.x, w.y, b.x, b.y);
            if (d < bestD) {
                bestD = d;
                bestBase = b;
            }
        }
        if (bestD === 1) {
            transfer(w.id);
        }
        else {
            moveTo(w.id, bestBase.x, bestBase.y);
        }
        return;
    }
    var resources = getObjectsByType("site", { owner: me, kind: "resource" });
    if (resources.length === 0)
        return;
    var bestRes = resources[0];
    if (bestRes === undefined)
        return;
    var bestDR = getRange(w.x, w.y, bestRes.x, bestRes.y);
    for (var j = 1; j < resources.length; j += 1) {
        var r = resources[j];
        if (r === undefined)
            continue;
        var dr = getRange(w.x, w.y, r.x, r.y);
        if (dr < bestDR) {
            bestDR = dr;
            bestRes = r;
        }
    }
    if (bestDR === 1) {
        harvest(w.id, bestRes.id);
    }
    else if (bestDR === 0) {
        harvest(w.id, bestRes.id);
    }
    else {
        moveTo(w.id, bestRes.x, bestRes.y);
    }
}
function commandFighter(u, me) {
    var bestFoeId = -1;
    var bestFoeX = -1;
    var bestFoeY = -1;
    var bestFD = 99999;
    for (var p = 0; p < 4; p += 1) {
        if (p === me)
            continue;
        var foes = getObjectsByType("unit", { owner: p });
        for (var fi = 0; fi < foes.length; fi += 1) {
            var f = foes[fi];
            if (f === undefined)
                continue;
            var d = getRange(u.x, u.y, f.x, f.y);
            if (d < bestFD) {
                bestFD = d;
                bestFoeId = f.id;
                bestFoeX = f.x;
                bestFoeY = f.y;
            }
        }
    }
    if (bestFoeId >= 0 && bestFD <= 1) {
        attack(u.id, bestFoeId);
        return;
    }
    var neutral = getObjectsByType("site", { owner: -1 });
    if (neutral.length > 0) {
        var idx = u.id % neutral.length;
        if (idx < 0)
            idx += neutral.length;
        var target = neutral[idx];
        if (target !== undefined) {
            if (getRange(u.x, u.y, target.x, target.y) !== 0) {
                moveTo(u.id, target.x, target.y);
            }
            return;
        }
    }
    if (bestFoeId >= 0) {
        moveTo(u.id, bestFoeX, bestFoeY);
    }
}
