"use strict";
const ADJ_X = [0, -1, 1, 0, -1, 1, -1, 1];
const ADJ_Y = [-1, 0, 0, 1, -1, -1, 1, 1];
const R2_X = [0, -2, 2, 0, -2, 2, -2, 2];
const R2_Y = [-2, 0, 0, 2, -2, -2, 2, 2];
const TERRAIN_CALL_LIMIT = 500;
const AGGRO_RANGE = 8;
const CARRY_LIMIT = 20;
const WORKER_COST = 4;
const MELEE_COST = 8;
var terrainCalls = 0;
function cheb(ax, ay, bx, by) {
    const dx = ax > bx ? ax - bx : bx - ax;
    const dy = ay > by ? ay - by : by - ay;
    return dx > dy ? dx : dy;
}
function siteRemaining(s) {
    return s.remaining === undefined ? 0 : s.remaining;
}
function unitRange(u) {
    return u.type === "ranged" ? 2 : 1;
}
function plainAt(x, y, cache) {
    const key = x + "," + y;
    const t = cache[key];
    if (t !== undefined) {
        return t === "plain";
    }
    if (terrainCalls >= TERRAIN_CALL_LIMIT) {
        return false;
    }
    terrainCalls += 1;
    const v = getTerrainAt(x, y);
    cache[key] = v;
    return v === "plain";
}
function addSpots(cx, cy, offX, offY, wantFree, maxCount, xs, ys, siteByKey, unitByKey, cache) {
    let count = 0;
    for (let k = 0; k < offX.length; k += 1) {
        if (count >= maxCount) {
            break;
        }
        const ox = offX[k];
        const oy = offY[k];
        if (ox === undefined || oy === undefined) {
            continue;
        }
        const x = cx + ox;
        const y = cy + oy;
        const key = x + "," + y;
        if (siteByKey[key] !== undefined) {
            continue;
        }
        if (wantFree && unitByKey[key] !== undefined) {
            continue;
        }
        if (!plainAt(x, y, cache)) {
            continue;
        }
        xs.push(x);
        ys.push(y);
        count += 1;
    }
    return count;
}
function pickSpot(start, count, xs, ys, taken) {
    if (count <= 0 || start < 0) {
        return -1;
    }
    for (let i = 0; i < count; i += 1) {
        const idx = start + i;
        const x = xs[idx];
        const y = ys[idx];
        if (x === undefined || y === undefined) {
            continue;
        }
        const key = x + "," + y;
        if (taken[key] === true) {
            continue;
        }
        taken[key] = true;
        return idx;
    }
    return -1;
}
function nearestSiteIndex(x, y, sites) {
    let best = -1;
    let bestD = 0;
    for (let i = 0; i < sites.length; i += 1) {
        const s = sites[i];
        if (s === undefined) {
            continue;
        }
        const d = cheb(x, y, s.x, s.y);
        if (best < 0 || d < bestD) {
            best = i;
            bestD = d;
        }
    }
    return best;
}
function nearestEnemyUnit(x, y, enemies) {
    let best = null;
    let bestD = 0;
    for (let i = 0; i < enemies.length; i += 1) {
        const u = enemies[i];
        if (u === undefined) {
            continue;
        }
        const d = cheb(x, y, u.x, u.y);
        if (best === null || d < bestD) {
            best = u;
            bestD = d;
        }
    }
    return best;
}
function nearestBaseIndex(x, y, bases) {
    let best = -1;
    let bestD = 0;
    for (let i = 0; i < bases.length; i += 1) {
        const b = bases[i];
        if (b === undefined) {
            continue;
        }
        const d = cheb(x, y, b.x, b.y);
        if (best < 0 || d < bestD) {
            best = i;
            bestD = d;
        }
    }
    return best;
}
function loop() {
    const me = getMyIndex();
    const tick = getTick();
    terrainCalls = 0;
    const players = getObjectsByType("player");
    let minePlayer = null;
    for (let i = 0; i < players.length; i += 1) {
        const p = players[i];
        if (p === undefined) {
            continue;
        }
        if (p.index === me) {
            minePlayer = p;
        }
    }
    if (minePlayer === null || !minePlayer.alive) {
        return;
    }
    const units = getObjectsByType("unit");
    const sites = getObjectsByType("site");
    const unitByKey = {};
    const siteByKey = {};
    const terrainCache = {};
    const myUnits = [];
    const enemies = [];
    let enemyMilitaryCount = 0;
    for (let i = 0; i < units.length; i += 1) {
        const u = units[i];
        if (u === undefined) {
            continue;
        }
        unitByKey[u.x + "," + u.y] = u;
        if (u.owner === me) {
            myUnits.push(u);
        }
        else {
            enemies.push(u);
            if (u.type !== "worker") {
                enemyMilitaryCount += 1;
            }
        }
    }
    const myBases = [];
    const myFreshResources = [];
    const neutralResources = [];
    const capturableSites = [];
    for (let i = 0; i < sites.length; i += 1) {
        const s = sites[i];
        if (s === undefined) {
            continue;
        }
        siteByKey[s.x + "," + s.y] = s;
        if (s.kind === "base") {
            if (s.owner === me) {
                myBases.push(s);
            }
            else {
                capturableSites.push(s);
            }
        }
        else if (s.kind === "resource") {
            if (s.owner === me) {
                if (siteRemaining(s) > 0) {
                    myFreshResources.push(s);
                }
            }
            else {
                capturableSites.push(s);
                if (siteRemaining(s) > 0 && (s.progressOwner === -1 || s.progressOwner === me)) {
                    neutralResources.push(s);
                }
            }
        }
        else if (s.owner !== me) {
            capturableSites.push(s);
        }
    }
    const myWorkers = [];
    const myMilitary = [];
    for (let i = 0; i < myUnits.length; i += 1) {
        const u = myUnits[i];
        if (u === undefined) {
            continue;
        }
        if (u.type === "worker") {
            myWorkers.push(u);
        }
        else {
            myMilitary.push(u);
        }
    }
    const workerCount = myWorkers.length;
    const militaryCount = myMilitary.length;
    let threatNearBase = false;
    for (let i = 0; i < enemies.length; i += 1) {
        const e = enemies[i];
        if (e === undefined) {
            continue;
        }
        for (let j = 0; j < myBases.length; j += 1) {
            const b = myBases[j];
            if (b === undefined) {
                continue;
            }
            if (cheb(e.x, e.y, b.x, b.y) <= AGGRO_RANGE) {
                threatNearBase = true;
                break;
            }
        }
        if (threatNearBase) {
            break;
        }
    }
    let push = false;
    if (militaryCount >= 10) {
        push = true;
    }
    if (tick >= 180 && militaryCount >= 6) {
        push = true;
    }
    if (tick >= 300 && militaryCount >= 4) {
        push = true;
    }
    if (tick >= 420 && militaryCount >= 2) {
        push = true;
    }
    if (tick >= 540) {
        push = true;
    }
    if (myBases.length === 0) {
        push = true;
    }
    if (push && enemyMilitaryCount > militaryCount + 2 && tick < 300) {
        push = false;
    }
    const baseIndexById = {};
    for (let i = 0; i < myBases.length; i += 1) {
        const b = myBases[i];
        if (b !== undefined) {
            baseIndexById[b.id] = i;
        }
    }
    const neutralIndexById = {};
    for (let i = 0; i < neutralResources.length; i += 1) {
        const s = neutralResources[i];
        if (s !== undefined) {
            neutralIndexById[s.id] = i;
        }
    }
    const deliveryX = [];
    const deliveryY = [];
    const deliveryStart = [];
    const deliveryCount = [];
    for (let bi = 0; bi < myBases.length; bi += 1) {
        const base = myBases[bi];
        deliveryStart[bi] = deliveryX.length;
        if (base === undefined) {
            deliveryCount[bi] = 0;
            continue;
        }
        deliveryCount[bi] = addSpots(base.x, base.y, ADJ_X, ADJ_Y, true, 4, deliveryX, deliveryY, siteByKey, unitByKey, terrainCache);
    }
    const harvestX = [];
    const harvestY = [];
    const harvestStart = [];
    const harvestCount = [];
    for (let ri = 0; ri < myFreshResources.length; ri += 1) {
        const s = myFreshResources[ri];
        harvestStart[ri] = harvestX.length;
        if (s === undefined) {
            harvestCount[ri] = 0;
            continue;
        }
        harvestCount[ri] = addSpots(s.x, s.y, ADJ_X, ADJ_Y, true, 6, harvestX, harvestY, siteByKey, unitByKey, terrainCache);
    }
    const rallyX = [];
    const rallyY = [];
    const rallyStart = [];
    const rallyCount = [];
    for (let bi = 0; bi < myBases.length; bi += 1) {
        const base = myBases[bi];
        rallyStart[bi] = rallyX.length;
        if (base === undefined) {
            rallyCount[bi] = 0;
            continue;
        }
        rallyCount[bi] = addSpots(base.x, base.y, R2_X, R2_Y, false, 6, rallyX, rallyY, siteByKey, unitByKey, terrainCache);
    }
    let workerTarget = 2;
    if (myFreshResources.length >= 2) {
        workerTarget = 4;
    }
    if (myFreshResources.length >= 4) {
        workerTarget = 6;
    }
    if (myFreshResources.length >= 6) {
        workerTarget = 8;
    }
    if (myFreshResources.length >= 8) {
        workerTarget = 10;
    }
    const needDefense = threatNearBase || enemyMilitaryCount > militaryCount + 1;
    let resNow = minePlayer.resources;
    for (let bi = 0; bi < myBases.length; bi += 1) {
        const base = myBases[bi];
        if (base === undefined) {
            continue;
        }
        if (base.producing !== null) {
            continue;
        }
        const occ = unitByKey[base.x + "," + base.y];
        if (occ !== undefined && occ.owner !== me) {
            continue;
        }
        let makeWorker = false;
        if (workerCount < 2) {
            makeWorker = true;
        }
        else if (needDefense && resNow >= MELEE_COST) {
            makeWorker = false;
        }
        else if (militaryCount === 0) {
            makeWorker = false;
        }
        else if (workerCount < workerTarget) {
            makeWorker = true;
        }
        else {
            makeWorker = false;
        }
        if (makeWorker) {
            if (resNow >= WORKER_COST) {
                spawnUnit(base.id, "worker");
                resNow -= WORKER_COST;
            }
        }
        else {
            if (resNow >= MELEE_COST) {
                spawnUnit(base.id, "melee");
                resNow -= MELEE_COST;
            }
            else if (resNow >= WORKER_COST && workerCount < workerTarget) {
                spawnUnit(base.id, "worker");
                resNow -= WORKER_COST;
            }
        }
    }
    const captureWorkerIds = [];
    const captureSiteIdx = [];
    for (let i = 0; i < myWorkers.length; i += 1) {
        const w = myWorkers[i];
        if (w === undefined) {
            continue;
        }
        if (w.carrying >= CARRY_LIMIT) {
            continue;
        }
        const sh = siteByKey[w.x + "," + w.y];
        if (sh === undefined) {
            continue;
        }
        if (sh.owner === me || sh.progressOwner !== me) {
            continue;
        }
        const ni = neutralIndexById[sh.id];
        if (ni !== undefined) {
            captureWorkerIds.push(w.id);
            captureSiteIdx.push(ni);
        }
    }
    let maxCapturers = 0;
    if (!threatNearBase && enemyMilitaryCount <= militaryCount && workerCount >= 5) {
        maxCapturers = 1;
    }
    if (!threatNearBase && enemyMilitaryCount <= militaryCount && workerCount >= 7) {
        maxCapturers = 2;
    }
    let guard = 0;
    while (captureWorkerIds.length < maxCapturers && guard < 8) {
        guard += 1;
        let chosenSite = -1;
        let chosenScore = 0;
        for (let i = 0; i < neutralResources.length; i += 1) {
            const s = neutralResources[i];
            if (s === undefined) {
                continue;
            }
            if (siteRemaining(s) <= 0) {
                continue;
            }
            if (s.progressOwner !== -1 && s.progressOwner !== me) {
                continue;
            }
            if (unitByKey[s.x + "," + s.y] !== undefined) {
                continue;
            }
            let used = false;
            for (let j = 0; j < captureSiteIdx.length; j += 1) {
                const si = captureSiteIdx[j];
                if (si !== undefined && si === i) {
                    used = true;
                    break;
                }
            }
            if (used) {
                continue;
            }
            const bi = nearestBaseIndex(s.x, s.y, myBases);
            const b = bi < 0 ? null : myBases[bi];
            const d = b === null || b === undefined ? 0 : cheb(s.x, s.y, b.x, b.y);
            const score = d + (s.progressOwner === me ? -2 : 0);
            if (chosenSite < 0 || score < chosenScore) {
                chosenSite = i;
                chosenScore = score;
            }
        }
        if (chosenSite < 0) {
            break;
        }
        let chosenWorker = -1;
        let chosenWorkerD = 0;
        for (let i = 0; i < myWorkers.length; i += 1) {
            const w = myWorkers[i];
            if (w === undefined) {
                continue;
            }
            if (w.carrying >= CARRY_LIMIT) {
                continue;
            }
            let assigned = false;
            for (let j = 0; j < captureWorkerIds.length; j += 1) {
                const wid = captureWorkerIds[j];
                if (wid !== undefined && wid === w.id) {
                    assigned = true;
                    break;
                }
            }
            if (assigned) {
                continue;
            }
            const s = neutralResources[chosenSite];
            if (s === undefined) {
                continue;
            }
            const d = cheb(w.x, w.y, s.x, s.y);
            if (chosenWorker < 0 || d < chosenWorkerD) {
                chosenWorker = i;
                chosenWorkerD = d;
            }
        }
        if (chosenWorker < 0) {
            break;
        }
        const w = myWorkers[chosenWorker];
        if (w === undefined) {
            break;
        }
        captureWorkerIds.push(w.id);
        captureSiteIdx.push(chosenSite);
    }
    let pushTargetIdx = -1;
    if (push) {
        let bestScore = 0;
        for (let i = 0; i < capturableSites.length; i += 1) {
            const s = capturableSites[i];
            if (s === undefined) {
                continue;
            }
            const occ = unitByKey[s.x + "," + s.y];
            if (occ !== undefined && occ.owner === me) {
                continue;
            }
            let priority = 0;
            if (s.kind === "base") {
                priority = -2;
            }
            else if (siteRemaining(s) > 0) {
                priority = 0;
            }
            else {
                priority = 2;
            }
            if (s.progressOwner === me) {
                priority -= 2;
            }
            const bi = nearestBaseIndex(s.x, s.y, myBases);
            const b = bi < 0 ? null : myBases[bi];
            const d = b === null || b === undefined ? 0 : cheb(s.x, s.y, b.x, b.y);
            const score = d + priority;
            if (pushTargetIdx < 0 || score < bestScore) {
                pushTargetIdx = i;
                bestScore = score;
            }
        }
    }
    const spotTaken = {};
    for (let i = 0; i < myUnits.length; i += 1) {
        const u = myUnits[i];
        if (u === undefined) {
            continue;
        }
        if (u.type !== "worker") {
            continue;
        }
        const key = u.x + "," + u.y;
        const here = siteByKey[key];
        if (here !== undefined && here.kind === "base" && here.owner === me) {
            const bi = baseIndexById[here.id];
            if (bi !== undefined) {
                const idx = pickSpot(deliveryStart[bi] ?? -1, deliveryCount[bi] ?? 0, deliveryX, deliveryY, spotTaken);
                if (idx >= 0) {
                    const x = deliveryX[idx];
                    const y = deliveryY[idx];
                    if (x !== undefined && y !== undefined) {
                        moveTo(u.id, x, y);
                    }
                    continue;
                }
                const ridx = pickSpot(rallyStart[bi] ?? -1, rallyCount[bi] ?? 0, rallyX, rallyY, spotTaken);
                if (ridx >= 0) {
                    const x = rallyX[ridx];
                    const y = rallyY[ridx];
                    if (x !== undefined && y !== undefined) {
                        moveTo(u.id, x, y);
                    }
                }
            }
            continue;
        }
        if (u.carrying >= CARRY_LIMIT) {
            const bi = nearestBaseIndex(u.x, u.y, myBases);
            if (bi >= 0) {
                const base = myBases[bi];
                if (base !== undefined) {
                    if (cheb(u.x, u.y, base.x, base.y) <= 1) {
                        transfer(u.id);
                        continue;
                    }
                    const idx = pickSpot(deliveryStart[bi] ?? -1, deliveryCount[bi] ?? 0, deliveryX, deliveryY, spotTaken);
                    if (idx >= 0) {
                        const x = deliveryX[idx];
                        const y = deliveryY[idx];
                        if (x !== undefined && y !== undefined) {
                            moveTo(u.id, x, y);
                        }
                    }
                }
            }
            continue;
        }
        if (here !== undefined && here.owner !== me && here.progressOwner === me) {
            continue;
        }
        let capNi = -1;
        for (let j = 0; j < captureWorkerIds.length; j += 1) {
            const wid = captureWorkerIds[j];
            if (wid !== undefined && wid === u.id) {
                const ni = captureSiteIdx[j];
                if (ni !== undefined) {
                    capNi = ni;
                }
                break;
            }
        }
        if (capNi >= 0) {
            const s = neutralResources[capNi];
            if (s !== undefined && s.owner !== me) {
                if (u.x === s.x && u.y === s.y) {
                    continue;
                }
                if (unitByKey[s.x + "," + s.y] === undefined) {
                    moveTo(u.id, s.x, s.y);
                    continue;
                }
            }
        }
        const ri = nearestSiteIndex(u.x, u.y, myFreshResources);
        if (ri >= 0) {
            const s = myFreshResources[ri];
            if (s !== undefined) {
                if (u.x === s.x && u.y === s.y) {
                    const idx = pickSpot(harvestStart[ri] ?? -1, harvestCount[ri] ?? 0, harvestX, harvestY, spotTaken);
                    if (idx >= 0) {
                        const x = harvestX[idx];
                        const y = harvestY[idx];
                        if (x !== undefined && y !== undefined) {
                            moveTo(u.id, x, y);
                        }
                    }
                    continue;
                }
                if (cheb(u.x, u.y, s.x, s.y) <= 1) {
                    harvest(u.id, s.id);
                    continue;
                }
                const idx = pickSpot(harvestStart[ri] ?? -1, harvestCount[ri] ?? 0, harvestX, harvestY, spotTaken);
                if (idx >= 0) {
                    const x = harvestX[idx];
                    const y = harvestY[idx];
                    if (x !== undefined && y !== undefined) {
                        moveTo(u.id, x, y);
                    }
                    continue;
                }
            }
        }
        const bi = nearestBaseIndex(u.x, u.y, myBases);
        if (bi >= 0) {
            const base = myBases[bi];
            if (base !== undefined && cheb(u.x, u.y, base.x, base.y) > 2) {
                const idx = pickSpot(rallyStart[bi] ?? -1, rallyCount[bi] ?? 0, rallyX, rallyY, spotTaken);
                if (idx >= 0) {
                    const x = rallyX[idx];
                    const y = rallyY[idx];
                    if (x !== undefined && y !== undefined) {
                        moveTo(u.id, x, y);
                    }
                }
            }
        }
    }
    for (let i = 0; i < myUnits.length; i += 1) {
        const u = myUnits[i];
        if (u === undefined) {
            continue;
        }
        if (u.type === "worker") {
            continue;
        }
        const key = u.x + "," + u.y;
        const here = siteByKey[key];
        if (here !== undefined && here.kind === "base" && here.owner === me) {
            const bi = baseIndexById[here.id];
            if (bi !== undefined) {
                const idx = pickSpot(deliveryStart[bi] ?? -1, deliveryCount[bi] ?? 0, deliveryX, deliveryY, spotTaken);
                if (idx >= 0) {
                    const x = deliveryX[idx];
                    const y = deliveryY[idx];
                    if (x !== undefined && y !== undefined) {
                        moveTo(u.id, x, y);
                    }
                    continue;
                }
                const ridx = pickSpot(rallyStart[bi] ?? -1, rallyCount[bi] ?? 0, rallyX, rallyY, spotTaken);
                if (ridx >= 0) {
                    const x = rallyX[ridx];
                    const y = rallyY[ridx];
                    if (x !== undefined && y !== undefined) {
                        moveTo(u.id, x, y);
                    }
                }
            }
            continue;
        }
        const targetEnemy = nearestEnemyUnit(u.x, u.y, enemies);
        if (targetEnemy !== null) {
            const d = cheb(u.x, u.y, targetEnemy.x, targetEnemy.y);
            if (d <= unitRange(u)) {
                attack(u.id, targetEnemy.id);
                continue;
            }
        }
        if (here !== undefined && here.owner !== me && here.progressOwner === me) {
            continue;
        }
        if (targetEnemy !== null) {
            const d = cheb(u.x, u.y, targetEnemy.x, targetEnemy.y);
            if (d <= AGGRO_RANGE) {
                moveTo(u.id, targetEnemy.x, targetEnemy.y);
                continue;
            }
        }
        if (push) {
            let siteIdx = pushTargetIdx;
            if (siteIdx < 0) {
                siteIdx = nearestSiteIndex(u.x, u.y, capturableSites);
            }
            if (siteIdx >= 0) {
                const s = capturableSites[siteIdx];
                if (s !== undefined) {
                    if (u.x === s.x && u.y === s.y) {
                        continue;
                    }
                    const occ = unitByKey[s.x + "," + s.y];
                    if (occ !== undefined && occ.owner === me) {
                        // fall through to rally
                    }
                    else {
                        if (occ !== undefined && occ.owner !== me && cheb(u.x, u.y, occ.x, occ.y) <= unitRange(u)) {
                            attack(u.id, occ.id);
                            continue;
                        }
                        moveTo(u.id, s.x, s.y);
                        continue;
                    }
                }
            }
        }
        const bi = nearestBaseIndex(u.x, u.y, myBases);
        if (bi >= 0) {
            const base = myBases[bi];
            if (base !== undefined && cheb(u.x, u.y, base.x, base.y) > 2) {
                const idx = pickSpot(rallyStart[bi] ?? -1, rallyCount[bi] ?? 0, rallyX, rallyY, spotTaken);
                if (idx >= 0) {
                    const x = rallyX[idx];
                    const y = rallyY[idx];
                    if (x !== undefined && y !== undefined) {
                        moveTo(u.id, x, y);
                    }
                }
            }
        }
        else {
            const si = nearestSiteIndex(u.x, u.y, capturableSites);
            if (si >= 0) {
                const s = capturableSites[si];
                if (s !== undefined && !(u.x === s.x && u.y === s.y)) {
                    moveTo(u.id, s.x, s.y);
                }
            }
        }
    }
}
