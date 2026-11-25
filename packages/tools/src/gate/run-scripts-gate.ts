/**
 * 命名规范门禁的入口:读 `package.json` 与 `docs/hld.md` §2.2.7,打印违规,按结果设退出码。
 *
 * 用 `node packages/tools/src/gate/run-scripts-gate.ts` 直接跑(同 `run-no-float-gate.ts`:
 * 本包以源码形式由 Node 的类型擦除执行,相对 import 一律写 `.ts`)。
 *
 * 退出码是这个门禁对外的全部契约:0 = 干净,1 = 有违规(或判据本身失效)。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scriptsGateFindings } from "./scripts-gate.ts";
import { vacuousReason } from "./vacuous.ts";

/** 本文件在 `<repo>/packages/tools/src/gate/` 下,上溯四层是仓库根。 */
const repoRoot = resolve(import.meta.dirname, "../../../..");

const main = (): number => {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = manifest.scripts ?? {};

  // 一条脚本都没读到 = 判据在空集合上通过,那是一条会一直绿的假门禁。按失败处理。
  const vacuous = vacuousReason(Object.keys(scripts).length, {
    subject: "package.json 的命名脚本",
    scope: "package.json#scripts",
  });
  if (vacuous !== "") {
    process.stderr.write(`命名规范门禁:${vacuous}\n`);
    return 1;
  }

  const hldText = readFileSync(resolve(repoRoot, "docs/hld.md"), "utf8");
  const findings = scriptsGateFindings({ scripts, hldText });

  for (const finding of findings) {
    process.stdout.write(`${finding.where}  ${finding.detail}\n`);
  }
  const summary =
    findings.length === 0
      ? `命名规范门禁:检查 ${Object.keys(scripts).length} 条脚本,命名形态 / 层脚本串联 / project 字面量 / 层表四项无违规。`
      : `命名规范门禁:检查 ${Object.keys(scripts).length} 条脚本,${findings.length} 处违规。`;
  process.stdout.write(`${summary}\n`);
  return findings.length === 0 ? 0 : 1;
};

process.exitCode = main();
