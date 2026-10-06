/**
 * 状态维护的不变量与反例(票 10)。
 *
 * ── 这两条断言测的是**状态的形状有没有被保持**,不是执行路径的可复现性 ──
 *
 * 「重跑十次逐 tick 全等」测的是同一条执行路径每次得到同一结果;本文件测的是**状态本身**
 * 在维护过程中有没有被保持成形(对象数组按数值 id 升序),以及**事件流的全序**是不是由
 * 规则(而非登记序 / 遍历自由度)定的。两条不是同一件事,不互相替代——复算一致性归票 11。
 *
 * ── 归属：为什么它属于引擎包而不是状态哈希那个包 ──
 *
 * `packages/replay` 的 `stateHashOf` 保证的是「**我按你给的顺序算**」——数组保序、对象键升序,
 * 它不替你重排。这一格保证的是「**你给的顺序本来就是对的**」:状态维护(写入口 `apply` 的
 * 有序插入 + 删除过滤,见 `driver/apply.ts` 头注)每 tick 结束时把 `units` / `sites` 维持成
 * 数值 id 升序。前者是原语,后者是调用它的人的义务;义务的守门人住在这里。
 *
 * ── 与 `step-order.test.ts` 那三条「回归基」的关系 ──
 *
 * `step-order.test.ts` 在 02a 立过三条最小版(空事件流下的两次相等、一次 `push` 断言、一次
 * 单次 `apply` 的升序)。本文件是**完整版**:构造真的让顺序可能被打乱(同 tick 新建 + 移动 +
 * 死亡 + 易主,连跑多 tick)、事件流真的有内容、定序断言同时覆盖 `push`/`unshift`/`splice`,
 * 并在收集器层直接把「按 id 定序」与「按登记序」区分开。
 *
 * ── 每条用例的注释写明它钉的是什么,以及改什么会让它红 ──
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import { stateHashOf, type JsonValue, type Ruleset } from "@model-war/replay";

import { apply } from "../driver/apply.js";
import { loadRuleset } from "../ruleset-loader/index.js";
import { stubRunner } from "../runner/stub.js";
import type { TickSink } from "../replay-writer/index.js";
import { buildTickLine } from "../replay-writer/tick-line.js";
import { processTick } from "./index.js";
import { createEventCollector, type Event } from "./events.js";
import type {
  GameState,
  Player,
  PlayerIndex,
  Site,
  Terrain,
  Unit,
  UnitType,
} from "../world/state.js";

/** 规则集取值与 `rulesets/v1.json` 同形;代码里**不许**出现那些数字(no-float 门禁同样扫测试)。 */
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

const RULESET_VIEW = loadRuleset(RULESET);

const PLAIN: Terrain = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => false));

const player = (index: PlayerIndex): Player => ({
  index,
  resources: 16,
  alive: true,
  exceptionTicks: 0,
});

const unit = (
  id: number,
  owner: PlayerIndex,
  type: UnitType,
  x: number,
  y: number,
  hp: number,
): Unit => ({ id, owner, type, x, y, hp, carrying: 0 });

const base = (id: number, owner: Site["owner"], x: number, y: number): Site => ({
  id,
  kind: "base",
  x,
  y,
  owner,
  progressOwner: -1,
  progress: 0,
  producing: null,
});

const withProgress = (site: Site, progressOwner: Site["owner"], progress: number): Site => ({
  ...site,
  progressOwner,
  progress,
});

const withProduction = (site: Site, type: UnitType, remainingTicks: number): Site => ({
  ...site,
  producing: { type, remainingTicks },
});

const makeState = (parts: {
  readonly units?: readonly Unit[];
  readonly sites?: readonly Site[];
  readonly tick?: number;
}): GameState => ({
  tick: parts.tick ?? 0,
  size: 8,
  terrain: PLAIN,
  players: [0, 1, 2, 3].map((index) => player(index as PlayerIndex)),
  units: parts.units ?? [],
  sites: parts.sites ?? [],
  nextId: 100,
  outcome: null,
  // 四席都在,无人被淘汰。
  eliminatedAtTick: [null, null, null, null],
  // 四席都还没发过 `economy-dead`(票 07 的事件闩,与 `firstContactTick` 同性质、不进 `Snapshot`)。
  economyDeadAtTick: [null, null, null, null],
  // null:让本文件那条多 tick 构造自己触发 first-contact,而不是被夹具预先抹掉。
  firstContactTick: null,
});

const NO_SINK: TickSink = { write: () => {} };

/** 严格的数值 id 升序。用它而不是「排序后比较」——后者对重复 id 也会放行。 */
const expectStrictlyAscending = (ids: readonly number[], what: string): void => {
  for (let at = 1; at < ids.length; at += 1) {
    expect(ids[at], `${what} 的第 ${String(at)} 项必须严格大于前一项`).toBeGreaterThan(
      ids[at - 1]!,
    );
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// §3.1 反向钉:乱序的单位数组产生不同的 stateHash
// §3.2 正向钉:键序不同 → 哈希相同;数组已升序 → 与直接计算逐字相同
// ═══════════════════════════════════════════════════════════════════════════════

it("反向钉:乱序的单位数组产生**不同**的 stateHash(不变量被破坏这件事必须可见)", () => {
  // 这条用例的存在理由:`stateHashOf` 的规范化是「对象键升序、**数组保序**」——它**不替你重排**。
  // 于是「状态维护违反了 units 的 id 升序不变量」这件事**必须**表现为哈希变化;否则复算那条路
  // (同一状态两次算出同一哈希)就看不见它,那条不变量等于不存在。它同时经写出路径
  // (`buildTickLine` 算 stateHash)与 `stateHashOf` 原语两处钉,是因为写出路径上任何一次
  // 「发出前顺手排一下」都会把违规掩盖掉——那正是这条用例要拦住的那类改动。
  const ordered = makeState({
    units: [
      unit(1, 0, "worker", 1, 0, 2),
      unit(2, 0, "melee", 2, 0, 12),
      unit(3, 0, "worker", 3, 0, 2),
    ],
  });
  const shuffled: GameState = {
    ...ordered,
    units: [ordered.units[2]!, ordered.units[0]!, ordered.units[1]!],
  };

  // 经写出路径:写出前排序会把两者拉平 → 这一条红。
  expect(buildTickLine(shuffled, []).stateHash).not.toBe(buildTickLine(ordered, []).stateHash);
  // 经原语(保序不做重排):`stateHashOf` 顺手重排会让两者相等 → 这一条红。
  expect(stateHashOf(shuffled)).not.toBe(stateHashOf(ordered));
});

it("正向钉:对象键书写顺序不同 → 哈希**逐字相同**(键那半在重排)", () => {
  // 与上一条合起来才说明两半各管一件事:键序被忽略(键升序在重排),数组序被保留(数组不重排)。
  // 改什么会红:把 `canonicalJsonOf` 的对象分支去掉 `.sort(...)`,这一条当场红。
  const ordered = makeState({
    units: [unit(1, 0, "worker", 1, 0, 2)],
    sites: [base(7, 1, 5, 5)],
  });
  const reordered: GameState = {
    firstContactTick: ordered.firstContactTick,
    eliminatedAtTick: ordered.eliminatedAtTick,
    economyDeadAtTick: ordered.economyDeadAtTick,
    outcome: ordered.outcome,
    nextId: ordered.nextId,
    sites: ordered.sites.map((site) => ({
      producing: site.producing,
      progress: site.progress,
      progressOwner: site.progressOwner,
      owner: site.owner,
      y: site.y,
      x: site.x,
      kind: site.kind,
      id: site.id,
      ...(site.remaining === undefined ? {} : { remaining: site.remaining }),
    })),
    units: ordered.units.map((item) => ({
      carrying: item.carrying,
      hp: item.hp,
      y: item.y,
      x: item.x,
      type: item.type,
      owner: item.owner,
      id: item.id,
    })),
    players: ordered.players.map((item) => ({
      exceptionTicks: item.exceptionTicks,
      alive: item.alive,
      resources: item.resources,
      index: item.index,
    })),
    terrain: ordered.terrain,
    size: ordered.size,
    tick: ordered.tick,
  };
  expect(stateHashOf(reordered)).toBe(stateHashOf(ordered));
});

it("正向钉:数组已按 id 升序 → 哈希与「不重排的直接计算」逐字相同", () => {
  // 「数组那半确实没重排」的正向面:对一个本就升序的数组,哈希等于直接照原样算的那一份。
  // 与 §3.1 的反向钉配对——反向钉说「乱序会变」,这一条说「升序是固定点,原语没替你打乱也没替你重排」。
  const state = makeState({
    units: [unit(1, 0, "worker", 1, 0, 2), unit(2, 0, "melee", 2, 0, 12)],
    sites: [base(7, -1, 5, 5)],
  });
  const byHand: JsonValue = {
    type: "tick",
    tick: state.tick,
    players: state.players,
    units: state.units,
    sites: state.sites,
    events: [],
  };
  expect(buildTickLine(state, []).stateHash).toBe(stateHashOf(byHand));
});

// ═══════════════════════════════════════════════════════════════════════════════
// §3.3 状态里的对象数组每 tick 结束按数值 id 升序(断言对象是状态本身)
// §3.4 同一构造两次 → 事件流逐项相同
// §3.6(端到端)两处易主同 tick → 事件仍按 id 排
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 一个 tick 里同时发生**新建 + 移动 + 死亡 + 易主**的构造,连跑多 tick。
 *
 * - 新建:基地 11 的产线本 tick 归零、出兵格空 → `create-unit`(新号 100,插在末尾);
 * - 移动:座位 2 的单位 4 每 tick 右移一格;
 * - 死亡:单位 3(近战)打死单位 5(农民);
 * - 易主:点位 3 与 7(原主 1)同 tick 被座位 0 的驱动者占领到阈值 → 一起易主。
 *
 * 另外在建初始态时经唯一写入口插一个 id 夹在中间的**点位**(9,位于 7 与 11 之间):
 * 点位号来自地图、引擎不重编号,所以「按中间号插入」是真实可能发生的顺序扰动。少了它,
 * 单位新号恒为最大(只追加到末尾),把有序插入改成追加也测不出来。加上它之后,
 * 「`insertById` 改成追加到末尾」→ 点位表变成 [3,7,11,13,9] → §3.3 断言红(实测见票的 `## Answer`)。
 */
const RICH_UNITS: readonly Unit[] = [
  unit(1, 0, "worker", 2, 2, 2),
  unit(2, 0, "worker", 5, 5, 2),
  unit(3, 0, "melee", 0, 0, 12),
  unit(4, 2, "worker", 0, 6, 2),
  unit(5, 1, "worker", 1, 0, 2),
];

const RICH_SITES: readonly Site[] = [
  withProgress(base(3, 1, 2, 2), 0, RULESET.captureTicks - 1),
  withProgress(base(7, 1, 5, 5), 0, RULESET.captureTicks - 1),
  withProduction(base(11, 2, 0, 7), "worker", 1),
  base(13, 3, 7, 0),
];

const richState = (): GameState => {
  const seeded = makeState({ units: RICH_UNITS, sites: RICH_SITES });
  // 中间号点位经唯一写入口插入:序号 9 落在 7 与 11 之间(有序插入的真实用途)。
  return apply(seeded, RULESET, {
    kind: "create-site",
    id: 9,
    siteKind: "base",
    x: 4,
    y: 4,
    owner: -1,
  });
};

const richRunners = () => [
  stubRunner(() => [{ kind: "attack", unitId: 3, targetId: 5 }]),
  stubRunner(() => []),
  stubRunner(() => [{ kind: "move", unitId: 4, dx: 1, dy: 0 }]),
  stubRunner(() => []),
];

const runRich = (ticks: number) => {
  let state = richState();
  const events: (readonly Event[])[] = [];
  const states: GameState[] = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    const result = processTick(state, richRunners(), RULESET_VIEW, NO_SINK);
    events.push(result.events);
    states.push(result.state);
    state = result.state;
  }
  return { events, states };
};

it("状态本身(不是发出的行)每 tick 结束都按数值 id 升序——新建+移动+死亡+易主同 tick,连跑多 tick", () => {
  // 断言对象是 `result.state` 的 `units` / `sites`,**不是**写出的那一行:后者会在写出路径上
  // 被「发出前排一次」掩盖(thl tick-line.ts 的 `stateHash` 取的是状态本身,但写出行另有一份数组)。
  // 改什么会红:`insertById` 改成追加到末尾 → 插入的中间号点位 9 落到队尾 → 这一条红。
  const { states } = runRich(3);
  expect(states).toHaveLength(3);
  for (const state of states) {
    expectStrictlyAscending(
      state.units.map((item) => item.id),
      "state.units",
    );
    expectStrictlyAscending(
      state.sites.map((item) => item.id),
      "state.sites",
    );
  }
  // 构造确实跑了四件事:新号 100 出生、单位 5 死亡、两个点位易主。
  const last = states[states.length - 1]!;
  expect(last.units.map((item) => item.id)).toContain(100);
  expect(last.units.some((item) => item.id === 5)).toBe(false);
  expect(last.sites.find((site) => site.id === 3)?.owner).toBe(0);
  expect(last.sites.find((site) => site.id === 7)?.owner).toBe(0);
});

it("同一构造跑两次 → 事件流逐项相同(种类、顺序、主体数值 id 都相同)", () => {
  // 事件流按「产出它的那一步 → 步内按对象数值 id 升序」定全序;若某处改成按插入序,
  // 同一局重跑就会得到逐项不同的事件序列,而复算与叙事战报都读这一列。
  // 改什么会红:把收集器 `events()` 去掉定序直接交(见票 `## Answer` 的实测),或让某一步
  // 先把事件排好再 push——后者会让「同一 tick 同类事件」的稳定序依赖实现自由度。
  const first = runRich(3);
  const second = runRich(3);
  expect(second.events).toEqual(first.events);
  expect(first.events[0]).toContainEqual({ kind: "site-captured", subjectId: 3 });
  expect(first.events[0]).toContainEqual({ kind: "site-captured", subjectId: 7 });
  expect(first.events[0]).toContainEqual({ kind: "unit-destroyed", subjectId: 5 });
  expect(first.events[0]).toContainEqual({ kind: "player-eliminated", subjectId: 1 });
});

it("两处易主同 tick → 事件按点位数值 id 升序(回归护栏;它区分不了 id 序与登记序)", () => {
  // 票面建议的这条端到端用例照写:它是一条有效的回归护栏(易主事件确实按 id 排)。
  //
  // 但**它区分不了**「按 id 定序」与「按登记序」:步 4 的 a) 段按 `state.sites` 的次序遍历,
  // 而 `state.sites` 已由 §3.3 的不变量保证升序,于是两个易主的登记序本来就等于 id 升序。
  // 真正能区分两者的用例在收集器那一层(见下一条直接登记)。这里如实标注,不假装它证明了更多。
  const { events } = runRich(1);
  const captures = (events[0] ?? []).filter((event) => event.kind === "site-captured");
  expect(captures).toEqual([
    { kind: "site-captured", subjectId: 3 },
    { kind: "site-captured", subjectId: 7 },
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// §3.6(收集器层)按对象数值 id 升序,而不是按登记序
// ═══════════════════════════════════════════════════════════════════════════════

it("收集器层:同一主体域内按数值 id 升序交,登记序被推翻(这一步才真的区分两种定序)", () => {
  // 直接以「登记序与 id 序相反」的次序调具名方法——这是端到端构造到不了的位置。
  // 改什么会红:把 `events()` 改成直接按登记序交(去掉 `sort(byOrder)`)。
  const sites = createEventCollector();
  sites.siteCaptured(7);
  sites.siteCaptured(3);
  expect(sites.events()).toEqual([
    { kind: "site-captured", subjectId: 3 },
    { kind: "site-captured", subjectId: 7 },
  ]);

  // 跨主体同理(单位域):大 id 先登记,小 id 仍先出。
  const units = createEventCollector();
  units.unitDestroyed(9);
  units.unitDestroyed(2);
  expect(units.events()).toEqual([
    { kind: "unit-destroyed", subjectId: 2 },
    { kind: "unit-destroyed", subjectId: 9 },
  ]);

  // 玩家级主体取 `playerIndex`:座位 3 先登记,座位 0 仍先出。
  const players = createEventCollector();
  players.playerEliminated(3);
  players.playerEliminated(0);
  expect(players.events()).toEqual([
    { kind: "player-eliminated", subjectId: 0 },
    { kind: "player-eliminated", subjectId: 3 },
  ]);

  // 跨步:步号是第一排序键,它压过主体 id——步 4 的点位事件即便主体 id 更小,也排在步 3 之后。
  const crossStep = createEventCollector();
  crossStep.siteCaptured(1); // 步 4
  crossStep.unitDestroyed(9); // 步 3
  expect(crossStep.events()).toEqual([
    { kind: "unit-destroyed", subjectId: 9 },
    { kind: "site-captured", subjectId: 1 },
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// §3.5 定序规则的实现位置只有一处(收集器),七步不许绕过它直接改数组
// ═══════════════════════════════════════════════════════════════════════════════

it("七步各只往收集器调具名方法:steps/*.ts 里没有任何 push / unshift / splice", () => {
  // 定序规则的实现位置**只有一处**(`events.ts` 的收集器,其头注就是那条规则)。
  // 任何一步绕过它直接往数组里 push / unshift / splice,规则就多出一条旁路,而那条旁路
  // 在端到端用例里看不出来(它只在「同一 tick 同类同主体」这种罕见序上才现形)。
  // 先例:`production.test.ts` 读 `script-surface.ts` 抽 `ERR_*` 名字做机械断言。
  const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
  const stepsDir = here("./steps");
  const files = readdirSync(stepsDir).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
  // 八步各一个文件;文件数忽然变了要先有人看一眼,而不是让下面的循环静默空转。
  expect(files).toHaveLength(8);
  for (const name of files) {
    // 去注释再断言:头注里写着「不允许某一步随手往数组里 push」,那句话本身不该被误判。
    const code = readFileSync(`${stepsDir}/${name}`, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // 出口只有收集器的具名方法与 `events()`;直接改数组的三种写法一律不许出现。
    expect(code, `${name} 不许往事件数组里 push / unshift / splice`).not.toMatch(
      /\.push\(|\.unshift\(|\.splice\(/,
    );
  }
});
