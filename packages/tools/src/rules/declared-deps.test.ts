/**
 * 「声明即依赖」规则的断言:一段源码 + 一组已声明依赖 → 一组违规。
 *
 * 断言对象与 `no-float.test.ts` 同类:纯函数的输入输出。违规的**呈现**(行号怎么算、消息怎么措辞、
 * 目录怎么遍历、退出码怎么设)不在这里断言——那些在门禁自测里以根脚本的退出码为准(spec 主缝)。
 * 快照测试与覆盖率门禁在 hld §2.2.4 里被禁,这里两条都不碰。
 */

import { expect, it } from "vitest";
import { packageNameOf, undeclaredDependencyViolations } from "../index.ts";

const declared = (...names: string[]): ReadonlySet<string> => new Set(names);

it("已声明的依赖放行", () => {
  const source = 'import { parseSync } from "oxc-parser";\nimport { join } from "node:path";\n';
  expect(undeclaredDependencyViolations(source, declared("oxc-parser"))).toEqual([]);
});

it("未声明的依赖判违规,且行列指向那条 import", () => {
  const violations = undeclaredDependencyViolations(
    'import { readFileSync } from "node:fs";\nimport { parseSync } from "oxc-parser";\n',
    declared(),
  );
  expect(violations).toHaveLength(1);
  expect(violations[0]?.rule).toBe("undeclared-dependency");
  expect(violations[0]?.specifier).toBe("oxc-parser");
  expect(violations[0]?.line).toBe(2);
  expect(violations[0]?.column).toBe(1);
  expect(violations[0]?.message).toContain("oxc-parser");
});

it.each([
  ["export … from", 'export { a } from "oxc-parser";\n'],
  ["export * from", 'export * from "oxc-parser";\n'],
  ["import type", 'import type { Program } from "oxc-parser";\n'],
  ["动态 import()", 'const p = await import("oxc-parser");\n'],
  ["require()", 'const p = require("oxc-parser");\n'],
])("四种形态都算依赖:%s", (_label, source) => {
  expect(undeclaredDependencyViolations(source, declared())).toHaveLength(1);
});

it("本包内部的相对路径引用不参与声明", () => {
  const source = 'import { walk } from "../ast.ts";\nimport { a } from "./b.ts";\n';
  expect(undeclaredDependencyViolations(source, declared())).toEqual([]);
});

it.each([
  ["node: 前缀", 'import { readFileSync } from "node:fs";\n'],
  ["不带前缀的内建模块名", 'import { readFileSync } from "fs";\n'],
  ["Node 的 imports 字段", 'import { a } from "#internal/a";\n'],
])("不参与声明:%s", (_label, source) => {
  expect(undeclaredDependencyViolations(source, declared())).toEqual([]);
});

it("子路径说明符按包名判定:声明了包就放行它的子路径", () => {
  const source = 'import { a } from "pkg/sub";\nimport { b } from "@scope/pkg/sub/deep";\n';
  expect(undeclaredDependencyViolations(source, declared("pkg", "@scope/pkg"))).toEqual([]);
});

it("workspace 包的引用同样受声明约束", () => {
  const violations = undeclaredDependencyViolations(
    'import { a } from "@model-war/engine";\n',
    declared(),
  );
  expect(violations).toHaveLength(1);
  expect(violations[0]?.message).toContain("@model-war/engine");
});

it("取不到名字的动态 import 不报(我看不见 ≠ 它没声明)", () => {
  const source = 'const name = "oxc-parser";\nconst p = await import(name);\n';
  expect(undeclaredDependencyViolations(source, declared())).toEqual([]);
});

it("语法错误被拒绝,报成违规而不是干净", () => {
  const violations = undeclaredDependencyViolations("import { a from;\n", declared());
  expect(violations).toHaveLength(1);
  expect(violations[0]?.rule).toBe("syntax-error");
});

it("同一段源码的判定稳定可复现", () => {
  const source = 'import { a } from "x";\nimport { b } from "y";\n';
  const once = undeclaredDependencyViolations(source, declared());
  const twice = undeclaredDependencyViolations(source, declared());
  expect(once).toEqual(twice);
});

it("违规按源码位置排序,可直接 diff", () => {
  const violations = undeclaredDependencyViolations(
    'import { b } from "y";\nimport { a } from "x";\n',
    declared(),
  );
  expect(violations.map((violation) => violation.specifier)).toEqual(["y", "x"]);
});

it("包名提取:相对路径与内建模块返回 undefined", () => {
  expect(packageNameOf("./x.ts")).toBeUndefined();
  expect(packageNameOf("node:fs")).toBeUndefined();
  expect(packageNameOf("fs")).toBeUndefined();
  expect(packageNameOf("pkg/sub")).toBe("pkg");
  expect(packageNameOf("@scope/pkg/sub")).toBe("@scope/pkg");
});
