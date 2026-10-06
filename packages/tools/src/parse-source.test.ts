import { expect, it } from "vitest";
import { parseSource } from "./index.ts";

it("合法的 module 源码通过", () => {
  expect(parseSource("export const answer = 42;\n")).toEqual({ ok: true });
});

it("合法的 script 源码通过(script 源形态 = 编译后的 JS)", () => {
  expect(parseSource("function loop() {}\n", "script")).toEqual({ ok: true });
});

/**
 * 收紧的两侧都钉住,缺任何一侧这组用例都只钉了一半:
 *
 * - 下面这组**拒 TS 注解**。它是本文件从「宽松」翻到「与入口契约同宽」的那一面。
 * - 上面那条**放行编译后的 JS**。只钉拒绝侧的话,把 `script` 形态整个判死(连干净 JS 一起拒)
 *   同样能变绿——那是误伤,失效方向与本组要消除的相反。
 *
 * 八种形态逐条列出来而不是只写一种:解析器对 TS 注解的拒绝面**不是**「凡 TS 皆拒」这一条
 * 公理,而是逐种形态各自的结果(实测 2026-10-04,oxc-parser 0.152.0,探针不落库)。
 * 少列几种,就会留下「换个注解写法又钻进来」的口子而没人发现。
 */
it("带 TS 注解的 script 源码被拒——校验器的源形态只有编译产物", () => {
  const annotated = [
    "function loop(): void {}\n", // 返回类型标注
    "function loop(a?: number) {}\n", // 可选形参
    "const m = new Map<number, number>();\n", // 泛型实参
    "const a = (1 as number) + 1;\n", // as 断言
    "const a = b!.c;\n", // 非空断言
    "interface Shape { x: number }\n", // interface 声明
    "enum Kind { A = 1 }\n", // enum 声明
    "function id<T>(x: T): T { return x; }\n", // 泛型函数
  ];
  expect(annotated.map((source) => parseSource(source, "script").ok)).toEqual(
    annotated.map(() => false),
  );
});

it("同段 TS 注解在 module 源形态下仍然通过——收紧只落在 script 一侧", () => {
  // 反向钉:防止有人把收紧做成「解析层一律不认 TS」。仓库自身源码就是 TS,
  // 那样一刀下去禁浮点门禁与声明依赖门禁会同时失效,而它们读的是 module 形态。
  expect(parseSource("function loop(): void {}\n")).toEqual({ ok: true });
  expect(parseSource("const a = (1 as number) + 1;\n")).toEqual({ ok: true });
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
