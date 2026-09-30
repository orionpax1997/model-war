// probes/farmer.js —— 桩模拟器自写的“农民海”对照探针（**不是**票 07 的模型盲写脚本，不进 FR-10 AC1 证据）。
//
// 存在理由：票 05 要判“农民海 vs 混编”是不是无脑最优，但盲写脚本里唯一的农民海 cell-c
// 把“给空闲农民派活”写成**先占点、后采集**（blind/cell-c/work/script.v1.js L193-213：capture 目标
// 永远优先，只有在没有可占点时才 fallback 到采集），于是它的农民几乎全程在赶去占点、一次都没
// harvest（见 results.md「cell-c 策略缺陷」）。拿一个不采集的脚本去判“农民海强度”是无效取证，
// 故这里补一个**会采集**的农民海探针，让 票 05 的判据（农民占比 / 占领效率 / 混编 vs 农民海胜率）
// 有可测对象。
//
// 策略（刻意保持“纯农民海”，不造兵、不主动打人）：
//   1) 生产：只造农民，补到 WORKER_TARGET；
//   2) 采集（HARVEST_PCT 比例的农民）：认领最近的**自家非枯竭矿**（含打下来的中立矿），
//      满载回最近自家基地交付（射程 1）；自家矿全枯竭就待采，不越权采中立矿（规则要求先占领）；
//   3) 扩张（其余农民）：认领最近的中立点位并**站上去**（captureTicks=10 期间冻结），
//      站定时邻格有敌对单位就还手（纯自卫）。
//
// 宿主注入（不算脚本自写常量，见 harness.mjs SCRIPTS 的 `inject`）：WORKER_TARGET / HARVEST_PCT。
// 契约遵守：单文件、顶层 function loop()、全整数、无 Date/Math.random/非确定源、
// 只调 api.md 白名单 API、跨 tick 只存数值 id。

const CARRY_LIMIT = 20;
const WORKER_COST = 4;
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

// ---------- 自认（用 ERR_NOT_OWNER 回读；见文件尾注）----------
// 一步完成：拿到全图单位，对每个单位试 move 一次；返回 undefined（没报错）的那几个就是自己的，
// 从中任取一个读它的 owner 即得座位号。不需要快照里的任何标记，也不需要等下一 tick 回读位置。
function identify() {
  const all = getObjectsByType('unit');
  for (let i = 0; i < all.length; i++) {
    const u = all[i];
    // 逐方向试：ERR_NOT_OWNER 是“非己方”的权威答复（见文件尾注）；撞墙/越界换个方向再试；
    // 一旦某个方向返回 undefined（受理了），这个单位就是自己的，读它的 owner 即得座位号。
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

function nearestOf(list, x, y) {
  let best = null;
  let bd = BIG;
  for (let i = 0; i < list.length; i++) {
    const d = getRange(x, y, list[i].x, list[i].y);
    if (d < bd) { bd = d; best = list[i]; }
  }
  return best;
}

// 可走 = 平原且无任何单位（快照可见全图单位，所以能避开拥堵；否则多个采集农会盯上同一个邻格卡死）
function isFree(x, y, all) {
  if (getTerrainAt(x, y) !== 'plain') return false;
  for (let i = 0; i < all.length; i++) if (all[i].x === x && all[i].y === y) return false;
  return true;
}

function freeNeighbor(x, y, all) {
  for (let i = 0; i < 8; i++) {
    const nx = x + DIRS[i][0];
    const ny = y + DIRS[i][1];
    if (isFree(nx, ny, all)) return { x: nx, y: ny };
  }
  return null;
}

// 贪心一步：先走“对角→横→纵”里第一个可走的；都不行就退到“使目标 Chebyshev 距离下降最多”的邻格
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
  for (let i = 0; i < 8; i++) {
    const nx = u.x + DIRS[i][0];
    const ny = u.y + DIRS[i][1];
    if (!isFree(nx, ny, all)) continue;
    if (getRange(nx, ny, tx, ty) < here) { move(u.id, DIRS[i][0], DIRS[i][1]); return; }
  }
}

function tick() {
  if (seat < 0) { identify(); return; }
  const mine = getObjectsByType('unit', { owner: seat });
  const sites = getObjectsByType('site');
  const all = getObjectsByType('unit');

  const myBases = [];
  const myMines = [];
  const myClaims = [];      // 本方“认领”的中立点位（见文件尾注）
  const neutral = [];
  const enemies = [];
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    if (s.owner === seat && s.kind === 'base') myBases.push(s);
    else if (s.owner === seat && s.kind === 'resource' && s.remaining > 0) myMines.push(s);
    else if (s.owner === -1) {
      neutral.push(s);
      if ((s.id - 1) % 4 === seat) myClaims.push(s);   // 认领：id mod 4 = 自座位
    }
  }
  for (let i = 0; i < all.length; i++) if (all[i].owner !== seat) enemies.push(all[i]);

  // 队列自记（快照无按基地查询的产线视图，票 14 P0-N3）
  const nb = []; const nl = [];
  for (let i = 0; i < queueBase.length; i++) {
    if (queueLeft[i] - 1 > 0) { nb.push(queueBase[i]); nl.push(queueLeft[i] - 1); }
  }
  queueBase = nb; queueLeft = nl;

  // 资源自记：初始 16 - 成功下单 + 成功交付（transfer 挂账，等结算后回补）
  const stillPending = [];
  for (let i = 0; i < pendingDeliver.length; i++) {
    const w = getObjectById(pendingDeliver[i]);
    if (w && w.owner === seat && w.type === 'worker') stillPending.push(pendingDeliver[i]);
    else myRes += CARRY_LIMIT;
  }
  pendingDeliver = stillPending;

  const workers = [];
  for (let i = 0; i < mine.length; i++) if (mine[i].type === 'worker') workers.push(mine[i]);
  const harvestCount = Math.floor((workers.length * HARVEST_PCT) / 100);

  // 生产：只造农民（农民海不造兵）
  for (let b = 0; b < myBases.length; b++) {
    const base = myBases[b];
    if (workers.length >= WORKER_TARGET) break;
    let busy = false;
    for (let q = 0; q < queueBase.length; q++) if (queueBase[q] === base.id) { busy = true; break; }
    if (busy) continue;
    if (myRes < WORKER_COST) continue;
    if (spawnUnit(base.id, 'worker')) { myRes -= WORKER_COST; queueBase.push(base.id); queueLeft.push(WORKER_SPAWN); }
  }

  // 单位行为
  for (let i = 0; i < workers.length; i++) {
    const u = workers[i];
    // 自卫：邻格有敌对单位就还手（不追击）
    const foe = nearestOf(enemies, u.x, u.y);
    if (foe && getRange(u.x, u.y, foe.x, foe.y) <= 1) { attack(u.id, foe.id); continue; }
    if (u.carrying >= CARRY_LIMIT) {
      const b = nearestOf(myBases, u.x, u.y);
      if (!b) continue;
      if (getRange(u.x, u.y, b.x, b.y) <= 1) { if (transfer(u.id)) pendingDeliver.push(u.id); }
      else stepToward(u, b.x, b.y, all);
      continue;
    }
    if (i < harvestCount) {
      const m = nearestOf(myMines, u.x, u.y);
      if (!m) continue;                                   // 自家矿枯竭 → 待采（不越权采中立矿）
      if (getRange(u.x, u.y, m.x, m.y) === 1) harvest(u.id, m.id);
      else {
        const cell = freeNeighbor(m.x, m.y, all);
        if (cell) stepToward(u, cell.x, cell.y, all);
        else stepToward(u, m.x, m.y, all);
      }
      continue;
    }
    // 扩张：站上本方认领的最近中立点位
    const pool = myClaims.length > 0 ? myClaims : neutral;
    const t = nearestOf(pool, u.x, u.y);
    if (!t) continue;
    if (u.x === t.x && u.y === t.y) continue;
    stepToward(u, t.x, t.y, all);
  }
}

function loop() {
  tick();
}

// 文件尾注（扩张目标为什么用“id mod 4 认领”而不是“最近的中立点”）：四方农民海同场时，
// “各走各的最近中立点”会让 4 方同时扑向同一个点，3 方白跑、一方独占——那样的对局量到的是
// 抢点拥堵而不是经济吞吐，票 03 的枯竭剖面会被这个假象污染。用 `id mod 4 = 座位` 把中立点位
// 静态切成四条车道，是“各方沿自己的方向扩张”的最简可测版本。
//
// 文件尾注（自认机制）：`move()` 对**非己方**单位返回 `ERR_NOT_OWNER`（api.md §4 动作函数的返回约定），
// 而动作函数的界检查在沙箱内即时返回——所以“一个 tick 内试 move 全图单位、看谁没报错”就是可行的
// 座位自认，不需要快照标记、不需要 index API。盲写脚本（票 07）无一发现这个口子：cell-a 猜 0 号、
// cell-b 写死 0、cell-c/cell-d 用“移动后回读 owner”的位置法（需要跨 tick，且方向方案会互相撞车）。
