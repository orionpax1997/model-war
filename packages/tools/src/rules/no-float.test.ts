import { expect, it } from "vitest";
import { ALLOWED_MATH_MEMBERS, noFloatViolations } from "../index.ts";

/**
 * 断言对象只有一件事:一段源码进,一组违规出。
 *
 * 内部实现(遍历方式、字面量文本的判读顺序、排序)都可以整块换掉而让这些断言继续成立——
 * 换掉了也不影响本文件测的东西。快照测试与覆盖率门禁在 hld §2.2.4 里被禁,这里两条都不碰。
 */

it("全整数源码无违规", () => {
  expect(noFloatViolations("export const a = 1 + 2 * 3;\n")).toEqual([]);
});

it("小数判违规,且行列指向字面量本身", () => {
  const violations = noFloatViolations("const a = 1;\nconst b = 1.5;\n");
  expect(violations).toHaveLength(1);
  expect(violations[0]?.rule).toBe("float-literal");
  expect(violations[0]?.line).toBe(2);
  expect(violations[0]?.column).toBe(11);
  expect(violations[0]?.message).toContain("1.5");
});

it.each([
  ["1e3", "const a = 1e3;\n"],
  ["1.0", "const a = 1.0;\n"],
  ["2E2", "const a = 2E2;\n"],
  [".5", "const a = .5;\n"],
  ["5.", "const a = 5.;\n"],
  ["1.5e-3", "const a = 1.5e-3;\n"],
  ["1_0.5", "const a = 1_0.5;\n"],
])("指数/小数写法即便求值为整数也判违规:%s", (raw, source) => {
  const violations = noFloatViolations(source);
  expect(violations).toHaveLength(1);
  expect(violations[0]?.rule).toBe("float-literal");
  expect(violations[0]?.message).toContain(raw);
});

it.each([
  ["10n", "const a = 10n;\n"],
  ["大整数运算", "const a = 2n ** 64n + 1n;\n"],
  ["十六进制", "const a = 0x1f;\n"],
  ["十六进制里的 e 是数字不是指数", "const a = 0xE1;\n"],
  ["二进制", "const a = 0b1010;\n"],
  ["八进制", "const a = 0o17;\n"],
  ["数字分隔符", "const a = 1_000_000;\n"],
])("整数写法放行:%s", (_label, source) => {
  expect(noFloatViolations(source)).toEqual([]);
});

it("白名单内的 Math 成员放行", () => {
  expect(noFloatViolations("const a = Math.floor(x) + Math.abs(y) + Math.max(0, z);\n")).toEqual(
    [],
  );
});

it("白名单表与真源一致:每个成员单独用一次都干净", () => {
  for (const member of ALLOWED_MATH_MEMBERS) {
    expect(
      noFloatViolations(`const a = Math.${member}(x);\n`),
      `Math.${member} 应当在名单内`,
    ).toEqual([]);
  }
});

it.each([
  ["random", "Math.random", "const a = Math.random();\n"],
  ["sqrt", "Math.sqrt", "const a = Math.sqrt(2);\n"],
  ["pow", "Math.pow", "const a = Math.pow(2, 8);\n"],
  ["PI", "Math.PI", "const a = Math.PI;\n"],
  ["计算属性里的成员名照样判", 'Math["random"]', 'const a = Math["random"]();\n'],
  ["globalThis 等价写法", "globalThis.Math.random", "const a = globalThis.Math.random();\n"],
])("白名单外的 Math 成员判违规:%s", (_case, memberText, source) => {
  const violations = noFloatViolations(source);
  expect(violations).toHaveLength(1);
  expect(violations[0]?.rule).toBe("math-member");
  expect(violations[0]?.message).toContain(memberText);
});

it("动态下标取不到成员名,按不在名单内处理", () => {
  const violations = noFloatViolations("const a = Math[key]();\n");
  expect(violations).toHaveLength(1);
  expect(violations[0]?.rule).toBe("math-member");
  expect(violations[0]?.column).toBe(11);
});

it("别处的 .Math 不是全局 Math,不误报", () => {
  expect(noFloatViolations("const a = bag.Math.random();\n")).toEqual([]);
});

it("同一处 Math 调用里,成员与字面量各自成一条违规", () => {
  const violations = noFloatViolations("const a = Math.sqrt(1.5);\n");
  expect(violations.map((violation) => violation.rule)).toEqual(["math-member", "float-literal"]);
});

it("负号不是浮点:位置指向字面量而非负号", () => {
  const violations = noFloatViolations("const a = -1.5;\n");
  expect(violations).toHaveLength(1);
  expect(violations[0]?.column).toBe(12);
});

it("嵌套深处的违规一样抓得到", () => {
  const source = [
    "export class Sim {",
    "  step(seed: number): number {",
    "    const scale = Math.sqrt(2);",
    "    let acc = 0;",
    "    for (const unit of units) {",
    "      acc += unit.hp * 0.5;",
    "    }",
    "    return acc * scale;",
    "  }",
    "}",
    "",
  ].join("\n");
  const violations = noFloatViolations(source);
  expect(violations.map((violation) => [violation.line, violation.column, violation.rule])).toEqual(
    [
      [3, 19, "math-member"],
      [6, 24, "float-literal"],
    ],
  );
});

it("违规按源码位置排序,可直接 diff", () => {
  const source = "const a = 1.5;\nconst b = 2.5;\nconst c = 3.5;\n";
  expect(noFloatViolations(source).map((violation) => violation.column)).toEqual([11, 11, 11]);
  expect(noFloatViolations(source).map((violation) => violation.line)).toEqual([1, 2, 3]);
});

it("非 ASCII 源码的行列仍指向出错处", () => {
  const source = '// 中文注释占多字节\nconst 名字 = "😀";\nconst a = 1.5;\n';
  const violations = noFloatViolations(source);
  expect(violations).toHaveLength(1);
  expect(violations[0]?.line).toBe(3);
  expect(violations[0]?.column).toBe(11);
});

/**
 * 上一条**钉不住**偏移口径:出错处另起一行,两种口径下行列都一样。这条才钉得住——
 * 非 ASCII 与违规处在**同一行**,列号在「字符偏移」与「UTF-8 字节偏移」下差 8(26 vs 34)。
 * oxc-parser 的 `start`/`end` 是字符偏移,把 `positionAt` 改成按 `Buffer.byteLength`
 * 算列,本条会红;上一条不会变。
 */
it("同一行内非 ASCII 之后的列号按字符偏移计(而非字节)", () => {
  const violations = noFloatViolations('const 名 = "中"; const a = 1.5;\n');
  expect(violations).toHaveLength(1);
  expect(violations[0]?.line).toBe(1);
  expect(violations[0]?.column).toBe(26);
});

it("语法错误被拒绝,报成违规而不是干净", () => {
  const violations = noFloatViolations("const = ;\n");
  expect(violations).toHaveLength(1);
  expect(violations[0]?.rule).toBe("syntax-error");
  expect(violations[0]?.line).toBe(1);
  expect(violations[0]?.column).toBeGreaterThan(0);
});

it("解析不过的源码不跑规则:残树上的结论不可复现", () => {
  // 前半段有浮点,后半段有语法错误。此时结果里只有语法错误,没有 float-literal。
  const violations = noFloatViolations("const a = 1.5;\nconst b = ;\n");
  expect(violations.map((violation) => violation.rule)).toEqual(["syntax-error"]);
});

it("script 模式的参赛脚本走同一条规则", () => {
  const clean = noFloatViolations("function loop(): void {\n  const n = 1 + 2;\n}\n", "script");
  expect(clean).toEqual([]);
  const dirty = noFloatViolations("function loop(): void {\n  const n = 0.5;\n}\n", "script");
  expect(dirty).toHaveLength(1);
  expect(dirty[0]?.rule).toBe("float-literal");
  expect(dirty[0]?.line).toBe(2);
});

it("同一段源码的判定稳定可复现", () => {
  const source = "const a = Math.sqrt(1.5) + 2n + 3;\n";
  expect(noFloatViolations(source)).toEqual(noFloatViolations(source));
});
