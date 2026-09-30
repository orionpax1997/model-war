// duels.mjs —— C1~C7 的"对局实证"：站桩对拼 + 速度消融 + 混战条件。
//
// 与 bench/calibrate.py 的分工：那是**面板算术筛查**（无移动/无碰撞/无寻路）；
// 本文件用**同一套结算语义**（engine.mjs）跑真实对拼，得到"混战条件下约束是否仍表现为设计意图"的证据。
//
// 口径（沿用票 02/04 的操作化定义，改动任一项即需重跑工作台）：
//   - 等成本配平：两军预算取造价最小公倍数，按整数单位组成；
//   - 集火：全体存活单位攻击当前 Chebyshev 最近的敌方单位（同 tick 结算）；
//   - 接敌起点：Chebyshev 距离 6（工作台口径）或 1（消融口径）；
//   - C3"优势明显" = 近战胜后保留 ≥25% 初始总 HP；
//   - C6 = 满血远程被单个近战击杀所需 tick ≤ 2。

import { RULESET } from './ruleset.mjs';
import { buildMap } from './map.mjs';
import { createGame, runTick, debugSpawn, exportTerritoryScores } from './engine.mjs';
import { createIdleRuntime } from './runtime.mjs';

function lcm(a, b) {
  const g = (x, y) => (y === 0 ? x : g(y, x % y));
  return (a / g(a, b)) * b;
}

// 两军按等成本配平（票 04 验收口径：预算取造价最小公倍数；取 48 作统一预算，
// 四个兵种造价 4/8/12/16 均可整除，且 melee/cavalry 正好是工作台用的 48）
const DUEL_BUDGET = 48;
function equalCostArmy(typeA, typeB) {
  const ca = RULESET.roster[typeA].cost;
  const cb = RULESET.roster[typeB].cost;
  const l = lcm(ca, cb);
  const budget = Math.max(DUEL_BUDGET, 3 * l); // 不小于工作台的 48，且是 lcm 的整数倍
  return { budget, lcm: l, nA: budget / ca, nB: budget / cb };
}

// 一个纯开阔地对拼局面：只放两军，其余座位空转；不造点���（避免经济/生产介入）
function duelSetup({ typeA, typeB, dist, seed = 3 }) {
  const { nA, nB } = equalCostArmy(typeA, typeB);
  const map = buildMap(seed, { variant: 'open-four' });
  const state = createGame({ map });
  state.units.clear();
  state.productions.clear();
  for (const s of state.sites) { s.owner = -1; s.progressOwner = -1; s.progress = 0; }
  // 找一片开阔地：以 (20,20) 为中线，两军沿 x 轴分列（起始 Chebyshev 距离 = dist）
  const midY = 20;
  const leftX = 20 - Math.ceil(dist / 2);
  const rightX = 20 + Math.floor(dist / 2);
  const a = [];
  for (let i = 0; i < nA; i++) {
    a.push(debugSpawn(state, 0, typeA, leftX, midY + (i - Math.floor(nA / 2))));
  }
  const b = [];
  for (let i = 0; i < nB; i++) {
    b.push(debugSpawn(state, 1, typeB, rightX, midY + (i - Math.floor(nB / 2))));
  }
  const hpA0 = a.reduce((acc, u) => acc + u.hp, 0);
  const hpB0 = b.reduce((acc, u) => acc + u.hp, 0);
  const costA = nA * RULESET.roster[typeA].cost;
  const costB = nB * RULESET.roster[typeB].cost;
  return { state, a, b, hpA0, hpB0, costA, costB, nA, nB, dist };
}

// 驾驶函数：给每个单位发"攻击最近敌人 / 走向最近敌人"的自造 intent（策略极简、双方同规则）
function drive(state, tick, me, foes) {
  const intents = [];
  const mine = [...state.units.values()].filter((u) => u.owner === me)
    .sort((x, y) => x.id - y.id);
  const foeList = foes.map((id) => state.units.get(id)).filter(Boolean)
    .sort((x, y) => x.id - y.id);
  for (const u of mine) {
    let best = null;
    let bd = 99;
    for (const f of foeList) {
      const d = Math.max(Math.abs(u.x - f.x), Math.abs(u.y - f.y));
      if (d < bd || (d === bd && best !== null && f.id < best.id)) { bd = d; best = f; }
    }
    if (!best) continue;
    const range = RULESET.roster[u.type].range;
    if (bd <= range) intents.push({ kind: 'attack', unitId: u.id, targetId: best.id });
    else {
      const dx = Math.sign(best.x - u.x);
      const dy = Math.sign(best.y - u.y);
      intents.push({ kind: 'move', unitId: u.id, dx, dy });
    }
  }
  return intents;
}

export function runDuel(cfg, maxTicks = 200) {
  const { state, a, b, hpA0, hpB0, nA, nB, costA, costB } = duelSetup(cfg);
  const idsA = a.map((u) => u.id);
  const idsB = b.map((u) => u.id);
  const idA = new Set(idsA);
  const idB = new Set(idsB);
  let firstContactTick = null;
  let firstDamageTick = null;
  let decisiveTick = null;
  for (let t = 0; t < maxTicks; t++) {
    const rtA = { callLoop: () => drive(state, t, 0, idsB) };
    const rtB = { callLoop: () => drive(state, t, 1, idsA) };
    runTick(state, [rtA, rtB, createIdleRuntime(), createIdleRuntime()]);
    if (firstContactTick === null) {
      for (const ua of state.units.values()) {
        if (!idA.has(ua.id)) continue;
        for (const ub of state.units.values()) {
          if (!idB.has(ub.id)) continue;
          if (Math.max(Math.abs(ua.x - ub.x), Math.abs(ua.y - ub.y)) <= 2) { firstContactTick = t; break; }
        }
      }
    }
    if (firstDamageTick === null && state.stats.firstStrike) firstDamageTick = state.stats.firstStrike.tick;
    const aliveA = [...state.units.values()].filter((u) => idA.has(u.id));
    const aliveB = [...state.units.values()].filter((u) => idB.has(u.id));
    if (decisiveTick === null && (aliveA.length === 0 || aliveB.length === 0)) decisiveTick = state.tick;
    if (aliveA.length === 0 || aliveB.length === 0) break;
    if (state.outcome) break;
  }
  const aliveA = [...state.units.values()].filter((u) => idA.has(u.id));
  const aliveB = [...state.units.values()].filter((u) => idB.has(u.id));
  const hpA = aliveA.reduce((acc, u) => acc + Math.max(0, u.hp), 0);
  const hpB = aliveB.reduce((acc, u) => acc + Math.max(0, u.hp), 0);
  const winner = aliveA.length === 0 && aliveB.length === 0 ? 'draw'
    : (aliveA.length === 0 ? cfg.typeB : cfg.typeA);
  return {
    ...cfg,
    nA, nB, costA, costB,
    winner,
    hpA, hpB,
    hpKeptPctA: Math.round((hpA / hpA0) * 1000) / 10,
    hpKeptPctB: Math.round((hpB / hpB0) * 1000) / 10,
    survivorsA: aliveA.length, survivorsB: aliveB.length,
    firstContactTick, firstDamageTick, decisiveTick,
    ticks: state.tick,
    deadByTick: state.stats.deathsByType,
  };
}

// --- C1~C6 对拼清单 ---
export const DUELS = [
  { id: 'C1', label: '近战 > 远程（等成本）', typeA: 'melee', typeB: 'ranged', dist: 6, expect: 'melee' },
  { id: 'C2', label: '远程 > 骑兵（等成本）', typeA: 'ranged', typeB: 'cavalry', dist: 6, expect: 'ranged' },
  { id: 'C3', label: '近战 > 骑兵且优势明显', typeA: 'melee', typeB: 'cavalry', dist: 6, expect: 'melee' },
  // 速度消融：同一对拼把接敌距离压到 1（无接近过程，骑兵拿不到速度红利）
  { id: 'C3d1', label: '近战 vs 骑兵（距离 1，消融接近优势）', typeA: 'melee', typeB: 'cavalry', dist: 1, expect: 'melee' },
  { id: 'C1d1', label: '近战 vs 远程（距离 1，无远程先手 volley）', typeA: 'melee', typeB: 'ranged', dist: 1, expect: 'melee' },
  { id: 'C2d1', label: '远程 vs 骑兵（距离 1）', typeA: 'ranged', typeB: 'cavalry', dist: 1, expect: 'ranged' },
];

// C6 专项：单个近战贴身打满血远程，记录远程被击杀的 tick
export function c6Probe(dist = 1) {
  const map = buildMap(3, { variant: 'open-four' });
  const state = createGame({ map });
  state.units.clear();
  for (const s of state.sites) { s.owner = -1; s.progressOwner = -1; s.progress = 0; }
  const melee = debugSpawn(state, 0, 'melee', 20 - dist, 20);
  const ranged = debugSpawn(state, 1, 'ranged', 20, 20);
  const hp0 = ranged.hp;
  let killedAt = null;
  for (let t = 0; t < 40; t++) {
    const rtA = { callLoop: () => (state.units.has(melee.id) ? [{ kind: 'attack', unitId: melee.id, targetId: ranged.id }] : []) };
    const rtB = { callLoop: () => (state.units.has(ranged.id) ? [{ kind: 'move', unitId: ranged.id, dx: -1, dy: 0 }] : []) };
    runTick(state, [rtA, rtB, createIdleRuntime(), createIdleRuntime()]);
    if (!state.units.has(ranged.id)) { killedAt = state.tick; break; }
  }
  return {
    id: 'C6', label: '远程在近战贴身 2 tick 内被击杀', dist, rangedHp: hp0,
    ticksToKill: killedAt, meleeNeeded: Math.ceil(hp0 / RULESET.roster.melee.damage),
    pass: killedAt !== null && killedAt <= 2,
  };
}

// C4/C5：纯算术约束（不需要跑对局，但同表并列便于一眼比对）
export function arithmeticConstraints() {
  const r = RULESET.roster;
  const hpPerCost = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, round3(v.hp / v.cost)]));
  const dmgPerCost = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, round3(v.damage / v.cost)]));
  const best = (o) => Math.max(...Object.values(o));
  const c4Hp = hpPerCost.melee === best(hpPerCost);
  const c4Dmg = dmgPerCost.melee === best(dmgPerCost);
  const c5 = {
    cavalrySpeed2x: r.cavalry.speed === 2 * r.melee.speed,
    othersSpeed1: r.worker.speed === 1 && r.melee.speed === 1 && r.ranged.speed === 1,
    cavalryCostGte2xMelee: r.cavalry.cost >= 2 * r.melee.cost,
  };
  return { hpPerCost, dmgPerCost, c4: { hpPerCostHighest: c4Hp, dmgPerCostHighest: c4Dmg }, c5 };
}

function round3(x) { return Math.round(x * 1000) / 1000; }

// C7：单基地满产烧钱率 vs 单农收入（单农收入用对局实测的采集—交付回路，burn 用 roster 造价/生产耗时）
export function c7Arithmetic(dist = 4) {
  const r = RULESET.roster;
  const burn = {};
  for (const [k, v] of Object.entries(r)) burn[k] = round3(v.cost / v.spawnTicks);
  // 单农回路：矿边到基地边作业，往返单程 max(0, D-2) tick，满载采集 carryLimit/harvestRate tick，交付 1 tick
  const leg = Math.max(0, dist - 2);
  const carryTicks = RULESET.carryLimit / RULESET.harvestRate;
  const cycle = 2 * leg + carryTicks + 1;
  const workerIncome = round3(RULESET.carryLimit / cycle);
  return {
    dist,
    leg, carryTicks, cycle,
    workerIncome,
    burnPerBase: burn,
    burnVsIncome: Object.fromEntries(Object.entries(burn).map(([k, v]) => [k, round3(v / workerIncome)])),
    hardConstraint: Object.values(burn).every((b) => b > workerIncome),
    comfortableBand: Object.fromEntries(Object.entries(burn).map(([k, v]) => [k, v >= 2 * workerIncome && v <= 4 * workerIncome])),
  };
}

// --- 骑兵价值的正向实验：它的价值应全部来自速度（袭扰/绕后），而不是战斗面 ---
// R1 骑兵 vs 纯农民海（无护卫）：经济打击能力
// R2 骑兵 vs 近战阵 + 后排农民：骑兵绕后打农民，近战追不上（速度差的真实兑现）
function raidSetup({ seed = 3, cavalry = 3, melee = 3, workers = 4, dist = 8, cavalrySpeed = 2, gap = false }) {
  const map = buildMap(seed, { variant: 'open-four' });
  // 消融：把骑兵速度改成 1（其余不变），用于证明“骑兵价值来自速度”而非来自数值面
  const ruleset = cavalrySpeed === 2 ? RULESET : {
    ...RULESET,
    roster: { ...RULESET.roster, cavalry: { ...RULESET.roster.cavalry, speed: cavalrySpeed } },
  };
  const state = createGame({ map, ruleset });
  state.units.clear();
  for (const s of state.sites) { s.owner = -1; s.progressOwner = -1; s.progress = 0; }
  const midY = 20;
  const frontX = 20 - Math.ceil(dist / 2);
  const backX = frontX - 3;                 // 农民在近战阵后方
  const cavX = 20 + Math.floor(dist / 2);
  const cav = [];
  for (let i = 0; i < cavalry; i++) cav.push(debugSpawn(state, 0, 'cavalry', cavX, midY + i - Math.floor(cavalry / 2)));
  const foeMelee = [];
  for (let i = 0; i < melee; i++) {
    // gap=true：近战阵留一个中间缺口（y=20 空），给骑兵可穿过的缝
    const y = gap && i === Math.floor(melee / 2) ? midY + (melee + 1) : midY + i - Math.floor(melee / 2);
    foeMelee.push(debugSpawn(state, 1, 'melee', frontX, y));
  }
  const foeWorkers = [];
  for (let i = 0; i < workers; i++) foeWorkers.push(debugSpawn(state, 1, 'worker', backX, midY + i - Math.floor(workers / 2)));
  return {
    state, cav, foeMelee, foeWorkers,
    ids: {
      cav: cav.map((u) => u.id),
      melee: foeMelee.map((u) => u.id),
      workers: foeWorkers.map((u) => u.id),
    },
  };
}

// 骑兵 doctrine（“无视主力直插后方”）：**不与主力交战**，只打农民；
// 路径被近战完全封死时就停在原地挨打（这正是“无掩护正面 = 骑兵无用”的证据）。
// 近战：追最近的骑兵（速度 1）。农民：无防守，原地待命（模拟“未设防的农群”）。
function driveRaid(state, { cav, melee, workers }) {
  const alive = (ids) => ids.map((i) => state.units.get(i)).filter(Boolean);
  const cavUnits = alive(cav);
  const foeMelee = alive(melee);
  const foeWorkers = alive(workers);
  const out = { 0: [], 1: [] };
  for (const u of cavUnits) {
    const cand = foeWorkers.slice().sort((a, b) => cheb(u, a) - cheb(u, b) || a.id - b.id);
    if (cand.length === 0) break;
    const t = cand[0];
    const d = cheb(u, t);
    if (d <= RULESET.roster.cavalry.range) {
      out[0].push({ kind: 'attack', unitId: u.id, targetId: t.id });
      continue;
    }
    // 目标方向堵死（没有可走的下一步）→ 只能贴住近战对拼
    const dx = Math.sign(t.x - u.x);
    const dy = Math.sign(t.y - u.y);
    const blocked = foeMelee.some((m) => m.x === u.x + dx && m.y === u.y + dy);
    if (blocked) {
      const blocker = foeMelee.find((m) => m.x === u.x + dx && m.y === u.y + dy);
      if (cheb(u, blocker) <= RULESET.roster.cavalry.range) {
        out[0].push({ kind: 'attack', unitId: u.id, targetId: blocker.id });
        continue;
      }
    }
    out[0].push({ kind: 'move', unitId: u.id, dx, dy });
  }
  for (const u of foeMelee) {
    const cand = cavUnits.slice().sort((a, b) => cheb(u, a) - cheb(u, b) || a.id - b.id);
    if (cand.length === 0) break;
    const t = cand[0];
    const d = cheb(u, t);
    if (d <= RULESET.roster.melee.range) out[1].push({ kind: 'attack', unitId: u.id, targetId: t.id });
    else out[1].push({ kind: 'move', unitId: u.id, dx: Math.sign(t.x - u.x), dy: Math.sign(t.y - u.y) });
  }
  for (const u of foeWorkers) {
    if (cavUnits.length === 0) break;
    out[1].push({ kind: 'move', unitId: u.id, dx: 0, dy: 0 });
  }
  return out;
}

function cheb(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function runRaid(cfg, maxTicks = 120) {
  const { state, ids } = raidSetup(cfg);
  const workerIds = new Set(ids.workers);
  const meleeIds = new Set(ids.melee);
  const cavIds = new Set(ids.cav);
  let firstWorkerKill = null;
  let firstCavLoss = null;
  let workersLost = 0;
  let meleeLost = 0;
  let cavLost = 0;
  for (let t = 0; t < maxTicks; t++) {
    const plans = driveRaid(state, ids);
    runTick(state, [
      { callLoop: () => plans[0] },
      { callLoop: () => plans[1] },
      createIdleRuntime(), createIdleRuntime(),
    ]);
    for (const u of state.units.values()) {
      if (workerIds.has(u.id) && u.hp <= 0) { /* 死亡已从 state 移除 */ }
    }
    workersLost = ids.workers.filter((i) => !state.units.has(i)).length;
    meleeLost = ids.melee.filter((i) => !state.units.has(i)).length;
    cavLost = ids.cav.filter((i) => !state.units.has(i)).length;
    if (firstWorkerKill === null && workersLost > 0) firstWorkerKill = state.tick;
    if (firstCavLoss === null && cavLost > 0) firstCavLoss = state.tick;
    if (workersLost >= cfg.workers) break;
  }
  const survivedWorkers = ids.workers.filter((i) => state.units.has(i)).length;
  return {
    ...cfg,
    cavalrySpeed: cfg.cavalrySpeed ?? 2,
    gap: cfg.gap ?? false,
    workersLost, meleeLost, cavLost, survivedWorkers,
    firstWorkerKill, firstCavLoss,
    ticks: state.tick,
    // 速度红利读数：首个农kill 早于首个骑兵损失 = 骑兵靠速度先手拿到经济战果
    speedEdge: firstWorkerKill !== null && (firstCavLoss === null || firstWorkerKill < firstCavLoss),
    remaining: { cav: ids.cav.filter((i) => state.units.has(i)).length, melee: ids.melee.filter((i) => state.units.has(i)).length },
    workerIds, meleeIds, cavIds,
  };
}

// --- E 系列：占领遇战（票 05 的"占领效率"与"经济死亡后抢点续命"条款）---
//
// 背景：票据 05 的判据是"农民能不能抢点、农民海会不会无脑最优"。矩阵里抢点与交火纠缠在一起
// （对手兵力/站位/时机不可控），所以这里做**受控遭遇**：一个中立基地 + 一支进攻方（无经济、
// 等价于经济死亡后的残兵）+ 一支守方近战，量“进攻方能不能把点打下来、用什么打下来的”。
//
// 口径：
//   - 进攻方只有进攻这一件事（走最近邻格 → 站上去冻结 → 10 tick 后易主），无经济、无生产；
//   - 守方 3 个近战，守在基地周围（贴身守）；
//   - 读数：占领成功与否、占领耗时（从开局到 site.owner 变进攻方）、进攻/守方存活数；
//   - 每个兵种都用**等造价 24** 的编制（worker×6 / melee×3 / ranged×2 / cavalry×1 加 8 造价档
//     cavalry×1+melee×1 记为 cavalry2），保证“用什么兵抢点”的比较是等价的。

function captureSetup({ attacker = 'melee', nAtt = 3, defenders = 3, dist = 6, seed = 5, cavalrySpeed = 2 }) {
  const map = buildMap(seed, { variant: 'open-four', size: 64 });
  const ruleset = cavalrySpeed === 2 ? RULESET : {
    ...RULESET,
    roster: { ...RULESET.roster, cavalry: { ...RULESET.roster.cavalry, speed: cavalrySpeed } },
  };
  const state = createGame({ map, ruleset });
  state.units.clear();
  state.productions.clear();
  for (const s of state.sites) { s.owner = -1; s.progressOwner = -1; s.progress = 0; }
  // 取一个中立基地当目标（按 id 升序第一个中立 base）
  const target = state.sites.find((s) => s.kind === 'base' && s.owner === -1);
  const cx = target.x;
  const cy = target.y;
  // 进攻方排成**纵队**（每波 3 个，共用西侧一条通道）：避免宽阵把结论搅成混战
  const att = [];
  for (let i = 0; i < nAtt; i++) {
    const wave = Math.floor(i / 3);
    const lane = i % 3;
    att.push(debugSpawn(state, 0, attacker, cx - dist - wave * 2, cy + lane - 1));
  }
  // 守方：站点周围的 8 个邻格，前 3 个（正交方向）先占
  const def = [];
  const defOff = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let i = 0; i < defenders; i++) {
    const [dx, dy] = defOff[i];
    def.push(debugSpawn(state, 1, 'melee', cx + dx, cy + dy));
  }
  return {
    state, target, att, def,
    ids: { att: att.map((u) => u.id), def: def.map((u) => u.id) },
    costAtt: nAtt * RULESET.roster[attacker].cost,
  };
}

// 进攻方 doctrine：邻格有守方就打，否则朝目标格直走，站上去就冻结（自然进入 capture）；
// 守方 doctrine：贴住最近进攻单位打
function driveCapture(state, ids, targetId) {
  const out = { 0: [], 1: [] };
  const att = ids.att.map((i) => state.units.get(i)).filter(Boolean).sort((a, b) => a.id - b.id);
  const def = ids.def.map((i) => state.units.get(i)).filter(Boolean).sort((a, b) => a.id - b.id);
  const target = state.sites.find((s) => s.id === targetId);
  for (const u of att) {
    if (!target) break;
    if (u.x === target.x && u.y === target.y) continue;      // 站定 = 占领中
    // 射程内有守方就打（不越级）
    const inRange = def.filter((d) => cheb(u, d) <= RULESET.roster[u.type].range)
      .sort((a, b) => a.id - b.id)[0];
    if (inRange) { out[0].push({ kind: 'attack', unitId: u.id, targetId: inRange.id }); continue; }
    const dx = Math.sign(target.x - u.x);
    const dy = Math.sign(target.y - u.y);
    out[0].push({ kind: 'move', unitId: u.id, dx, dy });
  }
  for (const u of def) {
    const cand = att.slice().sort((a, b) => cheb(u, a) - cheb(u, b) || a.id - b.id);
    const t = cand[0];
    if (!t) break;
    if (cheb(u, t) <= RULESET.roster.melee.range) out[1].push({ kind: 'attack', unitId: u.id, targetId: t.id });
    else out[1].push({ kind: 'move', unitId: u.id, dx: Math.sign(t.x - u.x), dy: Math.sign(t.y - u.y) });
  }
  return out;
}

export function runCaptureAssault(cfg, maxTicks = 90) {
  const { state, ids, target, costAtt } = captureSetup(cfg);
  let capturedAt = null;
  let firstAttLoss = null;
  for (let t = 0; t < maxTicks; t++) {
    const plans = driveCapture(state, ids, target.id);
    runTick(state, [
      { callLoop: () => plans[0] },
      { callLoop: () => plans[1] },
      createIdleRuntime(), createIdleRuntime(),
    ]);
    if (firstAttLoss === null && ids.att.some((i) => !state.units.has(i))) firstAttLoss = state.tick;
    if (capturedAt === null && target.owner === 0) { capturedAt = state.tick; break; }
    if (ids.att.every((i) => !state.units.has(i))) break;
  }
  return {
    ...cfg,
    cavalrySpeed: cfg.cavalrySpeed ?? 2,
    costAtt,
    captured: capturedAt !== null,
    capturedAt,
    firstAttLoss,
    attAlive: ids.att.filter((i) => state.units.has(i)).length,
    defAlive: ids.def.filter((i) => state.units.has(i)).length,
    siteOwner: target.owner,
    ticks: state.tick,
  };
}

export function runAllDuels() {
  const results = DUELS.map((d) => runDuel(d));
  // E 系列的编制网格：每个兵种在 24/48/72 三个等造价档上打一个 3 人驻防据点
  const assault = [
    { id: 'E0', label: '基准：无驻防，近战 3 抢点（耗时 = 接近 + captureTicks）', attacker: 'melee', nAtt: 3, defenders: 0 },
    { id: 'E1', label: '近战 3 vs 3 驻防', attacker: 'melee', nAtt: 3, defenders: 3 },
    { id: 'E2', label: '农民 6 vs 3 驻防（等造价 24）', attacker: 'worker', nAtt: 6, defenders: 3 },
    { id: 'E3', label: '远程 2 vs 3 驻防（等造价 24）', attacker: 'ranged', nAtt: 2, defenders: 3 },
    { id: 'E4', label: '骑兵 1 vs 3 驻防（等造价 16）', attacker: 'cavalry', nAtt: 1, defenders: 3 },
    { id: 'E6', label: '近战 3 vs 6 驻防（守方加倍）', attacker: 'melee', nAtt: 3, defenders: 6 },
  ];
  const grid = [];
  for (const type of ['worker', 'melee', 'ranged', 'cavalry']) {
    for (const budget of [24, 48, 72]) {
      const n = Math.max(1, Math.round(budget / RULESET.roster[type].cost));
      grid.push({
        id: `E.${type}.${n}`,
        label: `${type} × ${n}（造价 ${n * RULESET.roster[type].cost}）vs 3 驻防`,
        attacker: type, nAtt: n, defenders: 3,
      });
    }
  }
  return {
    duels: results,
    c6: c6Probe(1),
    arithmetic: arithmeticConstraints(),
    c7: c7Arithmetic(4),
    assaults: assault.map((a) => runCaptureAssault(a)),
    assaultGrid: grid.map((a) => runCaptureAssault(a)),
    raids: {
      r1_workers_only: runRaid({ id: 'R1', label: '骑兵 3 vs 农民 4（无护卫）', cavalry: 3, melee: 0, workers: 4, dist: 8 }),
      r2a_solid_screen: runRaid({ id: 'R2a', label: '骑兵 3 绕后 vs 近战 3 实线 + 农民 4（正面无缺口）', cavalry: 3, melee: 3, workers: 4, dist: 8 }),
      r2b_gap_screen: runRaid({ id: 'R2b', label: '同 R2a，但近战阵留 1 格缺口', cavalry: 3, melee: 3, workers: 4, dist: 8, gap: true }),
      r3_gap_speed1: runRaid({ id: 'R3', label: '同 R2b 几何，但骑兵速度消融为 1', cavalry: 3, melee: 3, workers: 4, dist: 8, gap: true, cavalrySpeed: 1 }),
    },
  };
}

export { exportTerritoryScores };
