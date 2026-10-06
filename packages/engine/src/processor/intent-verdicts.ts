/**
 * 六条意图的**判据**:唯一的实现,两个消费者共用(处理器与沙箱 guest)。
 *
 * ── 为什么判据只该有一个家,而它现在有两个调用方 ──
 *
 * 处理器要判「这条意图成不成立」(布尔,决定结算与丢弃);沙箱 guest 要判同一件事,但还要
 * 把它翻成一条**错误码**即时回给脚本(`isError` / `errCode`)。两份判据各写一遍就是两处会
 * 分叉的规则源,而分叉的形态正是「引擎在结算时丢弃了脚本以为成功的那一单」。所以判据落在这里,
 * 处理器经 `check12(...).ok` 读它、沙箱经同一批函数读它的 `code`;逐条判据的理由仍写在
 * `movement.ts` / `combat.ts` / `economy.ts` / `production.ts` 各自的 `check*` 头注里——
 * 那四处是**理由的家**,本模块是同一批判据的**实现的家**。
 *
 * ── guest 安全 ──
 * 本模块被 esbuild 打进 runtime bundle,所以它只 import 类型(擦除后一个运行时依赖都不剩):
 * 不碰 `node:*`、不读盘、不引任何容器库。视图与规则都取**结构化最小面**,于是引擎的
 * `MovementView` / `AttackView` / `EconomyView` / `ProductionView` / `RulesetView` 五个既存形状
 * 都能原样传进来,而 guest 用快照与宿主注入的规则集也能凑出同一份形状。
 *
 * ── 返回值为什么不是布尔 ──
 *
 * 沙箱 needs 的是「没过的是哪一条」:同一批判据里存在七种可回给脚本的失败原因(`ERR_*`),
 * 外加一种**没有错误码的静默丢弃**(产线已有订单时重复下单,见 `production.ts` 头注)。
 * 布尔把这个信息压掉,于是这里交回 `Verdict`:通过 / 失败且带码 / 失败但不带码(静默)。
 * 处理器只读 `.ok`,把 `Verdict` 还原成布尔——所以本模块的引入**不改变**结算行为。
 *
 * ── 错误码为什么也在本模块里 ──
 *
 * guest 必须把七个 `ERR_*` 名字铺成全局。名字的家是 `@model-war/schema` 的符号表;这里是它在
 * 引擎侧的**投影**(`INTENT_ERR_CODES`),由一条断言与符号表逐字对齐(`intent-verdicts.test.ts`)。
 * runtime bundle 不能 import 真源包(那条链会把 `@model-war/schema` 整个打进来),所以投影只能
 * 落在这样一份常量上,再由断言看着它不漂。
 */

import type { Point } from "../pathfinding/find-path.js";
import type { PlayerIndex, Site, Terrain, Unit, UnitType } from "../world/state.js";
import type { Intent } from "./intents.js";

/** 两条移动意图。与 `movement.ts` 的 `MoveIntent` 同形(同源是判别式,不是那处别名)。 */
export type MoveIntent = Extract<Intent, { kind: "move" | "moveTo" }>;
export type AttackIntent = Extract<Intent, { kind: "attack" }>;
export type HarvestIntent = Extract<Intent, { kind: "harvest" }>;
export type TransferIntent = Extract<Intent, { kind: "transfer" }>;
export type SpawnIntent = Extract<Intent, { kind: "spawnUnit" }>;

/** 引擎侧的七条 `ERR_*` 投影;与真源包符号表里 `kind === "error-code"` 的名字逐字相同。 */
export const INTENT_ERR_CODES = [
  "ERR_NOT_ENOUGH_RESOURCES",
  "ERR_INVALID_UNIT",
  "ERR_NOT_OWNER",
  "ERR_OUT_OF_RANGE",
  "ERR_INVALID_TARGET",
  "ERR_INVALID_SITE",
  "ERR_BAD_ARGS",
] as const;

/** 一条 `ERR_*`。 */
export type IntentErrCode = (typeof INTENT_ERR_CODES)[number];

/**
 * 一条意图的裁决。`ok` 为假时 `code` 是那条要给脚本的错误码,或是 `null`(静默丢弃,没有码)。
 *
 * `code: null` 只产自 `spawnVerdict` 的「产线已有订单」那一支:重复下单是**静默丢弃**,
 * 不是错误(`ERR_BASE_BUSY` 一码刻意不收,见 `script-surface.ts` 的头注)。
 */
export type Verdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: IntentErrCode | null };

const OK: Verdict = { ok: true };
const SILENT: Verdict = { ok: false, code: null };
const fail = (code: IntentErrCode): Verdict => ({ ok: false, code });

// ── 视图与规则:结构化最小面,引擎的五个既存形状与 guest 都能满足 ──────────────────

/** 带 `units` 的任意视图。 */
export type UnitView = { readonly units: readonly Unit[] };
/** 移动判据要的:尺寸、地形、单位表。 */
export type MoveView = {
  readonly size: number;
  readonly terrain: Terrain;
  readonly units: readonly Unit[];
};
/** 战斗判据要的:单位表与点位表。 */
export type AttackView = { readonly units: readonly Unit[]; readonly sites: readonly Site[] };
/** 采集/交付判据要的:单位、点位与玩家三项。 */
export type EconomyView = {
  readonly units: readonly Unit[];
  readonly sites: readonly Site[];
  readonly players: readonly { readonly index: PlayerIndex; readonly resources: number }[];
};
/** 生产判据要的:点位与玩家两项。 */
export type ProductionView = {
  readonly sites: readonly Site[];
  readonly players: readonly { readonly index: PlayerIndex; readonly resources: number }[];
};

/**
 * 判据要读的规则面:只有 `carryLimit` 与按兵种取属性两项。
 *
 * `RulesetView`(引擎装载后的视图)结构上满足它:它的 `raw` 带 `carryLimit`,`statsOf` 交回的
 * `UnitStats` 带 `cost` / `damage` / `range` 三项。guest 侧由宿主注入的规则集凑出同一形状。
 */
export type VerdictRules = {
  readonly raw: { readonly carryLimit: number };
  readonly statsOf: (unitType: UnitType) => {
    readonly cost: number;
    readonly damage: number;
    readonly range: number;
  };
};

// ── 共用取物与几何 ──

/** 按数值 id 取单位。`units` 由状态不变量保证升序,但一次一条意图,线性查找即可。 */
export const unitById = (view: UnitView, id: number): Unit | undefined =>
  view.units.find((unit) => unit.id === id);

/** 按数值 id 取点位。 */
export const siteById = (view: { readonly sites: readonly Site[] }, id: number): Site | undefined =>
  view.sites.find((site) => site.id === id);

/** 按座位取玩家;`players` 按 `playerIndex 0..3` 对齐。 */
export const playerOf = (
  view: ProductionView,
  seat: PlayerIndex,
): { readonly index: PlayerIndex; readonly resources: number } | undefined =>
  view.players.find((player) => player.index === seat);

/** 该兵种的造价。全整数,取自规则集,代码里不出现那个数字。 */
export const costOf = (ruleset: VerdictRules, unitType: UnitType): number =>
  ruleset.statsOf(unitType).cost;

/** 切比雪夫距离。射程与采集资格都用这一个度量。 */
export const chebyshev = (
  left: { readonly x: number; readonly y: number },
  right: { readonly x: number; readonly y: number },
): number => Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));

/** 采集资格:唯一有采集能力的兵种是 `worker`。 */
export const canHarvest = (unit: Unit): boolean => unit.type === "worker";

/** 一格是否在界内。 */
const inBounds = (view: MoveView, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < view.size && y < view.size;

/** 一格是否是墙。 */
const isWall = (view: MoveView, x: number, y: number): boolean => view.terrain[y]?.[x] === true;

/**
 * 一条移动意图的目标格。
 *
 * `move` 是「当前格 + 位移」,`moveTo` 是绝对坐标。`(0, 0)` 的 `move` 不表达位移,不是移动,
 * 故返回 `null` 当作参数非法(理由见 `movement.ts` 的 `checkMove` 头注)。
 */
export const moveTargetOf = (unit: Unit, intent: MoveIntent): Point | null => {
  if (intent.kind === "moveTo") {
    return { x: intent.x, y: intent.y };
  }
  if (intent.dx === 0 && intent.dy === 0) {
    return null;
  }
  return { x: unit.x + intent.dx, y: unit.y + intent.dy };
};

/**
 * 该单位相邻的**己方资源点**里数值 id 最小的那个;没有则 `undefined`(理由见 `economy.ts` 的
 * `checkHarvest` 与 `nearestFriendlyResourceSite` 头注)。
 */
export const nearestFriendlyResourceSite = (
  view: EconomyView,
  seat: PlayerIndex,
  unit: Unit,
  ruleset: VerdictRules,
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

/** 该单位相邻的**己方基地**里数值 id 最小的那个;口径同采集。 */
export const nearestFriendlyBaseSite = (
  view: EconomyView,
  seat: PlayerIndex,
  unit: Unit,
  ruleset: VerdictRules,
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

// ── 六条意图的判据 ────────────────────────────────────────────────────────────

/**
 * `move` 的判据。次序与 `movement.ts` 的 `checkMove` 逐条相同:单位存在 → 属主正确 →
 * 位移参数在界 → 目标格可通行。
 */
export const moveVerdict = (view: MoveView, seat: PlayerIndex, intent: MoveIntent): Verdict => {
  const unit = unitById(view, intent.unitId);
  if (unit === undefined) {
    return fail("ERR_INVALID_UNIT");
  }
  if (unit.owner !== seat) {
    return fail("ERR_NOT_OWNER");
  }
  if (intent.kind === "move" && (Math.abs(intent.dx) > 1 || Math.abs(intent.dy) > 1)) {
    // 类型上是 -1|0|1,但真沙箱交出的是 JSON,运行时可能收到别的数,故在缝上再判一次。
    return fail("ERR_BAD_ARGS");
  }
  const target = moveTargetOf(unit, intent);
  if (target === null) {
    return fail("ERR_BAD_ARGS");
  }
  if (!inBounds(view, target.x, target.y) || isWall(view, target.x, target.y)) {
    return fail("ERR_INVALID_TARGET");
  }
  return OK;
};

/**
 * `attack` 的判据。次序与 `combat.ts` 的 `checkAttack` 逐条相同:攻击者存在 → 属主 →
 * 有攻击能力 → 目标不是点位 → 目标是单位且为敌方 → 在射程内。
 *
 * `rules` 缺席时跳过要读规则集的两条(攻击能力与射程)。那是 guest 在**宿主没注入规则集**时的
 * 降级形态:这两条判据交回引擎终裁,而不是用一份臆造的属性把它误判成错。
 */
export const attackVerdict = (
  view: AttackView,
  seat: PlayerIndex,
  rules: VerdictRules | null,
  intent: AttackIntent,
): Verdict => {
  const attacker = unitById(view, intent.unitId);
  if (attacker === undefined) {
    return fail("ERR_INVALID_UNIT");
  }
  if (attacker.owner !== seat) {
    return fail("ERR_NOT_OWNER");
  }
  if (rules !== null && rules.statsOf(attacker.type).damage <= 0) {
    // 有攻击能力看 `damage`,不看 `range`(农民 range=1、damage=0)。
    return fail("ERR_INVALID_TARGET");
  }
  if (siteById(view, intent.targetId) !== undefined) {
    // 目标挂着点位号段是「打的是一个点位」(基地不可被攻击)。
    return fail("ERR_INVALID_TARGET");
  }
  const target = unitById(view, intent.targetId);
  if (target === undefined) {
    return fail("ERR_INVALID_UNIT");
  }
  if (target.owner === seat) {
    return fail("ERR_INVALID_TARGET");
  }
  if (rules !== null && chebyshev(attacker, target) > rules.statsOf(attacker.type).range) {
    return fail("ERR_OUT_OF_RANGE");
  }
  return OK;
};

/**
 * `harvest` 的判据。次序与 `economy.ts` 的 `checkHarvest` 逐条相同:单位存在 → 属主 →
 * 有采集能力 → 未满携带 → 相邻处有己方资源点(后两条要读规则集,`rules` 缺席时跳过)。
 *
 * `intent.siteId` **不参与判据**(与处理器一致):采集是「站在矿相邻格自动开采」,指定矿点不是
 * 规则的一部分(见 `economy.ts` 头注)。
 */
export const harvestVerdict = (
  view: EconomyView,
  seat: PlayerIndex,
  rules: VerdictRules | null,
  intent: HarvestIntent,
): Verdict => {
  const unit = unitById(view, intent.unitId);
  if (unit === undefined) {
    return fail("ERR_INVALID_UNIT");
  }
  if (unit.owner !== seat) {
    return fail("ERR_NOT_OWNER");
  }
  if (!canHarvest(unit)) {
    return fail("ERR_INVALID_UNIT");
  }
  if (rules !== null && unit.carrying >= rules.raw.carryLimit) {
    return fail("ERR_INVALID_TARGET");
  }
  if (rules === null) {
    return OK;
  }
  if (nearestFriendlyResourceSite(view, seat, unit, rules) === undefined) {
    return fail("ERR_INVALID_SITE");
  }
  return OK;
};

/**
 * `transfer` 的判据。次序与 `economy.ts` 的 `checkTransfer` 逐条相同:单位存在 → 属主 →
 * `carrying > 0` → 相邻处有己方基地(最后一条要读规则集,`rules` 缺席时跳过)。
 */
export const transferVerdict = (
  view: EconomyView,
  seat: PlayerIndex,
  rules: VerdictRules | null,
  intent: TransferIntent,
): Verdict => {
  const unit = unitById(view, intent.unitId);
  if (unit === undefined) {
    return fail("ERR_INVALID_UNIT");
  }
  if (unit.owner !== seat) {
    return fail("ERR_NOT_OWNER");
  }
  if (unit.carrying <= 0) {
    return fail("ERR_INVALID_TARGET");
  }
  if (rules !== null && nearestFriendlyBaseSite(view, seat, unit, rules) === undefined) {
    return fail("ERR_INVALID_SITE");
  }
  return OK;
};

/**
 * `spawnUnit` 的判据。次序与 `production.ts` 的 `checkSpawn` 逐条相同:基地存在 → 是基地 →
 * 属主 → 资金够(`rules` 缺席时跳过)→ 产线空闲。
 *
 * 产线已有订单那一支回 `SILENT`(没有码):重复下单是静默丢弃,不扣款、不计异常、也不是错误码
 * (见 `production.ts` 头注与 `script-surface.ts` 里「`ERR_BASE_BUSY` 不收」的裁决)。
 */
export const spawnVerdict = (
  view: ProductionView,
  seat: PlayerIndex,
  rules: VerdictRules | null,
  intent: SpawnIntent,
): Verdict => {
  const site = siteById(view, intent.baseId);
  if (site === undefined) {
    return fail("ERR_INVALID_SITE");
  }
  if (site.kind !== "base") {
    return fail("ERR_INVALID_SITE");
  }
  if (site.owner !== seat) {
    return fail("ERR_NOT_OWNER");
  }
  const player = playerOf(view, seat);
  if (player === undefined) {
    return fail("ERR_INVALID_SITE");
  }
  if (rules !== null && player.resources < costOf(rules, intent.unitType)) {
    return fail("ERR_NOT_ENOUGH_RESOURCES");
  }
  if (site.producing !== null) {
    return SILENT;
  }
  return OK;
};
