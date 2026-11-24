"use strict";
var botMyIndex = -1;
var botHomeX = -1;
var botHomeY = -1;
var botPrevKey = new Map();
var botPrevWant = new Map();
var botStuck = new Map();
var botMode = new Map();
var botMineOf = new Map();
var botCalls = 0;
var botWork = 0;
var botTickNo = 0;
var botOcc = new Map();
var botResv = new Map();
var botTerr = new Map();
var botAvoid = new Map();
var botWantNow = new Map();
var botModeNow = new Map();
var botActed = new Map();
const BOT_CARRY = 20;
const BOT_WORKER_COST = 4;
const BOT_MELEE_COST = 8;
const BOT_BUDGET = 700;
const BOT_WORK_BUDGET = 9000;
const BOT_STRIDE = 4096;
const BOT_MAX_WORKERS = 16;
const BOT_DX = [1, 0, -1, 0, 1, -1, 1, -1];
const BOT_DY = [0, 1, 0, -1, 1, 1, -1, -1];
function loop() {
    botWantNow = new Map();
    botModeNow = new Map();
    try {
        botTick();
    }
    catch {
        // 吞掉本 tick 的意外,已提交的意图保留。
    }
    botPrevWant = botWantNow;
    botMode = botModeNow;
}
function botDist(ax, ay, bx, by) {
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
function botDiv(a, b) {
    if (b <= 0) {
        return 0;
    }
    if (a >= 0) {
        return (a - (a % b)) / b;
    }
    const n = -a;
    return -((n - (n % b)) / b);
}
function botDir(v) {
    if (v > 0) {
        return 1;
    }
    if (v < 0) {
        return -1;
    }
    return 0;
}
function botPlain(x, y) {
    const k = x * BOT_STRIDE + y;
    const c = botTerr.get(k);
    if (c !== undefined) {
        return c === 1;
    }
    if (botCalls >= BOT_BUDGET) {
        return false;
    }
    botCalls += 1;
    const t = getTerrainAt(x, y);
    const v = t === "plain" ? 1 : 0;
    botTerr.set(k, v);
    return v === 1;
}
function botNav(u, tx, ty, stop) {
    const cur = botDist(u.x, u.y, tx, ty);
    if (cur <= stop) {
        return false;
    }
    if (botCalls + 10 > BOT_BUDGET) {
        if (botCalls < BOT_BUDGET) {
            botCalls += 1;
            moveTo(u.id, tx, ty);
            botWantNow.set(u.id, 1);
            botActed.set(u.id, 1);
            return true;
        }
        return false;
    }
    botWantNow.set(u.id, 1);
    botActed.set(u.id, 1);
    const stuck = botStuck.get(u.id) ?? 0;
    const mode = botMode.get(u.id) ?? 0;
    if (mode > 0 && stuck < 2) {
        botCalls += 1;
        moveTo(u.id, tx, ty);
        botModeNow.set(u.id, mode - 1);
        return true;
    }
    const allowEq = stuck >= 2;
    const allowAny = stuck >= 5;
    let found = false;
    let bx = 0;
    let by = 0;
    let bs = 0;
    const rot = (((u.id + botTickNo) % 8) + 8) % 8;
    for (let t = 0; t < 8; t += 1) {
        const idx = (rot + t) % 8;
        const nx = u.x + (BOT_DX[idx] ?? 0);
        const ny = u.y + (BOT_DY[idx] ?? 0);
        const k = nx * BOT_STRIDE + ny;
        if (botOcc.has(k) || botResv.has(k)) {
            continue;
        }
        if (botAvoid.has(k) && !(stop === 0 && nx === tx && ny === ty)) {
            continue;
        }
        let dx = nx - tx;
        if (dx < 0) {
            dx = -dx;
        }
        let dy = ny - ty;
        if (dy < 0) {
            dy = -dy;
        }
        const d = dx > dy ? dx : dy;
        if (d > cur && !allowAny) {
            continue;
        }
        if (d === cur && !allowEq) {
            continue;
        }
        const s = d * 64 + dx + dy;
        if (found && s >= bs) {
            continue;
        }
        if (!botPlain(nx, ny)) {
            continue;
        }
        found = true;
        bx = nx;
        by = ny;
        bs = s;
    }
    botCalls += 1;
    if (found) {
        move(u.id, botDir(bx - u.x), botDir(by - u.y));
        botResv.set(bx * BOT_STRIDE + by, 1);
        return true;
    }
    moveTo(u.id, tx, ty);
    botModeNow.set(u.id, 4);
    return true;
}
function botShift(u, tx, ty, maxD) {
    if (botCalls + 10 > BOT_BUDGET) {
        return false;
    }
    let found = false;
    let bx = 0;
    let by = 0;
    let bs = 0;
    const rot = (((u.id + botTickNo) % 8) + 8) % 8;
    for (let t = 0; t < 8; t += 1) {
        const idx = (rot + t) % 8;
        const nx = u.x + (BOT_DX[idx] ?? 0);
        const ny = u.y + (BOT_DY[idx] ?? 0);
        const k = nx * BOT_STRIDE + ny;
        if (botOcc.has(k) || botResv.has(k) || botAvoid.has(k)) {
            continue;
        }
        const d = botDist(nx, ny, tx, ty);
        const s = (d > maxD ? 100 : 0) + (d === 0 ? 50 : 0) + d;
        if (found && s >= bs) {
            continue;
        }
        if (!botPlain(nx, ny)) {
            continue;
        }
        found = true;
        bx = nx;
        by = ny;
        bs = s;
    }
    if (!found) {
        return false;
    }
    botCalls += 1;
    move(u.id, botDir(bx - u.x), botDir(by - u.y));
    botResv.set(bx * BOT_STRIDE + by, 1);
    botWantNow.set(u.id, 1);
    botActed.set(u.id, 1);
    return true;
}
function botAttack(u, targetId) {
    if (botCalls >= BOT_BUDGET) {
        return;
    }
    botCalls += 1;
    attack(u.id, targetId);
    botActed.set(u.id, 1);
}
function botSpawn(baseId, makeWorker) {
    if (botCalls + 2 > BOT_BUDGET) {
        return false;
    }
    botCalls += 2;
    const result = makeWorker ? spawnUnit(baseId, "worker") : spawnUnit(baseId, "melee");
    if (isError(result)) {
        return false;
    }
    return true;
}
function botTick() {
    botCalls = 0;
    botWork = 0;
    botResv = new Map();
    botTerr = new Map();
    botOcc = new Map();
    botAvoid = new Map();
    botActed = new Map();
    if (botMyIndex < 0) {
        botMyIndex = getMyIndex();
    }
    botCalls += 1;
    const me = botMyIndex;
    const tick = getTick();
    botCalls += 1;
    botTickNo = tick;
    const players = getObjectsByType("player");
    botCalls += 1;
    let resources = 0;
    let alive = false;
    for (let i = 0; i < players.length; i += 1) {
        const p = players[i];
        if (p === undefined) {
            continue;
        }
        if (p.index === me) {
            resources = p.resources;
            alive = p.alive;
        }
    }
    if (!alive) {
        return;
    }
    const allUnits = getObjectsByType("unit");
    botCalls += 1;
    const allSites = getObjectsByType("site");
    botCalls += 1;
    const workers = [];
    const army = [];
    const enemies = [];
    const newKey = new Map();
    const newStuck = new Map();
    for (let i = 0; i < allUnits.length; i += 1) {
        const u = allUnits[i];
        if (u === undefined) {
            continue;
        }
        const k = u.x * BOT_STRIDE + u.y;
        botOcc.set(k, u.owner);
        if (u.owner === me) {
            if (u.type === "worker") {
                workers.push(u);
            }
            else {
                army.push(u);
            }
            const pk = botPrevKey.get(u.id);
            const pw = botPrevWant.get(u.id);
            let s = botStuck.get(u.id) ?? 0;
            s = pk === k && pw === 1 ? s + 1 : 0;
            newKey.set(u.id, k);
            newStuck.set(u.id, s);
        }
        else {
            enemies.push(u);
        }
    }
    botPrevKey = newKey;
    botStuck = newStuck;
    const myBases = [];
    const myRes = [];
    const mySites = [];
    const targets = [];
    let sumX = 0;
    let sumY = 0;
    let nSites = 0;
    for (let i = 0; i < allSites.length; i += 1) {
        const s = allSites[i];
        if (s === undefined) {
            continue;
        }
        sumX += s.x;
        sumY += s.y;
        nSites += 1;
        if (s.owner === me) {
            mySites.push(s);
            if (s.kind === "base") {
                myBases.push(s);
                botAvoid.set(s.x * BOT_STRIDE + s.y, s.id);
            }
            else {
                const rem = s.remaining;
                if (rem === undefined || rem > 0) {
                    myRes.push(s);
                }
            }
        }
        else {
            targets.push(s);
        }
    }
    if (botHomeX < 0) {
        const b0 = myBases[0];
        if (b0 !== undefined) {
            botHomeX = b0.x;
            botHomeY = b0.y;
        }
    }
    let homeX = botHomeX;
    let homeY = botHomeY;
    if (homeX < 0) {
        const fu = army[0] ?? workers[0];
        if (fu !== undefined) {
            homeX = fu.x;
            homeY = fu.y;
        }
        else {
            homeX = 0;
            homeY = 0;
        }
    }
    let rx = homeX;
    let ry = homeY;
    if (nSites > 0) {
        const cx = botDiv(sumX, nSites);
        const cy = botDiv(sumY, nSites);
        rx = homeX + botDiv(cx - homeX, 4);
        ry = homeY + botDiv(cy - homeY, 4);
        if (!botPlain(rx, ry)) {
            rx = homeX;
            ry = homeY;
        }
    }
    // ---------- 农民:采集与交付 ----------
    const resLoad = [];
    for (let j = 0; j < myRes.length; j += 1) {
        resLoad.push(0);
    }
    const idleWorkers = [];
    const newMine = new Map();
    for (let i = 0; i < workers.length; i += 1) {
        const w = workers[i];
        if (w === undefined) {
            continue;
        }
        const onBase = botAvoid.has(w.x * BOT_STRIDE + w.y);
        let bBest = null;
        let bD = 0;
        for (let j = 0; j < myBases.length; j += 1) {
            const b = myBases[j];
            if (b === undefined) {
                continue;
            }
            botWork += 1;
            const d = botDist(w.x, w.y, b.x, b.y);
            if (bBest === null || d < bD || (d === bD && b.id < bBest.id)) {
                bBest = b;
                bD = d;
            }
        }
        if (w.carrying >= BOT_CARRY || (w.carrying > 0 && myRes.length === 0)) {
            if (bBest === null) {
                idleWorkers.push(w);
            }
            else if (bD === 1) {
                if (botCalls < BOT_BUDGET) {
                    botCalls += 1;
                    const r = transfer(w.id);
                    botActed.set(w.id, 1);
                    if (isError(r)) {
                        botShift(w, bBest.x, bBest.y, 1);
                    }
                }
            }
            else if (bD === 0) {
                botShift(w, bBest.x, bBest.y, 1);
            }
            else {
                botNav(w, bBest.x, bBest.y, 1);
            }
            continue;
        }
        const prev = botMineOf.get(w.id);
        let rBest = -1;
        let rCost = 0;
        let rD = 0;
        for (let j = 0; j < myRes.length; j += 1) {
            const s = myRes[j];
            if (s === undefined) {
                continue;
            }
            botWork += 1;
            const d = botDist(w.x, w.y, s.x, s.y);
            let c = d + 4 * (resLoad[j] ?? 0);
            if (prev !== undefined && s.id === prev) {
                c -= 4;
            }
            if (rBest < 0 || c < rCost) {
                rBest = j;
                rCost = c;
                rD = d;
            }
        }
        const site = rBest >= 0 ? myRes[rBest] : undefined;
        if (site === undefined) {
            idleWorkers.push(w);
            continue;
        }
        newMine.set(w.id, site.id);
        resLoad[rBest] = (resLoad[rBest] ?? 0) + 1;
        if (rD === 1 && !onBase) {
            if (botCalls < BOT_BUDGET) {
                botCalls += 1;
                const r = harvest(w.id, site.id);
                botActed.set(w.id, 1);
                if (isError(r)) {
                    botShift(w, site.x, site.y, 1);
                }
            }
        }
        else if (rD <= 1) {
            botShift(w, site.x, site.y, 1);
        }
        else if (w.carrying >= 10 && bBest !== null && bD === 1) {
            if (botCalls < BOT_BUDGET) {
                botCalls += 1;
                transfer(w.id);
                botActed.set(w.id, 1);
            }
        }
        else {
            botNav(w, site.x, site.y, 1);
        }
    }
    botMineOf = newMine;
    // ---------- 威胁 ----------
    const threats = [];
    let combatThreat = 0;
    for (let i = 0; i < enemies.length; i += 1) {
        if (botWork > BOT_WORK_BUDGET) {
            break;
        }
        const e = enemies[i];
        if (e === undefined) {
            continue;
        }
        let hit = false;
        for (let j = 0; j < mySites.length; j += 1) {
            const s = mySites[j];
            botWork += 1;
            if (s !== undefined && botDist(e.x, e.y, s.x, s.y) <= 4) {
                hit = true;
                break;
            }
        }
        if (!hit) {
            for (let j = 0; j < workers.length; j += 1) {
                const w = workers[j];
                botWork += 1;
                if (w !== undefined && botDist(e.x, e.y, w.x, w.y) <= 3) {
                    hit = true;
                    break;
                }
            }
        }
        if (hit) {
            threats.push(e);
            if (e.type !== "worker") {
                combatThreat += 1;
            }
        }
    }
    // ---------- 目标点位 ----------
    const taken = [];
    const targetAt = new Map();
    for (let i = 0; i < targets.length; i += 1) {
        const s = targets[i];
        if (s === undefined) {
            taken.push(true);
            continue;
        }
        taken.push(false);
        targetAt.set(s.x * BOT_STRIDE + s.y, i);
    }
    const done = [];
    for (let i = 0; i < army.length; i += 1) {
        done.push(false);
    }
    // A. 射程内先打
    for (let i = 0; i < army.length; i += 1) {
        if (botWork > BOT_WORK_BUDGET) {
            break;
        }
        const u = army[i];
        if (u === undefined) {
            continue;
        }
        const r = u.type === "ranged" ? 2 : 1;
        let best = null;
        for (let j = 0; j < enemies.length; j += 1) {
            const e = enemies[j];
            if (e === undefined) {
                continue;
            }
            botWork += 1;
            if (botDist(u.x, u.y, e.x, e.y) > r) {
                continue;
            }
            if (best === null || e.hp < best.hp || (e.hp === best.hp && e.id < best.id)) {
                best = e;
            }
        }
        if (best !== null) {
            botAttack(u, best.id);
            done[i] = true;
        }
    }
    // B. 已站在目标点位格上:原地推进占领
    for (let i = 0; i < army.length; i += 1) {
        const u = army[i];
        if (u === undefined) {
            continue;
        }
        const ti = targetAt.get(u.x * BOT_STRIDE + u.y);
        if (ti === undefined) {
            continue;
        }
        taken[ti] = true;
        done[i] = true;
        botActed.set(u.id, 1);
    }
    const idleDone = [];
    for (let i = 0; i < idleWorkers.length; i += 1) {
        const w = idleWorkers[i];
        let stay = false;
        if (w !== undefined) {
            const ti = targetAt.get(w.x * BOT_STRIDE + w.y);
            if (ti !== undefined && !taken[ti]) {
                taken[ti] = true;
                stay = true;
                botActed.set(w.id, 1);
            }
        }
        idleDone.push(stay);
    }
    // C. 迎击威胁
    const threatCap = threats.length < 12 ? threats.length : 12;
    for (let t = 0; t < threatCap; t += 1) {
        if (botWork > BOT_WORK_BUDGET) {
            break;
        }
        const e = threats[t];
        if (e === undefined) {
            continue;
        }
        const need = e.type === "worker" ? 1 : 2;
        for (let k = 0; k < need; k += 1) {
            let pick = -1;
            let pickD = 0;
            for (let i = 0; i < army.length; i += 1) {
                if (done[i]) {
                    continue;
                }
                const u = army[i];
                if (u === undefined) {
                    continue;
                }
                botWork += 1;
                const d = botDist(u.x, u.y, e.x, e.y);
                if (d > 12) {
                    continue;
                }
                if (pick < 0 || d < pickD) {
                    pick = i;
                    pickD = d;
                }
            }
            const pu = pick >= 0 ? army[pick] : undefined;
            if (pu === undefined) {
                break;
            }
            done[pick] = true;
            botNav(pu, e.x, e.y, 1);
        }
    }
    // D. 抢点:中立点位与无人防守的敌方点位
    let avail = 0;
    for (let i = 0; i < army.length; i += 1) {
        if (!done[i]) {
            avail += 1;
        }
    }
    let guardQuota = 0;
    if (tick >= 120) {
        guardQuota = myBases.length < 2 ? myBases.length : 2;
    }
    const maxCap = avail - guardQuota;
    const nOrder = [];
    const nPrio = [];
    for (let i = 0; i < targets.length; i += 1) {
        const s = targets[i];
        nPrio.push(0);
        if (s === undefined || taken[i]) {
            continue;
        }
        if (botWork > BOT_WORK_BUDGET) {
            break;
        }
        let near = 0;
        for (let j = 0; j < enemies.length; j += 1) {
            const e = enemies[j];
            botWork += 1;
            if (e !== undefined && e.type !== "worker" && botDist(e.x, e.y, s.x, s.y) <= 3) {
                near += 1;
            }
        }
        if (s.owner !== -1 && (near > 0 || tick < 60)) {
            continue;
        }
        let p = botDist(homeX, homeY, s.x, s.y);
        for (let j = 0; j < myBases.length; j += 1) {
            const b = myBases[j];
            if (b === undefined) {
                continue;
            }
            botWork += 1;
            const d = botDist(b.x, b.y, s.x, s.y);
            if (d < p) {
                p = d;
            }
        }
        if (s.kind === "base") {
            p -= 6;
        }
        if (s.progressOwner === me && s.progress > 0) {
            p -= 5;
        }
        if (s.owner !== -1) {
            p += 4;
        }
        p += 3 * near;
        const occ = botOcc.get(s.x * BOT_STRIDE + s.y);
        if (occ !== undefined && occ !== me) {
            p += 4;
        }
        nPrio[i] = p;
        nOrder.push(i);
    }
    nOrder.sort((a, b) => {
        const pa = nPrio[a] ?? 0;
        const pb = nPrio[b] ?? 0;
        if (pa !== pb) {
            return pa - pb;
        }
        return a - b;
    });
    let caps = 0;
    for (let oi = 0; oi < nOrder.length; oi += 1) {
        if (caps >= maxCap || botWork > BOT_WORK_BUDGET) {
            break;
        }
        const ti = nOrder[oi];
        if (ti === undefined || taken[ti]) {
            continue;
        }
        const s = targets[ti];
        if (s === undefined) {
            continue;
        }
        let pick = -1;
        let pickD = 0;
        for (let i = 0; i < army.length; i += 1) {
            if (done[i]) {
                continue;
            }
            const u = army[i];
            if (u === undefined) {
                continue;
            }
            botWork += 1;
            const d = botDist(u.x, u.y, s.x, s.y);
            if (pick < 0 || d < pickD) {
                pick = i;
                pickD = d;
            }
        }
        const pu = pick >= 0 ? army[pick] : undefined;
        if (pu === undefined) {
            break;
        }
        done[pick] = true;
        taken[ti] = true;
        caps += 1;
        botNav(pu, s.x, s.y, 0);
    }
    // E. 成团进攻敌方点位
    let remain = 0;
    for (let i = 0; i < army.length; i += 1) {
        if (!done[i]) {
            remain += 1;
        }
    }
    const attackers = remain - guardQuota;
    if (attackers >= 5 || (tick >= 400 && attackers >= 3)) {
        let gBest = null;
        let gP = 0;
        for (let i = 0; i < targets.length; i += 1) {
            if (botWork > BOT_WORK_BUDGET) {
                break;
            }
            const s = targets[i];
            if (s === undefined || s.owner === -1) {
                continue;
            }
            let p = botDist(homeX, homeY, s.x, s.y);
            for (let j = 0; j < enemies.length; j += 1) {
                const e = enemies[j];
                botWork += 1;
                if (e !== undefined && e.type !== "worker" && botDist(e.x, e.y, s.x, s.y) <= 3) {
                    p += 3;
                }
            }
            if (s.progressOwner === me && s.progress > 0) {
                p -= 8;
            }
            if (s.kind === "base") {
                p -= 4;
            }
            if (gBest === null || p < gP || (p === gP && s.id < gBest.id)) {
                gBest = s;
                gP = p;
            }
        }
        if (gBest !== null) {
            const gOcc = botOcc.get(gBest.x * BOT_STRIDE + gBest.y);
            let sent = 0;
            for (let i = 0; i < army.length; i += 1) {
                if (sent >= attackers) {
                    break;
                }
                if (done[i]) {
                    continue;
                }
                const u = army[i];
                if (u === undefined) {
                    continue;
                }
                done[i] = true;
                sent += 1;
                botActed.set(u.id, 1);
                if (botDist(u.x, u.y, gBest.x, gBest.y) <= 1 && gOcc === me) {
                    continue;
                }
                botNav(u, gBest.x, gBest.y, 0);
            }
        }
    }
    // F. 其余守家:分到各己方基地附近,不站基地格
    const guardCnt = [];
    for (let j = 0; j < myBases.length; j += 1) {
        guardCnt.push(0);
    }
    for (let i = 0; i < army.length; i += 1) {
        if (done[i]) {
            continue;
        }
        const u = army[i];
        if (u === undefined) {
            continue;
        }
        done[i] = true;
        let pick = -1;
        let pickS = 0;
        for (let j = 0; j < myBases.length; j += 1) {
            const b = myBases[j];
            if (b === undefined) {
                continue;
            }
            botWork += 1;
            const s = botDist(u.x, u.y, b.x, b.y) + 6 * (guardCnt[j] ?? 0);
            if (pick < 0 || s < pickS) {
                pick = j;
                pickS = s;
            }
        }
        const gb = pick >= 0 ? myBases[pick] : undefined;
        let gx = rx;
        let gy = ry;
        if (gb !== undefined) {
            guardCnt[pick] = (guardCnt[pick] ?? 0) + 1;
            gx = gb.x;
            gy = gb.y;
        }
        if (botAvoid.has(u.x * BOT_STRIDE + u.y)) {
            botShift(u, gx, gy, 2);
            continue;
        }
        if (botDist(u.x, u.y, gx, gy) > 2) {
            botNav(u, gx, gy, 2);
        }
        else {
            botActed.set(u.id, 1);
        }
    }
    // 无活可干的农民:去抢中立点位
    for (let i = 0; i < idleWorkers.length; i += 1) {
        if (idleDone[i]) {
            continue;
        }
        const w = idleWorkers[i];
        if (w === undefined) {
            continue;
        }
        let pick = -1;
        let pickD = 0;
        for (let ti = 0; ti < targets.length; ti += 1) {
            if (taken[ti]) {
                continue;
            }
            const s = targets[ti];
            if (s === undefined || s.owner !== -1) {
                continue;
            }
            if (botOcc.has(s.x * BOT_STRIDE + s.y)) {
                continue;
            }
            botWork += 1;
            const d = botDist(w.x, w.y, s.x, s.y);
            if (pick < 0 || d < pickD) {
                pick = ti;
                pickD = d;
            }
        }
        const ps = pick >= 0 ? targets[pick] : undefined;
        if (ps !== undefined) {
            taken[pick] = true;
            botNav(w, ps.x, ps.y, 0);
        }
    }
    // 站在己方基地格上又没有意图的单位:让开出兵格
    for (let i = 0; i < workers.length + army.length; i += 1) {
        const u = i < workers.length ? workers[i] : army[i - workers.length];
        if (u === undefined || botActed.has(u.id)) {
            continue;
        }
        if (botAvoid.has(u.x * BOT_STRIDE + u.y)) {
            botShift(u, rx, ry, 99);
        }
    }
    // ---------- 生产:产线空才下单 ----------
    let wc = workers.length;
    let ac = army.length;
    for (let i = 0; i < myBases.length; i += 1) {
        const b = myBases[i];
        if (b === undefined || b.producing === null) {
            continue;
        }
        if (b.producing.type === "worker") {
            wc += 1;
        }
        else {
            ac += 1;
        }
    }
    let workerTarget = myRes.length * 3;
    if (myRes.length > 0 && workerTarget < 4) {
        workerTarget = 4;
    }
    if (workerTarget > BOT_MAX_WORKERS) {
        workerTarget = BOT_MAX_WORKERS;
    }
    for (let i = 0; i < myBases.length; i += 1) {
        const b = myBases[i];
        if (b === undefined || b.producing !== null) {
            continue;
        }
        let wantWorker = false;
        if (tick < 520 && wc < workerTarget) {
            if (wc < 3) {
                wantWorker = true;
            }
            else if (combatThreat > 0 && ac < combatThreat * 2 + 2) {
                wantWorker = false;
            }
            else {
                wantWorker = wc < ac + 4;
            }
        }
        if (wantWorker) {
            if (resources >= BOT_WORKER_COST && botSpawn(b.id, true)) {
                resources -= BOT_WORKER_COST;
                wc += 1;
            }
        }
        else if (resources >= BOT_MELEE_COST) {
            if (botSpawn(b.id, false)) {
                resources -= BOT_MELEE_COST;
                ac += 1;
            }
        }
        else if ((tick >= 560 || (wc === 0 && myRes.length > 0)) && resources >= BOT_WORKER_COST) {
            if (botSpawn(b.id, true)) {
                resources -= BOT_WORKER_COST;
                wc += 1;
            }
        }
    }
}
