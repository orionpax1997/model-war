import { expect, it } from "vitest";
import { moduleSystemViolations } from "../index.ts";

/**
 * 断言对象只有一件事:一段源码进,一组带行列的违规出。
 *
 * 内部实现(遍历方式、形态怎么归类、文案怎么措辞)都可以整块换掉而让这些断言继续成立。
 * 快照测试与覆盖率门禁在 hld §2.2.4 里被禁,这里两条都不碰。
 *
 * 五种形态(hld §6.2 的模块系统一行)每一种都有一个能被弄红的反例,那是这张票的验收纪律:
 * 一条判不出红的规则与没有规则是同一件东西。
 */

/** 把违规收成「类别 @ 行列」,比逐字段断言短,且违规文本的措辞改动不必连带改测试。 */
const where = (source: string): readonly string[] =>
  moduleSystemViolations(source).map(
    (violation) => `${violation.rule} @ ${violation.line}:${violation.column}`,
  );

it("干净源码无违规", () => {
  const source = `function loop() {
  let n = 0;
  for (let i = 0; i < 8; i += 1) {
    n += Math.floor(i / 2);
  }
  return n;
}
loop();
`;
  expect(moduleSystemViolations(source)).toEqual([]);
});

it.each([
  ["静态 export", "export const a = 1;\n", "module-system @ 1:1"],
  ["export function", "export function loop() { return 1; }\n", "module-system @ 1:1"],
  ["export default", "export default 1;\n", "module-system @ 1:1"],
  ["具名再导出", "const a = 1;\nexport { a };\n", "module-system @ 2:1"],
  ["export *", "export * from 'x';\n", "module-system @ 1:1"],
  ["静态 import 默认导入", 'import x from "std";\n', "module-system @ 1:1"],
  ["静态 import 具名导入", 'import { a } from "std";\n', "module-system @ 1:1"],
  ["静态 import 副作用导入", 'import "std";\n', "module-system @ 1:1"],
  ["动态 import()", 'const p = import("std");\n', "module-system @ 1:11"],
  ["require()", 'const r = require("std");\n', "module-system @ 1:11"],
  ["require() 的 globalThis 等价写法", 'globalThis.require("std");\n', "module-system @ 1:1"],
  ["动态 eval()", "eval(s);\n", "module-system @ 1:1"],
  ["动态 eval() 的 globalThis 等价写法", "globalThis.eval(s);\n", "module-system @ 1:1"],
  ["无参 eval 算动态", "eval();\n", "module-system @ 1:1"],
  ["模板串含插值的 eval 算动态", "eval(`1${s}`);\n", "module-system @ 1:1"],
  ["字符串拼接的 eval 算动态:判据不做常量折叠", 'eval("1" + "1");\n', "module-system @ 1:1"],
  [
    "函数体里的模块语法照样判",
    "function loop() {\n  export const a = 1;\n}\n",
    "module-system @ 2:3",
  ],
  ["TS 的 import x = require(...)", 'import fs = require("fs");\n', "module-system @ 1:1"],
  ["TS 的 export = x", "const a = 1;\nexport = a;\n", "module-system @ 2:1"],
])("五种形态判违规:%s", (_case, source, expected) => {
  expect(where(source)).toEqual([expected]);
});

it.each([
  ["静态 eval:被求值的文本编译期就写定了", 'eval("1+1");\n'],
  ["静态 eval 的 globalThis 等价写法", 'globalThis.eval("1+1");\n'],
  ["别的对象上的同名方法不是全局 eval", "a.eval(s);\n"],
  ["别的对象上的同名方法不是 require", 'a.require("std");\n'],
  ["对象字面量里当键的 eval / require 不是调用", "const o = { eval: f, require: g };\n"],
  ["类上的同名方法不是全局 eval", "class A { eval() { return 1; } }\n"],
  ["名字里带 eval 的其它标识符不误伤", "const evaluated = evaluate(1);\n"],
])("合规写法放行:%s", (_case, source) => {
  expect(moduleSystemViolations(source)).toEqual([]);
});

it("违规文本面向模型:点名那个形态,并说清改什么", () => {
  const cases: readonly [string, readonly string[]][] = [
    ["export const a = 1;\n", ["export"]],
    ['import { a } from "std";\n', ["import"]],
    ['const p = import("std");\n', ["import()"]],
    ['const r = require("std");\n', ["require"]],
    ["eval(s);\n", ["eval"]],
  ];
  for (const [source, named] of cases) {
    const [violation] = moduleSystemViolations(source);
    // 面向模型层是这句话的第一职责(user story 3):文本里必须能看出是**哪一个形态**被拒了。
    for (const form of named) {
      expect(violation?.message, source).toContain(form);
    }
    expect(violation?.message, source).toContain("请把");
    expect(violation?.blocking, source).toBe(true);
  }
});

it("裁决可读:动态 eval 的诊断里说清静态形式为何不拦", () => {
  // 这条验收项要求「静态形式为何不拦」在诊断里读得出来,而不只写在代码注释里:
  // 模型打算改用 `eval(\"…\")` 绕过去时,它在编译期就该读到为什么不受理。
  const [violation] = moduleSystemViolations("eval(s);\n");
  expect(violation?.message).toContain("运行期才确定");
  expect(violation?.message).toContain("不拦");
  expect(violation?.message).toContain("编译期就写定");
});

it("同源:同一个位置的多种形态各报各的,判定链那一层负责全序", () => {
  // 一个 `export` 里同时列两个名字,只报一条(判据是**节点**不是**名字`);
  // 逐条报出来会让同一处笔误占掉渲染层的一整行位置列表。
  expect(where("const a = 1;\nexport { a, a };\n")).toEqual(["module-system @ 2:1"]);
});

it("解析不过时本规则不报违规:那条结论归判定链独占", () => {
  // 与禁列规则同一条纪律:同一件事有两个家,调用方拿到的会是两条互相矛盾的违规。
  expect(moduleSystemViolations("function loop() { const a = ; }\n")).toEqual([]);
});
