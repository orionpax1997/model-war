/**
 * 生成物的排版零件:生成头注释 + 常量声明的排版函数。
 *
 * 为什么单独成文件:每件生成物的生产函数只该写「这份清单怎么排」,不该各写一份
 * 「100 列宽怎么算单行」的判断。两件生成物各自复刻一份排版规则,分叉的时候没人会发现——
 * 而分叉的后果是每跑一次生成器就多一份与格式化器不一致的正文,`pnpm run fmt` 当场变红。
 *
 * **不复述收录判据**:判据随真源走(名单为什么是这几个,只有判据能回答)。生成物里抄一份就会漂移,
 * 而漂移的注释比没有注释更坏——读的人会以为它说的是真的。
 *
 * **这份零件是唯一的**。区块形态(一份文件里的某一段是生成物)的正文也走它,而不是另起一套宽度
 * 判断——排版规则一多就有第二份,而第二份与格式化器的分叉没人会发现,后果是每跑一次生成器就多
 * 一份与格式化器不一致的正文,`pnpm run fmt` 当场变红。
 */

/** 生成头注释。`id` 与 `truth` 都要进正文,改动等于改入库文件,漂移检查会照出来。 */
export const generatedHeader = (id: string, truth: string, note: string): string => `/**
 * 生成物——**勿手改**。
 *
 * 由 \`packages/tools/src/generate/registry.ts\` 里登记的 \`${id}\` 从 \`@model-war/schema\` 产出。
 * 改真源后跑 \`pnpm run generate\`(脚本自带一次 \`tsc -b\` 前置:生成器 import 真源包)。
 * 手改这里会在下一次生成时被原样覆盖,并被生成物漂移检查判红。
 *
 * 真源:\`${truth}\`。${note}
 *
 * 为什么规则层读的是本文件而不是直接 import 真源包:快门禁必须零构建,
 * 分界线与实测数字见 \`packages/tools/src/generate/registry.ts\` 的头注。
 */`;

/**
 * 复刻 `.oxfmtrc.json` 的 `printWidth`,用来决定数组落单行还是一项一行。
 *
 * 生成物要入库、要过格式门禁,所以它的形态必须就是 oxfmt 会产出的形态。这里刻意不 shell out
 * 调 `oxfmt`(生成器因此不必依赖格式化器):复刻一旦与 oxfmt 分叉,`pnpm run fmt` 会当场变红,
 * 那是提示改这个函数,不是提示手改生成物。
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

/** 一条带文档注释的 `readonly string[]` 常量声明。 */
export const documentedArray = (doc: string, name: string, items: readonly string[]): string =>
  `/** ${doc} */\n${arrayDeclaration(name, items)}`;

/** 一条带文档注释的 `string` 常量声明。取值用 `JSON.stringify` 写出,与数组项同一套引号形态。 */
export const documentedString = (doc: string, name: string, value: string): string =>
  `/** ${doc} */\nexport const ${name}: string = ${JSON.stringify(value)};`;

/**
 * 一格 Markdown 表格单元。**竖线要转义**,否则一条带竖线的说明或签名会把整张表拆成两列。
 *
 * 它属于排版零件而不属于任何一件生产函数:契约文档的表格由真源包的数据渲染,而那些数据里有竖线
 * 是常事(签名里的联合类型、字面量联合)。每件生产函数各写一份 `replaceAll` 的话,分叉时没人会
 * 发现——而分叉的后果是一张表在某一格处悄悄断成两列。
 *
 * 换行不可能出现(说明与签名都是单行常量),所以不必处理它;真出现时先改真源那一侧。
 */
export const tableCell = (text: string): string => text.replaceAll("|", "\\|");
