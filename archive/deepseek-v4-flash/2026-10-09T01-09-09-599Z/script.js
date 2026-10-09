"use strict";
function dist(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return Math.max(Math.abs(dx), Math.abs(dy));
}
function isAdjacent(ax, ay, bx, by) {
    return dist(ax, ay, bx, by) === 1;
}
function offsetX(idx) {
    if (idx === 0) {
        return 0;
    }
    if (idx === 1) {
        return 1;
    }
    if (idx === 2) {
        return 0;
    }
    return -1;
}
function offsetY(idx) {
    if (idx === 0) {
        return -1;
    }
    if (idx === 1) {
        return 0;
    }
    if (idx === 2) {
        return 1;
    }
    return 0;
}
function adjacentCell(unit, site, tick) {
    const start = (unit.id + tick) % 4;
    for (let i = 0; i < 4; i += 1) {
        const idx = (start + i) % 4;
        const tx = site.x + offsetX(idx);
        const ty = site.y + offsetY(idx);
        if (getTerrainAt(tx, ty) === "plain") {
            return { x: tx, y: ty };
        }
    }
    return { x: site.x + offsetX(start), y: site.y + offsetY(start) };
}
function isClaimed(id, claimedIds) {
    for (let i = 0; i < claimedIds.length; i += 1) {
        if (claimedIds[i] === id) {
            return true;
        }
    }
    return false;
}
function findNearestResource(unit, sites) {
    let best = null;
    let bestD = 0;
    for (let i = 0; i < sites.length; i += 1) {
        const s = sites[i];
        if (s === undefined) {
            continue;
        }
        if (s.kind !== "resource") {
            continue;
        }
        if (s.remaining !== undefined && s.remaining <= 0) {
            continue;
        }
        const d = dist(unit.x, unit.y, s.x, s.y);
        if (best === null || d < bestD) {
            best = s;
            bestD = d;
        }
    }
    return best;
}
function findNearestBase(unit, bases) {
    let best = null;
    let bestD = 0;
    for (let i = 0; i < bases.length; i += 1) {
        const s = bases[i];
        if (s === undefined) {
            continue;
        }
        const d = dist(unit.x, unit.y, s.x, s.y);
        if (best === null || d < bestD) {
            best = s;
            bestD = d;
        }
    }
    return best;
}
function findNearestUnclaimedSite(unit, sites, claimedIds) {
    let best = null;
    let bestD = 0;
    for (let i = 0; i < sites.length; i += 1) {
        const s = sites[i];
        if (s === undefined) {
            continue;
        }
        if (isClaimed(s.id, claimedIds)) {
            continue;
        }
        const d = dist(unit.x, unit.y, s.x, s.y);
        if (best === null || d < bestD) {
            best = s;
            bestD = d;
        }
    }
    return best;
}
function findAdjacentEnemy(unit, enemies) {
    for (let i = 0; i < enemies.length; i += 1) {
        const e = enemies[i];
        if (e === undefined) {
            continue;
        }
        if (dist(unit.x, unit.y, e.x, e.y) === 1) {
            return e;
        }
    }
    return null;
}
function findEnemyAtSite(site, enemies) {
    for (let i = 0; i < enemies.length; i += 1) {
        const e = enemies[i];
        if (e === undefined) {
            continue;
        }
        if (e.x === site.x && e.y === site.y) {
            return e;
        }
    }
    return null;
}
function findNearestEnemy(unit, enemies) {
    let best = null;
    let bestD = 0;
    for (let i = 0; i < enemies.length; i += 1) {
        const e = enemies[i];
        if (e === undefined) {
            continue;
        }
        const d = dist(unit.x, unit.y, e.x, e.y);
        if (best === null || d < bestD) {
            best = e;
            bestD = d;
        }
    }
    return best;
}
function threatens(enemy, myBases, myUnits) {
    for (let i = 0; i < myBases.length; i += 1) {
        const b = myBases[i];
        if (b === undefined) {
            continue;
        }
        if (dist(enemy.x, enemy.y, b.x, b.y) <= 4) {
            return true;
        }
    }
    for (let i = 0; i < myUnits.length; i += 1) {
        const u = myUnits[i];
        if (u === undefined) {
            continue;
        }
        if (u.type === "worker" && dist(enemy.x, enemy.y, u.x, u.y) <= 2) {
            return true;
        }
    }
    return false;
}
function findNearestThreateningEnemy(unit, enemies, myBases, myUnits) {
    let best = null;
    let bestD = 0;
    for (let i = 0; i < enemies.length; i += 1) {
        const e = enemies[i];
        if (e === undefined) {
            continue;
        }
        if (!threatens(e, myBases, myUnits)) {
            continue;
        }
        const d = dist(unit.x, unit.y, e.x, e.y);
        if (best === null || d < bestD) {
            best = e;
            bestD = d;
        }
    }
    return best;
}
function loop() {
    const me = getMyIndex();
    const tick = getTick();
    const players = getObjectsByType("player");
    const mine = players[me];
    if (mine === undefined) {
        return;
    }
    if (mine.alive === false) {
        return;
    }
    const allUnits = getObjectsByType("unit");
    const allSites = getObjectsByType("site");
    const myUnits = [];
    const enemyUnits = [];
    for (let i = 0; i < allUnits.length; i += 1) {
        const u = allUnits[i];
        if (u === undefined) {
            continue;
        }
        if (u.owner === me) {
            myUnits.push(u);
        }
        else {
            enemyUnits.push(u);
        }
    }
    const myBases = [];
    const myResourceSites = [];
    const neutralSites = [];
    const enemySites = [];
    for (let i = 0; i < allSites.length; i += 1) {
        const s = allSites[i];
        if (s === undefined) {
            continue;
        }
        if (s.owner === me) {
            if (s.kind === "base") {
                myBases.push(s);
            }
            else if (s.kind === "resource") {
                myResourceSites.push(s);
            }
        }
        else if (s.owner === -1) {
            neutralSites.push(s);
        }
        else if (s.owner >= 0 && s.owner !== me) {
            enemySites.push(s);
        }
    }
    let workerCount = 0;
    let militaryCount = 0;
    for (let i = 0; i < myUnits.length; i += 1) {
        const u = myUnits[i];
        if (u === undefined) {
            continue;
        }
        if (u.type === "worker") {
            workerCount += 1;
        }
        else {
            militaryCount += 1;
        }
    }
    let budget = mine.resources;
    const targetWorkers = Math.max(4, Math.min(8, myResourceSites.length * 2 + 2));
    let plannedWorkers = 0;
    let plannedMelee = 0;
    for (let i = 0; i < myBases.length; i += 1) {
        const base = myBases[i];
        if (base === undefined) {
            continue;
        }
        if (base.producing !== null) {
            continue;
        }
        const plannedWorkerTotal = workerCount + plannedWorkers;
        const plannedMeleeTotal = militaryCount + plannedMelee;
        let wantType = null;
        if (plannedMeleeTotal === 0 && plannedWorkerTotal >= 4 && budget >= 8) {
            wantType = "melee";
        }
        else if (plannedWorkerTotal < targetWorkers) {
            if (budget >= 4) {
                wantType = "worker";
            }
        }
        else {
            if (budget >= 8) {
                wantType = "melee";
            }
        }
        if (wantType !== null) {
            const result = spawnUnit(base.id, wantType);
            if (!isError(result)) {
                if (wantType === "worker") {
                    budget -= 4;
                    plannedWorkers += 1;
                }
                else {
                    budget -= 8;
                    plannedMelee += 1;
                }
            }
        }
    }
    const captureTargets = [];
    for (let i = 0; i < neutralSites.length; i += 1) {
        const s = neutralSites[i];
        if (s === undefined) {
            continue;
        }
        if (s.kind === "resource") {
            captureTargets.push(s);
        }
    }
    for (let i = 0; i < neutralSites.length; i += 1) {
        const s = neutralSites[i];
        if (s === undefined) {
            continue;
        }
        if (s.kind === "base") {
            captureTargets.push(s);
        }
    }
    const aggressive = tick > 180 || militaryCount >= 8 || neutralSites.length === 0;
    if (aggressive) {
        for (let i = 0; i < enemySites.length; i += 1) {
            const s = enemySites[i];
            if (s !== undefined) {
                captureTargets.push(s);
            }
        }
    }
    const claimedSiteIds = [];
    for (let i = 0; i < myUnits.length; i += 1) {
        const unit = myUnits[i];
        if (unit === undefined) {
            continue;
        }
        let onOwnBase = false;
        for (let b = 0; b < myBases.length; b += 1) {
            const base = myBases[b];
            if (base === undefined) {
                continue;
            }
            if (unit.x === base.x && unit.y === base.y) {
                const target = adjacentCell(unit, base, tick);
                moveTo(unit.id, target.x, target.y);
                onOwnBase = true;
                break;
            }
        }
        if (onOwnBase) {
            continue;
        }
        if (unit.type === "worker") {
            const resource = findNearestResource(unit, myResourceSites);
            if (unit.carrying >= 20 || (unit.carrying > 0 && resource === null)) {
                const base = findNearestBase(unit, myBases);
                if (base !== null) {
                    if (isAdjacent(unit.x, unit.y, base.x, base.y)) {
                        transfer(unit.id);
                    }
                    else {
                        const target = adjacentCell(unit, base, tick);
                        moveTo(unit.id, target.x, target.y);
                    }
                }
                continue;
            }
            if (resource !== null) {
                if (isAdjacent(unit.x, unit.y, resource.x, resource.y)) {
                    harvest(unit.id, resource.id);
                }
                else {
                    const target = adjacentCell(unit, resource, tick);
                    moveTo(unit.id, target.x, target.y);
                }
                continue;
            }
            if (unit.carrying === 0) {
                const targetSite = findNearestUnclaimedSite(unit, captureTargets, claimedSiteIds);
                if (targetSite !== null) {
                    claimedSiteIds.push(targetSite.id);
                    if (unit.x === targetSite.x && unit.y === targetSite.y) {
                        continue;
                    }
                    moveTo(unit.id, targetSite.x, targetSite.y);
                }
            }
            continue;
        }
        let onCaptureSite = false;
        for (let s = 0; s < captureTargets.length; s += 1) {
            const site = captureTargets[s];
            if (site === undefined) {
                continue;
            }
            if (unit.x === site.x && unit.y === site.y && site.owner !== me) {
                claimedSiteIds.push(site.id);
                onCaptureSite = true;
                break;
            }
        }
        const adjacentEnemy = findAdjacentEnemy(unit, enemyUnits);
        if (adjacentEnemy !== null) {
            attack(unit.id, adjacentEnemy.id);
            continue;
        }
        const threatEnemy = findNearestThreateningEnemy(unit, enemyUnits, myBases, myUnits);
        if (threatEnemy !== null) {
            if (isAdjacent(unit.x, unit.y, threatEnemy.x, threatEnemy.y)) {
                attack(unit.id, threatEnemy.id);
            }
            else {
                moveTo(unit.id, threatEnemy.x, threatEnemy.y);
            }
            continue;
        }
        if (onCaptureSite) {
            continue;
        }
        const targetSite = findNearestUnclaimedSite(unit, captureTargets, claimedSiteIds);
        if (targetSite !== null) {
            claimedSiteIds.push(targetSite.id);
            const enemyOnSite = findEnemyAtSite(targetSite, enemyUnits);
            if (enemyOnSite !== null) {
                if (isAdjacent(unit.x, unit.y, enemyOnSite.x, enemyOnSite.y)) {
                    attack(unit.id, enemyOnSite.id);
                }
                else {
                    moveTo(unit.id, enemyOnSite.x, enemyOnSite.y);
                }
            }
            else {
                if (unit.x === targetSite.x && unit.y === targetSite.y) {
                    continue;
                }
                moveTo(unit.id, targetSite.x, targetSite.y);
            }
            continue;
        }
        if (aggressive) {
            const enemy = findNearestEnemy(unit, enemyUnits);
            if (enemy !== null) {
                if (isAdjacent(unit.x, unit.y, enemy.x, enemy.y)) {
                    attack(unit.id, enemy.id);
                }
                else {
                    moveTo(unit.id, enemy.x, enemy.y);
                }
            }
        }
    }
}
