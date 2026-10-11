"use strict";
var selfIndex = -1;
var militaryPhase = 0;
function distance(ax, ay, bx, by) {
    return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}
function cellKey(x, y) {
    return x + ":" + y;
}
function noteResult(result) {
    if (isError(result)) {
        const code = errCode(result);
        if (code === ERR_NOT_ENOUGH_RESOURCES) {
            return;
        }
    }
}
function baseDistance(x, y, bases) {
    let best = 1000000;
    for (let i = 0; i < bases.length; i += 1) {
        const base = bases[i];
        if (base === undefined) {
            continue;
        }
        const d = distance(x, y, base.x, base.y);
        if (d < best) {
            best = d;
        }
    }
    return best;
}
function nearestBase(unit, bases) {
    let best = null;
    let bestDistance = 1000000;
    for (let i = 0; i < bases.length; i += 1) {
        const base = bases[i];
        if (base === undefined) {
            continue;
        }
        const d = distance(unit.x, unit.y, base.x, base.y);
        if (d < bestDistance ||
            (d === bestDistance && (best === null || base.id < best.id))) {
            best = base;
            bestDistance = d;
        }
    }
    return best;
}
function closestEnemy(unit, state, armedOnly) {
    let best = null;
    let bestDistance = 1000000;
    for (let i = 0; i < state.enemies.length; i += 1) {
        if (state.work <= 0) {
            break;
        }
        state.work -= 1;
        const enemy = state.enemies[i];
        if (enemy === undefined || (armedOnly && enemy.type === "worker")) {
            continue;
        }
        const d = distance(unit.x, unit.y, enemy.x, enemy.y);
        if (d < bestDistance ||
            (d === bestDistance && (best === null || enemy.id < best.id))) {
            best = enemy;
            bestDistance = d;
        }
    }
    return best;
}
function travel(unit, tx, ty, state) {
    if (state.calls >= 260 ||
        (unit.x === tx && unit.y === ty)) {
        return;
    }
    state.calls += 1;
    const path = findPath(unit.x, unit.y, tx, ty);
    if (path === null || path.length === 0) {
        return;
    }
    let nextX = unit.x;
    let nextY = unit.y;
    let found = false;
    for (let i = 0; i < path.length && i < 3; i += 1) {
        const step = path[i];
        if (step === undefined || (step.x === unit.x && step.y === unit.y)) {
            continue;
        }
        if (distance(unit.x, unit.y, step.x, step.y) === 1) {
            nextX = step.x;
            nextY = step.y;
            found = true;
        }
        break;
    }
    if (!found) {
        if (state.calls < 260) {
            state.calls += 1;
            noteResult(moveTo(unit.id, tx, ty));
        }
        return;
    }
    const nextKey = cellKey(nextX, nextY);
    if (!state.occupied.has(nextKey) && !state.reserved.has(nextKey)) {
        if (state.calls < 260) {
            state.calls += 1;
            const result = moveTo(unit.id, tx, ty);
            if (isError(result)) {
                const code = errCode(result);
                if (code === ERR_BAD_ARGS) {
                    return;
                }
            }
            else {
                state.reserved.add(nextKey);
            }
        }
        return;
    }
    let bestX = unit.x;
    let bestY = unit.y;
    let bestScore = 1000000;
    const currentDistance = distance(unit.x, unit.y, tx, ty);
    let terrainChecks = 0;
    for (let offset = 0; offset < 8; offset += 1) {
        const direction = (offset + unit.id + state.tick) % 8;
        let dx = 0;
        let dy = 0;
        if (direction === 0) {
            dx = 1;
        }
        else if (direction === 1) {
            dx = 1;
            dy = 1;
        }
        else if (direction === 2) {
            dy = 1;
        }
        else if (direction === 3) {
            dx = -1;
            dy = 1;
        }
        else if (direction === 4) {
            dx = -1;
        }
        else if (direction === 5) {
            dx = -1;
            dy = -1;
        }
        else if (direction === 6) {
            dy = -1;
        }
        else {
            dx = 1;
            dy = -1;
        }
        const x = unit.x + dx;
        const y = unit.y + dy;
        const key = cellKey(x, y);
        if (state.occupied.has(key) || state.reserved.has(key)) {
            continue;
        }
        const d = distance(x, y, tx, ty);
        if (d > currentDistance + 1 || state.calls >= 258 || terrainChecks >= 3) {
            continue;
        }
        terrainChecks += 1;
        state.calls += 1;
        if (getTerrainAt(x, y) !== "plain") {
            continue;
        }
        const score = d * 4 + distance(x, y, nextX, nextY);
        if (score < bestScore) {
            bestScore = score;
            bestX = x;
            bestY = y;
        }
    }
    if (bestScore < 1000000 && state.calls < 260) {
        let dx = 0;
        let dy = 0;
        if (bestX > unit.x) {
            dx = 1;
        }
        else if (bestX < unit.x) {
            dx = -1;
        }
        if (bestY > unit.y) {
            dy = 1;
        }
        else if (bestY < unit.y) {
            dy = -1;
        }
        state.calls += 1;
        const result = move(unit.id, dx, dy);
        if (isError(result)) {
            const code = errCode(result);
            if (code === ERR_BAD_ARGS) {
                return;
            }
        }
        else {
            state.reserved.add(cellKey(bestX, bestY));
        }
    }
}
function approachSite(unit, site, state) {
    let bestX = site.x;
    let bestY = site.y;
    let bestScore = 1000000;
    for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
            if (dx === 0 && dy === 0) {
                continue;
            }
            const x = site.x + dx;
            const y = site.y + dy;
            if (x === unit.x && y === unit.y) {
                return;
            }
            const key = cellKey(x, y);
            if (state.occupied.has(key) || state.reserved.has(key)) {
                continue;
            }
            const score = distance(unit.x, unit.y, x, y);
            if (score >= bestScore || state.calls >= 252) {
                continue;
            }
            state.calls += 1;
            if (getTerrainAt(x, y) !== "plain") {
                continue;
            }
            bestScore = score;
            bestX = x;
            bestY = y;
        }
    }
    if (bestScore < 1000000) {
        travel(unit, bestX, bestY, state);
    }
    else {
        travel(unit, site.x, site.y, state);
    }
}
function fleeWorker(unit, enemy, state) {
    const home = nearestBase(unit, state.bases);
    let bestX = unit.x;
    let bestY = unit.y;
    let bestScore = -1000000;
    let checks = 0;
    for (let offset = 0; offset < 8; offset += 1) {
        const direction = (offset + unit.id + state.tick) % 8;
        let dx = 0;
        let dy = 0;
        if (direction === 0) {
            dx = 1;
        }
        else if (direction === 1) {
            dx = 1;
            dy = 1;
        }
        else if (direction === 2) {
            dy = 1;
        }
        else if (direction === 3) {
            dx = -1;
            dy = 1;
        }
        else if (direction === 4) {
            dx = -1;
        }
        else if (direction === 5) {
            dx = -1;
            dy = -1;
        }
        else if (direction === 6) {
            dy = -1;
        }
        else {
            dx = 1;
            dy = -1;
        }
        const x = unit.x + dx;
        const y = unit.y + dy;
        const key = cellKey(x, y);
        if (state.occupied.has(key) || state.reserved.has(key)) {
            continue;
        }
        const separation = distance(x, y, enemy.x, enemy.y);
        const homeDistance = home === null ? 0 : distance(x, y, home.x, home.y);
        const score = separation * 12 - homeDistance;
        if (score <= bestScore || checks >= 3 || state.calls >= 258) {
            continue;
        }
        checks += 1;
        state.calls += 1;
        if (getTerrainAt(x, y) !== "plain") {
            continue;
        }
        bestScore = score;
        bestX = x;
        bestY = y;
    }
    if (bestScore > -1000000) {
        travel(unit, bestX, bestY, state);
    }
    else if (home !== null) {
        approachSite(unit, home, state);
    }
}
function chooseCapture(unit, state, danger, peacefulOnly) {
    let best = null;
    let bestScore = 1000000;
    for (let i = 0; i < state.sites.length; i += 1) {
        if (state.work <= 0) {
            break;
        }
        state.work -= 1;
        const site = state.sites[i];
        if (site === undefined ||
            site.owner === state.me ||
            state.claimed.has(site.id)) {
            continue;
        }
        const risk = danger.get(site.id) ?? 0;
        const homeDistance = baseDistance(site.x, site.y, state.bases);
        if (peacefulOnly && (site.owner !== -1 || risk > 0 || homeDistance > 14)) {
            continue;
        }
        const occupied = state.occupied.has(cellKey(site.x, site.y));
        const standingHere = unit.x === site.x && unit.y === site.y;
        if (peacefulOnly && occupied && !standingHere) {
            continue;
        }
        let score = distance(unit.x, unit.y, site.x, site.y) * 5 +
            homeDistance * 2 +
            risk * 8;
        if (site.owner !== -1) {
            score += 24;
        }
        if (site.kind === "base") {
            score -= 12;
        }
        if (site.progressOwner === state.me) {
            score -= site.progress * 3;
        }
        if (standingHere) {
            score -= 100;
        }
        if (occupied && !standingHere) {
            score += 18;
        }
        if (score < bestScore ||
            (score === bestScore && (best === null || site.id < best.id))) {
            best = site;
            bestScore = score;
        }
    }
    return best;
}
function runWorker(unit, state, danger, mineLoad, expand) {
    if (state.calls >= 260) {
        return;
    }
    const threat = closestEnemy(unit, state, true);
    if (threat !== null) {
        state.calls += 1;
        const range = getRange(unit.x, unit.y, threat.x, threat.y);
        const dangerRange = threat.type === "ranged" ? 3 : 2;
        if (range <= dangerRange) {
            fleeWorker(unit, threat, state);
            return;
        }
    }
    const home = nearestBase(unit, state.bases);
    if (unit.carrying > 0 && home !== null) {
        state.calls += 1;
        const range = getRange(unit.x, unit.y, home.x, home.y);
        if (range <= 1 && (unit.carrying >= 10 || state.mines.length === 0)) {
            if (state.calls < 260) {
                state.calls += 1;
                noteResult(transfer(unit.id));
            }
            return;
        }
    }
    if (unit.carrying >= 20 || (unit.carrying > 0 && state.mines.length === 0)) {
        if (home !== null) {
            state.calls += 1;
            if (getRange(unit.x, unit.y, home.x, home.y) <= 1) {
                if (state.calls < 260) {
                    state.calls += 1;
                    noteResult(transfer(unit.id));
                }
            }
            else {
                approachSite(unit, home, state);
            }
        }
        else {
            const target = chooseCapture(unit, state, danger, false);
            if (target !== null) {
                state.claimed.add(target.id);
                travel(unit, target.x, target.y, state);
            }
        }
        return;
    }
    if (expand && unit.carrying === 0) {
        const target = chooseCapture(unit, state, danger, true);
        if (target !== null) {
            state.claimed.add(target.id);
            travel(unit, target.x, target.y, state);
            return;
        }
    }
    let bestMine = null;
    let bestScore = 1000000;
    for (let i = 0; i < state.mines.length; i += 1) {
        if (state.work <= 0) {
            break;
        }
        state.work -= 1;
        const mine = state.mines[i];
        if (mine === undefined) {
            continue;
        }
        const risk = danger.get(mine.id) ?? 0;
        if (risk > 0) {
            continue;
        }
        const assigned = mineLoad.get(mine.id) ?? 0;
        const d = distance(unit.x, unit.y, mine.x, mine.y);
        const score = d * 3 +
            baseDistance(mine.x, mine.y, state.bases) * 2 +
            assigned * 9;
        if (score < bestScore ||
            (score === bestScore && (bestMine === null || mine.id < bestMine.id))) {
            bestMine = mine;
            bestScore = score;
        }
    }
    if (bestMine !== null) {
        mineLoad.set(bestMine.id, (mineLoad.get(bestMine.id) ?? 0) + 1);
        if (state.calls >= 259) {
            return;
        }
        state.calls += 1;
        const range = getRange(unit.x, unit.y, bestMine.x, bestMine.y);
        if (range <= 1) {
            if (unit.x === bestMine.x && unit.y === bestMine.y) {
                approachSite(unit, bestMine, state);
            }
            else {
                state.calls += 1;
                noteResult(harvest(unit.id, bestMine.id));
            }
        }
        else {
            approachSite(unit, bestMine, state);
        }
        return;
    }
    if (unit.carrying > 0 && home !== null) {
        if (state.calls >= 259) {
            return;
        }
        state.calls += 1;
        if (getRange(unit.x, unit.y, home.x, home.y) <= 1) {
            state.calls += 1;
            noteResult(transfer(unit.id));
        }
        else {
            approachSite(unit, home, state);
        }
        return;
    }
    const target = chooseCapture(unit, state, danger, true);
    if (target !== null) {
        state.claimed.add(target.id);
        travel(unit, target.x, target.y, state);
    }
    else if (home !== null && unit.x === home.x && unit.y === home.y) {
        approachSite(unit, home, state);
    }
}
function runSoldier(unit, state, danger, mainTarget, defensiveEnemy, armySize, scout) {
    if (state.calls >= 258) {
        return;
    }
    const reach = unit.type === "ranged" ? 2 : 1;
    let attackTarget = null;
    let attackScore = -1000000;
    let nearbyArmed = null;
    let nearbyDistance = 1000000;
    for (let i = 0; i < state.enemies.length; i += 1) {
        if (state.work <= 0) {
            break;
        }
        state.work -= 1;
        const enemy = state.enemies[i];
        if (enemy === undefined) {
            continue;
        }
        const d = distance(unit.x, unit.y, enemy.x, enemy.y);
        if (enemy.type !== "worker" && d < nearbyDistance) {
            nearbyArmed = enemy;
            nearbyDistance = d;
        }
        if (d > reach) {
            continue;
        }
        const assignedDamage = state.damage.get(enemy.id) ?? 0;
        const remainingHp = enemy.hp - assignedDamage;
        let score = 40 - enemy.hp;
        if (enemy.type === "ranged") {
            score += 14;
        }
        else if (enemy.type === "worker") {
            score += 8;
        }
        if (remainingHp <= 0) {
            score -= 100;
        }
        else if (remainingHp <= (unit.type === "melee" ? 3 : 2)) {
            score += 20;
        }
        if (score > attackScore ||
            (score === attackScore && (attackTarget === null || enemy.id < attackTarget.id))) {
            attackTarget = enemy;
            attackScore = score;
        }
    }
    if (attackTarget !== null) {
        state.calls += 1;
        const range = getRange(unit.x, unit.y, attackTarget.x, attackTarget.y);
        if (range <= reach && state.calls < 260) {
            state.calls += 1;
            const result = attack(unit.id, attackTarget.id);
            if (isError(result)) {
                const code = errCode(result);
                if (code === ERR_INVALID_TARGET) {
                    return;
                }
            }
            else {
                state.damage.set(attackTarget.id, (state.damage.get(attackTarget.id) ?? 0) +
                    (unit.type === "melee" ? 3 : 2));
            }
            return;
        }
    }
    if (defensiveEnemy !== null &&
        distance(unit.x, unit.y, defensiveEnemy.x, defensiveEnemy.y) <= 12) {
        travel(unit, defensiveEnemy.x, defensiveEnemy.y, state);
        return;
    }
    if (nearbyArmed !== null && nearbyDistance <= 4) {
        travel(unit, nearbyArmed.x, nearbyArmed.y, state);
        return;
    }
    let target = mainTarget;
    if (scout || target === null) {
        const personal = chooseCapture(unit, state, danger, armySize < 5);
        if (personal !== null) {
            target = personal;
        }
    }
    if (target !== null) {
        const risk = danger.get(target.id) ?? 0;
        if (risk === 0 || armySize >= 5 || state.bases.length === 0) {
            state.claimed.add(target.id);
            if (unit.type === "ranged" && !scout && risk > 0) {
                approachSite(unit, target, state);
            }
            else {
                travel(unit, target.x, target.y, state);
            }
            return;
        }
    }
    const home = nearestBase(unit, state.bases);
    if (home !== null) {
        if (unit.x === home.x && unit.y === home.y) {
            approachSite(unit, home, state);
        }
        else if (distance(unit.x, unit.y, home.x, home.y) > 3) {
            approachSite(unit, home, state);
        }
    }
}
function loop() {
    if (selfIndex < 0) {
        selfIndex = getMyIndex();
    }
    const tick = getTick();
    const players = getObjectsByType("player");
    let money = 0;
    let alive = false;
    for (let i = 0; i < players.length; i += 1) {
        const player = players[i];
        if (player !== undefined && player.index === selfIndex) {
            money = player.resources;
            alive = player.alive;
            break;
        }
    }
    if (!alive) {
        return;
    }
    const allUnits = getObjectsByType("unit");
    const allSites = getObjectsByType("site");
    const workers = [];
    const soldiers = [];
    const enemies = [];
    const bases = [];
    const mines = [];
    const sites = [];
    const occupied = new Set();
    let meleeCount = 0;
    let rangedCount = 0;
    for (let i = 0; i < allUnits.length; i += 1) {
        const unit = allUnits[i];
        if (unit === undefined) {
            continue;
        }
        occupied.add(cellKey(unit.x, unit.y));
        if (unit.owner === selfIndex) {
            if (unit.type === "worker") {
                workers.push(unit);
            }
            else {
                soldiers.push(unit);
                if (unit.type === "melee") {
                    meleeCount += 1;
                }
                else if (unit.type === "ranged") {
                    rangedCount += 1;
                }
            }
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
        sites.push(site);
        if (site.owner !== selfIndex) {
            continue;
        }
        if (site.kind === "base") {
            bases.push(site);
        }
        else if (site.remaining !== undefined && site.remaining > 0) {
            mines.push(site);
        }
    }
    workers.sort((a, b) => a.id - b.id);
    soldiers.sort((a, b) => a.id - b.id);
    enemies.sort((a, b) => a.id - b.id);
    bases.sort((a, b) => a.id - b.id);
    sites.sort((a, b) => a.id - b.id);
    const state = {
        me: selfIndex,
        tick,
        calls: 5,
        work: 1800,
        occupied,
        reserved: new Set(),
        claimed: new Set(),
        damage: new Map(),
        bases,
        mines,
        sites,
        enemies,
    };
    const danger = new Map();
    let defensiveEnemy = null;
    let defensiveScore = 1000000;
    let localThreats = 0;
    for (let i = 0; i < enemies.length; i += 1) {
        if (state.work <= 0) {
            break;
        }
        state.work -= 1;
        const enemy = enemies[i];
        if (enemy === undefined) {
            continue;
        }
        const d = baseDistance(enemy.x, enemy.y, bases);
        if (d <= 7) {
            if (enemy.type !== "worker") {
                localThreats += 1;
            }
            const score = d * 4 + (enemy.type === "worker" ? 5 : 0);
            if (score < defensiveScore ||
                (score === defensiveScore &&
                    (defensiveEnemy === null || enemy.id < defensiveEnemy.id))) {
                defensiveScore = score;
                defensiveEnemy = enemy;
            }
        }
    }
    for (let i = 0; i < sites.length && i < 64; i += 1) {
        const site = sites[i];
        if (site === undefined) {
            continue;
        }
        let risk = 0;
        for (let j = 0; j < enemies.length && j < 48; j += 1) {
            if (state.work <= 1200) {
                break;
            }
            state.work -= 1;
            const enemy = enemies[j];
            if (enemy === undefined) {
                continue;
            }
            const d = distance(site.x, site.y, enemy.x, enemy.y);
            if (d <= 4 && enemy.type !== "worker") {
                risk += 1;
            }
            else if (d === 0) {
                risk += 1;
            }
        }
        danger.set(site.id, risk);
    }
    let totalRemaining = 0;
    let safeMines = 0;
    for (let i = 0; i < mines.length; i += 1) {
        const mine = mines[i];
        if (mine === undefined) {
            continue;
        }
        totalRemaining += mine.remaining ?? 0;
        if ((danger.get(mine.id) ?? 0) === 0) {
            safeMines += 1;
        }
    }
    let desiredWorkers = Math.min(12, Math.max(4, safeMines * 3));
    if (safeMines === 0) {
        desiredWorkers = workers.length === 0 ? 1 : 2;
    }
    else if (totalRemaining < 60) {
        desiredWorkers = Math.min(desiredWorkers, 3);
    }
    else if (totalRemaining < 140) {
        desiredWorkers = Math.min(desiredWorkers, 5);
    }
    if ((workers.length >= Math.min(desiredWorkers, 6) && money >= 16) ||
        (workers.length >= 4 && tick >= 55) ||
        localThreats > 0) {
        militaryPhase = 1;
    }
    let pendingWorkers = 0;
    let pendingMelee = 0;
    let pendingRanged = 0;
    for (let i = 0; i < bases.length; i += 1) {
        const base = bases[i];
        if (base === undefined || base.producing === null) {
            continue;
        }
        if (base.producing.type === "worker") {
            pendingWorkers += 1;
        }
        else if (base.producing.type === "melee") {
            pendingMelee += 1;
        }
        else if (base.producing.type === "ranged") {
            pendingRanged += 1;
        }
    }
    for (let i = 0; i < bases.length; i += 1) {
        const base = bases[i];
        if (base === undefined || base.producing !== null || state.calls >= 240) {
            continue;
        }
        let order = "melee";
        let cost = 8;
        const workerTotal = workers.length + pendingWorkers;
        const forceTotal = soldiers.length + pendingMelee + pendingRanged;
        const urgentDefense = localThreats > 0 && forceTotal < localThreats + 2;
        const basicDefense = tick >= 20 && forceTotal < 2 && workerTotal >= 4;
        const replaceWorkers = workerTotal === 0 || (workerTotal < 3 && safeMines > 0);
        if (replaceWorkers ||
            (!urgentDefense && !basicDefense && workerTotal < desiredWorkers &&
                (militaryPhase === 0 || forceTotal >= 3 || workerTotal < 5))) {
            order = "worker";
            cost = 4;
        }
        else if (!urgentDefense &&
            meleeCount + pendingMelee >= 4 &&
            (rangedCount + pendingRanged) * 3 < meleeCount + pendingMelee &&
            money >= 16) {
            order = "ranged";
            cost = 12;
        }
        if (money < cost) {
            continue;
        }
        if (order !== "worker" && workerTotal === 0 && money - cost < 4) {
            continue;
        }
        state.calls += 1;
        const result = spawnUnit(base.id, order);
        if (isError(result)) {
            const code = errCode(result);
            if (code === ERR_NOT_ENOUGH_RESOURCES) {
                break;
            }
        }
        else {
            money -= cost;
            if (order === "worker") {
                pendingWorkers += 1;
            }
            else if (order === "melee") {
                pendingMelee += 1;
            }
            else if (order === "ranged") {
                pendingRanged += 1;
            }
        }
    }
    const mineLoad = new Map();
    for (let i = 0; i < workers.length && i < 16; i += 1) {
        const unit = workers[i];
        if (unit === undefined) {
            continue;
        }
        const expand = i === workers.length - 1 &&
            workers.length >= 5 &&
            localThreats === 0 &&
            totalRemaining >= 80;
        runWorker(unit, state, danger, mineLoad, expand);
    }
    let mainTarget = null;
    let mainScore = 1000000;
    for (let i = 0; i < sites.length; i += 1) {
        const site = sites[i];
        if (site === undefined || site.owner === selfIndex || state.claimed.has(site.id)) {
            continue;
        }
        const risk = danger.get(site.id) ?? 0;
        if (risk > 0 && soldiers.length < 5 && bases.length > 0) {
            continue;
        }
        let score = baseDistance(site.x, site.y, bases) * 4 + risk * 9;
        if (bases.length === 0) {
            const firstSoldier = soldiers[0];
            score =
                firstSoldier === undefined
                    ? 1000000
                    : distance(firstSoldier.x, firstSoldier.y, site.x, site.y) * 4 + risk * 9;
        }
        if (site.owner !== -1) {
            score += 20;
        }
        if (site.kind === "base") {
            score -= 14;
        }
        if (site.progressOwner === selfIndex) {
            score -= site.progress * 3;
        }
        if (score < mainScore ||
            (score === mainScore && (mainTarget === null || site.id < mainTarget.id))) {
            mainTarget = site;
            mainScore = score;
        }
    }
    const count = Math.min(soldiers.length, 48);
    for (let i = 0; i < count; i += 1) {
        if (state.calls >= 258) {
            break;
        }
        const index = soldiers.length <= 48 ? i : (i + tick) % soldiers.length;
        const unit = soldiers[index];
        if (unit === undefined) {
            continue;
        }
        const scout = localThreats === 0 &&
            unit.type !== "ranged" &&
            (i === 0 || (i === 1 && soldiers.length >= 8));
        runSoldier(unit, state, danger, mainTarget, defensiveEnemy, soldiers.length, scout);
    }
}
