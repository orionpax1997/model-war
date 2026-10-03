/**
 * 第一件生成物的生产函数:内置全局白名单 → 工具包内的生成源文件。
 *
 * **本文件是「混合传输」里 import 真源包的那一侧**(分界线见 `registry.ts` 头注):它 import
 * `@model-war/schema`(依赖图的根,方向合法),而它的产物由 `allowlist.ts` 读——规则层在
 * 「能不能 afford 构建」的另一边,所以那条边对它不成立。
 *
 * 生成物里**不复述收录判据**。判据随真源走(它连同名单是一体的:名单为什么是这十个,
 * 只有判据能回答);复述一份就会漂移,而漂移的注释比没有注释更坏——读的人会以为它说的是真的。
 */

import { ALLOWED_MATH_MEMBERS, BUILTIN_GLOBAL_NAMES } from "@model-war/schema";
import { documentedArray, generatedHeader } from "./emit.ts";
import type { GeneratedArtifact } from "./artifact.ts";

/** 生成物 id。它同时出现在生成头注释里,所以改了它等于改了入库文件的正文,漂移检查会照出来。 */
const ID = "builtin-globals-allowlist";

export const builtinGlobalsAllowlist: GeneratedArtifact = {
  id: ID,
  path: "packages/tools/src/generated/builtin-globals.ts",
  produce: () =>
    [
      generatedHeader(
        ID,
        "packages/schema/src/builtin-globals.ts",
        "收录判据的注释随真源走,不在此复述。",
      ),
      `// 生成物 id:${ID}`,
      documentedArray(
        "允许名单的 `Math` 成员表(整数闭包判据)。真源:`ALLOWED_MATH_MEMBERS`。",
        "ALLOWED_MATH_MEMBERS",
        ALLOWED_MATH_MEMBERS,
      ),
      documentedArray(
        "内置全局名白名单(不越界判据)。真源:`BUILTIN_GLOBAL_NAMES`;收录判据不在此复述。",
        "BUILTIN_GLOBAL_NAMES",
        BUILTIN_GLOBAL_NAMES,
      ),
    ].join("\n\n") + "\n",
};
