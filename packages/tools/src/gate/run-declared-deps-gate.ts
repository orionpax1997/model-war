/**
 * 「声明即依赖」门禁的入口:跑一遍本包运行时源码,打印违规,按结果设退出码。
 *
 * 用 `node packages/tools/src/gate/run-declared-deps-gate.ts` 直接跑(同 `run-no-float-gate.ts`:
 * 本包以源码形式由 Node 的类型擦除执行,不产出 dist、也不设 bin,hld §3.2 的唯一 bin 在 `apps/cli`)。
 * **零构建**:这道门禁读的是源码与 `package.json`,不需要 `tsc -b` 的任何产物——
 * 与 `check:deps`(depcruise 巡航 dist,必须先构建)形成对照,也正是本包留在巡航范围之外的代价里
 * 可以被补上的那一半。理由与实测见 `declared-deps-gate.ts` 的头注与 `.dependency-cruiser.js`。
 *
 * 退出码是这个门禁对外的全部契约:0 = 干净,1 = 有违规(或门禁本身失效)。
 */

import { relative, resolve } from "node:path";
import { checkDeclaredDepsTree, readDeclaredPackageNames } from "./declared-deps-gate.ts";

/** 门禁作用域:本包的运行时源码。测试文件由目录薄壳豁免(理由见 `declared-deps-gate.ts` 头注)。 */
const PACKAGE_DIR = "packages/tools";

/** 本文件在 `<repo>/packages/tools/src/gate/` 下,上溯四层是仓库根。 */
const repoRoot = resolve(import.meta.dirname, "../../../..");

const main = (): number => {
  const packageDir = resolve(repoRoot, PACKAGE_DIR);
  const declared = readDeclaredPackageNames(resolve(packageDir, "package.json"));
  const report = checkDeclaredDepsTree(resolve(packageDir, "src"), declared);

  if (report.files === 0) {
    // 一个文件都没读到 = 目标路径写错或源码挪了窝。此时报「干净」是一条会一直绿的假门禁,
    // 比红更危险,所以按失败处理(与禁浮点门禁同一条纪律)。
    process.stderr.write(
      `声明即依赖门禁:${PACKAGE_DIR}/src 下没有可检查的文件,门禁目标失效,按失败处理。\n`,
    );
    return 1;
  }

  for (const violation of report.violations) {
    const { file, line, column, rule, specifier, message } = violation;
    const subject = specifier === "" ? "" : `  \`${specifier}\``;
    process.stdout.write(
      `${relative(repoRoot, file)}:${line}:${column}  ${rule}${subject}  ${message}\n`,
    );
  }
  const summary =
    report.violations.length === 0
      ? `声明即依赖门禁:检查 ${report.files} 个文件,已声明 ${declared.size} 个依赖,无未声明引用。`
      : `声明即依赖门禁:检查 ${report.files} 个文件,${report.violations.length} 处未声明引用。`;
  process.stdout.write(`${summary}\n`);
  return report.violations.length === 0 ? 0 : 1;
};

process.exitCode = main();
