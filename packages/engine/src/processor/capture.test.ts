/**
 * 占领进度机(票 05,gdd §3.2《占领机制》):单轨累积 / 转轨重计 / 无人站立不衰减 / 同阵营保留不动 /
 * 达阈值易主并清零 / 全兵种一致。
 *
 * 每条用例在注释里写明「改什么会让它红」。四条关键反例(无人站立改成清零、转轨重计改成沿用进度、
 * 给农民加速、阈值判据 `>=` 改成 `>` / 阈值写死)分别落在下表,读数记在票的 `## Answer` 里。
 */

import { expect, it } from "vitest";
import type { Ruleset } from "@model-war/replay";

import { apply } from "../driver/apply.js";
import { loadRuleset, type RulesetView } from "../ruleset-loader/index.js";
import { stubRunner } from "../runner/stub.js";
import { processTick } from "./index.js";
import type { Intent } from "./intents.js";
import {
  UNIT_TYPES,
  type GameState,
  type Owner,
  type PlayerIndex,
  type Site,
  type Unit,
} from "../world/state.js";

/** 规则集取值与 `rulesets/v1.json` 同形;`captureTicks` 是 10,但代码里**不许**出现这个数字。 */
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

const unit = (id: number, owner: PlayerIndex, type: Unit["type"], x: number, y: number): Unit => ({
  id,
  owner,
  type,
  x,
  y,
  hp: 4,
  carrying: 0,
});

const base = (id: number, x: number, y: number, owner: Owner): Site => ({
  id,
  kind: "base",
  x,
  y,
  owner,
  progressOwner: -1,
  progress: 0,
  producing: null,
});

/** 给点位一条已有的轨道(基准状态用;推进由引擎做)。 */
const withProgress = (site: Site, progressOwner: Owner, progress: number): Site => ({
  ...site,
  progressOwner,
  progress,
});

const makeState = (units: readonly Unit[], sites: readonly Site[], tick = 0): GameState => ({
  tick,
  size: 8,
  terrain: Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => false)),
  players: [0, 1, 2, 3].map((index) => ({
    index: index as PlayerIndex,
    resources: 16,
    alive: true,
    exceptionTicks: 0,
  })),
  units,
  sites,
  nextId: 100,
  outcome: null,
  firstContactTick: null,
});

const SINK = { write: () => {} };

/** 按座位给四份策略(`undefined` 的座位交回空数组)。 */
const runners = (bySeat: readonly (readonly Intent[])[]) =>
  [0, 1, 2, 3].map((seat) => stubRunner(() => bySeat[seat] ?? []));

const step = (
  state: GameState,
  bySeat: readonly (readonly Intent[])[],
  ruleset: RulesetView = loadRuleset(RULESET),
) => processTick(state, runners(bySeat), ruleset, SINK);

const at = (state: GameState, id: number): Unit => {
  const found = state.units.find((item) => item.id === id);
  if (found === undefined) {
    throw new Error(`状态里没有单位 ${String(id)}`);
  }
  return found;
};

it("点位持有属主、进度属主与进度三样;属主与进度属主可为中立", () => {
  const state = apply(makeState([], []), RULESET, {
    kind: "create-site",
    id: 7,
    siteKind: "base",
    x: 1,
    y: 1,
    owner: -1,
  });
  const site = state.sites[0]!;
  expect(site.owner).toBe(-1);
  expect(site.progressOwner).toBe(-1);
  expect(site.progress).toBe(0);
});

it("单格单单位:两方同 tick 争同一格,占位基准判掉一个,只有站上去的那个驱动占领", () => {
  const site = base(5, 2, 0, -1);
  const a = unit(1, 0, "worker", 1, 0);
  const b = unit(2, 1, "worker", 3, 0);
  const result = step(makeState([a, b], [site]), [
    [{ kind: "move", unitId: 1, dx: 1, dy: 0 }],
    [{ kind: "move", unitId: 2, dx: -1, dy: 0 }],
    [],
    [],
  ]);
  // tick 0 的轮转优先:seat1 = 1 > seat0 = 0 → B 进格,A 被占位基准判掉(原地)。同一格只有一个。
  // 「同 tick 两个都进去」的反例:那样两条移动断言先红,点位上的驱动者也就成了两者之一。
  expect(at(result.state, 1).x).toBe(1);
  expect(at(result.state, 2).x).toBe(2);
  const captured = result.state.sites[0]!;
  // 驱动者是站上去的那个(B,owner 1);转轨重计从 1 起算。
  expect(captured.progressOwner).toBe(1);
  expect(captured.progress).toBe(1);
});

it("退化情形:同格两个单位时取数值 id 最小者的属主为驱动者(开局绕过占位裁决后的确定答案)", () => {
  const site = base(4, 3, 0, -1);
  // 正常路径下这不会被构造出来:同 tick 争同一格由 04 的占位裁决判掉。开局按地图逐个摆单位,
  // 地图数据若声明两个落在同一格的初始单位就绕过了它,那时取低 id 是给退化情形的确定答案。
  const low = unit(1, 1, "worker", 3, 0);
  const high = unit(2, 0, "worker", 3, 0);
  const result = step(makeState([low, high], [site]), [[], [], [], []]);
  expect(result.state.sites[0]!.progressOwner).toBe(1);
  expect(result.state.sites[0]!.progress).toBe(1);
});

it("驱动者与属主同阵营:进度(与进度属主)保留不动", () => {
  const site = withProgress(base(6, 2, 2, 0), 1, 3);
  const ally = unit(1, 0, "worker", 2, 2);
  const result = step(makeState([ally], [site]), [[], [], [], []]);
  // 推进或清零都会让这两条红:同阵营什么都写。
  expect(result.state.sites[0]!.progress).toBe(3);
  expect(result.state.sites[0]!.progressOwner).toBe(1);
  expect(result.state.sites[0]!.owner).toBe(0);
  expect(result.events).toEqual([]);
});

it("无人站立:一整局进度保留不动、不衰减", () => {
  const site = withProgress(base(3, 5, 5, 1), 2, 4);
  // 单位在别处,永远不站上 (5,5)。
  let state = makeState([unit(1, 0, "worker", 0, 0)], [site]);
  for (let tick = 0; tick < RULESET.tickLimit; tick++) {
    state = step(state, [[], [], [], []]).state;
  }
  // 「无人站立改成清零/衰减」的反例:这一条会红(进度不再是 4)。
  expect(state.sites[0]!.progress).toBe(4);
  expect(state.sites[0]!.progressOwner).toBe(2);
  expect(state.sites[0]!.owner).toBe(1);
});

it("驱动者与属主不同、进度属主也不是它:转轨重计(从 1 起算,无侵蚀)", () => {
  const site = withProgress(base(8, 1, 1, -1), 1, 4);
  const driver = unit(1, 2, "worker", 1, 1);
  const result = step(makeState([driver], [site]), [[], [], [], []]);
  // 「转轨改成沿用进度」的反例:那样会得到 5。
  expect(result.state.sites[0]!.progress).toBe(1);
  expect(result.state.sites[0]!.progressOwner).toBe(2);
});

it("进度属主就是驱动者:进度加一", () => {
  const site = withProgress(base(9, 1, 1, -1), 2, 4);
  const driver = unit(1, 2, "worker", 1, 1);
  const result = step(makeState([driver], [site]), [[], [], [], []]);
  expect(result.state.sites[0]!.progress).toBe(5);
  expect(result.state.sites[0]!.progressOwner).toBe(2);
});

it("达阈值:所有权易主、整条轨道清零,site-captured 在易主那一刻发", () => {
  const site = withProgress(base(11, 1, 1, 0), 1, RULESET.captureTicks - 1);
  const driver = unit(1, 1, "worker", 1, 1);
  const result = step(makeState([driver], [site]), [[], [], [], []]);
  const captured = result.state.sites[0]!;
  expect(captured.owner).toBe(1);
  // 清整条轨道:进度归 0、进度属主清成 -1(不是「进度 0 但属主还在」的半截状态)。
  expect(captured.progress).toBe(0);
  expect(captured.progressOwner).toBe(-1);
  expect(result.events).toEqual([{ kind: "site-captured", subjectId: 11 }]);
});

it("未达阈值:不发 site-captured,属主不动", () => {
  const site = withProgress(base(11, 1, 1, 0), 1, RULESET.captureTicks - 2);
  const driver = unit(1, 1, "worker", 1, 1);
  const result = step(makeState([driver], [site]), [[], [], [], []]);
  expect(result.state.sites[0]!.owner).toBe(0);
  expect(result.state.sites[0]!.progress).toBe(RULESET.captureTicks - 1);
  expect(result.events).toEqual([]);
});

it("累积到几时算达:驻留第 N tick 进度恰好 N,第 captureTicks tick 易主(阈值自规则集读,非 10)", () => {
  // 阈值换成 3:若判据写死 10 或写成 `progress > captureTicks`,下面这一条就红。
  const ruleset3 = loadRuleset({ ...RULESET, captureTicks: 3 });
  let state = makeState([unit(1, 1, "worker", 2, 2)], [base(12, 2, 2, -1)]);
  for (const expected of [1, 2]) {
    state = step(state, [[], [], [], []], ruleset3).state;
    expect(state.sites[0]!.progress).toBe(expected);
    expect(state.sites[0]!.owner).toBe(-1);
  }
  const captured = step(state, [[], [], [], []], ruleset3);
  expect(captured.state.sites[0]!.owner).toBe(1);
  expect(captured.state.sites[0]!.progress).toBe(0);
  expect(captured.events).toEqual([{ kind: "site-captured", subjectId: 12 }]);
});

it("全兵种占领速度一致:四个兵种同样的驻留 tick 数产出同样的进度序列(农民不加速)", () => {
  const sequences = UNIT_TYPES.map((type) => {
    let state = makeState([unit(1, 1, type, 2, 2)], [base(13, 2, 2, -1)]);
    const progress: number[] = [];
    for (let n = 1; n < RULESET.captureTicks; n++) {
      state = step(state, [[], [], [], []]).state;
      progress.push(state.sites[0]!.progress);
    }
    const afterThreshold = step(state, [[], [], [], []]).state.sites[0]!;
    return { progress, owner: afterThreshold.owner, progressAtThreshold: afterThreshold.progress };
  });
  const expected = Array.from({ length: RULESET.captureTicks - 1 }, (_item, index) => index + 1);
  for (const sequence of sequences) {
    // 「给农民(或任一兵种)加一个加速系数」的反例:那一个兵种的序列会与 expected 岔开,这里即红。
    expect(sequence.progress).toEqual(expected);
    expect(sequence.owner).toBe(1);
    expect(sequence.progressAtThreshold).toBe(0);
  }
  // 四个兵种的进度序列逐项相同——判据是「同样驻留 tick 数产出同样进度」,不是各自跑通即可。
  expect(new Set(sequences.map((sequence) => sequence.progress.join(","))).size).toBe(1);
});

it("堵点:己方单位站自家点位上,敌方同 tick 移上去被占位裁决判掉,进度保留不动", () => {
  const site = withProgress(base(14, 2, 0, 0), 1, 3);
  const ally = unit(1, 0, "worker", 2, 0);
  const enemy = unit(2, 1, "worker", 1, 0);
  const result = step(makeState([ally, enemy], [site]), [
    [],
    [{ kind: "move", unitId: 2, dx: 1, dy: 0 }],
    [],
    [],
  ]);
  // 钉的是「敌方**没能站上**那一格」这条路径:04 的占位裁决把 (2,0) 判给基准占位者(己方单位)。
  // 「站上去但 D 是己方」那条路不可能——单格单单位。
  expect(at(result.state, 2).x).toBe(1);
  // 格上的驱动者仍是己方 → 同阵营 → 保留不动。要抢点必须先消灭这个单位(单位可被攻击,基地不可)。
  expect(result.state.sites[0]!.owner).toBe(0);
  expect(result.state.sites[0]!.progressOwner).toBe(1);
  expect(result.state.sites[0]!.progress).toBe(3);
});

it("同 tick 多个点位易主:事件按点位 id 升序(与状态的升序一致)", () => {
  const low = withProgress(base(4, 1, 1, -1), 1, RULESET.captureTicks - 1);
  const high = withProgress(base(9, 3, 3, -1), 1, RULESET.captureTicks - 1);
  const a = unit(1, 1, "worker", 1, 1);
  const b = unit(2, 1, "worker", 3, 3);
  const result = step(makeState([a, b], [low, high]), [[], [], [], []]);
  // 「遍历序不是 id 升序」的反例:两条事件的 subjectId 会颠倒。
  expect(result.events).toEqual([
    { kind: "site-captured", subjectId: 4 },
    { kind: "site-captured", subjectId: 9 },
  ]);
});
