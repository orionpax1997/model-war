import { expect, it } from "vitest";

import { compileProtocolSchema } from "./protocol-schema.js";

it("终局协议支持四元数组、分数数值及可空淘汰时间，并拒绝不完整形状", () => {
  const matches = compileProtocolSchema({
    type: "object",
    additionalProperties: false,
    required: ["points", "eliminatedAtTick", "player", "reason"],
    properties: {
      points: {
        type: "array",
        minItems: 4,
        maxItems: 4,
        items: { type: "number", minimum: 0, maximum: 3 },
      },
      eliminatedAtTick: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
      player: { type: "string", minLength: 1, maxLength: 9 },
      reason: { enum: ["timeout", "victory"] },
    },
  });
  const value = {
    points: [1.5, 1.5, 1.5, 1.5],
    eliminatedAtTick: null,
    player: "candidate",
    reason: "timeout",
  };
  expect(matches(value)).toBe(true);
  expect(matches({ ...value, eliminatedAtTick: 12 })).toBe(true);
  expect(matches({ ...value, points: [3, 2, 1] })).toBe(false);
  expect(matches({ ...value, points: [3, 2, 1, 0, 0] })).toBe(false);
  expect(matches({ ...value, points: [3, 2, Infinity, 0] })).toBe(false);
  expect(matches({ ...value, points: [3, 2, -1, 0] })).toBe(false);
  expect(matches({ ...value, points: [3, 2, "1", 0] })).toBe(false);
  expect(matches({ ...value, eliminatedAtTick: 1.5 })).toBe(false);
  expect(matches({ ...value, eliminatedAtTick: "unknown" })).toBe(false);
  expect(matches({ ...value, player: "" })).toBe(false);
  expect(matches({ ...value, player: "candidatex" })).toBe(false);
  expect(matches({ ...value, reason: "uncertain-timeout" })).toBe(false);
});

it("非法 anyOf 子 Schema 不会被当作无限制的匹配分支", () => {
  const schema = { anyOf: [{ type: "null" }] } as const;
  Reflect.set(schema.anyOf, 0, false);
  expect(() => compileProtocolSchema(schema)).toThrow("关键字取值未支持");
});

it("协议适配器对未支持的嵌套关键字和无效约束继续失败安全", () => {
  const unsupported = {
    type: "array",
    items: { type: "string", format: "date-time" },
  } as const;
  expect(() => compileProtocolSchema(unsupported)).toThrow("关键字未支持：format");
  expect(() => compileProtocolSchema({ anyOf: [] })).toThrow("关键字取值未支持");
  expect(() => compileProtocolSchema({ enum: [] })).toThrow("关键字取值未支持");
  expect(() => compileProtocolSchema({ enum: [Infinity] })).toThrow("关键字取值未支持");
  expect(() => compileProtocolSchema({ minItems: -1 })).toThrow("关键字取值未支持");
  expect(() => compileProtocolSchema({ maxLength: 1.5 })).toThrow("关键字取值未支持");
  const matches = compileProtocolSchema({ type: "string", minLength: 1, maxLength: 1 });
  expect(matches("😀")).toBe(true);
  expect(matches("😀😀")).toBe(false);
});
