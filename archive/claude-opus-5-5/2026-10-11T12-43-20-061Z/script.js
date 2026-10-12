"use strict";
var myIndex = -1;
var tick = 0;
var mainBaseId = -1;
var firstMineId = -1;
var workerIds = [];
var combatUnitIds = [];
function loop() {
    tick = getTick();
    if (myIndex === -1) {
        myIndex = getMyIndex();
    }
    if (tick === 0) {
        initializeState();
    }
    const players = getObjectsByType("player");
    const me = players[myIndex];
    if (me === undefined || !me.alive) {
        return;
    }
    manageProduction(me.resources);
    manageWorkers();
    manageCombatUnits();
}
function initializeState() {
    const myBases = getObjectsByType("site", { owner: myIndex, kind: "base" });
    if (myBases.length > 0 && myBases[0] !== undefined) {
        mainBaseId = myBases[0].id;
    }
    const myResources = getObjectsByType("site", { owner: myIndex, kind: "resource" });
    if (myResources.length > 0 && myResources[0] !== undefined) {
        firstMineId = myResources[0].id;
    }
    const myUnits = getObjectsByType("unit", { owner: myIndex });
    for (let i = 0; i < myUnits.length; i += 1) {
        const unit = myUnits[i];
        if (unit === undefined) {
            continue;
        }
        if (unit.type === "worker") {
            workerIds.push(unit.id);
        }
    }
}
function manageProduction(resources) {
    const myBases = getObjectsByType("site", { owner: myIndex, kind: "base" });
    for (let i = 0; i < myBases.length; i += 1) {
        const base = myBases[i];
        if (base === undefined || base.producing !== null) {
            continue;
        }
        if (workerIds.length < 4 && resources >= 4) {
            const result = spawnUnit(base.id, "worker");
            if (!isError(result)) {
                resources = resources - 4;
            }
        }
        else if (resources >= 8) {
            const result = spawnUnit(base.id, "melee");
            if (!isError(result)) {
                resources = resources - 8;
            }
        }
    }
}
function manageWorkers() {
    const updatedWorkerIds = [];
    for (let i = 0; i < workerIds.length; i += 1) {
        const workerId = workerIds[i];
        if (workerId === undefined) {
            continue;
        }
        const obj = getObjectById(workerId);
        if (obj === null) {
            continue;
        }
        const worker = obj;
        if (worker.type !== "worker") {
            continue;
        }
        updatedWorkerIds.push(workerId);
        if (worker.carrying >= 20) {
            const bases = getObjectsByType("site", { owner: myIndex, kind: "base" });
            let closestBase = null;
            let closestDist = 0;
            for (let j = 0; j < bases.length; j += 1) {
                const base = bases[j];
                if (base === undefined) {
                    continue;
                }
                const dist = getRange(worker.x, worker.y, base.x, base.y);
                if (closestBase === null || dist < closestDist) {
                    closestBase = base;
                    closestDist = dist;
                }
            }
            if (closestBase !== null) {
                if (closestDist <= 1) {
                    transfer(workerId);
                }
                else {
                    moveTo(workerId, closestBase.x, closestBase.y);
                }
            }
        }
        else {
            const myMines = getObjectsByType("site", { owner: myIndex, kind: "resource" });
            let targetMine = null;
            let closestDist = 0;
            for (let j = 0; j < myMines.length; j += 1) {
                const mine = myMines[j];
                if (mine === undefined || mine.remaining === 0) {
                    continue;
                }
                const dist = getRange(worker.x, worker.y, mine.x, mine.y);
                if (targetMine === null || dist < closestDist) {
                    targetMine = mine;
                    closestDist = dist;
                }
            }
            if (targetMine !== null) {
                if (closestDist <= 1) {
                    harvest(workerId, targetMine.id);
                }
                else {
                    moveTo(workerId, targetMine.x, targetMine.y);
                }
            }
        }
    }
    workerIds = updatedWorkerIds;
}
function manageCombatUnits() {
    const myCombatUnits = getObjectsByType("unit", { owner: myIndex });
    const updatedCombatIds = [];
    for (let i = 0; i < myCombatUnits.length; i += 1) {
        const unit = myCombatUnits[i];
        if (unit === undefined || unit.type === "worker") {
            continue;
        }
        updatedCombatIds.push(unit.id);
        const neutralSites = getObjectsByType("site", { owner: -1 });
        let targetSite = null;
        let closestDist = 0;
        for (let j = 0; j < neutralSites.length; j += 1) {
            const site = neutralSites[j];
            if (site === undefined) {
                continue;
            }
            const dist = getRange(unit.x, unit.y, site.x, site.y);
            if (targetSite === null || dist < closestDist) {
                targetSite = site;
                closestDist = dist;
            }
        }
        const enemyUnits = getObjectsByType("unit");
        let nearestEnemy = null;
        let nearestDist = 0;
        for (let j = 0; j < enemyUnits.length; j += 1) {
            const enemy = enemyUnits[j];
            if (enemy === undefined || enemy.owner === myIndex) {
                continue;
            }
            const dist = getRange(unit.x, unit.y, enemy.x, enemy.y);
            if (nearestEnemy === null || dist < nearestDist) {
                nearestEnemy = enemy;
                nearestDist = dist;
            }
        }
        if (nearestEnemy !== null && nearestDist <= 3) {
            const range = unit.type === "ranged" ? 2 : 1;
            if (nearestDist <= range) {
                attack(unit.id, nearestEnemy.id);
            }
            else {
                moveTo(unit.id, nearestEnemy.x, nearestEnemy.y);
            }
        }
        else if (targetSite !== null) {
            moveTo(unit.id, targetSite.x, targetSite.y);
        }
    }
    combatUnitIds = updatedCombatIds;
}
