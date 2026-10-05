import { expect, it } from "vitest";
import { moduleSystemViolations, parseSource } from "../index.ts";

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
  ["括号是纯分组:括住的 eval 是同一个名字", "(eval)(s);\n", "module-system @ 1:2"],
  ["多层括号同样判", "((eval))(s);\n", "module-system @ 1:3"],
  ["括号包住 globalThis 等价写法", "((globalThis.eval))(s);\n", "module-system @ 1:3"],
  ["动态 eval() 的 globalThis 等价写法", "globalThis.eval(s);\n", "module-system @ 1:1"],
  [
    "成员名走字符串下标:globalThis 上的 eval 同样拦",
    'globalThis["eval"](s);\n',
    "module-system @ 1:1",
  ],
  [
    "括号只做分组:括住的 globalThis 走字符串下标同样拦",
    '(globalThis)["eval"](s);\n',
    "module-system @ 1:1",
  ],
  ["成员名走字符串下标的 require 同样拦", 'globalThis["require"]("std");\n', "module-system @ 1:1"],
  ["无参 eval 算动态", "eval();\n", "module-system @ 1:1"],
  ["模板串含插值的 eval 算动态", "eval(`1${s}`);\n", "module-system @ 1:1"],
  ["字符串拼接的 eval 算动态:判据不做常量折叠", 'eval("1" + "1");\n', "module-system @ 1:1"],
  ["无插值模板串同样算动态:判据不做常量折叠", "eval(`1+1`);\n", "module-system @ 1:1"],
  ["括号只做分组:剥掉它不改变实参是什么,变量仍算动态", "eval((s));\n", "module-system @ 1:1"],
  ["括号只做分组:内层仍是拼接,判据不做常量折叠", 'eval(("1" + "1"));\n', "module-system @ 1:1"],
  ["括号只做分组:内层仍是含插值的模板串", "eval((`1${s}`));\n", "module-system @ 1:1"],
  [
    "函数体里的模块语法照样判",
    "function loop() {\n  export const a = 1;\n}\n",
    "module-system @ 2:3",
  ],
])("五种形态判违规:%s", (_case, source, expected) => {
  expect(where(source)).toEqual([expected]);
});

/**
 * 两种 **TS 专有**的模块写法(`import x = require(...)` 与 `export = x`)不再由本规则判。
 * 它们在产物里不存在,而它们各有一个家:
 *
 * - `tsconfig.scripts.json` 的 `module: esnext` 让 `tsc` 直接判红(实测 2026-10-04,TypeScript 7.0.2:
 *   TS1202 / TS1203),诊断由生成管线的编译步骤原样透传给模型(hld §6.2「编译」那一行);
 * - 解析层按 script 源形态(编译产物)解析,这两种写法在产物形态下是解析错误,
 *   归判定链独占的 `syntax-error`。
 *
 * 它们曾列在本规则的五形态表里,那是「源形态比入口契约宽」那阵的遗留:当时 script 形态按
 * `lang: "ts"` 解析,未经编译的 TS 源码能一路走到本规则面前。源形态收紧后本规则只看产物,
 * 这两条随源形态一起消失——但**不是**因为它们变得合法,而是没有产品能带着它们走到这里。
 * 所以本条钉的是「它们不再由本规则判」这个事实本身:改回去等于让一条规则去判一种产物里
 * 不存在的语法,而那正是票 08 要消除的方向。
 */
it.each([
  ["TS 的 import x = require(...)", 'import fs = require("fs");\n'],
  ["TS 的 export = x", "const a = 1;\nexport = a;\n"],
])("TS 专有的模块写法不在本规则域内:产物形态下它们是解析错误", (_case, source) => {
  expect(moduleSystemViolations(source)).toEqual([]);
  expect(parseSource(source, "script").ok).toBe(false);
});

it.each([
  ["静态 eval:被求值的文本编译期就写定了", 'eval("1+1");\n'],
  ["静态 eval 的 globalThis 等价写法", 'globalThis.eval("1+1");\n'],
  ["括号只做分组:剥掉它仍是编译期写定的同一段常量", 'eval(("1+1"));\n'],
  ["多层括号同样剥到字面量", 'eval((("1+1")));\n'],
  ["括号只做分组:静态 eval 走字符串下标的 globalThis 同样放行", 'globalThis["eval"]("1+1");\n'],
  ["别的对象上的同名成员走字符串下标不是全局 eval", 'o["eval"](s);\n'],
  ["括号只做分组:别的对象走字符串下标也不是全局 eval", '(o)["eval"](s);\n'],
  ["动态下标取不到成员名,按不是全局 eval 处理", "globalThis[k](s);\n"],
  ["别的对象上的同名方法不是全局 eval", "a.eval(s);\n"],
  ["括号只做分组:括住的 eval 仍然不是调用", "a((eval));\n"],
  ["括号不改变对象那一支:别的对象上的 eval 仍然不是全局 eval", "((o.eval))(s);\n"],
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
  // 一个 `export` 里同时列两个名字,只报一条(判据是**节点**不是**名字**);
  // 逐条报出来会让同一处笔误占掉渲染层的一整行位置列表。
  // 两个名字刻意取不同:重复导出名(`export { a, a }`)在 JS 形态下是解析错误
  // (TS 形态下 oxc 放行,实测 2026-10-04,oxc-parser 0.152.0),拿它当样本会在源形态收紧后
  // 整条落进 `syntax-error`,钉的就不再是「一个节点报一条」而是「解析失败独占结果」了。
  expect(where("const a = 1;\nconst b = 2;\nexport { a, b };\n")).toEqual(["module-system @ 3:1"]);
});

it("解析不过时本规则不报违规:那条结论归判定链独占", () => {
  // 与禁列规则同一条纪律:同一件事有两个家,调用方拿到的会是两条互相矛盾的违规。
  expect(moduleSystemViolations("function loop() { const a = ; }\n")).toEqual([]);
});
