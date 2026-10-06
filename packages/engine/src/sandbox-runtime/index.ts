/**
 * 沙箱运行时(guest 侧):宿主桥的载体 + **注入 API 面的全表**。
 *
 * ── 它是什么、不是什么 ──
 *
 * 本文件是**跑在 guest 里**的代码,不是引擎的运行时依赖:它被 esbuild 打成单文件 IIFE
 * (票 04 固化成入库产物),经 `evalCode(runtimeCode)` 铺进 VM。所以它**不碰 `node:*`、不读盘**;
 * 它 import 的只有引擎里 guest 安全的那几件——同一份 A*(寻路)、同一份判据(`intent-verdicts.ts`)
 * 与兵种名清单(`world/state.ts` 的 `isUnitType`),这三样 esbuild 会原样打进产物。
 *
 * ── 为什么桥名与 setup 载体不手写、要由构建期注入 ──
 *
 * 宿主桥的命名约定住在真源包(`HOST_BRIDGE_PREFIX`,`__`),引擎侧由 `runner/index.ts` 拼成
 * `HOST_BRIDGE_SET_SNAPSHOT` / `HOST_BRIDGE_DRAIN_INTENTS` 两个常量。本文件在 guest 里,import
 * 不到那条常量链(import `@model-war/replay` 会把 `node:crypto` 一起拖进 bundle),于是那两个标识符
 * 在这里声明为**未绑定**,由构建脚本经 esbuild 的 `define` 注入字面量。源码里因此一个桥名都不手写:
 * 名字的家只有一处,构建期一次性传进来。
 *
 * 一次性 setup(`{ seat, ruleset }`)没有**第三个**注入名:宿主在建 VM 时先把它放在 `__setSnapshot`
 * 这个位置下,本文件在 IIFE 开头读走它、并立刻把同一位置换成每 tick 的桥函数。这样不必新增一个
 * 只出现一次的构建期注入名(那会给并行票正在改的构建面添一处耦合),而注入面的名字集合也就还是
 * 符号表那一份,一个不多一个不少。
 *
 * ── 注入面的全表,一次铺完 ──
 *
 * 查询与 action **全部在 VM 内**跑;每 tick 只跨宿主边界两次(`__setSnapshot` 进、`__drainIntents`
 * 出)。逐函数注入是明确的反面(hld §4.5):稠密/滥用区的跨边界成本会无上界。注入面按真源包的
 * `SANDBOX_INJECTED_API_SYMBOLS` 铺,名字的家在那里,本文件只是把它**实现**出来。
 *
 * ── 判据与寻路为什么是同一份 ──
 *
 * `move` / `moveTo` / `attack` / `harvest` / `transfer` / `spawnUnit` 的界检查调用
 * `intent-verdicts.ts`——与处理器的 `check()` **同一份实现**(那也正是「即时 ERR_* 与引擎终裁同一套
 * 规则」的形态)。`findPath` 直接复用引擎的 A*(hld §4.7:同一实现保证脚本查询与引擎移动一致)。
 *
 * ── 规则集从哪来 ──
 *
 * 判据里要读的规则面(射程 / 造价 / `carryLimit`)由宿主经**一次性的 setup 载荷**灌进来:
 * `{ seat, ruleset }`。它只在 runtime 载入前存在,载入后被宿主从全局删掉,所以脚本看不见它。
 * 宿主没灌规则集时 `rules` 为 `null`,要读规则集的那两条判据**降级为跳过**——那两件事交回引擎终裁,
 * 而不是用一份臆造的属性把它误判成错。
 *
 * ── API 计数(票 07 的「双计数」之一)──
 *
 * 每个注入函数都 `apiCalls += 1`(一个**宿主 authored 的普通整数**,不是 guest 可改的全局)。计数经
 * **同一次 `__drainIntents()` 返回载荷**带回宿主(返回结构 `{ intents, apiCalls }`)——不新增桥调用、
 * 不做每次 API 调用的跨边界计数。**阈值判定不在 guest**:宿主拿到 `apiCalls` 后与 `apiCallTickLimit`
 * 比较,超限则作废该座位本 tick 的全部意图。计数每 tick 由 `__setSnapshot` 归零。
 *
 * ── 座位自认为什么由本文件定义 ──
 *
 * 四份 runtime bundle 是**同一串字节**(它的 sha256 就是 `sandboxRuntimeHash`),而 `getMyIndex()`
 * 的返回值每个 VM 不同。座位随一次性 setup 灌入、被闭包捕获(`seat`),不是可写全局——脚本改不掉
 * 自己的座位。把「怎么注入」收进一个 setup 载荷,也让 API 面的形状(某个名字存不存在)由 runtime
 * 自己拥有,而不是「宿主记得注入谁」。
 */

import type { Ruleset } from "@model-war/replay";

import { findPath as findPathInTerrain, type Point } from "../pathfinding/find-path.js";
import {
  isUnitType,
  type PlayerIndex,
  type Player,
  type Site,
  type Snapshot,
  type Unit,
} from "../world/state.js";
import type { Intent } from "../processor/intents.js";
import {
  INTENT_ERR_CODES,
  type AttackIntent,
  type HarvestIntent,
  type IntentErrCode,
  type MoveIntent,
  type SpawnIntent,
  type TransferIntent,
  type Verdict,
  type VerdictRules,
  attackVerdict,
  harvestVerdict,
  moveVerdict,
  spawnVerdict,
  transferVerdict,
} from "../processor/intent-verdicts.js";

// 由构建脚本注入的两个桥名。声明为未绑定标识符:esbuild 的 `define` 在 bundle 时替换它们。
declare const HOST_BRIDGE_SET_SNAPSHOT: string;
declare const HOST_BRIDGE_DRAIN_INTENTS: string;

/** 一个动作没生效时交回的值。判它只能走 `isError` / `errCode`(契约面 `ErrResult`)。 */
type ErrResult = { readonly code: IntentErrCode };

/** `__drainIntents()` 的返回形状:意图 + 本 tick 的 API 调用计数(票 07)。 */
type DrainResult = {
  readonly intents: readonly Intent[];
  readonly apiCalls: number;
};

/** 宿主建 VM 时放在 `__setSnapshot` 位置上的一次性数据。`ruleset` 缺席 = 判据降级。 */
type Setup = {
  readonly seat?: PlayerIndex;
  readonly ruleset?: Ruleset;
};

const guest = globalThis as unknown as Record<string, unknown>;

/**
 * 读走一次性 setup:宿主在建 VM 时把它放在 `__setSnapshot` 这个位置下。
 * 下面《桥》一节会把同一位置换成真实的桥函数(命名与次序的理由见文件头注)。
 */
const setup = guest[HOST_BRIDGE_SET_SNAPSHOT] as Setup | undefined;
const seat: PlayerIndex = setup?.seat ?? 0;
const injectedRuleset = setup?.ruleset;

/** 判据要的规则面。宿主没灌规则集时是 `null`,要读规则集的两条判据跳过。 */
const rules: VerdictRules | null =
  injectedRuleset === undefined
    ? null
    : { raw: injectedRuleset, statsOf: (unitType) => injectedRuleset[unitType] };

/** 本 tick 的只读快照。`null` = 宿主还没交过。 */
let snapshot: Snapshot | null = null;

/** 本 tick 已收集、待 `__drainIntents()` 交回的意图。每 tick 由 `__setSnapshot` 清空。 */
let pending: Intent[] = [];

/**
 * 本 tick 已发生的 API 调用数。一个**普通整数**,每 tick 由 `__setSnapshot` 归零,经
 * `__drainIntents()` 的返回载荷交回宿主裁决(阈值判定不在 guest,见文件头注)。
 */
let apiCalls = 0;

/** 还没有快照时的空世界:判据跑在它上面会如实报「单位不存在」,不是抛异常。 */
const EMPTY: Snapshot = { tick: -1, size: 0, terrain: [], players: [], units: [], sites: [] };

/** 本 tick 的快照;还没交进快照时用空世界。 */
const world = (): Snapshot => snapshot ?? EMPTY;

// ── 桥:唯一几个与宿主约定名字的符号 ─────────────────────────────────────────
//
// 它们在脚本执行**之前**被宿主从全局删掉,但本闭包仍持有它们,所以宿主仍能经函数 handle 调用。
// 删桥是纵深防御的第二层,不是判罚手段:删掉之后脚本引用它们只是一次普通 `ReferenceError`。

guest[HOST_BRIDGE_SET_SNAPSHOT] = (next: Snapshot): void => {
  snapshot = next;
  pending = [];
  apiCalls = 0;
};

guest[HOST_BRIDGE_DRAIN_INTENTS] = (): DrainResult => {
  const drained = pending;
  pending = [];
  return { intents: drained, apiCalls };
};

// ── 查询函数:只读本 tick 的快照副本,不改引擎状态 ────────────────────────────

guest.getTick = (): number => {
  apiCalls += 1;
  return snapshot === null ? -1 : snapshot.tick;
};

guest.getObjectById = (id: number): Unit | Site | null => {
  apiCalls += 1;
  if (snapshot === null) {
    return null;
  }
  const unit = snapshot.units.find((candidate) => candidate.id === id);
  if (unit !== undefined) {
    return unit;
  }
  return snapshot.sites.find((candidate) => candidate.id === id) ?? null;
};

guest.getObjectsByType = (
  kind: string,
  filter?: { readonly owner?: number; readonly type?: string; readonly kind?: string },
): readonly unknown[] => {
  apiCalls += 1;
  if (snapshot === null) {
    return [];
  }
  if (kind === "unit") {
    return snapshot.units.filter(
      (unit) =>
        (filter?.owner === undefined || unit.owner === filter.owner) &&
        (filter?.type === undefined || unit.type === filter.type),
    );
  }
  if (kind === "site") {
    return snapshot.sites.filter(
      (site) =>
        (filter?.owner === undefined || site.owner === filter.owner) &&
        (filter?.kind === undefined || site.kind === filter.kind),
    );
  }
  if (kind === "player") {
    const players: readonly Player[] = snapshot.players.filter(
      (player) => filter?.owner === undefined || player.index === filter.owner,
    );
    return players;
  }
  return [];
};

guest.getRange = (ax: number, ay: number, bx: number, by: number): number => {
  apiCalls += 1;
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
};

guest.getTerrainAt = (x: number, y: number): "plain" | "wall" | "out" => {
  apiCalls += 1;
  if (snapshot === null || x < 0 || y < 0 || x >= snapshot.size || y >= snapshot.size) {
    return "out";
  }
  return snapshot.terrain[y]?.[x] === true ? "wall" : "plain";
};

guest.findPath = (sx: number, sy: number, tx: number, ty: number): readonly Point[] | null => {
  apiCalls += 1;
  if (snapshot === null) {
    return null;
  }
  return findPathInTerrain(snapshot.terrain, snapshot.size, { x: sx, y: sy }, { x: tx, y: ty });
};

// ── 动作函数:收集一条意图 + 界检查 + API 计数自增 ────────
//
// 界检查调用 `intent-verdicts.ts` 的判据——与处理器的 `check()` 是**同一份实现**。返回码是
// **即时反馈**(脚本据此决定要不要兜),而**意图照收**:判据没过的意图由引擎在结算时按同一套判据
// 再裁一次并丢弃(见 `script-outcome.ts` 的「沙箱内即时返回对应错误码,引擎在结算时按同一套界检查
// 再裁一次」)。处理器与 guest 共用同一份判据,所以「guest 说错、引擎说对」不会发生。

/** 收意图并交回即时反馈(有码就回码,静默丢弃那种回 `undefined`)。 */
const settle = (verdict: Verdict, intent: Intent): ErrResult | undefined => {
  pending.push(intent);
  if (verdict.ok || verdict.code === null) {
    return undefined;
  }
  return { code: verdict.code };
};

guest.move = (unitId: number, dx: -1 | 0 | 1, dy: -1 | 0 | 1): void | ErrResult => {
  apiCalls += 1;
  const intent: MoveIntent = { kind: "move", unitId, dx, dy };
  return settle(moveVerdict(world(), seat, intent), intent);
};

guest.moveTo = (unitId: number, x: number, y: number): void | ErrResult => {
  apiCalls += 1;
  const intent: MoveIntent = { kind: "moveTo", unitId, x, y };
  return settle(moveVerdict(world(), seat, intent), intent);
};

guest.attack = (unitId: number, targetId: number): void | ErrResult => {
  apiCalls += 1;
  const intent: AttackIntent = { kind: "attack", unitId, targetId };
  return settle(attackVerdict(world(), seat, rules, intent), intent);
};

guest.harvest = (unitId: number, siteId: number): void | ErrResult => {
  apiCalls += 1;
  const intent: HarvestIntent = { kind: "harvest", unitId, siteId };
  return settle(harvestVerdict(world(), seat, rules, intent), intent);
};

guest.transfer = (unitId: number): void | ErrResult => {
  apiCalls += 1;
  const intent: TransferIntent = { kind: "transfer", unitId };
  return settle(transferVerdict(world(), seat, rules, intent), intent);
};

guest.spawnUnit = (baseId: number, unitType: string): void | ErrResult => {
  apiCalls += 1;
  // 兵种名是字符串字面量联合;运行时(真沙箱交出的是 JSON)可能收到别的值,故在缝上再判一次。
  if (!isUnitType(unitType)) {
    return { code: "ERR_BAD_ARGS" };
  }
  const intent: SpawnIntent = { kind: "spawnUnit", baseId, unitType };
  return settle(spawnVerdict(world(), seat, rules, intent), intent);
};

// ── 座位自认:脚本唯一的「我是几号」来源 ───────────────────────────────────────

guest.getMyIndex = (): PlayerIndex => seat;

// ── 错误判别 helper:把动作函数的返回值拆成可判的两步 ─────────────────────────

guest.isError = (result: void | ErrResult): boolean =>
  result !== null && typeof result === "object";

guest.errCode = (result: void | ErrResult): IntentErrCode => (result as ErrResult).code;

// ── 错误码字符串:动作函数可能返回的那些值本身 ────────────────────────────────
//
// 名字逐条来自 `intent-verdicts.ts` 的 `INTENT_ERR_CODES`(它在引擎侧的投影),而那条投影由
// `intent-verdicts.test.ts` 与真源包符号表逐字对齐——「名字只有一个家」这条在 guest 侧的落点。

for (const code of INTENT_ERR_CODES) {
  guest[code] = code;
}
