/**
 * replay 包:回放的解析/序列化(stateHash 原语)+ 回放**文件格式版本**常量(hld §3.1)。
 * 依赖方向单向:replay → schema,不得反向(hld §3.2)。
 *
 * 行的**形状**归真源包 `packages/schema` 所有(hld §7.5,ADR-0003):meta / tick / result
 * 三行的类型与 JSON Schema 在那里,本包只做编解码、不再声明行的类型,故这里不复述字段。
 * 唯一留在本包的是 `CURRENT_SCHEMA_VERSION`——它是回放**文件格式的版本**,不是行的形状。
 *
 * 空壳阶段只落 stateHash 原语本身;行格式的编解码随回放写出路径落地。
 */

import { createHash } from "node:crypto";
import type { JsonValue } from "@model-war/schema";

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
