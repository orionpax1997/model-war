/**
 * 禁浮点门禁的目录遍历:纯函数 `noFloatViolations` 之上的薄壳。
 *
 * spec《Testing Decisions》写明:目录遍历只是纯函数之上的一层薄壳,**不单独为它写测试**。
 * 所以本文件里没有一处「聪明的」分支——只做三件事:列出目标目录下的运行时 `.ts` 文件、
 * 逐个读出来喂给纯函数、把违规带上文件名回传。规则本身全在 `rules/no-float.ts`,
 * 被测的那一层也就是那一层。
 *
 * 作用域:引擎包的**运行时源码**。测试文件排除在外,理由与 hld §3.2 的依赖门禁同源——
 * 门禁约束的是运行时行为,而测试代码不进对局进程(引擎里出现 `1.5` 是在断言它被拒,
 * 不在结算路径上)。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { noFloatViolations, type NoFloatViolation } from "../rules/no-float.ts";

/** 一条违规,外加它来自哪个文件。 */
export type FileNoFloatViolation = NoFloatViolation & { readonly file: string };

export type NoFloatTreeReport = {
  /** 实际检查了几个文件。目标路径写错时会读到 0——上层必须把它当失败,不能当干净。 */
  readonly files: number;
  readonly violations: readonly FileNoFloatViolation[];
};

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);

/** 是否是运行时代码:`*.ts` 且不是测试/属性测试/声明文件。 */
const isRuntimeSource = (name: string): boolean =>
  name.endsWith(".ts") &&
  !name.endsWith(".test.ts") &&
  !name.endsWith(".prop.ts") &&
  !name.endsWith(".d.ts");

const sourceFilesIn = (directory: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        found.push(...sourceFilesIn(path));
      }
    } else if (isRuntimeSource(entry.name)) {
      found.push(path);
    }
  }
  // 按路径排序:目录遍历的顺序取决于文件系统,门禁的输出要能直接 diff。
  return found.sort();
};

/** 遍历 `root` 下的运行时源码,逐个跑纯函数,回传违规。文件读取失败直接抛出——门禁不能靠沉默通过。 */
export const checkNoFloatTree = (root: string): NoFloatTreeReport => {
  const files = sourceFilesIn(root);
  const violations: FileNoFloatViolation[] = [];
  for (const file of files) {
    for (const violation of noFloatViolations(readFileSync(file, "utf8"))) {
      violations.push({ ...violation, file });
    }
  }
  return { files: files.length, violations };
};
