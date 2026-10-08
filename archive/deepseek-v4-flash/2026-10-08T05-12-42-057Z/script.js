"use strict";
function loop() {
    const me = getMyIndex();
    const allPlayers = getObjectsByType("player");
    const myPlayer = allPlayers[me];
    if (myPlayer === undefined || !myPlayer.alive) {
        return;
    }
    const resources = myPlayer.resources;
    const allSites = getObjectsByType("site");
    const allUnits = getObjectsByType("unit");
    const myBases = [];
    const myResourceSites = [];
    const neutralResourceSites = [];
    for (let i = 0; i < allSites.length; i++) {
        const site = allSites[i];
        if (site === undefined)
            continue;
        if (site.kind === 'base') {
            if (site.owner === me) {
                myBases.push(site);
            }
        }
        else if (site.kind === 'resource') {
            if (site.owner === me) {
                myResourceSites.push(site);
            }
            else if (site.owner === -1) {
                neutralResourceSites.push(site);
            }
        }
    }
    const myWorkers = [];
    const myMelee = [];
    for (let i = 0; i < allUnits.length; i++) {
        const unit = allUnits[i];
        if (unit === undefined)
            continue;
        if (unit.owner === me) {
            if (unit.type === 'worker') {
                myWorkers.push(unit);
            }
            else if (unit.type === 'melee') {
                myMelee.push(unit);
            }
        }
    }
    for (let i = 0; i < myBases.length; i++) {
        const base = myBases[i];
        if (base === undefined)
            continue;
        if (base.producing !== null)
            continue;
        const workerCount = myWorkers.length;
        const targetWorkerCount = myResourceSites.length * 2;
        const goalWorkers = targetWorkerCount > 4 ? targetWorkerCount : 4;
        if (workerCount < 4 && resources >= 4) {
            spawnUnit(base.id, "worker");
        }
        else if (myMelee.length < 2 && resources >= 8) {
            spawnUnit(base.id, "melee");
        }
        else if (workerCount < goalWorkers && resources >= 4) {
            spawnUnit(base.id, "worker");
        }
        else if (resources >= 8) {
            spawnUnit(base.id, "melee");
        }
    }
    for (let i = 0; i < myWorkers.length; i++) {
        const worker = myWorkers[i];
        if (worker === undefined)
            continue;
        if (worker.carrying >= 20) {
            let bestBase = null;
            let bestDist = 9999;
            for (let j = 0; j < myBases.length; j++) {
                const base = myBases[j];
                if (base === undefined)
                    continue;
                const d = getRange(worker.x, worker.y, base.x, base.y);
                if (d < bestDist) {
                    bestDist = d;
                    bestBase = base;
                }
            }
            if (bestBase === null)
                continue;
            if (bestDist <= 1) {
                transfer(worker.id);
            }
            else {
                const target = findAdjacentPlain(bestBase.x, bestBase.y);
                if (target !== null) {
                    moveTo(worker.id, target.x, target.y);
                }
            }
        }
        else {
            let bestSite = null;
            let bestDist = 9999;
            for (let j = 0; j < myResourceSites.length; j++) {
                const site = myResourceSites[j];
                if (site === undefined)
                    continue;
                const d = getRange(worker.x, worker.y, site.x, site.y);
                if (d < bestDist) {
                    bestDist = d;
                    bestSite = site;
                }
            }
            if (bestSite === null)
                continue;
            if (bestDist <= 1) {
                harvest(worker.id, bestSite.id);
            }
            else {
                const target = findAdjacentPlain(bestSite.x, bestSite.y);
                if (target !== null) {
                    moveTo(worker.id, target.x, target.y);
                }
            }
        }
    }
    const takenSites = [];
    for (let i = 0; i < myMelee.length; i++) {
        const melee = myMelee[i];
        if (melee === undefined)
            continue;
        let onSite = false;
        for (let j = 0; j < neutralResourceSites.length; j++) {
            const site = neutralResourceSites[j];
            if (site === undefined)
                continue;
            if (melee.x === site.x && melee.y === site.y) {
                onSite = true;
                break;
            }
        }
        if (onSite)
            continue;
        let bestSite = null;
        let bestDist = 9999;
        for (let j = 0; j < neutralResourceSites.length; j++) {
            const site = neutralResourceSites[j];
            if (site === undefined)
                continue;
            let taken = false;
            for (let k = 0; k < takenSites.length; k++) {
                if (takenSites[k] === site.id) {
                    taken = true;
                    break;
                }
            }
            if (taken)
                continue;
            const d = getRange(melee.x, melee.y, site.x, site.y);
            if (d < bestDist) {
                bestDist = d;
                bestSite = site;
            }
        }
        if (bestSite !== null) {
            takenSites.push(bestSite.id);
            moveTo(melee.id, bestSite.x, bestSite.y);
        }
    }
}
function findAdjacentPlain(cx, cy) {
    if (getTerrainAt(cx + 1, cy) === 'plain') {
        return { x: cx + 1, y: cy };
    }
    if (getTerrainAt(cx - 1, cy) === 'plain') {
        return { x: cx - 1, y: cy };
    }
    if (getTerrainAt(cx, cy + 1) === 'plain') {
        return { x: cx, y: cy + 1 };
    }
    if (getTerrainAt(cx, cy - 1) === 'plain') {
        return { x: cx, y: cy - 1 };
    }
    if (getTerrainAt(cx + 1, cy + 1) === 'plain') {
        return { x: cx + 1, y: cy + 1 };
    }
    if (getTerrainAt(cx + 1, cy - 1) === 'plain') {
        return { x: cx + 1, y: cy - 1 };
    }
    if (getTerrainAt(cx - 1, cy + 1) === 'plain') {
        return { x: cx - 1, y: cy + 1 };
    }
    if (getTerrainAt(cx - 1, cy - 1) === 'plain') {
        return { x: cx - 1, y: cy - 1 };
    }
    return null;
}
