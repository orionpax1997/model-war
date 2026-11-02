/**
 * 结构化内容的**规范序列化**与摘要：计划（试跑 / 选拔）的 `planSha256` 与单场身份摘要共用。
 *
 * ── 为什么要 canonical，而不是 `JSON.stringify` ──
 *
 * 摘要要覆盖「内容」而不是「书写」。对象键排序、数组保序把两者分开：同一份计划不论
 * 字段按什么顺序写出来，摘要相同；而数组里的顺序（座位、场次）本来就是内容，不能被排序吃掉。
 *
 * ── 为什么不是字节 sha256 ──
 *
 * 字节摘要（`scriptSha256` / `mapSha256` / `rulesetSha256`）回答「这份文件是不是那份文件」，
 * 逐字节比、由各调用点自己算（`apps/cli` 与 `packages/runner/src/scheduler.ts` 各留一份，
 * 不跨包共用）。本文件回答的是「这份**结构**是不是那份结构」——两者的判别对象不同，
 * 混用会把「换行多一个字节」当成「计划变了」。
 *
 * 本文件只依赖 `@model-war/schema` 的 `JsonValue`；不得 import engine（runner 的硬约束）。
 */

import { createHash } from "node:crypto";

import type { JsonValue } from "@model-war/schema";

/** 对象键排序、数组保序；不依赖 metadata 的书写键序。 */
export const canonicalJson = (value: JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Readonly<Record<string, JsonValue>>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/** `canonicalJson` 的 sha256（hex）。 */
export const hashOf = (value: JsonValue): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

/** 内容相等：经 canonical 序列化后逐字比。 */
export const same = (a: JsonValue, b: JsonValue): boolean => canonicalJson(a) === canonicalJson(b);
