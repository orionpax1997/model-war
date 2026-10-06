/**
 * 移动裁决:两条移动意图(`move` / `moveTo`)的 `check()` 与 `run()`。
 *
 * 规则依据是 hld §4.4 与 `rules-v1/rules.md` §3。三条裁决的落点在这里:
 * 1. **占位基准**:一轮结算**只以该轮开始时的占位为准**。单位离开它本轮的格子,不会让那格
 *    对后来者变为可进入;同一格至多一个单位成功进入。所以「算目标」与「落子」是两个相位,
 *    本模块只做前者(算出候选),落子在步 2 的竞争裁决之后。
 * 2. **同格竞争**:目标格相同的候选按轮转优先 `(tick + playerIndex) mod 4` 取胜者(值大者胜)。
 *    这一层在步 2 做,不在本模块——本模块不知道 tick,也不知道别的候选。
 * 3. **交换/穿行/链式**:不需要任何专门裁决。B 格本轮被占,于是 A 移动失败;B 是否成功只取决于 C。
 *    由「候选只在目标格未被基准占位时才成立」一条自动得到。
 *
 * ── `check()` 与 `run()` 为什么是两相位 ──
 * 「一轮只以该轮开始时的占位为准」使「逐 intent 就地写状态」不可能成立:一个单位的移动成不成立,
 * 取决于**同时提交的其他单位**想进哪一格。于是校验/算候选与落子必须分开——`check()` 只读地判
 * 「参数在界 / 属主正确 / 目标格合法」,`run()` 在只读基准上算一个候选变更,而**唯一**的落子出口
 * 仍是 `apply()`。本模块自己不改状态,连一个可写引用都拿不到(`MovementView` 每栏 readonly)。
 */

import type { RulesetView } from "../ruleset-loader/index.js";
import type { Change } from "../driver/apply.js";
import { findPath, type Point } from "../pathfinding/index.js";
import { UNIT_TYPES, type PlayerIndex, type Terrain, type Unit } from "../world/state.js";
import type { Intent } from "./intents.js";

/** 两条移动意图。其余四条不是移动(归 05–09),本票只交付这两条。 */
export type MoveIntent = Extract<Intent, { kind: "move" | "moveTo" }>;

/** 判别 `move` / `moveTo`。收窄判别式,不靠 `as`。 */
export const isMoveIntent = (intent: Intent): intent is MoveIntent =>
  intent.kind === "move" || intent.kind === "moveTo";

/**
 * `check()` / `run()` 的只读视图。
 *
 * **类型里没有任何写入口**:它是 `GameState` 的一个结构子集,每一栏都 readonly。所以步 2
 * 可以直接把真状态传进来,而传进来的那一份在类型上改不动——「check() 不改状态」由此由类型承担,
 * 不是一句口头约定。
 */
export type MovementView = {
  readonly size: number;
  readonly terrain: Terrain;
  readonly units: readonly Unit[];
};

/** 候选变更。它就是 `apply()` 已登记的那一种 `move-unit`,所以落子不需要第二种写操作。 */
export type MoveCandidate = Extract<Change, { kind: "move-unit" }>;

/** 按数值 id 取单位。`units` 由状态不变量保证升序,但这里只用线性查找——一次一条意图,不必二分。 */
export const unitById = (view: MovementView, id: number): Unit | undefined =>
  view.units.find((unit) => unit.id === id);

const inBounds = (view: MovementView, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < view.size && y < view.size;

const isWall = (view: MovementView, x: number, y: number): boolean => view.terrain[y]?.[x] === true;

/** 本轮某个格是否被占:**以该轮开始时的占位为准**(见文件头注第 1 条)。 */
const isOccupied = (view: MovementView, x: number, y: number): boolean =>
  view.units.some((unit) => unit.x === x && unit.y === y);

/**
 * 一条意图的目标格。
 *
 * `move` 是「当前格 + 位移」,`moveTo` 是绝对坐标。`(0, 0)` 的 `move` 不表达位移,不是移动,
 * 故返回 `null` 当作无效——规则面最小:把「原地不动」写成意图与「什么都不下」应当等价,不该多一条
 * 会参与竞争裁决的候选。
 */
const moveTargetOf = (unit: Unit, intent: MoveIntent): Point | null => {
  if (intent.kind === "moveTo") {
    return { x: intent.x, y: intent.y };
  }
  if (intent.dx === 0 && intent.dy === 0) {
    return null;
  }
  return { x: unit.x + intent.dx, y: unit.y + intent.dy };
};

/**
 * `check()`:参数在界、属主正确、目标格合法,返回布尔。
 *
 * 它**不收规则集**:这三条判据里没有一条用到规则集取值(移动不花资源、不比较属性),
 * 收进来只会是一个不读的一栏。需要规则集的是 `run()`——骑兵一 tick 走几轮取决于 `speed`。
 *
 * 「目格合法」只含界内与非墙。**目标格是否被占不在此列**:被占是裁决结果(移动失败),
 * 不是「意图非法」;两者都不发事件,但语义不同,混在一处会让「为什么这条意图被丢弃」失去答案。
 */
export const checkMove = (view: MovementView, seat: PlayerIndex, intent: MoveIntent): boolean => {
  const unit = unitById(view, intent.unitId);
  if (unit === undefined) {
    return false;
  }
  if (unit.owner !== seat) {
    return false;
  }
  if (intent.kind === "move" && (Math.abs(intent.dx) > 1 || Math.abs(intent.dy) > 1)) {
    // 类型上是 -1|0|1,但运行时(真沙箱交出的是 JSON)可能收到别的数,故在缝上再判一次。
    return false;
  }
  const target = moveTargetOf(unit, intent);
  if (target === null) {
    return false;
  }
  if (!inBounds(view, target.x, target.y) || isWall(view, target.x, target.y)) {
    return false;
  }
  return true;
};

/** 目标格未被基准占位就产出一个候选;被占则本轮移动失败(交换/穿行/链式全靠这一条)。 */
const candidateInto = (view: MovementView, unit: Unit, target: Point): MoveCandidate | null => {
  if (isOccupied(view, target.x, target.y)) {
    return null;
  }
  return { kind: "move-unit", unitId: unit.id, x: target.x, y: target.y };
};

/**
 * `run()`:在只读基准上算一个候选变更,或「不成立」(`null`)。
 *
 * `round` 是本 tick 的第几轮移动(从 0 起)。骑兵的二次移动(hld §4.4)落在这里:兵种 `speed`
 * 为 2 的单位在 `round = 0/1` 都能走,为 1 的只在 `round = 0` 能走——所以规则集是**真读**了一栏
 * (`speed`),不是收下不看的参数。
 *
 * `move` 的目标是当前格 + 位移;`moveTo` 用**与脚本 `findPath` 同一实现**现算一条路,
 * 取本 tick 的那一步(路径不跨 tick、也不跨轮缓存——与 hld §4.7「每 tick 重算」一致)。
 * 目标格被占(或 `moveTo` 的下一格被占)时返回 `null`:本轮移动失败,不尝试次优目标。
 */
export const runMove = (
  view: MovementView,
  seat: PlayerIndex,
  ruleset: RulesetView,
  round: number,
  intent: MoveIntent,
): MoveCandidate | null => {
  if (!checkMove(view, seat, intent)) {
    return null;
  }
  const unit = unitById(view, intent.unitId);
  if (unit === undefined) {
    return null;
  }
  // 这一轮该单位还走不走得动:骑兵 2 轮,其余 1 轮。第 N 轮的基准由调用点换(见步 2)。
  if (ruleset.statsOf(unit.type).speed <= round) {
    return null;
  }
  const target = moveTargetOf(unit, intent);
  if (target === null) {
    return null;
  }
  if (intent.kind === "move") {
    return candidateInto(view, unit, target);
  }
  const path = findPath(view.terrain, view.size, { x: unit.x, y: unit.y }, target);
  if (path === null || path.length < 2) {
    return null;
  }
  return candidateInto(view, unit, path[1]!);
};

/**
 * 一个 tick 里移动几轮 = 全场最大 `speed`(hld §4.4 的骑兵二次移动)。
 *
 * 「重复整轮结算一次」落到实现上就是「每轮重跑同一套裁决,第 N 轮的基准是第 N−1 轮结算之后的状态」;
 * 而 worker/melee/ranged 的 `speed` 是 1,它们只在第 0 轮参与,第 1 轮不参与。步 2 按
 * 「这一轮该单位还走不走得动」逐条过滤,而不是把四个座位一起再走一遍。
 * 轮转优先里的 `tick` 值两轮相同——步 2 用的是 `state.tick`,它在步 6 才加一。
 */
export const maxMoveRounds = (ruleset: RulesetView): number =>
  Math.max(...UNIT_TYPES.map((type) => ruleset.statsOf(type).speed));
