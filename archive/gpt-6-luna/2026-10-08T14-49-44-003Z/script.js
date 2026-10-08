"use strict";
var rememberedMe = -1;
function distance(ax, ay, bx, by) {
    const dx = ax >= bx ? ax - bx : bx - ax;
    const dy = ay >= by ? ay - by : by - ay;
    return dx >= dy ? dx : dy;
}
function adjacentSpot(site, fromX, fromY) {
    let bestX = 0;
    let bestY = 0;
    let bestDistance = 0;
    let found = false;
    for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
            if (dx === 0 && dy === 0) {
                continue;
            }
            const x = site.x + dx;
            const y = site.y + dy;
            if (getTerrainAt(x, y) !== "plain") {
                continue;
            }
            const d = distance(fromX, fromY, x, y);
            if (!found || d < bestDistance) {
                bestX = x;
                bestY = y;
                bestDistance = d;
                found = true;
            }
        }
    }
    return found ? { x: bestX, y: bestY } : null;
}
function moveIfNeeded(unitId, currentX, currentY, targetX, targetY) {
    if (currentX !== targetX || currentY !== targetY) {
        moveTo(unitId, targetX, targetY);
    }
}
function loop() {
    const me = getMyIndex();
    rememberedMe = me;
    const tick = getTick();
    const players = getObjectsByType("player");
    const minePlayer = players[me];
    if (minePlayer === undefined || !minePlayer.alive) {
        return;
    }
    const units = getObjectsByType("unit");
    const myUnits = getObjectsByType("unit", { owner: me });
    const allSites = getObjectsByType("site");
    const myBases = getObjectsByType("site", { owner: me, kind: "base" });
    let workerCount = 0;
    let queuedWorkers = 0;
    let ownedResources = 0;
    for (let i = 0; i < myUnits.length; i += 1) {
        const unit = myUnits[i];
        if (unit !== undefined && unit.type === "worker") {
            workerCount += 1;
        }
    }
    for (let i = 0; i < allSites.length; i += 1) {
        const site = allSites[i];
        if (site === undefined) {
            continue;
        }
        if (site.kind === "resource" && site.owner === me) {
            ownedResources += 1;
        }
        if (site.kind === "base" && site.owner === me && site.producing !== null && site.producing.type === "worker") {
            queuedWorkers += 1;
        }
    }
    let budget = minePlayer.resources;
    let plannedWorkers = workerCount + queuedWorkers;
    let targetWorkers = 2 + (ownedResources < 5 ? ownedResources : 5);
    for (let i = 0; i < myBases.length; i += 1) {
        const base = myBases[i];
        if (base === undefined || base.producing !== null) {
            continue;
        }
        let unitType = "melee";
        let cost = 8;
        if (plannedWorkers < targetWorkers) {
            unitType = "worker";
            cost = 4;
        }
        if (budget < cost) {
            continue;
        }
        const result = spawnUnit(base.id, unitType);
        if (!isError(result)) {
            budget -= cost;
            if (unitType === "worker") {
                plannedWorkers += 1;
            }
        }
        else {
            errCode(result);
        }
    }
    const assignedWorkers = [];
    for (let i = 0; i < allSites.length; i += 1) {
        assignedWorkers.push(0);
    }
    for (let i = 0; i < myUnits.length; i += 1) {
        const unit = myUnits[i];
        if (unit === undefined || unit.type !== "worker") {
            continue;
        }
        let nearestBase;
        let nearestBaseDistance = 0;
        for (let j = 0; j < myBases.length; j += 1) {
            const base = myBases[j];
            if (base === undefined) {
                continue;
            }
            const d = distance(unit.x, unit.y, base.x, base.y);
            if (nearestBase === undefined || d < nearestBaseDistance || (d === nearestBaseDistance && base.id < nearestBase.id)) {
                nearestBase = base;
                nearestBaseDistance = d;
            }
        }
        if (unit.carrying > 0 && nearestBase !== undefined) {
            if (nearestBaseDistance <= 1) {
                transfer(unit.id);
            }
            else {
                const spot = adjacentSpot(nearestBase, unit.x, unit.y);
                if (spot !== null) {
                    moveIfNeeded(unit.id, unit.x, unit.y, spot.x, spot.y);
                }
            }
            continue;
        }
        let chosenSiteIndex = -1;
        let chosenSiteScore = 0;
        for (let j = 0; j < allSites.length; j += 1) {
            const site = allSites[j];
            if (site === undefined || site.kind !== "resource") {
                continue;
            }
            if (site.remaining !== undefined && site.remaining <= 0) {
                continue;
            }
            if (site.owner !== me && site.owner !== -1) {
                continue;
            }
            const d = distance(unit.x, unit.y, site.x, site.y);
            const ownershipPenalty = site.owner === me ? 0 : 24;
            const loadPenalty = (assignedWorkers[j] ?? 0) * 12;
            const score = d + ownershipPenalty + loadPenalty;
            if (chosenSiteIndex < 0 ||
                score < chosenSiteScore ||
                (score === chosenSiteScore && site.id < (allSites[chosenSiteIndex]?.id ?? 2147483647))) {
                chosenSiteIndex = j;
                chosenSiteScore = score;
            }
        }
        if (chosenSiteIndex < 0) {
            if (nearestBase !== undefined) {
                const spot = adjacentSpot(nearestBase, unit.x, unit.y);
                if (spot !== null) {
                    moveIfNeeded(unit.id, unit.x, unit.y, spot.x, spot.y);
                }
            }
            continue;
        }
        assignedWorkers[chosenSiteIndex] = (assignedWorkers[chosenSiteIndex] ?? 0) + 1;
        const targetSite = allSites[chosenSiteIndex];
        if (targetSite === undefined) {
            continue;
        }
        if (targetSite.owner !== me) {
            moveIfNeeded(unit.id, unit.x, unit.y, targetSite.x, targetSite.y);
            continue;
        }
        const siteDistance = distance(unit.x, unit.y, targetSite.x, targetSite.y);
        if (siteDistance <= 1) {
            harvest(unit.id, targetSite.id);
        }
        else {
            const spot = adjacentSpot(targetSite, unit.x, unit.y);
            if (spot !== null) {
                moveIfNeeded(unit.id, unit.x, unit.y, spot.x, spot.y);
            }
            else {
                moveIfNeeded(unit.id, unit.x, unit.y, targetSite.x, targetSite.y);
            }
        }
    }
    const assignedCombat = [];
    for (let i = 0; i < allSites.length; i += 1) {
        assignedCombat.push(0);
    }
    for (let i = 0; i < myUnits.length; i += 1) {
        const unit = myUnits[i];
        if (unit === undefined || unit.type === "worker") {
            continue;
        }
        const attackRange = unit.type === "ranged" ? 2 : 1;
        let chosenEnemy;
        let chosenEnemyScore = 0;
        for (let j = 0; j < units.length; j += 1) {
            const enemy = units[j];
            if (enemy === undefined || enemy.owner === me) {
                continue;
            }
            const d = distance(unit.x, unit.y, enemy.x, enemy.y);
            const pursuitLimit = d <= attackRange ? 6 : 3;
            if (d > pursuitLimit) {
                continue;
            }
            const typePriority = enemy.type === "worker" ? 0 : enemy.type === "ranged" ? 1 : 2;
            const score = d * 10 + typePriority * 3 + enemy.hp;
            if (chosenEnemy === undefined || score < chosenEnemyScore || (score === chosenEnemyScore && enemy.id < chosenEnemy.id)) {
                chosenEnemy = enemy;
                chosenEnemyScore = score;
            }
        }
        if (chosenEnemy !== undefined) {
            const d = distance(unit.x, unit.y, chosenEnemy.x, chosenEnemy.y);
            if (d <= attackRange) {
                attack(unit.id, chosenEnemy.id);
                continue;
            }
            if (d <= 3) {
                moveIfNeeded(unit.id, unit.x, unit.y, chosenEnemy.x, chosenEnemy.y);
                continue;
            }
        }
        let chosenSiteIndex = -1;
        let chosenSiteScore = 0;
        for (let j = 0; j < allSites.length; j += 1) {
            const site = allSites[j];
            if (site === undefined || site.owner === me) {
                continue;
            }
            const d = distance(unit.x, unit.y, site.x, site.y);
            const loadPenalty = (assignedCombat[j] ?? 0) * 14;
            const ownershipPenalty = site.owner === -1 ? 0 : 4;
            const score = d + loadPenalty + ownershipPenalty;
            if (chosenSiteIndex < 0 ||
                score < chosenSiteScore ||
                (score === chosenSiteScore && site.id < (allSites[chosenSiteIndex]?.id ?? 2147483647))) {
                chosenSiteIndex = j;
                chosenSiteScore = score;
            }
        }
        if (chosenSiteIndex < 0) {
            continue;
        }
        assignedCombat[chosenSiteIndex] = (assignedCombat[chosenSiteIndex] ?? 0) + 1;
        const targetSite = allSites[chosenSiteIndex];
        if (targetSite !== undefined) {
            moveIfNeeded(unit.id, unit.x, unit.y, targetSite.x, targetSite.y);
        }
    }
    if (tick < 0 || rememberedMe < 0) {
        return;
    }
}
