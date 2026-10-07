"use strict";
// script.ts - Strategy B: 扩张运营
// 优先占领资源点与扩张经济，攒够家底再转军事
// 模块级：只存数值与简单状态
var me = -1;
var initDone = false;
var capturerId = -1;
function loop() {
    if (!initDone) {
        me = getMyIndex();
        initDone = true;
    }
    const tick = getTick();
    // --- 读玩家（含自己），拿自己的钱 ---
    const players = getObjectsByType("player");
    let myRes = 0;
    for (let i = 0; i < players.length; i += 1) {
        const p = players[i];
        if (p !== undefined && p.index === me) {
            myRes = p.resources;
        }
    }
    // --- 读点位：分类为基地、己方资源、中立资源 ---
    const sites = getObjectsByType("site");
    const bases = [];
    const ownedRes = [];
    const neutRes = [];
    for (let i = 0; i < sites.length; i += 1) {
        const s = sites[i];
        if (s === undefined)
            continue;
        if (s.kind === "base") {
            if (s.owner === me)
                bases.push(s);
        }
        else if (s.kind === "resource") {
            if (s.owner === me)
                ownedRes.push(s);
            else if (s.owner === -1)
                neutRes.push(s);
        }
    }
    // --- 读我方单位：分工人（含 capturer）、战斗 ---
    const myUnits = getObjectsByType("unit", { owner: me });
    const harvestWorkers = [];
    const combats = [];
    let capturer;
    for (let i = 0; i < myUnits.length; i += 1) {
        const u = myUnits[i];
        if (u === undefined)
            continue;
        if (u.type === "worker") {
            if (u.id === capturerId) {
                capturer = u;
            }
            else {
                harvestWorkers.push(u);
            }
        }
        else {
            combats.push(u);
        }
    }
    // --- 读敌方单位（来自所有存活玩家）---
    const enemies = [];
    for (let i = 0; i < players.length; i += 1) {
        const p = players[i];
        if (p === undefined || p.index === me || !p.alive)
            continue;
        const es = getObjectsByType("unit", { owner: p.index });
        for (let j = 0; j < es.length; j += 1) {
            const e = es[j];
            if (e !== undefined) {
                enemies.push(e);
            }
        }
    }
    // --- 生产决策 ---
    // 经济期（tick < 250）：worker 优先（workerCap=5）；之后：worker 维持 3，melee 主力
    const workerCap = tick < 250 ? 5 : 3;
    const totalWorkers = harvestWorkers.length + (capturer !== undefined ? 1 : 0);
    const wantWorker = totalWorkers < workerCap;
    for (let i = 0; i < bases.length; i += 1) {
        const b = bases[i];
        if (b.producing !== null)
            continue;
        let toSpawn;
        let cost;
        if (wantWorker && myRes >= 4) {
            toSpawn = "worker";
            cost = 4;
        }
        else if (myRes >= 8) {
            toSpawn = "melee";
            cost = 8;
        }
        else {
            continue;
        }
        if (myRes < cost)
            continue;
        const sr = spawnUnit(b.id, toSpawn);
        if (!isError(sr)) {
            myRes -= cost;
        }
    }
    // --- 分配 capturer（已死的就重置；够工人 + 还有中立点 → 派一个）---
    if (capturer === undefined && capturerId !== -1) {
        capturerId = -1;
    }
    if (capturer === undefined &&
        neutRes.length > 0 &&
        harvestWorkers.length >= 4) {
        capturerId = harvestWorkers[0].id;
        capturer = harvestWorkers[0];
    }
    // --- Capturer 行为：吃最近的 neutral resource 点 ---
    if (capturer !== undefined) {
        if (neutRes.length === 0) {
            // 没有中立点了，释放 capturer 让它回去采
            capturerId = -1;
        }
        else {
            let bestSite;
            let bestD = 999;
            for (let i = 0; i < neutRes.length; i += 1) {
                const s = neutRes[i];
                const d = getRange(capturer.x, capturer.y, s.x, s.y);
                if (d < bestD) {
                    bestD = d;
                    bestSite = s;
                }
            }
            if (bestSite !== undefined) {
                if (capturer.x !== bestSite.x || capturer.y !== bestSite.y) {
                    moveTo(capturer.id, bestSite.x, bestSite.y);
                }
                // 已在 site 上时不发任何意图，让 capture 进度推进
            }
        }
    }
    // --- 工人（采集）行为：满载交付，否则采集 ---
    for (let i = 0; i < harvestWorkers.length; i += 1) {
        const w = harvestWorkers[i];
        if (w === undefined)
            continue;
        if (w.id === capturerId)
            continue; // 兜底跳过 capturer
        if (w.carrying >= 20) {
            const tr = transfer(w.id);
            if (!isError(tr))
                continue;
            moveToBaseAdj(w, bases);
            continue;
        }
        // 找最近的我方资源点
        let bestIdx = -1;
        let bestD = 999;
        for (let j = 0; j < ownedRes.length; j += 1) {
            const rs = ownedRes[j];
            const d = getRange(w.x, w.y, rs.x, rs.y);
            if (d < bestD) {
                bestD = d;
                bestIdx = j;
            }
        }
        if (bestIdx === -1)
            continue;
        const rs = ownedRes[bestIdx];
        if (bestD === 1) {
            // 已相邻，采集
            harvest(w.id, rs.id);
        }
        else {
            // 走向 rs 的某个 plain 相邻格
            moveToAdjOf(w, rs.x, rs.y);
        }
    }
    // --- 战斗单位：找最近敌人，射程内攻击，否则走近 ---
    for (let i = 0; i < combats.length; i += 1) {
        const c = combats[i];
        let bestIdx = -1;
        let bestD = 999;
        for (let j = 0; j < enemies.length; j += 1) {
            const e = enemies[j];
            const d = getRange(c.x, c.y, e.x, e.y);
            if (d < bestD) {
                bestD = d;
                bestIdx = j;
            }
        }
        if (bestIdx === -1)
            continue;
        const e = enemies[bestIdx];
        const rng = c.type === "ranged" ? 2 : 1;
        if (bestD <= rng) {
            attack(c.id, e.id);
        }
        else {
            moveTo(c.id, e.x, e.y);
        }
    }
}
// 走向 (tx, ty) 的某个 plain 相邻格（挑离 w 最近的那个）
function moveToAdjOf(w, tx, ty) {
    let ax = tx;
    let ay = ty;
    let bestD = 999;
    for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
            if (dx === 0 && dy === 0)
                continue;
            const nx = tx + dx;
            const ny = ty + dy;
            if (getTerrainAt(nx, ny) !== "plain")
                continue;
            const d = getRange(w.x, w.y, nx, ny);
            if (d < bestD) {
                bestD = d;
                ax = nx;
                ay = ny;
            }
        }
    }
    if (bestD < 999) {
        moveTo(w.id, ax, ay);
    }
}
// 走向最近基地的某个 plain 相邻格（用来交付）
function moveToBaseAdj(w, bases) {
    if (bases.length === 0)
        return;
    let bx = 0;
    let by = 0;
    let bestD = 999;
    for (let i = 0; i < bases.length; i += 1) {
        const b = bases[i];
        const d = getRange(w.x, w.y, b.x, b.y);
        if (d < bestD) {
            bestD = d;
            bx = b.x;
            by = b.y;
        }
    }
    moveToAdjOf(w, bx, by);
}
