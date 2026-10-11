"use strict";
var targetSiteId = -1;
var capturerUnitId = -1;
function loop() {
    const me = getMyIndex();
    const playerRows = getObjectsByType("player");
    const self = playerRows[me];
    if (self === undefined) {
        return;
    }
    if (self.alive === false) {
        return;
    }
    let resources = self.resources;
    const units = getObjectsByType("unit", { owner: me });
    const bases = getObjectsByType("site", { owner: me, kind: "base" });
    const ownedRes = getObjectsByType("site", { owner: me, kind: "resource" });
    const neutralRes = getObjectsByType("site", { owner: -1, kind: "resource" });
    const allUnits = getObjectsByType("unit");
    let workerCount = 0;
    let soldierCount = 0;
    for (let i = 0; i < units.length; i += 1) {
        const u = units[i];
        if (u === undefined) {
            continue;
        }
        if (u.type === "worker") {
            workerCount += 1;
        }
        else {
            soldierCount += 1;
        }
    }
    for (let i = 0; i < bases.length; i += 1) {
        const b = bases[i];
        if (b === undefined) {
            continue;
        }
        if (b.producing !== null) {
            continue;
        }
        if (workerCount < 6 && resources >= 4) {
            const r = spawnUnit(b.id, "worker");
            if (!isError(r)) {
                workerCount += 1;
                resources -= 4;
            }
            continue;
        }
        if (resources >= 8) {
            const r = spawnUnit(b.id, "melee");
            if (!isError(r)) {
                soldierCount += 1;
                resources -= 8;
            }
        }
    }
    if (capturerUnitId >= 0) {
        let seen = false;
        for (let i = 0; i < units.length; i += 1) {
            const u = units[i];
            if (u === undefined) {
                continue;
            }
            if (u.id === capturerUnitId) {
                seen = true;
                break;
            }
        }
        if (!seen) {
            capturerUnitId = -1;
            targetSiteId = -1;
        }
    }
    if (targetSiteId >= 0) {
        let seen = false;
        for (let i = 0; i < neutralRes.length; i += 1) {
            const s = neutralRes[i];
            if (s === undefined) {
                continue;
            }
            if (s.id === targetSiteId) {
                seen = true;
                break;
            }
        }
        if (!seen) {
            capturerUnitId = -1;
            targetSiteId = -1;
        }
    }
    if (targetSiteId < 0 && neutralRes.length > 0 && soldierCount > 0) {
        const baseRow = bases[0];
        if (baseRow !== undefined) {
            let bestSiteId = -1;
            let bestSiteX = 0;
            let bestSiteY = 0;
            let bestSiteDist = 999999;
            for (let i = 0; i < neutralRes.length; i += 1) {
                const s = neutralRes[i];
                if (s === undefined) {
                    continue;
                }
                const d = getRange(baseRow.x, baseRow.y, s.x, s.y);
                if (d < bestSiteDist) {
                    bestSiteDist = d;
                    bestSiteId = s.id;
                    bestSiteX = s.x;
                    bestSiteY = s.y;
                }
            }
            if (bestSiteId >= 0) {
                let bestUnitId = -1;
                let bestUnitDist = 999999;
                for (let i = 0; i < units.length; i += 1) {
                    const u = units[i];
                    if (u === undefined) {
                        continue;
                    }
                    if (u.type === "worker") {
                        continue;
                    }
                    const d = getRange(u.x, u.y, bestSiteX, bestSiteY);
                    if (d < bestUnitDist) {
                        bestUnitDist = d;
                        bestUnitId = u.id;
                    }
                }
                if (bestUnitId >= 0) {
                    targetSiteId = bestSiteId;
                    capturerUnitId = bestUnitId;
                }
            }
        }
    }
    for (let i = 0; i < units.length; i += 1) {
        const u = units[i];
        if (u === undefined) {
            continue;
        }
        if (u.type === "worker") {
            if (u.carrying > 0) {
                let adjBaseId = -1;
                for (let j = 0; j < bases.length; j += 1) {
                    const b = bases[j];
                    if (b === undefined) {
                        continue;
                    }
                    const d = getRange(u.x, u.y, b.x, b.y);
                    if (d <= 1) {
                        adjBaseId = b.id;
                        break;
                    }
                }
                if (adjBaseId >= 0) {
                    transfer(u.id);
                }
                else {
                    let nearX = -1;
                    let nearY = -1;
                    let nearDist = 999999;
                    for (let j = 0; j < bases.length; j += 1) {
                        const b = bases[j];
                        if (b === undefined) {
                            continue;
                        }
                        const d = getRange(u.x, u.y, b.x, b.y);
                        if (d < nearDist) {
                            nearDist = d;
                            nearX = b.x;
                            nearY = b.y;
                        }
                    }
                    if (nearX >= 0) {
                        moveTo(u.id, nearX, nearY);
                    }
                }
            }
            else {
                let adjResId = -1;
                for (let j = 0; j < ownedRes.length; j += 1) {
                    const s = ownedRes[j];
                    if (s === undefined) {
                        continue;
                    }
                    const d = getRange(u.x, u.y, s.x, s.y);
                    if (d <= 1) {
                        adjResId = s.id;
                        break;
                    }
                }
                if (adjResId >= 0) {
                    harvest(u.id, adjResId);
                }
                else {
                    let nearX = -1;
                    let nearY = -1;
                    let nearDist = 999999;
                    for (let j = 0; j < ownedRes.length; j += 1) {
                        const s = ownedRes[j];
                        if (s === undefined) {
                            continue;
                        }
                        const d = getRange(u.x, u.y, s.x, s.y);
                        if (d < nearDist) {
                            nearDist = d;
                            nearX = s.x;
                            nearY = s.y;
                        }
                    }
                    if (nearX >= 0) {
                        moveTo(u.id, nearX, nearY);
                    }
                }
            }
            continue;
        }
        let acted = false;
        let myRange = 1;
        if (u.type === "ranged") {
            myRange = 2;
        }
        let bestFoeId = -1;
        let bestFoeDist = 999999;
        for (let j = 0; j < allUnits.length; j += 1) {
            const e = allUnits[j];
            if (e === undefined) {
                continue;
            }
            if (e.owner === me) {
                continue;
            }
            const d = getRange(u.x, u.y, e.x, e.y);
            if (d <= myRange && d < bestFoeDist) {
                bestFoeDist = d;
                bestFoeId = e.id;
            }
        }
        if (bestFoeId >= 0) {
            const r = attack(u.id, bestFoeId);
            if (!isError(r)) {
                acted = true;
            }
        }
        if (!acted && u.id === capturerUnitId && targetSiteId >= 0) {
            let sX = -1;
            let sY = -1;
            for (let j = 0; j < neutralRes.length; j += 1) {
                const s = neutralRes[j];
                if (s === undefined) {
                    continue;
                }
                if (s.id === targetSiteId) {
                    sX = s.x;
                    sY = s.y;
                    break;
                }
            }
            if (sX >= 0 && sY >= 0) {
                if (u.x !== sX || u.y !== sY) {
                    const r = moveTo(u.id, sX, sY);
                    if (!isError(r)) {
                        acted = true;
                    }
                }
                else {
                    acted = true;
                }
            }
        }
        if (!acted) {
            let defX = -1;
            let defY = -1;
            let defDist = 999999;
            for (let j = 0; j < ownedRes.length; j += 1) {
                const s = ownedRes[j];
                if (s === undefined) {
                    continue;
                }
                const d = getRange(u.x, u.y, s.x, s.y);
                if (d < defDist) {
                    defDist = d;
                    defX = s.x;
                    defY = s.y;
                }
            }
            if (defX >= 0) {
                if (defDist > 1) {
                    moveTo(u.id, defX, defY);
                }
            }
            else {
                const b = bases[0];
                if (b !== undefined) {
                    if (getRange(u.x, u.y, b.x, b.y) > 1) {
                        moveTo(u.id, b.x, b.y);
                    }
                }
            }
        }
    }
}
