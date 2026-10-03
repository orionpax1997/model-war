import { expect, it } from "vitest";
import { renderViolations, type ScriptViolation } from "../index.ts";

/**
 * 断言对象是**面向模型层的那段文本**本身:它是生成管线唯一会转发给参赛脚本作者的东西
 * (生成管线只读退出码与 stdout),所以它的形状是契约,不是排版。
 *
 * 同类合并的那条用例同时在 `validate/run-validate-script.test.ts` 里从入口那一侧再钉一遍——
 * 那里钉的是「入口打出来的文本」,这里是「渲染函数怎么归并」。两处都不是内部结构的断言。
 */

const violation = (over: Partial<ScriptViolation> = {}): ScriptViolation => ({
  rule: "forbidden-global",
  message: "禁列全局名 `Date`:请改用脚本自己算得出来的量。",
  line: 2,
  column: 7,
  blocking: true,
  ...over,
});

it("没有违规时渲染成通过那一句", () => {
  expect(renderViolations([])).toBe("脚本静态校验通过:没有违规。\n");
});

it("同类合并:五条同类别违规并成一行", () => {
  const text = renderViolations([1, 2, 3, 4, 5].map((line) => violation({ line })));
  const lines = text.trimEnd().split("\n");
  // 抬头一句 + 一条合并行。逐行列出的话这里是六行。
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("5 处");
  expect(lines[1]).toContain("位置 1:7、2:7、3:7、4:7、5:7");
});

it("合并的一行里位置列表本身有序", () => {
  // 位置列表无序的话,模型挪动一处违规就会让整行文本变样,生成管线的 diff 全是噪声。
  const text = renderViolations([
    violation({ line: 9 }),
    violation({ line: 2 }),
    violation({ line: 5 }),
  ]);
  expect(text).toContain("位置 2:7、5:7、9:7");
});

it("同类别里文案不同的也并成一行:名字不靠「取第一条」被吞掉", () => {
  const text = renderViolations([
    violation({ line: 2, message: "禁列全局名 `Date`:请改用脚本自己算得出来的量。" }),
    violation({ line: 5, message: "禁列全局名 `Math.random`:请改用脚本自己算得出来的量。" }),
  ]);
  const lines = text.trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("`Date`");
  expect(lines[1]).toContain("`Math.random`");
});

it("不同类别分行,抬头句说清合并成几条", () => {
  const text = renderViolations([
    violation({ line: 2 }),
    violation({ rule: "module-system", message: "模块系统 `export`:不能有。", line: 1, column: 1 }),
  ]);
  expect(text).toContain("2 处违规,按类别合并成 2 条");
  const lines = text.trimEnd().split("\n");
  expect(lines).toHaveLength(3);
  // 按「先出现的位置」排组,所以先出现的那条在前。
  expect(lines[1]).toContain("模块系统");
  expect(lines[2]).toContain("禁列全局名");
});

it("只提示不拦:抬头句说「通过」,行首标提示", () => {
  const text = renderViolations([violation({ blocking: false })]);
  expect(text).toContain("脚本静态校验通过,但有 1 处提示(不拦截)");
  expect(text).toContain("- [提示]");
  expect(text).not.toContain("- [拦截]");
});

it("有拦截项时抬头句说未通过", () => {
  expect(renderViolations([violation()])).toContain("脚本静态校验未通过");
});

it("没有位置的违规渲染成「无位置」,不编一个 1:1", () => {
  // 体积级不是 AST 规则,它没有位置可言;硬给它一个位置只会让「这个位置是猜的」消失在数据里。
  const text = renderViolations([
    violation({
      rule: "script-size",
      line: null,
      column: null,
      blocking: false,
      message: "超出上限。",
    }),
  ]);
  expect(text).toContain("位置 无位置");
});

it("面向模型层不出现内部记号", () => {
  const text = renderViolations([violation()]);
  expect(text).not.toContain("forbidden-global");
});
