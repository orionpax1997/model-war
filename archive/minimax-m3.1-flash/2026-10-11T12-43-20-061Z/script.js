"use strict";
var cachedSeat = -1;
function loop() {
    if (cachedSeat < 0) {
        cachedSeat = getMyIndex();
    }
    const me = cachedSeat;
    const tick = getTick();
    const players = getObjectsByType("player");
    const player = players[me];
    if (player === undefined || !player.alive) {
        return;
    }
    const unitSnapshot = getObjectsByType("unit");
    const siteSnapshot = getObjectsByType("site");
    const mine = [];
    const enemies = [];
    const workers = [];
    const fighters = [];
    for (let i = 0; i < unitSnapshot.length; i += 1) {
        const unit = unitSnapshot[i];
        if (unit === undefined) {
            continue;
        }
        if (unit.owner === me) {
            mine.push(unit);
            if (unit.type === "worker") {
                workers.push(unit);
            }
            else {
                fighters.push(unit);
            }
        }
        else {
            enemies.push(unit);
        }
    }
    const sites = [];
    const ownedBases = [];
    const ownedResources = [];
    const targets = [];
    for (let i = 0; i < siteSnapshot.length; i += 1) {
        const site = siteSnapshot[i];
        if (site === undefined) {
            continue;
        }
        sites.push(site);
        if (site.owner === me) {
            if (site.kind === "base") {
                ownedBases.push(site);
            }
            else {
                ownedResources.push(site);
            }
        }
        else {
            targets.push(site);
        }
    }
    let anchorX = 0;
    let anchorY = 0;
    if (ownedBases.length > 0) {
        anchorX = medianCoord(ownedBases);
        anchorY = medianCoord(ownedBases);
    }
    else if (ownedResources.length > 0) {
        anchorX = medianCoord(ownedResources);
        anchorY = medianCoord(ownedResources);
    }
    else if (fighters.length > 0) {
        anchorX = medianCoord(fighters);
        anchorY = medianCoord(fighters);
    }
    else if (sites.length > 0) {
        anchorX = sites[0].x;
        anchorY = sites[0].y;
    }
    targets.sort((a, b) => {
        const av = targetPriority(a, anchorX, anchorY);
        const bv = targetPriority(b, anchorX, anchorY);
        if (av !== bv) {
            return av - bv;
        }
        return a.id - b.id;
    });
    const homeThreats = findHomeThreats(enemies, ownedBases, ownedResources);
    let armyX = anchorX;
    let armyY = anchorY;
    if (fighters.length > 0) {
        armyX = medianCoord(fighters);
        armyY = medianCoord(fighters);
    }
    const focusEnemies = buildFocusEnemies(enemies, homeThreats, armyX, armyY);
    let economicSites = 0;
    for (let i = 0; i < ownedResources.length; i += 1) {
        const site = ownedResources[i];
        if (site === undefined) {
            continue;
        }
        if (site.remaining === undefined || site.remaining > 0) {
            economicSites += 1;
        }
    }
    let workerGoal = economicSites > 16 ? 20 : 4 + economicSites;
    if (economicSites === 0) {
        workerGoal = workers.length > 0 ? workers.length : 1;
    }
    ownedBases.sort(compareSitesById);
    runProduction(ownedBases, workers.length, fighters.length, workerGoal, player.resources);
    for (let i = 0; i < workers.length; i += 1) {
        const worker = workers[i];
        if (worker === undefined) {
            continue;
        }
        commandWorker(worker, ownedBases, ownedResources, focusEnemies, sites, me, tick);
    }
    const assignmentSites = targets.length > 32 ? targets.slice(0, 32) : targets;
    const assignments = assignCombatTargets(fighters, mine, assignmentSites, anchorX, anchorY);
    for (let i = 0; i < fighters.length; i += 1) {
        const fighter = fighters[i];
        const target = assignments[i];
        if (fighter === undefined || target === undefined) {
            continue;
        }
        commandFighter(fighter, target, focusEnemies, homeThreats, targets.length > 0);
    }
}
function runProduction(bases, liveWorkers, liveMilitary, workerGoal, initialCash) {
    if (bases.length === 0) {
        return initialCash;
    }
    let workerPipeline = liveWorkers;
    let militaryPipeline = liveMilitary;
    for (let i = 0; i < bases.length; i += 1) {
        const base = bases[i];
        if (base === undefined || base.producing === null) {
            continue;
        }
        if (base.producing.type === "worker") {
            workerPipeline += 1;
        }
        else {
            militaryPipeline += 1;
        }
    }
    if (liveWorkers === 0) {
        if (workerPipeline > 0) {
            return initialCash;
        }
        for (let i = 0; i < bases.length; i += 1) {
            const base = bases[i];
            if (base === undefined || base.producing !== null || initialCash < 4) {
                continue;
            }
            const result = spawnUnit(base.id, "worker");
            if (isError(result)) {
                errCode(result);
                continue;
            }
            return initialCash - 4;
        }
        return initialCash;
    }
    let cash = initialCash;
    let newWorkers = 0;
    for (let i = 0; i < bases.length; i += 1) {
        const base = bases[i];
        if (base === undefined || base.producing !== null) {
            continue;
        }
        const wantOpeningMilitary = liveWorkers >= 2 && militaryPipeline < 2;
        const wantWorker = !wantOpeningMilitary &&
            workerPipeline < workerGoal &&
            newWorkers < 2;
        let type = "melee";
        if (wantWorker) {
            type = "worker";
        }
        const cost = type === "worker" ? 4 : 8;
        if (cash < cost) {
            continue;
        }
        const result = spawnUnit(base.id, type);
        if (isError(result)) {
            errCode(result);
            continue;
        }
        cash -= cost;
        if (type === "worker") {
            workerPipeline += 1;
            newWorkers += 1;
        }
        else {
            militaryPipeline += 1;
        }
    }
    return cash;
}
function commandWorker(worker, bases, resources, focusEnemies, sites, me, tick) {
    const base = findNearestSite(worker, bases);
    const baseDistance = base === null ? 0 : distanceBetween(worker, base);
    if (worker.carrying >= 20) {
        if (base !== null && baseDistance === 1) {
            submitTransfer(worker.id);
        }
        else if (base !== null) {
            moveBesideSite(worker, base, tick);
        }
        else {
            sendWorkerToContestedSite(worker, sites, me);
        }
        return;
    }
    const threat = findMilitaryThreat(worker, focusEnemies, 2);
    if (threat !== null) {
        if (base !== null && baseDistance === 1 && worker.carrying > 0) {
            submitTransfer(worker.id);
        }
        else if (base !== null) {
            moveBesideSite(worker, base, tick);
        }
        else {
            fleeFrom(worker, threat);
        }
        return;
    }
    const mine = findMineToWork(worker, resources);
    if (mine === null) {
        sendWorkerToContestedSite(worker, sites, me);
        return;
    }
    const mineDistance = distanceBetween(worker, mine);
    if (mineDistance === 1) {
        submitHarvest(worker.id, mine.id);
    }
    else {
        moveBesideSite(worker, mine, tick);
    }
}
function commandFighter(fighter, targetSite, enemies, homeThreats, hasTargets) {
    const choice = scanCombatChoice(fighter, enemies);
    if (choice.attack !== null) {
        submitAttack(fighter.id, choice.attack.id);
        return;
    }
    if (targetSite !== null) {
        const onTarget = fighter.x === targetSite.x && fighter.y === targetSite.y;
        if (onTarget) {
            return;
        }
        const homeFoe = findNearestFromList(fighter, homeThreats);
        if (homeFoe !== null && distanceBetween(fighter, homeFoe) <= 6) {
            submitMoveTo(fighter.id, homeFoe.x, homeFoe.y);
            return;
        }
        if (choice.nearest !== null && choice.nearestDistance <= 2) {
            submitMoveTo(fighter.id, choice.nearest.x, choice.nearest.y);
            return;
        }
        submitMoveTo(fighter.id, targetSite.x, targetSite.y);
        return;
    }
    const homeFoe = findNearestFromList(fighter, homeThreats);
    if (homeFoe !== null && distanceBetween(fighter, homeFoe) <= 8) {
        submitMoveTo(fighter.id, homeFoe.x, homeFoe.y);
        return;
    }
    if (choice.nearest !== null &&
        (choice.nearestDistance <= 3 || !hasTargets)) {
        submitMoveTo(fighter.id, choice.nearest.x, choice.nearest.y);
    }
}
function assignCombatTargets(fighters, mine, sites, anchorX, anchorY) {
    const count = fighters.length;
    const assigned = [];
    const used = [];
    const claims = [];
    for (let i = 0; i < count; i += 1) {
        assigned.push(null);
        used.push(false);
    }
    for (let i = 0; i < sites.length; i += 1) {
        claims.push(0);
    }
    for (let i = 0; i < count; i += 1) {
        const fighter = fighters[i];
        if (fighter === undefined) {
            continue;
        }
        for (let j = 0; j < sites.length; j += 1) {
            const site = sites[j];
            if (site !== undefined &&
                fighter.x === site.x &&
                fighter.y === site.y) {
                assigned[i] = site;
                used[i] = true;
                claims[j] = 1;
                break;
            }
        }
    }
    for (let i = 0; i < mine.length; i += 1) {
        const unit = mine[i];
        if (unit === undefined || unit.type !== "worker") {
            continue;
        }
        for (let j = 0; j < sites.length; j += 1) {
            const site = sites[j];
            if (site !== undefined &&
                claims[j] !== 1 &&
                unit.x === site.x &&
                unit.y === site.y) {
                claims[j] = 2;
            }
        }
    }
    let frontLimit = 4;
    if (count < 8) {
        frontLimit = 1;
    }
    else if (count < 18) {
        frontLimit = 2;
    }
    else if (count < 32) {
        frontLimit = 3;
    }
    let fronts = 0;
    for (let j = 0; j < sites.length; j += 1) {
        if (fronts >= frontLimit) {
            break;
        }
        const site = sites[j];
        if (site === undefined) {
            continue;
        }
        fronts += 1;
        let quota = 3;
        if (claims[j] === 1) {
            quota = 2;
        }
        else if (claims[j] === 2) {
            quota = 1;
        }
        for (let k = 0; k < quota; k += 1) {
            let chosen = -1;
            let bestDistance = 0;
            let bestId = 0;
            for (let i = 0; i < count; i += 1) {
                const fighter = fighters[i];
                if (fighter === undefined || used[i]) {
                    continue;
                }
                const d = distanceBetween(fighter, site);
                if (chosen === -1 ||
                    d < bestDistance ||
                    (d === bestDistance && fighter.id < bestId)) {
                    chosen = i;
                    bestDistance = d;
                    bestId = fighter.id;
                }
            }
            if (chosen >= 0) {
                assigned[chosen] = site;
                used[chosen] = true;
            }
        }
    }
    if (sites.length === 0 && count > 0) {
        const fallback = sites[0];
        if (fallback !== undefined) {
            const nearest = fighters[0];
            if (nearest !== undefined) {
                assigned[0] = fallback;
            }
        }
    }
    return assigned;
}
function scanCombatChoice(unit, enemies) {
    const attackRange = unit.type === "ranged" ? 2 : 1;
    let nearest = null;
    let nearestDistance = 0;
    let attack = null;
    for (let i = 0; i < enemies.length; i += 1) {
        const foe = enemies[i];
        if (foe === undefined) {
            continue;
        }
        const dx = unit.x - foe.x;
        const dy = unit.y - foe.y;
        const ax = dx < 0 ? -dx : dx;
        const ay = dy < 0 ? -dy : dy;
        const d = ax > ay ? ax : ay;
        if (nearest === null ||
            d < nearestDistance ||
            (d === nearestDistance && foe.id < nearest.id)) {
            nearest = foe;
            nearestDistance = d;
        }
        if (d > attackRange) {
            continue;
        }
        const foeClass = foe.type === "worker" ? 0 : 1;
        let take = false;
        if (attack === null) {
            take = true;
        }
        else {
            const attackClass = attack.type === "worker" ? 0 : 1;
            if (foeClass !== attackClass) {
                take = foeClass < attackClass;
            }
            else if (foe.hp !== attack.hp) {
                take = foe.hp < attack.hp;
            }
            else if (d !== nearestDistance) {
                take = d < nearestDistance;
            }
            else {
                take = foe.id < attack.id;
            }
        }
        if (take) {
            attack = foe;
        }
    }
    return {
        nearest: nearest,
        nearestDistance: nearestDistance,
        attack: attack
    };
}
function findHomeThreats(enemies, bases, resources) {
    const threats = [];
    const distances = [];
    for (let i = 0; i < enemies.length; i += 1) {
        const foe = enemies[i];
        if (foe === undefined) {
            continue;
        }
        let homeDistance = 5;
        for (let j = 0; j < bases.length; j += 1) {
            const site = bases[j];
            if (site === undefined) {
                continue;
            }
            const d = distanceBetween(foe, site);
            if (d < homeDistance) {
                homeDistance = d;
            }
        }
        for (let j = 0; j < resources.length; j += 1) {
            const site = resources[j];
            if (site === undefined) {
                continue;
            }
            const d = distanceBetween(foe, site);
            if (d < homeDistance) {
                homeDistance = d;
            }
        }
        if (homeDistance <= 4) {
            insertRanked(threats, distances, foe, homeDistance, 4);
        }
    }
    return threats;
}
function buildFocusEnemies(enemies, homeThreats, armyX, armyY) {
    const focus = [];
    const distances = [];
    for (let i = 0; i < enemies.length; i += 1) {
        const foe = enemies[i];
        if (foe === undefined) {
            continue;
        }
        const d = distanceBetween(foe, { x: armyX, y: armyY });
        insertRanked(focus, distances, foe, d, 28);
    }
    for (let i = 0; i < homeThreats.length; i += 1) {
        const threat = homeThreats[i];
        if (threat === undefined) {
            continue;
        }
        let duplicate = false;
        for (let j = 0; j < focus.length; j += 1) {
            if (focus[j].id === threat.id) {
                duplicate = true;
                break;
            }
        }
        if (duplicate) {
            continue;
        }
        if (focus.length < 32) {
            focus.push(threat);
        }
        else {
            focus[focus.length - 1] = threat;
        }
    }
    return focus;
}
function insertRanked(items, distances, item, itemDistance, limit) {
    if (items.length >= limit) {
        const last = items[items.length - 1];
        const lastDistance = distances[distances.length - 1];
        if (itemDistance > lastDistance ||
            (itemDistance === lastDistance && item.id >= last.id)) {
            return;
        }
    }
    let position = items.length;
    while (position > 0) {
        const previous = items[position - 1];
        const previousDistance = distances[position - 1];
        if (previousDistance < itemDistance ||
            (previousDistance === itemDistance && previous.id <= item.id)) {
            break;
        }
        position -= 1;
    }
    if (items.length < limit) {
        items.push(item);
        distances.push(itemDistance);
        return;
    }
    for (let i = items.length - 1; i > position; i -= 1) {
        items[i] = items[i - 1];
        distances[i] = distances[i - 1];
    }
    items[position] = item;
    distances[position] = itemDistance;
}
function findMilitaryThreat(worker, enemies, maxDistance) {
    let best = null;
    let bestDistance = maxDistance + 1;
    for (let i = 0; i < enemies.length; i += 1) {
        const foe = enemies[i];
        if (foe === undefined || foe.type === "worker") {
            continue;
        }
        const d = distanceBetween(worker, foe);
        if (d < bestDistance ||
            (best !== null && d === bestDistance && foe.id < best.id)) {
            best = foe;
            bestDistance = d;
        }
    }
    return best;
}
function findNearestFromList(unit, candidates) {
    let best = null;
    let bestDistance = 0;
    for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i];
        if (candidate === undefined) {
            continue;
        }
        const d = distanceBetween(unit, candidate);
        if (best === null ||
            d < bestDistance ||
            (d === bestDistance && candidate.id < best.id)) {
            best = candidate;
            bestDistance = d;
        }
    }
    return best;
}
function findNearestSite(unit, candidates) {
    let best = null;
    let bestDistance = 0;
    for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i];
        if (candidate === undefined) {
            continue;
        }
        const d = distanceBetween(unit, candidate);
        if (best === null ||
            d < bestDistance ||
            (d === bestDistance && candidate.id < best.id)) {
            best = candidate;
            bestDistance = d;
        }
    }
    return best;
}
function findMineToWork(worker, resources) {
    let nearest = null;
    let nearestDistance = 0;
    let adjacent = null;
    for (let i = 0; i < resources.length; i += 1) {
        const site = resources[i];
        if (site === undefined ||
            (site.remaining !== undefined && site.remaining <= 0)) {
            continue;
        }
        const d = distanceBetween(worker, site);
        if (d === 1 && (adjacent === null || site.id < adjacent.id)) {
            adjacent = site;
        }
        if (nearest === null ||
            d < nearestDistance ||
            (d === nearestDistance && site.id < nearest.id)) {
            nearest = site;
            nearestDistance = d;
        }
    }
    return adjacent === null ? nearest : adjacent;
}
function sendWorkerToContestedSite(worker, sites, me) {
    let best = null;
    let bestDistance = 0;
    for (let i = 0; i < sites.length; i += 1) {
        const site = sites[i];
        if (site === undefined || site.owner === me) {
            continue;
        }
        const d = distanceBetween(worker, site);
        if (best === null ||
            d < bestDistance ||
            (d === bestDistance && site.id < best.id)) {
            best = site;
            bestDistance = d;
        }
    }
    if (best !== null && worker.x !== best.x && worker.y !== best.y) {
        submitMoveTo(worker.id, best.x, best.y);
    }
}
function moveBesideSite(unit, site, tick) {
    const preferred = preferredNeighborSlot(unit, site);
    const slot = (preferred + tick) % 8;
    submitMoveTo(unit.id, site.x + neighborOffsetX(slot), site.y + neighborOffsetY(slot));
}
function preferredNeighborSlot(unit, site) {
    const dx = signValue(unit.x - site.x);
    const dy = signValue(unit.y - site.y);
    if (dx < 0) {
        if (dy < 0) {
            return 0;
        }
        if (dy > 0) {
            return 6;
        }
        return 3;
    }
    if (dx > 0) {
        if (dy < 0) {
            return 2;
        }
        if (dy > 0) {
            return 5;
        }
        return 4;
    }
    if (dy < 0) {
        return 1;
    }
    if (dy > 0) {
        return 7;
    }
    return unit.id % 8;
}
function neighborOffsetX(slot) {
    if (slot === 0 || slot === 3 || slot === 6) {
        return -1;
    }
    if (slot === 2 || slot === 4 || slot === 5) {
        return 1;
    }
    return 0;
}
function neighborOffsetY(slot) {
    if (slot === 0 || slot === 1 || slot === 2) {
        return -1;
    }
    if (slot === 5 || slot === 6 || slot === 7) {
        return 1;
    }
    return 0;
}
function fleeFrom(worker, foe) {
    let dx = signValue(worker.x - foe.x);
    let dy = signValue(worker.y - foe.y);
    if (dx === 0 && dy === 0) {
        dx = 1;
    }
    submitMove(worker.id, dx, dy);
}
function signValue(value) {
    if (value < 0) {
        return -1;
    }
    if (value > 0) {
        return 1;
    }
    return 0;
}
function targetPriority(site, anchorX, anchorY) {
    let priority = distanceBetween(site, { x: anchorX, y: anchorY });
    if (site.kind === "base") {
        if (site.owner === -1) {
            priority -= 3;
        }
        else {
            priority -= 5;
        }
    }
    else if (site.owner !== -1) {
        priority -= 1;
    }
    return priority;
}
function medianCoord(items) {
    if (items.length === 0) {
        return 0;
    }
    const values = [];
    for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item !== undefined) {
            values.push(item.x);
        }
    }
    if (values.length === 0) {
        return 0;
    }
    values.sort((a, b) => a - b);
    let low = 0;
    let high = values.length - 1;
    while (low < high) {
        low += 1;
        if (low < high) {
            high -= 1;
        }
    }
    return values[low];
}
function distanceBetween(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const ax = dx < 0 ? -dx : dx;
    const ay = dy < 0 ? -dy : dy;
    return ax > ay ? ax : ay;
}
function compareSitesById(a, b) {
    return a.id - b.id;
}
function submitMove(unitId, dx, dy) {
    inspectActionResult(move(unitId, dx, dy));
}
function submitMoveTo(unitId, x, y) {
    inspectActionResult(moveTo(unitId, x, y));
}
function submitAttack(unitId, targetId) {
    inspectActionResult(attack(unitId, targetId));
}
function submitHarvest(unitId, siteId) {
    inspectActionResult(harvest(unitId, siteId));
}
function submitTransfer(unitId) {
    inspectActionResult(transfer(unitId));
}
function inspectActionResult(result) {
    if (isError(result)) {
        errCode(result);
    }
}
