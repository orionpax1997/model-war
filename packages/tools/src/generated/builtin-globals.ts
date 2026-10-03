/**
 * 生成物——**勿手改**。
 *
 * 由 `packages/tools/src/generate/registry.ts` 里登记的 `builtin-globals-allowlist` 从 `@model-war/schema` 产出。
 * 改真源后跑 `pnpm run generate`(脚本自带一次 `tsc -b` 前置:生成器 import 真源包)。
 * 手改这里会在下一次生成时被原样覆盖,并被生成物漂移检查判红。
 *
 * 真源:`packages/schema/src/builtin-globals.ts`。收录判据的注释随真源走,不在此复述。
 *
 * 为什么规则层读的是本文件而不是直接 import 真源包:快门禁必须零构建,
 * 分界线与实测数字见 `packages/tools/src/generate/registry.ts` 的头注。
 */

// 生成物 id:builtin-globals-allowlist

/** 允许名单的 `Math` 成员表(整数闭包判据)。真源:`ALLOWED_MATH_MEMBERS`。 */
export const ALLOWED_MATH_MEMBERS: readonly string[] = [
  "abs",
  "ceil",
  "clz32",
  "floor",
  "imul",
  "max",
  "min",
  "round",
  "sign",
  "trunc",
];

/** 非 `Math` 的内置全局名白名单。真源:`BUILTIN_GLOBAL_NAMES`,当前为空(理由见真源侧注释)。 */
export const BUILTIN_GLOBAL_NAMES: readonly string[] = [];
