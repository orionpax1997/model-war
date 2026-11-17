// 参赛脚本 v1:经济(采集与交付)+ 近战为主的兵力 + 抢占点位。
// 座位只从 getMyIndex() 读取;跨 tick 只保存数值;每单位每 tick 只提交一条意图。

var sdCarry = 20;
var sdCostWorker = 4;
var sdCostMelee = 8;
var sdWorkerCap = 12;

function sdCheb(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax > bx ? ax - bx : bx - ax;
  const dy = ay > by ? ay - by : by - ay;
  return dx > dy ? dx : dy;
}

// 选一个可站立的相邻格(平地)。salt 用来打散同一目标上的多个单位,避免都挤同一格。
function sdStandCell(cx: number, cy: number, salt: number): { x: number; y: number } | null {
  const off = salt % 9;
  for (let s = 0; s < 9; s += 1) {
    const c = (s + off) % 9;
    if (c === 4) {
      continue;
    }
    const col = c % 3;
    const row = (c - col) / 3;
    const x = cx + col - 1;
    const y = cy + row - 1;
    if (getTerrainAt(x, y) === "plain") {
      return { x: x, y: y };
    }
  }
  return null;
}

function sdNearest<T extends { x: number; y: number }>(fx: number, fy: number, list: T[]): T | null {
  let best: T | null = null;
  let bestD = 0;
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    if (c === undefined) {
      continue;
    }
    const d = sdCheb(fx, fy, c.x, c.y);
    if (best === null || d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

function loop() {
  const me = getMyIndex();

  const players = getObjectsByType("player");
  let gold = 0;
  for (let i = 0; i < players.length; i += 1) {
    const p = players[i];
    if (p !== undefined && p.index === me) {
      gold = p.resources;
    }
  }

  const sites = getObjectsByType("site");
  const units = getObjectsByType("unit");

  const myBases = sites.filter((s) => s.owner === me && s.kind === "base");
  const myMines = sites.filter(
    (s) => s.owner === me && s.kind === "resource" && (s.remaining === undefined || s.remaining > 0),
  );
  const goals = sites.filter((s) => s.owner !== me);

  const myUnits = units.filter((u) => u.owner === me);
  const foes = units.filter((u) => u.owner !== me);
  const myWorkers = myUnits.filter((u) => u.type === "worker");
  const myFighters = myUnits.filter((u) => u.type !== "worker");

  // 生产:每条产线空着才下单;先补农民到目标数,再出近战。
  let budget = gold;
  let workerCount = myWorkers.length;
  let workerGoal = myMines.length * 2 + 2;
  if (workerGoal > sdWorkerCap) {
    workerGoal = sdWorkerCap;
  }
  for (let i = 0; i < myBases.length; i += 1) {
    const b = myBases[i];
    if (b === undefined || b.producing !== null) {
      continue;
    }
    if (workerCount < workerGoal && budget >= sdCostWorker) {
      const r = spawnUnit(b.id, "worker");
      if (!isError(r)) {
        budget -= sdCostWorker;
        workerCount += 1;
      }
      continue;
    }
    if (budget >= sdCostMelee) {
      const r2 = spawnUnit(b.id, "melee");
      if (!isError(r2)) {
        budget -= sdCostMelee;
      }
    }
  }

  // 农民:满载或无矿可采时送基地交付,否则去最近的己方矿采集。
  for (let i = 0; i < myWorkers.length; i += 1) {
    const w = myWorkers[i];
    if (w === undefined) {
      continue;
    }
    const deliver = w.carrying >= sdCarry || (w.carrying > 0 && myMines.length === 0);
    if (deliver) {
      const base = sdNearest(w.x, w.y, myBases);
      if (base === null) {
        continue;
      }
      if (sdCheb(w.x, w.y, base.x, base.y) <= 1) {
        transfer(w.id);
      } else {
        const cell = sdStandCell(base.x, base.y, w.id);
        if (cell !== null) {
          moveTo(w.id, cell.x, cell.y);
        }
      }
      continue;
    }
    const mine = sdNearest(w.x, w.y, myMines);
    if (mine === null) {
      continue;
    }
    if (sdCheb(w.x, w.y, mine.x, mine.y) <= 1) {
      harvest(w.id, mine.id);
    } else {
      const cell2 = sdStandCell(mine.x, mine.y, w.id);
      if (cell2 !== null) {
        moveTo(w.id, cell2.x, cell2.y);
      }
    }
  }

  // 战斗单位:近处有敌就打(或贴近),否则去抢最近的非己方点位。
  for (let i = 0; i < myFighters.length; i += 1) {
    const f = myFighters[i];
    if (f === undefined) {
      continue;
    }
    const range = f.type === "ranged" ? 2 : 1;
    const foe = sdNearest(f.x, f.y, foes);
    if (foe !== null && sdCheb(f.x, f.y, foe.x, foe.y) <= 10) {
      const d = sdCheb(f.x, f.y, foe.x, foe.y);
      if (d <= range) {
        attack(f.id, foe.id);
      } else {
        moveTo(f.id, foe.x, foe.y);
      }
      continue;
    }
    const goal = sdNearest(f.x, f.y, goals);
    if (goal === null) {
      continue;
    }
    if (f.x === goal.x && f.y === goal.y) {
      continue;
    }
    moveTo(f.id, goal.x, goal.y);
  }
}