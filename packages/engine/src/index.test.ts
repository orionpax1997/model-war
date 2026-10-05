/**
 * engine 包的**导出面**(hld《模块的深度》:「调用方要学的东西少于它拿到的能力」)。
 *
 * 外部缝**唯一**是 `runMatch`(02b 落)。本票交付的是引擎内核,所以这张用例的作用是
 * **在 02b 合进来之前**,把「哪些东西不许漏出去」先钉住:漏出去一个符号,
 * 「跑一局」就多一条可写的路,而 ADR-0005 逐条裁掉的正是这类平行表示。
 *
 * 用「不许出现的名字清单」而不是「导出面必须恰好是这 N 个」:
 * 后者在 02b 把 `runMatch` 接进来时必然红一次,而那次红并不说明任何东西坏了。
 */

import { expect, it } from "vitest";

import * as engine from "./index.js";

/** 处理器与写出路径的**内部**缝。每一项都有「为什么不是缝」的理由,见 `index.ts` 头注。 */
const INTERNAL_SYMBOLS = [
  "processTick",
  "buildSnapshot",
  "groupIntents",
  "createEventCollector",
  "buildTickLine",
  "buildMetaLine",
  "serializeTickLine",
  "serializeMetaLine",
  "tickLinePayload",
  "stubRunner",
  "loadRuleset",
  "createInitialState",
  "fillVariantWalls",
  "apply",
] as const;

it("处理器与写出路径的内部符号一个都不在导出面上", () => {
  const exported = Object.keys(engine);
  for (const symbol of INTERNAL_SYMBOLS) {
    expect(exported, `${symbol} 是内部缝,不该出现在 engine 的导出面上`).not.toContain(symbol);
  }
});

it("六个 intent 只有一个实现,不构成缝,所以不导出", () => {
  // 把六个 intent 做成带公开接口的独立包或从 index 再导出,都是把不可替换的东西说成可替换。
  // 本票不导出它们;02b 接 `runMatch` 时也不该导出(它收的是冻结脚本,不是 intent)。
  const exported = Object.keys(engine);
  for (const symbol of ["INTENT_KINDS", "Intent", "check", "run"]) {
    expect(exported).not.toContain(symbol);
  }
});

it("当前导出面没有运行时符号(外部缝尚不存在)", () => {
  // 02b 把 `runMatch` 接进来之后,这一条要改成「恰好只有 runMatch」。
  expect(Object.keys(engine)).toEqual([]);
});
