"use strict";
var mySeat = -1;
var combatOffset = 0;
var workerOffset = 0;
function cellKey(x, y) {
    return x + "," + y;
}
function distance(ax, ay, bx, by) {
    let dx = ax - bx;
    let dy = ay - by;
    if (dx < 0)
        dx = -dx;
    if (dy < 0)
        dy = -dy;
    return dx > dy ? dx : dy;
}
function direction(value) {
    if (value < 0)
        return -1;
    if (value > 0)
        return 1;
    return 0;
}
function noteResult(ctx, result) {
    ctx.calls -= 2;
    if (isError(result)) {
        const code = errCode(result);
        if (code === ERR_NOT_ENOUGH_RESOURCES)
            return false;
        return false;
    }
    return true;
}
function terrain(ctx, x, y) {
    if (ctx.calls < 8)
        return false;
    ctx.calls -= 1;
    return getTerrainAt(x, y) === "plain";
}
function clearCell(ctx, x, y) {
    const key = cellKey(x, y);
    return !ctx.occupied.has(key) && !ctx.reserved.has(key);
}
function nearbyEnemies(ctx, x, y, radius) {
    const found = [];
    for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
            const bucket = ctx.grid.get(cellKey(x + dx, y + dy));
            if (bucket === undefined)
                continue;
            for (let i = 0; i < bucket.length; i += 1) {
                const unit = bucket[i];
                if (unit !== undefined && unit.owner !== ctx.me)
                    found.push(unit);
            }
        }
    }
    return found;
}
function go(ctx, unit, tx, ty) {
    if (ctx.calls < 16)
        return;
    if (unit.x === tx && unit.y === ty)
        return;
    const dx = direction(tx - unit.x);
    const dy = direction(ty - unit.y);
    const nx = unit.x + dx;
    const ny = unit.y + dy;
    const directClear = clearCell(ctx, nx, ny);
    if (directClear && terrain(ctx, nx, ny)) {
        ctx.calls -= 1;
        const result = move(unit.id, dx, dy);
        if (noteResult(ctx, result))
            ctx.reserved.add(cellKey(nx, ny));
        return;
    }
    if (directClear) {
        ctx.calls -= 1;
        noteResult(ctx, moveTo(unit.id, tx, ty));
        return;
    }
    let bestX = unit.x;
    let bestY = unit.y;
    let bestScore = 1000000000;
    const oldDistance = distance(unit.x, unit.y, tx, ty);
    const rotation = (unit.id + ctx.tick) % 8;
    const steps = [
        [1, 0], [1, 1], [0, 1], [-1, 1],
        [-1, 0], [-1, -1], [0, -1], [1, -1],
    ];
    for (let i = 0; i < 8; i += 1) {
        const step = steps[(i + rotation) % 8];
        if (step === undefined)
            continue;
        const x = unit.x + step[0];
        const y = unit.y + step[1];
        if (!clearCell(ctx, x, y))
            continue;
        const d = distance(x, y, tx, ty);
        if (d > oldDistance)
            continue;
        let score = d * 12;
        const ax = tx - x;
        const ay = ty - y;
        score += (ax < 0 ? -ax : ax) + (ay < 0 ? -ay : ay);
        if (score >= bestScore || !terrain(ctx, x, y))
            continue;
        bestScore = score;
        bestX = x;
        bestY = y;
    }
    if (bestX !== unit.x || bestY !== unit.y) {
        if (ctx.calls < 5)
            return;
        ctx.calls -= 1;
        const result = move(unit.id, direction(bestX - unit.x), direction(bestY - unit.y));
        if (noteResult(ctx, result))
            ctx.reserved.add(cellKey(bestX, bestY));
        return;
    }
    if (ctx.calls >= 5) {
        ctx.calls -= 1;
        noteResult(ctx, moveTo(unit.id, tx, ty));
    }
}
function adjacentDestination(ctx, unit, site, preferBases) {
    const candidates = [];
    for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0)
                continue;
            const x = site.x + dx;
            const y = site.y + dy;
            const here = x === unit.x && y === unit.y;
            if (!here && !clearCell(ctx, x, y))
                continue;
            let score = distance(unit.x, unit.y, x, y) * 10;
            if (preferBases) {
                let baseDistance = 1000000;
                for (let b = 0; b < ctx.bases.length; b += 1) {
                    const base = ctx.bases[b];
                    if (base === undefined)
                        continue;
                    const d = distance(x, y, base.x, base.y);
                    if (d < baseDistance)
                        baseDistance = d;
                }
                if (baseDistance < 1000000)
                    score += baseDistance * 3;
            }
            for (let b = 0; b < ctx.bases.length; b += 1) {
                const base = ctx.bases[b];
                if (base !== undefined && base.x === x && base.y === y)
                    score += 200;
            }
            if (here)
                score -= 2;
            candidates.push({ x, y, score });
        }
    }
    candidates.sort((a, b) => a.score - b.score || a.x - b.x || a.y - b.y);
    for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i];
        if (candidate === undefined)
            continue;
        if (candidate.x === unit.x && candidate.y === unit.y)
            return candidate;
        if (terrain(ctx, candidate.x, candidate.y))
            return candidate;
    }
    return null;
}
function retreat(ctx, unit, enemies) {
    if (ctx.calls < 20)
        return false;
    let bestX = unit.x;
    let bestY = unit.y;
    let bestScore = -1000000000;
    for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0)
                continue;
            const x = unit.x + dx;
            const y = unit.y + dy;
            if (!clearCell(ctx, x, y))
                continue;
            let score = 0;
            let closest = 100;
            for (let e = 0; e < enemies.length; e += 1) {
                const enemy = enemies[e];
                if (enemy === undefined || enemy.type === "worker")
                    continue;
                const d = distance(x, y, enemy.x, enemy.y);
                if (d < closest)
                    closest = d;
                const reach = enemy.type === "ranged" ? 2 : 1;
                if (d <= reach)
                    score -= 100;
                else if (d <= reach + 1)
                    score -= 20;
            }
            score += closest * 12;
            let homeDistance = 100;
            for (let b = 0; b < ctx.bases.length; b += 1) {
                const base = ctx.bases[b];
                if (base === undefined)
                    continue;
                const d = distance(x, y, base.x, base.y);
                if (d < homeDistance)
                    homeDistance = d;
                if (d === 0)
                    score -= 80;
            }
            score -= homeDistance;
            if (score <= bestScore || !terrain(ctx, x, y))
                continue;
            bestScore = score;
            bestX = x;
            bestY = y;
        }
    }
    if (bestX === unit.x && bestY === unit.y)
        return false;
    if (ctx.calls < 5)
        return false;
    ctx.calls -= 1;
    const result = move(unit.id, direction(bestX - unit.x), direction(bestY - unit.y));
    if (noteResult(ctx, result))
        ctx.reserved.add(cellKey(bestX, bestY));
    return true;
}
function deliver(ctx, unit) {
    let nearest = null;
    let bestDistance = 1000000;
    for (let i = 0; i < ctx.bases.length; i += 1) {
        const base = ctx.bases[i];
        if (base === undefined)
            continue;
        const d = distance(unit.x, unit.y, base.x, base.y);
        if (d < bestDistance || (d === bestDistance && nearest !== null && base.id < nearest.id)) {
            nearest = base;
            bestDistance = d;
        }
    }
    if (nearest === null)
        return false;
    if (bestDistance > 0 && bestDistance <= 1 && ctx.calls >= 6) {
        ctx.calls -= 1;
        const actualRange = getRange(unit.x, unit.y, nearest.x, nearest.y);
        if (actualRange <= 1) {
            ctx.calls -= 1;
            noteResult(ctx, transfer(unit.id));
            return true;
        }
    }
    const destination = adjacentDestination(ctx, unit, nearest, false);
    if (destination !== null) {
        go(ctx, unit, destination.x, destination.y);
        return true;
    }
    return false;
}
function chooseSite(ctx, unit, economic) {
    let best = null;
    let bestScore = 1000000000;
    for (let i = 0; i < ctx.sites.length; i += 1) {
        const site = ctx.sites[i];
        if (site === undefined)
            continue;
        const threatenedOwn = site.owner === ctx.me &&
            site.progressOwner !== ctx.me &&
            site.progressOwner !== -1 &&
            site.progress > 0;
        if (site.owner === ctx.me && !threatenedOwn)
            continue;
        const d = distance(unit.x, unit.y, site.x, site.y);
        const assigned = ctx.assignments.get(site.id) || 0;
        let score = d * 5;
        if (site.kind === "base") {
            score -= ctx.bases.length === 0 ? 70 : 18;
            score += assigned * 3;
        }
        else {
            score += assigned * 28;
            if (economic && site.remaining !== undefined && site.remaining > 0)
                score -= 20;
        }
        if (site.owner === -1)
            score -= 12;
        if (threatenedOwn)
            score -= site.kind === "base" ? 55 : 20;
        if (site.progressOwner === ctx.me)
            score -= site.progress * 2;
        const occupants = ctx.grid.get(cellKey(site.x, site.y));
        if (occupants !== undefined) {
            for (let o = 0; o < occupants.length; o += 1) {
                const occupant = occupants[o];
                if (occupant === undefined)
                    continue;
                if (occupant.owner === ctx.me && occupant.id !== unit.id) {
                    score += site.kind === "base" ? 8 : 65;
                }
                else if (occupant.owner !== ctx.me) {
                    score += economic ? 100 : occupant.type === "worker" ? 0 : 12;
                }
            }
        }
        if (score < bestScore || (score === bestScore && best !== null && site.id < best.id)) {
            bestScore = score;
            best = site;
        }
    }
    return best;
}
function workerTurn(ctx, unit) {
    const enemies = nearbyEnemies(ctx, unit.x, unit.y, 3);
    let threatened = false;
    for (let i = 0; i < enemies.length; i += 1) {
        const enemy = enemies[i];
        if (enemy === undefined || enemy.type === "worker")
            continue;
        const d = distance(unit.x, unit.y, enemy.x, enemy.y);
        const dangerRange = enemy.type === "ranged" ? 3 : 2;
        if (d <= dangerRange)
            threatened = true;
    }
    if (threatened) {
        if (unit.carrying > 0) {
            for (let i = 0; i < ctx.bases.length; i += 1) {
                const base = ctx.bases[i];
                if (base === undefined)
                    continue;
                const d = distance(unit.x, unit.y, base.x, base.y);
                if (d > 0 && d <= 1) {
                    deliver(ctx, unit);
                    return;
                }
            }
        }
        if (retreat(ctx, unit, enemies))
            return;
    }
    if (unit.carrying >= 20 || (unit.carrying > 0 && ctx.mines.length === 0)) {
        if (deliver(ctx, unit))
            return;
    }
    let selected = null;
    let selectedScore = 1000000000;
    for (let i = 0; i < ctx.mines.length; i += 1) {
        const mine = ctx.mines[i];
        if (mine === undefined)
            continue;
        const remaining = mine.remaining;
        if (remaining === undefined || remaining <= 0)
            continue;
        const allocated = ctx.assignments.get(mine.id) || 0;
        let score = distance(unit.x, unit.y, mine.x, mine.y) * 5 + allocated * 13;
        let homeDistance = 1000000;
        for (let b = 0; b < ctx.bases.length; b += 1) {
            const base = ctx.bases[b];
            if (base === undefined)
                continue;
            const d = distance(mine.x, mine.y, base.x, base.y);
            if (d < homeDistance)
                homeDistance = d;
        }
        if (homeDistance < 1000000)
            score += homeDistance * 2;
        for (let e = 0; e < enemies.length; e += 1) {
            const enemy = enemies[e];
            if (enemy === undefined || enemy.type === "worker")
                continue;
            if (distance(mine.x, mine.y, enemy.x, enemy.y) <= 3)
                score += 70;
        }
        if (remaining < 20)
            score += 15;
        if (score < selectedScore ||
            (score === selectedScore && selected !== null && mine.id < selected.id)) {
            selectedScore = score;
            selected = mine;
        }
    }
    if (selected !== null) {
        const assigned = ctx.assignments.get(selected.id) || 0;
        ctx.assignments.set(selected.id, assigned + 1);
        const d = distance(unit.x, unit.y, selected.x, selected.y);
        if (d > 0 && d <= 1 && unit.carrying < 20 && ctx.calls >= 6) {
            ctx.calls -= 1;
            if (getRange(unit.x, unit.y, selected.x, selected.y) <= 1) {
                ctx.calls -= 1;
                noteResult(ctx, harvest(unit.id, selected.id));
                return;
            }
        }
        const destination = adjacentDestination(ctx, unit, selected, true);
        if (destination !== null) {
            go(ctx, unit, destination.x, destination.y);
            return;
        }
    }
    if (unit.carrying > 0 && deliver(ctx, unit))
        return;
    for (let i = 0; i < ctx.sites.length; i += 1) {
        const site = ctx.sites[i];
        if (site !== undefined && site.x === unit.x && site.y === unit.y &&
            site.owner !== ctx.me)
            return;
    }
    const target = chooseSite(ctx, unit, true);
    if (target !== null) {
        ctx.assignments.set(target.id, (ctx.assignments.get(target.id) || 0) + 1);
        go(ctx, unit, target.x, target.y);
    }
    else {
        clearBase(ctx, unit);
    }
}
function clearBase(ctx, unit) {
    for (let i = 0; i < ctx.bases.length; i += 1) {
        const base = ctx.bases[i];
        if (base === undefined || base.x !== unit.x || base.y !== unit.y)
            continue;
        const destination = adjacentDestination(ctx, unit, base, false);
        if (destination !== null)
            go(ctx, unit, destination.x, destination.y);
        return;
    }
}
function combatTurn(ctx, unit) {
    const enemies = nearbyEnemies(ctx, unit.x, unit.y, 4);
    const reach = unit.type === "ranged" ? 2 : 1;
    const damage = unit.type === "melee" ? 3 : 2;
    let victim = null;
    let victimScore = -1000000000;
    let chase = null;
    let chaseScore = 1000000000;
    let adjacentDanger = false;
    for (let i = 0; i < enemies.length; i += 1) {
        const enemy = enemies[i];
        if (enemy === undefined)
            continue;
        const d = distance(unit.x, unit.y, enemy.x, enemy.y);
        const assignedDamage = ctx.damage.get(enemy.id) || 0;
        const hpLeft = enemy.hp - assignedDamage;
        if (d <= 1 && enemy.type !== "worker")
            adjacentDanger = true;
        if (d <= reach) {
            let score = 60 - enemy.hp * 2;
            if (enemy.type === "worker")
                score += 35;
            if (enemy.type === "ranged")
                score += 22;
            if (hpLeft > 0 && hpLeft <= damage)
                score += 45;
            if (hpLeft <= 0)
                score -= 150;
            const standingSite = ctx.sites.find(site => site.x === enemy.x && site.y === enemy.y && site.owner === ctx.me);
            if (standingSite !== undefined)
                score += standingSite.kind === "base" ? 70 : 30;
            if (score > victimScore ||
                (score === victimScore && victim !== null && enemy.id < victim.id)) {
                victimScore = score;
                victim = enemy;
            }
        }
        let score = d * 12 + enemy.hp;
        if (enemy.type === "worker")
            score -= 15;
        if (enemy.type === "ranged")
            score -= 8;
        if (hpLeft <= 0)
            score += 80;
        if (score < chaseScore ||
            (score === chaseScore && chase !== null && enemy.id < chase.id)) {
            chaseScore = score;
            chase = enemy;
        }
    }
    if (unit.type === "ranged" && adjacentDanger &&
        (victim === null || victim.hp > damage)) {
        if (retreat(ctx, unit, enemies))
            return;
    }
    if (victim !== null && ctx.calls >= 6) {
        ctx.calls -= 1;
        const actualRange = getRange(unit.x, unit.y, victim.x, victim.y);
        if (actualRange <= reach) {
            ctx.calls -= 1;
            const result = attack(unit.id, victim.id);
            if (noteResult(ctx, result)) {
                ctx.damage.set(victim.id, (ctx.damage.get(victim.id) || 0) + damage);
            }
            return;
        }
    }
    for (let i = 0; i < ctx.sites.length; i += 1) {
        const site = ctx.sites[i];
        if (site === undefined || site.x !== unit.x || site.y !== unit.y)
            continue;
        if (site.owner !== ctx.me) {
            ctx.assignments.set(site.id, (ctx.assignments.get(site.id) || 0) + 1);
            return;
        }
    }
    if (chase !== null) {
        const d = distance(unit.x, unit.y, chase.x, chase.y);
        let protect = false;
        for (let b = 0; b < ctx.bases.length; b += 1) {
            const base = ctx.bases[b];
            if (base !== undefined &&
                distance(chase.x, chase.y, base.x, base.y) <= 4)
                protect = true;
        }
        if (d <= 2 || protect || (chase.type === "worker" && d <= 3)) {
            go(ctx, unit, chase.x, chase.y);
            return;
        }
    }
    const target = chooseSite(ctx, unit, false);
    if (target !== null) {
        ctx.assignments.set(target.id, (ctx.assignments.get(target.id) || 0) + 1);
        go(ctx, unit, target.x, target.y);
        return;
    }
    if (chase !== null) {
        go(ctx, unit, chase.x, chase.y);
        return;
    }
    clearBase(ctx, unit);
}
function loop() {
    if (mySeat < 0)
        mySeat = getMyIndex();
    const tick = getTick();
    const players = getObjectsByType("player");
    let player = null;
    for (let i = 0; i < players.length; i += 1) {
        const candidate = players[i];
        if (candidate !== undefined && candidate.index === mySeat)
            player = candidate;
    }
    if (player === null || !player.alive)
        return;
    const allUnits = getObjectsByType("unit");
    const allSites = getObjectsByType("site");
    const sites = allSites.slice(0, 128);
    sites.sort((a, b) => a.id - b.id);
    const bases = [];
    const mines = [];
    let remainingResources = 0;
    for (let i = 0; i < sites.length; i += 1) {
        const site = sites[i];
        if (site === undefined || site.owner !== mySeat)
            continue;
        if (site.kind === "base") {
            if (bases.length < 24)
                bases.push(site);
        }
        else if (site.remaining !== undefined && site.remaining > 0) {
            mines.push(site);
            remainingResources += site.remaining;
        }
    }
    const grid = new Map();
    const occupied = new Set();
    const workers = [];
    const fighters = [];
    let meleeCount = 0;
    let rangedCount = 0;
    for (let i = 0; i < allUnits.length && i < 2048; i += 1) {
        const unit = allUnits[i];
        if (unit === undefined)
            continue;
        const key = cellKey(unit.x, unit.y);
        occupied.add(key);
        const bucket = grid.get(key);
        if (bucket === undefined)
            grid.set(key, [unit]);
        else
            bucket.push(unit);
        if (unit.owner !== mySeat)
            continue;
        if (unit.type === "worker")
            workers.push(unit);
        else
            fighters.push(unit);
        if (unit.type === "melee")
            meleeCount += 1;
        if (unit.type === "ranged")
            rangedCount += 1;
    }
    workers.sort((a, b) => a.id - b.id);
    fighters.sort((a, b) => a.id - b.id);
    const ctx = {
        me: mySeat,
        tick,
        calls: 740,
        sites,
        bases,
        mines,
        grid,
        occupied,
        reserved: new Set(),
        damage: new Map(),
        assignments: new Map(),
    };
    let queuedWorkers = 0;
    let queuedFighters = 0;
    let queuedRanged = 0;
    for (let i = 0; i < bases.length; i += 1) {
        const base = bases[i];
        if (base === undefined || base.producing === null)
            continue;
        if (base.producing.type === "worker")
            queuedWorkers += 1;
        else
            queuedFighters += 1;
        if (base.producing.type === "ranged")
            queuedRanged += 1;
    }
    let desiredWorkers = mines.length * 3;
    if (desiredWorkers < 4 && mines.length > 0)
        desiredWorkers = 4;
    if (desiredWorkers > 10)
        desiredWorkers = 10;
    while (desiredWorkers > 1 && desiredWorkers * 30 > remainingResources) {
        desiredWorkers -= 1;
    }
    if (mines.length === 0)
        desiredWorkers = workers.length > 0 ? workers.length : 1;
    let money = player.resources;
    for (let i = 0; i < bases.length; i += 1) {
        const base = bases[i];
        if (base === undefined || base.producing !== null || ctx.calls < 20)
            continue;
        if (workers.length + fighters.length + queuedWorkers + queuedFighters >= 96)
            break;
        const localEnemies = nearbyEnemies(ctx, base.x, base.y, 4);
        let danger = false;
        for (let e = 0; e < localEnemies.length; e += 1) {
            const enemy = localEnemies[e];
            if (enemy !== undefined && enemy.type !== "worker")
                danger = true;
        }
        let economicDistance = 1000000;
        for (let m = 0; m < mines.length; m += 1) {
            const mine = mines[m];
            if (mine === undefined)
                continue;
            const d = distance(base.x, base.y, mine.x, mine.y);
            if (d < economicDistance)
                economicDistance = d;
        }
        const existingWorkers = workers.length + queuedWorkers;
        const canRepay = economicDistance < 1000000 &&
            economicDistance * 2 + 26 < 600 - tick;
        let type = "melee";
        let cost = 8;
        if (existingWorkers === 0 ||
            (existingWorkers < desiredWorkers && canRepay && !danger &&
                (existingWorkers < 3 || fighters.length + queuedFighters >= 2))) {
            type = "worker";
            cost = 4;
        }
        else if (meleeCount >= 4 &&
            (rangedCount + queuedRanged) * 4 < meleeCount && !danger) {
            type = "ranged";
            cost = 12;
        }
        if (money < cost)
            continue;
        ctx.calls -= 1;
        const result = spawnUnit(base.id, type);
        if (noteResult(ctx, result)) {
            money -= cost;
            if (type === "worker")
                queuedWorkers += 1;
            else
                queuedFighters += 1;
            if (type === "ranged")
                queuedRanged += 1;
        }
    }
    const workerLimit = workers.length < 24 ? workers.length : 24;
    let workersProcessed = 0;
    for (let n = 0; n < workerLimit; n += 1) {
        if (ctx.calls < 25)
            break;
        const index = (workerOffset + n) % workers.length;
        const unit = workers[index];
        if (unit !== undefined)
            workerTurn(ctx, unit);
        workersProcessed += 1;
    }
    if (workers.length > 0) {
        workerOffset = (workerOffset + workersProcessed) % workers.length;
    }
    ctx.assignments.clear();
    const fighterLimit = fighters.length < 56 ? fighters.length : 56;
    let fightersProcessed = 0;
    for (let n = 0; n < fighterLimit; n += 1) {
        if (ctx.calls < 25)
            break;
        const index = (combatOffset + n) % fighters.length;
        const unit = fighters[index];
        if (unit !== undefined)
            combatTurn(ctx, unit);
        fightersProcessed += 1;
    }
    if (fighters.length > 0) {
        combatOffset = (combatOffset + fightersProcessed) % fighters.length;
    }
}
