/**
 * 生产(票 06,gdd §5《基地与生产》):每基地一条产线、下单即占线扣款、资金不足无效、
 * 重复下单静默丢弃、每 tick 推进、归零出兵、出兵格被占挂起、易主取消并全额退款给原主。
 *
 * 每条用例在注释里写明「改什么会让它红」;四条关键反例(校验与扣款调换、挂起改成换格出兵、
 * 易主退款改成不退、重复下单改成覆盖订单并再扣一次款)的实测读数记在票的 `## Answer` 里。
 *
 * ── 「没有产线忙这个错误码」怎么钉 ──
 *
 * 重复下单是**静默丢弃**,不是错误。错误码的真源是 `packages/schema` 的注入面目录
 * (`script-surface.ts` 的 `SANDBOX_INJECTED_API_SYMBOL_CATALOG`),而引擎包只能经 `replay`
 * 看到类型面、看不到那张运行时表——所以下面那一条用例**直接读那份真源**,抽出全部带引号的
 * `ERR_*` 名字,断言其中不含任何与产线 / 队列 / 基地忙有关的码。谁哪天给 `spawnUnit` 加一个
 * `ERR_BASE_BUSY`,这一条当场变红(那一码是明确**不收**的,理由见该文件头注)。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import type { Ruleset } from "@model-war/replay";

import { loadRuleset } from "../ruleset-loader/index.js";
import { stubRunner } from "../runner/stub.js";
import { processTick } from "./index.js";
import type { Intent } from "./intents.js";
import type {
  GameState,
  Owner,
  PlayerIndex,
  Site,
  SiteProduction,
  Unit,
  UnitType,
} from "../world/state.js";

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

const unit = (id: number, owner: PlayerIndex, type: UnitType, x: number, y: number): Unit => ({
  id,
  owner,
  type,
  x,
  y,
  hp: 4,
  carrying: 0,
});

const site = (
  id: number,
  kind: Site["kind"],
  x: number,
  y: number,
  owner: Owner,
  producing: SiteProduction | null = null,
): Site => ({
  id,
  kind,
  x,
  y,
  owner,
  progressOwner: -1,
  progress: 0,
  producing,
});

const base = (id: number, x: number, y: number, owner: Owner): Site =>
  site(id, "base", x, y, owner);

const resourceSite = (id: number, x: number, y: number, owner: Owner): Site =>
  site(id, "resource", x, y, owner);

/** 给基地一条已有订单(基准状态用;推进与出兵由引擎做)。 */
const withProduction = (baseSite: Site, type: UnitType, remainingTicks: number): Site => ({
  ...baseSite,
  producing: { type, remainingTicks },
});

/** 把一条占领轨道挂在点位上(易主用例用)。 */
const withProgress = (baseSite: Site, progressOwner: Owner, progress: number): Site => ({
  ...baseSite,
  progressOwner,
  progress,
});

const makeState = (
  units: readonly Unit[],
  sites: readonly Site[],
  options: {
    readonly tick?: number;
    readonly resources?: Partial<Record<PlayerIndex, number>>;
    readonly alive?: Partial<Record<PlayerIndex, boolean>>;
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
  // 与 `players[].alive` 一起派生,免得夹具里出现「已出局却没有淘汰时刻」这种真实引擎
  // 不会产生的中间态——`eliminate-player` 是一条变更同时写两面的(见 apply.ts 那条注释)。
  eliminatedAtTick: [0, 1, 2, 3].map((index) =>
    (options.alive?.[index as PlayerIndex] ?? true) ? null : (options.tick ?? 0),
  ),
  // 默认非 null:这些用例不该被「首触」事件干扰(战斗用例的同一条处置)。
  firstContactTick: 0,
});

/**
 * 一个**不产生终局**的夹具底座:一个中立副点位 + 座位 3 的一支占位部队。
 *
 * 票 09 之后步 5 会**正当**判出终局,而下面三条用例把座位 0 那一格隔出来看、并对 `events`
 * 整表断言,于是那些终局事件会挤进来:
 * - 单点位图上,谁占了那唯一的点位就满足 gdd《胜利与淘汰》的「控制地图上全部点位」——多一个
 *   中立副点位之后它不成立;
 * - 只剩一个座位有单位时又触发捷径条款——座位 3 留一支部队之后它不成立。
 * 剩下的缺口在两席显式标成早已出局(无单位、无基地、`alive=false`,与刚被淘汰的那一刻逐字一致),
 * 步 5 开头就 `continue`。于是事件流里只剩生产自己产生的那一条。
 *
 * 不传这两样的用例不受影响:它们的夹具同样留空几席,但不整表断言 `events`。
 * 号不与任何夹具对象重:全局 id 空间只有一个(票 08)。
 */
const DECOY_SITE = resourceSite(9, 3, 3, -1);
const HOLDER = unit(60, 3, "worker", 7, 7);

const SINK = { write: () => {} };

/** 按座位给四份策略(`undefined` 的座位交回空数组)。 */
const runners = (bySeat: readonly (readonly Intent[])[]) =>
  [0, 1, 2, 3].map((seat) => stubRunner(() => bySeat[seat] ?? []));

const step = (
  state: GameState,
  bySeat: readonly (readonly Intent[])[],
  ruleset = loadRuleset(RULESET),
) => processTick(state, runners(bySeat), ruleset, SINK);

const spawn = (baseId: number, unitType: UnitType): Intent => ({
  kind: "spawnUnit",
  baseId,
  unitType,
});

it("玩家级意图不参与「每单位只留最后一个」:同一玩家对两个基地各下一单,两单都落地", () => {
  const result = step(makeState([], [base(4, 1, 1, 0), base(7, 3, 3, 0)]), [
    [spawn(4, "worker"), spawn(7, "worker")],
    [],
    [],
    [],
  ]);
  // 两单各自占住一条产线,谁也不顶替谁。
  // 反例:若 spawnUnit 被当成单位级意图按 id 分组,只会剩一单 → 两个断言里必有一个红。
  expect(result.state.sites[0]!.producing).toEqual({ type: "worker", remainingTicks: 1 });
  expect(result.state.sites[1]!.producing).toEqual({ type: "worker", remainingTicks: 1 });
  // 两单各扣一次 worker 造价(4+4);下单那一 tick 也吃一次推进,故 remainingTicks 是 spawnTicks-1。
  expect(result.state.players[0]!.resources).toBe(16 - 4 - 4);
});

it("多基地 = 并行产能:各基地队列独立推进,互不影响", () => {
  const result = step(
    makeState(
      [],
      [withProduction(base(4, 1, 1, 0), "worker", 2), withProduction(base(7, 3, 3, 0), "melee", 4)],
    ),
    [[], [], [], []],
  );
  // 两条队列各自减一;把「全局一条队列」写成覆盖式推进,这两条必有一条红。
  expect(result.state.sites[0]!.producing).toEqual({ type: "worker", remainingTicks: 1 });
  expect(result.state.sites[1]!.producing).toEqual({ type: "melee", remainingTicks: 3 });
});

it("下单先校验资金、校验过才扣款:资金恰好等于造价时能下单", () => {
  const result = step(makeState([], [base(5, 1, 1, 0)], { resources: { 0: 4 } }), [
    [spawn(5, "worker")],
    [],
    [],
    [],
  ]);
  // 恰好等于 cost(4)能下单:从 4 扣到 0,队列占上。
  expect(result.state.sites[0]!.producing).toEqual({ type: "worker", remainingTicks: 1 });
  expect(result.state.players[0]!.resources).toBe(0);
});

it("资金不足:这一单无效——不占队列、不扣款、资金一个不少,且不抛错误码", () => {
  const result = step(
    makeState([HOLDER], [base(5, 1, 1, 0), DECOY_SITE], {
      resources: { 0: 3 },
      alive: { 1: false, 2: false },
    }),
    [[spawn(5, "worker")], [], [], []],
  );
  // 「校验推进、扣款退后」的反例(先扣再判)会让资金变成 -1、或先占上队列 → 这两条红。
  expect(result.state.sites[0]!.producing).toBeNull();
  expect(result.state.players[0]!.resources).toBe(3);
  // 只看向座位 0:这一单没成就不该凭空多出一个属于它的单位。
  expect(result.state.units.filter((item) => item.owner === 0)).toEqual([]);
  // 静默丢弃:不发事件、不计异常(八种事件里没有「意图无效」这一类)。
  expect(result.events).toEqual([]);
});

it("产线已有订单时重复下单:静默丢弃——不扣款、队列不变(仍是原来那单)", () => {
  const result = step(
    makeState([HOLDER], [withProduction(base(5, 1, 1, 0), "melee", 4), DECOY_SITE], {
      alive: { 1: false, 2: false },
    }),
    [[spawn(5, "worker")], [], [], []],
  );
  // 新下的是 worker,但队列里还是原来的 melee(被本 tick 正常推进到 3):类型没被覆盖。
  expect(result.state.sites[0]!.producing).toEqual({ type: "melee", remainingTicks: 3 });
  // 重复的那一单没有扣款。
  expect(result.state.players[0]!.resources).toBe(16);
  expect(result.events).toEqual([]);
});

it("同 tick 对同一基地连下两单:只成第一单,第二单静默丢弃(一条产线一次只有一个订单)", () => {
  const result = step(makeState([], [base(5, 1, 1, 0)]), [
    [spawn(5, "melee"), spawn(5, "melee")],
    [],
    [],
    [],
  ]);
  // 两单都过了步 1(步 1 只看 tick 开始的产线,那时是空的);落子时第二单看到队列已占 → 丢弃。
  expect(result.state.sites[0]!.producing).toEqual({ type: "melee", remainingTicks: 3 });
  // 只扣了一次 melee 造价(8)。
  expect(result.state.players[0]!.resources).toBe(16 - 8);
});

it("错误码表里没有「产线忙」这一码:重复下单不是错误而是静默丢弃", () => {
  // 错误码真源在真源包(引擎包看不到那张运行时表),直接读它、抽出全部带引号的 ERR_ 名字。
  const source = readFileSync(
    fileURLToPath(new URL("../../../../packages/schema/src/script-surface.ts", import.meta.url)),
    "utf8",
  );
  const codes = [...source.matchAll(/"ERR_[A-Z_]+"/g)].map((match) => match[0].slice(1, -1));
  // 抽到的是真源里那张表上的名字(不是注释里的字样):表里确有码,且不是空表。
  expect(codes).toContain("ERR_NOT_ENOUGH_RESOURCES");
  // 断言「不含任何与产线/队列/基地忙有关的码」:谁哪天加了 `ERR_BASE_BUSY`,这一条当场变红。
  // 那一码是**明确不收**的(见 script-surface.ts 头注):重复下单不是错误,队列忙不忙由快照的
  // `site.producing` 供给,不该让模型去 `isError` 一个它其实不该问的东西。
  expect(codes.filter((code) => /BUSY|QUEUE|PRODUC|BASE/.test(code))).toEqual([]);
});

it("资源点不是产线:给资源点下单无效(gdd §5「任何己方控制的基地都是产线」)", () => {
  const result = step(makeState([], [resourceSite(9, 1, 1, 0)]), [
    [spawn(9, "worker")],
    [],
    [],
    [],
  ]);
  // 「kind 不判、任何点位都当产线」的反例:这里会占上、扣款 → 两条断言红。
  expect(result.state.sites[0]!.producing).toBeNull();
  expect(result.state.players[0]!.resources).toBe(16);
});

it("只能给自己的基地下单:敌方 / 中立的基地都无效", () => {
  const enemy = base(6, 1, 1, 1);
  const neutral = base(8, 3, 3, -1);
  const result = step(makeState([], [enemy, neutral]), [
    [spawn(6, "worker"), spawn(8, "worker")],
    [],
    [],
    [],
  ]);
  // 「属主正确」那一条的反例:不判属主会占上敌方/中立基地并扣款。
  expect(result.state.sites[0]!.producing).toBeNull();
  expect(result.state.sites[1]!.producing).toBeNull();
  expect(result.state.players[0]!.resources).toBe(16);
});

it("每 tick 推进:剩余 tick 减一;归零那一 tick 出兵并清空队列(出兵格=基地格本身)", () => {
  let state = makeState([], [withProduction(base(5, 2, 2, 0), "worker", 2)]);
  state = step(state, [[], [], [], []]).state;
  // 第 1 tick:减一,还没出兵。
  expect(state.sites[0]!.producing).toEqual({ type: "worker", remainingTicks: 1 });
  expect(state.units).toEqual([]);

  const done = step(state, [[], [], [], []]);
  // 第 2 tick:归零 → 出兵 + 清空队列。
  expect(done.state.sites[0]!.producing).toBeNull();
  expect(done.state.units).toEqual([
    { id: 100, owner: 0, type: "worker", x: 2, y: 2, hp: 2, carrying: 0 },
  ]);
  expect(done.state.nextId).toBe(101);
});

it("下单那一 tick 计入生产耗时:spawnTicks=2 的单在下单后第 2 tick 的 d) 里出兵", () => {
  // 下单在步 1、推进在步 4;下单 tick 也吃一次推进,所以第 1 tick 末 remaining 是 1。
  const placed = step(makeState([], [base(5, 2, 2, 0)]), [[spawn(5, "worker")], [], [], []]);
  expect(placed.state.sites[0]!.producing).toEqual({ type: "worker", remainingTicks: 1 });
  const done = step(placed.state, [[], [], [], []]);
  expect(done.state.sites[0]!.producing).toBeNull();
  expect(done.state.units.map((item) => [item.type, item.x, item.y])).toEqual([["worker", 2, 2]]);
});

it("出兵格被任意单位占据(含己方)则挂起:remainingTicks 停在 0 不再变,不换格、不跳过", () => {
  const ally = unit(1, 0, "worker", 2, 2);
  let state = makeState([ally], [withProduction(base(5, 2, 2, 0), "worker", 1)]);
  state = step(state, [[], [], [], []]).state;
  // 归零那一 tick:到点了,但格子被自家单位占住 → 挂起,remainingTicks 停在 0。
  expect(state.sites[0]!.producing).toEqual({ type: "worker", remainingTicks: 0 });
  expect(state.units).toHaveLength(1);

  state = step(state, [[], [], [], []]).state;
  // 挂起期间 remainingTicks 不再变(仍是 0,不写成 -1),也不出兵、不换格(仍只有那个占位单位)。
  // 「被占则换格出兵」的反例:这里会多出一个单位 → 红。
  expect(state.sites[0]!.producing).toEqual({ type: "worker", remainingTicks: 0 });
  expect(state.units).toHaveLength(1);
  expect(state.units[0]!.x).toBe(2);
});

it("格子空出那一 tick 立刻出兵:挂起(remainingTicks=0)且格空 → 同 tick 出兵 + 清空", () => {
  // 已到点(0)、格空:不再有 advance,直接出兵。
  const result = step(makeState([], [withProduction(base(5, 2, 2, 0), "worker", 0)]), [
    [],
    [],
    [],
    [],
  ]);
  expect(result.state.sites[0]!.producing).toBeNull();
  expect(result.state.units.map((item) => [item.owner, item.type, item.x, item.y])).toEqual([
    [0, "worker", 2, 2],
  ]);
});

it("基地易主:队列取消,并把订单兵种的全额造价退给原主(不按剩余 tick 折算)", () => {
  const captured = withProgress(
    withProduction(base(5, 2, 2, 0), "melee", 1),
    1,
    RULESET.captureTicks - 1,
  );
  const driver = unit(1, 1, "worker", 2, 2);
  // 座位 0 只是丢了基地,还有一支部队——按 gdd《胜利与淘汰》「**同时**无单位且无基地」不算淘汰。
  // 这一支是刻意留的:它顺带钉住「易主退款不会把原主顺手判出局」。
  const army = unit(2, 0, "worker", 0, 0);
  const result = step(
    makeState([driver, army, HOLDER], [captured, DECOY_SITE], {
      resources: { 0: 10, 1: 20 },
      alive: { 2: false },
    }),
    [[], [], [], []],
  );
  expect(result.state.sites[0]!.owner).toBe(1);
  expect(result.state.sites[0]!.producing).toBeNull();
  // 全额 = melee.cost(8),与 remainingTicks=1 无关;退给原主(座位 0)。
  expect(result.state.players[0]!.resources).toBe(10 + 8);
  // 新主没多出一分钱。
  expect(result.state.players[1]!.resources).toBe(20);
  // 座位 0 丢了基地但部队尚存 → 没有被顺手判出局(淘汰条件要「同时」)。
  expect(result.state.players[0]!.alive).toBe(true);
  // 「易主退款改成不退」的反例:座位 0 仍是 10 → 上一条红。
  expect(result.events).toEqual([{ kind: "site-captured", subjectId: 5 }]);
});

it("易主取消后不会替原主在别人家的基地里出个兵(队列已随易主取消)", () => {
  const captured = withProgress(
    withProduction(base(5, 2, 2, 0), "worker", 0),
    1,
    RULESET.captureTicks - 1,
  );
  const driver = unit(1, 1, "worker", 2, 2);
  const result = step(makeState([driver], [captured]), [[], [], [], []]);
  // 队列在 a) 就被取消了;d) 不会替原主(座位 0)出个兵。只剩那个易主驱动者。
  expect(result.state.sites[0]!.owner).toBe(1);
  expect(result.state.sites[0]!.producing).toBeNull();
  expect(result.state.units.map((item) => item.owner)).toEqual([1]);
});

it("原主已淘汰(alive=false)时也照原主退款:退款只是往资源池那个数上加一笔", () => {
  const captured = withProgress(
    withProduction(base(5, 2, 2, 0), "melee", 3),
    1,
    RULESET.captureTicks - 1,
  );
  const driver = unit(1, 1, "worker", 2, 2);
  const result = step(
    makeState([driver], [captured], { resources: { 0: 5 }, alive: { 0: false } }),
    [[], [], [], []],
  );
  // 「原主已淘汰时不退款」对应的是**回归中立**那条路(归票 09),不是这里:易主退款无条件给原主。
  expect(result.state.players[0]!.resources).toBe(5 + RULESET.melee.cost);
});

it("同 tick 多单但资金只够一单:按处理序(座位 → 基地 id 升序)先到者成、后到者丢弃", () => {
  const result = step(
    makeState([], [base(4, 1, 1, 0), base(7, 3, 3, 0)], { resources: { 0: 8 } }),
    [[spawn(4, "melee"), spawn(7, "melee")], [], [], []],
  );
  // 资金 8 只够一单 melee(8)。base 4 先处理 → 占线扣款;base 7 看到 0 < 8 → 丢弃。
  expect(result.state.sites[0]!.producing).toEqual({ type: "melee", remainingTicks: 3 });
  expect(result.state.sites[1]!.producing).toBeNull();
  expect(result.state.players[0]!.resources).toBe(0);
});

it("同 tick 基地易主后再给原主下单:步 1 放行、d) 按当前属主重判 → 丢弃,不扣款", () => {
  const captured = withProgress(base(5, 2, 2, 0), 1, RULESET.captureTicks - 1);
  const driver = unit(1, 1, "worker", 2, 2);
  const result = step(makeState([driver], [captured]), [[spawn(5, "worker")], [], [], []]);
  // 步 1 用的是 tick 开始的状态,那时基地还是座位 0 的;易主后 d) 在**当前**状态上重判属主 → 无效。
  expect(result.state.sites[0]!.owner).toBe(1);
  expect(result.state.sites[0]!.producing).toBeNull();
  expect(result.state.players[0]!.resources).toBe(16);
});
