// probes/legion.js —— 桩模拟器自写的对照探针（**不是**票 07 的模型盲写脚本，不进 FR-10 AC1 证据）。
//
// 存在理由（gdd §8 记录 #10）：4 份盲写脚本里只有 cell-d 会造骑兵，而 cell-d 与 cell-a 的胜负差
// （open-four@64 8/32 vs 24/32）与“是否造骑兵”完全混淆（模型档位、严谨度、v1 两项静态不符），
// 所以**用真实模型脚本做不出因果判断**。本探针提供机制层的受控实验：同一份源码、同样的几何、
// 同样的座位，宿主只改 `USE_CAVALRY` 这一个变量。
//
// 与 probes/raider.js 的关键差别：**会占点**。raider 只冲农民不会占点（终局均领土分只有 4.7），
// 所以它测不出“造骑兵是否值得”——占点才是终局分的主项。
//
// 打法（刻意保持“中性”，不猜阈值）：农民地板 → 占家门口的点 → 造近战/远程为主力；
// USE_CAVALRY=true 时按 gdd §5「护矿是常态」把一部分产能转成骑兵去切敌后的农民。
//
// 契约遵守：单文件、顶层 function loop()、全整数、无 Date/Math.random/非确定源、
// 只调 api.md 白名单 API、跨 tick 只存数值 id。

const CARRY_LIMIT = 20;
const WORKER_COST = 4;
const MELEE_COST = 8;
const RANGED_COST = 12;
const CAVALRY_COST = 16;
const WORKER_SPAWN = 2;
const MELEE_SPAWN = 4;
const RANGED_SPAWN = 6;
const CAVALRY_SPAWN = 8;
const BIG = 9999;

// 宿主注入（run-all --set USE_CAVALRY=… → SCRIPTS.legion / SCRIPTS.legionNoCav 的 inject 前缀）
const WORKER_TARGET = 4;
const RESERVE = WORKER_COST * 2;   // 国库地板：留得住两个农民

const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

let seat = -1;
let queueBase = [];
let queueLeft = [];
let myRes = 16;

// ---------- 自认（用 ERR_NOT_OWNER 回读；见文件尾注）----------
function identify() {
  const all = getObjectsByType('unit');
  for (let i = 0; i < all.length; i++) {
    const u = all[i];
    for (let k = 0; k < 8; k++) {
      const d = DIRS[(u.id * 3 + 5 + k) % 8];
      const r = move(u.id, d[0], d[1]);
      if (r === 'ERR_NOT_OWNER') break;
      if (r === undefined) {
        const mine = getObjectById(u.id);
        if (mine && mine.owner >= 0) { seat = mine.owner; return true; }
        break;
      }
    }
  }
  return false;
}

// ---------- 走位工具 ----------
function nearestOf(list, x, y) {
  let best = null;
  let bd = BIG;
  for (let i = 0; i < list.length; i++) {
    const d = getRange(x, y, list[i].x, list[i].y);
    if (d < bd) { bd = d; best = list[i]; }
  }
  return best;
}

function isFree(x, y, all) {
  if (getTerrainAt(x, y) !== 'plain') return false;
  for (let i = 0; i < all.length; i++) if (all[i].x === x && all[i].y === y) return false;
  return true;
}

function freeNeighbor(x, y, all) {
  for (let i = 0; i < DIRS.length; i++) {
    const nx = x + DIRS[i][0];
    const ny = y + DIRS[i][1];
    if (isFree(nx, ny, all)) return { x: nx, y: ny };
  }
  return null;
}

function stepToward(u, tx, ty, all) {
  const dx = tx - u.x;
  const dy = ty - u.y;
  const sx = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
  const sy = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
  const tryCell = (nx, ny) => {
    if (!isFree(nx, ny, all)) return false;
    move(u.id, nx - u.x, ny - u.y);
    return true;
  };
  if (sx !== 0 && sy !== 0 && tryCell(u.x + sx, u.y + sy)) return;
  if (sx !== 0 && tryCell(u.x + sx, u.y)) return;
  if (sy !== 0 && tryCell(u.x, u.y + sy)) return;
  const here = getRange(u.x, u.y, tx, ty);
  for (let i = 0; i < DIRS.length; i++) {
    const nx = u.x + DIRS[i][0];
    const ny = u.y + DIRS[i][1];
    if (!isFree(nx, ny, all)) continue;
    if (getRange(nx, ny, tx, ty) < here) { move(u.id, DIRS[i][0], DIRS[i][1]); return; }
  }
}

function tick() {
  if (seat < 0) { identify(); return; }

  const my = getObjectsByType('unit', { owner: seat });
  const sites = getObjectsByType('site');
  const all = getObjectsByType('unit');

  const myBases = [];
  const myMines = [];
  const claimable = [];      // 中立点位（基地/资源点）——占点优先序 1
  const enemies = [];
  const foreignWorkers = [];
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    if (s.owner === seat && s.kind === 'base') myBases.push(s);
    else if (s.owner === seat && s.kind === 'resource') { if (s.remaining > 0) myMines.push(s); }
    else if (s.owner === -1) claimable.push(s);
  }
  for (let i = 0; i < all.length; i++) {
    if (all[i].owner === seat) continue;
    enemies.push(all[i]);
    if (all[i].type === 'worker') foreignWorkers.push(all[i]);
  }

  // 队列自记（快照有 productions 字段但无按基地查询的 API 面，票 14 P0-N3）
  const nb = []; const nl = [];
  for (let i = 0; i < queueBase.length; i++) {
    if (queueLeft[i] - 1 > 0) { nb.push(queueBase[i]); nl.push(queueLeft[i] - 1); }
  }
  queueBase = nb; queueLeft = nl;

  // 资源自记（快照 players 数组无 self 标记、也无自读 API 面，票 14 P0-N3）：初始 16 − 成功下单 + 成功交付。
  // 交付在 `transfer()` 被受理的当下就入账（结算发生在本 tick 之后，worker 仍活着，所以不能等它“消失”）。

  let workers = 0;
  let army = 0;
  let cav = 0;
  for (let i = 0; i < my.length; i++) {
    if (my[i].type === 'worker') workers += 1;
    else { army += 1; if (my[i].type === 'cavalry') cav += 1; }
  }

  // —— 生产：农民地板（4 农）→ 主产近战，开关打开时每 4 个主力补 1 骑兵 ——
  // 注意返回约定：动作 API **受理时返回 undefined，被拒时返回 'ERR_*' 字符串**（api.md §4）。
  // 快照没有“读自己资源”的入口（票 14 P0-N3），所以这里自记国库：受理即入账/扣账。
  const SPAWN_OF = { worker: WORKER_SPAWN, melee: MELEE_SPAWN, ranged: RANGED_SPAWN, cavalry: CAVALRY_SPAWN };
  const COST_OF = { worker: WORKER_COST, melee: MELEE_COST, ranged: RANGED_COST, cavalry: CAVALRY_COST };
  for (let b = 0; b < myBases.length; b++) {
    const base = myBases[b];
    let busy = false;
    for (let q = 0; q < queueBase.length; q++) if (queueBase[q] === base.id) { busy = true; break; }
    if (busy) continue;
    let type = 'melee';
    if (workers < WORKER_TARGET) type = 'worker';
    else if (USE_CAVALRY && cav * 4 < army) type = 'cavalry';
    else if (army % 3 === 2) type = 'ranged';       // 少量远程补纵深（远程贴身即溃，所以只占 1/3）
    // 国库地板：造兵单位要留出两个农民的钱（不这么干会把国库花光然后饿死——实测过：探针 3/4 席经济死亡）
    const need = COST_OF[type] + (type === 'worker' ? 0 : RESERVE);
    if (myRes < need) continue;
    if (spawnUnit(base.id, type) === undefined) {
      myRes -= COST_OF[type];
      queueBase.push(base.id);
      queueLeft.push(SPAWN_OF[type]);
      if (type === 'worker') workers += 1;
      else { army += 1; if (type === 'cavalry') cav += 1; }
    }
  }

  // —— 单位行为：农民采/交，战斗单位“先占点、有敌人就清场、骑兵切敌后农民” ——
  for (let i = 0; i < my.length; i++) {
    const u = my[i];
    if (u.type === 'worker') {
      if (u.carrying >= CARRY_LIMIT) {
        const b = nearestOf(myBases, u.x, u.y);
        if (!b) continue;
        if (getRange(u.x, u.y, b.x, b.y) <= 1) { if (transfer(u.id) === undefined) myRes += CARRY_LIMIT; }
        else stepToward(u, b.x, b.y, all);
        continue;
      }
      const m = nearestOf(myMines, u.x, u.y);
      if (!m) continue;                               // 无自家矿：规则要求先占领才有开采权
      if (getRange(u.x, u.y, m.x, m.y) === 1) harvest(u.id, m.id);
      else {
        const cell = freeNeighbor(m.x, m.y, all);
        stepToward(u, cell ? cell.x : m.x, cell ? cell.y : m.y, all);
      }
      continue;
    }
    // 战斗单位行为（“中性”打法，不猜阈值）：
    //   1) 贴脸的敌人先打（整场唯一的交火条件）
    //   2) 骑兵切敌后农民（gdd §5「护矿是常态」）—— 这是两个实验臂的**唯一差异**
    //   3) 其余单位不去远征：守点 / 抢中立点（占点是终局分主项）
    const adj = nearestOf(enemies, u.x, u.y);
    if (adj && getRange(u.x, u.y, adj.x, adj.y) <= 1) { attack(u.id, adj.id); continue; }
    if (u.type === 'cavalry') {
      const prey = nearestOf(foreignWorkers, u.x, u.y);
      if (prey) { stepToward(u, prey.x, prey.y, all); continue; }
    }
    const stand = nearestOf(claimable, u.x, u.y);
    if (stand && stand.remaining !== 0) { stepToward(u, stand.x, stand.y, all); continue; }
    const guard = nearestOf(myBases.length > 0 ? myBases : myMines, u.x, u.y);
    if (guard && !(u.x === guard.x && u.y === guard.y)) stepToward(u, guard.x, guard.y, all);
  }
}

function loop() {
  tick();
}

// 文件尾注（自认机制）：`move()` 对**非己方**单位返回 `ERR_NOT_OWNER`（api.md §4 的返回约定，
// 界检查在沙箱内即时返回），所以“一个 tick 内对全图单位逐个试 move、看谁没报错”就是可行的座位自认。
// 盲写脚本无一发现这个口子（gdd §8 #10 与 handoff.md §4.1：终稿改用 `getMyIndex()`，探针沿用 workaround）。
