"use strict";
var myIndex = -1;
function loop() {
    if (myIndex < 0) {
        myIndex = getMyIndex();
    }
    const me = myIndex;
    const players = getObjectsByType("player");
    const myPlayer = players[me];
    if (myPlayer === undefined || !myPlayer.alive) {
        return;
    }
    let resources = myPlayer.resources;
    const allUnits = getObjectsByType("unit");
    const myUnits = [];
    const enemyUnits = [];
    for (let i = 0; i < allUnits.length; i++) {
        const u = allUnits[i];
        if (u === undefined)
            continue;
        if (u.owner === me) {
            myUnits.push(u);
        }
        else {
            enemyUnits.push(u);
        }
    }
    const allSites = getObjectsByType("site");
    const myBases = [];
    const myResourceSites = [];
    const nonMySites = [];
    for (let i = 0; i < allSites.length; i++) {
        const s = allSites[i];
        if (s === undefined)
            continue;
        if (s.owner === me) {
            if (s.kind === "base") {
                myBases.push(s);
            }
            else if (s.kind === "resource") {
                myResourceSites.push(s);
            }
        }
        else {
            nonMySites.push(s);
        }
    }
    let workerCount = 0;
    let combatCount = 0;
    for (let i = 0; i < myUnits.length; i++) {
        const u = myUnits[i];
        if (u === undefined)
            continue;
        if (u.type === "worker") {
            workerCount++;
        }
        else {
            combatCount++;
        }
    }
    for (let i = 0; i < myBases.length; i++) {
        const base = myBases[i];
        if (base === undefined)
            continue;
        if (base.producing !== null)
            continue;
        let buildType = null;
        if (workerCount < 8 && resources >= 4) {
            buildType = "worker";
        }
        else if (resources >= 8) {
            buildType = "melee";
        }
        if (buildType !== null) {
            spawnUnit(base.id, buildType);
            if (buildType === "worker") {
                workerCount++;
                resources -= 4;
            }
            else if (buildType === "melee") {
                combatCount++;
                resources -= 8;
            }
        }
    }
    for (let i = 0; i < myUnits.length; i++) {
        const u = myUnits[i];
        if (u === undefined)
            continue;
        if (u.type === "worker") {
            handleWorker(u, me, myBases, myResourceSites, nonMySites);
        }
        else {
            handleCombat(u, me, enemyUnits, nonMySites);
        }
    }
}
function handleWorker(u, me, myBases, myResourceSites, nonMySites) {
    if (u.carrying >= 20) {
        let nearestBase = null;
        let nearestDist = 999999;
        for (let i = 0; i < myBases.length; i++) {
            const b = myBases[i];
            if (b === undefined)
                continue;
            const d = chebyshev(u.x, u.y, b.x, b.y);
            if (d < nearestDist) {
                nearestDist = d;
                nearestBase = b;
            }
        }
        if (nearestBase !== null) {
            if (nearestDist === 1) {
                transfer(u.id);
            }
            else {
                const adj = findAdjacentPlain(nearestBase.x, nearestBase.y);
                if (adj !== null) {
                    moveTo(u.id, adj.x, adj.y);
                }
                else {
                    moveTo(u.id, nearestBase.x, nearestBase.y);
                }
            }
        }
        return;
    }
    let nearestSite = null;
    let nearestDist = 999999;
    for (let i = 0; i < myResourceSites.length; i++) {
        const s = myResourceSites[i];
        if (s === undefined)
            continue;
        if (s.remaining !== undefined && s.remaining <= 0)
            continue;
        const d = chebyshev(u.x, u.y, s.x, s.y);
        if (d < nearestDist) {
            nearestDist = d;
            nearestSite = s;
        }
    }
    if (nearestSite !== null) {
        if (nearestDist === 1) {
            harvest(u.id, nearestSite.id);
        }
        else {
            const adj = findAdjacentPlain(nearestSite.x, nearestSite.y);
            if (adj !== null) {
                moveTo(u.id, adj.x, adj.y);
            }
            else {
                moveTo(u.id, nearestSite.x, nearestSite.y);
            }
        }
        return;
    }
    let nearestNonMy = null;
    let nearestNonMyDist = 999999;
    for (let i = 0; i < nonMySites.length; i++) {
        const s = nonMySites[i];
        if (s === undefined)
            continue;
        const d = chebyshev(u.x, u.y, s.x, s.y);
        if (d < nearestNonMyDist) {
            nearestNonMyDist = d;
            nearestNonMy = s;
        }
    }
    if (nearestNonMy !== null) {
        if (nearestNonMyDist === 0) {
            // 已经在点位格上
        }
        else {
            moveTo(u.id, nearestNonMy.x, nearestNonMy.y);
        }
    }
}
function handleCombat(u, me, enemyUnits, nonMySites) {
    let range = 1;
    if (u.type === "ranged")
        range = 2;
    let target = null;
    let targetDist = 999999;
    for (let i = 0; i < enemyUnits.length; i++) {
        const e = enemyUnits[i];
        if (e === undefined)
            continue;
        const d = chebyshev(u.x, u.y, e.x, e.y);
        if (d <= range && d < targetDist) {
            targetDist = d;
            target = e;
        }
    }
    if (target !== null) {
        attack(u.id, target.id);
        return;
    }
    let onSite = false;
    for (let i = 0; i < nonMySites.length; i++) {
        const s = nonMySites[i];
        if (s === undefined)
            continue;
        if (s.x === u.x && s.y === u.y) {
            onSite = true;
            break;
        }
    }
    if (onSite) {
        return;
    }
    let nearestEnemy = null;
    let nearestEnemyDist = 999999;
    for (let i = 0; i < enemyUnits.length; i++) {
        const e = enemyUnits[i];
        if (e === undefined)
            continue;
        const d = chebyshev(u.x, u.y, e.x, e.y);
        if (d < nearestEnemyDist) {
            nearestEnemyDist = d;
            nearestEnemy = e;
        }
    }
    if (nearestEnemy !== null) {
        moveTo(u.id, nearestEnemy.x, nearestEnemy.y);
        return;
    }
    let nearestSite = null;
    let nearestSiteDist = 999999;
    for (let i = 0; i < nonMySites.length; i++) {
        const s = nonMySites[i];
        if (s === undefined)
            continue;
        const d = chebyshev(u.x, u.y, s.x, s.y);
        if (d < nearestSiteDist) {
            nearestSiteDist = d;
            nearestSite = s;
        }
    }
    if (nearestSite !== null) {
        if (nearestSiteDist === 0) {
            // 已经在点位格上
        }
        else {
            moveTo(u.id, nearestSite.x, nearestSite.y);
        }
    }
}
function chebyshev(ax, ay, bx, by) {
    const dx = ax > bx ? ax - bx : bx - ax;
    const dy = ay > by ? ay - by : by - ay;
    return dx > dy ? dx : dy;
}
function findAdjacentPlain(x, y) {
    if (getTerrainAt(x + 1, y) === "plain")
        return { x: x + 1, y: y };
    if (getTerrainAt(x - 1, y) === "plain")
        return { x: x - 1, y: y };
    if (getTerrainAt(x, y + 1) === "plain")
        return { x: x, y: y + 1 };
    if (getTerrainAt(x, y - 1) === "plain")
        return { x: x, y: y - 1 };
    if (getTerrainAt(x + 1, y + 1) === "plain")
        return { x: x + 1, y: y + 1 };
    if (getTerrainAt(x + 1, y - 1) === "plain")
        return { x: x + 1, y: y - 1 };
    if (getTerrainAt(x - 1, y + 1) === "plain")
        return { x: x - 1, y: y + 1 };
    if (getTerrainAt(x - 1, y - 1) === "plain")
        return { x: x - 1, y: y - 1 };
    return null;
}
