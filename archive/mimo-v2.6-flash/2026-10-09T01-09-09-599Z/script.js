"use strict";
var myIndex = -1;
var alarmTicks = 0;
const WORKER_COST = 4;
const MELEE_COST = 8;
const RANGED_COST = 12;
const CARRY_LIMIT = 20;
const MIL_CAP = 18;
const TOTAL_CAP = 30;
const WORKER_HARD_CAP = 12;
const CELL_SHIFT = 3;
const GRID_BASE = 256;
const GRID_STRIDE = 1024;
const FLEE_RADIUS = 2;
const HOME_THREAT_RADIUS = 2;
const DEF_CHASE_RADIUS = 5;
const EXPAND_CHASE_RADIUS = 2;
const PEACEFUL_UNTIL = 120;
function dist(ax, ay, bx, by) {
    let dx = ax - bx;
    if (dx < 0) {
        dx = -dx;
    }
    let dy = ay - by;
    if (dy < 0) {
        dy = -dy;
    }
    return dx > dy ? dx : dy;
}
function nearestIdx(ax, ay, arr) {
    let best = -1;
    let bestD = 0;
    for (let i = 0; i < arr.length; i += 1) {
        const s = arr[i];
        if (s === undefined) {
            continue;
        }
        const d = dist(ax, ay, s.x, s.y);
        if (best < 0 || d < bestD) {
            best = i;
            bestD = d;
        }
    }
    return best;
}
function hasCombatNear(u, grid, radius) {
    const cx = (u.x >> CELL_SHIFT) + GRID_BASE;
    const cy = (u.y >> CELL_SHIFT) + GRID_BASE;
    for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
            const cell = grid[(cx + ox) * GRID_STRIDE + (cy + oy)];
            if (cell === undefined) {
                continue;
            }
            for (let j = 0; j < cell.length; j += 1) {
                const e = cell[j];
                if (e === undefined) {
                    continue;
                }
                if (e.type === "worker") {
                    continue;
                }
                if (dist(u.x, u.y, e.x, e.y) <= radius) {
                    return true;
                }
            }
        }
    }
    return false;
}
function onOpenSite(u, groups) {
    for (let g = 0; g < groups.length; g += 1) {
        const arr = groups[g];
        if (arr === undefined) {
            continue;
        }
        for (let i = 0; i < arr.length; i += 1) {
            const s = arr[i];
            if (s === undefined) {
                continue;
            }
            if (s.x === u.x && s.y === u.y) {
                return true;
            }
        }
    }
    return false;
}
function pickCapture(ax, ay, groups) {
    for (let g = 0; g < groups.length; g += 1) {
        const arr = groups[g];
        if (arr === undefined) {
            continue;
        }
        if (arr.length === 0) {
            continue;
        }
        const idx = nearestIdx(ax, ay, arr);
        if (idx >= 0) {
            const s = arr[idx];
            if (s !== undefined) {
                return s;
            }
        }
    }
    return null;
}
function pushGroup(dst, src) {
    if (src.length > 0) {
        dst.push(src);
    }
}
function loop() {
    const tick = getTick();
    if (myIndex < 0) {
        myIndex = getMyIndex();
    }
    const me = myIndex;
    const players = getObjectsByType("player");
    let money = 0;
    let selfOk = false;
    for (let i = 0; i < players.length; i += 1) {
        const p = players[i];
        if (p === undefined) {
            continue;
        }
        if (p.index === me) {
            money = p.resources;
            selfOk = true;
            break;
        }
    }
    if (!selfOk) {
        return;
    }
    const allSites = getObjectsByType("site");
    const allUnits = getObjectsByType("unit");
    // ---- 点位分组 ----
    const myOwned = allSites.filter((s) => s.owner === me);
    const myBases = allSites.filter((s) => s.owner === me && s.kind === "base");
    const myMines = allSites.filter((s) => s.owner === me && s.kind === "resource" && s.remaining !== undefined && s.remaining > 0);
    const guardList = myOwned.filter((s) => s.kind === "resource");
    const openSites = allSites.filter((s) => s.owner !== me);
    const nMine = openSites.filter((s) => s.owner === -1 && s.kind === "resource" && s.remaining !== undefined && s.remaining > 0);
    const eMine = openSites.filter((s) => s.owner !== -1 && s.kind === "resource" && s.remaining !== undefined && s.remaining > 0);
    const nBase = openSites.filter((s) => s.owner === -1 && s.kind === "base");
    const eBase = openSites.filter((s) => s.owner !== -1 && s.kind === "base");
    const junk = openSites.filter((s) => s.kind === "resource" && (s.remaining === undefined || s.remaining <= 0));
    const capGroups = [];
    if (myBases.length === 0) {
        pushGroup(capGroups, nBase);
        pushGroup(capGroups, eBase);
        pushGroup(capGroups, nMine);
        pushGroup(capGroups, eMine);
        pushGroup(capGroups, junk);
    }
    else if (tick < PEACEFUL_UNTIL && (nMine.length > 0 || nBase.length > 0)) {
        pushGroup(capGroups, nMine);
        pushGroup(capGroups, nBase);
    }
    else {
        pushGroup(capGroups, nMine);
        pushGroup(capGroups, eMine);
        pushGroup(capGroups, nBase);
        pushGroup(capGroups, eBase);
        pushGroup(capGroups, junk);
    }
    // ---- 单位分组 ----
    const myUnits = allUnits.filter((u) => u.owner === me);
    const enemies = allUnits.filter((u) => u.owner !== me);
    const myWorkers = myUnits.filter((u) => u.type === "worker");
    const myMil = myUnits.filter((u) => u.type !== "worker");
    let meleeCount = 0;
    let rangedCount = 0;
    for (let i = 0; i < myMil.length; i += 1) {
        const u = myMil[i];
        if (u === undefined) {
            continue;
        }
        if (u.type === "melee") {
            meleeCount += 1;
        }
        else if (u.type === "ranged") {
            rangedCount += 1;
        }
    }
    // ---- 空间网格(敌方单位) ----
    const grid = {};
    for (let i = 0; i < enemies.length; i += 1) {
        const e = enemies[i];
        if (e === undefined) {
            continue;
        }
        const key = ((e.x >> CELL_SHIFT) + GRID_BASE) * GRID_STRIDE + ((e.y >> CELL_SHIFT) + GRID_BASE);
        let cell = grid[key];
        if (cell === undefined) {
            cell = [];
            grid[key] = cell;
        }
        cell.push(e);
    }
    // ---- 家门口威胁 ----
    let threatX = -1;
    let threatY = -1;
    let threatFound = false;
    if (enemies.length > 0) {
        for (let i = 0; i < myOwned.length; i += 1) {
            const s = myOwned[i];
            if (s === undefined) {
                continue;
            }
            const cx = (s.x >> CELL_SHIFT) + GRID_BASE;
            const cy = (s.y >> CELL_SHIFT) + GRID_BASE;
            for (let oy = -1; oy <= 1; oy += 1) {
                for (let ox = -1; ox <= 1; ox += 1) {
                    const cell = grid[(cx + ox) * GRID_STRIDE + (cy + oy)];
                    if (cell === undefined) {
                        continue;
                    }
                    for (let j = 0; j < cell.length; j += 1) {
                        const e = cell[j];
                        if (e === undefined) {
                            continue;
                        }
                        if (dist(s.x, s.y, e.x, e.y) <= HOME_THREAT_RADIUS) {
                            threatFound = true;
                            threatX = e.x;
                            threatY = e.y;
                        }
                    }
                }
            }
        }
    }
    if (threatFound) {
        if (alarmTicks < 999) {
            alarmTicks += 1;
        }
    }
    else {
        alarmTicks = 0;
    }
    // ---- 农民岗位分配 ----
    const mineLoad = [];
    for (let m = 0; m < myMines.length; m += 1) {
        mineLoad.push(0);
    }
    const assignIdx = [];
    for (let w = 0; w < myWorkers.length; w += 1) {
        const u = myWorkers[w];
        if (u === undefined) {
            assignIdx.push(-1);
            continue;
        }
        let best = -1;
        let bestScore = 0;
        for (let m = 0; m < myMines.length; m += 1) {
            const s = myMines[m];
            const load = mineLoad[m];
            if (s === undefined || load === undefined) {
                continue;
            }
            const d = dist(u.x, u.y, s.x, s.y);
            const score = d + load * 4;
            if (best < 0 || score < bestScore) {
                best = m;
                bestScore = score;
            }
        }
        if (best >= 0) {
            const prev = mineLoad[best];
            if (prev !== undefined) {
                mineLoad[best] = prev + 1;
            }
        }
        assignIdx.push(best);
    }
    // ---- 农民行动 ----
    for (let w = 0; w < myWorkers.length; w += 1) {
        const u = myWorkers[w];
        if (u === undefined) {
            continue;
        }
        if (enemies.length > 0 && hasCombatNear(u, grid, FLEE_RADIUS)) {
            const b = myBases[0];
            if (b !== undefined) {
                moveTo(u.id, b.x, b.y);
            }
            continue;
        }
        if (myBases.length > 0) {
            const full = u.carrying >= CARRY_LIMIT;
            if (!full && myMines.length > 0) {
                let s = null;
                const m = assignIdx[w];
                if (m !== undefined && m >= 0) {
                    const cand = myMines[m];
                    if (cand !== undefined) {
                        s = cand;
                    }
                }
                if (s === null) {
                    const idx = nearestIdx(u.x, u.y, myMines);
                    if (idx >= 0) {
                        const cand2 = myMines[idx];
                        if (cand2 !== undefined) {
                            s = cand2;
                        }
                    }
                }
                if (s !== null) {
                    if (dist(u.x, u.y, s.x, s.y) <= 1) {
                        harvest(u.id, s.id);
                    }
                    else {
                        moveTo(u.id, s.x, s.y);
                    }
                    continue;
                }
            }
            if (u.carrying > 0) {
                const bidx = nearestIdx(u.x, u.y, myBases);
                const b = bidx >= 0 ? myBases[bidx] : undefined;
                if (b !== undefined) {
                    if (dist(u.x, u.y, b.x, b.y) <= 1) {
                        transfer(u.id);
                    }
                    else {
                        moveTo(u.id, b.x, b.y);
                    }
                    continue;
                }
            }
            if (!full && myMines.length > 0) {
                const idx = nearestIdx(u.x, u.y, myMines);
                const s2 = idx >= 0 ? myMines[idx] : undefined;
                if (s2 !== undefined) {
                    if (dist(u.x, u.y, s2.x, s2.y) <= 1) {
                        harvest(u.id, s2.id);
                    }
                    else {
                        moveTo(u.id, s2.x, s2.y);
                    }
                    continue;
                }
            }
        }
        if (onOpenSite(u, capGroups)) {
            continue;
        }
        const t = pickCapture(u.x, u.y, capGroups);
        if (t !== null) {
            moveTo(u.id, t.x, t.y);
        }
    }
    // ---- 防守岗哨指派(最老的几个战斗单位守家) ----
    let defCount = 1;
    if (myMil.length >= 8) {
        defCount = 2;
    }
    if (myMil.length >= 12) {
        defCount = 3;
    }
    if (defCount > myMil.length) {
        defCount = myMil.length;
    }
    let d0 = -1;
    let d1 = -1;
    let d2 = -1;
    if (defCount > 0) {
        for (let i = 0; i < myMil.length; i += 1) {
            const u = myMil[i];
            if (u === undefined) {
                continue;
            }
            const id = u.id;
            if (d0 < 0 || id < d0) {
                d2 = d1;
                d1 = d0;
                d0 = id;
            }
            else if (defCount >= 2 && (d1 < 0 || id < d1)) {
                d2 = d1;
                d1 = id;
            }
            else if (defCount >= 3 && (d2 < 0 || id < d2)) {
                d2 = id;
            }
        }
    }
    // ---- 战斗单位行动 ----
    for (let i = 0; i < myMil.length; i += 1) {
        const u = myMil[i];
        if (u === undefined) {
            continue;
        }
        const atkRange = u.type === "ranged" ? 2 : 1;
        const cx = (u.x >> CELL_SHIFT) + GRID_BASE;
        const cy = (u.y >> CELL_SHIFT) + GRID_BASE;
        let atkId = -1;
        let atkD = 999;
        let cId = -1;
        let cX = -1;
        let cY = -1;
        let cD = 999;
        for (let oy = -1; oy <= 1; oy += 1) {
            for (let ox = -1; ox <= 1; ox += 1) {
                const cell = grid[(cx + ox) * GRID_STRIDE + (cy + oy)];
                if (cell === undefined) {
                    continue;
                }
                for (let j = 0; j < cell.length; j += 1) {
                    const e = cell[j];
                    if (e === undefined) {
                        continue;
                    }
                    const d = dist(u.x, u.y, e.x, e.y);
                    if (d <= atkRange && d < atkD) {
                        atkD = d;
                        atkId = e.id;
                    }
                    if (e.type !== "worker" && d <= 7 && d < cD) {
                        cD = d;
                        cId = e.id;
                        cX = e.x;
                        cY = e.y;
                    }
                }
            }
        }
        if (atkId >= 0) {
            attack(u.id, atkId);
            continue;
        }
        let rank = -1;
        if (u.id === d0) {
            rank = 0;
        }
        else if (defCount >= 2 && u.id === d1) {
            rank = 1;
        }
        else if (defCount >= 3 && u.id === d2) {
            rank = 2;
        }
        const canGuard = guardList.length > 0 || myBases.length > 0;
        const isDef = rank >= 0 && canGuard;
        if (threatFound && (isDef || alarmTicks >= 2)) {
            moveTo(u.id, threatX, threatY);
            continue;
        }
        if (isDef) {
            if (cId >= 0 && cD <= DEF_CHASE_RADIUS) {
                moveTo(u.id, cX, cY);
            }
            else if (guardList.length > 0) {
                const g = guardList[rank % guardList.length];
                if (g !== undefined) {
                    if (!(u.x === g.x && u.y === g.y)) {
                        moveTo(u.id, g.x, g.y);
                    }
                }
            }
            else if (myBases.length > 0) {
                const g = myBases[rank % myBases.length];
                if (g !== undefined && dist(u.x, u.y, g.x, g.y) > 1) {
                    moveTo(u.id, g.x, g.y);
                }
            }
            continue;
        }
        if (cId >= 0 && cD <= EXPAND_CHASE_RADIUS) {
            moveTo(u.id, cX, cY);
            continue;
        }
        if (onOpenSite(u, capGroups)) {
            continue;
        }
        const t = pickCapture(u.x, u.y, capGroups);
        if (t !== null) {
            moveTo(u.id, t.x, t.y);
        }
    }
    // ---- 生产 ----
    let workerTarget = 4;
    if (tick >= 15) {
        workerTarget = 5;
    }
    if (tick >= 30) {
        workerTarget = 6;
    }
    if (tick >= 45) {
        workerTarget = 7;
    }
    if (tick >= 60) {
        workerTarget = 8;
    }
    if (myMines.length === 0) {
        workerTarget = myWorkers.length;
    }
    let bank = money;
    let addW = 0;
    let addMil = 0;
    let addMelee = 0;
    let addRanged = 0;
    for (let i = 0; i < myBases.length; i += 1) {
        const b = myBases[i];
        if (b === undefined) {
            continue;
        }
        if (b.producing !== null) {
            continue;
        }
        if (myWorkers.length + addW + myMil.length + addMil >= TOTAL_CAP) {
            continue;
        }
        let kind = "";
        if (myWorkers.length + addW < workerTarget && bank >= WORKER_COST) {
            kind = "worker";
        }
        else if (myMil.length + addMil < MIL_CAP && bank >= MELEE_COST) {
            const totalMelee = meleeCount + addMelee;
            const totalRanged = rangedCount + addRanged;
            if (totalMelee >= 6 && totalRanged * 3 < totalMelee && bank >= RANGED_COST) {
                kind = "ranged";
            }
            else {
                kind = "melee";
            }
        }
        else if (myMines.length > 0 &&
            myWorkers.length + addW < WORKER_HARD_CAP &&
            bank >= WORKER_COST) {
            kind = "worker";
        }
        if (kind === "") {
            continue;
        }
        const res = spawnUnit(b.id, kind);
        if (!isError(res)) {
            if (kind === "worker") {
                bank -= WORKER_COST;
                addW += 1;
            }
            else if (kind === "ranged") {
                bank -= RANGED_COST;
                addMil += 1;
                addRanged += 1;
            }
            else {
                bank -= MELEE_COST;
                addMil += 1;
                addMelee += 1;
            }
        }
    }
}
