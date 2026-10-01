// probes/raider.js —— 桩模拟器自写的对照探针（**不是**票 07 的模型盲写脚本，不进 FR-10 AC1 证据）。
//
// 存在理由：4 份盲写脚本里只有 cell-d 会出骑兵（cell-a/b/c 的生产决策里没有骑兵），
// 因此“C1~C7 在混战条件下是否仍表现为设计意图”“经济死亡后抢点续命”这两项取证
// 在盲写脚本集上覆盖不到。探针只做两件事，其余行为保持“中性”（不主动抢点、不主动混战）：
//   1) 造骑兵：先保证 2 个农民，再造 2 骑兵用速度直插敌后打农民（gdd §5「护矿是常态」）；
//   2) 经济死亡检测（无农民且攒不出农民）后，改用残兵免费占领最近的中立点位（gdd §5 续命条款）。
//
// 契约遵守：单文件、顶层 function loop()、全整数、无 Date/Math.random/非确定源、
// 只调 api.md 白名单 API、跨 tick 只存数值 id。

const CARRY_LIMIT = 20;
const CAVALRY_COST = 16;
const WORKER_COST = 4;
const MELEE_COST = 8;
const CAVALRY_SPAWN = 8;
const MELEE_SPAWN = 4;
const WORKER_SPAWN = 2;
const BIG = 9999;

const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

let seat = -1;
let queueBase = [];
let queueLeft = [];
let pendingDeliver = [];
let myRes = 16;
let econDead = false;

// ---------- 自认（用 ERR_NOT_OWNER 回读；见文件尾注）----------
// 一步完成：拿到全图单位，逐个试 move；返回 undefined（受理了）的那几个就是自己的，
// 读其中一个的 owner 即得座位号。不需要快照里的自标记，也不需要跨 tick 回读位置。
function identify() {
  const all = getObjectsByType('unit');
  for (let i = 0; i < all.length; i++) {
    const u = all[i];
    // 逐方向试：ERR_NOT_OWNER 是“非己方”的权威答复（见文件尾注）；撞墙/越界则换个方向；
    // 某个方向返回 undefined（受理）即说明这个单位是自己的。
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

// ---------- 走位工具（占用感知：否则多个单位会盯上同一个邻格卡死）----------
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

// 贪心一步：先试“对角→横→纵”里第一个可走的；都不行就退到“使目标 Chebyshev 距离下降最多”的邻格
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

function nearestNeutral(sites, x, y) {
  let best = null;
  let bd = BIG;
  for (let i = 0; i < sites.length; i++) {
    if (sites[i].owner !== -1) continue;
    const d = getRange(x, y, sites[i].x, sites[i].y);
    if (d < bd) { bd = d; best = sites[i]; }
  }
  return best;
}

function tick() {
  if (seat < 0) { identify(); return; }

  const my = getObjectsByType('unit', { owner: seat });
  const sites = getObjectsByType('site');
  const all = getObjectsByType('unit');

  const myBases = [];
  const myMines = [];
  const enemies = [];
  const foreignWorkers = [];
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    if (s.owner === seat && s.kind === 'base') myBases.push(s);
    else if (s.owner === seat && s.kind === 'resource' && s.remaining > 0) myMines.push(s);
  }
  for (let i = 0; i < all.length; i++) {
    if (all[i].owner === seat) continue;
    enemies.push(all[i]);
    if (all[i].type === 'worker') foreignWorkers.push(all[i]);
  }

  // 队列自记（快照的 productions 字段有，但无按基地查询的 API 面，票 14 P0-N3）
  const nb = []; const nl = [];
  for (let i = 0; i < queueBase.length; i++) {
    if (queueLeft[i] - 1 > 0) { nb.push(queueBase[i]); nl.push(queueLeft[i] - 1); }
  }
  queueBase = nb; queueLeft = nl;

  // 资源自记（快照 players 数组无 self 标记）：初始 16 - 成功下单 + 成功交付（transfer 挂账等结算）
  const stillPending = [];
  for (let i = 0; i < pendingDeliver.length; i++) {
    const w = getObjectById(pendingDeliver[i]);
    if (w && w.owner === seat && w.type === 'worker') stillPending.push(pendingDeliver[i]);
    else myRes += CARRY_LIMIT;
  }
  pendingDeliver = stillPending;

  let workers = 0;
  let cav = 0;
  let melee = 0;
  for (let i = 0; i < my.length; i++) {
    if (my[i].type === 'worker') workers += 1;
    if (my[i].type === 'cavalry') cav += 1;
    if (my[i].type === 'melee') melee += 1;
  }
  if (workers === 0 && myRes < WORKER_COST + MELEE_COST) econDead = true;

  // —— 生产：经济地板（2 农民）→ 2 骑兵突袭 → 经济死亡后转近战 ——
  for (let b = 0; b < myBases.length; b++) {
    const base = myBases[b];
    if (workers >= 2 && !econDead && cav >= 2) break;
    let busy = false;
    for (let q = 0; q < queueBase.length; q++) if (queueBase[q] === base.id) { busy = true; break; }
    if (busy) continue;
    let type = 'melee';
    if (workers < 2) type = 'worker';
    else if (!econDead && cav < 2) type = 'cavalry';
    const cost = type === 'cavalry' ? CAVALRY_COST : (type === 'worker' ? WORKER_COST : MELEE_COST);
    if (myRes < cost) continue;
    if (spawnUnit(base.id, type)) {
      myRes -= cost;
      queueBase.push(base.id);
      queueLeft.push(type === 'cavalry' ? CAVALRY_SPAWN : (type === 'worker' ? WORKER_SPAWN : MELEE_SPAWN));
      if (type === 'cavalry') cav += 1; else if (type === 'worker') workers += 1; else melee += 1;
    }
    // 下单被拒（造兵格被占/产线忙）→ 引擎挂起，不扣款；下一 tick 再试
  }

  // —— 单位行为 ——
  for (let i = 0; i < my.length; i++) {
    const u = my[i];
    if (u.type === 'worker') {
      if (u.carrying >= CARRY_LIMIT) {
        const b = nearestOf(myBases, u.x, u.y);
        if (!b) continue;
        if (getRange(u.x, u.y, b.x, b.y) <= 1) { if (transfer(u.id)) pendingDeliver.push(u.id); }
        else stepToward(u, b.x, b.y, all);
        continue;
      }
      const m = nearestOf(myMines, u.x, u.y);
      if (!m) continue;                                    // 无自家矿（规则要求先占领才有开采权）
      if (getRange(u.x, u.y, m.x, m.y) === 1) harvest(u.id, m.id);
      else {
        const cell = freeNeighbor(m.x, m.y, all);
        stepToward(u, cell ? cell.x : m.x, cell ? cell.y : m.y, all);
      }
      continue;
    }
    // 经济死亡后：残兵抢最近的中立点位续命
    if (econDead) {
      const target = nearestNeutral(sites, u.x, u.y);
      if (target) {
        if (u.x === target.x && u.y === target.y) continue;
        stepToward(u, target.x, target.y, all);
        continue;
      }
    }
    // 平时：直插敌后打农民（gdd §5「护矿是常态」），无农可打才打最近的敌人
    const prey = nearestOf(foreignWorkers, u.x, u.y);
    if (prey) {
      if (getRange(u.x, u.y, prey.x, prey.y) <= 1) { attack(u.id, prey.id); continue; }
      stepToward(u, prey.x, prey.y, all);
      continue;
    }
    const foe = nearestOf(enemies, u.x, u.y);
    if (foe) {
      if (getRange(u.x, u.y, foe.x, foe.y) <= 1) { attack(u.id, foe.id); continue; }
      stepToward(u, foe.x, foe.y, all);
    }
  }
}

function loop() {
  tick();
}

// 文件尾注（自认机制）：`move()` 对**非己方**单位返回 `ERR_NOT_OWNER`（api.md §4 的返回约定，
// 界检查在沙箱内即时返回），所以“一个 tick 内对全图单位逐个试 move、看谁没报错”就是可行的座位自认。
// 盲写脚本（票 07）无一发现这个口子：cell-a 猜 0 号、cell-b 写死 0、cell-c/cell-d 用“移动后回读 owner”
// 的位置法（要跨 tick，方向方案还会互相撞车——四方同款脚本时全员误判成 0 号，见 results.md）。
