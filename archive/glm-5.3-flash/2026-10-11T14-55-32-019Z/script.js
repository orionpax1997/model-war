"use strict";
// script.ts
// 四方对称 RTS 参赛脚本:经济(农民采集交付)+ 近战爆兵 + 抢占中立点。
// 座位只从 getMyIndex() 读;跨 tick 只存数值;每单位每 tick 至多一条意图;
// 返回值一律走 isError / errCode 两步判别。
var myIndexSaved = -1;
const CARRY_LIMIT = 20;
const WORKER_COST = 4;
const MELEE_COST = 8;
const RANGED_COST = 12;
const CAVALRY_COST = 16;
const WORKER_TARGET = 5;
function cheb(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    const adx = dx < 0 ? -dx : dx;
    const ady = dy < 0 ? -dy : dy;
    return adx > ady ? adx : ady;
}
function unitCost(t) {
    if (t === "worker") {
        return WORKER_COST;
    }
    if (t === "melee") {
        return MELEE_COST;
    }
    if (t === "ranged") {
        return RANGED_COST;
    }
    return CAVALRY_COST;
}
function nearestSite(list, ux, uy) {
    let best = null;
    let bestD = 0;
    for (let i = 0; i < list.length; i += 1) {
        const s = list[i];
        if (s === undefined) {
            continue;
        }
        const d = cheb(ux, uy, s.x, s.y);
        if (best === null || d < bestD) {
            best = s;
            bestD = d;
        }
    }
    return best;
}
function loop() {
    const tick = getTick();
    const me = getMyIndex();
    myIndexSaved = me;
    const players = getObjectsByType("player");
    const mine = players[me];
    if (mine === undefined) {
        return;
    }
    if (!mine.alive) {
        return;
    }
    let res = mine.resources;
    const units = getObjectsByType("unit");
    const sites = getObjectsByType("site");
    const myUnits = [];
    const enemies = [];
    for (let i = 0; i < units.length; i += 1) {
        const u = units[i];
        if (u === undefined) {
            continue;
        }
        if (u.owner === me) {
            myUnits.push(u);
        }
        else {
            enemies.push(u);
        }
    }
    const myBases = [];
    const myMines = [];
    const otherSites = [];
    for (let i = 0; i < sites.length; i += 1) {
        const s = sites[i];
        if (s === undefined) {
            continue;
        }
        if (s.kind === "base") {
            if (s.owner === me) {
                myBases.push(s);
            }
            else {
                otherSites.push(s);
            }
        }
        else {
            if (s.owner === me) {
                if (s.remaining !== undefined && s.remaining > 0) {
                    myMines.push(s);
                }
            }
            else {
                otherSites.push(s);
            }
        }
    }
    let workerCount = 0;
    let soldierCount = 0;
    for (let i = 0; i < myUnits.length; i += 1) {
        const u = myUnits[i];
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
    // 生产:每条空产线下单一单。先补经济,再补近战主力。
    for (let i = 0; i < myBases.length; i += 1) {
        const b = myBases[i];
        if (b === undefined) {
            continue;
        }
        if (b.producing !== null) {
            continue;
        }
        let want = null;
        if (workerCount < WORKER_TARGET && res >= WORKER_COST) {
            want = "worker";
        }
        else if (res >= MELEE_COST) {
            want = "melee";
        }
        else if (res >= WORKER_COST && workerCount < WORKER_TARGET + 2) {
            want = "worker";
        }
        if (want === null) {
            continue;
        }
        const r = spawnUnit(b.id, want);
        if (isError(r)) {
            const code = errCode(r);
            if (code === ERR_NOT_ENOUGH_RESOURCES) {
                continue;
            }
            continue;
        }
        res -= unitCost(want);
        if (want === "worker") {
            workerCount += 1;
        }
        else {
            soldierCount += 1;
        }
    }
    // 单位意图:每单位本 tick 只提交一条。
    for (let i = 0; i < myUnits.length; i += 1) {
        const u = myUnits[i];
        if (u === undefined) {
            continue;
        }
        if (u.type === "worker") {
            workerAct(u, myBases, myMines, otherSites);
        }
        else {
            soldierAct(u, enemies, otherSites);
        }
    }
}
function workerAct(u, myBases, myMines, otherSites) {
    // 满载:回基地交付。
    if (u.carrying >= CARRY_LIMIT) {
        const b = nearestSite(myBases, u.x, u.y);
        if (b === null) {
            return;
        }
        if (cheb(u.x, u.y, b.x, b.y) <= 1) {
            const r = transfer(u.id);
            if (isError(r)) {
                errCode(r);
            }
            return;
        }
        const r2 = moveTo(u.id, b.x, b.y);
        if (isError(r2)) {
            errCode(r2);
        }
        return;
    }
    // 有可采的己方矿:相邻就采,否则走过去。
    if (myMines.length > 0) {
        const s = nearestSite(myMines, u.x, u.y);
        if (s !== null) {
            if (cheb(u.x, u.y, s.x, s.y) <= 1) {
                const r = harvest(u.id, s.id);
                if (isError(r)) {
                    errCode(r);
                }
                return;
            }
            const r2 = moveTo(u.id, s.x, s.y);
            if (isError(r2)) {
                errCode(r2);
            }
            return;
        }
    }
    // 没矿可采但身上有货:先交付。
    if (u.carrying > 0 && myBases.length > 0) {
        const b = nearestSite(myBases, u.x, u.y);
        if (b !== null) {
            if (cheb(u.x, u.y, b.x, b.y) <= 1) {
                const r = transfer(u.id);
                if (isError(r)) {
                    errCode(r);
                }
                return;
            }
            const r2 = moveTo(u.id, b.x, b.y);
            if (isError(r2)) {
                errCode(r2);
            }
            return;
        }
    }
    // 没矿可采:去踩最近的非己方点位(踩上中心格被动占领)。
    captureOrHold(u, otherSites);
}
function soldierAct(u, enemies, otherSites) {
    // 找最近敌人。
    let bestId = -1;
    let bestX = 0;
    let bestY = 0;
    let bestD = 0;
    for (let i = 0; i < enemies.length; i += 1) {
        const e = enemies[i];
        if (e === undefined) {
            continue;
        }
        const d = cheb(u.x, u.y, e.x, e.y);
        if (bestId === -1 || d < bestD) {
            bestId = e.id;
            bestX = e.x;
            bestY = e.y;
            bestD = d;
        }
    }
    if (bestId !== -1 && bestD <= 10) {
        if (bestD <= 1) {
            const r = attack(u.id, bestId);
            if (isError(r)) {
                errCode(r);
            }
            return;
        }
        const r2 = moveTo(u.id, bestX, bestY);
        if (isError(r2)) {
            errCode(r2);
        }
        return;
    }
    // 附近没敌人:去抢点 / 守在已踩的点上继续推进。
    captureOrHold(u, otherSites);
}
function captureOrHold(u, otherSites) {
    const t = nearestSite(otherSites, u.x, u.y);
    if (t === null) {
        return;
    }
    // 已经站在点位格上:不提交意图,原地驱动占领进度。
    if (cheb(u.x, u.y, t.x, t.y) === 0) {
        return;
    }
    const r = moveTo(u.id, t.x, t.y);
    if (isError(r)) {
        errCode(r);
    }
}
