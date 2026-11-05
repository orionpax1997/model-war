/**
 * 引擎的三条跨模块不变量:资源总账、占领轨道、标识分配。
 *
 * ── 为什么走处理器原语,而不引整局夹具 ──
 *
 * 三条命题量的是「状态在相邻两个 tick 之间怎么变」,不是「一局跑完结果对不对」。`processTick`
 * 是处理器自己的内部缝(见 `processor/index.ts` 头注),它把 0–7 步一次跑完,于是每一条命题都在
 * **真管线**上判:采集、交付、下单、推进、出兵、占领、易主退款七种转移各走各的模块,只要有一个
 * 把方向或量算错,判据就红。整局夹具(`runMatch` + 沙箱 + 冻结脚本)买不到这条覆盖面:它给的是
 * 端到端对局结果,而属性测试要在 30s 内跑上百个场景。每个场景的「脚本」都是普通 TS 函数经
 * `stubRunner` 接进缝里(ADR-0005),文件里不出现任何脚本文本。
 *
 * ── 一、资源总账逐 tick 单调不增 ──
 *
 * 总账 = 可读资源 + 在建投入(`ledgerOf`):
 *   - 可读资源 = Σ `players[].resources` + Σ `units[].carrying` + Σ 资源点的 `remaining`;
 *   - 在建投入 = Σ 每条产线订单的**造价**(`statsOf(producing.type).cost`,不是 `remainingTicks`)。
 * 按「这笔资源此刻归谁」把七种转移分三类:
 *   - **内部转移**(总账不变):采集(矿的储量 → 单位携带)、交付(携带 → 玩家池)、
 *     下单(玩家池 → 在建投入)。第三条同样是搬动:钱变成「还没变成东西的投入」,仍在账上。
 *   - **净流出**(总账减少):订单离开在建而**没有**回到玩家池——出兵(那笔钱变成单位,而单位只按
 *     携带量计值)与作废(点位回归中立那条路取消订单、不退款)。
 *   - **返还**(总账不变,金额精确):易主取消订单时原额退还原主(在建 → 玩家池)。
 * 判据是三条(`ledgerBreaches`):总账不增;净减额不超过同 tick 在建变小过的那些产线的全部投入;
 * 玩家池的每一笔进账都必须有同 tick 的内部来源。
 *
 * ── 二、占领轨道 ──
 *
 * 点位上的 `progress` / `progressOwner` 是一条状态机(家是 gdd §3.2,实现在 `capture.ts`):
 * 进度有界在 `0..captureTicks`;「进度非零」等价于「轨道有主」(`progressOwner !== -1`);
 * 换主(驱动者换了座位)即从 1 重计、无侵蚀;易主那一刻进度与轨道属主一起清零,且新主正是
 * 站在点位上的那一位。
 *
 * ── 三、标识分配 ──
 *
 * `nextId` 是全局单调递增的分配器,号不回收(hld §4.1/§4.6)。判据:本 tick 出现的每个新对象号都
 * 严格大于此前已发号的最大值、且从未出现过;`nextId` 越过已发号最大值且从不后退。
 *
 * ── 每条属性都配「生成器自证」与「翻脸用例」 ──
 *
 * 一条属性可能恒真,有两种成因,正文各有一条自证:
 *
 * 1. **生成器退化了**:只长出「什么都不发生」的输入,于是「什么都不违例」与命题无关。每条属性
 *    后面都有一条 `fc.sample` 自证,断言样本里真的出现会被该命题检出的形态(总账真的下降过、
 *    进度真的非零过、id 真的增长过)。自证用**固定种子**:它要的是稳定证据,不是每次换个样本;
 *    随机种子会让它就为了「这一次抽到的样本不够花哨」而红,那种红毫无信息。
 * 2. **判据恒真**:判据里某个条件永远成立,于是它从不翻脸。每条属性后面都有一条翻脸用例:
 *    在**真实结算出来的状态**上把其中一笔转移改反(扣款改成加款、交付只清携带量不入池、
 *    进度写成负数、换主沿用旧进度、新对象复用旧号),或者直接造一个违反不变量的点位 / 状态,
 *    再喂给**同一个判据函数**,断言它报出那条具体的规则 id。翻脸用例一行生产代码都不改,
 *    它证明的是「判据会红」——于是正向那条「不红」才有内容。
 */

import fc from "fast-check";
import { expect, it } from "vitest";
import type { Ruleset } from "@model-war/replay";

import { loadRuleset, type RulesetView } from "../ruleset-loader/index.js";
import { stubRunner, type StubStrategy } from "../runner/stub.js";
import type { SeatRunner } from "../runner/index.js";
import { captureDriverAt } from "./capture.js";
import { processTick } from "./index.js";
import type { Intent } from "./intents.js";
import type {
  GameState,
  Owner,
  PlayerIndex,
  Site,
  SiteKind,
  Snapshot,
  Unit,
  UnitType,
} from "../world/state.js";

/** 规则集取值与 `rulesets/v1.json` 同形;判据里一律从这份视图读,不出现那些数字。 */
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

/** 占领阈值的上界,从规则集读;判据里不出现字面量。 */
const CAPTURE_TICKS = RULESET.captureTicks;

/** 携带上限,从规则集读(生成携带量用它收边)。 */
const CARRY_LIMIT = RULESET.carryLimit;

const SEATS: readonly PlayerIndex[] = [0, 1, 2, 3];

const BOARD = 8;

const plain = (size: number): readonly (readonly boolean[])[] =>
  Array.from({ length: size }, () => Array.from({ length: size }, () => false));

const SINK = { write: () => {} };

const unit = (
  id: number,
  owner: PlayerIndex,
  type: UnitType,
  x: number,
  y: number,
  carrying = 0,
): Unit => ({ id, owner, type, x, y, hp: 4, carrying });

const site = (id: number, kind: SiteKind, x: number, y: number, owner: Owner): Site => ({
  id,
  kind,
  x,
  y,
  owner,
  progressOwner: -1,
  progress: 0,
  producing: null,
});

const base = (id: number, x: number, y: number, owner: Owner): Site =>
  site(id, "base", x, y, owner);

const resourceSite = (id: number, x: number, y: number, owner: Owner, remaining: number): Site => ({
  ...site(id, "resource", x, y, owner),
  remaining,
});

const withTrack = (point: Site, progressOwner: Owner, progress: number): Site => ({
  ...point,
  progressOwner,
  progress,
});

const withOrder = (point: Site, type: UnitType, remainingTicks: number): Site => ({
  ...point,
  producing: { type, remainingTicks },
});

/**
 * 四个座位各一个哨兵单位,外加一个中立点位:把步 5 的淘汰、「全点位归属」与「捷径」三条终局
 * 判定堵在门外,于是场景只观测自己要观测的机制。哨兵站在角落,不参与任何场景的几何。
 */
const PADDING_UNITS: readonly Unit[] = [
  unit(90, 0, "melee", 6, 6),
  unit(91, 1, "melee", 6, 7),
  unit(92, 2, "melee", 7, 6),
  unit(93, 3, "melee", 7, 7),
];

const PADDING_SITE = base(99, 0, 0, -1);

type StateParts = {
  readonly units: readonly Unit[];
  readonly sites: readonly Site[];
  /** 四席的初始资源池;省略即 16(与 `initialResources` 同量级)。 */
  readonly resources?: readonly number[];
};

const stateOf = ({ units, sites, resources }: StateParts): GameState => ({
  tick: 0,
  size: BOARD,
  terrain: plain(BOARD),
  players: SEATS.map((index) => ({
    index,
    resources: resources?.[index] ?? 16,
    alive: true,
    exceptionTicks: 0,
  })),
  units: [...units].sort((left, right) => left.id - right.id),
  sites: [...sites].sort((left, right) => left.id - right.id),
  nextId: 100,
  outcome: null,
  eliminatedAtTick: [null, null, null, null],
  // 非 null:首触事件不参与本文件的任何命题,把它钉成「已发生」免得它挤进状态变化。
  firstContactTick: 0,
  economyDeadAtTick: [null, null, null, null],
});

/** 一条不变量违规。规则 id 给断言认,细节给人读。 */
type Breach = {
  readonly rule: string;
  readonly detail: string;
};

/**
 * 沿一串逐 tick 状态跑一遍判据。违规文案带上「这次转移是哪两个 tick 之间」,否则一条红的判据
 * 只能告诉你在某处坏了。
 */
const violationsAlong = (
  states: readonly GameState[],
  check: (before: GameState, after: GameState) => readonly Breach[],
): readonly string[] => {
  const found: string[] = [];
  for (let index = 1; index < states.length; index += 1) {
    const before = states[index - 1];
    const after = states[index];
    if (before === undefined || after === undefined) {
      continue;
    }
    for (const breach of check(before, after)) {
      found.push(`${String(before.tick)}→${String(after.tick)}:${breach.rule}(${breach.detail})`);
    }
  }
  return found;
};

/**
 * 跑 N 个 tick,返回**含初态**的逐 tick 状态。
 *
 * 只有座位 0 参赛(座位 1..3 每 tick 交回空数组):三条不变量与「谁下的单」无关,而四面脚本
 * 会让每个场景的状态解释起来更贵。执行器每 tick 重新武装(`setSnapshot`),所以一份执行器数组
 * 可以跨 tick 复用。
 */
const tickStatesOf = (
  initial: GameState,
  strategy: StubStrategy,
  ticks: number,
): readonly GameState[] => {
  const runners: readonly SeatRunner[] = SEATS.map((seat) =>
    stubRunner((snapshot) => (seat === 0 ? strategy(snapshot) : [])),
  );
  const states: GameState[] = [initial];
  let state = initial;
  for (let index = 0; index < ticks; index += 1) {
    state = processTick(state, runners, RULESET_VIEW, SINK).state;
    states.push(state);
  }
  return states;
};

type Transition = {
  readonly before: GameState;
  readonly after: GameState;
};

/**
 * 固定场景里找出第一条满足条件的转移(翻脸用例从真实结算出来的状态出发,而不是自己编一对)。
 * 找不到就是夹具与生产行为已经分叉,直接抛——静默跳过等于让翻脸用例悄悄失效。
 */
const findTransition = (
  states: readonly GameState[],
  matches: (before: GameState, after: GameState) => boolean,
): Transition => {
  for (let index = 1; index < states.length; index += 1) {
    const before = states[index - 1];
    const after = states[index];
    if (before !== undefined && after !== undefined && matches(before, after)) {
      return { before, after };
    }
  }
  throw new Error("固定场景里没有出现预期的转移:夹具与生产行为已经分叉");
};

const resourcesOf = (state: GameState, seat: PlayerIndex): number =>
  state.players.find((player) => player.index === seat)?.resources ?? 0;

const withResources = (state: GameState, seat: PlayerIndex, resources: number): GameState => ({
  ...state,
  players: state.players.map((player) =>
    player.index === seat ? { ...player, resources } : player,
  ),
});

// ── 一、资源总账 ──────────────────────────────────────────────────────────────

/** 总账及其三栏构成。分成四栏是为了让违规细节能说清「哪一栏对不上」。 */
type Ledger = {
  readonly playerPool: number;
  readonly carrying: number;
  readonly remaining: number;
  readonly inFlight: number;
  /** 可读资源 = 玩家池 + 携带量 + 矿的储量。 */
  readonly readable: number;
  /** 总账 = 可读资源 + 在建投入。 */
  readonly total: number;
};

/** 一条产线订单的造价;没有订单即 0。退款额与这里的算法是同一条(`costOf`)。 */
const inFlightCostOf = (point: Site, ruleset: RulesetView): number =>
  point.producing === null ? 0 : ruleset.statsOf(point.producing.type).cost;

const ledgerOf = (state: GameState, ruleset: RulesetView): Ledger => {
  const playerPool = state.players.reduce((sum, player) => sum + player.resources, 0);
  const carrying = state.units.reduce((sum, held) => sum + held.carrying, 0);
  const remaining = state.sites.reduce((sum, point) => sum + (point.remaining ?? 0), 0);
  const inFlight = state.sites.reduce((sum, point) => sum + inFlightCostOf(point, ruleset), 0);
  const readable = playerPool + carrying + remaining;
  return { playerPool, carrying, remaining, inFlight, readable, total: readable + inFlight };
};

/**
 * 本 tick「在建变小过」的每一条产线的**出手前全部投入**。
 *
 * 为什么取全部投入而不是差额:同一 tick 里一条产线的订单可能先完成、又接下新单(易主之后新主
 * 在同一 tick 下单),按差额算会把「完成释出的 8」减成「4」,于是净减 8 看起来无法解释。
 * 取全部投入是对净减额的安全上界——净减额本身仍由上面的等式逐栏算,不会因此放松。
 */
const releasedInFlight = (before: GameState, after: GameState, ruleset: RulesetView): number => {
  let released = 0;
  for (const point of before.sites) {
    const costBefore = inFlightCostOf(point, ruleset);
    if (costBefore === 0) {
      continue;
    }
    const next = after.sites.find((candidate) => candidate.id === point.id);
    const costAfter = next === undefined ? 0 : inFlightCostOf(next, ruleset);
    if (costAfter < costBefore) {
      released += costBefore;
    }
  }
  return released;
};

/**
 * 资源总账的三条判据。空数组 = 这一次转移是合法的。
 *
 * 1. `ledger-increased`:总账不得增加。方向算反的扣款、只加携带量不减矿、交付出池却不减携带量,
 *    都会让这一条红。
 * 2. `decrease-unexplained`:净减额不得超过同 tick 释放的在建投入。资源凭空消失(交付只清携带量
 *    不入池、采集只减矿不加携带量)只在这里露头。
 * 3. `player-gain-unbacked`:玩家池的每一笔进账都必须有同 tick 的内部来源。交付从携带量来、
 *    退款从在建投入来——超出这个数的进账就是凭空印钱。
 */
const ledgerBreaches = (
  before: GameState,
  after: GameState,
  ruleset: RulesetView,
): readonly Breach[] => {
  const from = ledgerOf(before, ruleset);
  const to = ledgerOf(after, ruleset);
  const dropped = from.total - to.total;
  const released = releasedInFlight(before, after, ruleset);
  const gained = to.playerPool - from.playerPool;
  const internalDrain =
    from.carrying - to.carrying + (from.remaining - to.remaining) + (from.inFlight - to.inFlight);
  const breaches: Breach[] = [];
  if (dropped < 0) {
    breaches.push({
      rule: "ledger-increased",
      detail: `总账 ${String(from.total)}→${String(to.total)}`,
    });
  }
  if (dropped > released) {
    breaches.push({
      rule: "decrease-unexplained",
      detail: `净减 ${String(dropped)} > 在建释出 ${String(released)}`,
    });
  }
  if (gained > 0 && internalDrain < gained) {
    breaches.push({
      rule: "player-gain-unbacked",
      detail: `玩家池进账 ${String(gained)} > 内部释出 ${String(internalDrain)}`,
    });
  }
  return breaches;
};

type LedgerAction = "idle" | "harvest" | "transfer" | "spawn";

type LedgerScenario = {
  /** 四席同一初始资源池(只判总额,不判是谁的)。 */
  readonly resources: number;
  readonly mineRemaining: number;
  readonly carrying: number;
  /** 占领基地上那条订单的兵种:它决定退款额(= 该兵种的造价)。 */
  readonly orderType: UnitType;
  /** 占领基地上那条订单的剩余 tick。 */
  readonly orderTicks: number;
  /** 座位 0 下单时产的兵种。 */
  readonly spawnType: UnitType;
  readonly progressOwner: Owner;
  readonly progress: number;
  /** 每 tick 座位 0 交回的那一条 intent。 */
  readonly schedule: readonly LedgerAction[];
};

const LEDGER_WORKER_ID = 10;
const LEDGER_SIEGER_ID = 11;
const LEDGER_ORDER_BASE_ID = 30;
const LEDGER_MINE_ID = 31;
const LEDGER_CAPTURE_BASE_ID = 32;

/**
 * 场景的几何:农民(2,2)贴着矿(2,3)与自家基地(3,2);座位 1 的兵站在座位 0 的基地(5,5)上,
 * 而那条基地上挂着一条订单——占领到点那一刻,订单按原额退给原主(座位 0)。四笔转移因此都在
 * 一张盘上:采集、交付、下单/出兵、易主退款。
 */
const ledgerInitialState = (scenario: LedgerScenario): GameState =>
  stateOf({
    resources: [scenario.resources, 16, 16, 16],
    units: [
      unit(LEDGER_WORKER_ID, 0, "worker", 2, 2, scenario.carrying),
      unit(LEDGER_SIEGER_ID, 1, "worker", 5, 5),
      ...PADDING_UNITS,
    ],
    sites: [
      base(LEDGER_ORDER_BASE_ID, 3, 2, 0),
      resourceSite(LEDGER_MINE_ID, 2, 3, 0, scenario.mineRemaining),
      withOrder(
        withTrack(base(LEDGER_CAPTURE_BASE_ID, 5, 5, 0), scenario.progressOwner, scenario.progress),
        scenario.orderType,
        scenario.orderTicks,
      ),
      PADDING_SITE,
    ],
  });

/** 一条动作翻译成一条 intent。`idle` 是「本 tick 什么都不交」。 */
const ledgerIntents = (action: LedgerAction, spawnType: UnitType): readonly Intent[] => {
  if (action === "harvest") {
    return [{ kind: "harvest", unitId: LEDGER_WORKER_ID, siteId: LEDGER_MINE_ID }];
  }
  if (action === "transfer") {
    return [{ kind: "transfer", unitId: LEDGER_WORKER_ID }];
  }
  if (action === "spawn") {
    return [{ kind: "spawnUnit", baseId: LEDGER_ORDER_BASE_ID, unitType: spawnType }];
  }
  return [];
};

const ledgerStatesOf = (scenario: LedgerScenario): readonly GameState[] =>
  tickStatesOf(
    ledgerInitialState(scenario),
    (snapshot) => ledgerIntents(scenario.schedule[snapshot.tick] ?? "idle", scenario.spawnType),
    scenario.schedule.length,
  );

const ledgerAction = fc.constantFrom<LedgerAction>("idle", "harvest", "transfer", "spawn");

/**
 * 进度初值偏向阈值附近:否则 10 个 tick 内很少真的走到「易主 → 退款」,而那条转移恰恰是本命题
 * 要覆盖的「返还」一支。轨道自洽(无主 ⇔ 进度 0)由 `map` 收边:不从「引擎永远不会产生的轨道」
 * 出发,判据就不会在第一天红。
 */
const ledgerScenario: fc.Arbitrary<LedgerScenario> = fc
  .record({
    resources: fc.integer({ min: 0, max: 40 }),
    mineRemaining: fc.integer({ min: 0, max: 30 }),
    carrying: fc.integer({ min: 0, max: CARRY_LIMIT }),
    orderType: fc.constantFrom<UnitType>("worker", "melee", "ranged"),
    orderTicks: fc.integer({ min: 0, max: RULESET.melee.spawnTicks }),
    spawnType: fc.constantFrom<UnitType>("worker", "melee", "cavalry"),
    progressOwner: fc.constantFrom<Owner>(-1, 1),
    progress: fc.constantFrom(0, 1, CAPTURE_TICKS - 2, CAPTURE_TICKS - 1),
    schedule: fc.array(ledgerAction, { minLength: 2, maxLength: 10 }),
  })
  .map((raw) => ({
    ...raw,
    progress: raw.progressOwner === -1 ? 0 : Math.max(1, raw.progress),
  }));

it("资源总账逐 tick 单调不增:采集与交付是内部转移、下单进在建、出兵与作废才净减", () => {
  fc.assert(
    fc.property(ledgerScenario, (scenario) => {
      const states = ledgerStatesOf(scenario);
      expect(
        violationsAlong(states, (before, after) => ledgerBreaches(before, after, RULESET_VIEW)),
      ).toEqual([]);
    }),
    { numRuns: 120 },
  );
});

/** 逐 tick 总账序列上的形态读数,给下面那条自证用。 */
type LedgerFacts = {
  readonly inFlightSeen: boolean;
  readonly dropped: boolean;
  readonly refunded: boolean;
  readonly internalShift: boolean;
};

const ledgerFactsOf = (states: readonly GameState[]): LedgerFacts => {
  let inFlightSeen = false;
  let dropped = false;
  let refunded = false;
  let internalShift = false;
  for (let index = 1; index < states.length; index += 1) {
    const before = states[index - 1];
    const after = states[index];
    if (before === undefined || after === undefined) {
      continue;
    }
    const from = ledgerOf(before, RULESET_VIEW);
    const to = ledgerOf(after, RULESET_VIEW);
    inFlightSeen ||= to.inFlight > 0;
    dropped ||= to.total < from.total;
    refunded ||= to.playerPool > from.playerPool && to.inFlight < from.inFlight;
    internalShift ||=
      to.total === from.total && (to.carrying !== from.carrying || to.remaining !== from.remaining);
  }
  return { inFlightSeen, dropped, refunded, internalShift };
};

/**
 * 自证一:**生成器真的长出了会动的那几种形态**。若它只会生成「什么都不发生」的场景,上面那条
 * 「逐 tick 不违例」就与命题无关了。固定种子:这里要的是稳定证据(见文件头注)。
 */
it("生成器自证:样本里总账真的动过——有在建投入、有净减、有退款、也有内部搬动", () => {
  const samples = fc.sample(ledgerScenario, { numRuns: 60, seed: 2_026_1001 });
  const facts = samples.map((scenario) => ledgerFactsOf(ledgerStatesOf(scenario)));
  expect(
    facts.some((fact) => fact.inFlightSeen),
    "没有一个样本出现过在建投入:下单/退款那一支没被覆盖",
  ).toBe(true);
  expect(
    facts.some((fact) => fact.dropped),
    "没有一个样本的总账下降过:出兵与作废那一支没被覆盖",
  ).toBe(true);
  expect(
    facts.some((fact) => fact.refunded),
    "没有一个样本出现过退款:易主取消订单那一支没被覆盖",
  ).toBe(true);
  expect(
    facts.some((fact) => fact.internalShift),
    "没有一个样本出现过采集/交付的内部搬动",
  ).toBe(true);
});

/**
 * 固定场景(不随种子变):采集、交付、下单、出兵各一次,翻脸用例从它的真实转移上取料。
 * 订单剩余 tick 取 1,是为了让那张基地从第一 tick 起就挂在「到点待出兵」的挂起位上,
 * 把输出留给座位 0 的基地。
 */
const LEDGER_FLIP_SCENARIO: LedgerScenario = {
  resources: 16,
  mineRemaining: 10,
  carrying: 3,
  orderType: "worker",
  orderTicks: 1,
  spawnType: "worker",
  progressOwner: -1,
  progress: 0,
  schedule: ["idle", "harvest", "transfer", "spawn", "idle", "idle"],
};

/**
 * 翻脸一:**把生产扣款改成加款**。真实转移里付款方少了 `cost`;把它写成「入账 `cost`」,
 * 总账就该涨。若判据不认这条,`ledger-increased` 永远不发——那么「总账不增」在退化的判据下也绿。
 */
it("翻脸:把扣款写成加款,总账必须变红", () => {
  const states = ledgerStatesOf(LEDGER_FLIP_SCENARIO);
  const paid = findTransition(
    states,
    (before, after) =>
      ledgerOf(after, RULESET_VIEW).inFlight > ledgerOf(before, RULESET_VIEW).inFlight,
  );
  const cost = RULESET_VIEW.statsOf(LEDGER_FLIP_SCENARIO.spawnType).cost;
  // 真实 after 里是 `before - cost`;改成 `before + cost`,即这笔钱凭空生出两倍。
  const flipped = withResources(paid.after, 0, resourcesOf(paid.before, 0) + cost);
  expect(flipped).not.toEqual(paid.after);
  expect(ledgerBreaches(paid.before, flipped, RULESET_VIEW).map((breach) => breach.rule)).toContain(
    "ledger-increased",
  );
});

/**
 * 翻脸二:**把交付算成净流出**——携带量照常清零,资源却没进玩家池。净减额 4 没有任何在建释出
 * 可以解释,`decrease-unexplained` 必须响。
 */
it("翻脸:交付只清携带量不入池,净减必须变红", () => {
  const states = ledgerStatesOf(LEDGER_FLIP_SCENARIO);
  const delivered = findTransition(
    states,
    (before, after) =>
      ledgerOf(after, RULESET_VIEW).playerPool > ledgerOf(before, RULESET_VIEW).playerPool,
  );
  // 玩家池退回交付前的样子:携带量已清零,于是这一笔资源既不在手上也不在池里。
  const flipped = withResources(delivered.after, 0, resourcesOf(delivered.before, 0));
  expect(flipped).not.toEqual(delivered.after);
  expect(
    ledgerBreaches(delivered.before, flipped, RULESET_VIEW).map((breach) => breach.rule),
  ).toContain("decrease-unexplained");
});

/**
 * 翻脸三:**交付入了池,携带量却没清**。总账因此上涨,而且玩家池这笔进账没有同 tick 的内部来源
 * ——`player-gain-unbacked` 必须响。
 */
it("翻脸:交付入池但不清携带量,进账必须变红", () => {
  const states = ledgerStatesOf(LEDGER_FLIP_SCENARIO);
  const delivered = findTransition(
    states,
    (before, after) =>
      ledgerOf(after, RULESET_VIEW).playerPool > ledgerOf(before, RULESET_VIEW).playerPool,
  );
  const carried =
    delivered.before.units.find((held) => held.id === LEDGER_WORKER_ID)?.carrying ?? 0;
  // 只把携带量还回去:资源同时出现在玩家池与手上,等于凭空多出一份。
  const flipped: GameState = {
    ...delivered.after,
    units: delivered.after.units.map((held) =>
      held.id === LEDGER_WORKER_ID ? { ...held, carrying: carried } : held,
    ),
  };
  expect(flipped).not.toEqual(delivered.after);
  expect(
    ledgerBreaches(delivered.before, flipped, RULESET_VIEW).map((breach) => breach.rule),
  ).toContain("player-gain-unbacked");
});

// ── 二、占领轨道 ──────────────────────────────────────────────────────────────

/**
 * 占领轨道的六条判据。空数组 = 这条轨道这一次转移是合法的。
 *
 * 1. `progress-out-of-range`:进度必须落在 `0..captureTicks`。
 * 2. `progress-without-track`:进度非零却没有轨道属主。
 * 3. `track-without-progress`:轨道有主却进度为零(半截状态:两种内部表示换着来,回放要靠猜)。
 * 4. `track-switch-not-reset`:换主必须从 1 重计,不许沿用上一位驱动者的进度(无侵蚀)。
 * 5. `capture-not-cleared`:易主那一刻进度与轨道属主必须一起清零。
 * 6. `capture-not-by-driver`:易主只能给站在该点位上的那一位(`captureDriverAt` 是驻守者的唯一来源)。
 */
const captureBreaches = (
  before: Site,
  after: Site,
  unitsAfter: readonly Unit[],
  captureTicks: number,
): readonly Breach[] => {
  const breaches: Breach[] = [];
  if (after.progress < 0 || after.progress > captureTicks) {
    breaches.push({
      rule: "progress-out-of-range",
      detail: `进度 ${String(after.progress)} 越出 0..${String(captureTicks)}`,
    });
  }
  if (after.progress > 0 && after.progressOwner === -1) {
    breaches.push({
      rule: "progress-without-track",
      detail: `进度 ${String(after.progress)} 但轨道无主`,
    });
  }
  if (after.progress <= 0 && after.progressOwner !== -1) {
    breaches.push({
      rule: "track-without-progress",
      detail: `轨道属主 ${String(after.progressOwner)} 但进度 ${String(after.progress)}`,
    });
  }
  if (
    before.progressOwner !== -1 &&
    after.progressOwner !== -1 &&
    before.progressOwner !== after.progressOwner &&
    after.progress !== 1
  ) {
    breaches.push({
      rule: "track-switch-not-reset",
      detail: `换主 ${String(before.progressOwner)}→${String(after.progressOwner)} 后进度 ${String(after.progress)}`,
    });
  }
  if (after.owner !== before.owner) {
    if (after.progress !== 0 || after.progressOwner !== -1) {
      breaches.push({
        rule: "capture-not-cleared",
        detail: `易主后进度 ${String(after.progress)}、轨道属主 ${String(after.progressOwner)}`,
      });
    }
    const driver = captureDriverAt(after, unitsAfter);
    if (after.owner !== -1 && driver !== after.owner) {
      breaches.push({
        rule: "capture-not-by-driver",
        detail: `易主给 ${String(after.owner)},驻守者 ${String(driver)}`,
      });
    }
  }
  return breaches;
};

type CaptureScenario = {
  readonly kind: SiteKind;
  readonly owner: Owner;
  readonly progressOwner: Owner;
  readonly progress: number;
  /** 站在点位格上的驱动者座位。 */
  readonly driverSeat: PlayerIndex;
  /** 在 (3,2) 待命的接手者座位,与驱动者不同。 */
  readonly reliefSeat: PlayerIndex;
  /** 是否让驱动者先离开、接手者再进来(这一步只走 2 tick,故需要 3 个 tick 以上)。 */
  readonly rotate: boolean;
  readonly ticks: number;
};

const CAPTURE_SITE_ID = 40;
const CAPTURE_DRIVER_UNIT_ID = 10;
const CAPTURE_RELIEF_UNIT_ID = 11;

/** `number % 4` 收边成 `PlayerIndex`:座位号是编号,不是参数,所以这里允许出现四个字面量。 */
const seatOf = (value: number): PlayerIndex => {
  const normalized = ((value % 4) + 4) % 4;
  return normalized === 0 ? 0 : normalized === 1 ? 1 : normalized === 2 ? 2 : 3;
};

const captureInitialState = (scenario: CaptureScenario): GameState => {
  const point =
    scenario.kind === "base"
      ? base(CAPTURE_SITE_ID, 3, 3, scenario.owner)
      : resourceSite(CAPTURE_SITE_ID, 3, 3, scenario.owner, RULESET.resourcePerSite);
  return stateOf({
    units: [
      unit(CAPTURE_DRIVER_UNIT_ID, scenario.driverSeat, "melee", 3, 3),
      unit(CAPTURE_RELIEF_UNIT_ID, scenario.reliefSeat, "worker", 3, 2),
      ...PADDING_UNITS,
    ],
    sites: [withTrack(point, scenario.progressOwner, scenario.progress), PADDING_SITE],
  });
};

const captureStrategy =
  (scenario: CaptureScenario): StubStrategy =>
  (snapshot) => {
    if (!scenario.rotate) {
      return [];
    }
    // 驱动者先走开(此刻接手者还占着自己的格子),下一 tick 接手者才能进来——占位裁决以
    // 「这一 tick 开始时的占位」为准,交换不可能在一个 tick 里完成。
    if (snapshot.tick === 0) {
      return [{ kind: "move", unitId: CAPTURE_DRIVER_UNIT_ID, dx: -1, dy: 0 }];
    }
    if (snapshot.tick === 1) {
      return [{ kind: "move", unitId: CAPTURE_RELIEF_UNIT_ID, dx: 0, dy: 1 }];
    }
    return [];
  };

const captureStatesOf = (scenario: CaptureScenario): readonly GameState[] =>
  tickStatesOf(captureInitialState(scenario), captureStrategy(scenario), scenario.ticks);

/** 逐个点位(含哨兵点位)检查轨道;哨兵点位永远不动,正好是最便宜的那条正向断言。 */
const captureViolationsAlong = (states: readonly GameState[]): readonly string[] =>
  violationsAlong(states, (before, after) => {
    const found: Breach[] = [];
    for (const point of after.sites) {
      const previous = before.sites.find((candidate) => candidate.id === point.id);
      if (previous === undefined) {
        continue;
      }
      found.push(...captureBreaches(previous, point, after.units, CAPTURE_TICKS));
    }
    return found;
  });

const captureScenario: fc.Arbitrary<CaptureScenario> = fc
  .record({
    kind: fc.constantFrom<SiteKind>("base", "resource"),
    owner: fc.constantFrom<Owner>(-1, 0, 1, 2),
    progressOwner: fc.constantFrom<Owner>(-1, 0, 1, 2, 3),
    progress: fc.constantFrom(0, 1, 3, CAPTURE_TICKS - 2, CAPTURE_TICKS - 1),
    driverSeat: fc.constantFrom<PlayerIndex>(0, 1, 2, 3),
    reliefOffset: fc.integer({ min: 1, max: 3 }),
    rotate: fc.boolean(),
    ticks: fc.integer({ min: 3, max: 14 }),
  })
  .map((raw) => ({
    kind: raw.kind,
    owner: raw.owner,
    progressOwner: raw.progressOwner,
    progress: raw.progressOwner === -1 ? 0 : Math.max(1, raw.progress),
    driverSeat: raw.driverSeat,
    reliefSeat: seatOf(raw.driverSeat + raw.reliefOffset),
    rotate: raw.rotate,
    ticks: raw.ticks,
  }));

it("占领轨道:进度有界、进度非零等价于有主、换主从 1 重计、易主清零且只给驻守者", () => {
  fc.assert(
    fc.property(captureScenario, (scenario) => {
      expect(captureViolationsAlong(captureStatesOf(scenario))).toEqual([]);
    }),
    { numRuns: 120 },
  );
});

type CaptureFacts = {
  readonly advanced: boolean;
  readonly switched: boolean;
  readonly captured: boolean;
  readonly cleared: boolean;
};

const captureFactsOf = (states: readonly GameState[]): CaptureFacts => {
  let advanced = false;
  let switched = false;
  let captured = false;
  let cleared = false;
  for (let index = 1; index < states.length; index += 1) {
    const before = states[index - 1];
    const after = states[index];
    if (before === undefined || after === undefined) {
      continue;
    }
    const previous = before.sites.find((point) => point.id === CAPTURE_SITE_ID);
    const next = after.sites.find((point) => point.id === CAPTURE_SITE_ID);
    if (previous === undefined || next === undefined) {
      continue;
    }
    advanced ||= next.progress > 0;
    switched ||= previous.progressOwner !== next.progressOwner && next.progressOwner !== -1;
    captured ||= previous.owner !== next.owner;
    cleared ||= previous.owner !== next.owner && next.progress === 0 && next.progressOwner === -1;
  }
  return { advanced, switched, captured, cleared };
};

/**
 * 自证二:样本里**进度真的非零过、真的换过主、真的易过主并清零过**。否则「轨道不违例」可能只是
 * 因为演算从未离开 0 进度。
 */
it("生成器自证:样本里进度真的非零、真的换主、真的易主并清零", () => {
  const samples = fc.sample(captureScenario, { numRuns: 60, seed: 2_026_1002 });
  const facts = samples.map((scenario) => captureFactsOf(captureStatesOf(scenario)));
  expect(
    facts.some((fact) => fact.advanced),
    "没有一个样本的进度非零过",
  ).toBe(true);
  expect(
    facts.some((fact) => fact.switched),
    "没有一个样本换过主:转轨重计那一支没被覆盖",
  ).toBe(true);
  expect(
    facts.some((fact) => fact.captured),
    "没有一个样本易主过:阈值那一支没被覆盖",
  ).toBe(true);
  expect(
    facts.some((fact) => fact.cleared),
    "易主后清零那一支没被覆盖",
  ).toBe(true);
});

/** 翻脸用例的底座:一个静止的点位与「没人站在上面」的单位表。 */
const QUIET_SITE = base(CAPTURE_SITE_ID, 3, 3, 0);

/**
 * 翻脸一:**进度写成负数**。轨道属主不动、只把进度改成负的——`progress-out-of-range` 必须响。
 */
it("翻脸:进度写成负数必须变红", () => {
  const before = withTrack(QUIET_SITE, 1, CAPTURE_TICKS - 2);
  const flipped = withTrack(QUIET_SITE, 1, -1);
  expect(
    captureBreaches(before, flipped, [], CAPTURE_TICKS).map((breach) => breach.rule),
  ).toContain("progress-out-of-range");
});

/**
 * 翻脸二:**无主仍有进度**(把清零只做了一半:进度清了、属主没清,或反过来)。
 */
it("翻脸:无主仍有进度必须变红", () => {
  const before = withTrack(QUIET_SITE, 1, 3);
  const flipped = withTrack(QUIET_SITE, -1, 3);
  expect(
    captureBreaches(before, flipped, [], CAPTURE_TICKS).map((breach) => breach.rule),
  ).toContain("progress-without-track");
  const halfCleared = withTrack(QUIET_SITE, 1, 0);
  expect(
    captureBreaches(before, halfCleared, [], CAPTURE_TICKS).map((breach) => breach.rule),
  ).toContain("track-without-progress");
});

/**
 * 翻脸三:**换主沿用旧进度**(转轨重计改成「接着往下数」)。
 */
it("翻脸:换主沿用旧进度必须变红", () => {
  const before = withTrack(QUIET_SITE, 0, CAPTURE_TICKS - 3);
  const flipped = withTrack(QUIET_SITE, 2, CAPTURE_TICKS - 2);
  expect(
    captureBreaches(before, flipped, [], CAPTURE_TICKS).map((breach) => breach.rule),
  ).toContain("track-switch-not-reset");
});

/**
 * 翻脸四:**易主但不清零**;翻脸五:**易主给不在点位上的那个座位**。两条都只改一处,
 * 分别打中 `capture-not-cleared` 与 `capture-not-by-driver`。
 */
it("翻脸:易主不清零、易主给不在点位上的座位,各自必须变红", () => {
  const before = withTrack(base(CAPTURE_SITE_ID, 3, 3, 0), 1, CAPTURE_TICKS - 1);
  const captured = withTrack(base(CAPTURE_SITE_ID, 3, 3, 1), -1, 0);
  const driver = unit(CAPTURE_DRIVER_UNIT_ID, 1, "melee", 3, 3);
  // 正向:改对的那一次不违例——否则下面的「翻脸必红」可能来自判据恒红。
  expect(captureBreaches(before, captured, [driver], CAPTURE_TICKS)).toEqual([]);

  const notCleared = withTrack(base(CAPTURE_SITE_ID, 3, 3, 1), 1, CAPTURE_TICKS - 1);
  expect(
    captureBreaches(before, notCleared, [driver], CAPTURE_TICKS).map((breach) => breach.rule),
  ).toContain("capture-not-cleared");

  const wrongOwner = withTrack(base(CAPTURE_SITE_ID, 3, 3, 2), -1, 0);
  expect(
    captureBreaches(before, wrongOwner, [driver], CAPTURE_TICKS).map((breach) => breach.rule),
  ).toContain("capture-not-by-driver");
});

// ── 三、标识分配 ──────────────────────────────────────────────────────────────

/** 状态里的全部对象号。点位的号来自地图,单位的号来自分配器——两条都在同一个 id 空间里。 */
const idsOf = (state: GameState): readonly number[] => [
  ...state.units.map((held) => held.id),
  ...state.sites.map((point) => point.id),
];

/** 每个号出现了几次。用重数而不是集合:复用旧号会让某个号在同一个状态里出现两次。 */
const idCountsOf = (state: GameState): ReadonlyMap<number, number> => {
  const counts = new Map<number, number>();
  for (const id of idsOf(state)) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
};

const maxOf = (ids: Iterable<number>): number => {
  let max = Number.NEGATIVE_INFINITY;
  for (const id of ids) {
    max = Math.max(max, id);
  }
  return max;
};

/**
 * 标识分配的五条判据。`everIssued` 是**此前出现过**的全部号(含已消失的对象),所以「号不回收」
 * 与「严格递增」由同一个集合判:
 *
 * 1. `id-reused`:本 tick 的新对象用了一个曾经发过的号。
 * 2. `id-not-increasing`:新对象号没有严格大于已发号最大值。
 * 3. `id-duplicated`:本 tick 结束时同一个号出现在两个对象上(全局 id 空间破了,
 *    `getObjectById` 就有两个候选)。
 * 4. `id-allocator-behind`:`nextId` 没有越过已发号最大值 —— 下一个对象会撞号。
 * 5. `id-allocator-regressed`:`nextId` 比上一 tick 小。
 *
 * 「新对象」按**重数**判,不按集合:同一个号在 after 里比 before 里多出现几次,就是这一 tick 新发
 * 了几个号。按集合判会漏掉整类退化——复用旧号时那个号本来就在 before 里活着。
 */
const idBreaches = (
  before: GameState,
  after: GameState,
  everIssued: ReadonlySet<number>,
): readonly Breach[] => {
  const breaches: Breach[] = [];
  const beforeCounts = idCountsOf(before);
  const afterCounts = idCountsOf(after);
  const maxIssued = maxOf(everIssued);
  for (const [id, count] of afterCounts) {
    const fresh = count - (beforeCounts.get(id) ?? 0);
    for (let issued = 0; issued < fresh; issued += 1) {
      if (everIssued.has(id)) {
        breaches.push({ rule: "id-reused", detail: `新对象拿到旧号 ${String(id)}` });
      }
      if (id <= maxIssued) {
        breaches.push({
          rule: "id-not-increasing",
          detail: `新对象号 ${String(id)} ≤ 已发号最大值 ${String(maxIssued)}`,
        });
      }
    }
    if (count > 1) {
      breaches.push({
        rule: "id-duplicated",
        detail: `号 ${String(id)} 同时挂到 ${String(count)} 个对象上`,
      });
    }
  }
  if (after.nextId <= maxIssued) {
    breaches.push({
      rule: "id-allocator-behind",
      detail: `nextId ${String(after.nextId)} ≤ 已发号最大值 ${String(maxIssued)}`,
    });
  }
  if (after.nextId < before.nextId) {
    breaches.push({
      rule: "id-allocator-regressed",
      detail: `nextId ${String(before.nextId)}→${String(after.nextId)}`,
    });
  }
  return breaches;
};

type IdScenario = {
  /** 参战的基地数(1..3):每个基地一条产线,产线只在上面的单位走开之后才能再下一单。 */
  readonly baseCount: number;
  /** 每个基地产什么。兵种不同 → `spawnTicks` 不同 → 出世落在不同 tick 上。 */
  readonly types: readonly [UnitType, UnitType, UnitType];
  readonly resources: number;
  readonly ticks: number;
};

const ID_BASE_IDS = [50, 51, 52];
const ID_BASE_CELLS = [
  { x: 1, y: 4 },
  { x: 3, y: 4 },
  { x: 5, y: 4 },
];

const idInitialState = (scenario: IdScenario): GameState =>
  stateOf({
    resources: [scenario.resources, 16, 16, 16],
    units: [...PADDING_UNITS],
    sites: [
      ...ID_BASE_CELLS.slice(0, scenario.baseCount).map((cell, index) =>
        base(ID_BASE_IDS[index] ?? 0, cell.x, cell.y, 0),
      ),
      PADDING_SITE,
    ],
  });

const STEPS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
] as const;

/** 从某个单位脚下挑一步空位。挑不到就原地待着(移动失败,不尝试次优目标)。 */
const freeStepFrom = (
  snapshot: Snapshot,
  held: Unit,
): { readonly dx: -1 | 0 | 1; readonly dy: -1 | 0 | 1 } | null => {
  for (const step of STEPS) {
    const x = held.x + step.dx;
    const y = held.y + step.dy;
    if (x < 0 || y < 0 || x >= snapshot.size || y >= snapshot.size) {
      continue;
    }
    if (snapshot.units.some((other) => other.x === x && other.y === y)) {
      continue;
    }
    return step;
  }
  return null;
};

/**
 * 参赛脚本:产线空着就下单(出兵格空着是前提,与 `production.ts` 给脚本的写法建议一致),
 * 站在自己基地上的单位先走开——走开之后产线才能再收一单。于是 N 个 tick 里对象号会一批一批地发。
 */
const idStrategy =
  (scenario: IdScenario): StubStrategy =>
  (snapshot) => {
    const intents: Intent[] = [];
    for (const point of snapshot.sites) {
      const index = ID_BASE_IDS.indexOf(point.id);
      if (point.kind !== "base" || point.owner !== 0 || point.producing !== null) {
        continue;
      }
      if (index < 0 || index >= scenario.baseCount) {
        continue;
      }
      if (snapshot.units.some((held) => held.x === point.x && held.y === point.y)) {
        continue;
      }
      intents.push({
        kind: "spawnUnit",
        baseId: point.id,
        unitType: scenario.types[index] ?? "worker",
      });
    }
    for (const held of snapshot.units) {
      if (held.owner !== 0) {
        continue;
      }
      const onBase = snapshot.sites.some(
        (point) => point.x === held.x && point.y === held.y && point.kind === "base",
      );
      if (!onBase) {
        continue;
      }
      const step = freeStepFrom(snapshot, held);
      if (step !== null) {
        intents.push({ kind: "move", unitId: held.id, dx: step.dx, dy: step.dy });
      }
    }
    return intents;
  };

const idStatesOf = (scenario: IdScenario): readonly GameState[] =>
  tickStatesOf(idInitialState(scenario), idStrategy(scenario), scenario.ticks);

const idViolationsAlong = (states: readonly GameState[]): readonly string[] => {
  const found: string[] = [];
  for (let index = 1; index < states.length; index += 1) {
    const before = states[index - 1];
    const after = states[index];
    if (before === undefined || after === undefined) {
      continue;
    }
    const everIssued = new Set(states.slice(0, index).flatMap(idsOf));
    for (const breach of idBreaches(before, after, everIssued)) {
      found.push(`${String(before.tick)}→${String(after.tick)}:${breach.rule}(${breach.detail})`);
    }
  }
  return found;
};

const unitType = fc.constantFrom<UnitType>("worker", "melee", "cavalry");

const idScenario: fc.Arbitrary<IdScenario> = fc.record({
  baseCount: fc.integer({ min: 1, max: 3 }),
  types: fc.tuple(unitType, unitType, unitType),
  resources: fc.constantFrom(16, 32, 48),
  ticks: fc.integer({ min: 4, max: 12 }),
});

it("标识单调递增且不复用:新对象号严格大于已发号最大值,nextId 从不后退", () => {
  fc.assert(
    fc.property(idScenario, (scenario) => {
      expect(idViolationsAlong(idStatesOf(scenario))).toEqual([]);
    }),
    { numRuns: 80 },
  );
});

/**
 * 自证三:样本里**真的在发号**——总数够多、跨多个 tick、且全批不重复。若生成器退化成「一个都
 * 生不出来」,上面那条就变成了「没有新对象就没有违规」。
 */
it("生成器自证:样本里真的发出了新号,且跨多个 tick 一批批发", () => {
  const samples = fc.sample(idScenario, { numRuns: 40, seed: 2_026_1003 });
  const runs = samples.map((scenario) => {
    const states = idStatesOf(scenario);
    const issued: number[] = [];
    let ticksWithCreations = 0;
    for (let index = 1; index < states.length; index += 1) {
      const before = states[index - 1];
      const after = states[index];
      if (before === undefined || after === undefined) {
        continue;
      }
      const known = new Set(idsOf(before));
      const fresh = idsOf(after).filter((id) => !known.has(id));
      if (fresh.length > 0) {
        ticksWithCreations += 1;
        issued.push(...fresh);
      }
    }
    return { issued, ticksWithCreations };
  });
  // 每个样本都从同一份初态出发(号从 100 起),所以「同一批样本之间」本来就会重号;
  // 这里要证的是**单个样本内部**的号不重复,以及样本里真的在发号。
  for (const run of runs) {
    expect(new Set(run.issued).size, "同一个样本里发出了重复的号").toBe(run.issued.length);
  }
  expect(
    runs.filter((run) => run.issued.length > 0).length,
    "半数以上的样本一个新对象都没造出来",
  ).toBeGreaterThanOrEqual(samples.length / 2);
  expect(
    runs.some((run) => run.ticksWithCreations >= 3),
    "没有一个样本在 3 个以上 tick 里各发过一批号:分配器只被推了一步",
  ).toBe(true);
});

/** 固定场景(不随种子变):一个基地连产,足够让翻脸用例拿到一对真实的「新对象」转移。 */
const ID_FLIP_SCENARIO: IdScenario = {
  baseCount: 1,
  types: ["worker", "melee", "cavalry"],
  resources: 32,
  ticks: 6,
};

const renumberUnit = (state: GameState, from: number, to: number): GameState => ({
  ...state,
  units: state.units.map((held) => (held.id === from ? { ...held, id: to } : held)),
});

/** 翻脸用例的取料点:第一条「造出了新对象」的真实转移,外加当时的已发号集合。 */
const firstCreation = (
  states: readonly GameState[],
): {
  readonly before: GameState;
  readonly after: GameState;
  readonly created: number;
  readonly maxIssued: number;
} => {
  for (let index = 1; index < states.length; index += 1) {
    const before = states[index - 1];
    const after = states[index];
    if (before === undefined || after === undefined) {
      continue;
    }
    const known = new Set(idsOf(before));
    const fresh = idsOf(after).filter((id) => !known.has(id));
    const created = fresh[0];
    if (created === undefined) {
      continue;
    }
    const everIssued = new Set(states.slice(0, index).flatMap(idsOf));
    return { before, after, created, maxIssued: maxOf(everIssued) };
  }
  throw new Error("固定场景里没有造出任何新对象:夹具与生产行为已经分叉");
};

/**
 * 翻脸一:**新对象复用旧号**。把刚造出来的那个对象的号改成哨兵单位的号 90——它曾经发过,
 * 判据必须报 `id-reused`。
 */
it("翻脸:新对象复用旧号必须变红", () => {
  const creation = firstCreation(idStatesOf(ID_FLIP_SCENARIO));
  const flipped = renumberUnit(creation.after, creation.created, 90);
  expect(flipped).not.toEqual(creation.after);
  expect(
    idBreaches(creation.before, flipped, new Set(idsOf(creation.before))).map(
      (breach) => breach.rule,
    ),
  ).toContain("id-reused");
});

/**
 * 翻脸二:**新号不严格递增**。把新对象的号压到已发号的最大值上(不越界、不倒退,只是不再增长)。
 */
it("翻脸:新号不严格大于已发号最大值必须变红", () => {
  const creation = firstCreation(idStatesOf(ID_FLIP_SCENARIO));
  const flipped = renumberUnit(creation.after, creation.created, creation.maxIssued);
  expect(flipped).not.toEqual(creation.after);
  expect(
    idBreaches(creation.before, flipped, new Set(idsOf(creation.before))).map(
      (breach) => breach.rule,
    ),
  ).toContain("id-not-increasing");
});

/**
 * 翻脸三:**分配器没抬升 / 抬升后退回**。两种坏法分别打中 `id-allocator-behind` 与
 * `id-allocator-regressed`。
 */
it("翻脸:nextId 没越过已发号最大值、nextId 回退,各自必须变红", () => {
  const creation = firstCreation(idStatesOf(ID_FLIP_SCENARIO));
  const everIssued = new Set(idsOf(creation.before));
  const behind: GameState = { ...creation.after, nextId: creation.maxIssued };
  expect(idBreaches(creation.before, behind, everIssued).map((breach) => breach.rule)).toContain(
    "id-allocator-behind",
  );
  const regressed: GameState = { ...creation.after, nextId: creation.maxIssued - 1 };
  expect(idBreaches(creation.before, regressed, everIssued).map((breach) => breach.rule)).toContain(
    "id-allocator-regressed",
  );
});
