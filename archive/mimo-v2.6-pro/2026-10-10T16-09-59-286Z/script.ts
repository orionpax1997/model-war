// script.ts —— 扩张运营:先稳经济与点位,攒够家底再转军事,按 tick 节奏推进。
// 硬约束落实:座位只从 getMyIndex() 取;跨 tick 只带数值;每单位每 tick 只提交一条意图;
// 判错只走 isError / errCode 两步;全整数运算;无模块语法、无非确定源。

// ================= 跨 tick 记忆(只存数值) =================
var taskUnitId: number[] = [];
var taskSiteId: number[] = [];
var taskKind: number[] = []; // 1 = 堵点(站自家点位格),2 = 踩点(站非自家点位格)
var tmpX = 0;
var tmpY = 0;

// ================= 内部记录(纯数值,每 tick 重建,不缓存快照) =================
type SiteRec = {
  id: number;
  x: number;
  y: number;
  isBase: number;
  isNeutral: number;
  left: number;
  busy: number;
};

type FoeRec = {
  id: number;
  x: number;
  y: number;
  hp: number;
};

type MyRec = {
  id: number;
  x: number;
  y: number;
  carry: number;
  worker: number;
  range: number;
};

// ================= 纯计算辅助 =================
function cheb(ax: number, ay: number, bx: number, by: number): number {
  let dx = ax - bx;
  let dy = ay - by;
  if (dx < 0) {
    dx = -dx;
  }
  if (dy < 0) {
    dy = -dy;
  }
  return dx > dy ? dx : dy;
}

function findRec(list: SiteRec[], id: number): SiteRec | null {
  for (const r of list) {
    if (r.id === id) {
      return r;
    }
  }
  return null;
}

function indexOfRec(list: SiteRec[], id: number): number {
  let i = 0;
  for (const r of list) {
    if (r.id === id) {
      return i;
    }
    i += 1;
  }
  return -1;
}

function nearestRec(ux: number, uy: number, list: SiteRec[]): SiteRec | null {
  let best: SiteRec | null = null;
  let bestD = 0;
  for (const r of list) {
    const d = cheb(ux, uy, r.x, r.y);
    if (best === null || d < bestD) {
      best = r;
      bestD = d;
    }
  }
  return best;
}

function nearestFoe(ux: number, uy: number, foes: FoeRec[], radius: number): FoeRec | null {
  let best: FoeRec | null = null;
  let bestD = 0;
  for (const f of foes) {
    const d = cheb(ux, uy, f.x, f.y);
    if (d > radius) {
      continue;
    }
    if (best === null || d < bestD) {
      best = f;
      bestD = d;
    }
  }
  return best;
}

function taskIndexOf(uid: number): number {
  for (let i = 0; i < taskUnitId.length; i += 1) {
    if (taskUnitId[i] === uid) {
      return i;
    }
  }
  return -1;
}

function setTask(uid: number, sid: number, kind: number): void {
  const i = taskIndexOf(uid);
  if (i < 0) {
    taskUnitId.push(uid);
    taskSiteId.push(sid);
    taskKind.push(kind);
  } else {
    taskSiteId[i] = sid;
    taskKind[i] = kind;
  }
}

// 挑点位的邻格(不站点位格上,避免与占领/堵点职责打架,也别堵自家出兵格)。
function pickAdjacent(ux: number, uy: number, sx: number, sy: number): boolean {
  let bx = 0;
  let by = 0;
  let found = 0;
  let bestD = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const cx = sx + dx;
      const cy = sy + dy;
      const d = cheb(ux, uy, cx, cy);
      if (found === 0 || d < bestD) {
        found = 1;
        bestD = d;
        bx = cx;
        by = cy;
      }
    }
  }
  if (found === 0) {
    return false;
  }
  if (getTerrainAt(bx, by) === "plain") {
    tmpX = bx;
    tmpY = by;
    return true;
  }
  // 首选格不是平地:在其余邻格里挑平地
  let found2 = 0;
  let best2 = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const cx = sx + dx;
      const cy = sy + dy;
      if (cx === bx && cy === by) {
        continue;
      }
      if (getTerrainAt(cx, cy) !== "plain") {
        continue;
      }
      const d = cheb(ux, uy, cx, cy);
      if (found2 === 0 || d < best2) {
        found2 = 1;
        best2 = d;
        tmpX = cx;
        tmpY = cy;
      }
    }
  }
  return found2 === 1;
}

// 踩点目标选择:前期抢中立(开经济 + 分),有家底后转敌方点位,终局强攻基地。
function pickCapture(
  ux: number,
  uy: number,
  tick: number,
  push: number,
  list: SiteRec[],
): SiteRec | null {
  let best: SiteRec | null = null;
  let bestCost = 0;
  for (const s of list) {
    const d = cheb(ux, uy, s.x, s.y);
    let bias = 120;
    if (s.isNeutral === 1) {
      bias = 0;
    } else if (s.isBase === 1) {
      bias = 400;
      if (push === 1) {
        bias = -260;
      }
      if (tick >= 520) {
        bias = -700;
      }
    } else {
      bias = 120;
      if (push === 1) {
        bias = -60;
      }
      if (tick >= 520) {
        bias = -120;
      }
    }
    const cost = d * 8 + bias;
    if (best === null || cost < bestCost) {
      best = s;
      bestCost = cost;
    }
  }
  return best;
}

// 军事单位(以及转为抢点的农民)的单 tick 单意图决策。
function actCombatant(
  uid: number,
  ux: number,
  uy: number,
  atkRange: number,
  foes: FoeRec[],
  foeSites: SiteRec[],
  blockSite: SiteRec[],
  blockTaken: number[],
  tick: number,
  canAttack: number,
  push: number,
): void {
  // 1) 射程内有敌人就打:同 tick 攻击同时结算,不用赌先后手
  if (canAttack === 1) {
    let best: FoeRec | null = null;
    let bestScore = 0;
    for (const f of foes) {
      const d = cheb(ux, uy, f.x, f.y);
      if (d > atkRange) {
        continue;
      }
      const score = f.hp * 8 + d;
      if (best === null || score < bestScore) {
        best = f;
        bestScore = score;
      }
    }
    if (best !== null) {
      const inRange = getRange(ux, uy, best.x, best.y);
      if (inRange <= atkRange) {
        attack(uid, best.id);
        return;
      }
    }
  }

  // 2) 记忆里的任务还成不成立:成立就继续走/站住
  const ti = taskIndexOf(uid);
  let target: SiteRec | null = null;
  if (ti >= 0) {
    const sid = taskSiteId[ti];
    const kind = taskKind[ti];
    if (sid !== undefined && kind !== undefined) {
      if (kind === 1) {
        target = findRec(blockSite, sid);
        if (target !== null) {
          const idx = indexOfRec(blockSite, sid);
          if (idx >= 0) {
            blockTaken[idx] = 1;
          }
        }
      } else {
        target = findRec(foeSites, sid);
      }
    }
  }
  if (target !== null) {
    const d = cheb(ux, uy, target.x, target.y);
    if (d === 0) {
      // 站在点位格上:驱动占领 / 堵点,不再移动
      return;
    }
    moveTo(uid, target.x, target.y);
    return;
  }

  // 3) 2 格内有敌人且能打:贴上去打掉威胁
  if (canAttack === 1) {
    const near = nearestFoe(ux, uy, foes, 2);
    if (near !== null) {
      moveTo(uid, near.x, near.y);
      return;
    }
  }

  // 4) 堵点:最近的受威胁自家资源点(资源点不占产线,站上去零成本)
  if (canAttack === 1) {
    let bs: SiteRec | null = null;
    let bsD = 0;
    let bsIdx = -1;
    for (let i = 0; i < blockSite.length; i += 1) {
      const s = blockSite[i];
      const taken = blockTaken[i];
      if (s === undefined || taken === undefined || taken !== 0) {
        continue;
      }
      const d = cheb(ux, uy, s.x, s.y);
      if (bs === null || d < bsD) {
        bs = s;
        bsD = d;
        bsIdx = i;
      }
    }
    if (bs !== null && bsIdx >= 0) {
      blockTaken[bsIdx] = 1;
      setTask(uid, bs.id, 1);
      const d = cheb(ux, uy, bs.x, bs.y);
      if (d !== 0) {
        moveTo(uid, bs.x, bs.y);
      }
      return;
    }
  }

  // 5) 踩点:站上点位格被动推进占领(没有“占领”这个动作函数)
  const pick = pickCapture(ux, uy, tick, push, foeSites);
  if (pick !== null) {
    setTask(uid, pick.id, 2);
    const d = cheb(ux, uy, pick.x, pick.y);
    if (d !== 0) {
      moveTo(uid, pick.x, pick.y);
    }
    return;
  }

  // 6) 无事可做:原地待命
}

// ================= 入口 =================
function loop(): void {
  const me = getMyIndex();
  const tick = getTick();
  const players = getObjectsByType("player");
  const sites = getObjectsByType("site");
  const units = getObjectsByType("unit");

  // 钱每 tick 重读,不跨 tick 记账
  let money = 0;
  for (const p of players) {
    if (p.index === me) {
      money = p.resources;
    }
  }

  // ---------- 点位分类 ----------
  const myBases: SiteRec[] = [];
  const myRes: SiteRec[] = [];
  const foeSites: SiteRec[] = [];
  for (const s of sites) {
    const rec: SiteRec = {
      id: s.id,
      x: s.x,
      y: s.y,
      isBase: s.kind === "base" ? 1 : 0,
      isNeutral: s.owner === -1 ? 1 : 0,
      left: s.remaining === undefined ? 0 : s.remaining,
      busy: s.producing === null ? 0 : 1,
    };
    if (s.owner === me) {
      if (rec.isBase === 1) {
        myBases.push(rec);
      } else {
        myRes.push(rec);
      }
    } else {
      foeSites.push(rec);
    }
  }

  // ---------- 单位分类 ----------
  const mine: MyRec[] = [];
  const foes: FoeRec[] = [];
  const aliveIds: number[] = [];
  let workerCount = 0;
  let armyCount = 0;
  for (const u of units) {
    if (u.owner === me) {
      const isWorker = u.type === "worker" ? 1 : 0;
      let rng = 1;
      if (u.type === "ranged") {
        rng = 2;
      }
      const rec: MyRec = {
        id: u.id,
        x: u.x,
        y: u.y,
        carry: u.carrying,
        worker: isWorker,
        range: rng,
      };
      mine.push(rec);
      aliveIds.push(u.id);
      if (isWorker === 1) {
        workerCount += 1;
      } else {
        armyCount += 1;
      }
    } else {
      foes.push({ id: u.id, x: u.x, y: u.y, hp: u.hp });
    }
  }

  // ---------- 生产:先补经济,后补军力 ----------
  let workerTarget = 5 + 2 * myRes.length;
  if (workerTarget > 20) {
    workerTarget = 20;
  }
  for (const base of myBases) {
    if (base.busy !== 0) {
      continue;
    }
    if (workerCount < workerTarget && tick < 400 && money >= 4) {
      const r = spawnUnit(base.id, "worker");
      if (!isError(r)) {
        money -= 4;
        workerCount += 1;
        continue;
      }
      const code = errCode(r);
      if (code === ERR_NOT_ENOUGH_RESOURCES) {
        // 资金不足:这一单不扣款、不占队列
        continue;
      }
      continue;
    }
    const wantRanged = armyCount > 0 && armyCount % 4 === 3 && money >= 12;
    const cost = wantRanged ? 12 : 8;
    if (money >= cost) {
      const r2 = spawnUnit(base.id, wantRanged ? "ranged" : "melee");
      if (!isError(r2)) {
        money -= cost;
        armyCount += 1;
      }
    }
  }

  // 是否转入强攻(有家底或临近终局才压上)
  const push = tick >= 460 || (tick >= 280 && armyCount >= 8) ? 1 : 0;

  // ---------- 受威胁的自家资源点(需要有人站上去堵) ----------
  const blockSite: SiteRec[] = [];
  const blockTaken: number[] = [];
  for (const s of myRes) {
    let threat = 0;
    for (const f of foes) {
      if (cheb(f.x, f.y, s.x, s.y) <= 4) {
        threat = 1;
        break;
      }
    }
    if (threat !== 1) {
      continue;
    }
    let occupied = 0;
    for (const m of mine) {
      if (m.x === s.x && m.y === s.y) {
        occupied = 1;
        break;
      }
    }
    blockSite.push(s);
    blockTaken.push(occupied);
  }

  // ---------- 农民:满载交付 / 就近采矿 / 没矿就抢点 ----------
  const resTally: number[] = [];
  for (const s of myRes) {
    resTally.push(0);
  }
  const captureWorkers = armyCount === 0 && tick < 220 ? 2 : 0;
  let wIndex = 0;

  for (const m of mine) {
    if (m.worker !== 1) {
      continue;
    }
    const wi = wIndex;
    wIndex += 1;

    // 没有己方基地:经济回不来,残兵照样抢点(经济死亡不等于出局)
    if (myBases.length === 0) {
      actCombatant(m.id, m.x, m.y, 1, foes, foeSites, blockSite, blockTaken, tick, 0, push);
      continue;
    }

    // 已经在踩点的农民:踩完(点位易主)才回来采矿
    const existing = taskIndexOf(m.id);
    if (existing >= 0) {
      const k = taskKind[existing];
      const sid = taskSiteId[existing];
      if (k === 2 && sid !== undefined && findRec(foeSites, sid) !== null) {
        actCombatant(m.id, m.x, m.y, 1, foes, foeSites, blockSite, blockTaken, tick, 0, push);
        continue;
      }
    }

    // 开局分两个农民去踩中立点:先占矿才能采,占下来就是 200 储量的家底
    if (wi < captureWorkers) {
      actCombatant(m.id, m.x, m.y, 1, foes, foeSites, blockSite, blockTaken, tick, 0, push);
      continue;
    }

    // 满载 → 走到自家基地相邻格交付(不出基地格,免得堵自家产线)
    if (m.carry >= 20) {
      const b = nearestRec(m.x, m.y, myBases);
      if (b === null) {
        continue;
      }
      const d = getRange(m.x, m.y, b.x, b.y);
      if (d === 1) {
        const r = transfer(m.id);
        if (isError(r)) {
          const code = errCode(r);
          if (code === ERR_NOT_OWNER) {
            continue;
          }
        }
      } else if (pickAdjacent(m.x, m.y, b.x, b.y)) {
        if (m.x !== tmpX || m.y !== tmpY) {
          moveTo(m.id, tmpX, tmpY);
        }
      }
      continue;
    }

    // 找一处还有余量、还没挤满人的自家活矿
    let target: SiteRec | null = null;
    let td = 0;
    let ti2 = -1;
    for (let i = 0; i < myRes.length; i += 1) {
      const s = myRes[i];
      const t = resTally[i];
      if (s === undefined || t === undefined) {
        continue;
      }
      if (s.left <= 0 || t >= 4) {
        continue;
      }
      const d = cheb(m.x, m.y, s.x, s.y);
      if (target === null || d < td) {
        target = s;
        td = d;
        ti2 = i;
      }
    }
    if (target === null) {
      // 全挤满了就退而采最近的活矿;全采空了就去抢点
      for (const s of myRes) {
        if (s.left > 0) {
          const d = cheb(m.x, m.y, s.x, s.y);
          if (target === null || d < td) {
            target = s;
            td = d;
            ti2 = -2;
          }
        }
      }
    }
    if (target === null) {
      actCombatant(m.id, m.x, m.y, 1, foes, foeSites, blockSite, blockTaken, tick, 0, push);
      continue;
    }
    if (ti2 >= 0) {
      const t = resTally[ti2];
      resTally[ti2] = (t === undefined ? 0 : t) + 1;
    }

    // 采集只认相邻格:站在矿格上不算相邻,先挪到邻格再开采
    const dd = getRange(m.x, m.y, target.x, target.y);
    if (dd === 1) {
      harvest(m.id, target.id);
    } else if (pickAdjacent(m.x, m.y, target.x, target.y)) {
      if (m.x !== tmpX || m.y !== tmpY) {
        moveTo(m.id, tmpX, tmpY);
      }
    }
  }

  // ---------- 军事单位:打威胁 → 守点 → 踩点 ----------
  for (const m of mine) {
    if (m.worker === 1) {
      continue;
    }
    actCombatant(m.id, m.x, m.y, m.range, foes, foeSites, blockSite, blockTaken, tick, 1, push);
  }

  // ---------- 修剪跨 tick 记忆:只留本 tick 仍存在的单位 ----------
  const keepU: number[] = [];
  const keepS: number[] = [];
  const keepK: number[] = [];
  for (let i = 0; i < taskUnitId.length; i += 1) {
    const uid = taskUnitId[i];
    const sid = taskSiteId[i];
    const kind = taskKind[i];
    if (uid === undefined || sid === undefined || kind === undefined) {
      continue;
    }
    let alive = 0;
    for (const a of aliveIds) {
      if (a === uid) {
        alive = 1;
        break;
      }
    }
    if (alive === 1) {
      keepU.push(uid);
      keepS.push(sid);
      keepK.push(kind);
    }
  }
  taskUnitId = keepU;
  taskSiteId = keepS;
  taskKind = keepK;
}