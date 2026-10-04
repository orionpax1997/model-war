/**
 * 名表**读取点**的断言:D 拿到的接口长什么样、每个查询的语义是什么。
 *
 * 这里断言的是读取形态的封装(前缀判定、名单查询),**不断言任何禁令**——禁 `__*`、禁列、
 * 禁 `export`/`import` 那些规则属 D,它们会以规则层 + 退出码的形式出现,不在这里。
 *
 * 最后一条用例守的是「注入面**不被任何规则消费**」这条纪律的另一半:查询认得出表里的名字,
 * 认不出表外的名字(含类型名)。它曾是「表为空,任何查询都返回 false」的占位断言,注入面按
 * 收录判据回填后改写成现在这个形态——**意图没变**:让「表里有什么」在这里能被一眼核对,
 * 而不是靠注释说它空/不空。空表的语义不再是「还没铺」,判据已在真源侧定稿并回填。
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

it("注入面已按收录判据回填:查询认得出表里的名字,认不出表外的名字", () => {
  expect(SANDBOX_INJECTED_API_SYMBOLS.length, "判据已裁决,注入面不该退回空表").toBeGreaterThan(0);
  for (const symbol of SANDBOX_INJECTED_API_SYMBOLS) {
    expect(isSandboxInjectedSymbol(symbol), `${symbol} 应当在注入面里`).toBe(true);
  }
  expect(isSandboxInjectedSymbol("fly"), "表外的名字不在注入面里").toBe(false);
  expect(isSandboxInjectedSymbol("UnitType"), "类型名不产生运行时值,不在注入面里").toBe(false);
  expect(isSandboxInjectedSymbol("__setSnapshot"), "宿主桥不在注入面里").toBe(false);
});
