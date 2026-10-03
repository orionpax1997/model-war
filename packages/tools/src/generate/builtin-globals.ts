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
import type { GeneratedArtifact } from "./artifact.ts";

/** 生成物 id。它同时出现在生成头注释里,所以改了它等于改了入库文件的正文,漂移检查会照出来。 */
const ID = "builtin-globals-allowlist";

const GENERATED_HEADER = `/**
 * 生成物——**勿手改**。
 *
 * 由 \`packages/tools/src/generate/registry.ts\` 里登记的 \`${ID}\` 从 \`@model-war/schema\` 产出。
 * 改真源后跑 \`pnpm run generate\`(脚本自带一次 \`tsc -b\` 前置:生成器 import 真源包)。
 * 手改这里会在下一次生成时被原样覆盖,并被生成物漂移检查判红。
 *
 * 真源:\`packages/schema/src/builtin-globals.ts\`。收录判据的注释随真源走,不在此复述。
 *
 * 为什么规则层读的是本文件而不是直接 import 真源包:快门禁必须零构建,
 * 分界线与实测数字见 \`packages/tools/src/generate/registry.ts\` 的头注。
 */`;

/**
 * 复刻 `.oxfmtrc.json` 的 `printWidth`,用来决定数组落单行还是一项一行。
 *
 * 生成物要入库、要过格式门禁,所以它的形态必须就是 oxfmt 会产出的形态——否则每跑一次生成器
 * 就多一份与格式化器分叉的正文。这里刻意不 shell out 调 `oxfmt`(生成器因此不必依赖格式化器):
 * 复刻一旦与 oxfmt 分叉,`pnpm run fmt` 会当场变红,那是提示改这个函数,不是提示手改生成物。
 */
const PRINT_WIDTH = 100;

/** 一条 `readonly string[]` 常量声明,按宽度决定单行 / 一项一行。 */
const arrayDeclaration = (name: string, items: readonly string[]): string => {
  const signature = `export const ${name}: readonly string[] = `;
  const inline = `${signature}[${items.map((item) => JSON.stringify(item)).join(", ")}];`;
  if (inline.length <= PRINT_WIDTH) {
    return inline;
  }
  return `${signature}[\n${items.map((item) => `  ${JSON.stringify(item)},`).join("\n")}\n];`;
};

const documented = (doc: string, name: string, items: readonly string[]): string =>
  `/** ${doc} */\n${arrayDeclaration(name, items)}`;

export const builtinGlobalsAllowlist: GeneratedArtifact = {
  id: ID,
  path: "packages/tools/src/generated/builtin-globals.ts",
  produce: () =>
    [
      GENERATED_HEADER,
      `// 生成物 id:${ID}`,
      documented(
        "允许名单的 `Math` 成员表(整数闭包判据)。真源:`ALLOWED_MATH_MEMBERS`。",
        "ALLOWED_MATH_MEMBERS",
        ALLOWED_MATH_MEMBERS,
      ),
      documented(
        "非 `Math` 的内置全局名白名单。真源:`BUILTIN_GLOBAL_NAMES`,当前为空(理由见真源侧注释)。",
        "BUILTIN_GLOBAL_NAMES",
        BUILTIN_GLOBAL_NAMES,
      ),
    ].join("\n\n") + "\n",
};
