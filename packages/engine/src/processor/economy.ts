/**
 * 采集、交付与经济死亡(票 07;gdd §5《经济与生产》、`docs/rules-v1/rules.md` §4.1–§4.3)。
 * **这一节就是这台经济机器的家**。
 *
 * ── 为什么是「只读视图 + `check()` + 纯函数产出候选变更」而不是就地写状态 ──
 *
 * 与 `movement.ts` / `combat.ts` / `production.ts` 同形:视图每一栏 readonly,「`check()` 不改状态」
 * 由类型承担;要落下的每一件事都经唯一写入口 `apply()` 的变更表(`harvest` / `transfer`,
 * 见 `driver/apply.ts`)。落子不在本模块,本模块只算「该不该落、落成什么」。
 *
 * ── 无被动收入:经济只从 intent 来 ──
 *
 * 采集要脚本提交 `harvest` 意图,交付要提交 `transfer` 意图;单位**站着不动什么都不会发生**。
 * 这是规则明确刻意的取舍(不做死锁保护),所以「没有 intent 就没有入账」是一条要能被断言的
 * 性质,而不是实现的副作用(用例钉住)。
 *
 * ── 采集能力的判据(契约面缺口)──
 *
 * 规则集**没有**「这个兵种能不能采集」这一栏——`rulesets/*.json` 给的是全局的 `harvestRate`,
 * 而它是**速率**不是**资格**。本模块按 gdd §5/§6.1 的定位把资格判成「类型名是 `worker`」:
 * 「农民:经济与堵点——采集、携带、交付;无攻击能力」是四条兵种线里唯一的一句采集定位,
 * 而 `worker.cost` / `harvestRate` / `carryLimit` 三个参数都挂在 `worker` 这一条线上。
 * 这不是含糊过去:它是一处**契约面缺口**——规则集缺「能否采集」这一栏,兵种名到能力的映射
 * 目前只能由代码承载(先例:`ruleset-loader` 的 `statsOf` 把兵种名映射到属性线)。补这一栏归
 * 契约面那一轮(票 12 记下)。**别去改规则集**:本轮不改生成物。
 *
 * ── 「相邻」的口径 ──
 *
 * gdd/rules 的措辞是「站在矿的**相邻格**上」「基地的**相邻格**」,射程取 §10 的 `worker.range`。
 * 代码用**切比雪夫距离 ≤ `statsOf(worker).range`**,与 `step3-combat.ts` 的
 * `distance <= statsOf(attacker.type).range` **同源**——一个兵种只有一个「射程」概念,不另立一套
 * 「相邻」定义。当前 `worker.range = 1`,即切比雪夫 ≤ 1(**含站在矿格/基地格上那一格**);
 * 选 ≤ 1 而不是「恰好 1」,是为了让「射程」在移动、战斗、采集、交付四处只有一份实现,
 * 且规则集把 `range` 调大时四处一起变。
 *
 * ── 多个相邻目标取哪一个:数值 id 最小 ──
 *
 * 规则侧没写「一个农民贴着两个己方矿点该采哪个」,交付那一侧写了「同时相邻多个己方基地时,
 * 交付给数值 id 最小的那个」。本模块把**两侧统一**成同一条:相邻候选按**数值 id 升序**取第一个。
 * 理由与本仓「数值升序是唯一被声明的定序语义」同源(见 `world/state.ts` 对 `GameState` 的说明、
 * `processor/events.ts` 的定序规则):不取「遍历到的第一个」(那是实现的自由,换一遍历序回放就变样),
 * 而取一条由 id 决定的确定答案。用例两处各钉一条(采集的「多矿取最小」、交付的「多基地取最小」)。
 */

import type { RulesetView } from "../ruleset-loader/index.js";
import type { Change } from "../driver/apply.js";
import type { Intent } from "./intents.js";
import type { PlayerIndex, Site, Unit } from "../world/state.js";

/** 本模块处理的两条意图。收窄判别式,不靠 `as`。 */
export type HarvestIntent = Extract<Intent, { kind: "harvest" }>;
export type TransferIntent = Extract<Intent, { kind: "transfer" }>;

/** 判别 `harvest`。其余五条不是采集(归 04/06/08/09),本票只交付这一条。 */
export const isHarvestIntent = (intent: Intent): intent is HarvestIntent =>
  intent.kind === "harvest";

/** 判别 `transfer`。 */
export const isTransferIntent = (intent: Intent): intent is TransferIntent =>
  intent.kind === "transfer";

/**
 * `check()` / `run()` 的只读视图。
 *
 * **类型里没有任何写入口**:它是 `GameState` 的一个结构子集,每一栏 readonly,所以步 1 与步 4
 * 可以直接把真状态传进来。经济死亡判据要用 `players`(读 `resources`),采集/交付的封顶要用
 * `sites`(读 `remaining`)与 `units`(读 `carrying` / 位置),故三栏都列。
 */
export type EconomyView = {
  readonly units: readonly Unit[];
  readonly sites: readonly Site[];
  readonly players: readonly { readonly index: PlayerIndex; readonly resources: number }[];
};

/** 候选变更。它们就是 `apply()` 已登记的 `harvest` / `transfer`,落子不需要第二种写操作。 */
export type Harvest = Extract<Change, { kind: "harvest" }>;
export type Transfer = Extract<Change, { kind: "transfer" }>;

/** 按数值 id 取单位。`units` 由状态不变量保证升序,但一次一条意图,线性查找即可。 */
const unitIn = (view: EconomyView, id: number): Unit | undefined =>
  view.units.find((unit) => unit.id === id);

/** 切比雪夫距离。与 `step3-combat.ts` 的射程判定同一个度量。 */
const chebyshev = (left: Unit, right: Site): number =>
  Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));

/** 采集资格:唯一有采集能力的兵种是 `worker`(见头注的契约面缺口)。 */
const canHarvest = (unit: Unit): boolean => unit.type === "worker";

/**
 * 该单位相邻的**己方资源点**里数值 id 最小的那个;没有则 `undefined`。
 *
 * `view.sites` 由状态不变量保证升序,所以「升序遍历遇到的第一个合格者」就是 id 最小的合格者——
 * 不额外排序,也不依赖「先遍历到谁」。合格 = `kind === "resource"`、`owner === seat`、
 * `remaining > 0`、在射程内。`remaining === 0`(采空)的矿**跳过**:它还在点位表里(仍计入胜利
 * 条件),但再也产不出资源,所以不是可采目标。
 */
const nearestFriendlyResourceSite = (
  view: EconomyView,
  seat: PlayerIndex,
  unit: Unit,
  ruleset: RulesetView,
): Site | undefined => {
  const range = ruleset.statsOf(unit.type).range;
  for (const site of view.sites) {
    if (site.kind !== "resource" || site.owner !== seat) {
      continue;
    }
    if ((site.remaining ?? 0) <= 0) {
      continue;
    }
    if (chebyshev(unit, site) <= range) {
      return site;
    }
  }
  return undefined;
};

/**
 * 该单位相邻的**己方基地**里数值 id 最小的那个;没有则 `undefined`。口径同采集(见头注)。
 */
const nearestFriendlyBaseSite = (
  view: EconomyView,
  seat: PlayerIndex,
  unit: Unit,
  ruleset: RulesetView,
): Site | undefined => {
  const range = ruleset.statsOf(unit.type).range;
  for (const site of view.sites) {
    if (site.kind !== "base" || site.owner !== seat) {
      continue;
    }
    if (chebyshev(unit, site) <= range) {
      return site;
    }
  }
  return undefined;
};

/**
 * `checkHarvest()`:六条判据,返回布尔。
 *
 * 1. **单位存在**——`unitId` 命中一个单位;
 * 2. **属主正确**——单位属于该座位(拿别人的农民下采集无效);
 * 3. **有采集能力**——`worker`(见头注;规则集没有这一栏,判据落在类型名上);
 * 4. **相邻处有己方资源点**——存在 `kind === "resource"`、`owner === seat`、在射程内的点位;
 * 5. **该矿未采空**——`remaining > 0`;
 * 6. **未满携带**——`carrying < carryLimit`。
 *
 * 4 与 5 一起由 `nearestFriendlyResourceSite` 表达。判据 6 用「未满携带」而不是「满了也照样加」:
 * 满携带是「这一 tick 不再产生有效采集」,而封顶在落子那一侧做(见 `harvestChangeOf`)。
 *
 * `intent.siteId` **不参与判据**。gdd §5 的采集是「站在矿相邻格自动开采」,没有「指定矿点」这一步;
 * 规则侧只规定「相邻己方资源点」,多矿取 id 最小那条由本模块统一决定。若让 `siteId` 参与目标选择,
 * 同一段脚本在不同相邻构型下会得到两种语义,而「取 id 最小」这条规则就没有一处能钉住。
 * `siteId` 是契约面冻结的意图形状的一部分(见 `processor/intents.ts`),保留字段、不读它。
 */
export const checkHarvest = (
  view: EconomyView,
  seat: PlayerIndex,
  ruleset: RulesetView,
  intent: HarvestIntent,
): boolean => {
  const unit = unitIn(view, intent.unitId);
  if (unit === undefined) {
    return false;
  }
  if (unit.owner !== seat) {
    return false;
  }
  if (!canHarvest(unit)) {
    return false;
  }
  if (unit.carrying >= ruleset.raw.carryLimit) {
    return false;
  }
  return nearestFriendlyResourceSite(view, seat, unit, ruleset) !== undefined;
};

/**
 * `run()`:在只读基线上算出唯一一条候选采集变更,或「不成立」(`null`)。
 *
 * 取量 = `min(harvestRate, carryLimit - carrying, remaining)`,三项封顶各管一件事:
 * - `harvestRate`:本 tick 的自然产出上限;
 * - `carryLimit - carrying`:**满携带即停**按封顶实现——这一 tick 取到满为止,不做「满了就一点不取」
 *   (那是判据 6 已经挡掉的另一支,见 `checkHarvest`);
 * - `remaining`:矿里还剩多少——有限储量的硬上限,取量不能超过余量。
 *
 * 取量是**全部为整数**的三项取最小,结果仍是整数(NFR-1)。
 */
export const harvestChangeOf = (
  view: EconomyView,
  seat: PlayerIndex,
  ruleset: RulesetView,
  intent: HarvestIntent,
): Harvest | null => {
  if (!checkHarvest(view, seat, ruleset, intent)) {
    return null;
  }
  const unit = unitIn(view, intent.unitId);
  if (unit === undefined) {
    return null;
  }
  const site = nearestFriendlyResourceSite(view, seat, unit, ruleset);
  if (site === undefined) {
    return null;
  }
  const remaining = site.remaining ?? 0;
  const amount = Math.min(
    ruleset.raw.harvestRate,
    ruleset.raw.carryLimit - unit.carrying,
    remaining,
  );
  return { kind: "harvest", unitId: unit.id, siteId: site.id, amount };
};

/**
 * `checkTransfer()`:四条判据,返回布尔。
 *
 * 1. **单位存在**;2. **属主正确**;3. **`carrying > 0`**;4. **相邻处有己方基地**。
 *
 * `carrying === 0` 时**直接判假**:这条意图不成立 → `transferChangeOf` 返回 `null` → **没有变更被
 * 造出来、不发事件、不计异常**(静默丢弃)。理由:交付一个空的口袋不是一条规则事件,而
 * 「把 0 加进玩家池」是一次可观察但无意义的写;静默丢弃与「没交」在状态上逐字相同。
 *
 * 不单列「类型是农民」:非农民兵种的 `carrying` 恒为 `0`(见 `world/state.ts` 的 `Unit.carrying`),
 * 所以判据 3 在数据上已经把它挡掉,多判一次类型会把「携带量属于哪个兵种」变成第二个家。
 */
export const checkTransfer = (
  view: EconomyView,
  seat: PlayerIndex,
  ruleset: RulesetView,
  intent: TransferIntent,
): boolean => {
  const unit = unitIn(view, intent.unitId);
  if (unit === undefined) {
    return false;
  }
  if (unit.owner !== seat) {
    return false;
  }
  if (unit.carrying <= 0) {
    return false;
  }
  return nearestFriendlyBaseSite(view, seat, unit, ruleset) !== undefined;
};

/**
 * `run()`:在只读基线上算出唯一一条候选交付变更,或「不成立」(`null`)。
 *
 * `amount` = 单位当前携带量(整数),交付后清零;`siteId` = 相邻己方基地里数值 id 最小者
 * (见头注;资源进玩家全局池,与哪个基地收无关,但记录它以便审计)。
 */
export const transferChangeOf = (
  view: EconomyView,
  seat: PlayerIndex,
  ruleset: RulesetView,
  intent: TransferIntent,
): Transfer | null => {
  if (!checkTransfer(view, seat, ruleset, intent)) {
    return null;
  }
  const unit = unitIn(view, intent.unitId);
  if (unit === undefined) {
    return null;
  }
  const site = nearestFriendlyBaseSite(view, seat, unit, ruleset);
  if (site === undefined) {
    return null;
  }
  return {
    kind: "transfer",
    unitId: unit.id,
    siteId: site.id,
    player: seat,
    amount: unit.carrying,
  };
};

/**
 * 经济死亡的**形式判据**:该玩家无任何 `worker` 单位 **且** `resources < worker.cost`(造价从规则集读)。
 *
 * ── 这是一条纯函数,不读 `economyDeadAtTick` ──
 *
 * 「每局每席至多一条事件」的闩记在 `GameState.economyDeadAtTick` 里(与 `firstContactTick` 同性质),
 * 由**调用点**(步 4 的循环)读它决定「这条事件发过没有」。本判据只看单位表、玩家资源与规则集——
 * 判据的输入里**没有**那一栏,所以「经济死亡状态」在**任何**字段里都不存在,可以随时从可观察
 * 事实重算。反向用例(`processor/economy.test.ts`)钉的就是这条:两份额外状态只差闩栏时,本函数
 * 同值。
 */
export const isEconomyDead = (
  view: EconomyView,
  seat: PlayerIndex,
  ruleset: RulesetView,
): boolean => {
  if (view.units.some((unit) => unit.owner === seat && unit.type === "worker")) {
    return false;
  }
  const player = view.players.find((candidate) => candidate.index === seat);
  if (player === undefined) {
    return false;
  }
  return player.resources < ruleset.raw.worker.cost;
};
