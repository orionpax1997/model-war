/**
 * 「哪些文件算运行时代码」的目录遍历:纯规则层之上的一层薄壳,两个门禁薄壳共用。
 *
 * 共用的理由不是省几行,而是**豁免口径只该有一份**:禁浮点门禁(depcruise 的测试豁免也是同一条)
 * 与依赖面门禁都排除 `*.test.ts` / `*.prop.ts`,理由都是 hld §3.2 那条:门禁约束的是运行时代码,
 * 而测试代码不进生产路径。两条门禁各写一份过滤条件,将来有人只改一份时,
 * 「哪些文件被门禁看着」就有两个答案,而没人会发现差的那一份。
 *
 * 因此本文件里没有一处「聪明的」分支:只做两件事——列出目录下的运行时 `.ts` 文件、按路径排序。
 * 排序是给门禁输出用的:目录遍历的顺序取决于文件系统,不排序就没法 diff 两次运行的输出。
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** 不进遍历的目录名:依赖树与本包自己的产物(本包以源码形态执行,dist 里只有 `.d.ts`)。 */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);

/** 是否是运行时代码:`*.ts` 且不是测试 / 属性测试 / 声明文件。 */
const isRuntimeSource = (name: string): boolean =>
  name.endsWith(".ts") &&
  !name.endsWith(".test.ts") &&
  !name.endsWith(".prop.ts") &&
  !name.endsWith(".d.ts");

const filesIn = (directory: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        found.push(...filesIn(path));
      }
    } else if (isRuntimeSource(entry.name)) {
      found.push(path);
    }
  }
  return found.sort();
};

/** 遍历 `root` 下的运行时源码,回传文件路径(按路径排序)。文件读取失败直接抛出——门禁不能靠沉默通过。 */
export const runtimeSourceFilesIn = (root: string): string[] => filesIn(root);
