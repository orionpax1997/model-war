"use strict";
var rememberedPlayerIndex = -1;
function distance(ax, ay, bx, by) {
    const dx = Math.abs(ax - bx);
    const dy = Math.abs(ay - by);
    return dx > dy ? dx : dy;
}
function issueMoveTo(unitId, x, y) {
    const result = moveTo(unitId, x, y);
    if (isError(result)) {
        errCode(result);
    }
}
function issueHarvest(unitId, siteId) {
    const result = harvest(unitId, siteId);
    if (isError(result)) {
        errCode(result);
    }
}
function issueTransfer(unitId) {
    const result = transfer(unitId);
    if (isError(result)) {
        errCode(result);
    }
}
function issueAttack(unitId, targetId) {
    const result = attack(unitId, targetId);
    if (isError(result)) {
        errCode(result);
    }
}
function issueSpawn(baseId, unitType) {
    const result = spawnUnit(baseId, unitType);
    if (isError(result)) {
        errCode(result);
    }
}
function isOccupiedByOther(x, y, unitId, units) {
    for (let i = 0; i < units.length; i += 1) {
        const unit = units[i];
        if (unit === undefined) {
            continue;
        }
        if (unit.id !== unitId && unit.x === x && unit.y === y) {
            return true;
        }
    }
    return false;
}
function adjacentTile(unit, site, units) {
    let bestFree = null;
    let bestFreeDistance = 0;
    let bestAny = null;
    let bestAnyDistance = 0;
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
            const candidateDistance = distance(unit.x, unit.y, x, y);
            const tile = { x: x, y: y };
            if (bestAny === null ||
                candidateDistance < bestAnyDistance) {
                bestAny = tile;
                bestAnyDistance = candidateDistance;
            }
            if (isOccupiedByOther(x, y, unit.id, units)) {
                continue;
            }
            if (bestFree === null ||
                candidateDistance < bestFreeDistance) {
                bestFree = tile;
                bestFreeDistance = candidateDistance;
            }
        }
    }
    return bestFree !== null ? bestFree : bestAny;
}
function nearestBase(unit, bases) {
    let best = null;
    let bestDistance = 0;
    for (let i = 0; i < bases.length; i += 1) {
        const base = bases[i];
        if (base === undefined) {
            continue;
        }
        const d = distance(unit.x, unit.y, base.x, base.y);
        if (best === null || d < bestDistance || (d === bestDistance && base.id < best.id)) {
            best = base;
            bestDistance = d;
        }
    }
    return best;
}
function isClaimed(siteId, claimedSiteIds) {
    for (let i = 0; i < claimedSiteIds.length; i += 1) {
        const id = claimedSiteIds[i];
        if (id !== undefined && id === siteId) {
            return true;
        }
    }
    return false;
}
function claimSite(siteId, claimedSiteIds) {
    claimedSiteIds.push(siteId);
}
function chooseWorkerMine(unit, activeMines, mineLoads) {
    let bestIndex = -1;
    let bestLoad = 0;
    let bestDistance = 0;
    for (let i = 0; i < activeMines.length; i += 1) {
        const site = activeMines[i];
        if (site === undefined) {
            continue;
        }
        const load = mineLoads[i];
        const currentLoad = load === undefined ? 0 : load;
        const d = distance(unit.x, unit.y, site.x, site.y);
        if (bestIndex < 0 ||
            currentLoad < bestLoad ||
            (currentLoad === bestLoad && d < bestDistance) ||
            (currentLoad === bestLoad && d === bestDistance && site.id < activeMines[bestIndex].id)) {
            bestIndex = i;
            bestLoad = currentLoad;
            bestDistance = d;
        }
    }
    if (bestIndex >= 0) {
        const current = mineLoads[bestIndex];
        mineLoads[bestIndex] = (current === undefined ? 0 : current) + 1;
    }
    return bestIndex;
}
function nearestUnclaimedResource(unit, sites, units, claimedSiteIds) {
    let best = null;
    let bestDistance = 0;
    for (let i = 0; i < sites.length; i += 1) {
        const site = sites[i];
        if (site === undefined || site.kind !== "resource" || site.owner !== -1) {
            continue;
        }
        if (isClaimed(site.id, claimedSiteIds)) {
            continue;
        }
        let occupied = false;
        for (let j = 0; j < units.length; j += 1) {
            const other = units[j];
            if (other !== undefined &&
                other.id !== unit.id &&
                other.x === site.x &&
                other.y === site.y) {
                occupied = true;
                break;
            }
        }
        if (occupied) {
            continue;
        }
        const d = distance(unit.x, unit.y, site.x, site.y);
        if (best === null || d < bestDistance || (d === bestDistance && site.id < best.id)) {
            best = site;
            bestDistance = d;
        }
    }
    return best;
}
function chooseCaptureSite(unit, sites, units, claimedSiteIds, me) {
    let best = null;
    let bestRank = 0;
    let bestDistance = 0;
    for (let i = 0; i < sites.length; i += 1) {
        const site = sites[i];
        if (site === undefined || site.owner === me) {
            continue;
        }
        if (isClaimed(site.id, claimedSiteIds)) {
            continue;
        }
        let occupied = false;
        for (let j = 0; j < units.length; j += 1) {
            const other = units[j];
            if (other !== undefined &&
                other.id !== unit.id &&
                other.x === site.x &&
                other.y === site.y) {
                occupied = true;
                break;
            }
        }
        if (occupied) {
            continue;
        }
        let rank = 0;
        if (site.progressOwner === me) {
            rank = 0;
        }
        else if (site.kind === "resource" && site.owner === -1) {
            rank = 1;
        }
        else if (site.kind === "base" && site.owner === -1) {
            rank = 2;
        }
        else if (site.kind === "resource") {
            rank = 3;
        }
        else {
            rank = 4;
        }
        const d = distance(unit.x, unit.y, site.x, site.y);
        if (best === null ||
            rank < bestRank ||
            (rank === bestRank && d < bestDistance) ||
            (rank === bestRank && d === bestDistance && site.id < best.id)) {
            best = site;
            bestRank = rank;
            bestDistance = d;
        }
    }
    return best;
}
function bestEnemyInRange(unit, enemies) {
    const range = unit.type === "ranged" ? 2 : 1;
    let best = null;
    let bestPriority = 0;
    let bestDistance = 0;
    for (let i = 0; i < enemies.length; i += 1) {
        const enemy = enemies[i];
        if (enemy === undefined) {
            continue;
        }
        const d = distance(unit.x, unit.y, enemy.x, enemy.y);
        if (d > range) {
            continue;
        }
        const priority = enemy.type === "worker" ? 0 : 1;
        if (best === null ||
            priority < bestPriority ||
            (priority === bestPriority && d < bestDistance) ||
            (priority === bestPriority && d === bestDistance && enemy.hp < best.hp) ||
            (priority === bestPriority && d === bestDistance && enemy.hp === best.hp && enemy.id < best.id)) {
            best = enemy;
            bestPriority = priority;
            bestDistance = d;
        }
    }
    return best;
}
function nearestEnemy(unit, enemies) {
    let best = null;
    let bestDistance = 0;
    for (let i = 0; i < enemies.length; i += 1) {
        const enemy = enemies[i];
        if (enemy === undefined) {
            continue;
        }
        const d = distance(unit.x, unit.y, enemy.x, enemy.y);
        if (best === null ||
            d < bestDistance ||
            (d === bestDistance && enemy.type === "worker" && best.type !== "worker") ||
            (d === bestDistance && enemy.type === best.type && enemy.id < best.id)) {
            best = enemy;
            bestDistance = d;
        }
    }
    return best;
}
function loop() {
    if (rememberedPlayerIndex < 0) {
        rememberedPlayerIndex = getMyIndex();
    }
    const me = rememberedPlayerIndex;
    const players = getObjectsByType("player");
    let minePlayer = null;
    for (let i = 0; i < players.length; i += 1) {
        const player = players[i];
        if (player !== undefined && player.index === me) {
            minePlayer = player;
            break;
        }
    }
    if (minePlayer === null || !minePlayer.alive) {
        return;
    }
    const allUnits = getObjectsByType("unit");
    const allSites = getObjectsByType("site");
    const ownUnits = [];
    const enemies = [];
    const ownSites = [];
    const ownBases = [];
    const activeMines = [];
    for (let i = 0; i < allUnits.length; i += 1) {
        const unit = allUnits[i];
        if (unit === undefined) {
            continue;
        }
        if (unit.owner === me) {
            ownUnits.push(unit);
        }
        else {
            enemies.push(unit);
        }
    }
    for (let i = 0; i < allSites.length; i += 1) {
        const site = allSites[i];
        if (site === undefined) {
            continue;
        }
        if (site.owner === me) {
            ownSites.push(site);
            if (site.kind === "base") {
                ownBases.push(site);
            }
            else if (site.remaining !== undefined && site.remaining > 0) {
                activeMines.push(site);
            }
        }
    }
    ownUnits.sort((a, b) => a.id - b.id);
    ownSites.sort((a, b) => a.id - b.id);
    ownBases.sort((a, b) => a.id - b.id);
    activeMines.sort((a, b) => a.id - b.id);
    const workers = [];
    const army = [];
    for (let i = 0; i < ownUnits.length; i += 1) {
        const unit = ownUnits[i];
        if (unit === undefined) {
            continue;
        }
        if (unit.type === "worker") {
            workers.push(unit);
        }
        else {
            army.push(unit);
        }
    }
    let pendingWorkers = 0;
    let activeResourceCount = 0;
    for (let i = 0; i < ownSites.length; i += 1) {
        const site = ownSites[i];
        if (site !== undefined &&
            site.kind === "resource" &&
            site.remaining !== undefined &&
            site.remaining > 0) {
            activeResourceCount += 1;
        }
    }
    for (let i = 0; i < ownBases.length; i += 1) {
        const base = ownBases[i];
        if (base !== undefined && base.producing !== null && base.producing.type === "worker") {
            pendingWorkers += 1;
        }
    }
    let workerTarget = 2;
    if (activeResourceCount >= 8) {
        workerTarget = 5;
    }
    else if (activeResourceCount >= 6) {
        workerTarget = 4;
    }
    else if (activeResourceCount >= 2) {
        workerTarget = 3;
    }
    let budget = minePlayer.resources;
    for (let i = 0; i < ownBases.length; i += 1) {
        const base = ownBases[i];
        if (base === undefined || base.producing !== null) {
            continue;
        }
        if (workers.length + pendingWorkers < workerTarget && budget >= 8) {
            issueSpawn(base.id, "worker");
            budget -= 4;
            pendingWorkers += 1;
        }
        else if (budget >= 12) {
            issueSpawn(base.id, "melee");
            budget -= 8;
        }
    }
    const claimedSiteIds = [];
    for (let i = 0; i < ownUnits.length; i += 1) {
        const unit = ownUnits[i];
        if (unit === undefined) {
            continue;
        }
        for (let j = 0; j < allSites.length; j += 1) {
            const site = allSites[j];
            if (site !== undefined &&
                site.owner !== me &&
                site.x === unit.x &&
                site.y === unit.y) {
                claimSite(site.id, claimedSiteIds);
            }
        }
    }
    const mineLoads = [];
    for (let i = 0; i < activeMines.length; i += 1) {
        mineLoads.push(0);
    }
    for (let i = 0; i < workers.length; i += 1) {
        const worker = workers[i];
        if (worker === undefined || worker.carrying >= 20) {
            continue;
        }
        const mineIndex = chooseWorkerMine(worker, activeMines, mineLoads);
        const mine = mineIndex >= 0 ? activeMines[mineIndex] : undefined;
        let threatened = false;
        let closestThreat = null;
        let closestThreatDistance = 0;
        for (let j = 0; j < enemies.length; j += 1) {
            const enemy = enemies[j];
            if (enemy === undefined) {
                continue;
            }
            const d = distance(worker.x, worker.y, enemy.x, enemy.y);
            if (d <= 2 && (closestThreat === null || d < closestThreatDistance)) {
                threatened = true;
                closestThreat = enemy;
                closestThreatDistance = d;
            }
        }
        if (threatened) {
            const base = nearestBase(worker, ownBases);
            if (base !== null) {
                const goal = adjacentTile(worker, base, ownUnits);
                if (goal !== null && (goal.x !== worker.x || goal.y !== worker.y)) {
                    issueMoveTo(worker.id, goal.x, goal.y);
                    continue;
                }
            }
            else if (closestThreat !== null) {
                const dx = worker.x > closestThreat.x ? 1 : worker.x < closestThreat.x ? -1 : 0;
                const dy = worker.y > closestThreat.y ? 1 : worker.y < closestThreat.y ? -1 : 0;
                if (dx !== 0 || dy !== 0) {
                    const result = move(worker.id, dx, dy);
                    if (isError(result)) {
                        errCode(result);
                    }
                    continue;
                }
            }
        }
        if (mine !== undefined) {
            const d = distance(worker.x, worker.y, mine.x, mine.y);
            if (d === 1) {
                issueHarvest(worker.id, mine.id);
                continue;
            }
            const goal = adjacentTile(worker, mine, ownUnits);
            if (goal !== null && (goal.x !== worker.x || goal.y !== worker.y)) {
                issueMoveTo(worker.id, goal.x, goal.y);
            }
            continue;
        }
        const expansionSite = nearestUnclaimedResource(worker, allSites, ownUnits, claimedSiteIds);
        if (expansionSite !== null) {
            claimSite(expansionSite.id, claimedSiteIds);
            if (worker.x !== expansionSite.x || worker.y !== expansionSite.y) {
                issueMoveTo(worker.id, expansionSite.x, expansionSite.y);
            }
            continue;
        }
        if (worker.carrying > 0) {
            const base = nearestBase(worker, ownBases);
            if (base !== null) {
                if (distance(worker.x, worker.y, base.x, base.y) <= 1) {
                    issueTransfer(worker.id);
                }
                else {
                    const goal = adjacentTile(worker, base, ownUnits);
                    if (goal !== null && (goal.x !== worker.x || goal.y !== worker.y)) {
                        issueMoveTo(worker.id, goal.x, goal.y);
                    }
                }
            }
        }
    }
    for (let i = 0; i < workers.length; i += 1) {
        const worker = workers[i];
        if (worker === undefined || worker.carrying < 20) {
            continue;
        }
        const base = nearestBase(worker, ownBases);
        if (base === null) {
            continue;
        }
        if (distance(worker.x, worker.y, base.x, base.y) <= 1) {
            issueTransfer(worker.id);
        }
        else {
            const goal = adjacentTile(worker, base, ownUnits);
            if (goal !== null && (goal.x !== worker.x || goal.y !== worker.y)) {
                issueMoveTo(worker.id, goal.x, goal.y);
            }
        }
    }
    for (let i = 0; i < army.length; i += 1) {
        const unit = army[i];
        if (unit === undefined) {
            continue;
        }
        const targetEnemy = bestEnemyInRange(unit, enemies);
        if (targetEnemy !== null) {
            issueAttack(unit.id, targetEnemy.id);
            continue;
        }
        let standingSite = null;
        for (let j = 0; j < allSites.length; j += 1) {
            const site = allSites[j];
            if (site !== undefined && site.x === unit.x && site.y === unit.y) {
                standingSite = site;
                break;
            }
        }
        if (standingSite !== null && standingSite.kind === "base" && standingSite.owner === me) {
            const goal = adjacentTile(unit, standingSite, ownUnits);
            if (goal !== null && (goal.x !== unit.x || goal.y !== unit.y)) {
                issueMoveTo(unit.id, goal.x, goal.y);
            }
            continue;
        }
        if (standingSite !== null && standingSite.owner !== me) {
            claimSite(standingSite.id, claimedSiteIds);
            continue;
        }
        const captureSite = chooseCaptureSite(unit, allSites, ownUnits, claimedSiteIds, me);
        if (captureSite !== null) {
            claimSite(captureSite.id, claimedSiteIds);
            if (unit.x !== captureSite.x || unit.y !== captureSite.y) {
                issueMoveTo(unit.id, captureSite.x, captureSite.y);
            }
            continue;
        }
        const enemy = nearestEnemy(unit, enemies);
        if (enemy !== null && (unit.x !== enemy.x || unit.y !== enemy.y)) {
            issueMoveTo(unit.id, enemy.x, enemy.y);
        }
    }
}
