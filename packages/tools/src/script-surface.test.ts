/**
 * 名表**读取点**的断言:D 拿到的接口长什么样、每个查询的语义是什么。
 *
 * 这里断言的是读取形态的封装(前缀判定、名单查询),**不断言任何禁令**——禁 `__*`、禁列、
 * 禁 `export`/`import` 那些规则属 D,它们会以规则层 + 退出码的形式出现,不在这里。
 *
 * 倒数第二条用例是**占位纪律**的断言:沙箱注入面此刻为空,空表的语义是「还没铺」而不是
 * 「什么都不许用」。它会在 G 回填那张表时变红——那是有意的:回填是一次计划内变更,
 * 让它先把这条用例改掉,比让它悄悄生效更便宜。
 */

import { expect, it } from "vitest";
import {
  FORBIDDEN_GLOBAL_NAMES,
  HOST_BRIDGE_PREFIX,
  SANDBOX_INJECTED_API_SYMBOLS,
  isForbiddenGlobalName,
  isHostBridgeSymbol,
  isSandboxInjectedSymbol,
} from "./index.ts";

it("宿主桥前缀是一个常量,不是散在各处的正则", () => {
  expect(HOST_BRIDGE_PREFIX).toBe("__");
});

it("前缀判定只认前缀,认全部带前缀的符号", () => {
  expect(isHostBridgeSymbol("__readMemory")).toBe(true);
  expect(isHostBridgeSymbol("__")).toBe(true);
  // 单下划线不是桥:那条缝一旦开,任何人写 `_private` 都会被当成桥拦下。
  expect(isHostBridgeSymbol("_readMemory")).toBe(false);
  expect(isHostBridgeSymbol("readMemory")).toBe(false);
});

it("禁列名单里的每个名字都被认出来,包括成员路径形态", () => {
  expect(FORBIDDEN_GLOBAL_NAMES).toContain("Date");
  expect(FORBIDDEN_GLOBAL_NAMES).toContain("Math.random");
  expect(FORBIDDEN_GLOBAL_NAMES).toContain("performance");
  expect(FORBIDDEN_GLOBAL_NAMES).toContain("queueMicrotask");

  for (const name of FORBIDDEN_GLOBAL_NAMES) {
    expect(isForbiddenGlobalName(name), `${name} 应当在禁列里`).toBe(true);
  }
});

it("名单外的名字不误伤", () => {
  expect(isForbiddenGlobalName("DateTime")).toBe(false);
  expect(isForbiddenGlobalName("Math.floor")).toBe(false);
  expect(isForbiddenGlobalName("setTimeout")).toBe(false);
});

it("注入面当前为空:待沙箱执行器(G)回填", () => {
  expect(SANDBOX_INJECTED_API_SYMBOLS).toEqual([]);
  expect(isSandboxInjectedSymbol("anything")).toBe(false);
});
