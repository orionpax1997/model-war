// engine.mjs —— throwaway 最小结算模拟器：实现 draft rules.md §2 的 tick 结算语义。
//
// 它不是真 engine（不落 packages/、不跑 QuickJS、不做预算/内存裁决），但严格照抄草案的
// 结算顺序（顺序即规范）：dispatch → validate → movement → combat → objectTick → evaluate。
// 额外挂一层 trace（统计与取证），供 harness 产出证据。

import { RULESET, chebyshev } from './ruleset.mjs';

export const DIR8 = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

function rot90(x, y, size) {
  return [size - 1 - y, x];
}

export function createGame({ map, ruleset = RULESET, startResources = ruleset.initialResources, trace = true }) {
  const state = {
    tick: 0,
    map,
    ruleset,
    players: [0, 1, 2, 3].map((index) => ({
      index, resources: startResources, alive: true, exceptionTicks: 0, eliminatedAt: null,
    })),
    units: new Map(),
    sites: map.sites.map((s) => ({ ...s })),
    productions: new Map(), // baseId -> { baseId, type, ticksLeft }
    nextId: (() => { const maxSite = map.sites.reduce((m, s) => Math.max(m, s.id), 0); let n = maxSite + 1; return () => n++; })(),
    outcome: null,
    events: [],
    stats: trace ? createTrace() : null,
  };
  for (const su of map.spawnUnits) {
    createUnit(state, su.owner, su.type, su.x, su.y);
  }
  return state;
}

function createTrace() {
  return {
    // 战斗：按兵种归因
    damageByType: { worker: 0, melee: 0, ranged: 0, cavalry: 0 },
    killsByType: { worker: 0, melee: 0, ranged: 0, cavalry: 0 },
    deathsByType: { worker: 0, melee: 0, ranged: 0, cavalry: 0 },
    damageTakenByType: { worker: 0, melee: 0, ranged: 0, cavalry: 0 },
    firstStrike: null, // { tick, attacker, target, dist } 首个有效开火
    firstContact: null, // { tick, a, b, dist } 首个敌对接触（Chebyshev ≤ 2）
    // 占领：驱动者兵种归因
    captureTicksByDriverType: { worker: 0, melee: 0, ranged: 0, cavalry: 0 },
    sitesCapturedByDriverType: { worker: 0, melee: 0, ranged: 0, cavalry: 0 },
    // 占领：按“易主后的属主 × 驱动兵种”归因（取证：每方的占领效率）
    sitesCapturedByPlayerDriver: [
      { worker: 0, melee: 0, ranged: 0, cavalry: 0 },
      { worker: 0, melee: 0, ranged: 0, cavalry: 0 },
      { worker: 0, melee: 0, ranged: 0, cavalry: 0 },
      { worker: 0, melee: 0, ranged: 0, cavalry: 0 },
    ],
    // 经济
    harvested: 0,
    deliveredByPlayer: [0, 0, 0, 0],
    harvestedByPlayer: [0, 0, 0, 0],
    spawnOrders: 0,
    spawnOrdersRejectedBusyBase: 0,
    discardedIntents: 0,
    discardedByKind: {},
    refunds: 0,
    // 全图储量轨迹（每 tick 采样）
    remainingSamples: [],
  };
}

export function createUnit(state, owner, type, x, y) {
  const spec = state.ruleset.roster[type];
  const u = {
    id: state.nextId(), owner, type, x, y, hp: spec.hp, carrying: 0, lastAttackerId: null,
  };
  state.units.set(u.id, u);
  return u;
}

export function unitsOf(state, owner) {
  const out = [];
  for (const u of state.units.values()) if (u.owner === owner) out.push(u);
  out.sort((a, b) => a.id - b.id);
  return out;
}

function sortedUnits(state) {
  return [...state.units.values()].sort((a, b) => a.id - b.id);
}

function unitAt(state, x, y) {
  for (const u of state.units.values()) if (u.x === x && u.y === y) return u;
  return null;
}

function sitesOf(state, kind) {
  return state.sites.filter((s) => s.kind === kind).sort((a, b) => a.id - b.id);
}

function isPlain(state, x, y) {
  const { map } = state;
  if (x < 0 || y < 0 || x >= map.size || y >= map.size) return false;
  return map.terrain[y][x] === 'plain';
}

// --- 快照（draft api.md §1：只读副本、字段形状固定）---
export function buildSnapshot(state) {
  return {
    tick: state.tick,
    players: state.players.map((p) => ({
      index: p.index, resources: p.resources, alive: p.alive, exceptionTicks: p.exceptionTicks,
    })),
    units: sortedUnits(state).map((u) => ({
      id: u.id, owner: u.owner, type: u.type, x: u.x, y: u.y, hp: u.hp, carrying: u.carrying,
    })),
    sites: state.sites.map((s) => ({
      id: s.id, kind: s.kind, x: s.x, y: s.y, owner: s.owner,
      progressOwner: s.progressOwner, progress: s.progress,
      ...(s.kind === 'resource' ? { remaining: s.remaining } : {}),
    })),
    productions: [...state.productions.values()]
      .map((q) => ({ baseId: q.baseId, type: q.type, ticksLeft: q.ticksLeft }))
      .sort((a, b) => a.baseId - b.baseId),
  };
}

function note(state, kind, detail) {
  // detail 先展开、kind/tick 后写：detail 里可能也带 kind（如点位 kind）字段
  if (state.events.length < 4000) state.events.push({ ...detail, tick: state.tick, kind });
}

// --- 主 tick 管线 ---
// runtimes[playerIndex] = { callLoop(snapshotPlainObject) -> Intent[] }；异常由本函数捕获计异常。
export function runTick(state, runtimes) {
  const { ruleset } = state;

  // 0. dispatch：构建只读快照 → 按 playerIndex 0..3 串行执行 loop()，收集 intents
  const snapshot = buildSnapshot(state);
  const intents = [];
  for (let p = 0; p < 4; p++) {
    if (!state.players[p].alive) continue; // 淘汰方 loop() 不再执行
    const rt = runtimes[p];
    if (!rt) continue;
    let collected;
    try {
      collected = rt.callLoop(snapshot);
    } catch (err) {
      state.players[p].exceptionTicks++;
      if (state.stats) {
        state.events.push({ tick: state.tick, kind: 'exception', player: p, message: String(err && err.message) });
      }
      continue; // 本 tick 该方 intents 置空（原地待命），不影响其他三方
    }
    for (const it of collected) intents.push({ ...it, player: p });
  }

  // 1. validate：先按单位分组、每单位只留最后一个（静默丢弃，不计异常），
  //    再按 playerIndex 0..3、unitId 升序逐条校验；无效者丢弃（写事件流，不计异常）
  const unitLast = new Map(); // `${player}:${unitId}` -> intent
  const spawnLast = new Map(); // `${player}:${baseId}` -> intent
  const order = [];
  for (const it of intents) {
    if (it.kind === 'spawnUnit') {
      const key = `${it.player}:${it.baseId}`;
      if (!spawnLast.has(key)) order.push({ key, spawn: true });
      spawnLast.set(key, it);
    } else {
      const key = `${it.player}:${it.unitId}`;
      if (!unitLast.has(key)) order.push({ key, spawn: false });
      unitLast.set(key, it);
    }
  }
  const valid = [];
  order.sort((a, b) => {
    if (a.spawn !== b.spawn) return a.spawn ? 1 : -1; // 单位级先于玩家级（仅影响校验顺序，无语义依赖）
    const [pa, ua] = a.key.split(':').map(Number);
    const [pb, ub] = b.key.split(':').map(Number);
    if (pa !== pb) return pa - pb;
    return ua - ub;
  });
  for (const entry of order) {
    const it = entry.spawn ? spawnLast.get(entry.key) : unitLast.get(entry.key);
    const checked = entry.spawn ? checkSpawn(state, it) : checkUnitIntent(state, it);
    if (checked.ok) {
      if (checked.intent) valid.push(checked.intent);
    } else discard(state, it, checked.code);
  }

  // 2. movement：占位基准 + 轮转优先；骑兵二次移动 = 重复整轮一次
  //    二次步的语义（解释性决策，README 有记）：首步被裁掉的骑兵不享受二次步；
  //    首步成功的骑兵再走一步（move 沿原方向、moveTo 沿重算路径的第一步），二次轮同样吃占位与轮转裁决。
  const moves = valid.filter((v) => v.kind === 'move' || v.kind === 'moveTo');
  const movedRound1 = resolveMovementRound(state, moves);
  const secondSteps = [];
  for (const m of moves) {
    if (state.ruleset.roster[m.moveType].speed < 2 || !movedRound1.has(m.unitId)) continue;
    const u = state.units.get(m.unitId);
    if (!u) continue;
    if (m.kind === 'move') {
      const nx = u.x + m.dx;
      const ny = u.y + m.dy;
      if (isPlain(state, nx, ny) && !(nx === u.x && ny === u.y)) {
        secondSteps.push({ kind: 'move', unitId: m.unitId, player: m.player, nx, ny, moveType: 'cavalry' });
      }
    } else {
      const path = findPath(state, u.x, u.y, m.x, m.y);
      if (path && path.length > 0) {
        const [nx, ny] = path[0];
        if (isPlain(state, nx, ny)) {
          secondSteps.push({ kind: 'move', unitId: m.unitId, player: m.player, nx, ny, moveType: 'cavalry' });
        }
      }
    }
  }
  if (secondSteps.length > 0) resolveMovementRound(state, secondSteps);

  // 3. combat：同 tick 全部 attack 同时结算（先算全部伤害，再统一扣血，归零者死亡移除）
  const attacks = valid.filter((v) => v.kind === 'attack');
  const dmgByTarget = new Map();     // targetId -> 总伤害
  const contribByTarget = new Map(); // targetId -> Map(attackerType -> 伤害)，用于击杀归因
  for (const a of attacks) {
    const attacker = state.units.get(a.unitId);
    const target = state.units.get(a.targetId);
    if (!attacker || !target) continue;
    const spec = ruleset.roster[attacker.type];
    if (spec.damage <= 0) continue;
    dmgByTarget.set(a.targetId, (dmgByTarget.get(a.targetId) ?? 0) + spec.damage);
    if (!contribByTarget.has(a.targetId)) contribByTarget.set(a.targetId, new Map());
    const contrib = contribByTarget.get(a.targetId);
    contrib.set(attacker.type, (contrib.get(attacker.type) ?? 0) + spec.damage);
    target.lastAttackerId = attacker.id;   // 取证：最后一个打出伤害的攻击者（跨 tick 也记）
    if (state.stats) {
      state.stats.damageByType[attacker.type] += spec.damage;
      if (state.stats.firstStrike === null) {
        state.stats.firstStrike = {
          tick: state.tick,
          attackerType: attacker.type,
          targetType: target.type,
          dist: chebyshev(attacker.x, attacker.y, target.x, target.y),
        };
      }
    }
  }
  let killedThisTick = 0;
  const killedDetail = [];
  for (const [targetId, dmg] of [...dmgByTarget.entries()].sort((a, b) => a[0] - b[0])) {
    const target = state.units.get(targetId);
    if (!target) continue;
    target.hp -= dmg;
    if (state.stats) {
      state.stats.damageTakenByType[target.type] += dmg;
      if (target.hp <= 0) {
        killedThisTick += 1;
        state.stats.deathsByType[target.type] += 1;
        let bestType = null;
        let bestDmg = -1;
        for (const [type, d] of contribByTarget.get(targetId) ?? []) {
          if (d > bestDmg) { bestDmg = d; bestType = type; }
        }
        if (bestType) state.stats.killsByType[bestType] += 1;
      }
    }
    if (target.hp <= 0) {
      // 取证：逐个死亡的完整归因（谁打的、什么兵种、在哪）
      const contrib = [...(contribByTarget.get(targetId) ?? [])].sort((a, b) => b[1] - a[1]);
      killedDetail.push({
        victim: { id: target.id, owner: target.owner, type: target.type, x: target.x, y: target.y },
        byType: contrib.map(([type, d]) => `${type}:${d}`).join('+') || null,
        by: target.lastAttackerId ?? null,
      });
      state.units.delete(targetId);
    }
  }
  if (killedThisTick > 0) note(state, 'units-destroyed', { count: killedThisTick, killed: killedDetail });

  // 3.5 取证用：敌对接触首 tick（Chebyshev ≤ 2）
  if (state.stats && state.stats.firstContact === null) {
    const us = sortedUnits(state);
    outer:
    for (let i = 0; i < us.length; i++) {
      for (let j = i + 1; j < us.length; j++) {
        if (us[i].owner === us[j].owner) continue;
        const d = chebyshev(us[i].x, us[i].y, us[j].x, us[j].y);
        if (d <= 2) {
          state.stats.firstContact = {
            tick: state.tick, a: us[i].type, b: us[j].type, dist: d,
            aOwner: us[i].owner, bOwner: us[j].owner,
          };
          break outer;
        }
      }
    }
  }

  // 4. objectTick：按对象数值 id 升序，a) 占领 b) 采集 c) 交付 d) 生产
  for (const s of state.sites) {
    if (s.kind === 'base' || s.kind === 'resource') applyCapture(state, s);
  }
  for (const h of valid.filter((v) => v.kind === 'harvest')) applyHarvest(state, h);
  for (const t of valid.filter((v) => v.kind === 'transfer')) applyTransfer(state, t);
  for (const q of [...state.productions.values()].sort((a, b) => a.baseId - b.baseId)) {
    applyProduction(state, q);
  }

  // 5. evaluate：a) 淘汰 → 点位回归中立  b) 全点位归属单一玩家  c) 捷径条款  d) 淘汰方不再执行
  evaluate(state);

  // 6. trace 采样
  if (state.stats) {
    let remaining = 0;
    for (const s of state.sites) if (s.kind === 'resource') remaining += s.remaining;
    state.stats.remainingSamples.push(remaining);
  }

  // 7. tick++
  state.tick++;
  return state;
}

// 击杀归因已在 combat 阶段内完成（见 contribByTarget）。

function discard(state, intent, code) {
  if (state.stats) {
    state.stats.discardedIntents += 1;
    const k = `${intent.kind}:${code}`;
    state.stats.discardedByKind[k] = (state.stats.discardedByKind[k] ?? 0) + 1;
  }
  note(state, 'intent-discarded', { player: intent.player, kind: intent.kind, code, unitId: intent.unitId, baseId: intent.baseId });
}

function checkUnitIntent(state, it) {
  const { ruleset } = state;
  const u = state.units.get(it.unitId);
  if (!u) return { ok: false, code: 'ERR_INVALID_UNIT' };
  if (u.owner !== it.player) return { ok: false, code: 'ERR_NOT_OWNER' };
  switch (it.kind) {
    case 'move': {
      if (!Number.isInteger(it.dx) || !Number.isInteger(it.dy)) return { ok: false, code: 'ERR_BAD_ARGS' };
      if (Math.abs(it.dx) > 1 || Math.abs(it.dy) > 1) return { ok: false, code: 'ERR_BAD_ARGS' };
      const nx = u.x + it.dx;
      const ny = u.y + it.dy;
      if (!isPlain(state, nx, ny)) return { ok: false, code: 'ERR_BAD_ARGS' };
      if (nx === u.x && ny === u.y) return { ok: false, code: 'ERR_BAD_ARGS' };
      return { ok: true, intent: { ...it, nx, ny, moveType: u.type } };
    }
    case 'moveTo': {
      if (!Number.isInteger(it.x) || !Number.isInteger(it.y)) return { ok: false, code: 'ERR_BAD_ARGS' };
      if (!isPlain(state, it.x, it.y)) return { ok: false, code: 'ERR_BAD_ARGS' };
      if (u.x === it.x && u.y === it.y) return { ok: true, intent: { ...it, nx: u.x, ny: u.y, moveType: u.type, noop: true } };
      const path = findPath(state, u.x, u.y, it.x, it.y);
      if (!path) return { ok: false, code: 'ERR_BAD_ARGS' };
      const [nx, ny] = path[0];
      return { ok: true, intent: { ...it, nx, ny, moveType: u.type } };
    }
    case 'attack': {
      const spec = ruleset.roster[u.type];
      if (spec.damage <= 0) return { ok: false, code: 'ERR_INVALID_TARGET' };
      const t = state.units.get(it.targetId);
      if (!t) return { ok: false, code: 'ERR_INVALID_TARGET' };
      if (t.owner === u.owner) return { ok: false, code: 'ERR_INVALID_TARGET' };
      if (chebyshev(u.x, u.y, t.x, t.y) > spec.range) return { ok: false, code: 'ERR_OUT_OF_RANGE' };
      return { ok: true, intent: it };
    }
    case 'harvest': {
      if (u.type !== 'worker') return { ok: false, code: 'ERR_INVALID_SITE' };
      const s = state.sites.find((x) => x.id === it.siteId);
      if (!s || s.kind !== 'resource') return { ok: false, code: 'ERR_INVALID_SITE' };
      if (s.owner !== u.owner) return { ok: false, code: 'ERR_NOT_OWNER' };
      if (chebyshev(u.x, u.y, s.x, s.y) > 1) return { ok: false, code: 'ERR_OUT_OF_RANGE' };
      if (u.carrying >= ruleset.carryLimit) return { ok: false, code: 'ERR_OUT_OF_RANGE' };
      if (s.remaining <= 0) return { ok: false, code: 'ERR_INVALID_SITE' };
      return { ok: true, intent: it };
    }
    case 'transfer': {
      if (u.carrying <= 0) return { ok: false, code: 'ERR_BAD_ARGS' };
      const base = nearestOwnBase(state, u);
      if (!base) return { ok: false, code: 'ERR_NOT_OWNER' };
      return { ok: true, intent: { ...it, baseId: base.id } };
    }
    default:
      return { ok: false, code: 'ERR_BAD_ARGS' };
  }
}

function checkSpawn(state, it) {
  const { ruleset } = state;
  const type = it.unitType;
  if (!ruleset.roster[type]) return { ok: false, code: 'ERR_BAD_ARGS' };
  const s = state.sites.find((x) => x.id === it.baseId);
  if (!s || s.kind !== 'base') return { ok: false, code: 'ERR_INVALID_SITE' };
  if (s.owner !== it.player) return { ok: false, code: 'ERR_NOT_OWNER' };
  if (state.players[it.player].resources < ruleset.roster[type].cost) {
    return { ok: false, code: 'ERR_NOT_ENOUGH_RESOURCES' };
  }
  if (state.productions.has(it.baseId)) {
    // 一条产线一次一个在产单（草案未定义重复下单；桩取“丢弃且不扣款”并计数）
    if (state.stats) state.stats.spawnOrdersRejectedBusyBase += 1;
    return { ok: false, code: 'ERR_BASE_BUSY' };
  }
  state.players[it.player].resources -= ruleset.roster[type].cost; // 下单即扣款
  state.productions.set(it.baseId, {
    baseId: it.baseId, type, ticksLeft: ruleset.roster[type].spawnTicks,
  });
  if (state.stats) state.stats.spawnOrders += 1;
  note(state, 'spawn-ordered', { player: it.player, baseId: it.baseId, type });
  return { ok: true, intent: null }; // 生产已入队，无需进入后续阶段
}

function nearestOwnBase(state, u) {
  let best = null;
  for (const s of state.sites) {
    if (s.kind !== 'base' || s.owner !== u.owner) continue;
    if (chebyshev(u.x, u.y, s.x, s.y) > 1) continue;
    if (best === null || s.id < best.id) best = s; // 同时相邻多个己方基地 → 交付给 id 最小的
  }
  return best;
}

// 返回本轮实际移动过的单位 id 集合（供骑兵二次步判定）
function resolveMovementRound(state, moves) {
  const moved = new Set();
  if (moves.length === 0) return moved;
  const occStart = new Set();
  for (const u of state.units.values()) occStart.add(`${u.x},${u.y}`);

  const claims = new Map();
  for (const m of moves) {
    const key = `${m.nx},${m.ny}`;
    if (!claims.has(key)) claims.set(key, []);
    claims.get(key).push(m);
  }
  const claimed = new Set();
  // 目标格 key 升序保证裁决顺序确定（draft §2：按 playerIndex 再 unitId；此处以单元为裁决单位）
  for (const key of [...claims.keys()].sort()) {
    const list = claims.get(key);
    // 轮转优先 (tick + playerIndex) mod 4，方向假设：值大者胜（draft TODO：来源只写“取胜者”）
    list.sort((a, b) => {
      const pa = (state.tick + a.player) % 4;
      const pb = (state.tick + b.player) % 4;
      if (pa !== pb) return pb - pa;
      return a.unitId - b.unitId;
    });
    // 占位基准：本轮开始时目标格被占 → 全部失败（单位离开本轮所在格不使该格对后来者可进入）
    if (occStart.has(key)) continue;
    const win = list[0];
    const u = state.units.get(win.unitId);
    if (!u || claimed.has(win.unitId)) continue;
    u.x = win.nx;
    u.y = win.ny;
    claimed.add(win.unitId);
    moved.add(win.unitId);
  }
  return moved;
}

function applyCapture(state, s) {
  const d = unitAt(state, s.x, s.y);
  if (!d) return; // 无人站立：进度冻结保留，不衰减
  if (d.owner === s.owner) return; // 同阵营：冻结
  if (s.progressOwner !== d.owner) {
    s.progressOwner = d.owner;
    s.progress = 1;
  } else {
    s.progress += 1;
  }
  if (state.stats) {
    state.stats.captureTicksByDriverType[d.type] += 1;
  }
  if (s.progress >= state.ruleset.captureTicks) {
    const prevOwner = s.owner;
    s.owner = d.owner;
    s.progress = 0;
    s.progressOwner = -1;
    if (state.stats) {
      state.stats.sitesCapturedByDriverType[d.type] += 1;
      state.stats.sitesCapturedByPlayerDriver[d.owner][d.type] += 1;
    }
    note(state, 'site-captured', { siteId: s.id, kind: s.kind, owner: d.owner, prevOwner, driverType: d.type });
    if (s.kind === 'base' && prevOwner >= 0) {
      // 基地易主：该基地队列取消并全额退款给原主（已淘汰不退款）
      const q = state.productions.get(s.id);
      if (q) {
        state.productions.delete(s.id);
        if (state.players[prevOwner].alive) {
          state.players[prevOwner].resources += state.ruleset.roster[q.type].cost;
          if (state.stats) state.stats.refunds += 1;
          note(state, 'queue-refunded', { player: prevOwner, baseId: s.id, cost: state.ruleset.roster[q.type].cost });
        }
      }
    }
  }
}

function applyHarvest(state, h) {
  const u = state.units.get(h.unitId);
  const s = state.sites.find((x) => x.id === h.siteId);
  if (!u || !s) return;
  if (u.carrying >= state.ruleset.carryLimit) return;
  const gain = Math.min(state.ruleset.harvestRate, s.remaining);
  u.carrying += gain;
  s.remaining -= gain;
  if (state.stats) {
    state.stats.harvested += gain;
    state.stats.harvestedByPlayer[u.owner] += gain;
  }
}

function applyTransfer(state, t) {
  const u = state.units.get(t.unitId);
  if (!u || u.carrying <= 0) return;
  state.players[u.owner].resources += u.carrying;
  if (state.stats) state.stats.deliveredByPlayer[u.owner] += u.carrying;
  u.carrying = 0;
}

function applyProduction(state, q) {
  const base = state.sites.find((s) => s.id === q.baseId);
  if (!base || base.kind !== 'base') { state.productions.delete(q.baseId); return; }
  if (base.owner < 0) { state.productions.delete(q.baseId); return; }
  if (q.ticksLeft > 0) {
    q.ticksLeft -= 1;
    return;
  }
  // 出兵格 = 基地格（"格空后自动续出" 只有单格语义才成立；见 README 解释性决策）
  if (unitAt(state, base.x, base.y)) return; // 挂起等待
  const u = createUnit(state, base.owner, q.type, base.x, base.y);
  state.productions.delete(q.baseId);
  note(state, 'unit-spawned', { player: base.owner, type: q.type, unitId: u.id, at: `${base.x},${base.y}` });
}

// 寻路：八向 BFS，邻居展开顺序固定（draft §9-6：findPath 与 moveTo 同一实现、结果一致）
export function findPath(state, sx, sy, tx, ty) {
  if (sx === tx && sy === ty) return [];
  const { map } = state;
  const key = (x, y) => `${x},${y}`;
  const prev = new Map();
  const seen = new Set([key(sx, sy)]);
  let frontier = [[sx, sy]];
  while (frontier.length > 0) {
    const next = [];
    for (const [x, y] of frontier) {
      for (const [dx, dy] of DIR8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
        if (map.terrain[ny][nx] !== 'plain') continue;
        const k = key(nx, ny);
        if (seen.has(k)) continue;
        seen.add(k);
        prev.set(k, key(x, y));
        if (nx === tx && ny === ty) {
          const path = [];
          let cur = k;
          while (cur !== key(sx, sy)) {
            const [cx, cy] = cur.split(',').map(Number);
            path.push([cx, cy]);
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

function evaluate(state) {
  const { ruleset } = state;
  // a) 淘汰：无任何单位且无任何基地
  for (const p of state.players) {
    if (!p.alive) continue;
    const hasUnits = [...state.units.values()].some((u) => u.owner === p.index);
    const hasBases = state.sites.some((s) => s.kind === 'base' && s.owner === p.index);
    if (!hasUnits && !hasBases) {
      p.alive = false;
      p.eliminatedAt = state.tick;
      for (const s of state.sites) {
        if (s.owner === p.index) {
          s.owner = -1;
          s.progressOwner = -1;
          s.progress = 0;
          if (s.kind === 'base') {
            const q = state.productions.get(s.id);
            if (q) state.productions.delete(s.id); // 原主已淘汰：不退款
          }
        }
      }
      note(state, 'player-eliminated', { player: p.index });
    }
  }
  // b) 全部点位归属单一玩家 → 胜
  const owners = new Set(state.sites.map((s) => s.owner));
  if (owners.size === 1) {
    const winner = [...owners][0];
    if (winner >= 0) return finish(state, 'victory', winner);
  }
  // c) 仅剩一方尚存 → 捷径条款
  const alive = state.players.filter((p) => p.alive);
  if (alive.length === 1) return finish(state, 'shortcut', alive[0].index);
  return undefined;
}

function territoryScore(state, p) {
  const { ruleset } = state;
  let score = 0;
  for (const s of state.sites) {
    if (s.owner !== p.index) continue;
    score += s.kind === 'base' ? ruleset.baseScore : ruleset.resourceScore;
  }
  let unitCost = 0;
  for (const u of state.units.values()) if (u.owner === p.index) unitCost += ruleset.roster[u.type].cost;
  return score + Math.floor(unitCost / ruleset.unitCostDivisor);
}

export function exportTerritoryScores(state) {
  return [0, 1, 2, 3].map((p) => territoryScore(state, state.players[p]));
}

function finish(state, reason, winner) {
  const rankings = computeRankings(state, winner);
  state.outcome = { reason, winner, rankings, territoryScores: exportTerritoryScores(state), tick: state.tick };
  note(state, 'match-end', { reason, winner, rankings });
  return state.outcome;
}

function computeRankings(state, winner) {
  const scores = exportTerritoryScores(state);
  const entries = state.players.map((p) => ({
    index: p.index,
    alive: p.alive,
    score: scores[p.index],
    eliminatedAt: p.eliminatedAt,
  }));
  entries.sort((a, b) => {
    if (a.index === winner) return -1;
    if (b.index === winner) return 1;
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    const ae = a.eliminatedAt === null ? Infinity : a.eliminatedAt;
    const be = b.eliminatedAt === null ? Infinity : b.eliminatedAt;
    if (ae !== be) return be - ae; // 后出局者名次更前
    return a.index - b.index;
  });
  const rankings = [];
  let lastKey = null;
  entries.forEach((e, i) => {
    const key = `${e.alive}|${e.score}|${e.eliminatedAt}`;
    const rank = key === lastKey ? i : i + 1;
    rankings[e.index] = rank;
    lastKey = key;
  });
  return rankings;
}

// 超时收口：tick 达 tickLimit → 按 §7 领土分规则定名次
export function finishByTimeout(state) {
  if (state.outcome) return state.outcome;
  return finish(state, 'timeout', null);
}

// 测试钩子：桩对拼实验直接在状态里造单位（不是规则面能力，只是夹具）
export function debugSpawn(state, owner, type, x, y) {
  return createUnit(state, owner, type, x, y);
}

export { territoryScore, rot90 };
