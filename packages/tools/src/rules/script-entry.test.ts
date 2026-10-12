import { expect, it } from "vitest";
import {
  SCRIPT_LINT_STAGES,
  scriptEntryStage,
  scriptEntryViolations,
  validateScriptSource,
} from "../index.ts";

/**
 * 断言对象只有外部可观察的两件:一段产物被接受还是被带诊断拒绝、以及诊断里那句话在不在。
 * 判据的语义是「引擎载入产物后能不能取到可调用的 `loop`」,所以正反例各按那条语义取:
 * 引擎经 `vm.global.getProp("loop")` 取,顶层 `function` 与顶层 `var` 都取得到,
 * 顶层 `let` / `const` 落在全局词法环境里、取不到(实测见规则文件头注)。
 *
 * 上限一律显式传:取值归规则集文件,校验器不给默认值,`script-size` 才不会抢走结论。
 */

const OPTS = { maxBytes: 1_000_000, phase: "freeze" } as const;

const rules = (source: string): readonly string[] =>
  validateScriptSource(source, OPTS).map((violation) => violation.rule);

it("顶层 `function loop` 放行", () => {
  expect(rules("function loop() { return 1; }\nloop();\n")).toEqual([]);
});

it("顶层 `var loop = 函数值` 放行:引擎的 getProp 同样取得到", () => {
  expect(rules("var loop = function () { return 1; };\n")).toEqual([]);
  expect(rules("var loop = () => 1;\n")).toEqual([]);
});

it("空产物违规:这是它封的那个一路绿灯的空脚本", () => {
  // 模型回空代码围栏时,tsc 把空源码编译成 `"use strict";` 照样成功,四级静态检查都无事可查。
  const violations = scriptEntryViolations('"use strict";\n');
  expect(violations.map((violation) => violation.rule)).toEqual(["script-entry"]);
});

it("没有任何顶层 `loop` 声明即违规", () => {
  expect(rules("var x = 1;\n")).toEqual(["script-entry"]);
});

it("顶层 `let` / `const loop` 违规:它们在全局词法环境里,引擎按名字取不到", () => {
  // 契约 §1.1 写的是顶层 `function loop()`;模型另一常见写法 `const loop = () => {}` 在引擎里
  // 取不到入口(getProp 得到 undefined),所以这里拒得对,而不是误伤。
  expect(rules("const loop = () => 1;\n")).toEqual(["script-entry"]);
  expect(rules("let loop = function () { return 1; };\n")).toEqual(["script-entry"]);
});

it("顶层 `var loop` 绑的不是函数也违规", () => {
  expect(rules("var loop = 1;\n")).toEqual(["script-entry"]);
});

it("写在块里的 `function loop` 违规:不是顶层声明,取不到", () => {
  expect(rules("if (true) { function loop() {} }\n")).toEqual(["script-entry"]);
});

it("诊断面向模型:说清引擎怎么取、该写成什么样,且不出现内部记号", () => {
  const [violation] = scriptEntryViolations('"use strict";\n');
  expect(violation?.message).toContain("loop");
  expect(violation?.message).toContain("function loop()");
  expect(violation?.message).toContain("const");
  expect(violation?.message).not.toContain("script-entry");
});

it("判的是某个声明不存在,所以没有位置,且两相都拦", () => {
  const [violation] = scriptEntryViolations('"use strict";\n');
  expect(violation?.line).toBeNull();
  expect(violation?.column).toBeNull();
  expect(violation?.blocking).toBe(true);
  // 体积才分两档;没有入口的产物跑不起来,迭代期也给拦截结论。
  expect(
    validateScriptSource('"use strict";\n', { maxBytes: 1_000_000, phase: "iteration" }).every(
      (v) => v.blocking,
    ),
  ).toBe(true);
});

it("解析失败时本规则不报:那条结论归判定链独占", () => {
  expect(scriptEntryViolations("function loop() { const a = ; }\n")).toEqual([]);
});

it("判定链上的脚本入口级排在模块系统之后、体积之前", () => {
  // 顺序是裁决:入口级不吃字节数、也不与另外几级互遮,插错格没有外部可观察的等价物。
  expect(SCRIPT_LINT_STAGES[3]).toBe(scriptEntryStage);
  expect(SCRIPT_LINT_STAGES.indexOf(scriptEntryStage)).toBeGreaterThan(2);
});
