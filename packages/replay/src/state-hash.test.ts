import { expect, it } from "vitest";
import type { JsonValue } from "@model-war/schema";
import { stateHashOf } from "./index.js";

it("stateHash 是 64 位小写十六进制的 SHA-256", () => {
  expect(stateHashOf({ tick: 1 })).toMatch(/^[0-9a-f]{64}$/);
});

it("相同输入得到相同哈希,不同输入得到不同哈希", () => {
  const state: JsonValue = { tick: 7, players: [{ index: 0, resources: 3 }] };
  expect(stateHashOf(state)).toBe(stateHashOf(state));
  expect(stateHashOf(state)).not.toBe(
    stateHashOf({ tick: 8, players: [{ index: 0, resources: 3 }] }),
  );
});

it("对象键的书写顺序不影响哈希", () => {
  expect(stateHashOf({ a: 1, b: 2 })).toBe(stateHashOf({ b: 2, a: 1 }));
});

it("数组保序:顺序变了就是另一个状态", () => {
  expect(stateHashOf([1, 2])).not.toBe(stateHashOf([2, 1]));
});
