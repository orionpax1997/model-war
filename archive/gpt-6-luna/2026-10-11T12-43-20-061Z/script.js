"use strict";
function chebyshevDistance(ax, ay, bx, by) {
    const dx = ax >= bx ? ax - bx : bx - ax;
    const dy = ay >= by ? ay - by : by - ay;
    return dx >= dy ? dx : dy;
}
function loop() {
    const me = getMyIndex();
    const allUnits = getObjectsByType("unit");
    const allSites = getObjectsByType("site");
    const mine = [];
    const foes = [];
    for (let i = 0; i < allUnits.length; i += 1) {
        const unit = allUnits[i];
        if (unit === undefined) {
            continue;
        }
        if (unit.owner === me) {
            mine.push(unit);
        }
        else {
            foes.push(unit);
        }
    }
    const ownBases = [];
    const ownResources = [];
    const objectives = [];
    for (let i = 0; i < allSites.length; i += 1) {
        const site = allSites[i];
        if (site === undefined) {
            continue;
        }
        if (site.kind === "base" && site.owner === me) {
            ownBases.push(site);
        }
        if (site.kind === "resource" && site.owner === me) {
            ownResources.push(site);
        }
        if (site.owner !== me) {
            objectives.push(site);
        }
    }
    mine.sort((a, b) => a.id - b.id);
    foes.sort((a, b) => a.id - b.id);
    ownBases.sort((a, b) => a.id - b.id);
    ownResources.sort((a, b) => a.id - b.id);
    objectives.sort((a, b) => a.id - b.id);
    let workerCount = 0;
    const army = [];
    for (let i = 0; i < mine.length; i += 1) {
        const unit = mine[i];
        if (unit === undefined) {
            continue;
        }
        if (unit.type === "worker") {
            workerCount += 1;
        }
        else {
            army.push(unit);
        }
    }
    const players = getObjectsByType("player");
    const player = players[me];
    let resources = player === undefined ? 0 : player.resources;
    for (let i = 0; i < ownBases.length; i += 1) {
        const base = ownBases[i];
        if (base === undefined || base.producing !== null) {
            continue;
        }
        if (workerCount < 4 && resources >= 4) {
            spawnUnit(base.id, "worker");
            resources -= 4;
            workerCount += 1;
        }
        else if (resources >= 8) {
            spawnUnit(base.id, "melee");
            resources -= 8;
        }
    }
    let workerIndex = 0;
    for (let i = 0; i < mine.length; i += 1) {
        const unit = mine[i];
        if (unit === undefined || unit.type !== "worker") {
            continue;
        }
        if (unit.carrying > 0) {
            let bestBase = -1;
            let bestDistance = 0;
            for (let j = 0; j < ownBases.length; j += 1) {
                const base = ownBases[j];
                if (base === undefined) {
                    continue;
                }
                const distance = chebyshevDistance(unit.x, unit.y, base.x, base.y);
                if (bestBase === -1 || distance < bestDistance) {
                    bestBase = j;
                    bestDistance = distance;
                }
            }
            const base = bestBase < 0 ? undefined : ownBases[bestBase];
            if (base !== undefined) {
                if (bestDistance > 1) {
                    moveTo(unit.id, base.x, base.y);
                }
                else if (bestDistance === 1) {
                    transfer(unit.id);
                }
            }
            continue;
        }
        if (ownResources.length === 0) {
            continue;
        }
        const start = workerIndex % ownResources.length;
        workerIndex += 1;
        let target;
        for (let offset = 0; offset < ownResources.length; offset += 1) {
            const candidate = ownResources[(start + offset) % ownResources.length];
            if (candidate !== undefined &&
                candidate.remaining !== undefined &&
                candidate.remaining > 0) {
                target = candidate;
                break;
            }
        }
        if (target === undefined) {
            continue;
        }
        const distance = chebyshevDistance(unit.x, unit.y, target.x, target.y);
        if (distance === 1) {
            harvest(unit.id, target.id);
        }
        else if (distance > 1) {
            moveTo(unit.id, target.x, target.y);
        }
    }
    for (let i = 0; i < army.length; i += 1) {
        const unit = army[i];
        if (unit === undefined) {
            continue;
        }
        let nearestEnemy;
        let nearestDistance = 0;
        let nearestScore = 0;
        for (let j = 0; j < foes.length; j += 1) {
            const enemy = foes[j];
            if (enemy === undefined) {
                continue;
            }
            const distance = chebyshevDistance(unit.x, unit.y, enemy.x, enemy.y);
            const score = distance * 10 + (enemy.type === "worker" ? 0 : 1);
            if (nearestEnemy === undefined || score < nearestScore) {
                nearestEnemy = enemy;
                nearestDistance = distance;
                nearestScore = score;
            }
        }
        const attackRange = unit.type === "ranged" ? 2 : 1;
        if (nearestEnemy !== undefined && nearestDistance <= attackRange) {
            attack(unit.id, nearestEnemy.id);
            continue;
        }
        const pursuitRange = unit.type === "ranged" ? 4 : 3;
        if (nearestEnemy !== undefined && nearestDistance <= pursuitRange) {
            moveTo(unit.id, nearestEnemy.x, nearestEnemy.y);
            continue;
        }
        if (objectives.length > 0) {
            const objectiveIndex = (i + (unit.id % objectives.length)) % objectives.length;
            const objective = objectives[objectiveIndex];
            if (objective !== undefined && (unit.x !== objective.x || unit.y !== objective.y)) {
                moveTo(unit.id, objective.x, objective.y);
            }
            continue;
        }
        if (nearestEnemy !== undefined && (unit.x !== nearestEnemy.x || unit.y !== nearestEnemy.y)) {
            moveTo(unit.id, nearestEnemy.x, nearestEnemy.y);
        }
    }
}
