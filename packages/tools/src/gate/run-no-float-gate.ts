/**
 * 禁浮点门禁的入口:跑一遍目录薄壳,打印违规,按结果设退出码。
 *
 * 用 `node packages/tools/src/gate/run-no-float-gate.ts` 直接跑——本包以源码形式由 Node 的
 * 类型擦除执行,不产出 dist、也不设 bin(hld §3.2:唯一的 bin 在 `apps/cli`)。因此本包内部
 * 的相对 import 一律写 `.ts` 扩展名:Node 的类型擦除不做 `.js` → `.ts` 的改写,
 * 写成 `.js` 的话这里会以 ERR_MODULE_NOT_FOUND 起手。
 *
 * 退出码是这个门禁对外的全部契约:0 = 干净,1 = 有违规(或门禁本身失效)。
 */

import { relative, resolve } from "node:path";
import { checkNoFloatTree } from "./no-float-gate.ts";

/** 门禁作用域:引擎包的运行时源码(FR-2 AC3 / NFR-1,hld §2.2.3、§4.6)。 */
const ENGINE_SOURCE_DIR = "packages/engine/src";

/** 本文件在 `<repo>/packages/tools/src/gate/` 下,上溯四层是仓库根。 */
const repoRoot = resolve(import.meta.dirname, "../../../..");

const main = (): number => {
  const report = checkNoFloatTree(resolve(repoRoot, ENGINE_SOURCE_DIR));

  if (report.files === 0) {
    // 一个文件都没读到 = 目标路径写错或源码挪了窝。此时报「干净」是一条会一直绿的假门禁,
    // 比红更危险,所以按失败处理。
    process.stderr.write(
      `禁浮点门禁:${ENGINE_SOURCE_DIR} 下没有可检查的文件,门禁目标失效,按失败处理。\n`,
    );
    return 1;
  }

  for (const violation of report.violations) {
    const { file, line, column, rule, message } = violation;
    process.stdout.write(`${relative(repoRoot, file)}:${line}:${column}  ${rule}  ${message}\n`);
  }
  const summary =
    report.violations.length === 0
      ? `禁浮点门禁:检查 ${report.files} 个文件,无违规。`
      : `禁浮点门禁:检查 ${report.files} 个文件,${report.violations.length} 处违规。`;
  process.stdout.write(`${summary}\n`);
  return report.violations.length === 0 ? 0 : 1;
};

process.exitCode = main();
