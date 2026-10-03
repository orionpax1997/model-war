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

// ---------- 墙感知：地形掩码 + 八向 BFS 距离场 ----------
// 为什么自己算而不调 api.md 的 findPath/moveTo：findPath 只看地形、不看单位，返回整条路；
// 这份探针的移动语义是「一步一格、且要避开被占的格」（isFree），两条路线的拥堵行为不同，
// 换过去就不是「同一个贪心规则加墙感知」而是「换了移动规则」——受控替换要求只动墙感知这一维。
// 地形整局不变，所以掩码与距离场都按目标格缓存，同一目标整个对局只 BFS 一次。
let gridN = 0;
let plainMask = null;
const fieldCache = {};

function ensureGrid() {
  if (gridN > 0) return;
  let n = 0;
  while (getTerrainAt(n, 0) !== 'out') n++;   // 地图尺寸探针不写死（标定环还有 size=40）
  gridN = n;
  plainMask = new Int16Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) plainMask[y * n + x] = getTerrainAt(x, y) === 'plain' ? 1 : 0;
}

// 到 (tx,ty) 的八向 BFS 距离场：dist[cell] = 最短步数，不可达 = -1
function fieldTo(tx, ty) {
  ensureGrid();
  const key = tx + ',' + ty;
  const hit = fieldCache[key];
  if (hit !== undefined) return hit;
  const n = gridN;
  const dist = new Int16Array(n * n).fill(-1);
  const start = ty * n + tx;
  if (plainMask[start] === 1) {
    const queue = new Int32Array(n * n);
    let head = 0, tail = 0;
    dist[start] = 0; queue[tail++] = start;
    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % n;
      const cy = (cur - cx) / n;
      const nd = dist[cur] + 1;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DIRS[k][0];
        const ny = cy + DIRS[k][1];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const ni = ny * n + nx;
        if (plainMask[ni] === 0 || dist[ni] >= 0) continue;
        dist[ni] = nd; queue[tail++] = ni;
      }
    }
  }
  fieldCache[key] = dist;
  return dist;
}

// 象限（绕地图中心的四个角域），编号序 = 旋转序 TL→TR→BR→BL，所以四方家的象限各不相同。
// 这是扩张车道的**几何定义**，见 tick() 里的用法。
function quadrantOf(x, y) {
  ensureGrid();
  const h = (gridN - 1) / 2;
  return (x > h ? 1 : 0) + (y > h ? 2 : 0);
}

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

// 朝目标走一步。判据分三层，**任何一层都保留拥堵兜底**：
//   L1 直线三连（对角 → 横 → 纵）——原版逐字保留，外加一道「不许远离目标」的闸门；
//   L2 墙感知距离场里下降一步的邻格（墙已经把直线拉长时，L2 才与 L1 分道）；
//   L3 Chebyshev 下降邻格——目标在距离场里不可达时的兜底。
// 「保留拥堵兜底」是硬约束：首步格被别人占住时要退到次优的合法邻格，而不是原地不动。
// 诊断（06-confound §4）里那版墙感知 BFS 因为漏了这条兜底，把无墙夹具臂从 3080 打到 2000——
// 受控替换只允许动「下降判据」这一维，动了拥堵行为就不是受控替换了。
//
// L1 那道闸门（`f[cell] <= f[here]`）是必需的，不是锦上添花：原版 L1 判的是「这一步朝不朝目标走」，
// 于是**横向那一步在墙边是「朝目标走」的**（x 在靠近），哪怕它离目标更远。带墙时这会形成
// 周期 2 的来回踱步：L1 把单位横向推离目标、L2 下一 tick 又把它拉回来，两个 tick 一个循环，
// 净位移永远是 0（corridor-split 上 12 个单位 t=300 之后逐 tick 都在 A↔B）。实测这个 2-循环
// 就是修完 F1 之后 corridor-split 仍然采不空的直接原因。闸门只否决「距离场变大」的格子，
// 而 L1 三个候选本来就朝目标走，所以**无墙平原上 f ≡ Chebyshev，闸门是恒真的**——夹具臂不受影响。
function stepToward(u, tx, ty, all) {
  const f = fieldTo(tx, ty);          // 首次调用会把 gridN 建起来，所以必须先于读 gridN
  const n = gridN;
  const d0 = f[u.y * n + u.x];

  const dx = tx - u.x;
  const dy = ty - u.y;
  const sx = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
  const sy = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
  const tryCell = (nx, ny) => {
    if (!isFree(nx, ny, all)) return false;
    if (d0 >= 0 && f[ny * n + nx] > d0) return false;    // 墙感知闸门：这一步不许更远离目标
    move(u.id, nx - u.x, ny - u.y);
    return true;
  };
  if (sx !== 0 && sy !== 0 && tryCell(u.x + sx, u.y + sy)) return;
  if (sx !== 0 && tryCell(u.x + sx, u.y)) return;
  if (sy !== 0 && tryCell(u.x, u.y + sy)) return;

  // L2：距离场下降一步。候选里挑「Chebyshev 更小」的，同格按 DIRS 序——这与 L1 的对角优先同偏好，
  // 所以无墙平原上 L2 取到的格子与 L3 逐字一致（此时距离场恒等于 Chebyshev）。
  if (d0 > 0) {
    let bestK = -1;
    let bestCheb = BIG;
    for (let k = 0; k < 8; k++) {
      const nx = u.x + DIRS[k][0];
      const ny = u.y + DIRS[k][1];
      if (!isFree(nx, ny, all)) continue;
      if (f[ny * n + nx] !== d0 - 1) continue;
      const c = getRange(nx, ny, tx, ty);
      if (c < bestCheb) { bestCheb = c; bestK = k; }
    }
    if (bestK >= 0) { move(u.id, DIRS[bestK][0], DIRS[bestK][1]); return; }
  }

  // L3：距离场不可用（d0 <= 0）时沿 Chebyshev 下降——原版的第 4 段，原样保留
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

  // 认领车道用**几何**定义：本方家落在哪个象限，就认领同象限的中立点位（见文件尾注）。
  // 象限从地形掩码推出地图尺寸，不依赖 site 编号——这是修 F2 的关键：编号基数在夹具（1-based）
  // 与真图 JSON（0-based）里不同，同一条 `id mod 4` 公式在两边给出的车道整整差 90°。
  let homeQ = -1;
  for (let i = 0; i < sites.length; i++) {
    if (sites[i].owner === seat && sites[i].kind === 'base') { homeQ = quadrantOf(sites[i].x, sites[i].y); break; }
  }

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
      if (homeQ >= 0 && quadrantOf(s.x, s.y) === homeQ) myClaims.push(s);   // 认领：同象限车道
    }
  }
  for (let i = 0; i < all.length; i++) if (all[i].owner !== seat) enemies.push(all[i]);

  // 队列自记（快照无按基地查询的产线视图，票 14 P0-N3）
  const nb = []; const nl = [];
  for (let i = 0; i < queueBase.length; i++) {
    if (queueLeft[i] - 1 > 0) { nb.push(queueBase[i]); nl.push(queueLeft[i] - 1); }
  }
  queueBase = nb; queueLeft = nl;

  // 资源自记：初始 16 - 成功下单 + 成功交付。
  // 交付的记账模型是「当 tick 挂账、下一 tick 无条件到账」，不是「等这个单位消失」：
  //   transfer() 成功时返回 undefined（不是 true），按真值判定会让 pendingDeliver 永远是空的、
  //   myRes 永远 0；改成 `=== undefined` 又会因为交付后单位不消失而变成只增不减的泄漏。
  // 一次交付必是满载（上面只在 carrying >= CARRY_LIMIT 时交付，且 CARRY_LIMIT 就是载重上限），
  // 所以到账额恒为 CARRY_LIMIT。
  myRes += pendingDeliver.length * CARRY_LIMIT;
  pendingDeliver = [];

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
      // transfer() 成功返回 undefined，失败返回 'ERR_*' 字符串——成功判定必须是 `=== undefined`
      if (getRange(u.x, u.y, b.x, b.y) <= 1) { if (transfer(u.id) === undefined) pendingDeliver.push(u.id); }
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

// 文件尾注（扩张车道为什么用“象限”而不是“id mod 4”）：四方农民海同场时，
// “各走各的最近中立点”会让 4 方同时扑向同一个点，3 方白跑、一方独占——那样的对局量到的是
// 抢点拥堵而不是经济吞吐，票 03 的枯竭剖面会被这个假象污染。把中立点位静态切成四条车道、
// 本方只认领自己那一条，是“各方沿自己的方向扩张”的最简可测版本。
//
// 车道为什么按**象限**而不是按**编号**切（票 06 诊断 §F2 的修法）：车道本质是「各家沿自己方向扩张」，
// 方向是几何量，象限是几何量；`site.id` 不是。而编号基数在夹具（map.mjs 的 nextId 从 1 起）与
// 真图 JSON（从 0 起）里不同，同一条 `(id-1)%4===seat` 在真图上把每方的车道整整转了 90°——
// 座位 0 在真图上第一个要认领的点从家门口 9 格的中立矿变成 27 格外的一家中立基地。
// 改地图 JSON 的编号能对齐，但那是让地图承担一个与几何无关的约定；改公式则两边同图必然同车道。
// 复核：在无墙夹具上「象限车道」与原 `(id-1)%4` 逐点位完全一致（20/20），夹具臂因此不受影响。
//
// 文件尾注（自认机制）：`move()` 对**非己方**单位返回 `ERR_NOT_OWNER`（api.md §4 动作函数的返回约定），
// 而动作函数的界检查在沙箱内即时返回——所以“一个 tick 内试 move 全图单位、看谁没报错”就是可行的
// 座位自认，不需要快照标记、不需要 index API。盲写脚本（票 07）无一发现这个口子：cell-a 猜 0 号、
// cell-b 写死 0、cell-c/cell-d 用“移动后回读 owner”的位置法（需要跨 tick，且方向方案会互相撞车）。
