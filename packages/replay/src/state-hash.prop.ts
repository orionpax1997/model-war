import fc from "fast-check";
import { expect, it } from "vitest";
import type { JsonValue } from "@model-war/schema";
import { stateHashOf } from "./index.js";

// 两层嵌套的 JSON 值:够覆盖"键序无关在嵌套层"的命题,又不引入递归生成器。
const jsonValue: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.integer(), { maxLength: 6 }),
  fc.array(fc.dictionary(fc.string({ minLength: 1 }), fc.integer(), { maxKeys: 4 }), {
    maxLength: 3,
  }),
  fc.dictionary(fc.string({ minLength: 1 }), fc.integer(), { maxKeys: 6 }),
);

it("任意 JSON 值都得到 64 位小写十六进制", () => {
  fc.assert(
    fc.property(jsonValue, (value) => {
      expect(stateHashOf(value)).toMatch(/^[0-9a-f]{64}$/);
    }),
  );
});

it("键序无关:同一个映射不论按什么顺序写出,哈希相同", () => {
  fc.assert(
    fc.property(
      fc.dictionary(fc.string({ minLength: 1 }), fc.integer(), { maxKeys: 8 }),
      (record) => {
        const entries = Object.entries(record);
        const forward = Object.fromEntries(entries);
        const reversed = Object.fromEntries([...entries].reverse());
        expect(stateHashOf(forward)).toBe(stateHashOf(reversed));
      },
    ),
  );
});

it("键序无关在嵌套层同样成立:JSON 往返不改变哈希", () => {
  fc.assert(
    fc.property(jsonValue, (value) => {
      expect(stateHashOf(JSON.parse(JSON.stringify(value)) as JsonValue)).toBe(stateHashOf(value));
    }),
  );
});
