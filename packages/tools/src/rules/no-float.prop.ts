/**
 * 属性测试:「只由整数构成的表达式永不合规」。
 *
 * 生成的是**表达式**而不是裸整数。若只生成 `42` 这类单个字面量,命题退化成「整数不违规」,
 * 恰好就是判据里那条最容易被改坏的一行——这样的命题恒真,测不出任何东西。下面的生成器
 * 长出的是带运算符、带括号、带白名单 `Math` 调用的表达式树。
 *
 * 属性是否恒真,靠文件末尾两条「翻脸」用例与一次现做现验的变异证明,不由本文件自证。
 */

import fc from "fast-check";
import { expect, it } from "vitest";
import { ALLOWED_MATH_MEMBERS, noFloatViolations } from "../index.ts";

/** 需要两个参数的 Math 成员:调用点要按真实 arity 拼,免得生成出 `Math.imul(x)` 这种废表达式。 */
const BINARY_MATH_MEMBERS = ["imul", "max", "min"];

/** 整数闭包的运算符:整型入、整型出。刻意不含 `/`——`1 / 3` 是运行时才产生的浮点,归属性测试的
 * 「step 输出全为整数」那条动态命题管(hld §2.2.4),不由这道字面量门禁管。 */
const INTEGER_OPERATORS = ["+", "-", "*", "%", "<<", ">>", "&", "|", "^"] as const;

const intLiteral = fc
  .integer({ min: -2_000_000_000, max: 2_000_000_000 })
  .map((value) => String(value));

/** 深度预算手写而非用 `fc.letrec`:生成器的形状是这条命题的一半,摊开写比藏在一个递归里好读。 */
const integerExpression = (depth: number): fc.Arbitrary<string> => {
  if (depth <= 0) {
    return intLiteral;
  }
  const child = integerExpression(depth - 1);
  return fc.oneof(
    { weight: 3, arbitrary: intLiteral },
    {
      weight: 2,
      arbitrary: fc
        .tuple(fc.constantFrom(...ALLOWED_MATH_MEMBERS), child)
        .map(([member, argument]) =>
          BINARY_MATH_MEMBERS.includes(member)
            ? `Math.${member}(${argument}, ${argument})`
            : `Math.${member}(${argument})`,
        ),
    },
    {
      weight: 3,
      arbitrary: fc
        .tuple(child, fc.constantFrom(...INTEGER_OPERATORS), child)
        .map(([left, operator, right]) => `(${left} ${operator} ${right})`),
    },
    { weight: 1, arbitrary: child.map((inner) => `(${inner})`) },
  );
};

// 每轮命题都要真解一遍 AST(比同仓的哈希属性测试贵),故轮数高于默认的 100。
const NUM_RUNS = 300;
const RUN_OPTIONS = { numRuns: NUM_RUNS } as const;

const wrap = (expression: string): string => `export const v = ${expression};\n`;

it("只由整数构成的表达式永不合规", () => {
  fc.assert(
    fc.property(integerExpression(3), (expression) => {
      expect(noFloatViolations(wrap(expression))).toEqual([]);
    }),
    RUN_OPTIONS,
  );
});

it("script 模式下同一条命题也成立", () => {
  fc.assert(
    fc.property(integerExpression(3), (expression) => {
      expect(noFloatViolations(`function loop() {\n  v = ${expression};\n}\n`, "script")).toEqual(
        [],
      );
    }),
    RUN_OPTIONS,
  );
});

/**
 * 命题不是恒真的第一条证据:**生成器真的长出了复杂表达式**。
 * 若它退化成只会吐裸整数,上面两条就变成了「整数不违规」——而那正是最容易被改坏的一行。
 * 这条断言把生成器本身钉住:必须同时出现运算符、括号与白名单 `Math` 调用。
 */
it("生成器长出的是表达式而不是裸整数", () => {
  const samples = fc.sample(integerExpression(3), 200);
  expect(
    samples.some((expression) =>
      INTEGER_OPERATORS.some((operator) => expression.includes(` ${operator} `)),
    ),
  ).toBe(true);
  expect(samples.some((expression) => expression.includes("("))).toBe(true);
  expect(samples.some((expression) => expression.includes("Math."))).toBe(true);
  expect(samples.some((expression) => expression.length > 12)).toBe(true);
});

/**
 * 命题不是恒真的第二条证据:**同一条判据在邻域里会翻脸**。
 * 把生成的表达式里第一个整数叶换成小数、换成白名单外的 `Math` 调用,判据必须立刻报出违规。
 * 若判据恒返回「干净」,下面两条会红;若生成器只吐裸整数,变异无从下手,也会红。
 */
it("把一个整数叶改成小数,判据必须报出违规", () => {
  fc.assert(
    fc.property(integerExpression(3), (expression) => {
      const mutated = expression.replace(/(\d+)/, "$1.0");
      expect(mutated).not.toBe(expression);
      expect(noFloatViolations(wrap(mutated)).length).toBeGreaterThan(0);
    }),
    RUN_OPTIONS,
  );
});

it("把一个整数叶改成白名单外的 Math 调用,判据必须报出违规", () => {
  fc.assert(
    fc.property(integerExpression(3), (expression) => {
      const mutated = expression.replace(/(\d+)/, "Math.sqrt($1)");
      expect(mutated).not.toBe(expression);
      expect(noFloatViolations(wrap(mutated)).length).toBeGreaterThan(0);
    }),
    RUN_OPTIONS,
  );
});
