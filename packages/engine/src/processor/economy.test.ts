/**
 * 采集、交付与经济死亡(票 07;gdd §5《经济与生产》、`docs/rules-v1/rules.md` §4.1–§4.3)。
 *
 * 每条用例在注释里写明「改什么会让它红」;五条关键反例的实测读数记在票的 `## Answer` 里:
 * 交付目标改成「按座位分组取最后」(座位口径)、经济死亡事件改成每 tick 发、允许未占领开采、
 * 「满携带即停」去掉 `carryLimit` 封顶,以及交付目标改成取数组末位(采集多矿取 id 最大)。
 *
 * ── 夹具底座 ──
 *
 * 与 `production.test.ts` 同款:一个中立副点位 + 座位 3 的占位部队,用来堵住步 5 的终局判定,
 * 免得终局事件挤进对 `events` 的断言(理由见那份文件里 `DECOY_SITE` 那段注释)。
 * 经济死亡与 `events` 的用例尤其需要它:四席都不该被「只剩一方」的捷径顺手判出终局。
 */

import { expect, it } from "vitest";
import type { Ruleset } from "@model-war/replay";

import { loadRuleset } from "../ruleset-loader/index.js";
import { stubRunner } from "../runner/stub.js";
import { isEconomyDead, transferChangeOf } from "./economy.js";
import { processTick } from "./index.js";
import { buildSnapshot } from "../snapshot/snapshot.js";
import type { Intent } from "./intents.js";
import type { GameState, Owner, PlayerIndex, Site, Unit, UnitType } from "../world/state.js";

/** 规则集取值与 `rulesets/v1.json` 同形;代码里**不许**出现那些数字。 */
const RULESET: Ruleset = {
  tickLimit: 600,
  captureTicks: 10,
  initialResources: 16,
  harvestRate: 1,
  carryLimit: 20,
  resourcePerSite: 200,
  worker: { cost: 4, hp: 2, damage: 0, range: 1, speed: 1, spawnTicks: 2 },
  melee: { cost: 8, hp: 12, damage: 3, range: 1, speed: 1, spawnTicks: 4 },
  ranged: { cost: 12, hp: 4, damage: 2, range: 2, speed: 1, spawnTicks: 6 },
  cavalry: { cost: 16, hp: 6, damage: 2, range: 1, speed: 2, spawnTicks: 8 },
  baseScore: 4,
  resourceScore: 1,
  unitCostDivisor: 6,
  exceptionTickLimit: 0,
  eventTickLimit: 0,
  apiCallTickLimit: 0,
  memoryLimit: 0,
  memoryTickCeiling: 0,
  wallClockSoftLimit: 0,
  wallClockHardTimeout: 0,
  scriptSizeLimit: 0,
};

const plain = (size: number): readonly (readonly boolean[])[] =>
  Array.from({ length: size }, () => Array.from({ length: size }, () => false));

const unit = (
  id: number,
  owner: PlayerIndex,
  type: UnitType,
  x: number,
  y: number,
  carrying = 0,
): Unit => ({ id, owner, type, x, y, hp: 4, carrying });

const site = (
  id: number,
  kind: Site["kind"],
  x: number,
  y: number,
  owner: Owner,
  remaining?: number,
): Site => ({
  id,
  kind,
  x,
  y,
  owner,
  progressOwner: -1,
  progress: 0,
  producing: null,
  ...(remaining === undefined ? {} : { remaining }),
});

const base = (id: number, x: number, y: number, owner: Owner): Site =>
  site(id, "base", x, y, owner);

const resourceSite = (id: number, x: number, y: number, owner: Owner, remaining: number): Site =>
  site(id, "resource", x, y, owner, remaining);

const makeState = (
  units: readonly Unit[],
  sites: readonly Site[],
  options: {
    readonly tick?: number;
    readonly resources?: Partial<Record<PlayerIndex, number>>;
    readonly alive?: Partial<Record<PlayerIndex, boolean>>;
    readonly economyDeadAtTick?: readonly (number | null)[];
  } = {},
): GameState => ({
  tick: options.tick ?? 0,
  size: 8,
  terrain: plain(8),
  players: [0, 1, 2, 3].map((index) => ({
    index: index as PlayerIndex,
    resources: options.resources?.[index as PlayerIndex] ?? 16,
    alive: options.alive?.[index as PlayerIndex] ?? true,
    exceptionTicks: 0,
  })),
  units,
  sites,
  nextId: 100,
  outcome: null,
  // 与 `players[].alive` 一起派生,免得夹具里出现「已出局却没有淘汰时刻」这种真实引擎不会产生的中间态。
  eliminatedAtTick: [0, 1, 2, 3].map((index) =>
    (options.alive?.[index as PlayerIndex] ?? true) ? null : (options.tick ?? 0),
  ),
  // 默认非 null:这些用例不该被「首触」事件干扰(战斗用例的同一条处置)。
  firstContactTick: 0,
  economyDeadAtTick: options.economyDeadAtTick ?? [null, null, null, null],
});

/** 一个**不产生终局**的底座:中立副点位 + 座位 3 的占位部队(见头注)。 */
const DECOY_SITE = base(90, 7, 7, -1);
const HOLDER = unit(60, 3, "worker", 7, 6);

const SINK = { write: () => {} };

const runners = (bySeat: readonly (readonly Intent[])[]) =>
  [0, 1, 2, 3].map((seat) => stubRunner(() => bySeat[seat] ?? []));

const step = (state: GameState, bySeat: readonly (readonly Intent[])[]) =>
  processTick(state, runners(bySeat), loadRuleset(RULESET), SINK);

const harvest = (unitId: number, siteId: number): Intent => ({ kind: "harvest", unitId, siteId });
const transfer = (unitId: number): Intent => ({ kind: "transfer", unitId });
const spawn = (baseId: number, unitType: UnitType): Intent => ({
  kind: "spawnUnit",
  baseId,
  unitType,
});

// ── 采集 ──────────────────────────────────────────────────────────────────────

it("采集:carrying 加、矿的 remaining 减放同一次落子;资源**不入玩家池**(要交付才入)", () => {
  const worker = unit(1, 0, "worker", 3, 3);
  const mine = resourceSite(5, 3, 4, 0, 200);
  const result = step(
    makeState([worker, HOLDER], [mine, DECOY_SITE], { alive: { 1: false, 2: false } }),
    [[harvest(1, 5)], [], [], []],
  );
  expect(result.state.units[0]!.carrying).toBe(1);
  expect(result.state.sites[0]!.remaining).toBe(199);
  // 采集只动携带量,玩家池一分不动(这是「交付才入池」,也是「无被动收入」的一半)。
  // 反例:落子只加携带量、不减 remaining → 199 那条红;采集顺手把资源加进池 → 16 那条红。
  expect(result.state.players[0]!.resources).toBe(16);
  expect(result.events).toEqual([]);
});

it("采空(remaining=0)后不再是可采目标:不删点位、不改 kind", () => {
  const worker = unit(1, 0, "worker", 3, 3);
  const mine = resourceSite(5, 3, 4, 0, 1);
  const state = makeState([worker, HOLDER], [mine, DECOY_SITE], { alive: { 1: false, 2: false } });
  const first = step(state, [[harvest(1, 5)], [], [], []]);
  // 余量 1 被取走 → 0。矿还在,kind 仍是 resource(只contributes 胜利判定,不再产资源)。
  expect(first.state.sites[0]!.remaining).toBe(0);
  expect(first.state.sites[0]!.kind).toBe("resource");

  const second = step(first.state, [[harvest(1, 5)], [], [], []]);
  // 采空之后:第二次采集判 false(没有 remaining > 0 的相邻己方矿)→ 不发变更、carrying 不变。
  expect(second.state.units[0]!.carrying).toBe(1);
  expect(second.state.sites[0]!.remaining).toBe(0);
  expect(second.events).toEqual([]);
});

it("满携带即停按**封顶**实现(取到满为止),harvestRate>1 时封顶是 carryLimit-carrying", () => {
  // 用 harvestRate=5 的规则集才能让 carryLimit 那一项真的生效:rate=1 时
  // min(1, carryLimit-carrying, remaining) 与 min(1, remaining) 恒等,封顶看不出来。
  const ruleset = loadRuleset({ ...RULESET, harvestRate: 5 });
  const worker = unit(1, 0, "worker", 3, 3, 19);
  const mine = resourceSite(5, 3, 4, 0, 200);
  const result = processTick(
    makeState([worker], [mine, DECOY_SITE]),
    runners([[harvest(1, 5)], [], [], []]),
    ruleset,
    SINK,
  );
  // 19 → 20(只取 1,取到满为止),不是 24(超上限),也不是 0(「满了就一点不取」是另一支)。
  expect(result.state.units[0]!.carrying).toBe(20);
  expect(result.state.sites[0]!.remaining).toBe(199);
  // 反例:去掉 `carryLimit - carrying` 这一项 → carrying 变 24 → 两条红。
});

it("满携带(carrying == carryLimit)时不再采集:判据第 6 条直接判假", () => {
  const worker = unit(1, 0, "worker", 3, 3, 20);
  const mine = resourceSite(5, 3, 4, 0, 200);
  const result = step(makeState([worker], [mine, DECOY_SITE]), [[harvest(1, 5)], [], [], []]);
  expect(result.state.units[0]!.carrying).toBe(20);
  expect(result.state.sites[0]!.remaining).toBe(200);
});

it("多个相邻己方矿取**数值 id 最小**者;意图里的 siteId 不参与目标选择", () => {
  const worker = unit(1, 0, "worker", 3, 3);
  // (3,3) 同时贴着 id=4@(4,3) 与 id=7@(3,4)。sites 升序:[4, 7]。
  const low = resourceSite(4, 4, 3, 0, 200);
  const high = resourceSite(7, 3, 4, 0, 200);
  const result = step(makeState([worker], [low, high, DECOY_SITE]), [
    // 意图点名 id=7,引擎仍采 id=4(取 id 最小)。理由是「数值升序是唯一被声明的定序语义」。
    [harvest(1, 7)],
    [],
    [],
    [],
  ]);
  expect(result.state.sites[0]!.remaining).toBe(199); // id=4 被采
  expect(result.state.sites[1]!.remaining).toBe(200); // id=7 没动
  // 反例:改成取数组末位 / id 最大 → 上面两条对调。
});

it("站在矿格上也能采(切比雪夫 ≤ 1,与战斗的 distance <= range 同源):含距离 0 那一格", () => {
  const worker = unit(1, 0, "worker", 3, 3);
  const mine = resourceSite(5, 3, 3, 0, 200);
  const result = step(makeState([worker], [mine, DECOY_SITE]), [[harvest(1, 5)], [], [], []]);
  expect(result.state.units[0]!.carrying).toBe(1);
  expect(result.state.sites[0]!.remaining).toBe(199);
  // 反例:把「相邻」改成「恰好 1」→ 站在矿格上的这一条红。
});

it("中立 / 敌方资源点无开采权:未占领就采集无效(静默丢弃)", () => {
  const worker = unit(1, 0, "worker", 3, 3);
  const neutral = resourceSite(5, 3, 4, -1, 200);
  const enemy = resourceSite(6, 4, 3, 1, 200);
  const result = step(makeState([worker], [neutral, enemy, DECOY_SITE]), [
    [harvest(1, 5), harvest(1, 6)], // 每单位只留最后一条,但两条都落在「必须己方」这条判据上
    [],
    [],
    [],
  ]);
  // 反例:去掉 `owner === seat` 判据 → 两个中立/敌方矿都会被采。
  expect(result.state.units[0]!.carrying).toBe(0);
  expect(result.state.sites[0]!.remaining).toBe(200);
  expect(result.state.sites[1]!.remaining).toBe(200);
});

it("采集要**采集能力**:非农民单位(近战)贴着自己的矿也采不了", () => {
  const soldier = unit(1, 0, "melee", 3, 3);
  const mine = resourceSite(5, 3, 4, 0, 200);
  const result = step(makeState([soldier], [mine, DECOY_SITE]), [[harvest(1, 5)], [], [], []]);
  // 反例:采集能力判据放宽到「任何兵种」→ 近战开始采 → 这里红。
  expect(result.state.units[0]!.carrying).toBe(0);
  expect(result.state.sites[0]!.remaining).toBe(200);
});

it("采集的属主与存在性:拿别人的农民或用不存在的单位 id 采集都无效", () => {
  const enemyWorker = unit(1, 1, "worker", 3, 3);
  const mine = resourceSite(5, 3, 4, 1, 200);
  const result = step(makeState([enemyWorker], [mine, DECOY_SITE]), [
    [harvest(1, 5), harvest(99, 5)],
    [],
    [],
    [],
  ]);
  expect(result.state.units[0]!.carrying).toBe(0);
  expect(result.state.sites[0]!.remaining).toBe(200);
});

it("无被动收入:农民贴着己方矿区站着不动、不提交 intent,资源一点不涨", () => {
  const worker = unit(1, 0, "worker", 3, 3);
  const mine = resourceSite(5, 3, 4, 0, 200);
  let state = makeState([worker], [mine, DECOY_SITE]);
  for (let tick = 0; tick < 3; tick++) {
    state = step(state, [[], [], [], []]).state;
  }
  // 反例:把采集改成「站在矿旁自动开采」→ carrying 会涨、这里红。
  expect(state.players[0]!.resources).toBe(16);
  expect(state.units[0]!.carrying).toBe(0);
  expect(state.sites[0]!.remaining).toBe(200);
});

it("采空不删点位:全点位胜利条件数的是全部点位,与 remaining 无关", () => {
  // 座位 0 控制全部点位(一个基地 + 一个余量 1 的资源点),农民贴着矿采;一 tick 内采空。
  const worker = unit(1, 0, "worker", 2, 3);
  const home = base(5, 0, 0, 0);
  const mine = resourceSite(6, 2, 2, 0, 1);
  const result = step(
    makeState([worker], [home, mine], { alive: { 1: false, 2: false, 3: false } }),
    [[harvest(1, 6)], [], [], []],
  );
  // 采空后点位仍在、kind 不变。
  expect(result.state.sites.map((item) => item.id)).toEqual([5, 6]);
  expect(result.state.sites[1]!.remaining).toBe(0);
  expect(result.state.sites[1]!.kind).toBe("resource");
  // 步 5 的「全点位归属」数的是全部点位,于是座位 0 照样凭控制全图获胜。
  // 反例:采空时把点位从 sites 里删掉 → 全点位判定少一个点仍然成立,但上面 map 那条红。
  expect(result.events).toContainEqual({ kind: "victory", subjectId: 0 });
});

// ── 交付 ──────────────────────────────────────────────────────────────────────

it("交付:carrying 清零入玩家池(全局共享池,不按基地分池)", () => {
  const worker = unit(1, 0, "worker", 3, 3, 8);
  const home = base(5, 3, 4, 0);
  const result = step(makeState([worker], [home, DECOY_SITE]), [[transfer(1)], [], [], []]);
  expect(result.state.units[0]!.carrying).toBe(0);
  expect(result.state.players[0]!.resources).toBe(16 + 8);
  // 反例:只清零不入池、或只入池不清零 → 两条各红一条。
});

it("carrying === 0 时交付直接判假:**静默丢弃**——不发事件、不计异常", () => {
  const worker = unit(1, 0, "worker", 3, 3, 0);
  const home = base(5, 3, 4, 0);
  const result = step(
    makeState([worker, HOLDER], [home, DECOY_SITE], { alive: { 1: false, 2: false } }),
    [[transfer(1)], [], [], []],
  );
  expect(result.state.players[0]!.resources).toBe(16);
  expect(result.state.units[0]!.carrying).toBe(0);
  // 八种事件里没有「意图无效」这一类;交付空口袋不是可观察事件。
  expect(result.events).toEqual([]);
});

it("交付目标:相邻己方基地里**数值 id 最小**者(两个相邻己方基地才能把口径分开)", () => {
  const worker = unit(1, 0, "worker", 3, 3, 8);
  // (3,3) 同时贴着 id=4@(4,3) 与 id=8@(3,4),都属于座位 0。
  const low = base(4, 4, 3, 0);
  const high = base(8, 3, 4, 0);
  const view = makeState([worker], [low, high, DECOY_SITE]);
  const change = transferChangeOf(view, 0, loadRuleset(RULESET), { kind: "transfer", unitId: 1 });
  // 落到 id=4 那个基地:资源进玩家池(与哪个基地收无关),但记录的目标基地必须是 id 最小者。
  // 反例:按「座位分组取最后」→ 目标变成 id=8 → 这一条红。
  expect(change).toEqual({ kind: "transfer", unitId: 1, siteId: 4, player: 0, amount: 8 });
});

it("交付目标**不是**「属主座位号最小」:相邻敌方基地不被选,仍交给自己那座 id 更大的", () => {
  // 座位 1 的农民贴着两座基地:敌方座位 0 的 id=4、自己的 id=8。
  // 「取己方基地里 id 最小」= 自己的 id=8;「取相邻基地里属主座位号最小」= 敌方 id=4。两口径分开。
  const worker = unit(1, 1, "worker", 3, 3, 8);
  const enemy = base(4, 4, 3, 0);
  const own = base(8, 3, 4, 1);
  const view = makeState([worker], [enemy, own, DECOY_SITE]);
  const change = transferChangeOf(view, 1, loadRuleset(RULESET), { kind: "transfer", unitId: 1 });
  // 反例:取「属主座位号最小的相邻基地」(不判敌我)→ 目标变成敌方 id=4 → 这一条红。
  expect(change).toEqual({ kind: "transfer", unitId: 1, siteId: 8, player: 1, amount: 8 });
});

it("交付要相邻己方基地与属主正确:没有相邻基地 / 拿别人的农民交付都无效", () => {
  const far = base(5, 6, 6, 0);
  const orphan = unit(1, 0, "worker", 3, 3, 8);
  const noBase = step(makeState([orphan], [far, DECOY_SITE]), [[transfer(1)], [], [], []]);
  expect(noBase.state.players[0]!.resources).toBe(16);
  expect(noBase.state.units[0]!.carrying).toBe(8);

  const enemyWorker = unit(2, 1, "worker", 3, 3, 8);
  const home = base(5, 3, 4, 0);
  const wrongOwner = step(makeState([enemyWorker], [home, DECOY_SITE]), [
    [transfer(2)],
    [],
    [],
    [],
  ]);
  expect(wrongOwner.state.players[1]!.resources).toBe(16);
  expect(wrongOwner.state.units[0]!.carrying).toBe(8);
});

// ── c) 在 d) 之前:交付立刻可花的钱 ────────────────────────────────────────────

it("交付(c)在生产(d)之前:这一 tick 交的货能立刻供这一 tick 下单", () => {
  // 座位 0 资金 8,两座基地各下一单 melee(单价 8),农民贴着基地带着 8。
  // 步 1 对两单各用 tick 开始的状态校验:8 >= 8,两单都放行。
  const worker = unit(1, 0, "worker", 1, 2, 8); // 贴着 base(4)
  const near = base(4, 1, 1, 0);
  const other = base(7, 3, 3, 0);
  const result = step(
    makeState([worker], [near, other], {
      resources: { 0: 8 },
      alive: { 1: false, 2: false, 3: false },
    }),
    [[transfer(1), spawn(4, "melee"), spawn(7, "melee")], [], [], []],
  );
  // 交付先落:8 + 8 = 16;d) 两单各扣 8 → 0,两座基地都占上队列。
  // 反例:把 c 挪到 d 之后 → 第一单扣 8 到 0,第二单资金不足被丢弃 → base(7) 那条红。
  expect(result.state.players[0]!.resources).toBe(0);
  expect(result.state.sites[0]!.producing).toEqual({ type: "melee", remainingTicks: 3 });
  expect(result.state.sites[1]!.producing).toEqual({ type: "melee", remainingTicks: 3 });
});

// ── 经济死亡 ──────────────────────────────────────────────────────────────────

it("经济死亡:无农民且 resources < worker.cost → 发一条 economy-dead;闩让每局每席至多一条", () => {
  // 座位 0 有一座基地(不满足淘汰条件)、无单位、资金 2 < 4;座位 1 也留基地,避免「只剩一方」的捷径。
  const sites = [base(5, 2, 2, 0), base(6, 5, 5, 1)];
  const first = step(makeState([], sites, { resources: { 0: 2 }, alive: { 2: false, 3: false } }), [
    [],
    [],
    [],
    [],
  ]);
  expect(first.state.economyDeadAtTick[0]).toBe(0);
  expect(first.events).toEqual([{ kind: "economy-dead", subjectId: 0 }]);

  const second = step(first.state, [[], [], [], []]);
  // 闩:第二次成立不再发。反例:去掉 `economyDeadAtTick` 的 `continue` → 这里多一条 → 红。
  expect(second.state.economyDeadAtTick[0]).toBe(0);
  expect(second.events).toEqual([]);
});

it("经济死亡判据的两个谓词缺一不可:有农民 / 钱够 都**不**进死亡", () => {
  // a) 有农民(资金仍不足)→ 不是经济死亡。
  const worker = unit(1, 0, "worker", 2, 2);
  const withWorker = step(
    makeState([worker], [base(5, 2, 3, 0), base(6, 5, 5, 1)], {
      resources: { 0: 2 },
      alive: { 2: false, 3: false },
    }),
    [[], [], [], []],
  );
  expect(withWorker.events.filter((event) => event.kind === "economy-dead")).toEqual([]);

  // b) 无农民但资金 >= worker.cost(4)→ 不是经济死亡。
  const enoughMoney = step(
    makeState([], [base(5, 2, 2, 0), base(6, 5, 5, 1)], {
      resources: { 0: 4 },
      alive: { 2: false, 3: false },
    }),
    [[], [], [], []],
  );
  expect(enoughMoney.events.filter((event) => event.kind === "economy-dead")).toEqual([]);
});

it("经济死亡判定在 d) 之后:同一 tick 刚出兵的农民把玩家从死亡边缘拉回来", () => {
  // 座位 0 资金 0、当前无单位,但基地里有一条**本 tick 归零**的工人订单: d) 会出兵。
  const producingBase: Site = {
    ...base(5, 2, 2, 0),
    producing: { type: "worker", remainingTicks: 0 },
  };
  const result = step(
    makeState([], [producingBase, base(6, 5, 5, 1)], {
      resources: { 0: 0 },
      alive: { 2: false, 3: false },
    }),
    [[], [], [], []],
  );
  expect(result.state.units.map((item) => item.type)).toEqual(["worker"]);
  // 反例:把判定提到 d) 之前 → 出兵前该玩家无农民且资金 0 < 4 → 多发一条 economy-dead → 这里红。
  expect(result.events.filter((event) => event.kind === "economy-dead")).toEqual([]);
});

it("同一 tick 多个玩家同时经济死亡:事件按座位号升序(收集器按主体数值 id 定序)", () => {
  const sites = [base(5, 2, 2, 0), base(6, 5, 5, 1), base(7, 1, 6, 2), base(8, 6, 1, 3)];
  const result = step(
    makeState([], sites, { resources: { 0: 2, 1: 3 }, alive: { 2: false, 3: false } }),
    [[], [], [], []],
  );
  expect(result.events).toEqual([
    { kind: "economy-dead", subjectId: 0 },
    { kind: "economy-dead", subjectId: 1 },
  ]);
  expect(result.state.economyDeadAtTick).toEqual([0, 0, null, null]);
});

it("经济死亡**不是出局**:它不碰 alive、不写任何玩家字段(判据是纯函数,事件只是记账)", () => {
  const sites = [base(5, 2, 2, 0), base(6, 5, 5, 1)];
  const result = step(
    makeState([], sites, { resources: { 0: 2 }, alive: { 2: false, 3: false } }),
    [[], [], [], []],
  );
  expect(result.state.players[0]!.alive).toBe(true);
  // 出局才是步 5 的事;经济死亡只发一条事件 + 记一个「发过了」的 tick。
  expect(result.state.eliminatedAtTick[0]).toBeNull();
});

// ── 反向用例:状态模型里没有经济死亡字段 ────────────────────────────────────────

it("Player 的键集**恰好**是契约面四栏:多一栏 `economicallyDead` 这类布尔就红", () => {
  const player = makeState([], []).players[0]!;
  expect(Object.keys(player)).toEqual(["index", "resources", "alive", "exceptionTicks"]);
});

it("Snapshot 里**没有**任何与 economy 有关的栏(脚本可见面不暴露经济状态)", () => {
  const snapshot = buildSnapshot(makeState([], []));
  expect(Object.keys(snapshot)).toEqual(["tick", "size", "terrain", "players", "units", "sites"]);
  expect(Object.keys(snapshot).filter((key) => /econom/i.test(key))).toEqual([]);
  // 闩栏不进快照:它只是「事件发过了」的记账。
  expect("economyDeadAtTick" in snapshot).toBe(false);
});

it("经济死亡的判据是**纯函数**:它不读 `economyDeadAtTick` 那一栏", () => {
  const view = makeState([], [base(5, 2, 2, 0)], { resources: { 0: 2 } });
  const ruleset = loadRuleset(RULESET);
  // 同一份经济事实,只把闩栏从「没发过」换成「发过了」——判据同值。
  // 用 GameState 接住再传:力的「不读那一栏」由参数类型 EconomyView 承担(它根本没有那一栏)。
  const notYet = isEconomyDead(view, 0, ruleset);
  const latchOn: GameState = { ...view, economyDeadAtTick: [0, null, null, null] };
  const already = isEconomyDead(latchOn, 0, ruleset);
  expect(notYet).toBe(true);
  expect(already).toBe(true);
  // 「已发过」不会让判据由真变假;反过来有农民时也不会因闩栏变真。
  const withWorker = makeState([unit(1, 0, "worker", 0, 0)], [base(5, 2, 2, 0)], {
    resources: { 0: 2 },
  });
  const withWorkerLatch: GameState = { ...withWorker, economyDeadAtTick: [0, null, null, null] };
  expect(isEconomyDead(withWorkerLatch, 0, ruleset)).toBe(false);
});
