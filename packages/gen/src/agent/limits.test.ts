/**
 * 会话级预算与守卫的单测:边界落在「恰好 80%」上,用量读法借用报告侧那份字段优先级。
 */

import { expect, it } from "vitest";

import {
  AGENT_MAX_STEPS,
  AGENT_TOTAL_WALL_CLOCK_MS,
  CONTEXT_GUARD,
  contextGuardTrips,
  inputTokensOf,
} from "./limits.js";

it("步数与总墙钟是 ADR 定的那两个量级", () => {
  expect(AGENT_MAX_STEPS).toBe(120);
  expect(AGENT_TOTAL_WALL_CLOCK_MS).toBe(1_800_000);
});

it("守卫用一对整数表达 80%:恰好到边界就触发", () => {
  expect(CONTEXT_GUARD).toEqual({ numerator: 4, denominator: 5 });
  expect(contextGuardTrips(7_999, 10_000)).toBe(false);
  expect(contextGuardTrips(8_000, 10_000)).toBe(true);
  expect(contextGuardTrips(0, 10_000)).toBe(false);
  // 大窗口上也精确:1M 的 80% 是 800000。
  expect(contextGuardTrips(799_999, 1_000_000)).toBe(false);
  expect(contextGuardTrips(800_000, 1_000_000)).toBe(true);
});

it("用量读法按报告侧的字段优先级:三家拼写各自读得到", () => {
  expect(inputTokensOf({ prompt_tokens: 11, input_tokens: 22 })).toBe(11);
  expect(inputTokensOf({ input_tokens: 22 })).toBe(22);
  expect(inputTokensOf({ promptTokenCount: 33 })).toBe(33);
});

it("读不到就是 undefined,不冒充 0(那会让守卫永不触发)", () => {
  expect(inputTokensOf(undefined)).toBeUndefined();
  expect(inputTokensOf({})).toBeUndefined();
  expect(inputTokensOf({ prompt_tokens: -1 })).toBeUndefined();
  expect(inputTokensOf({ prompt_tokens: 1.5 })).toBeUndefined();
  expect(inputTokensOf({ prompt_tokens: "11" })).toBeUndefined();
});
