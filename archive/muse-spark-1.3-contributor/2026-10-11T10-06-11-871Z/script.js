"use strict";
var cachedMe = -1;
var lastTickSeen = 0;
function myAbs(n) {
    if (n < 0) {
        return 0 - n;
    }
    return n;
}
function cheby(ax, ay, bx, by) {
    var dx = ax - bx;
    if (dx < 0) {
        dx = 0 - dx;
    }
    var dy = ay - by;
    if (dy < 0) {
        dy = 0 - dy;
    }
    if (dx > dy) {
        return dx;
    }
    return dy;
}
function loop() {
    var me = getMyIndex();
    cachedMe = me;
    var tick = getTick();
    lastTickSeen = tick;
    var players = getObjectsByType("player");
    var myRes = 0;
    for (var pi = 0; pi < players.length; pi += 1) {
        var pl = players[pi];
        if (pl === undefined) {
            continue;
        }
        if (pl.index === me) {
            myRes = pl.resources;
        }
    }
    var allUnits = getObjectsByType("unit");
    var allSites = getObjectsByType("site");
    var myBases = [];
    var myResSites = [];
    var neutralRes = [];
    var otherSites = [];
    var myUnits = [];
    var myWorkerCount = 0;
    var myMeleeCount = 0;
    var myRangedCount = 0;
    for (var si = 0; si < allSites.length; si += 1) {
        var s = allSites[si];
        if (s === undefined) {
            continue;
        }
        if (s.owner === me) {
            if (s.kind === "base") {
                myBases.push(s);
            }
            else {
                myResSites.push(s);
            }
        }
        else {
            otherSites.push(s);
            if (s.owner === -1 && s.kind === "resource") {
                neutralRes.push(s);
            }
        }
    }
    for (var ui = 0; ui < allUnits.length; ui += 1) {
        var u = allUnits[ui];
        if (u === undefined) {
            continue;
        }
        if (u.owner === me) {
            myUnits.push(u);
            if (u.type === "worker") {
                myWorkerCount = myWorkerCount + 1;
            }
            else if (u.type === "melee") {
                myMeleeCount = myMeleeCount + 1;
            }
            else if (u.type === "ranged") {
                myRangedCount = myRangedCount + 1;
            }
        }
    }
    var desired = 4 + myResSites.length;
    if (tick < 120) {
        if (desired > 6) {
            desired = 6;
        }
    }
    else if (tick < 300) {
        if (desired > 10) {
            desired = 10;
        }
    }
    else {
        if (desired > 8) {
            desired = 8;
        }
    }
    var budget = myRes;
    for (var bi = 0; bi < myBases.length; bi += 1) {
        var b = myBases[bi];
        if (b === undefined) {
            continue;
        }
        if (b.producing !== null) {
            continue;
        }
        if (myWorkerCount < desired) {
            if (budget >= 4) {
                spawnUnit(b.id, "worker");
                budget = budget - 4;
                myWorkerCount = myWorkerCount + 1;
            }
        }
        else {
            var wantRanged = 0;
            if (myRangedCount * 3 < myMeleeCount) {
                wantRanged = 1;
            }
            if (tick < 80) {
                wantRanged = 0;
            }
            if (wantRanged === 1) {
                if (budget >= 12) {
                    spawnUnit(b.id, "ranged");
                    budget = budget - 12;
                    myRangedCount = myRangedCount + 1;
                }
                else if (budget >= 8) {
                    spawnUnit(b.id, "melee");
                    budget = budget - 8;
                    myMeleeCount = myMeleeCount + 1;
                }
            }
            else {
                if (budget >= 8) {
                    spawnUnit(b.id, "melee");
                    budget = budget - 8;
                    myMeleeCount = myMeleeCount + 1;
                }
            }
        }
    }
    var threatened = 0;
    var threatX = 0;
    var threatY = 0;
    var threatId = -1;
    if (myBases.length > 0) {
        for (var ei = 0; ei < allUnits.length; ei += 1) {
            var eu = allUnits[ei];
            if (eu === undefined) {
                continue;
            }
            if (eu.owner === me) {
                continue;
            }
            for (var bj = 0; bj < myBases.length; bj += 1) {
                var bb = myBases[bj];
                if (bb === undefined) {
                    continue;
                }
                var ddb = cheby(eu.x, eu.y, bb.x, bb.y);
                if (ddb <= 6) {
                    threatened = 1;
                    threatX = eu.x;
                    threatY = eu.y;
                    threatId = eu.id;
                    break;
                }
            }
            if (threatened === 1) {
                break;
            }
        }
    }
    var wIdx = 0;
    var mIdx = 0;
    for (var mi = 0; mi < myUnits.length; mi += 1) {
        var unit = myUnits[mi];
        if (unit === undefined) {
            continue;
        }
        if (unit.type === "worker") {
            var curW = wIdx;
            wIdx = wIdx + 1;
            if (tick < 300 && neutralRes.length > 0 && (curW % 3 === 2)) {
                var tIdx = curW % neutralRes.length;
                var tgt = neutralRes[tIdx];
                if (tgt !== undefined) {
                    var dd0 = cheby(unit.x, unit.y, tgt.x, tgt.y);
                    if (dd0 === 0) {
                        continue;
                    }
                    else {
                        moveTo(unit.id, tgt.x, tgt.y);
                        continue;
                    }
                }
            }
            if (unit.carrying >= 20) {
                if (myBases.length === 0) {
                    if (otherSites.length > 0) {
                        var ci = curW % otherSites.length;
                        var csite = otherSites[ci];
                        if (csite !== undefined) {
                            moveTo(unit.id, csite.x, csite.y);
                        }
                    }
                    continue;
                }
                var bestB = null;
                var bestD = 0;
                var firstB = 1;
                for (var k = 0; k < myBases.length; k += 1) {
                    var cand = myBases[k];
                    if (cand === undefined) {
                        continue;
                    }
                    var d = cheby(unit.x, unit.y, cand.x, cand.y);
                    if (firstB === 1 || d < bestD) {
                        bestD = d;
                        bestB = cand;
                        firstB = 0;
                    }
                }
                if (bestB === null) {
                    continue;
                }
                if (bestD === 0) {
                    move(unit.id, 1, 0);
                }
                else if (bestD === 1) {
                    transfer(unit.id);
                }
                else {
                    moveTo(unit.id, bestB.x, bestB.y);
                }
            }
            else {
                var bestS = null;
                var bestSD = 0;
                var firstS = 1;
                for (var k2 = 0; k2 < myResSites.length; k2 += 1) {
                    var css = myResSites[k2];
                    if (css === undefined) {
                        continue;
                    }
                    if (css.remaining !== undefined && css.remaining <= 0) {
                        continue;
                    }
                    var d2 = cheby(unit.x, unit.y, css.x, css.y);
                    if (firstS === 1 || d2 < bestSD) {
                        bestSD = d2;
                        bestS = css;
                        firstS = 0;
                    }
                }
                if (bestS !== null) {
                    if (bestSD === 0) {
                        move(unit.id, 1, 0);
                    }
                    else if (bestSD === 1) {
                        harvest(unit.id, bestS.id);
                    }
                    else {
                        moveTo(unit.id, bestS.x, bestS.y);
                    }
                }
                else {
                    if (neutralRes.length > 0) {
                        var ti = curW % neutralRes.length;
                        var tt = neutralRes[ti];
                        if (tt !== undefined) {
                            var d3 = cheby(unit.x, unit.y, tt.x, tt.y);
                            if (d3 === 0) {
                                continue;
                            }
                            else {
                                moveTo(unit.id, tt.x, tt.y);
                            }
                        }
                    }
                    else if (otherSites.length > 0) {
                        var ti2 = curW % otherSites.length;
                        var tt2 = otherSites[ti2];
                        if (tt2 !== undefined) {
                            var d4 = cheby(unit.x, unit.y, tt2.x, tt2.y);
                            if (d4 === 0) {
                                continue;
                            }
                            else {
                                moveTo(unit.id, tt2.x, tt2.y);
                            }
                        }
                    }
                    else {
                        if (myBases.length > 0) {
                            var nb = null;
                            var nd = 0;
                            var f = 1;
                            for (var k3 = 0; k3 < myBases.length; k3 += 1) {
                                var cbb = myBases[k3];
                                if (cbb === undefined) {
                                    continue;
                                }
                                var dd2 = cheby(unit.x, unit.y, cbb.x, cbb.y);
                                if (f === 1 || dd2 < nd) {
                                    nd = dd2;
                                    nb = cbb;
                                    f = 0;
                                }
                            }
                            if (nb !== null && nd > 2) {
                                moveTo(unit.id, nb.x, nb.y);
                            }
                            else {
                                continue;
                            }
                        }
                    }
                }
            }
        }
        else {
            var curM = mIdx;
            mIdx = mIdx + 1;
            var bestE = null;
            var bestED = 0;
            var firstE = 1;
            for (var e2 = 0; e2 < allUnits.length; e2 += 1) {
                var euv = allUnits[e2];
                if (euv === undefined) {
                    continue;
                }
                if (euv.owner === me) {
                    continue;
                }
                var ed = cheby(unit.x, unit.y, euv.x, euv.y);
                if (firstE === 1 || ed < bestED) {
                    bestED = ed;
                    bestE = euv;
                    firstE = 0;
                }
            }
            var myRange = 1;
            if (unit.type === "ranged") {
                myRange = 2;
            }
            if (bestE !== null && bestED <= myRange) {
                attack(unit.id, bestE.id);
                continue;
            }
            if (threatened === 1 && threatId >= 0) {
                var td = cheby(unit.x, unit.y, threatX, threatY);
                if (td <= myRange && bestE !== null && bestED <= myRange) {
                    attack(unit.id, bestE.id);
                }
                else {
                    moveTo(unit.id, threatX, threatY);
                }
                continue;
            }
            if (tick < 250) {
                if (neutralRes.length > 0) {
                    var nti = curM % neutralRes.length;
                    var nt = neutralRes[nti];
                    if (nt !== undefined) {
                        var nd2 = cheby(unit.x, unit.y, nt.x, nt.y);
                        if (nd2 === 0) {
                            continue;
                        }
                        else {
                            moveTo(unit.id, nt.x, nt.y);
                        }
                    }
                }
                else if (otherSites.length > 0 && tick >= 150) {
                    var oti = curM % otherSites.length;
                    var ot = otherSites[oti];
                    if (ot !== undefined) {
                        var od = cheby(unit.x, unit.y, ot.x, ot.y);
                        if (od === 0) {
                            continue;
                        }
                        else {
                            moveTo(unit.id, ot.x, ot.y);
                        }
                    }
                }
                else {
                    if (bestE !== null && bestED <= 8) {
                        moveTo(unit.id, bestE.x, bestE.y);
                    }
                    else {
                        continue;
                    }
                }
            }
            else {
                if (otherSites.length > 0) {
                    var loti = curM % otherSites.length;
                    var lot = otherSites[loti];
                    if (lot !== undefined) {
                        var lod = cheby(unit.x, unit.y, lot.x, lot.y);
                        if (lod === 0) {
                            continue;
                        }
                        else {
                            moveTo(unit.id, lot.x, lot.y);
                        }
                    }
                }
                else if (bestE !== null) {
                    moveTo(unit.id, bestE.x, bestE.y);
                }
                else {
                    continue;
                }
            }
        }
    }
}
