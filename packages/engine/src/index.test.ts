/**
 * engine 包的**导出面**(hld《模块的深度》:「调用方要学的东西少于它拿到的能力」)。
 *
 * 外部缝**唯一**是 `runMatch`。先钉「恰好只有 runMatch」(正向),再钉「内部符号一个都不在」
 * (反向):两向同在,一个内部缝漏出去、或多导出一个平行入口,都会当场红。
 *
 * 用「恰好只有 runMatch」而不是「不许出现的名字清单」:清单只抓漏,不抓**多**——而
 * 「多导出一个入口」正是 ADR-0005 要避的那类平行表示。「恰好」把它也抓了。
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

it("导出面上恰好只有 runMatch 一个运行时符号", () => {
  expect(Object.keys(engine)).toEqual(["runMatch"]);
});

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
