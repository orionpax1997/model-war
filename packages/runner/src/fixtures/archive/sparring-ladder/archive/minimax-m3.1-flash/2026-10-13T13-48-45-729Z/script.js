"use strict";
const WORKER_COST = 4;
const MELEE_COST = 8;
const RANGED_COST = 12;
const DELIVERY_TARGET = 12;
const MAX_WORKERS = 16;
const MAX_SOLDIERS = 140;
const MAX_ENEMIES = 160;
const ROLE_FIGHT = 0;
const ROLE_DEFEND = 1;
const ROLE_CAPTURE = 2;
var homeReady = 0;
var homeX = 0;
var homeY = 0;
function scriptDistance(ax, ay, bx, by) {
    return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}
function positiveMod(value, modulus) {
    const result = value % modulus;
    return result < 0 ? result + modulus : result;
}
function directionX(direction) {
    if (direction === 0 || direction === 1 || direction === 6) {
        return 1;
    }
    if (direction === 3 || direction === 4 || direction === 5) {
        return -1;
    }
    return 0;
}
function directionY(direction) {
    if (direction === 0 || direction === 1 || direction === 2) {
        return 1;
    }
    if (direction === 4 || direction === 5 || direction === 6) {
        return -1;
    }
    return 0;
}
function hasUnitAt(units, x, y, exceptId) {
    for (const unit of units) {
        if (unit.id !== exceptId && unit.x === x && unit.y === y) {
            return true;
        }
    }
    return false;
}
function isSitePoint(sites, x, y) {
    for (const site of sites) {
        if (site.x === x && site.y === y) {
            return true;
        }
    }
    return false;
}
function freeAdjacentPoint(centerX, centerY, units, unitId, preferredX, preferredY) {
    let best = null;
    let bestScore = 2147483647;
    const start = positiveMod(unitId, 8);
    for (let offset = 0; offset < 8; offset += 1) {
        const direction = positiveMod(start + offset, 8);
        const x = centerX + directionX(direction);
        const y = centerY + directionY(direction);
        if (getTerrainAt(x, y) !== "plain") {
            continue;
        }
        if (hasUnitAt(units, x, y, unitId)) {
            continue;
        }
        const score = scriptDistance(x, y, preferredX, preferredY) * 8 + offset;
        if (score < bestScore) {
            best = { x: x, y: y };
            bestScore = score;
        }
    }
    return best;
}
function guardPost(anchor, ordinal, units, sites, unitId) {
    const start = positiveMod(ordinal * 3 + unitId, 8);
    for (let radius = 1; radius <= 3; radius += 1) {
        for (let offset = 0; offset < 8; offset += 1) {
            const direction = positiveMod(start + offset, 8);
            const x = anchor.x + directionX(direction) * radius;
            const y = anchor.y + directionY(direction) * radius;
            if (getTerrainAt(x, y) !== "plain") {
                continue;
            }
            if (isSitePoint(sites, x, y)) {
                continue;
            }
            if (hasUnitAt(units, x, y, unitId)) {
                continue;
            }
            return { x: x, y: y };
        }
    }
    return null;
}
function nearestBase(unit, bases) {
    let best = null;
    let bestDistance = 2147483647;
    for (const base of bases) {
        const d = scriptDistance(unit.x, unit.y, base.x, base.y);
        if (d < bestDistance ||
            (d === bestDistance && best !== null && base.id < best.id)) {
            best = base;
            bestDistance = d;
        }
    }
    return best;
}
function enemyWithinRange(unit, enemies, maximumRange) {
    let best = null;
    let bestScore = 2147483647;
    for (const enemy of enemies) {
        const d = scriptDistance(unit.x, unit.y, enemy.x, enemy.y);
        if (d > maximumRange) {
            continue;
        }
        let score = d * 12 + enemy.hp * 2;
        if (enemy.type === "worker") {
            score -= 18;
        }
        else if (enemy.type === "ranged") {
            score -= 4;
        }
        else if (enemy.type === "cavalry") {
            score += 3;
        }
        if (enemy.hp <= 2) {
            score -= 20;
        }
        if (score < bestScore ||
            (score === bestScore && best !== null && enemy.id < best.id)) {
            best = enemy;
            bestScore = score;
        }
    }
    return best;
}
function chooseCombatTarget(unit, enemies) {
    return enemyWithinRange(unit, enemies, 2147483647);
}
function adjacentMine(worker, mines) {
    let best = null;
    let bestDistance = 2;
    for (const mine of mines) {
        const d = scriptDistance(worker.x, worker.y, mine.x, mine.y);
        if (d < bestDistance ||
            (d === bestDistance && best !== null && mine.id < best.id)) {
            best = mine;
            bestDistance = d;
        }
    }
    return best;
}
function standingOnSite(unit, sites) {
    for (const site of sites) {
        if (unit.x === site.x && unit.y === site.y) {
            return site;
        }
    }
    return null;
}
function siteNearAny(site, sites, maximumRange) {
    for (const other of sites) {
        if (scriptDistance(site.x, site.y, other.x, other.y) <= maximumRange) {
            return true;
        }
    }
    return false;
}
function captureScore(site, unit) {
    let score = scriptDistance(unit.x, unit.y, site.x, site.y) * 10;
    if (site.kind === "resource") {
        score -= 4;
    }
    if (site.owner === -1) {
        score -= 8;
    }
    if (site.progressOwner === unit.owner) {
        score -= 24;
    }
    return score;
}
function submitMove(unitId, dx, dy) {
    const result = move(unitId, dx, dy);
    if (isError(result)) {
        errCode(result);
    }
}
function submitMoveTo(unitId, x, y) {
    const result = moveTo(unitId, x, y);
    if (isError(result)) {
        errCode(result);
    }
}
function submitAttack(unitId, targetId) {
    const result = attack(unitId, targetId);
    if (isError(result)) {
        errCode(result);
    }
}
function submitHarvest(unitId, siteId) {
    const result = harvest(unitId, siteId);
    if (isError(result)) {
        errCode(result);
    }
}
function submitTransfer(unitId) {
    const result = transfer(unitId);
    if (isError(result)) {
        errCode(result);
    }
}
function submitSpawn(baseId, unitType) {
    const result = spawnUnit(baseId, unitType);
    if (isError(result)) {
        errCode(result);
    }
}
function commandCombat(unit, target) {
    if (target === null) {
        return false;
    }
    const attackRange = unit.type === "ranged" ? 2 : 1;
    if (scriptDistance(unit.x, unit.y, target.x, target.y) <= attackRange) {
        submitAttack(unit.id, target.id);
    }
    else {
        submitMoveTo(unit.id, target.x, target.y);
    }
    return true;
}
function sendDelivery(worker, base, units) {
    const d = scriptDistance(worker.x, worker.y, base.x, base.y);
    if (d === 1) {
        submitTransfer(worker.id);
        return true;
    }
    const point = freeAdjacentPoint(base.x, base.y, units, worker.id, base.x, base.y);
    if (point !== null) {
        submitMoveTo(worker.id, point.x, point.y);
        return true;
    }
    let dx = worker.x < base.x ? 1 : worker.x > base.x ? -1 : 0;
    let dy = worker.y < base.y ? 1 : worker.y > base.y ? -1 : 0;
    if (dx === 0 && dy === 0) {
        if (positiveMod(worker.id, 2) === 0) {
            dx = 1;
        }
        else {
            dy = 1;
        }
    }
    submitMove(worker.id, dx, dy);
    return true;
}
function sendCapture(unit, site, enemies) {
    const attackRange = unit.type === "ranged" ? 2 : 1;
    const nearbyEnemy = enemyWithinRange(unit, enemies, attackRange);
    if (nearbyEnemy !== null) {
        return commandCombat(unit, nearbyEnemy);
    }
    if (unit.x === site.x && unit.y === site.y) {
        return false;
    }
    submitMoveTo(unit.id, site.x, site.y);
    return true;
}
function sendToPost(unit, anchor, ordinal, units, sites) {
    const point = guardPost(anchor, ordinal, units, sites, unit.id);
    if (point === null) {
        return false;
    }
    if (unit.x === point.x && unit.y === point.y) {
        return false;
    }
    submitMoveTo(unit.id, point.x, point.y);
    return true;
}
function loop() {
    const tick = getTick();
    const me = getMyIndex();
    const players = getObjectsByType("player");
    const self = players[me];
    if (self === undefined || !self.alive) {
        return;
    }
    const allUnits = getObjectsByType("unit");
    const allSites = getObjectsByType("site");
    const workers = [];
    const soldiers = [];
    const enemies = [];
    const enemyCombat = [];
    let workerCount = 0;
    let soldierCount = 0;
    for (const unit of allUnits) {
        if (unit.owner === me) {
            if (unit.type === "worker") {
                workerCount += 1;
                if (workers.length < MAX_WORKERS) {
                    workers.push(unit);
                }
            }
            else {
                soldierCount += 1;
                if (soldiers.length < MAX_SOLDIERS) {
                    soldiers.push(unit);
                }
            }
        }
        else if (enemies.length < MAX_ENEMIES) {
            enemies.push(unit);
            if (unit.type !== "worker") {
                enemyCombat.push(unit);
            }
        }
    }
    workers.sort((a, b) => a.id - b.id);
    soldiers.sort((a, b) => a.id - b.id);
    enemies.sort((a, b) => a.id - b.id);
    enemyCombat.sort((a, b) => a.id - b.id);
    const ownedSites = [];
    const ownedBases = [];
    const activeMines = [];
    for (const site of allSites) {
        if (site.owner === me) {
            ownedSites.push(site);
            if (site.kind === "base") {
                ownedBases.push(site);
            }
            else if (site.remaining === undefined || site.remaining > 0) {
                activeMines.push(site);
            }
        }
    }
    ownedSites.sort((a, b) => a.id - b.id);
    ownedBases.sort((a, b) => a.id - b.id);
    activeMines.sort((a, b) => a.id - b.id);
    if (homeReady === 0 && ownedBases.length > 0) {
        let selectedBase = null;
        let selectedScore = 2147483647;
        for (const base of ownedBases) {
            let score = 0;
            for (const unit of allUnits) {
                if (unit.owner === me) {
                    score += scriptDistance(unit.x, unit.y, base.x, base.y);
                }
            }
            if (score < selectedScore ||
                (score === selectedScore && selectedBase !== null && base.id < selectedBase.id)) {
                selectedBase = base;
                selectedScore = score;
            }
        }
        if (selectedBase !== null) {
            homeX = selectedBase.x;
            homeY = selectedBase.y;
            homeReady = 1;
        }
    }
    const threats = [];
    const combatThreats = [];
    for (const enemy of enemies) {
        const maximumRange = enemy.type === "worker" ? 3 : 5;
        for (const site of ownedSites) {
            if (scriptDistance(enemy.x, enemy.y, site.x, site.y) <= maximumRange) {
                threats.push(enemy);
                if (enemy.type !== "worker") {
                    combatThreats.push(enemy);
                }
                break;
            }
        }
    }
    threats.sort((a, b) => a.id - b.id);
    combatThreats.sort((a, b) => a.id - b.id);
    let actionBudget = 740;
    let plannedWorkers = workerCount;
    let plannedSpend = 0;
    let plannedMilitary = soldierCount;
    let workerGoal = activeMines.length === 0
        ? 4
        : Math.max(4, Math.min(8, activeMines.length + 2));
    if (ownedBases.length > 1 && workerGoal < 8) {
        workerGoal += 1;
    }
    for (const base of ownedBases) {
        if (actionBudget < 3) {
            break;
        }
        if (base.producing !== null) {
            continue;
        }
        const available = self.resources - plannedSpend;
        let makeWorker = false;
        if (plannedWorkers < workerGoal) {
            if (plannedWorkers === 0) {
                makeWorker = true;
            }
            else if (activeMines.length === 0) {
                makeWorker = true;
            }
            else if (plannedMilitary >= 2) {
                makeWorker = true;
            }
            else if (plannedMilitary >= 1 && available >= 16) {
                makeWorker = true;
            }
        }
        if (combatThreats.length > 0 &&
            plannedWorkers > 0 &&
            plannedMilitary < 3) {
            makeWorker = false;
        }
        let unitType;
        let unitCost;
        if (makeWorker) {
            unitType = "worker";
            unitCost = WORKER_COST;
        }
        else if (plannedMilitary >= 3 &&
            positiveMod(plannedMilitary, 4) === 3) {
            unitType = "ranged";
            unitCost = RANGED_COST;
        }
        else {
            unitType = "melee";
            unitCost = MELEE_COST;
        }
        if (available < unitCost) {
            continue;
        }
        if (unitType !== "worker" &&
            plannedWorkers < 2 &&
            available - unitCost < WORKER_COST) {
            continue;
        }
        submitSpawn(base.id, unitType);
        actionBudget -= 3;
        plannedSpend += unitCost;
        if (unitType === "worker") {
            plannedWorkers += 1;
        }
        else {
            plannedMilitary += 1;
        }
    }
    const objectives = [];
    for (const site of allSites) {
        if (site.owner !== me) {
            objectives.push(site);
        }
    }
    objectives.sort((a, b) => a.id - b.id);
    const objectiveSoldierClaim = [];
    const objectiveWorkerClaim = [];
    const objectiveCount = [];
    for (let i = 0; i < objectives.length; i += 1) {
        objectiveSoldierClaim.push(-1);
        objectiveWorkerClaim.push(false);
        objectiveCount.push(0);
    }
    for (let soldierIndex = 0; soldierIndex < soldiers.length; soldierIndex += 1) {
        const soldier = soldiers[soldierIndex];
        if (soldier === undefined) {
            continue;
        }
        for (let objectiveIndex = 0; objectiveIndex < objectives.length; objectiveIndex += 1) {
            const site = objectives[objectiveIndex];
            if (site !== undefined &&
                objectiveSoldierClaim[objectiveIndex] === -1 &&
                soldier.x === site.x &&
                soldier.y === site.y) {
                objectiveSoldierClaim[objectiveIndex] = soldierIndex;
                const count = objectiveCount[objectiveIndex];
                if (count !== undefined) {
                    objectiveCount[objectiveIndex] = count + 1;
                }
                break;
            }
        }
    }
    let existingClaims = 0;
    for (let workerIndex = 0; workerIndex < workers.length; workerIndex += 1) {
        const worker = workers[workerIndex];
        if (worker === undefined) {
            continue;
        }
        for (let objectiveIndex = 0; objectiveIndex < objectives.length; objectiveIndex += 1) {
            const site = objectives[objectiveIndex];
            if (site !== undefined &&
                !objectiveWorkerClaim[objectiveIndex] &&
                worker.x === site.x &&
                worker.y === site.y) {
                objectiveWorkerClaim[objectiveIndex] = true;
                const count = objectiveCount[objectiveIndex];
                if (count !== undefined) {
                    objectiveCount[objectiveIndex] = count + 1;
                }
                existingClaims += 1;
                break;
            }
        }
    }
    const guardSites = [];
    for (const base of ownedBases) {
        guardSites.push(base);
    }
    if (guardSites.length === 0) {
        for (const site of ownedSites) {
            guardSites.push(site);
        }
    }
    const roles = [];
    const guardOrdinal = [];
    const captureTargets = [];
    for (let i = 0; i < soldiers.length; i += 1) {
        roles.push(ROLE_FIGHT);
        guardOrdinal.push(-1);
        captureTargets.push(-1);
    }
    let guardGoal = 0;
    if (soldiers.length > 0 && guardSites.length > 0) {
        let guardCapacity = guardSites.length + 1;
        if (soldiers.length >= 12) {
            guardCapacity = Math.max(3, guardCapacity);
        }
        guardGoal = Math.min(soldiers.length, guardCapacity, Math.max(2, Math.floor(soldiers.length / 3) + 1));
    }
    let assignedGuards = 0;
    for (let guardIndex = 0; guardIndex < guardGoal; guardIndex += 1) {
        const anchor = guardSites[positiveMod(guardIndex, guardSites.length)];
        if (anchor === undefined) {
            break;
        }
        let bestIndex = -1;
        let bestDistance = 2147483647;
        for (let soldierIndex = 0; soldierIndex < soldiers.length; soldierIndex += 1) {
            const soldier = soldiers[soldierIndex];
            const soldierRole = roles[soldierIndex];
            const claimedSoldier = objectiveSoldierClaim[soldierIndex];
            if (soldier === undefined ||
                soldierRole === undefined ||
                claimedSoldier === undefined ||
                soldierRole !== ROLE_FIGHT ||
                claimedSoldier >= 0) {
                continue;
            }
            const d = scriptDistance(soldier.x, soldier.y, anchor.x, anchor.y);
            const currentBest = bestIndex >= 0 ? soldiers[bestIndex] : undefined;
            if (d < bestDistance ||
                (d === bestDistance &&
                    currentBest !== undefined &&
                    soldier.id < currentBest.id)) {
                bestDistance = d;
                bestIndex = soldierIndex;
            }
        }
        if (bestIndex >= 0) {
            roles[bestIndex] = ROLE_DEFEND;
            guardOrdinal[bestIndex] = guardIndex;
            assignedGuards += 1;
        }
    }
    let existingSoldierClaims = 0;
    for (let objectiveIndex = 0; objectiveIndex < objectives.length; objectiveIndex += 1) {
        const soldierIndex = objectiveSoldierClaim[objectiveIndex];
        if (soldierIndex !== undefined && soldierIndex >= 0) {
            roles[soldierIndex] = ROLE_CAPTURE;
            captureTargets[soldierIndex] = objectiveIndex;
            existingSoldierClaims += 1;
        }
    }
    const availableSoldiers = Math.max(0, soldiers.length - assignedGuards);
    const captureCapacity = soldiers.length >= 24 ? 12 : 10;
    let captureQuota = Math.min(objectives.length, captureCapacity, Math.floor(availableSoldiers / 2));
    if (activeMines.length === 0 && availableSoldiers > captureQuota) {
        captureQuota += 1;
    }
    if (ownedBases.length === 0) {
        captureQuota = Math.min(availableSoldiers, captureCapacity, Math.max(3, captureQuota));
    }
    let captureSlots = Math.max(0, captureQuota - existingClaims);
    for (let soldierIndex = 0; soldierIndex < soldiers.length; soldierIndex += 1) {
        if (captureSlots <= 0) {
            break;
        }
        const currentRole = roles[soldierIndex];
        if (currentRole === undefined || currentRole !== ROLE_FIGHT) {
            continue;
        }
        const soldier = soldiers[soldierIndex];
        if (soldier === undefined) {
            continue;
        }
        let bestObjective = -1;
        let bestScore = 2147483647;
        for (let objectiveIndex = 0; objectiveIndex < objectives.length; objectiveIndex += 1) {
            const count = objectiveCount[objectiveIndex];
            if (count !== undefined && count > 0) {
                continue;
            }
            const site = objectives[objectiveIndex];
            if (site === undefined) {
                continue;
            }
            const score = captureScore(site, soldier);
            if (score < bestScore) {
                bestScore = score;
                bestObjective = objectiveIndex;
            }
        }
        if (bestObjective >= 0) {
            roles[soldierIndex] = ROLE_CAPTURE;
            captureTargets[soldierIndex] = bestObjective;
            objectiveSoldierClaim[bestObjective] = soldierIndex;
            objectiveCount[bestObjective] = 1;
            captureSlots -= 1;
        }
    }
    let recoveryBase = null;
    if (ownedBases.length === 0) {
        let bestDistance = 2147483647;
        for (const site of allSites) {
            if (site.kind !== "base" || site.owner === me) {
                continue;
            }
            const d = scriptDistance(homeX, homeY, site.x, site.y);
            if (d < bestDistance ||
                (d === bestDistance && recoveryBase !== null && site.id < recoveryBase.id)) {
                recoveryBase = site;
                bestDistance = d;
            }
        }
    }
    let fallbackResource = null;
    if (activeMines.length === 0) {
        let bestDistance = 2147483647;
        for (let objectiveIndex = 0; objectiveIndex < objectives.length; objectiveIndex += 1) {
            const site = objectives[objectiveIndex];
            const count = objectiveCount[objectiveIndex];
            if (site === undefined ||
                site.kind !== "resource" ||
                count === undefined ||
                count > 0 ||
                (site.remaining !== undefined && site.remaining <= 0)) {
                continue;
            }
            const d = scriptDistance(homeX, homeY, site.x, site.y);
            if (site.owner === -1) {
                if (d < bestDistance) {
                    bestDistance = d;
                    fallbackResource = site;
                }
            }
            else if (fallbackResource === null) {
                fallbackResource = site;
            }
        }
    }
    let pressureUnit = null;
    let pressureSite = null;
    if (soldiers.length >= 14 &&
        threats.length === 0 &&
        ownedBases.length > 0) {
        let bestDistance = 9;
        for (const enemy of enemyCombat) {
            const d = scriptDistance(homeX, homeY, enemy.x, enemy.y);
            if (d <= bestDistance ||
                (d === bestDistance && pressureUnit !== null && enemy.id < pressureUnit.id)) {
                bestDistance = d;
                pressureUnit = enemy;
            }
        }
        if (pressureUnit === null) {
            let bestSiteDistance = 2147483647;
            for (const site of objectives) {
                if (site.owner === -1) {
                    continue;
                }
                const d = scriptDistance(homeX, homeY, site.x, site.y);
                if (d < bestSiteDistance ||
                    (d === bestSiteDistance && pressureSite !== null && site.id < pressureSite.id)) {
                    pressureSite = site;
                    bestSiteDistance = d;
                }
            }
        }
    }
    let fallbackWorkersSent = 0;
    let recoveryWorkerSent = 0;
    for (let workerIndex = 0; workerIndex < workers.length; workerIndex += 1) {
        if (actionBudget <= 0) {
            break;
        }
        const worker = workers[workerIndex];
        if (worker === undefined) {
            continue;
        }
        const base = nearestBase(worker, ownedBases);
        const closeEnemy = enemyWithinRange(worker, enemyCombat, 2);
        if (base !== null &&
            (worker.carrying >= DELIVERY_TARGET ||
                (worker.carrying > 0 && closeEnemy !== null))) {
            sendDelivery(worker, base, allUnits);
            actionBudget -= 1;
            continue;
        }
        if (closeEnemy !== null &&
            scriptDistance(worker.x, worker.y, closeEnemy.x, closeEnemy.y) <= 1) {
            const awayX = worker.x * 2 - closeEnemy.x;
            const awayY = worker.y * 2 - closeEnemy.y;
            const point = freeAdjacentPoint(worker.x, worker.y, allUnits, worker.id, awayX, awayY);
            if (point !== null) {
                submitMoveTo(worker.id, point.x, point.y);
            }
            else {
                let dx = worker.x === closeEnemy.x
                    ? 0
                    : worker.x > closeEnemy.x
                        ? 1
                        : -1;
                let dy = worker.y === closeEnemy.y
                    ? 0
                    : worker.y > closeEnemy.y
                        ? 1
                        : -1;
                if (dx === 0 && dy === 0) {
                    dx = positiveMod(worker.id + tick, 2) === 0 ? 1 : -1;
                }
                submitMove(worker.id, dx, dy);
            }
            actionBudget -= 1;
            continue;
        }
        let holdingObjective = false;
        for (let objectiveIndex = 0; objectiveIndex < objectives.length; objectiveIndex += 1) {
            const site = objectives[objectiveIndex];
            if (site !== undefined &&
                objectiveWorkerClaim[objectiveIndex] &&
                worker.x === site.x &&
                worker.y === site.y) {
                holdingObjective = true;
                break;
            }
        }
        if (holdingObjective) {
            continue;
        }
        if (ownedBases.length === 0 &&
            recoveryBase !== null &&
            recoveryWorkerSent === 0) {
            recoveryWorkerSent = 1;
            if (worker.x !== recoveryBase.x || worker.y !== recoveryBase.y) {
                let blocked = false;
                for (const enemy of enemyCombat) {
                    if (scriptDistance(enemy.x, enemy.y, recoveryBase.x, recoveryBase.y) <= 2) {
                        blocked = true;
                        break;
                    }
                }
                if (!blocked) {
                    submitMoveTo(worker.id, recoveryBase.x, recoveryBase.y);
                    actionBudget -= 1;
                }
            }
            continue;
        }
        if (activeMines.length === 0 &&
            fallbackResource !== null &&
            fallbackWorkersSent < 2) {
            let blocked = false;
            for (const enemy of enemyCombat) {
                if (scriptDistance(enemy.x, enemy.y, fallbackResource.x, fallbackResource.y) <= 2) {
                    blocked = true;
                    break;
                }
            }
            if (!blocked) {
                fallbackWorkersSent += 1;
                if (worker.x !== fallbackResource.x ||
                    worker.y !== fallbackResource.y) {
                    submitMoveTo(worker.id, fallbackResource.x, fallbackResource.y);
                    actionBudget -= 1;
                }
            }
            continue;
        }
        if (activeMines.length === 0) {
            continue;
        }
        const currentMine = adjacentMine(worker, activeMines);
        if (currentMine !== null) {
            submitHarvest(worker.id, currentMine.id);
            actionBudget -= 1;
            continue;
        }
        let standingMine = null;
        for (const mine of activeMines) {
            if (worker.x === mine.x && worker.y === mine.y) {
                standingMine = mine;
                break;
            }
        }
        if (standingMine !== null) {
            const preferredBase = base !== null ? base : standingMine;
            const point = freeAdjacentPoint(standingMine.x, standingMine.y, allUnits, worker.id, preferredBase.x, preferredBase.y);
            if (point !== null) {
                submitMoveTo(worker.id, point.x, point.y);
            }
            else {
                let dx = worker.x < homeX ? 1 : worker.x > homeX ? -1 : 0;
                let dy = worker.y < homeY ? 1 : worker.y > homeY ? -1 : 0;
                if (dx === 0 && dy === 0) {
                    dx = positiveMod(worker.id + tick, 2) === 0 ? 1 : -1;
                }
                submitMove(worker.id, dx, dy);
            }
            actionBudget -= 1;
            continue;
        }
        const assignedMineIndex = positiveMod(workerIndex + worker.id, activeMines.length);
        const assignedMine = activeMines[assignedMineIndex];
        if (assignedMine === undefined) {
            continue;
        }
        const preferredBase = base !== null ? base : assignedMine;
        const mineStand = freeAdjacentPoint(assignedMine.x, assignedMine.y, allUnits, worker.id, preferredBase.x, preferredBase.y);
        if (mineStand !== null) {
            submitMoveTo(worker.id, mineStand.x, mineStand.y);
        }
        else {
            submitMoveTo(worker.id, assignedMine.x, assignedMine.y);
        }
        actionBudget -= 1;
    }
    for (let soldierIndex = 0; soldierIndex < soldiers.length; soldierIndex += 1) {
        if (actionBudget <= 0) {
            break;
        }
        const soldier = soldiers[soldierIndex];
        const roleValue = roles[soldierIndex];
        if (soldier === undefined) {
            continue;
        }
        const role = roleValue === undefined ? ROLE_FIGHT : roleValue;
        const occupiedBase = standingOnSite(soldier, ownedBases);
        if (occupiedBase !== null) {
            if (sendToPost(soldier, occupiedBase, soldier.id, allUnits, allSites)) {
                actionBudget -= 1;
            }
            continue;
        }
        if (role === ROLE_CAPTURE) {
            const targetIndex = captureTargets[soldierIndex];
            if (targetIndex !== undefined && targetIndex >= 0) {
                const targetSite = objectives[targetIndex];
                if (targetSite !== undefined) {
                    if (combatThreats.length > 0 &&
                        siteNearAny(targetSite, ownedSites, 6)) {
                        const defender = chooseCombatTarget(soldier, threats);
                        if (commandCombat(soldier, defender)) {
                            actionBudget -= 1;
                        }
                    }
                    else if (sendCapture(soldier, targetSite, enemies)) {
                        actionBudget -= 1;
                    }
                    continue;
                }
            }
        }
        if (ownedBases.length === 0 && role !== ROLE_DEFEND) {
            if (recoveryBase !== null && sendCapture(soldier, recoveryBase, enemies)) {
                actionBudget -= 1;
            }
            continue;
        }
        if (role === ROLE_DEFEND) {
            if (threats.length > 0) {
                const target = chooseCombatTarget(soldier, threats);
                if (commandCombat(soldier, target)) {
                    actionBudget -= 1;
                }
                continue;
            }
            const ordinalValue = guardOrdinal[soldierIndex];
            const ordinal = ordinalValue === undefined ? soldierIndex : ordinalValue;
            const anchor = guardSites[positiveMod(ordinal, guardSites.length)];
            if (anchor !== undefined &&
                sendToPost(soldier, anchor, ordinal, allUnits, allSites)) {
                actionBudget -= 1;
            }
            continue;
        }
        if (threats.length > 0) {
            const target = chooseCombatTarget(soldier, threats);
            if (commandCombat(soldier, target)) {
                actionBudget -= 1;
            }
            continue;
        }
        if (pressureUnit !== null) {
            if (commandCombat(soldier, pressureUnit)) {
                actionBudget -= 1;
            }
            continue;
        }
        if (pressureSite !== null) {
            if (sendCapture(soldier, pressureSite, enemies)) {
                actionBudget -= 1;
            }
            continue;
        }
        if (guardSites.length > 0) {
            const ordinal = soldierIndex * 3;
            const anchor = guardSites[positiveMod(ordinal, guardSites.length)];
            if (anchor !== undefined &&
                sendToPost(soldier, anchor, ordinal, allUnits, allSites)) {
                actionBudget -= 1;
            }
        }
    }
}
