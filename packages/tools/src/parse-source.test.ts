import { expect, it } from "vitest";
import { parseSource } from "./index.ts";

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
  const outcome = parseSource('// 中文注释占用多字节\nlet a = 1;\nlet b = ;\n', "script");
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

/**
 * 上面那条非 ASCII 用例**钉不住**偏移口径:出错处另起一行,行号与列号都与偏移口径无关。
 * 这条才钉得住——非 ASCII 与出错处在**同一行**,列号在「字符偏移」与「UTF-8 字节偏移」两种
 * 解释下差 5(24 vs 29)。把 `positionAt` 改成按 `Buffer.byteLength` 算列,本条会红;
 * 只看行号的那条不会变。
 */
it("同一行内非 ASCII 之后的列号按字符偏移计(而非字节)", () => {
  const outcome = parseSource('const 名 = "中"; let b = ;\n');
  expect(outcome.ok).toBe(false);
  if (outcome.ok) {
    return;
  }
  expect(outcome.errors[0]?.line).toBe(1);
  expect(outcome.errors[0]?.column).toBe(24);
});
