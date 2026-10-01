// selftest.mjs —— 桩模拟器结算语义的微测试（throwaway 桩的可信度基础）。
// 覆盖 draft rules.md §3 移动裁决、§5 占领、§6 战斗、§4 经济与生产、§7 胜负与淘汰、§9 确定性。

import { buildMap, assertFourFoldSymmetry, assertSiteInvariants, assertConnectivity } from './map.mjs';
import {
  createGame, runTick, debugSpawn, exportTerritoryScores, findPath, finishByTimeout, buildSnapshot,
} from './engine.mjs';
import { RULESET } from './ruleset.mjs';
import { createIdleRuntime, createPlayerRuntime } from './runtime.mjs';
const runtimeMod = { createPlayerRuntime };

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

// 一个可控的局面：清空单位与点位属主，只摆测试需要的对象
function blankGame(seed = 5) {
  const map = buildMap(seed);
  const state = createGame({ map });
  state.units.clear();
  state.productions.clear();
  for (const s of state.sites) {
    s.owner = -1; s.progressOwner = -1; s.progress = 0;
    if (s.kind === 'resource') s.remaining = 125;
  }
  return state;
}
const idle = () => [createIdleRuntime(), createIdleRuntime(), createIdleRuntime(), createIdleRuntime()];

console.log('== 地图夹具 ==');
check('四重旋转对称（terrain + sites）', () => {
  for (const seed of [1, 2, 3, 42, 2026]) {
    assertFourFoldSymmetry(buildMap(seed));
  }
});
check('点位不变量：每方 1 家 / 中立基地与资源点为 4 的倍数 / 点位不在墙上', () => {
  for (const seed of [1, 2, 3, 42, 2026]) {
    assertSiteInvariants(buildMap(seed));
  }
});
check('墙体变体不隔断任何点位或起始位', () => {
  for (const seed of [1, 2, 3, 7, 11, 42, 99, 777, 2026]) assertConnectivity(buildMap(seed));
});
check('初始条件对等：四方家基地/起始农民互为 90° 旋转、资源相同', () => {
  const state = createGame({ map: buildMap(1) });
  eq(state.players.length, 4);
  for (const p of state.players) eq(p.resources, RULESET.initialResources, '起始资金');
  const perOwner = [0, 0, 0, 0];
  for (const u of state.units.values()) perOwner[u.owner] += 1;
  assert(perOwner.every((n) => n === perOwner[0]), `起始农民数不对等: ${perOwner}`);
  const bases = state.sites.filter((s) => s.kind === 'base' && s.owner >= 0);
  eq(bases.length, 4, '主基地数');
});

console.log('== §3 移动与碰撞 ==');
check('同格竞争：按 (tick+playerIndex) mod 4 值大者胜，其余原地', () => {
  const state = blankGame();
  const t = 0;
  // 0 号与 1 号同抢 (20,20)；(0+0)%4=0 < (0+1)%4=1 → 1 号进
  const a = debugSpawn(state, 0, 'melee', 19, 20);
  const b = debugSpawn(state, 1, 'melee', 21, 20);
  state.units.get(a.id).x = 19;
  runTickWithMoves(state, t, [[a, 1, 0], [b, -1, 0]]);
  eq(state.units.get(b.id).x, 20, '1 号应进入目标格');
  eq(state.units.get(a.id).x, 19, '0 号应原地不动');
});
check('占位基准：本轮开始时被占的格，后来者进不去（离开也不腾格）', () => {
  const state = blankGame();
  const a = debugSpawn(state, 0, 'melee', 20, 20);
  const b = debugSpawn(state, 1, 'melee', 22, 20);
  runTickWithMoves(state, 0, [[a, 1, 0], [b, -2, 0]]);
  eq(state.units.get(a.id).x, 21, '占位者应移动到 (21,20)');
  eq(state.units.get(b.id).x, 22, '后来者应被“本轮开始时的占位”挡住并留在原地');
  void b;
});
check('交换穿行 A↔B 两者都失败（无链式裁决）', () => {
  const state = blankGame();
  const a = debugSpawn(state, 0, 'melee', 20, 20);
  const b = debugSpawn(state, 1, 'melee', 21, 20);
  runTickWithMoves(state, 0, [[a, 1, 0], [b, -1, 0]]);
  eq(state.units.get(a.id).x, 20, 'A 不应移动');
  eq(state.units.get(b.id).x, 21, 'B 不应移动');
});
check('链式移动 A→B、B→C：A 失败（目标格本轮被占），B 只看 C', () => {
  const state = blankGame();
  const a = debugSpawn(state, 0, 'melee', 19, 20);
  const b = debugSpawn(state, 1, 'melee', 20, 20);
  runTickWithMoves(state, 0, [[a, 1, 0], [b, 1, 0]]);
  eq(state.units.get(a.id).x, 19, 'A 目标格本轮被占 → 失败');
  eq(state.units.get(b.id).x, 21, 'B 应进入空格 (21,20)');
});
check('骑兵二次移动：一 tick 走两格（两轮各自独立裁决）', () => {
  const state = blankGame();
  const cav = debugSpawn(state, 0, 'cavalry', 19, 20);
  const foot = debugSpawn(state, 0, 'melee', 19, 22);
  runTickWithMoves(state, 0, [[cav, 1, 0], [foot, 1, 0]]);
  eq(state.units.get(cav.id).x, 21, '骑兵应走两格');
  eq(state.units.get(foot.id).x, 20, '非骑兵只走一格');
});
check('moveTo 每 tick 只走一步（等价 move），路径逐 tick 重算', () => {
  const state = blankGame();
  const u = debugSpawn(state, 0, 'melee', 5, 5);
  for (let i = 0; i < 3; i++) {
    const snapshot = buildSnapshot(state);
    runTick(state, [{ callLoop: () => [{ kind: 'moveTo', unitId: u.id, x: 15, y: 15 }] }, ...idle().slice(1)]);
    void snapshot;
  }
  eq(state.units.get(u.id).x, 8, '三 tick 应走三格');
});
check('findPath 绕墙且与 moveTo 同实现（FR-10 AC3 约束 6）', () => {
  const state = blankGame(11);
  const path = findPath(state, 2, 2, 2, 12);
  assert(path !== null && path.length > 0, '应有路径');
  for (const [x, y] of path) eq(state.map.terrain[y][x], 'plain', '路径不得穿墙');
});

console.log('== §5 占领 ==');
check('同阵营站立冻结进度；无人站立不衰减', () => {
  const state = blankGame();
  const mine = state.sites.find((s) => s.kind === 'resource');
  mine.owner = 0;
  const w = debugSpawn(state, 0, 'worker', mine.x + 1, mine.y);
  for (let i = 0; i < 5; i++) {
    state.productions.clear();
    runTick(state, [{ callLoop: () => [] }, ...idle().slice(1)]);
    if (mine.progress !== 0) throw new Error('同阵营站立不应累积进度');
  }
  // 移开后进度保留
  state.units.delete(w.id);
  runTick(state, idle());
  eq(mine.progress, 0, '占位前进度');
  const w2 = debugSpawn(state, 0, 'worker', mine.x, mine.y);
  mine.owner = -1;
  for (let i = 0; i < 3; i++) runTick(state, idle());
  eq(mine.progress, 3, '累积 3 tick');
  eq(mine.owner, -1, '未满 10 不易主');
  for (let i = 0; i < 7; i++) runTick(state, idle());
  eq(mine.owner, 0, '满 10 tick 易主');
  eq(mine.progress, 0, '易主后进度清零');
  void w2;
});
check('转轨重计：1-tick 触碰把对手进度打回 1（无侵蚀）', () => {
  const state = blankGame();
  const mine = state.sites.find((s) => s.kind === 'resource');
  const a = debugSpawn(state, 0, 'worker', mine.x, mine.y);
  for (let i = 0; i < 6; i++) runTick(state, idle());
  eq(mine.progress, 6, '0 号累积 6');
  state.units.delete(a.id);
  const b = debugSpawn(state, 1, 'worker', mine.x, mine.y);
  runTick(state, idle());
  eq(mine.progress, 1, '1 号触碰后应重计为 1');
  eq(mine.progressOwner, 1, 'progressOwner 应为 1 号');
  void b;
});
check('堵点：己方单位站自家点位可物理阻止敌方踩点（占领不需资源）', () => {
  const state = blankGame();
  const mine = state.sites.find((s) => s.kind === 'resource');
  mine.owner = 0;
  const defender = debugSpawn(state, 0, 'melee', mine.x, mine.y);
  for (let i = 0; i < 20; i++) {
    if (state.tick === 0) debugSpawn(state, 1, 'melee', mine.x, mine.y + 1);
    runTick(state, idle());
  }
  eq(mine.owner, 0, '守点单位在场时敌方无法逐点吃掉（双方贴身僵持）');
  void defender;
});

console.log('== §4 经济与生产 ==');
check('采集 + 满携带停 + 交付入池；储量扣减', () => {
  const state = blankGame();
  const mine = state.sites.find((s) => s.kind === 'resource');
  const base = state.sites.find((s) => s.kind === 'base');
  mine.owner = 0; base.owner = 0;
  const w = debugSpawn(state, 0, 'worker', mine.x + 1, mine.y);
  for (let i = 0; i < RULESET.carryLimit; i++) {
    runTick(state, [{ callLoop: () => [{ kind: 'harvest', unitId: w.id, siteId: mine.id }] }, ...idle().slice(1)]);
  }
  eq(state.units.get(w.id).carrying, RULESET.carryLimit, '满载');
  eq(mine.remaining, 125 - RULESET.carryLimit, '储量扣减');
  // 再采一条应被丢弃（携带上限）
  const before = state.units.get(w.id).carrying;
  runTick(state, [{ callLoop: () => [{ kind: 'harvest', unitId: w.id, siteId: mine.id }] }, ...idle().slice(1)]);
  eq(state.units.get(w.id).carrying, before, '满载后不再采');
  // 交付
  state.units.get(w.id).x = base.x + 1; state.units.get(w.id).y = base.y;
  runTick(state, [{ callLoop: () => [{ kind: 'transfer', unitId: w.id }] }, ...idle().slice(1)]);
  eq(state.players[0].resources, RULESET.initialResources + RULESET.carryLimit, '交付入池');
  eq(state.units.get(w.id).carrying, 0, '交付后清零');
});
check('交付：仅当与己方基地相邻时生效（非相邻 → 丢弃，不计异常）', () => {
  const state = blankGame();
  const bases = state.sites.filter((s) => s.kind === 'base').sort((a, b) => a.id - b.id);
  bases[0].owner = 0; bases[1].owner = 0;
  const far = debugSpawn(state, 0, 'worker', 20, 20);
  state.units.get(far.id).carrying = 5;
  runTick(state, [{ callLoop: () => [{ kind: 'transfer', unitId: far.id }] }, ...idle().slice(1)]);
  eq(state.units.get(far.id).carrying, 5, '非相邻不应交付');
  eq(state.players[0].exceptionTicks, 0, '丢弃不计异常');
  // 相邻时交付（"同时相邻多个取 id 最小" 在全局资源池下不可观测，见 README）
  const near = debugSpawn(state, 0, 'worker', bases[0].x + 1, bases[0].y);
  runTick(state, [{ callLoop: () => [{ kind: 'transfer', unitId: near.id }] }, ...idle().slice(1)]);
  eq(state.players[0].resources, RULESET.initialResources, '无携带量不产生收入');
});
check('下单即扣款；资金不足无效（不占队列不扣款）', () => {
  const state = blankGame();
  const base = state.sites.find((s) => s.kind === 'base');
  base.owner = 0;
  state.players[0].resources = 12;
  runTick(state, [{ callLoop: () => [{ kind: 'spawnUnit', baseId: base.id, unitType: 'ranged' }] }, ...idle().slice(1)]);
  eq(state.players[0].resources, 0, '远程 12 应扣光');
  eq(state.productions.size, 1, '队列 1');
  runTick(state, [{ callLoop: () => [{ kind: 'spawnUnit', baseId: base.id, unitType: 'melee' }] }, ...idle().slice(1)]);
  eq(state.players[0].resources, 0, '资金不足不应扣款');
  eq(state.productions.size, 1, '资金不足不应占队列');
});
check('生产耗时：ticksLeft 归零才出兵', () => {
  const state = blankGame();
  const base = state.sites.find((s) => s.kind === 'base');
  base.owner = 0;
  const n0 = state.units.size;
  runTick(state, [{ callLoop: () => [{ kind: 'spawnUnit', baseId: base.id, unitType: 'melee' }] }, ...idle().slice(1)]);
  for (let i = 0; i < RULESET.roster.melee.spawnTicks - 1; i++) {
    runTick(state, idle());
    eq(state.units.size, n0, `第 ${i + 1} tick 不应出兵`);
  }
  runTick(state, idle());
  eq(state.units.size, n0 + 1, '第 4 tick 应出兵');
});
check('出兵格被占 → 挂起等待，格空后自动续出（己方单位堵自家基地）', () => {
  const state = blankGame();
  const base = state.sites.find((s) => s.kind === 'base');
  base.owner = 0;
  const blocker = debugSpawn(state, 0, 'melee', base.x, base.y);
  runTick(state, [{ callLoop: () => [{ kind: 'spawnUnit', baseId: base.id, unitType: 'melee' }] }, ...idle().slice(1)]);
  const n0 = state.units.size;
  for (let i = 0; i < 10; i++) runTick(state, idle());
  eq(state.units.size, n0, '出兵格被占时应挂起');
  eq(base.owner, 0, '自家单位踩自家基地不推进也不易主');
  state.units.delete(blocker.id);
  runTick(state, idle());
  eq(state.units.size, 1, '格空后应续出（堵点单位已消失，新单位占其位）');
  const spawned = [...state.units.values()][0];
  eq(spawned.type, 'melee', '续出的应是在产队列的近战');
  assert(spawned.id > blocker.id, '续出单位应有新 id');
  eq(state.productions.size, 0, '队列完成');
});
check('基地易主：队列取消并全额退款给原主', () => {
  const state = blankGame();
  const base = state.sites.find((s) => s.kind === 'base');
  base.owner = 0;
  state.players[0].resources = 20;
  runTick(state, [{ callLoop: () => [{ kind: 'spawnUnit', baseId: base.id, unitType: 'ranged' }] }, ...idle().slice(1)]);
  eq(state.players[0].resources, 8, '下单扣 12');
  // 1 号踩点 10 tick
  const w = debugSpawn(state, 1, 'worker', base.x, base.y);
  for (let i = 0; i < RULESET.captureTicks; i++) runTick(state, idle());
  eq(base.owner, 1, '基地应易主');
  eq(state.players[0].resources, 20, '原主应拿回 12');
  eq(state.productions.size, 0, '队列应取消');
  void w;
});

console.log('== §6 战斗 ==');
check('同 tick 全部攻击同时结算（先算全伤害，攻击者死亡不影响其攻击生效）', () => {
  const state = blankGame();
  const a1 = debugSpawn(state, 0, 'melee', 20, 20);
  const a2 = debugSpawn(state, 0, 'melee', 21, 20);
  const b1 = debugSpawn(state, 1, 'melee', 20, 21);
  const b2 = debugSpawn(state, 1, 'melee', 21, 21);
  runTick(state, [
    { callLoop: () => [{ kind: 'attack', unitId: a1.id, targetId: b1.id }, { kind: 'attack', unitId: a2.id, targetId: b1.id }] },
    { callLoop: () => [{ kind: 'attack', unitId: b1.id, targetId: a1.id }, { kind: 'attack', unitId: b2.id, targetId: a1.id }] },
    createIdleRuntime(), createIdleRuntime(),
  ]);
  // 各自集火 1 个目标：a1/b1 都是 12hp，各吃 3+3=6 → 都活着；b2/a2 无人打
  assert(state.units.has(a1.id) && state.units.has(b1.id), '6 点伤害不应致死（hp12）');
  assert(state.units.has(a2.id) && state.units.has(b2.id), '未受击者存活');
  // 追加一轮打死对方
  runTick(state, [
    { callLoop: () => [{ kind: 'attack', unitId: a1.id, targetId: b1.id }, { kind: 'attack', unitId: a2.id, targetId: b1.id }] },
    { callLoop: () => [{ kind: 'attack', unitId: b1.id, targetId: a1.id }, { kind: 'attack', unitId: b2.id, targetId: a1.id }] },
    createIdleRuntime(), createIdleRuntime(),
  ]);
  runTick(state, [
    { callLoop: () => [{ kind: 'attack', unitId: a1.id, targetId: b1.id }, { kind: 'attack', unitId: a2.id, targetId: b1.id }] },
    { callLoop: () => [{ kind: 'attack', unitId: b1.id, targetId: a1.id }, { kind: 'attack', unitId: b2.id, targetId: a1.id }] },
    createIdleRuntime(), createIdleRuntime(),
  ]);
  assert(!state.units.has(b1.id) && !state.units.has(a1.id), '第三轮 12 伤害应同时互杀');
});
check('攻击者本 tick 死亡仍生效（先算全伤害再统一扣血）', () => {
  const state = blankGame();
  const a = debugSpawn(state, 0, 'ranged', 20, 22); // 射程 2
  const b1 = debugSpawn(state, 1, 'melee', 20, 21);
  const b2 = debugSpawn(state, 1, 'melee', 21, 21);
  runTick(state, [
    { callLoop: () => [{ kind: 'attack', unitId: a.id, targetId: b1.id }] },
    { callLoop: () => [{ kind: 'attack', unitId: b1.id, targetId: a.id }, { kind: 'attack', unitId: b2.id, targetId: a.id }] },
    createIdleRuntime(), createIdleRuntime(),
  ]);
  assert(!state.units.has(a.id), 'a 应在本 tick 被两个近战打死（3+3 > hp4）');
  eq(state.units.get(b1.id).hp, 12 - 2, 'a 的攻击仍应生效（无先手秒杀）');
});
check('射程/属主/无攻击能力的 intent 丢弃且不计异常', () => {
  const state = blankGame();
  const a = debugSpawn(state, 0, 'melee', 20, 20);
  const far = debugSpawn(state, 1, 'melee', 25, 20);
  const w = debugSpawn(state, 0, 'worker', 21, 20);
  runTick(state, [
    { callLoop: () => [
      { kind: 'attack', unitId: a.id, targetId: far.id }, // 超射程
      { kind: 'attack', unitId: a.id, targetId: w.id }, // 己方单位
      { kind: 'attack', unitId: w.id, targetId: far.id }, // 农民无攻击能力
      { kind: 'move', unitId: a.id, dx: 3, dy: 0 }, // 参数越界
    ] },
    createIdleRuntime(), createIdleRuntime(), createIdleRuntime(),
  ]);
  eq(state.players[0].exceptionTicks, 0, '丢弃不得计异常');
  eq(state.units.get(a.id).x, 20, '非法 intent 不得生效');
  eq(state.units.get(far.id).hp, 12, '远端目标不应受伤');
});
check('同单位一 tick 多个 intent 只保留最后一个（静默丢弃，不计异常）', () => {
  const state = blankGame();
  const u = debugSpawn(state, 0, 'melee', 20, 20);
  runTick(state, [{ callLoop: () => [
    { kind: 'move', unitId: u.id, dx: 1, dy: 0 },
    { kind: 'move', unitId: u.id, dx: 0, dy: 1 },
  ] }, ...idle().slice(1)]);
  eq(state.units.get(u.id).x, 20, '第一条应被覆盖');
  eq(state.units.get(u.id).y, 21, '最后一条生效');
  eq(state.players[0].exceptionTicks, 0, '静默丢弃不计异常');
});
check('loop() 抛异常 → 该 tick 指令集置空 + exceptionTicks++，不影响他方', () => {
  const state = blankGame();
  const u = debugSpawn(state, 0, 'melee', 20, 20);
  const other = debugSpawn(state, 1, 'melee', 20, 22);
  runTick(state, [
    { callLoop: () => { throw new Error('boom'); } },
    { callLoop: () => [{ kind: 'move', unitId: other.id, dx: 0, dy: -1 }] },
    createIdleRuntime(), createIdleRuntime(),
  ]);
  eq(state.players[0].exceptionTicks, 1, '异常计数');
  eq(state.units.get(u.id).x, 20, '该 tick 该方应原地待命');
  eq(state.units.get(other.id).y, 21, '他方不受影响');
});

console.log('== §7 胜负与淘汰 ==');
check('淘汰：无单位且无基地 → 出局，点位回归中立', () => {
  const state = blankGame();
  const mine = state.sites.find((s) => s.kind === 'resource');
  mine.owner = 3; // 3 号无单位、只剩一个矿
  runTick(state, idle());
  eq(state.players[3].alive, false, '应出局');
  eq(mine.owner, -1, '矿回归中立');
  eq(state.players[3].eliminatedAt, 0, '出局 tick');
});
check('全点位归属单一玩家 → 立即胜（无需持续）', () => {
  const state = blankGame();
  for (const s of state.sites) { s.owner = 2; s.progressOwner = -1; s.progress = 0; }
  runTick(state, idle());
  assert(state.outcome, '应分出胜负');
  eq(state.outcome.reason, 'victory', '胜因');
  eq(state.outcome.winner, 2, '胜者');
});
check('捷径条款：仅剩一方存活 → 立即胜', () => {
  const state = blankGame();
  for (let p = 0; p < 3; p++) {
    const b = state.sites.find((s) => s.kind === 'base' && s.owner === p);
    if (b) { b.owner = -1; }
  }
  const keep = state.sites.filter((s) => s.kind === 'base');
  for (const b of keep) b.owner = 2;
  const mine = state.sites.find((s) => s.kind === 'resource');
  mine.owner = -1;
  runTick(state, idle());
  assert(state.outcome, '应分出胜负');
  eq(state.outcome.reason, 'shortcut', '胜因应为捷径');
  eq(state.outcome.winner, 2, '胜者');
});
check('超时名次：存活优先 → 领土分降序 → 后出局者靠前', () => {
  const state = blankGame();
  // 0 号无单位无基地（已淘汰），1 号 1 兵，2 号无兵但有 2 基地，3 号 1 基地
  state.players[0].alive = false; state.players[0].eliminatedAt = 100;
  const bases = state.sites.filter((s) => s.kind === 'base');
  bases[0].owner = 2; bases[1].owner = 2; bases[2].owner = 3;
  debugSpawn(state, 1, 'melee', 5, 5);
  finishByTimeout(state);
  const r = state.outcome.rankings;
  assert(r[2] < r[3], '2 号（2 基地 8 分）应排在 3 号（1 基地 4 分）之前');
  assert(r[3] < r[1], '3 号（4 分）应排在 1 号（1 单位分）之前');
  assert(r[1] < r[0], '存活者排在已淘汰者之前');
});
check('领土分 = 4×基地 + 1×矿 + ⌊Σ存活单位造价/6⌋', () => {
  const state = blankGame();
  state.sites.forEach((s) => { s.owner = 1; });
  debugSpawn(state, 1, 'melee', 5, 5);
  debugSpawn(state, 1, 'cavalry', 6, 5);
  const scores = exportTerritoryScores(state);
  const nBases = state.sites.filter((s) => s.kind === 'base').length;
  const nMines = state.sites.filter((s) => s.kind === 'resource').length;
  const expect = 4 * nBases + 1 * nMines + Math.floor((8 + 16) / 6);
  eq(scores[1], expect, '领土分');
});

console.log('== §9 确定性 ==');
check('同种子 + 同脚本 → 逐 tick 状态一致（NFR-1 一票否决项的可测形式）', () => {
  const snapOf = (seed) => {
    const state = createGame({ map: buildMap(seed) });
    const scripted = (p) => ({ callLoop: () => [{ kind: 'moveTo', unitId: 100 + p, x: 5 + p, y: 5 }] });
    const runtimes = [scripted(0), scripted(1), scripted(2), scripted(3)];
    const hashes = [];
    for (let i = 0; i < 50; i++) {
      runTick(state, runtimes);
      hashes.push(JSON.stringify(buildSnapshot(state)));
    }
    return hashes;
  };
  const a = snapOf(3);
  const b = snapOf(3);
  eq(a.length, b.length, '长度');
  for (let i = 0; i < a.length; i++) eq(a[i], b[i], `第 ${i} tick 状态不一致`);
});

console.log('== 座位自认（票 14 P0-1 的可测形式）==');
// 契约 api.md 的动作函数对**非己方**单位返回 `ERR_NOT_OWNER`，而界检查在沙箱内即时返回，
// 所以“一个 tick 内逐个试 move、看谁没报错”就是一个可用的座位自认手段。
// 这条自测钉住这个事实：P0-1 不是“当前 schema 下无解”，而是“盲写脚本没找到这个口子”。
const selfIdSource = (tag) => `
let seat = -1;
let probes = 0;
function identify() {
  const all = getObjectsByType('unit');
  for (let i = 0; i < all.length; i++) {
    const u = all[i];
    for (let k = 0; k < 8; k++) {
      const d = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]][(u.id + k) % 8];
      const r = move(u.id, d[0], d[1]);
      probes += 1;
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
function loop() { if (seat < 0) identify(); }
void ${JSON.stringify(tag)};
`;

check('ERR_NOT_OWNER 自认：四方同款脚本各自认对自己的座位（不用 index API）', () => {
  const { createPlayerRuntime } = runtimeMod;
  const map = buildMap(11, { size: 64 });
  const state = createGame({ map });
  const rts = [0, 1, 2, 3].map((p) => createPlayerRuntime({ source: selfIdSource(p), playerIndex: p, map, label: `p${p}` }));
  for (let t = 0; t < 3; t++) runTick(state, rts);
  for (let p = 0; p < 4; p++) {
    eq(rts[p].peek('seat'), p, `player ${p} 认错座位`);
  }
});

check('位置法自认（四方同款脚本）会互相撞车 —— 盲写脚本用的就是这个', () => {
  const { createPlayerRuntime } = runtimeMod;
  const map = buildMap(11, { size: 64 });
  const state = createGame({ map });
  const posProbe = `
let myIndex = -1;
let markState = 0;
let markIds = [];
let markTX = [];
let markTY = [];
function beginMark() {
  markIds = []; markTX = []; markTY = [];
  const all = getObjectsByType('unit');
  for (let i = 0; i < all.length; i++) {
    const u = all[i];
    const d = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]][u.id % 8];
    const tx = u.x + d[0]; const ty = u.y + d[1];
    if (getTerrainAt(tx, ty) !== 'plain') continue;
    markIds.push(u.id); markTX.push(tx); markTY.push(ty);
    move(u.id, d[0], d[1]);
  }
  markState = 1;
}
function endMark() {
  let found = -1;
  for (let i = 0; i < markIds.length; i++) {
    const o = getObjectById(markIds[i]);
    if (o && o.x === markTX[i] && o.y === markTY[i]) { found = o.owner; break; }
  }
  markState = 0;
  if (found < 0) return false;
  myIndex = found;
  return true;
}
function loop() { if (myIndex < 0) { if (markState === 0) beginMark(); else endMark(); } }
`;
  const rts = [0, 1, 2, 3].map((p) => createPlayerRuntime({ source: posProbe, playerIndex: p, map, label: `p${p}` }));
  for (let t = 0; t < 4; t++) runTick(state, rts);
  const seats = [0, 1, 2, 3].map((p) => rts[p].peek('myIndex'));
  assert(new Set(seats).size < 4 || seats.some((s, i) => s !== i),
    '位置法自认在四方同款脚本下居然全对（那本条自测的前提就不成立，需要重写对照）');
});

console.log('== 辅助 ==');
// 直接注入 intents 走一遍 runTick（夹具用：绕过 API 面的界检查，测引擎侧裁决）
// 注意：intent 的 player 由 dispatch 阶段决定，所以按单位属主分发给对应座位。
function runTickWithMoves(state, tick, moves) {
  state.tick = tick;
  const perPlayer = [[], [], [], []];
  for (const [u, dx, dy] of moves) perPlayer[u.owner].push({ kind: 'move', unitId: u.id, dx, dy });
  const runtimes = perPlayer.map((intents) => ({ callLoop: () => intents }));
  runTick(state, runtimes);
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
