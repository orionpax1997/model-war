"use strict";
var mySeat = -1;
function dist(ax, ay, bx, by) {
    let dx = ax - bx;
    if (dx < 0)
        dx = -dx;
    let dy = ay - by;
    if (dy < 0)
        dy = -dy;
    return dx > dy ? dx : dy;
}
function loop() {
    if (mySeat < 0) {
        mySeat = getMyIndex();
    }
    const me = mySeat;
    const players = getObjectsByType("player");
    const allSites = getObjectsByType("site");
    const allUnits = getObjectsByType("unit");
    let myRes = 0;
    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (p !== undefined && p.index === me) {
            myRes = p.resources;
            break;
        }
    }
    const myBases = [];
    const myResSites = [];
    const captSites = [];
    const defSites = [];
    for (let i = 0; i < allSites.length; i++) {
        const s = allSites[i];
        if (s === undefined)
            continue;
        if (s.owner === me) {
            if (s.kind === "base") {
                myBases.push(s);
            }
            else {
                const rem = s.remaining;
                if (rem === undefined || rem > 0) {
                    myResSites.push(s);
                }
            }
            if (s.progressOwner !== me && s.progressOwner !== -1 && s.progress > 0) {
                defSites.push(s);
            }
        }
        else {
            captSites.push(s);
        }
    }
    const workers = [];
    const soldiers = [];
    const enemies = [];
    for (let i = 0; i < allUnits.length; i++) {
        const u = allUnits[i];
        if (u === undefined)
            continue;
        if (u.owner === me) {
            if (u.type === "worker")
                workers.push(u);
            else
                soldiers.push(u);
        }
        else {
            enemies.push(u);
        }
    }
    var targetWorkers = myBases.length * 2 + 4;
    var workerOrders = 0;
    var availRes = myRes;
    for (let i = 0; i < myBases.length; i++) {
        const base = myBases[i];
        if (base === undefined)
            continue;
        if (base.producing !== null)
            continue;
        if (workers.length + workerOrders < targetWorkers && availRes >= 4) {
            spawnUnit(base.id, "worker");
            workerOrders++;
            availRes -= 4;
        }
        else if (availRes >= 8) {
            spawnUnit(base.id, "melee");
            availRes -= 8;
        }
    }
    for (let i = 0; i < workers.length; i++) {
        const w = workers[i];
        if (w === undefined)
            continue;
        var threatened = false;
        var fdx = 0;
        var fdy = 0;
        for (let j = 0; j < enemies.length; j++) {
            const e = enemies[j];
            if (e === undefined)
                continue;
            if (dist(w.x, w.y, e.x, e.y) <= 2) {
                threatened = true;
                if (w.x > e.x)
                    fdx = 1;
                else if (w.x < e.x)
                    fdx = -1;
                if (w.y > e.y)
                    fdy = 1;
                else if (w.y < e.y)
                    fdy = -1;
                break;
            }
        }
        if (threatened) {
            if (fdx === 0 && fdy === 0)
                fdx = 1;
            move(w.id, fdx, fdy);
            continue;
        }
        if (w.carrying >= 20 || (w.carrying > 0 && myResSites.length === 0)) {
            var bestD = 99999;
            var bestB = null;
            for (let j = 0; j < myBases.length; j++) {
                const b = myBases[j];
                if (b === undefined)
                    continue;
                const d = dist(w.x, w.y, b.x, b.y);
                if (d <= 1) {
                    transfer(w.id);
                    bestB = null;
                    break;
                }
                if (d < bestD) {
                    bestD = d;
                    bestB = b;
                }
            }
            if (bestB !== null)
                moveTo(w.id, bestB.x, bestB.y);
        }
        else if (myResSites.length > 0) {
            var bestD2 = 99999;
            var bestS = null;
            for (let j = 0; j < myResSites.length; j++) {
                const s = myResSites[j];
                if (s === undefined)
                    continue;
                const d = dist(w.x, w.y, s.x, s.y);
                if (d < bestD2) {
                    bestD2 = d;
                    bestS = s;
                }
            }
            if (bestS !== null) {
                if (bestD2 === 0) {
                    harvest(w.id, bestS.id);
                }
                else {
                    moveTo(w.id, bestS.x, bestS.y);
                }
            }
        }
    }
    for (let i = 0; i < soldiers.length; i++) {
        const s = soldiers[i];
        if (s === undefined)
            continue;
        const atkRange = s.type === "ranged" ? 2 : 1;
        var bestEnemy = null;
        var bestScore = -99999;
        for (let j = 0; j < enemies.length; j++) {
            const e = enemies[j];
            if (e === undefined)
                continue;
            const d = dist(s.x, s.y, e.x, e.y);
            if (d > atkRange)
                continue;
            var score = 0;
            if (e.type === "worker")
                score += 100;
            score -= d * 10;
            score -= e.hp;
            if (bestEnemy === null || score > bestScore) {
                bestEnemy = e;
                bestScore = score;
            }
        }
        if (bestEnemy !== null) {
            attack(s.id, bestEnemy.id);
            continue;
        }
        var stay = false;
        for (let j = 0; j < captSites.length; j++) {
            const t = captSites[j];
            if (t !== undefined && t.x === s.x && t.y === s.y) {
                stay = true;
                break;
            }
        }
        if (!stay) {
            for (let j = 0; j < defSites.length; j++) {
                const t = defSites[j];
                if (t !== undefined && t.x === s.x && t.y === s.y) {
                    stay = true;
                    break;
                }
            }
        }
        if (stay)
            continue;
        var bestD3 = 99999;
        var bestT = null;
        for (let j = 0; j < defSites.length; j++) {
            const t = defSites[j];
            if (t === undefined)
                continue;
            const d = dist(s.x, s.y, t.x, t.y);
            if (d === 0 || d > 15)
                continue;
            if (d < bestD3) {
                bestD3 = d;
                bestT = t;
            }
        }
        if (bestT === null) {
            for (let j = 0; j < captSites.length; j++) {
                const t = captSites[j];
                if (t === undefined)
                    continue;
                const d = dist(s.x, s.y, t.x, t.y);
                if (d === 0)
                    continue;
                if (d < bestD3) {
                    bestD3 = d;
                    bestT = t;
                }
            }
        }
        if (bestT !== null) {
            moveTo(s.id, bestT.x, bestT.y);
        }
        else if (enemies.length > 0) {
            var bestD4 = 99999;
            var bestE = null;
            for (let j = 0; j < enemies.length; j++) {
                const e = enemies[j];
                if (e === undefined)
                    continue;
                const d = dist(s.x, s.y, e.x, e.y);
                if (d < bestD4) {
                    bestD4 = d;
                    bestE = e;
                }
            }
            if (bestE !== null)
                moveTo(s.id, bestE.x, bestE.y);
        }
    }
}
