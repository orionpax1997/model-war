/**
 * replay 包:回放的解析/序列化(stateHash 原语)+ 回放**文件格式版本**常量(hld §3.1)。
 * 依赖方向单向:replay → schema,不得反向(hld §3.2)。
 *
 * 行的**形状**归真源包 `packages/schema` 所有(hld §7.5,ADR-0003):meta / tick / result
 * 三行的类型与 JSON Schema 在那里,本包只做编解码、不再声明行的类型,故这里不复述字段。
 * 唯一留在本包的是 `CURRENT_SCHEMA_VERSION`——它是回放**文件格式的版本**,不是行的形状。
 *
 * 写方向的编解码随写出路径落地,读方向是 `renderReplay`(它住在本包的理由见该文件头注)。
 *
 * ── 下面这一组再导出:真源包类型面的「传递」,不是本包的新声明 ──
 *
 * 依赖方向是 `schema ← replay ← engine`(hld §3.2),而 `engine` 的 manifest 上只声明了本包。
 * 于是凡引擎要用到的真源包形状(规则集 / 地图 / `JsonValue`)都从这里取,而不是让引擎直接
 * import `@model-war/schema`——那要么在引擎的 manifest 上加一条依赖,要么依赖一条未被声明的
 * 依赖恰好被提升到根 `node_modules`,后者在干净克隆里会当场变成 TS2307。
 * 每一项都是**原样再导出**,没有一处重声明:形状仍然只有一个家,本包只是那条路上的中转。
 */

import { createHash } from "node:crypto";
import type { JsonValue } from "@model-war/schema";

export type {
  JsonValue,
  MapDefinition,
  MapSite,
  MapSpawnUnit,
  MapVariantSlot,
  ReplayEvent,
  ReplayEventKind,
  ReplayLine,
  ReplayMetaLine,
  ReplayOutcomeReason,
  ReplayPlayer,
  ReplayPlayerRef,
  ReplayResultLine,
  ReplaySeat,
  ReplaySite,
  ReplaySiteProduction,
  ReplayTickLine,
  ReplayTickPayload,
  ReplayUnit,
  ReplayUnitType,
  Ruleset,
  RulesetVersion,
  UnitStats,
} from "@model-war/schema";

/** 回放三行的 JSON Schema。经本包中转,理由同上面的类型面。 */
export {
  REPLAY_META_LINE_JSON_SCHEMA,
  REPLAY_RESULT_LINE_JSON_SCHEMA,
  REPLAY_TICK_LINE_JSON_SCHEMA,
} from "@model-war/schema";

/** 规则集键清单的键序。与 `Ruleset` 类型同源,派生量断言遍历它。 */
export { RULESET_KEYS, RULESET_UNIT_KEYS } from "@model-war/schema";

/** 规则集版本真源(hld §7.1 三处一致)。经本包中转,理由见文件头。 */
export { RULESET_VERSION } from "@model-war/schema";

/**
 * 宿主桥前缀(hld §6.2)。**原样再导出**:沙箱执行器那一侧(票 G)与本仓引擎侧拼同一个桥名,
 * 两侧各写一个字面量 `__` 就是那套 `__*` 静态禁令漏掉的那一半。
 */
export { HOST_BRIDGE_PREFIX } from "@model-war/schema";

/**
 * 回放**文件格式**的版本(hld §7.5 末段)。跨版本兼容性以它为准(FR-9 AC2)。
 *
 * 它是格式的版本,不是行的形状:行(meta / tick / result 三类)的类型与 JSON Schema 归真源包
 * 所有(ADR-0003),本包只做编解码。取值从 1 起,格式发生不兼容变更时递增。
 */
export const CURRENT_SCHEMA_VERSION = 1;

export { renderReplay } from "./render.js";

/**
 * 对一个 tick 的规范化状态求 SHA-256(hld §4.6):哈希计算只在写出路径上,不参与结算。
 *
 * "规范化"由两件事合成,本函数各管一件:
 * - 对象键升序(见 `canonicalJsonOf`):键的书写顺序不影响哈希;
 * - 对象数组的升序由状态不变量保证(units/sites 按数值 id 升序维护,hld §4.1),本函数保序不做重排。
 */
export const stateHashOf = (state: JsonValue): string =>
  createHash("sha256").update(canonicalJsonOf(state)).digest("hex");

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

/** 键排序的规范化 JSON:对象键升序、数组保序、标量走 JSON.stringify。 */
const canonicalJsonOf = (value: JsonValue): string => {
  if (value === null) {
    return "null";
  }
  if (isJsonArray(value)) {
    return `[${value.map((item) => canonicalJsonOf(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonOf(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
};
