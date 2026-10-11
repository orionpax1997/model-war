// 扩张运营:先稳住经济与点位,攒够家底再转军事,按 tick 节奏推进。

var WORKER_COST = 4;
var MELEE_COST = 8;
var CARRY_LIMIT = 20;
var ARMY_START_TICK = 120;
var MIN_WORKERS_FOR_ARMY = 6;
var WORKER_GOAL_CAP = 16;
var ENGAGE_RADIUS = 12;
var RALLY_RADIUS = 2;

// 跨 tick 只保存数值:单位 id -> 资源点 id 的分配表。每 tick 按存活单位重建。
var assignTo: { [key: number]: number } = {};

function rangeOf(type: string): number {
  if (type === "ranged") {
    return 2;
  }
  return 1;
}

// 返回某格相邻的可通行格中,离单位最近的那一个;没有则为 null。
function edgeCell(cx: number, cy: number, ux: number, uy: number): { x: number; y: number } | null {
  let bestX = 0;
  let bestY = 0;
  let bestD = -1;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const x = cx + dx;
      const y = cy + dy;
      if (getTerrainAt(x, y) !== "plain") {
        continue;
      }
      const d = getRange(ux, uy, x, y);
      if (bestD === -1 || d < bestD) {
        bestD = d;
        bestX = x;
        bestY = y;
      }
    }
  }
  if (bestD === -1) {
    return null;
  }
  return { x: bestX, y: bestY };
}

function loop(): void {
  const me = getMyIndex();
  const tick = getTick();

  // 资金从快照读,不自己记。
  let funds = 0;
  const players = getObjectsByType("player");
  for (let i = 0; i < players.length; i += 1) {
    const p = players[i];
    if (p !== undefined && p.index === me) {
      funds = p.resources;
    }
  }

  const allSites = getObjectsByType("site");
  const bases = allSites.filter((s) => s.kind === "base" && s.owner === me);
  const resSites = allSites.filter((s) => s.kind === "resource");
  const usable = resSites.filter(
    (s) => (s.owner === -1 || s.owner === me) && (s.remaining === undefined || s.remaining > 0),
  );
  let mySiteCount = 0;
  for (let i = 0; i < resSites.length; i += 1) {
    const s = resSites[i];
    if (s !== undefined && s.owner === me) {
      mySiteCount += 1;
    }
  }

  const allUnits = getObjectsByType("unit");
  const mine = allUnits.filter((u) => u.owner === me);
  const foes = allUnits.filter((u) => u.owner !== me);
  const workers = mine.filter((u) => u.type === "worker");
  const army = mine.filter((u) => u.type !== "worker");

  // ---- 生产:每条产线一次一单;已有订单的产线不重复下单 ----
  let workerCount = workers.length;
  for (let i = 0; i < bases.length; i += 1) {
    const b = bases[i];
    if (b !== undefined && b.producing !== null && b.producing.type === "worker") {
      workerCount += 1;
    }
  }
  const wantWorkers = 6 + 2 * mySiteCount;
  const workerGoal = wantWorkers > WORKER_GOAL_CAP ? WORKER_GOAL_CAP : wantWorkers;

  let budget = funds;
  for (let i = 0; i < bases.length; i += 1) {
    const b = bases[i];
    if (b === undefined || b.producing !== null) {
      continue;
    }
    if (workerCount < workerGoal && budget >= WORKER_COST) {
      spawnUnit(b.id, "worker");
      budget -= WORKER_COST;
      workerCount += 1;
    } else if (tick >= ARMY_START_TICK && workers.length >= MIN_WORKERS_FOR_ARMY && budget >= MELEE_COST) {
      spawnUnit(b.id, "melee");
      budget -= MELEE_COST;
    }
  }

  // ---- 资源点分配:保留仍有效的旧分配,其余按负载最小、距离最近分配 ----
  const load: { [key: number]: number } = {};
  const nextAssign: { [key: number]: number } = {};

  for (let i = 0; i < workers.length; i += 1) {
    const w = workers[i];
    if (w === undefined) {
      continue;
    }
    const prev = assignTo[w.id];
    if (prev === undefined) {
      continue;
    }
    const stillValid = usable.filter((s) => s.id === prev).length > 0;
    if (stillValid) {
      nextAssign[w.id] = prev;
      const c = load[prev];
      load[prev] = c === undefined ? 1 : c + 1;
    }
  }

  for (let i = 0; i < workers.length; i += 1) {
    const w = workers[i];
    if (w === undefined || nextAssign[w.id] !== undefined) {
      continue;
    }
    let best = -1;
    let bestLoad = 0;
    let bestD = 0;
    for (let j = 0; j < usable.length; j += 1) {
      const s = usable[j];
      if (s === undefined) {
        continue;
      }
      const l0 = load[s.id];
      const l = l0 === undefined ? 0 : l0;
      const d = getRange(w.x, w.y, s.x, s.y);
      if (best === -1 || l < bestLoad || (l === bestLoad && d < bestD)) {
        best = s.id;
        bestLoad = l;
        bestD = d;
      }
    }
    if (best !== -1) {
      nextAssign[w.id] = best;
      const c = load[best];
      load[best] = c === undefined ? 1 : c + 1;
    }
  }
  assignTo = nextAssign;

  // ---- 农民:每人每 tick 只写一条意图 ----
  for (let i = 0; i < workers.length; i += 1) {
    const w = workers[i];
    if (w === undefined) {
      continue;
    }
    const sid = nextAssign[w.id];
    if (sid === undefined) {
      continue;
    }
    const site = allSites.filter((s) => s.id === sid)[0];
    if (site === undefined) {
      continue;
    }

    // 满载:交付到相邻己方基地;不靠占基地格(会堵产线)。
    if (w.carrying >= CARRY_LIMIT) {
      let home: { x: number; y: number } | null = null;
      let homeD = 0;
      for (let k = 0; k < bases.length; k += 1) {
        const b = bases[k];
        if (b === undefined) {
          continue;
        }
        const d = getRange(w.x, w.y, b.x, b.y);
        if (home === null || d < homeD) {
          home = { x: b.x, y: b.y };
          homeD = d;
        }
      }
      if (home !== null) {
        if (homeD <= 1) {
          transfer(w.id);
        } else {
          const cell = edgeCell(home.x, home.y, w.x, w.y);
          if (cell !== null) {
            moveTo(w.id, cell.x, cell.y);
          }
        }
      }
      continue;
    }

    if (site.owner === me) {
      // 己方资源点:站在相邻格上开采,不站在点位格本身。
      if (getRange(w.x, w.y, site.x, site.y) === 1) {
        harvest(w.id, site.id);
      } else {
        const cell = edgeCell(site.x, site.y, w.x, w.y);
        if (cell !== null) {
          moveTo(w.id, cell.x, cell.y);
        }
      }
    } else if (w.x !== site.x || w.y !== site.y) {
      // 中立资源点:站上去才驱动占领。
      moveTo(w.id, site.x, site.y);
    }
  }

  // ---- 军事:只在经济成型后启用;就近迎敌,否则守在主基地旁 ----
  const anchor = bases[0];
  for (let i = 0; i < army.length; i += 1) {
    const u = army[i];
    if (u === undefined) {
      continue;
    }
    const rng = rangeOf(u.type);

    let foeId = -1;
    let foeX = 0;
    let foeY = 0;
    let foeD = 0;
    for (let j = 0; j < foes.length; j += 1) {
      const f = foes[j];
      if (f === undefined) {
        continue;
      }
      if (anchor !== undefined && getRange(anchor.x, anchor.y, f.x, f.y) > ENGAGE_RADIUS) {
        continue;
      }
      const d = getRange(u.x, u.y, f.x, f.y);
      if (foeId === -1 || d < foeD) {
        foeId = f.id;
        foeX = f.x;
        foeY = f.y;
        foeD = d;
      }
    }

    if (foeId !== -1) {
      if (foeD <= rng) {
        attack(u.id, foeId);
      } else {
        moveTo(u.id, foeX, foeY);
      }
    } else if (anchor !== undefined) {
      if (getRange(u.x, u.y, anchor.x, anchor.y) > RALLY_RADIUS) {
        const cell = edgeCell(anchor.x, anchor.y, u.x, u.y);
        if (cell !== null) {
          moveTo(u.id, cell.x, cell.y);
        }
      }
    }
  }
}