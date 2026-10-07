"use strict";
// script.ts — 四方 RTS 参赛脚本（策略取向 A：爆兵压制）
// 单文件自包含；顶层声明入口 loop()。
// 不含模块语法、动态求值、非确定源或宿主桥。
// 模块级只保留数值记忆（座位号），其余每 tick 重新查询快照。
var me = -1;
var desiredWorkers = 2;
function loop() {
    if (me < 0) {
        me = getMyIndex();
    }
    const players = getObjectsByType("player");
    const self = players[me];
    if (self === undefined) {
        return;
    }
    const allUnits = getObjectsByType("unit");
    const allSites = getObjectsByType("site");
    // 玩家级意图：先把每条空产线补上（读 producing，空才下单）。
    produce(allUnits, allSites, self.resources);
    // 单位级意图：每个单位本 tick 只提交一条。
    for (let i = 0; i < allUnits.length; i += 1) {
        const unit = allUnits[i];
        if (unit === undefined) {
            continue;
        }
        if (unit.owner !== me) {
            continue;
        }
        if (unit.type === "worker") {
            actWorker(unit, allSites);
        }
        else {
            actFighter(unit, allUnits, allSites);
        }
    }
}
/** 爆兵优先：留够基础农民后，剩余资源全部投入近战。 */
function produce(allUnits, allSites, resources) {
    let workers = 0;
    for (let i = 0; i < allUnits.length; i += 1) {
        const unit = allUnits[i];
        if (unit === undefined) {
            continue;
        }
        if (unit.owner === me && unit.type === "worker") {
            workers += 1;
        }
    }
    let budget = resources;
    for (let i = 0; i < allSites.length; i += 1) {
        const site = allSites[i];
        if (site === undefined) {
            continue;
        }
        if (site.owner !== me || site.kind !== "base") {
            continue;
        }
        // 产线已有订单时重复下单会被静默丢弃，所以先读 producing，空才下单。
        if (site.producing !== null) {
            continue;
        }
        let choice = null;
        if (workers < desiredWorkers && budget >= 4) {
            choice = "worker";
        }
        else if (budget >= 8) {
            choice = "melee";
        }
        if (choice === null) {
            continue;
        }
        const result = spawnUnit(site.id, choice);
        if (isError(result)) {
            // 落在「丢弃」：只丢这一单，不扣款、不计异常，其余意图照常。
            continue;
        }
        if (choice === "worker") {
            workers += 1;
            budget -= 4;
        }
        else {
            budget -= 8;
        }
    }
}
/** 农民：满载就回最近己方基地交付，否则去最近己方资源点采集。 */
function actWorker(unit, allSites) {
    if (unit.carrying >= 20) {
        let adjacentBase = -1;
        let bestBaseX = 0;
        let bestBaseY = 0;
        let bestBaseDist = 1000000;
        for (let i = 0; i < allSites.length; i += 1) {
            const site = allSites[i];
            if (site === undefined) {
                continue;
            }
            if (site.owner !== me || site.kind !== "base") {
                continue;
            }
            const d = getRange(unit.x, unit.y, site.x, site.y);
            if (d <= 1) {
                // 相邻多个己方基地时，交给数值 id 最小的那个。
                if (adjacentBase < 0 || site.id < adjacentBase) {
                    adjacentBase = site.id;
                }
            }
            if (d < bestBaseDist) {
                bestBaseDist = d;
                bestBaseX = site.x;
                bestBaseY = site.y;
            }
        }
        if (adjacentBase >= 0) {
            transfer(unit.id);
            return;
        }
        if (bestBaseDist < 1000000) {
            moveTo(unit.id, bestBaseX, bestBaseY);
        }
        return;
    }
    let bestSiteId = -1;
    let bestSiteX = 0;
    let bestSiteY = 0;
    let bestSiteDist = 1000000;
    for (let i = 0; i < allSites.length; i += 1) {
        const site = allSites[i];
        if (site === undefined) {
            continue;
        }
        if (site.owner !== me || site.kind !== "resource") {
            continue;
        }
        if (site.remaining !== undefined && site.remaining <= 0) {
            continue;
        }
        const d = getRange(unit.x, unit.y, site.x, site.y);
        if (d < bestSiteDist) {
            bestSiteDist = d;
            bestSiteId = site.id;
            bestSiteX = site.x;
            bestSiteY = site.y;
        }
    }
    if (bestSiteId < 0) {
        return;
    }
    if (bestSiteDist <= 1) {
        harvest(unit.id, bestSiteId);
    }
    else {
        moveTo(unit.id, bestSiteX, bestSiteY);
    }
}
/** 战斗单位：射程内就攻击，否则逼近最近敌人；无敌人时去占最近的非己方点位。 */
function actFighter(unit, allUnits, allSites) {
    const range = unit.type === "ranged" ? 2 : 1;
    let foeId = -1;
    let foeX = 0;
    let foeY = 0;
    let foeDist = 1000000;
    for (let i = 0; i < allUnits.length; i += 1) {
        const foe = allUnits[i];
        if (foe === undefined) {
            continue;
        }
        if (foe.owner === me) {
            continue;
        }
        const d = getRange(unit.x, unit.y, foe.x, foe.y);
        if (d < foeDist) {
            foeDist = d;
            foeId = foe.id;
            foeX = foe.x;
            foeY = foe.y;
        }
    }
    if (foeId >= 0) {
        if (foeDist <= range) {
            attack(unit.id, foeId);
        }
        else {
            moveTo(unit.id, foeX, foeY);
        }
        return;
    }
    let siteId = -1;
    let siteX = 0;
    let siteY = 0;
    let siteDist = 1000000;
    for (let i = 0; i < allSites.length; i += 1) {
        const site = allSites[i];
        if (site === undefined) {
            continue;
        }
        if (site.owner === me) {
            continue;
        }
        const d = getRange(unit.x, unit.y, site.x, site.y);
        if (d < siteDist) {
            siteDist = d;
            siteId = site.id;
            siteX = site.x;
            siteY = site.y;
        }
    }
    if (siteId >= 0) {
        moveTo(unit.id, siteX, siteY);
    }
}
