/**
 * 「声明即依赖」门禁的目录遍历 + manifest 读取:纯规则层之上的薄壳。
 *
 * ── 这道门禁为什么存在(而不是让 depcruise 顺手管了) ──
 * 本包(`packages/tools`)**有意**留在 dependency-cruiser 的巡航范围之外:它以源码形态由 Node 的
 * 类型擦除执行,`emitDeclarationOnly`,`dist` 里没有 `.js`,而本仓库的 TypeScript 7 没有 JS 编程 API
 * (`transpileModule` 不存在),depcruise 又把可用编译器硬编码为 `>=2.0.0 <7.0.0`——直接巡航 `src`
 * 得到的是「0 modules, 0 dependencies」+ exit 0 的**假绿**(`.dependency-cruiser.js` 顶部有实测记录)。
 * 所以巡航入口是各包的 `dist`,而本包不在其中。这是**取舍不是疏漏**:本包产 JS 就要让快门禁付一次构建,
 * 而快门禁必须零构建(hld §2.2.1 里 Node 下限取 22.18 的成因之一,ADR-0003 里那组实测数字)。
 *
 * 代价有两块,本门禁只补其中一块,另一半明确记在 `.dependency-cruiser.js` 头注里:
 *   - **第三方依赖面(本门禁管)**:`src` 里 import `oxc-parser` / `vitest` / `ajv` 而 package.json
 *     一个都没声明,`tsc -b` 照样退出 0(模块解析一路向上找 `node_modules`,workspace 根把
 *     devDependency 摆平了)。仓库此刻正吃着这条:`src/parse-source.ts` import `oxc-parser`。
 *   - **包图方向(本门禁不管)**:`@model-war/*` 的引用仍靠 tsc 的 TS2307 兜(只软链已声明的包)。
 *     而「声明了但方向反了」(真源包反向 import 工具包)编译器拦不住,仍靠规范。
 *
 * 门禁作用域:本包的**运行时源码**(测试与属性测试豁免,理由同 hld §3.2:门禁约束的是运行时代码)。
 */

import { readFileSync } from "node:fs";

import {
  undeclaredDependencyViolations,
  type DeclaredDepsViolation,
} from "../rules/declared-deps.ts";
import { runtimeSourceFilesIn } from "./source-tree.ts";

/** 一条违规,外加它来自哪个文件。 */
export type FileDeclaredDepsViolation = DeclaredDepsViolation & { readonly file: string };

export type DeclaredDepsTreeReport = {
  /** 实际检查了几个文件。目标路径写错时会读到 0——上层必须把它当失败,不能当干净。 */
  readonly files: number;
  readonly violations: readonly FileDeclaredDepsViolation[];
};

/**
 * 从 `package.json` 读出本包**已声明**的依赖名集合。
 *
 * 只收 `dependencies`,不收 `devDependencies`,理由见 `rules/declared-deps.ts` 的头注:本包没有构建
 * 步骤,整份源码由 Node 直接执行,所以运行时 import 的每个包都是运行时依赖。测试文件要的
 * vitest / fast-check 走根 devDependency,由目录薄壳的测试豁免负责。
 *
 * 读文件失败直接抛出:门禁不能靠「读不到 manifest ⇒ 零依赖 ⇒ 全绿」蒙过去。
 */
export const readDeclaredPackageNames = (manifestPath: string): ReadonlySet<string> => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return new Set(Object.keys(manifest.dependencies ?? {}));
};

/** 遍历 `root` 下的运行时源码,逐个跑纯函数,回传违规。 */
export const checkDeclaredDepsTree = (
  root: string,
  declared: ReadonlySet<string>,
): DeclaredDepsTreeReport => {
  const files = runtimeSourceFilesIn(root);
  const violations: FileDeclaredDepsViolation[] = [];
  for (const file of files) {
    for (const violation of undeclaredDependencyViolations(readFileSync(file, "utf8"), declared)) {
      violations.push({ ...violation, file });
    }
  }
  return { files: files.length, violations };
};
