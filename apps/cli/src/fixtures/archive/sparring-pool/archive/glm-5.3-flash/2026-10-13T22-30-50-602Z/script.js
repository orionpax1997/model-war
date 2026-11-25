"use strict";
var myIndex = -1;
const CAPTURE_TICKS = 10;
const WORKER_COST = 4;
const MELEE_COST = 8;
const CARRY_LIMIT = 20;
const WORKER_TARGET = 6;
function cheb(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    const adx = dx < 0 ? -dx : dx;
    const ady = dy < 0 ? -dy : dy;
    return adx > ady ? adx : ady;
}
/** 返回距离最近的元素下标;没有可用元素时返回 -1。 */
function nearestIdx(items, x, y) {
    let best = -1;
    let bestD = 999999;
    for (let i = 0; i < items.length; i += 1) {
        const it = items[i];
        if (it === undefined) {
            continue;
        }
        const d = cheb(it.x, it.y, x, y);
        if (d < bestD) {
            bestD = d;
            best = i;
        }
    }
    return best;
}
const SORTED_BUF = [];
/** 返回按到 (x,y) 的距离升序排好的下标序列(复用模块级缓冲,只放数值)。 */
function orderIdx(items, x, y) {
    SORTED_BUF.length = 0;
    for (let i = 0; i < items.length; i += 1) {
        if (items[i] !== undefined) {
            SORTED_BUF.push(i);
        }
    }
    // 插入排序,确定性、无比较器闭包
    for (let i = 1; i < SORTED_BUF.length; i += 1) {
        const idx = SORTED_BUF[i];
        const it = items[idx];
        let j = i - 1;
        while (j >= 0) {
            const jdx = SORTED_BUF[j];
            const jt = items[jdx];
            if (cheb(jt.x, jt.y, x, y) <= cheb(it.x, it.y, x, y)) {
                break;
            }
            SORTED_BUF[j + 1] = jdx;
            j -= 1;
        }
        SORTED_BUF[j + 1] = idx;
    }
    const out = [];
    for (let i = 0; i < SORTED_BUF.length; i += 1) {
        out.push(SORTED_BUF[i]);
    }
    return out;
}
/** 按优先级挑一个可占领点位:中立基地 > 中立矿 > 敌方矿 > 敌方基地,同级取最近。 */
function pickTargetIdx(targets, x, y) {
    let best = -1;
    let bestKey = 999999999;
    for (let i = 0; i < targets.length; i += 1) {
        const s = targets[i];
        if (s === undefined) {
            continue;
        }
        let p;
        if (s.kind === "base" && s.owner === -1) {
            p = 0;
        }
        else if (s.kind === "resource" && s.owner === -1) {
            p = 1;
        }
        else if (s.kind === "resource") {
            p = 2;
        }
        else {
            p = 3;
        }
        const key = p * 1000 + cheb(s.x, s.y, x, y);
        if (key < bestKey) {
            bestKey = key;
            best = i;
        }
    }
    return best;
}
function loop() {
    const tick = getTick();
    if (myIndex < 0) {
        myIndex = getMyIndex();
    }
    const me = myIndex;
    const players = getObjectsByType("player");
    const meRow = players[me];
    if (meRow === undefined || !meRow.alive) {
        return;
    }
    let myRes = meRow.resources;
    const allUnits = getObjectsByType("unit");
    const allSites = getObjectsByType("site");
    const mine = [];
    const foes = [];
    for (let i = 0; i < allUnits.length; i += 1) {
        const u = allUnits[i];
        if (u === undefined) {
            continue;
        }
        if (u.owner === me) {
            mine.push(u);
        }
        else {
            foes.push(u);
        }
    }
    mine.sort(function (a, b) { return a.id - b.id; });
    const myBases = [];
    const harvestSites = [];
    const targets = [];
    for (let i = 0; i < allSites.length; i += 1) {
        const s = allSites[i];
        if (s === undefined) {
            continue;
        }
        if (s.kind === "base" && s.owner === me) {
            myBases.push(s);
        }
        else if (s.kind === "resource" && s.owner === me && s.remaining !== 0) {
            harvestSites.push(s);
        }
        else if (s.owner !== me) {
            targets.push(s);
        }
    }
    // ---- 生产:先补经济,再爆近战 ----
    let workerCount = 0;
    for (let i = 0; i < mine.length; i += 1) {
        const u = mine[i];
        if (u !== undefined && u.type === "worker") {
            workerCount += 1;
        }
    }
    for (let i = 0; i < myBases.length; i += 1) {
        const b = myBases[i];
        if (b === undefined || b.producing !== null) {
            continue;
        }
        if (workerCount < WORKER_TARGET && myRes >= WORKER_COST) {
            const r = spawnUnit(b.id, "worker");
            if (!isError(r)) {
                myRes -= WORKER_COST;
                workerCount += 1;
            }
        }
        else if (myRes >= MELEE_COST) {
            const r = spawnUnit(b.id, "melee");
            if (!isError(r)) {
                myRes -= MELEE_COST;
            }
        }
    }
    // ---- 农民:避敌 → 交付 → 采集 → 抢点 ----
    const load = new Array(harvestSites.length);
    for (let i = 0; i < harvestSites.length; i += 1) {
        load[i] = 0;
    }
    for (let i = 0; i < mine.length; i += 1) {
        const u = mine[i];
        if (u === undefined || u.type !== "worker") {
            continue;
        }
        const bi = nearestIdx(myBases, u.x, u.y);
        const home = bi >= 0 ? myBases[bi] : undefined;
        // 威胁规避:近敌绕开,朝家走
        const fi = nearestIdx(foes, u.x, u.y);
        if (fi >= 0 && home !== undefined) {
            const f = foes[fi];
            if (f !== undefined && cheb(u.x, u.y, f.x, f.y) <= 3) {
                const r = moveTo(u.id, home.x, home.y);
                if (isError(r)) {
                    errCode(r);
                }
                continue;
            }
        }
        // 满载交付
        if (home !== undefined && u.carrying >= CARRY_LIMIT) {
            if (cheb(u.x, u.y, home.x, home.y) === 1) {
                const r = transfer(u.id);
                if (isError(r)) {
                    errCode(r);
                }
            }
            else {
                const r = moveTo(u.id, home.x, home.y);
                if (isError(r)) {
                    errCode(r);
                }
            }
            continue;
        }
        // 采集:每矿至多两人
        const order = orderIdx(harvestSites, u.x, u.y);
        let chosen = -1;
        for (let k = 0; k < order.length; k += 1) {
            const idx = order[k];
            if (load[idx] < 2) {
                chosen = idx;
                break;
            }
        }
        if (chosen >= 0) {
            const s = harvestSites[chosen];
            load[chosen] = load[chosen] + 1;
            if (cheb(u.x, u.y, s.x, s.y) === 1) {
                const r = harvest(u.id, s.id);
                if (isError(r)) {
                    errCode(r);
                }
            }
            else {
                const r = moveTo(u.id, s.x, s.y);
                if (isError(r)) {
                    errCode(r);
                }
            }
            continue;
        }
        // 无矿可采:就近交付余量,或去踩中立点
        if (home !== undefined && u.carrying > 0 && cheb(u.x, u.y, home.x, home.y) === 1) {
            const r = transfer(u.id);
            if (isError(r)) {
                errCode(r);
            }
            continue;
        }
        const ti = pickTargetIdx(targets, u.x, u.y);
        if (ti >= 0) {
            const t = targets[ti];
            const r = moveTo(u.id, t.x, t.y);
            if (isError(r)) {
                errCode(r);
            }
            continue;
        }
        if (home !== undefined) {
            const r = moveTo(u.id, home.x, home.y);
            if (isError(r)) {
                errCode(r);
            }
        }
    }
    // ---- 战斗单位:近敌接战,否则去占领 ----
    for (let i = 0; i < mine.length; i += 1) {
        const u = mine[i];
        if (u === undefined || u.type === "worker") {
            continue;
        }
        const fi = nearestIdx(foes, u.x, u.y);
        if (fi >= 0) {
            const f = foes[fi];
            if (f !== undefined) {
                const d = cheb(u.x, u.y, f.x, f.y);
                const range = u.type === "ranged" ? 2 : 1;
                if (d <= range) {
                    const r = attack(u.id, f.id);
                    if (isError(r)) {
                        errCode(r);
                    }
                    continue;
                }
                if (d <= 9) {
                    const r = moveTo(u.id, f.x, f.y);
                    if (isError(r)) {
                        errCode(r);
                    }
                    continue;
                }
            }
        }
        const ti = pickTargetIdx(targets, u.x, u.y);
        if (ti >= 0) {
            const t = targets[ti];
            const r = moveTo(u.id, t.x, t.y);
            if (isError(r)) {
                errCode(r);
            }
            continue;
        }
        // 无点可占:压向最近的敌方残兵
        if (fi >= 0) {
            const f = foes[fi];
            if (f !== undefined) {
                const r = moveTo(u.id, f.x, f.y);
                if (isError(r)) {
                    errCode(r);
                }
            }
        }
    }
}
