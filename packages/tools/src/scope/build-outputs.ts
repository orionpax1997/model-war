/**
 * 源码路径 → 构建产物路径。
 *
 * ── 为什么需要这张映射 ──
 *
 * 依赖图里的**跨包边指向产物,不是源码**。包解析走 `exports`(指向 `dist/`),所以
 * `apps/cli` 里的 `import("@model-war/runner")` 在图上连到 `packages/runner/dist/index.js`;
 * 只有**包内**的相对 import 才连到 `src/`。而 `git diff` 给的是 `src/` 路径。
 *
 * 实测(ADR-0038):
 *
 * | 问法 | 选中 |
 * |---|---|
 * | `vitest related packages/engine/src/runner/quickjs.ts` | 7 个(全是包内) |
 * | `vitest related packages/engine/dist/runner/quickjs.js` | 11 个(含全部 `cli-*`) |
 * | `vitest related packages/schema/src/index.ts` | 40 个 |
 * | `vitest related packages/schema/dist/index.js` | 1628 个 |
 *
 * 差的那部分正好是最贵的进程级用例。所以选择器要拿**两个问法的并集**,把改动先展开成产物。
 *
 * 映射不靠约定靠读:**每个包的 `tsconfig.json` 里 `rootDir` / `outDir` 是唯一真源**。
 * 缺任意一项即抛错——这时静态映射失效,选择器会静默少选,而少选不报错。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Workspace {
  /** 仓库相对路径,如 `packages/engine`。 */
  readonly dir: string;
  /** 相对包目录,如 `src`。 */
  readonly rootDir: string;
  /** 相对包目录,如 `dist`。 */
  readonly outDir: string;
  /**
   * `emitDeclarationOnly`:只产 `.d.ts`、不产 `.js`。
   *
   * `packages/tools` 就是这种包(它由 Node 的类型擦除直接从源码执行,不产出运行时代码)。
   * 把它也映射成 `.js` 会让「产物存在吗」这条检查永远回答"不在",于是每次都退回全量——
   * 退回全量不算错,但它会把这个包的每次改动都变成 70s,而真正的原因是映射写错了。
   */
  readonly emitDeclarationOnly: boolean;
}

/** 去掉 JSON 里的 `//` 注释(tsconfig 允许注释,`JSON.parse` 不允许)。字符串内的 `//` 不动。 */
const stripComments = (text: string): string =>
  text.replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g,
    (_whole, literal: string | undefined) => literal ?? "",
  );

/**
 * 每个工作区包的编译目录。读不到就跳过(不是所有目录都是包),读到但不完整就抛。
 */
export const workspacesOf = (repoRoot: string): readonly Workspace[] => {
  const found: Workspace[] = [];
  for (const parent of ["apps", "packages"]) {
    let children: string[];
    try {
      children = readdirSync(join(repoRoot, parent));
    } catch {
      continue;
    }
    for (const child of children) {
      const configPath = join(repoRoot, parent, child, "tsconfig.json");
      if (!existsSync(configPath)) continue;
      const parsed = JSON.parse(stripComments(readFileSync(configPath, "utf8"))) as {
        compilerOptions?: { rootDir?: string; outDir?: string; emitDeclarationOnly?: boolean };
      };
      const rootDir = parsed.compilerOptions?.rootDir;
      const outDir = parsed.compilerOptions?.outDir;
      if (rootDir === undefined || outDir === undefined) {
        throw new Error(
          `${parent}/${child}/tsconfig.json 缺 rootDir 或 outDir:源码改动无法映射到构建产物。` +
            "选择器靠这条映射才能看见跨包依赖,缺了它会静默少选而不报错。",
        );
      }
      found.push({
        dir: `${parent}/${child}`,
        rootDir,
        outDir,
        emitDeclarationOnly: parsed.compilerOptions?.emitDeclarationOnly === true,
      });
    }
  }
  return found;
};

/**
 * 一个源码文件会被 `tsc -b` 产出成哪些文件。
 *
 * 只映射 `.ts`,不映射 `.json`(仓库里没有 `resolveJsonModule` 的产出一说)。`.d.ts` 也映射:
 * 它们的读者是类型测试与 `gate:types`,少映射一类就少一类边。
 */
export const buildOutputsOf = (
  path: string,
  workspaces: readonly Workspace[],
): readonly string[] => {
  for (const workspace of workspaces) {
    const prefix = `${workspace.dir}/${workspace.rootDir}/`;
    if (!path.startsWith(prefix) || !path.endsWith(".ts") || path.endsWith(".d.ts")) continue;
    const base = path.slice(prefix.length, -".ts".length);
    const declaration = `${workspace.dir}/${workspace.outDir}/${base}.d.ts`;
    return workspace.emitDeclarationOnly
      ? [declaration]
      : [`${workspace.dir}/${workspace.outDir}/${base}.js`, declaration];
  }
  return [];
};
