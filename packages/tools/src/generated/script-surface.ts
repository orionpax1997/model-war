/**
 * 生成物——**勿手改**。
 *
 * 由 `packages/tools/src/generate/registry.ts` 里登记的 `script-surface-names` 从 `@model-war/schema` 产出。
 * 改真源后跑 `pnpm run generate`(脚本自带一次 `tsc -b` 前置:生成器 import 真源包)。
 * 手改这里会在下一次生成时被原样覆盖,并被生成物漂移检查判红。
 *
 * 真源:`packages/schema/src/script-surface.ts`。收录判据与逐个「为什么收」都随真源走,不在此复述。
 *
 * 为什么规则层读的是本文件而不是直接 import 真源包:快门禁必须零构建,
 * 分界线与实测数字见 `packages/tools/src/generate/registry.ts` 的头注。
 */

// 生成物 id:script-surface-names

/** 宿主桥的命名前缀。真源:`HOST_BRIDGE_PREFIX`。它与「桥函数初始化后被删除」是同一套约定。 */
export const HOST_BRIDGE_PREFIX: string = "__";

/** 禁列的确定性污染源。真源:`FORBIDDEN_GLOBAL_NAMES`。收录判据见真源侧注释。 */
export const FORBIDDEN_GLOBAL_NAMES: readonly string[] = [
  "Date",
  "Math.random",
  "performance",
  "queueMicrotask",
];

/** 沙箱注入的 API 符号表。真源:`SANDBOX_INJECTED_API_SYMBOLS`。这里交出的只是**名字**——「怎么注入」由沙箱执行器定,与这张表无关;要改名改真源并重跑生成器。 */
export const SANDBOX_INJECTED_API_SYMBOLS: readonly string[] = [
  "getTick",
  "getObjectById",
  "getObjectsByType",
  "getRange",
  "getTerrainAt",
  "findPath",
  "move",
  "moveTo",
  "attack",
  "harvest",
  "transfer",
  "spawnUnit",
  "getMyIndex",
  "isError",
  "errCode",
  "ERR_NOT_ENOUGH_RESOURCES",
  "ERR_INVALID_UNIT",
  "ERR_NOT_OWNER",
  "ERR_OUT_OF_RANGE",
  "ERR_INVALID_TARGET",
  "ERR_INVALID_SITE",
  "ERR_BAD_ARGS",
];
