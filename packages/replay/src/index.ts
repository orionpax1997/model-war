/**
 * replay 包:回放行格式、解析/序列化与 stateHash 原语(hld §3.1)。
 * 依赖方向单向:replay → schema,不得反向(hld §3.2)。
 * 空壳阶段只落 stateHash 原语本身;行格式与解析随回放写出路径落地。
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
