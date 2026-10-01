// runtime.mjs —— 每方一个 vm context（近似 hld §4.5 的沙箱形态）：
// 脚本可见的全局 = 本文件注入的 API 面 + 契约文档允许的纯函数子集；
// 宿主桥函数在初始化后从 VM 全局删除（草案 §9-10：__* 已删除且进黑名单）。
//
// 桩与真 engine 的差别（已知且可接受）：
//   - 不跑 QuickJS/WASI，不做控制流事件计数、API 预算、内存判据（map.md：桩不带预算裁决）；
//   - 异常只按"loop() 抛异常"计 exceptionTicks，不做预算/内存转异常；
//   - 快照用深拷贝传入（对象身份不跨 tick 的语义由快照结构保证，不做 Object.freeze）。

import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { RULESET, chebyshev } from './ruleset.mjs';

// 契约草案里 4 份脚本源都是 TS 记法（票 07 wording-risks：TS/JS 记法未定义），
// 桩按 hld §7.4 的做法先剥离类型再装载。
export function stripTypes(src) {
  return stripTypeScriptTypes(src, { mode: 'strip' });
}

// runtime bundle：注入 guest 侧的 API 实现（闭包内持有宿主桥，桥名不进 guest 全局）
const BUNDLE = `
'use strict';
(function (bridge, TERRAIN, SIZE, CONST) {
  let snap = null;
  let unitById = null;
  let siteById = null;
  let prodByBase = null;
  const intents = [];
  let apiCalls = 0;
  let pathCalls = 0;

  const D8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

  function idx(id) { return unitById.get(id); }
  function sidx(id) { return siteById.get(id); }
  function cheb(ax, ay, bx, by) {
    const dx = ax > bx ? ax - bx : bx - ax;
    const dy = ay > by ? ay - by : by - ay;
    return dx > dy ? dx : dy;
  }
  function plain(x, y) {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return false;
    return TERRAIN[y][x] === 'plain';
  }

  // ---- 快照装载（宿主每 tick 调一次）----
  function setSnapshot(s) {
    snap = s;
    unitById = new Map();
    siteById = new Map();
    prodByBase = new Map();
    for (const u of snap.units) unitById.set(u.id, u);
    for (const st of snap.sites) siteById.set(st.id, st);
    for (const pr of snap.productions) prodByBase.set(pr.baseId, pr);
    intents.length = 0;
  }

  // ---- 查询 API（draft api.md §3）----
  function getTick() { apiCalls++; return snap.tick; }

  function getObjectById(id) {
    apiCalls++;
    if (typeof id !== 'number') return null;
    return unitById.get(id) || siteById.get(id) || prodByBase.get(id) || null;
  }

  function getObjectsByType(kind, filter) {
    apiCalls++;
    const list = kind === 'unit' ? snap.units : snap.sites;
    const out = [];
    for (const o of list) {
      if (filter) {
        if (filter.owner !== undefined && filter.owner !== null && o.owner !== filter.owner) continue;
        if (filter.type !== undefined && filter.type !== null && o.type !== filter.type) continue;
        if (filter.kind !== undefined && filter.kind !== null && o.kind !== filter.kind) continue;
      }
      out.push(o);
    }
    return out;
  }

  function getRange(ax, ay, bx, by) { apiCalls++; return cheb(ax, ay, bx, by); }

  function getTerrainAt(x, y) {
    apiCalls++;
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return 'out';
    return TERRAIN[y][x];
  }

  function findPath(sx, sy, tx, ty) {
    apiCalls++; pathCalls++;
    if (!Number.isInteger(sx) || !Number.isInteger(sy) || !Number.isInteger(tx) || !Number.isInteger(ty)) return null;
    if (!plain(tx, ty)) return null;
    if (sx === tx && sy === ty) return [];
    const prev = new Map();
    const seen = new Set([sx + ',' + sy]);
    let frontier = [[sx, sy]];
    while (frontier.length) {
      const next = [];
      for (const [x, y] of frontier) {
        for (const [dx, dy] of D8) {
          const nx = x + dx, ny = y + dy;
          if (!plain(nx, ny)) continue;
          const k = nx + ',' + ny;
          if (seen.has(k)) continue;
          seen.add(k);
          prev.set(k, x + ',' + y);
          if (nx === tx && ny === ty) {
            const path = [];
            let cur = k;
            while (cur !== sx + ',' + sy) {
              const parts = cur.split(',');
              path.push({ x: Number(parts[0]), y: Number(parts[1]) });
              cur = prev.get(cur);
            }
            path.reverse();
            return path;
          }
          next.push([nx, ny]);
        }
      }
      frontier = next;
    }
    return null;
  }

  // ---- 动作 API（draft api.md §4）：收集 + 界检查 + API 计数，终裁交宿主 ----
  function ownedUnit(unitId) {
    if (typeof unitId !== 'number') return null;
    const u = idx(unitId);
    if (!u) return 'ERR_INVALID_UNIT';
    if (u.owner !== bridge.playerIndex) return 'ERR_NOT_OWNER';
    return u;
  }

  function move(unitId, dx, dy) {
    apiCalls++;
    const u = ownedUnit(unitId);
    if (u !== null && typeof u === 'string') return u;
    if (dx !== -1 && dx !== 0 && dx !== 1) return 'ERR_BAD_ARGS';
    if (dy !== -1 && dy !== 0 && dy !== 1) return 'ERR_BAD_ARGS';
    if (!plain(u.x + dx, u.y + dy)) return 'ERR_BAD_ARGS';
    if (dx === 0 && dy === 0) return 'ERR_BAD_ARGS';
    intents.push({ kind: 'move', unitId: unitId, dx: dx, dy: dy });
    return undefined;
  }

  function moveTo(unitId, x, y) {
    apiCalls++;
    const u = ownedUnit(unitId);
    if (u !== null && typeof u === 'string') return u;
    if (!Number.isInteger(x) || !Number.isInteger(y)) return 'ERR_BAD_ARGS';
    if (!plain(x, y)) return 'ERR_BAD_ARGS';
    if (u.x === x && u.y === y) return 'ERR_BAD_ARGS';
    const path = findPath(u.x, u.y, x, y);
    if (path === null || path.length === 0) return 'ERR_BAD_ARGS';
    intents.push({ kind: 'moveTo', unitId: unitId, x: x, y: y });
    return undefined;
  }

  function attack(unitId, targetId) {
    apiCalls++;
    const u = ownedUnit(unitId);
    if (u !== null && typeof u === 'string') return u;
    if (typeof targetId !== 'number') return 'ERR_INVALID_TARGET';
    const t = idx(targetId);
    if (!t) return 'ERR_INVALID_TARGET';   // 目标不存在（含"打基地"——基地不是 unit）
    if (t.owner === u.owner) return 'ERR_INVALID_TARGET';
    if (CONST.UNIT_DAMAGE[u.type] <= 0) return 'ERR_INVALID_TARGET'; // 无攻击能力
    if (cheb(u.x, u.y, t.x, t.y) > CONST.UNIT_RANGE[u.type]) return 'ERR_OUT_OF_RANGE';
    intents.push({ kind: 'attack', unitId: unitId, targetId: targetId });
    return undefined;
  }

  function harvest(unitId, siteId) {
    apiCalls++;
    const u = ownedUnit(unitId);
    if (u !== null && typeof u === 'string') return u;
    if (u.type !== 'worker') return 'ERR_INVALID_SITE';
    if (typeof siteId !== 'number') return 'ERR_INVALID_SITE';
    const s = sidx(siteId);
    if (!s || s.kind !== 'resource') return 'ERR_INVALID_SITE';
    if (s.owner !== u.owner) return 'ERR_NOT_OWNER';
    if (cheb(u.x, u.y, s.x, s.y) > 1) return 'ERR_OUT_OF_RANGE';
    if (u.carrying >= CONST.CARRY_LIMIT) return 'ERR_OUT_OF_RANGE';
    if (s.remaining <= 0) return 'ERR_INVALID_SITE';
    intents.push({ kind: 'harvest', unitId: unitId, siteId: siteId });
    return undefined;
  }

  function transfer(unitId) {
    apiCalls++;
    const u = ownedUnit(unitId);
    if (u !== null && typeof u === 'string') return u;
    if (u.carrying <= 0) return 'ERR_BAD_ARGS';
    let best = null;
    for (const s of snap.sites) {
      if (s.kind !== 'base' || s.owner !== u.owner) continue;
      if (cheb(u.x, u.y, s.x, s.y) > 1) continue;
      if (best === null || s.id < best.id) best = s;
    }
    if (best === null) return 'ERR_NOT_OWNER';
    intents.push({ kind: 'transfer', unitId: unitId });
    return undefined;
  }

  function spawnUnit(baseId, unitType) {
    apiCalls++;
    if (typeof baseId !== 'number') return 'ERR_INVALID_SITE';
    const s = sidx(baseId);
    if (!s || s.kind !== 'base') return 'ERR_INVALID_SITE';
    if (s.owner !== bridge.playerIndex) return 'ERR_NOT_OWNER';
    const cost = CONST.UNIT_COST[unitType];
    if (cost === undefined) return 'ERR_BAD_ARGS';
    if (snap.players[bridge.playerIndex].resources < cost) return 'ERR_NOT_ENOUGH_RESOURCES';
    intents.push({ kind: 'spawnUnit', baseId: baseId, unitType: unitType });
    return undefined;
  }

  globalThis.getTick = getTick;
  globalThis.getObjectById = getObjectById;
  globalThis.getObjectsByType = getObjectsByType;
  globalThis.getRange = getRange;
  globalThis.getTerrainAt = getTerrainAt;
  globalThis.findPath = findPath;
  globalThis.move = move;
  globalThis.moveTo = moveTo;
  globalThis.attack = attack;
  globalThis.harvest = harvest;
  globalThis.transfer = transfer;
  globalThis.spawnUnit = spawnUnit;
  // 常量表（api.md §6）
  globalThis.TICK_LIMIT = CONST.TICK_LIMIT;
  globalThis.HARVEST_RATE = CONST.HARVEST_RATE;
  globalThis.CARRY_LIMIT = CONST.CARRY_LIMIT;
  globalThis.RESOURCE_PER_SITE = CONST.RESOURCE_PER_SITE;
  globalThis.CAPTURE_TICKS = CONST.CAPTURE_TICKS;
  globalThis.BASE_SCORE = CONST.BASE_SCORE;
  globalThis.RESOURCE_SCORE = CONST.RESOURCE_SCORE;
  globalThis.UNIT_COST_DIVISOR = CONST.UNIT_COST_DIVISOR;

  bridge.__install({
    setSnapshot: setSnapshot,
    drain: function () { const out = intents.slice(); intents.length = 0; return { intents: out, apiCalls: apiCalls, pathCalls: pathCalls }; },
  });
})(__bridge, __terrain, __size, __const);
delete globalThis.__bridge;
delete globalThis.__terrain;
delete globalThis.__size;
delete globalThis.__const;
`;

function buildConsts(ruleset) {
  return {
    TICK_LIMIT: ruleset.tickLimit,
    HARVEST_RATE: ruleset.harvestRate,
    CARRY_LIMIT: ruleset.carryLimit,
    RESOURCE_PER_SITE: ruleset.resourcePerSite,
    CAPTURE_TICKS: ruleset.captureTicks,
    BASE_SCORE: ruleset.baseScore,
    RESOURCE_SCORE: ruleset.resourceScore,
    UNIT_COST_DIVISOR: ruleset.unitCostDivisor,
    UNIT_COST: {
      worker: ruleset.roster.worker.cost, melee: ruleset.roster.melee.cost,
      ranged: ruleset.roster.ranged.cost, cavalry: ruleset.roster.cavalry.cost,
    },
    UNIT_DAMAGE: {
      worker: ruleset.roster.worker.damage, melee: ruleset.roster.melee.damage,
      ranged: ruleset.roster.ranged.damage, cavalry: ruleset.roster.cavalry.damage,
    },
    UNIT_RANGE: {
      worker: ruleset.roster.worker.range, melee: ruleset.roster.melee.range,
      ranged: ruleset.roster.ranged.range, cavalry: ruleset.roster.cavalry.range,
    },
  };
}

// 沙箱内可见全局 = context 自带内建 + 本文件注入的 API 面 + 常量表。
// 不注入宿主能力：无 Date / performance / queueMicrotask / 定时器 / fetch / process / require / eval
// （codeGeneration.strings=false 直接关掉 guest 内的 eval 与 new Function）。

export function createPlayerRuntime({ source, playerIndex, map, ruleset = RULESET, label = '' }) {
  const ctx = vm.createContext(Object.create(null), {
    name: `player-${playerIndex}${label ? `-${label}` : ''}`,
    codeGeneration: { strings: false, wasm: false },
  });
  const bridge = { playerIndex };
  let guest = null;
  const counters = { apiCalls: 0, pathCalls: 0, loopCalls: 0 };

  ctx.__bridge = bridge;
  ctx.__terrain = map.terrain;
  ctx.__size = map.size;
  ctx.__const = buildConsts(ruleset);
  bridge.__install = (api) => { guest = api; };
  vm.runInContext(BUNDLE, ctx, { filename: 'runtime-bundle.js' });
  vm.runInContext(stripTypes(source), ctx, { filename: `script(player-${playerIndex}).js` });

  if (typeof ctx.loop !== 'function') throw new Error('script must declare a top-level `function loop()`');

  // vm context 自带一套内建（Math/JSON/Map/Set/…）+ 无宿主能力（无 performance/setTimeout/fetch/process/require）。
  // 再按契约把非确定源与动态求值显式置空（真实链路是静态校验拒绝；桩里置空使误用表现为异常，可被取证发现）：
  //   Math.random / Date / eval / Function / queueMicrotask / performance
  vm.runInContext(
    'globalThis.Math.random = undefined; globalThis.Date = undefined; globalThis.eval = undefined;' +
    ' globalThis.Function = undefined; globalThis.queueMicrotask = undefined; globalThis.performance = undefined;',
    ctx,
  );

  return {
    label,
    callLoop(snapshot) {
      // 深拷贝：与真 engine 一样保证"你改副本不影响引擎、对象身份不跨 tick"
      const copy = JSON.parse(JSON.stringify(snapshot));
      guest.setSnapshot(copy);
      counters.loopCalls += 1;
      ctx.loop();
      const drained = guest.drain();
      counters.apiCalls += drained.apiCalls;
      counters.pathCalls += drained.pathCalls;
      return drained.intents;
    },
    counters,
    // 取证用：宿主观测 guest 的模块级变量（只读，不参与结算）
    peek: (expr) => vm.runInContext(expr, ctx),
    get globals() { return ctx; },
  };
}

// 不放脚本的座位（桩对拼实验里的旁观方/缺席方）
export function createIdleRuntime() {
  return { label: 'idle', callLoop: () => [], counters: { apiCalls: 0, pathCalls: 0, loopCalls: 0 } };
}

export { chebyshev };
