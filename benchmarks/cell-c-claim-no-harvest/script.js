"use strict";
// script.ts
// 策略 C：占点不采集。
// 产能只投向战斗单位，靠占点扩张与压制；不造农民、不安排采集。
//
// 契约要点：
//  - 座位只从 getMyIndex() 认，读一次存进模块级变量。
//  - 跨 tick 变量只放数值，不缓存对象引用与查询结果。
//  - 每个单位每 tick 只提交一条单位级意图（attack 或 moveTo）。
//  - 下单前先读 producing，非 null 不下单。
//  - 错误只用 isError / errCode 两步判别，不用 typeof 或真值。
//  - 全整数运算。
var myIndex = -1;
function loop() {
    if (myIndex < 0) {
        myIndex = getMyIndex();
    }
    var players = getObjectsByType("player");
    var mePlayer = players[myIndex];
    var money = 0;
    if (mePlayer !== undefined) {
        money = mePlayer.resources;
    }
    // 生产：每条空产线下一单近战。已有订单静默跳过（先读 producing）。
    var bases = getObjectsByType("site", { owner: myIndex, kind: "base" });
    for (var bi = 0; bi < bases.length; bi += 1) {
        var base = bases[bi];
        if (base === undefined) {
            continue;
        }
        if (base.producing !== null) {
            continue;
        }
        if (money < 8) {
            continue;
        }
        var spawned = spawnUnit(base.id, "melee");
        if (isError(spawned)) {
            var spawnCode = errCode(spawned);
            if (spawnCode === ERR_NOT_ENOUGH_RESOURCES) {
                money = 0;
            }
        }
        else {
            money = money - 8;
        }
    }
    var units = getObjectsByType("unit", { owner: myIndex });
    var allUnits = getObjectsByType("unit");
    var sites = getObjectsByType("site");
    var claimed = [];
    var claimedCount = 0;
    var offDx = [1, -1, 0, 0, 1, 1, -1, -1];
    var offDy = [0, 0, 1, -1, 1, -1, 1, -1];
    for (var ui = 0; ui < units.length; ui += 1) {
        var unit = units[ui];
        if (unit === undefined) {
            continue;
        }
        // 一、射程内有敌人：只提交攻击这一条意图。
        var foeId = nearestFoeInRange(unit, allUnits, myIndex);
        if (foeId >= 0) {
            attack(unit.id, foeId);
            continue;
        }
        // 二、否则去占一个还没分出去的中立/敌方位点。
        var siteIndex = pickSite(unit, sites, claimed, claimedCount, myIndex);
        if (siteIndex < 0) {
            continue;
        }
        var site = sites[siteIndex];
        claimed[claimedCount] = site.id;
        claimedCount = claimedCount + 1;
        // 已与点位相邻：原地驻守，让占领进度累积，不再提交移动。
        // 站点格本身多半不可站立（采集规则要求站在相邻格），所以占领靠相邻。
        if (getRange(unit.x, unit.y, site.x, site.y) <= 1) {
            continue;
        }
        // 选一个相邻的可通行格作为落脚点，朝它走一步。
        var destX = -1;
        var destY = -1;
        var haveDest = 0;
        var bestD = 0;
        for (var oi = 0; oi < 8; oi += 1) {
            var nx = site.x + offDx[oi];
            var ny = site.y + offDy[oi];
            if (getTerrainAt(nx, ny) !== "plain") {
                continue;
            }
            var nd = getRange(unit.x, unit.y, nx, ny);
            if (haveDest === 0 || nd < bestD) {
                destX = nx;
                destY = ny;
                bestD = nd;
                haveDest = 1;
            }
        }
        if (haveDest === 1) {
            moveTo(unit.id, destX, destY);
        }
    }
}
// 本 tick 射程内最近的敌方单位 id；没有则 -1。射程外的敌人不追。
function nearestFoeInRange(unit, allUnits, me) {
    var rng = 0;
    if (unit.type === "melee") {
        rng = 1;
    }
    else if (unit.type === "ranged") {
        rng = 2;
    }
    else if (unit.type === "cavalry") {
        rng = 1;
    }
    else {
        rng = 0;
    }
    if (rng === 0) {
        return -1;
    }
    var best = -1;
    var bestD = 0;
    for (var i = 0; i < allUnits.length; i += 1) {
        var foe = allUnits[i];
        if (foe === undefined) {
            continue;
        }
        if (foe.owner === me) {
            continue;
        }
        var d = getRange(unit.x, unit.y, foe.x, foe.y);
        if (d > rng) {
            continue;
        }
        if (best === -1 || d < bestD) {
            best = foe.id;
            bestD = d;
        }
    }
    return best;
}
// 为本单位挑一个可占点位：先找中立，其次敌方，且本 tick 尚未分配给别的单位。
// 返回 sites 数组下标；没有可占点位时返回 -1。
function pickSite(unit, sites, claimed, claimedCount, me) {
    for (var pass = 0; pass < 2; pass += 1) {
        var best = -1;
        var bestD = 0;
        for (var i = 0; i < sites.length; i += 1) {
            var s = sites[i];
            if (s === undefined) {
                continue;
            }
            if (s.owner === me) {
                continue;
            }
            var neutral = s.owner === -1;
            if (pass === 0 && neutral === false) {
                continue;
            }
            if (pass === 1 && neutral === true) {
                continue;
            }
            if (isClaimed(s.id, claimed, claimedCount)) {
                continue;
            }
            var d = getRange(unit.x, unit.y, s.x, s.y);
            if (best === -1 || d < bestD) {
                best = i;
                bestD = d;
            }
        }
        if (best !== -1) {
            return best;
        }
    }
    return -1;
}
function isClaimed(id, claimed, claimedCount) {
    for (var i = 0; i < claimedCount; i += 1) {
        if (claimed[i] === id) {
            return true;
        }
    }
    return false;
}
