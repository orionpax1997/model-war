"use strict";
var selfIndex = -1;
var apiUsed = 0;
var workUsed = 0;
var militaryStage = 0;
function distance(ax, ay, bx, by) {
    const dx = Math.abs(ax - bx);
    const dy = Math.abs(ay - by);
    return dx > dy ? dx : dy;
}
function acceptResult(result) {
    if (apiUsed >= 260) {
        return false;
    }
    apiUsed += 1;
    if (isError(result)) {
        apiUsed += 1;
        const code = errCode(result);
        if (code === ERR_NOT_ENOUGH_RESOURCES) {
            return false;
        }
        return false;
    }
    return true;
}
function travel(unit, x, y) {
    if (apiUsed >= 250 || (unit.x === x && unit.y === y)) {
        return;
    }
    apiUsed += 1;
    const result = moveTo(unit.id, x, y);
    acceptResult(result);
}
function cellKey(x, y) {
    return x + "," + y;
}
function adjacentDestination(unit, site, occupied, reserved, terrain) {
    let bestX = 0;
    let bestY = 0;
    let bestScore = 1000000000;
    let found = false;
    for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
            if (dx === 0 && dy === 0) {
                continue;
            }
            if (workUsed >= 1100 || apiUsed >= 245) {
                continue;
            }
            workUsed += 1;
            const x = site.x + dx;
            const y = site.y + dy;
            const key = cellKey(x, y);
            const staying = unit.x === x && unit.y === y;
            if (!staying && (occupied.has(key) || reserved.has(key))) {
                continue;
            }
            let passable = terrain.get(key);
            if (passable === undefined) {
                apiUsed += 1;
                passable = getTerrainAt(x, y) === "plain";
                terrain.set(key, passable);
            }
            if (!passable) {
                continue;
            }
            const score = distance(unit.x, unit.y, x, y) * 8;
            if (!found || score < bestScore) {
                found = true;
                bestScore = score;
                bestX = x;
                bestY = y;
            }
        }
    }
    if (!found) {
        return null;
    }
    reserved.add(cellKey(bestX, bestY));
    return { x: bestX, y: bestY };
}
function withdraw(unit, base, occupied, reserved, terrain) {
    if (base === null) {
        return;
    }
    const destination = adjacentDestination(unit, base, occupied, reserved, terrain);
    if (destination !== null) {
        travel(unit, destination.x, destination.y);
    }
}
function loop() {
    apiUsed = 0;
    workUsed = 0;
    if (selfIndex < 0) {
        apiUsed += 1;
        selfIndex = getMyIndex();
    }
    const me = selfIndex;
    apiUsed += 1;
    const tick = getTick();
    apiUsed += 1;
    const players = getObjectsByType("player");
    let money = 0;
    let alive = false;
    for (let i = 0; i < players.length; i += 1) {
        const player = players[i];
        if (player === undefined || player.index !== me) {
            continue;
        }
        money = player.resources;
        alive = player.alive;
    }
    if (!alive) {
        return;
    }
    apiUsed += 1;
    const units = getObjectsByType("unit");
    apiUsed += 1;
    const sites = getObjectsByType("site");
    const workers = [];
    const soldiers = [];
    const enemies = [];
    const bases = [];
    const mines = [];
    const objectives = [];
    const occupied = new Set();
    const reserved = new Set();
    const terrain = new Map();
    const mineLoads = new Map();
    const objectiveLoads = new Map();
    const incomingDamage = new Map();
    const siteDanger = new Map();
    let workerCount = 0;
    let soldierCount = 0;
    let rangedCount = 0;
    let pendingWorkers = 0;
    let pendingSoldiers = 0;
    let remainingOre = 0;
    let home = null;
    for (let i = 0; i < units.length && workUsed < 320; i += 1) {
        workUsed += 1;
        const unit = units[i];
        if (unit === undefined) {
            continue;
        }
        occupied.add(cellKey(unit.x, unit.y));
        if (unit.owner === me) {
            if (unit.type === "worker") {
                workerCount += 1;
                if (workers.length < 16) {
                    workers.push(unit);
                }
            }
            else {
                soldierCount += 1;
                if (unit.type === "ranged") {
                    rangedCount += 1;
                }
                if (soldiers.length < 80) {
                    soldiers.push(unit);
                }
            }
        }
        else if (enemies.length < 64) {
            enemies.push(unit);
        }
    }
    for (let i = 0; i < sites.length && workUsed < 440; i += 1) {
        workUsed += 1;
        const site = sites[i];
        if (site === undefined) {
            continue;
        }
        if (site.owner === me) {
            if (site.kind === "base") {
                bases.push(site);
                if (home === null || site.id < home.id) {
                    home = site;
                }
                if (site.producing !== null) {
                    if (site.producing.type === "worker") {
                        pendingWorkers += 1;
                    }
                    else {
                        pendingSoldiers += 1;
                    }
                }
            }
            else if (site.remaining !== undefined && site.remaining > 0) {
                mines.push(site);
                remainingOre += site.remaining;
            }
        }
        else {
            objectives.push(site);
        }
    }
    let homeThreat = null;
    let homeThreatDistance = 1000000000;
    let nearbyEnemySoldiers = 0;
    if (home !== null) {
        for (let i = 0; i < enemies.length && workUsed < 520; i += 1) {
            workUsed += 1;
            const enemy = enemies[i];
            if (enemy === undefined) {
                continue;
            }
            const d = distance(home.x, home.y, enemy.x, enemy.y);
            if (enemy.type !== "worker" && d <= 8) {
                nearbyEnemySoldiers += 1;
            }
            if (d < homeThreatDistance) {
                homeThreat = enemy;
                homeThreatDistance = d;
            }
        }
    }
    const assessedSites = [];
    for (let i = 0; i < mines.length; i += 1) {
        const mine = mines[i];
        if (mine !== undefined) {
            assessedSites.push(mine);
        }
    }
    for (let i = 0; i < objectives.length; i += 1) {
        const site = objectives[i];
        if (site !== undefined) {
            assessedSites.push(site);
        }
    }
    for (let i = 0; i < assessedSites.length && workUsed < 700; i += 1) {
        const site = assessedSites[i];
        if (site === undefined) {
            continue;
        }
        let danger = 0;
        for (let j = 0; j < enemies.length && workUsed < 700; j += 1) {
            workUsed += 1;
            const enemy = enemies[j];
            if (enemy === undefined || enemy.type === "worker") {
                continue;
            }
            if (distance(site.x, site.y, enemy.x, enemy.y) <= 4) {
                danger += 1;
            }
        }
        siteDanger.set(site.id, danger);
    }
    let desiredWorkers = mines.length * 2 + 2;
    if (desiredWorkers < 4 && remainingOre > 0) {
        desiredWorkers = 4;
    }
    if (desiredWorkers > 10) {
        desiredWorkers = 10;
    }
    if (remainingOre === 0) {
        desiredWorkers = objectives.length > 0 ? 2 : 0;
    }
    else if (remainingOre < 80 && desiredWorkers > 4) {
        desiredWorkers = 4;
    }
    if (workerCount >= 4 &&
        (money >= 16 || soldierCount >= 3 || tick >= 60)) {
        militaryStage = 1;
    }
    const urgentDefense = homeThreatDistance <= 6;
    const readyToAdvance = soldierCount >= 6 &&
        soldierCount + pendingSoldiers >= nearbyEnemySoldiers + 3 &&
        (militaryStage === 1 || remainingOre === 0);
    for (let i = 0; i < bases.length && apiUsed < 220; i += 1) {
        const base = bases[i];
        if (base === undefined || base.producing !== null) {
            continue;
        }
        let order = "melee";
        let cost = 8;
        let shouldOrder = false;
        if (workerCount + pendingWorkers < desiredWorkers &&
            (!urgentDefense || workerCount + pendingWorkers < 2)) {
            order = "worker";
            cost = 4;
            shouldOrder = true;
        }
        else if (urgentDefense ||
            militaryStage === 1 ||
            workerCount + pendingWorkers >= desiredWorkers) {
            shouldOrder = true;
            if (soldierCount >= 5 &&
                rangedCount * 4 < soldierCount &&
                money >= 16 &&
                !urgentDefense) {
                order = "ranged";
                cost = 12;
            }
        }
        const reserve = workerCount + pendingWorkers === 0 ? 4 : 0;
        if (!shouldOrder || money < cost + reserve) {
            if (order === "worker" && money >= 4) {
                shouldOrder = true;
            }
            else {
                continue;
            }
        }
        apiUsed += 1;
        const result = spawnUnit(base.id, order);
        if (acceptResult(result)) {
            money -= cost;
            if (order === "worker") {
                pendingWorkers += 1;
            }
            else {
                pendingSoldiers += 1;
                if (order === "ranged") {
                    rangedCount += 1;
                }
            }
        }
    }
    for (let i = 0; i < workers.length && apiUsed < 235; i += 1) {
        const unit = workers[i];
        if (unit === undefined) {
            continue;
        }
        let nearestBase = null;
        let baseDistance = 1000000000;
        for (let j = 0; j < bases.length && workUsed < 900; j += 1) {
            workUsed += 1;
            const base = bases[j];
            if (base === undefined) {
                continue;
            }
            const d = distance(unit.x, unit.y, base.x, base.y);
            if (nearestBase === null ||
                d < baseDistance ||
                (d === baseDistance && base.id < nearestBase.id)) {
                nearestBase = base;
                baseDistance = d;
            }
        }
        let endangered = false;
        for (let j = 0; j < enemies.length && workUsed < 930; j += 1) {
            workUsed += 1;
            const enemy = enemies[j];
            if (enemy !== undefined &&
                enemy.type !== "worker" &&
                distance(unit.x, unit.y, enemy.x, enemy.y) <= 3) {
                endangered = true;
                break;
            }
        }
        if (unit.carrying > 0 &&
            nearestBase !== null &&
            (unit.carrying >= 20 || endangered || mines.length === 0)) {
            if (baseDistance <= 1) {
                apiUsed += 1;
                const range = getRange(unit.x, unit.y, nearestBase.x, nearestBase.y);
                if (range <= 1 && apiUsed < 245) {
                    apiUsed += 1;
                    const result = transfer(unit.id);
                    acceptResult(result);
                }
            }
            else {
                withdraw(unit, nearestBase, occupied, reserved, terrain);
            }
            continue;
        }
        if (endangered) {
            withdraw(unit, nearestBase, occupied, reserved, terrain);
            continue;
        }
        let chosenMine = null;
        let bestMineScore = 1000000000;
        for (let j = 0; j < mines.length && workUsed < 960; j += 1) {
            workUsed += 1;
            const mine = mines[j];
            if (mine === undefined) {
                continue;
            }
            const danger = siteDanger.get(mine.id);
            if (danger === undefined || danger > 0) {
                continue;
            }
            const assigned = mineLoads.get(mine.id);
            const load = assigned === undefined ? 0 : assigned;
            if (load >= 3) {
                continue;
            }
            const haul = nearestBase === null
                ? 0
                : distance(mine.x, mine.y, nearestBase.x, nearestBase.y);
            const score = distance(unit.x, unit.y, mine.x, mine.y) * 2 +
                haul +
                load * 12;
            if (chosenMine === null ||
                score < bestMineScore ||
                (score === bestMineScore && mine.id < chosenMine.id)) {
                chosenMine = mine;
                bestMineScore = score;
            }
        }
        if (chosenMine !== null) {
            const previous = mineLoads.get(chosenMine.id);
            mineLoads.set(chosenMine.id, previous === undefined ? 1 : previous + 1);
            const d = distance(unit.x, unit.y, chosenMine.x, chosenMine.y);
            const onBase = nearestBase !== null &&
                unit.x === nearestBase.x &&
                unit.y === nearestBase.y;
            if (d <= 1 && !onBase) {
                apiUsed += 1;
                const range = getRange(unit.x, unit.y, chosenMine.x, chosenMine.y);
                if (range <= 1 && apiUsed < 245) {
                    apiUsed += 1;
                    const result = harvest(unit.id, chosenMine.id);
                    acceptResult(result);
                }
            }
            else {
                const destination = adjacentDestination(unit, chosenMine, occupied, reserved, terrain);
                if (destination !== null) {
                    travel(unit, destination.x, destination.y);
                }
            }
            continue;
        }
        if (unit.carrying > 0 && nearestBase !== null) {
            if (baseDistance <= 1 && apiUsed < 245) {
                apiUsed += 1;
                const range = getRange(unit.x, unit.y, nearestBase.x, nearestBase.y);
                if (range <= 1) {
                    apiUsed += 1;
                    const result = transfer(unit.id);
                    acceptResult(result);
                }
            }
            else {
                withdraw(unit, nearestBase, occupied, reserved, terrain);
            }
            continue;
        }
        let expansion = null;
        let expansionScore = 1000000000;
        for (let j = 0; j < objectives.length && workUsed < 980; j += 1) {
            workUsed += 1;
            const site = objectives[j];
            if (site === undefined || site.owner !== -1) {
                continue;
            }
            const danger = siteDanger.get(site.id);
            if (danger === undefined || danger > 0) {
                continue;
            }
            const assigned = objectiveLoads.get(site.id);
            if (assigned !== undefined && assigned >= 1) {
                continue;
            }
            const key = cellKey(site.x, site.y);
            if (occupied.has(key) &&
                (unit.x !== site.x || unit.y !== site.y)) {
                continue;
            }
            const homeDistance = nearestBase === null
                ? 0
                : distance(nearestBase.x, nearestBase.y, site.x, site.y);
            const score = distance(unit.x, unit.y, site.x, site.y) * 2 +
                homeDistance;
            if (expansion === null ||
                score < expansionScore ||
                (score === expansionScore && site.id < expansion.id)) {
                expansion = site;
                expansionScore = score;
            }
        }
        if (expansion !== null) {
            objectiveLoads.set(expansion.id, 1);
            travel(unit, expansion.x, expansion.y);
        }
        else {
            withdraw(unit, nearestBase, occupied, reserved, terrain);
        }
    }
    const rotation = soldiers.length === 0 ? 0 : tick % soldiers.length;
    for (let offset = 0; offset < soldiers.length && apiUsed < 245; offset += 1) {
        const unit = soldiers[(offset + rotation) % soldiers.length];
        if (unit === undefined) {
            continue;
        }
        const weaponRange = unit.type === "ranged" ? 2 : 1;
        const damage = unit.type === "melee" ? 3 : 2;
        let target = null;
        let targetScore = 1000000000;
        let nearestEnemy = null;
        let nearestDistance = 1000000000;
        for (let j = 0; j < enemies.length && workUsed < 1100; j += 1) {
            workUsed += 1;
            const enemy = enemies[j];
            if (enemy === undefined) {
                continue;
            }
            const d = distance(unit.x, unit.y, enemy.x, enemy.y);
            if (nearestEnemy === null ||
                d < nearestDistance ||
                (d === nearestDistance && enemy.id < nearestEnemy.id)) {
                nearestEnemy = enemy;
                nearestDistance = d;
            }
            if (d > weaponRange) {
                continue;
            }
            const allocated = incomingDamage.get(enemy.id);
            const remainingHp = enemy.hp - (allocated === undefined ? 0 : allocated);
            const score = (remainingHp <= 0 ? 1000 : 0) +
                remainingHp * 4 +
                (enemy.type === "worker" ? 8 : 0) +
                d;
            if (target === null ||
                score < targetScore ||
                (score === targetScore && enemy.id < target.id)) {
                target = enemy;
                targetScore = score;
            }
        }
        if (target !== null) {
            apiUsed += 1;
            const range = getRange(unit.x, unit.y, target.x, target.y);
            if (range <= weaponRange && apiUsed < 250) {
                apiUsed += 1;
                const result = attack(unit.id, target.id);
                if (acceptResult(result)) {
                    const allocated = incomingDamage.get(target.id);
                    incomingDamage.set(target.id, (allocated === undefined ? 0 : allocated) + damage);
                }
            }
            continue;
        }
        if (homeThreat !== null &&
            homeThreatDistance <= 6 &&
            (home === null ||
                distance(unit.x, unit.y, home.x, home.y) <= 12 ||
                !readyToAdvance)) {
            travel(unit, homeThreat.x, homeThreat.y);
            continue;
        }
        if (nearestEnemy !== null &&
            nearestDistance <= 3 &&
            (readyToAdvance || nearbyEnemySoldiers <= soldierCount)) {
            travel(unit, nearestEnemy.x, nearestEnemy.y);
            continue;
        }
        let objective = null;
        let objectiveScore = 1000000000;
        for (let j = 0; j < objectives.length && workUsed < 1100; j += 1) {
            workUsed += 1;
            const site = objectives[j];
            if (site === undefined) {
                continue;
            }
            if (site.owner !== -1 && !readyToAdvance && bases.length > 0) {
                continue;
            }
            const danger = siteDanger.get(site.id);
            if (danger === undefined) {
                continue;
            }
            if (!readyToAdvance && danger > 0) {
                continue;
            }
            const assigned = objectiveLoads.get(site.id);
            const load = assigned === undefined ? 0 : assigned;
            const limit = site.owner === -1 ? 2 : 6;
            if (load >= limit) {
                continue;
            }
            const onSite = unit.x === site.x && unit.y === site.y;
            if (!onSite && occupied.has(cellKey(site.x, site.y)) && load === 0) {
                if (site.owner === -1) {
                    continue;
                }
            }
            const homeDistance = home === null
                ? 0
                : distance(home.x, home.y, site.x, site.y);
            let score = distance(unit.x, unit.y, site.x, site.y) * 3 +
                homeDistance +
                danger * 8 +
                load * 6;
            if (site.owner !== -1) {
                score += 18;
            }
            if (site.kind === "base") {
                score -= readyToAdvance ? 8 : 2;
            }
            if (onSite) {
                score -= 100;
            }
            else if (site.progressOwner === me && site.progress > 0) {
                score -= site.progress;
            }
            if (objective === null ||
                score < objectiveScore ||
                (score === objectiveScore && site.id < objective.id)) {
                objective = site;
                objectiveScore = score;
            }
        }
        if (objective !== null) {
            const assigned = objectiveLoads.get(objective.id);
            objectiveLoads.set(objective.id, assigned === undefined ? 1 : assigned + 1);
            travel(unit, objective.x, objective.y);
            continue;
        }
        if (readyToAdvance && nearestEnemy !== null) {
            travel(unit, nearestEnemy.x, nearestEnemy.y);
            continue;
        }
        let rally = home;
        let rallyScore = 1000000000;
        for (let j = 0; j < mines.length && workUsed < 1100; j += 1) {
            workUsed += 1;
            const mine = mines[j];
            if (mine === undefined) {
                continue;
            }
            const danger = siteDanger.get(mine.id);
            const score = distance(unit.x, unit.y, mine.x, mine.y) -
                (danger === undefined ? 0 : danger * 8);
            if (score < rallyScore) {
                rally = mine;
                rallyScore = score;
            }
        }
        if (rally !== null) {
            const onBase = rally.kind === "base" &&
                unit.x === rally.x &&
                unit.y === rally.y;
            if (onBase ||
                distance(unit.x, unit.y, rally.x, rally.y) > weaponRange) {
                withdraw(unit, rally, occupied, reserved, terrain);
            }
        }
    }
}
