import { expect, it } from "vitest";
import { parseSource } from "./index.js";

it("合法的 module 源码通过", () => {
  expect(parseSource("export const answer = 42;\n")).toEqual({ ok: true });
});

it("合法的 script 源码通过", () => {
  expect(parseSource("function loop(): void {}\n", "script")).toEqual({ ok: true });
});

it("语法错误被拒绝,且带行列", () => {
  const outcome = parseSource("const = ;\n");
  expect(outcome.ok).toBe(false);
  if (outcome.ok) {
    return;
  }
  expect(outcome.errors.length).toBeGreaterThan(0);
  const first = outcome.errors[0];
  expect(first?.line).toBeGreaterThanOrEqual(1);
  expect(first?.column).toBeGreaterThanOrEqual(1);
  expect(first?.message.length).toBeGreaterThan(0);
});

it("报错位置指向出错的那一行", () => {
  const outcome = parseSource("let a = 1;\nlet b = ;\n", "script");
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.errors[0]?.line).toBe(2);
  }
});

it("非 ASCII 源码的行号列号仍指向出错处", () => {
  const outcome = parseSource("// 中文注释占用多字节\nlet a = 1;\nlet b = ;\n", "script");
  expect(outcome.ok).toBe(false);
  if (outcome.ok) {
    return;
  }
  expect(outcome.errors[0]?.line).toBe(3);
  expect(outcome.errors[0]?.column).toBe(9);
});

it("同一段源码的判定稳定可复现", () => {
  expect(parseSource("export const x = 1;\n")).toEqual(parseSource("export const x = 1;\n"));
});
