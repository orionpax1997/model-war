"use strict";
var capUnitIds = [];
var capSiteIds = [];
var occ = {};
var siteAt = {};
var baseAt = {};
var foeAt = {};
function cheb(ax, ay, bx, by) {
    const dx = ax > bx ? ax - bx : bx - ax;
    const dy = ay > by ? ay - by : by - ay;
    return dx > dy ? dx : dy;
}
function cellKey(x, y) {
    return (x + 1000) * 10000 + (y + 1000);
}
function indexById(list) {
    const m = {};
    for (let i = 0; i < list.length; i += 1) {
        const e = list[i];
        if (e === undefined) {
            continue;
        }
        m[e.id] = e;
    }
    return m;
}
function nearestOf(list, x, y) {
    let best = null;
    let bestD = 999999;
    for (let i = 0; i < list.length; i += 1) {
        const e = list[i];
        if (e === undefined) {
            continue;
        }
        const d = cheb(x, y, e.x, e.y);
        if (d < bestD) {
            bestD = d;
            best = e;
        }
    }
    return best;
}
function adjCell(tx, ty, ux, uy) {
    let best = null;
    let bestD = 99;
    for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) {
                continue;
            }
            const x = tx + dx;
            const y = ty + dy;
            const k = cellKey(x, y);
            if (occ[k] === true || siteAt[k] === true) {
                continue;
            }
            if (getTerrainAt(x, y) !== "plain") {
                continue;
            }
            const d = cheb(ux, uy, x, y);
            if (d < bestD) {
                bestD = d;
                best = { x: x, y: y };
            }
        }
    }
    if (best !== null) {
        occ[cellKey(best.x, best.y)] = true;
    }
    return best;
}
function stepDeliver(id, x, y, bases) {
    const b = nearestOf(bases, x, y);
    if (b === null) {
        return;
    }
    if (cheb(x, y, b.x, b.y) === 1) {
        transfer(id);
        return;
    }
    const c = adjCell(b.x, b.y, x, y);
    if (c !== null) {
        moveTo(id, c.x, c.y);
    }
}
function stepHarvest(id, x, y, res) {
    const r = nearestOf(res, x, y);
    if (r === null) {
        return;
    }
    if (cheb(x, y, r.x, r.y) === 1) {
        harvest(id, r.id);
        return;
    }
    const c = adjCell(r.x, r.y, x, y);
    if (c !== null) {
        moveTo(id, c.x, c.y);
    }
}
function loop() {
    const me = getMyIndex();
    const tick = getTick();
    const players = getObjectsByType("player");
    const mine = players[me];
    if (mine === undefined) {
        return;
    }
    const units = getObjectsByType("unit");
    const sites = getObjectsByType("site");
    occ = {};
    siteAt = {};
    baseAt = {};
    foeAt = {};
    const myBases = [];
    const myRes = [];
    const neutralRes = [];
    for (let i = 0; i < sites.length; i += 1) {
        const s = sites[i];
        if (s === undefined) {
            continue;
        }
        siteAt[cellKey(s.x, s.y)] = true;
        if (s.kind === "base") {
            if (s.owner === me) {
                myBases.push(s);
                baseAt[cellKey(s.x, s.y)] = true;
            }
        }
        else {
            if (s.owner === me && (s.remaining === undefined || s.remaining > 0)) {
                myRes.push(s);
            }
            else if (s.owner === -1) {
                neutralRes.push(s);
            }
        }
    }
    const myUnits = [];
    const foes = [];
    const workers = [];
    let armyCount = 0;
    let meleeCount = 0;
    let rangedCount = 0;
    for (let i = 0; i < units.length; i += 1) {
        const u = units[i];
        if (u === undefined) {
            continue;
        }
        occ[cellKey(u.x, u.y)] = true;
        if (u.owner === me) {
            myUnits.push(u);
            if (u.type === "worker") {
                workers.push(u);
            }
            else {
                armyCount += 1;
                if (u.type === "melee") {
                    meleeCount += 1;
                }
                else if (u.type === "ranged") {
                    rangedCount += 1;
                }
            }
        }
        else {
            foes.push(u);
            foeAt[cellKey(u.x, u.y)] = true;
        }
    }
    const unitById = indexById(myUnits);
    const siteById = indexById(sites);
    const handled = {};
    // 1) 维持已派出的占领者:站上点位才驱动,站旁边不算
    const keepU = [];
    const keepS = [];
    for (let k = 0; k < capUnitIds.length; k += 1) {
        const uid = capUnitIds[k];
        const sid = capSiteIds[k];
        if (uid === undefined || sid === undefined) {
            continue;
        }
        const u = unitById[uid];
        const s = siteById[sid];
        if (u === undefined || s === undefined || s.owner !== -1) {
            continue;
        }
        keepU.push(uid);
        keepS.push(sid);
        handled[uid] = true;
        if (u.x !== s.x || u.y !== s.y) {
            moveTo(uid, s.x, s.y);
        }
    }
    capUnitIds = keepU;
    capSiteIds = keepS;
    // 2) 腾出自家基地格:单位站在出兵格上会挂起产线
    for (let i = 0; i < myUnits.length; i += 1) {
        const u = myUnits[i];
        if (u === undefined || handled[u.id] === true) {
            continue;
        }
        if (baseAt[cellKey(u.x, u.y)] === true) {
            handled[u.id] = true;
            const c = adjCell(u.x, u.y, u.x, u.y);
            if (c !== null) {
                moveTo(u.id, c.x, c.y);
            }
        }
    }
    // 3) 扩张:派农民去占中立资源点(只用农民,不动正在采的人太多)
    if (tick >= 20 && workers.length >= 5 && capUnitIds.length < 2) {
        for (let si = 0; si < neutralRes.length && capUnitIds.length < 2; si += 1) {
            const site = neutralRes[si];
            if (site === undefined || capSiteIds.indexOf(site.id) >= 0) {
                continue;
            }
            if (foeAt[cellKey(site.x, site.y)] === true) {
                continue;
            }
            let bestId = -1;
            let bestD = 999;
            for (let wi = 0; wi < workers.length; wi += 1) {
                const w = workers[wi];
                if (w === undefined || handled[w.id] === true || w.carrying > 0) {
                    continue;
                }
                const d = cheb(w.x, w.y, site.x, site.y);
                if (d < bestD) {
                    bestD = d;
                    bestId = w.id;
                }
            }
            if (bestId >= 0) {
                capUnitIds.push(bestId);
                capSiteIds.push(site.id);
                handled[bestId] = true;
                moveTo(bestId, site.x, site.y);
            }
        }
    }
    // 4) 经济:采集与交付
    for (let i = 0; i < workers.length; i += 1) {
        const w = workers[i];
        if (w === undefined || handled[w.id] === true) {
            continue;
        }
        if (w.carrying >= 20) {
            stepDeliver(w.id, w.x, w.y, myBases);
            continue;
        }
        if (myRes.length === 0) {
            if (w.carrying > 0) {
                stepDeliver(w.id, w.x, w.y, myBases);
            }
            continue;
        }
        stepHarvest(w.id, w.x, w.y, myRes);
    }
    // 5) 军事:稳住阵地;经济够了、兵够了再推进
    const attackMode = tick >= 200 && armyCount >= 10;
    for (let i = 0; i < myUnits.length; i += 1) {
        const u = myUnits[i];
        if (u === undefined || u.type === "worker" || handled[u.id] === true) {
            continue;
        }
        const t = nearestOf(foes, u.x, u.y);
        if (t === null) {
            continue;
        }
        const d = cheb(u.x, u.y, t.x, t.y);
        if (!attackMode && d > 4) {
            continue;
        }
        const range = u.type === "ranged" ? 2 : 1;
        if (d <= range) {
            attack(u.id, t.id);
        }
        else {
            moveTo(u.id, t.x, t.y);
        }
    }
    // 6) 生产:先补农民到目标数,再按家底转军事
    let econTarget = 6 + 2 * myRes.length;
    if (econTarget > 16) {
        econTarget = 16;
    }
    let res = mine.resources;
    let W = workers.length;
    let M = meleeCount;
    let R = rangedCount;
    for (let bi = 0; bi < myBases.length; bi += 1) {
        const b = myBases[bi];
        if (b === undefined || b.producing !== null) {
            continue;
        }
        if (W < econTarget && res >= 4) {
            if (!isError(spawnUnit(b.id, "worker"))) {
                res -= 4;
                W += 1;
            }
            continue;
        }
        if (tick >= 100 && W >= econTarget - 2) {
            if (R * 2 < M && res >= 12) {
                if (!isError(spawnUnit(b.id, "ranged"))) {
                    res -= 12;
                    R += 1;
                }
            }
            else if (res >= 8) {
                if (!isError(spawnUnit(b.id, "melee"))) {
                    res -= 8;
                    M += 1;
                }
            }
        }
    }
}
