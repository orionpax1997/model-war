/**
 * 散文禁抄取值门禁的入口:读键清单源码文本抽名字,扫一遍散文面,打印命中,按结果设退出码。
 *
 * 用 `node packages/tools/src/rules/run-prose-gate.ts` 直接跑——本包以源码形式由 Node 的类型擦除
 * 执行,不产出 dist、也不设 bin(hld §3.2),因此本包内部的相对 import 一律写 `.ts` 扩展名。
 *
 * **零构建**:只 import node 内置模块与同包的纯模块,不 import `@model-war/schema`(它的 `exports`
 * 指向 `dist/`,会让快门禁依赖一次 `tsc -b`,与 hld §2.2.8 的「快门禁必须零构建」不相容)。
 * 受管参数名从 `packages/schema/src/ruleset-keys.ts` 的**源码文本**抽,理由与抽法见
 * `rules-doc-prose.ts` 的头注。
 *
 * 退出码是这个门禁对外的全部契约:0 = 干净,1 = 有违规(或门禁本身失效)。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { vacuousReason } from "../gate/vacuous.ts";
import {
  PROSE_SCANNED_DIRS,
  boundParameterNamesFrom,
  describeHandCopiedValue,
  documentsInDir,
  handCopiedValuesIn,
  keyNamesFromRulesetSource,
  proseScanTargets,
} from "../rules-doc-prose.ts";

/** 本文件在 `<repo>/packages/tools/src/rules/` 下,上溯四层是仓库根。 */
const repoRoot = resolve(import.meta.dirname, "../../../..");

/** 受管参数名的真源:键清单本体。这里只读它的源码文本,不 import 真源包(零构建)。 */
const RULESET_KEYS_SOURCE = "packages/schema/src/ruleset-keys.ts";

const main = (): number => {
  const source = readFileSync(resolve(repoRoot, RULESET_KEYS_SOURCE), "utf8");
  // 空转检测判的是**从源码文本抽出来的**键名:手写的两个派生常量名永远在,拿名字全集去数
  // 永远数不到 0,那道判定就成了一句永真的死代码。
  const keyNames = keyNamesFromRulesetSource(source);
  const names = boundParameterNamesFrom(source);
  const targets = proseScanTargets(repoRoot);

  // 防假绿:抽到 0 个键名、或某个目录条目里一份文档都没有、或扫描集整体为空,都按失败处理——
  // 此时报「干净」什么也没断言(空转检测的共享件在 `gate/vacuous.ts`)。目录条目单独判一次,
  // 是因为显式清单本身永远非空:ADR 目录被挪走时总数仍是 7,只查总数会放过它。
  const vacuous = [
    vacuousReason(keyNames.length, { subject: "键清单参数名", scope: RULESET_KEYS_SOURCE }),
    ...PROSE_SCANNED_DIRS.map((dir) =>
      vacuousReason(documentsInDir(repoRoot, dir).length, {
        subject: "散文文档",
        scope: dir.label,
      }),
    ),
    vacuousReason(targets.length, {
      subject: "被扫的散文文档",
      scope: "显式清单 + docs/adr/",
    }),
  ].filter((reason) => reason !== "");
  if (vacuous.length > 0) {
    process.stderr.write(`散文禁抄取值门禁:${vacuous.join("")}\n`);
    return 1;
  }

  const violations: string[] = [];
  for (const target of targets) {
    const file = readFileSync(resolve(repoRoot, target.path), "utf8");
    for (const hit of handCopiedValuesIn(file, names)) {
      violations.push(describeHandCopiedValue(hit, target.label));
    }
  }

  for (const violation of violations) {
    process.stdout.write(`散文禁抄取值门禁不通过:${violation}\n`);
  }
  const summary =
    violations.length === 0
      ? `散文禁抄取值门禁:检查 ${targets.length} 份文档、${names.length} 个受管参数名,无违规。`
      : `散文禁抄取值门禁:检查 ${targets.length} 份文档、${names.length} 个受管参数名,` +
        `${violations.length} 处违规。`;
  process.stdout.write(`${summary}\n`);
  return violations.length === 0 ? 0 : 1;
};

process.exitCode = main();
