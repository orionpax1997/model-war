"use strict";
// script.ts — 扩张运营:先经济与占点,攒够家底再转军事。
// 形态:单文件、顶层 loop()、无模块语法、无非确定源、跨 tick 只存数值。
var myIndex = -1;
var homeBaseId = -1;
function loop() {
    if (myIndex < 0) {
        myIndex = getMyIndex();
    }
    const me = myIndex;
    const tick = getTick();
    // ---- 玩家侧三项:每 tick 重读 ----
    const players = getObjectsByType("player");
    let myRes = 0;
    let alive = true;
    for (let i = 0; i < players.length; i += 1) {
        const p = players[i];
        if (p !== undefined && p.index === me) {
            myRes = p.resources;
            alive = p.alive;
        }
    }
    if (!alive) {
        return;
    }
    // ---- 快照:单位与点位,每 tick 重查,不缓存 ----
    const myUnits = getObjectsByType("unit", { owner: me });
    const allSites = getObjectsByType("site");
    const allUnits = getObjectsByType("unit");
    const myBases = [];
    const myMines = [];
    const neutralSites = [];
    let home = null;
    for (let i = 0; i < allSites.length; i += 1) {
        const s = allSites[i];
        if (s === undefined) {
            continue;
        }
        if (s.owner === me) {
            if (s.kind === "base") {
                myBases.push(s);
                if (home === null) {
                    home = s;
                }
            }
            else if (s.remaining !== undefined && s.remaining > 0) {
                myMines.push(s);
            }
        }
        else if (s.owner === -1) {
            neutralSites.push(s);
        }
    }
    if (home === null) {
        // 没有己方基地:残局。单位仍在就继续抢中立点。
        captureWithAll(myUnits, neutralSites, allUnits, me);
        return;
    }
    if (homeBaseId < 0) {
        homeBaseId = home.id;
    }
    // ---- 敌方单位清单(一次查询,循环内复用) ----
    const foes = [];
    for (let i = 0; i < allUnits.length; i += 1) {
        const u = allUnits[i];
        if (u !== undefined && u.owner !== me) {
            foes.push(u);
        }
    }
    // ---- 生产:每条产线空了才下单;先补农民,后转近战 ----
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
    for (let i = 0; i < myBases.length; i += 1) {
        const b = myBases[i];
        if (b === undefined || b.producing !== null) {
            continue;
        }
        let want = null;
        if (workerCount < 8 && myRes >= 4) {
            want = "worker";
        }
        else if (myRes >= 8) {
            want = "melee";
        }
        if (want !== null) {
            const r = spawnUnit(b.id, want);
            if (isError(r)) {
                const code = errCode(r);
                if (code === "ERR_NOT_ENOUGH_RESOURCES") {
                    continue;
                }
                continue;
            }
            if (want === "worker") {
                workerCount += 1;
            }
            else {
                militaryCount += 1;
            }
        }
    }
    // ---- 中立点按离家距离排序(本 tick 内排序,不跨 tick 缓存) ----
    const sortedNeutral = sortNeutralByHome(neutralSites, home);
    // ---- 农民:采集 → 交付 → 占点,三态每 tick 由快照现算 ----
    let captureSlot = 0;
    for (let i = 0; i < myUnits.length; i += 1) {
        const u = myUnits[i];
        if (u === undefined || u.type !== "worker") {
            continue;
        }
        // 危险规避:有敌人贴脸就先撤向家。
        let danger = false;
        for (let j = 0; j < foes.length; j += 1) {
            const f = foes[j];
            if (f !== undefined && getRange(u.x, u.y, f.x, f.y) <= 2) {
                danger = true;
                break;
            }
        }
        if (u.carrying >= 20) {
            deliverWorker(u, myBases);
            continue;
        }
        // 最近的可用矿
        let bestMine = null;
        let bestD = 0;
        for (let j = 0; j < myMines.length; j += 1) {
            const m = myMines[j];
            if (m === undefined) {
                continue;
            }
            const d = getRange(u.x, u.y, m.x, m.y);
            if (bestMine === null || d < bestD) {
                bestMine = m;
                bestD = d;
            }
        }
        if (bestMine !== null) {
            if (bestD <= 1) {
                const r = harvest(u.id, bestMine.id);
                if (isError(r)) {
                    continue;
                }
            }
            else if (danger) {
                fleeHome(u, home);
            }
            else {
                const r = moveTo(u.id, bestMine.x, bestMine.y);
                if (isError(r)) {
                    continue;
                }
            }
            continue;
        }
        // 没有可用矿:有携带先交付,否则去占中立点。
        if (u.carrying > 0) {
            deliverWorker(u, myBases);
            continue;
        }
        if (sortedNeutral.length === 0) {
            // 无点可占:守在家附近。
            if (getRange(u.x, u.y, home.x, home.y) > 1) {
                const r = moveTo(u.id, home.x, home.y);
                if (isError(r)) {
                    continue;
                }
            }
            continue;
        }
        const target = sortedNeutral[captureSlot % sortedNeutral.length];
        if (target === undefined) {
            continue;
        }
        captureSlot += 1;
        if (u.x === target.x && u.y === target.y) {
            // 站在点位格上驱动占领:不提交意图,原地累积。
            continue;
        }
        const r2 = moveTo(u.id, target.x, target.y);
        if (isError(r2)) {
            continue;
        }
    }
    // ---- 军事单位:守家,敌近则打;中盘后随优势前出占点 ----
    for (let i = 0; i < myUnits.length; i += 1) {
        const u = myUnits[i];
        if (u === undefined || u.type === "worker") {
            continue;
        }
        const reach = u.type === "ranged" ? 2 : 1;
        let nearestFoe = null;
        let nearestD = 0;
        for (let j = 0; j < foes.length; j += 1) {
            const f = foes[j];
            if (f === undefined) {
                continue;
            }
            const d = getRange(u.x, u.y, f.x, f.y);
            if (nearestFoe === null || d < nearestD) {
                nearestFoe = f;
                nearestD = d;
            }
        }
        if (nearestFoe !== null && nearestD <= reach) {
            const r = attack(u.id, nearestFoe.id);
            if (isError(r)) {
                continue;
            }
            continue;
        }
        // 敌人逼近任一己方基地(含家)时前出迎击。
        let threat = false;
        if (nearestFoe !== null) {
            for (let j = 0; j < myBases.length; j += 1) {
                const b = myBases[j];
                if (b !== undefined && getRange(b.x, b.y, nearestFoe.x, nearestFoe.y) <= 8) {
                    threat = true;
                    break;
                }
            }
        }
        if (threat && nearestFoe !== null) {
            const r = moveTo(u.id, nearestFoe.x, nearestFoe.y);
            if (isError(r)) {
                continue;
            }
            continue;
        }
        // 无威胁:中盘后去占最近的中立点,否则守家。
        if (tick >= 300 && sortedNeutral.length > 0) {
            const target = sortedNeutral[i % sortedNeutral.length];
            if (target !== undefined) {
                if (u.x === target.x && u.y === target.y) {
                    continue;
                }
                const r = moveTo(u.id, target.x, target.y);
                if (isError(r)) {
                    continue;
                }
                continue;
            }
        }
        if (getRange(u.x, u.y, home.x, home.y) > 2) {
            const r = moveTo(u.id, home.x, home.y);
            if (isError(r)) {
                continue;
            }
        }
    }
}
/** 农民交付:相邻任一己方基地就 transfer,否则走向最近的基地。 */
function deliverWorker(u, bases) {
    let best = null;
    let bestD = 0;
    for (let i = 0; i < bases.length; i += 1) {
        const b = bases[i];
        if (b === undefined) {
            continue;
        }
        const d = getRange(u.x, u.y, b.x, b.y);
        if (best === null || d < bestD) {
            best = b;
            bestD = d;
        }
    }
    if (best === null) {
        return;
    }
    if (bestD <= 1) {
        const r = transfer(u.id);
        if (isError(r)) {
            return;
        }
        return;
    }
    const r2 = moveTo(u.id, best.x, best.y);
    if (isError(r2)) {
        return;
    }
}
/** 危险撤离:朝家走一步。 */
function fleeHome(u, home) {
    const r = moveTo(u.id, home.x, home.y);
    if (isError(r)) {
        return;
    }
}
/** 中立点按离家距离升序(插入排序,规模小,不引浮点)。 */
function sortNeutralByHome(sites, home) {
    const arr = [];
    for (let i = 0; i < sites.length; i += 1) {
        const s = sites[i];
        if (s !== undefined) {
            arr.push(s);
        }
    }
    for (let i = 1; i < arr.length; i += 1) {
        const cur = arr[i];
        if (cur === undefined) {
            continue;
        }
        const cd = getRange(home.x, home.y, cur.x, cur.y);
        let j = i - 1;
        while (j >= 0) {
            const prev = arr[j];
            if (prev === undefined) {
                j -= 1;
                continue;
            }
            if (getRange(home.x, home.y, prev.x, prev.y) <= cd) {
                break;
            }
            arr[j + 1] = prev;
            j -= 1;
        }
        arr[j + 1] = cur;
    }
    return arr;
}
/** 残局:没有己方基地时,所有单位去占最近的中立点。 */
function captureWithAll(units, neutralSites, allUnits, me) {
    if (neutralSites.length === 0) {
        return;
    }
    let slot = 0;
    for (let i = 0; i < units.length; i += 1) {
        const u = units[i];
        if (u === undefined) {
            continue;
        }
        const target = neutralSites[slot % neutralSites.length];
        if (target === undefined) {
            continue;
        }
        slot += 1;
        if (u.x === target.x && u.y === target.y) {
            continue;
        }
        const r = moveTo(u.id, target.x, target.y);
        if (isError(r)) {
            continue;
        }
    }
}
