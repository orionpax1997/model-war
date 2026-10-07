/**
 * 预算键结构门禁的入口:读真源(取值文件 + 键清单源码 + 引擎常量源码 + 文档文本),跑一遍纯函数,
 * 打印不通过项,按结果设退出码。
 *
 * 用 `node packages/tools/src/gate/run-budget-gate.ts` 直接跑——本包以源码形式由 Node 的类型擦除
 * 执行,不产出 dist、也不设 bin(hld §3.2),因此本包内部的相对 import 一律写 `.ts` 扩展名。
 *
 * **零构建**:只 import node 内置模块与同包的冻结常量模块,不 import `@model-war/schema`、
 * 更不 import 引擎(hld §3.2 禁)。所有需要真源的地方都改成读源码/数据文本,判据见
 * `budget-gate.ts` 的头注。
 *
 * 退出码是这个门禁对外的全部契约:0 = 干净,1 = 有违规(或门禁本身失效)。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  HONEST_ALIVE_HEAP_PEAK_BYTES,
  INTERRUPT_EVERY_EVENTS,
} from "../sandbox-probes/constants.ts";
import { checkBudget } from "./budget-gate.ts";

/** 本文件在 `<repo>/packages/tools/src/gate/` 下,上溯四层是仓库根。 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const RULESET_JSON = "rulesets/v1.json";
const RULESET_KEYS_SOURCE = "packages/schema/src/ruleset-keys.ts";
const RULESET_SOURCE = "packages/schema/src/ruleset.ts";
const QUICKJS_SOURCE = "packages/engine/src/runner/quickjs.ts";
const HLD_DOC = "docs/hld.md";
const BENCHMARKS_DIR = "benchmarks";

const read = (relative: string): string => readFileSync(`${repoRoot}${relative}`, "utf8");

/**
 * 基准产物的字节数。**与 `check:selfproof` 用的是同一批文件**(`benchmarks/<cell>/script.js`),
 * 但这里现算而不抄常量:算出来的最大值是 `scriptSizeLimit` 的硬下界,抄一份就会与磁盘分叉。
 * 读目录而不另列名字清单:多列一份 `BENCHMARK_NAMES` 就是多一处会悄悄过期的真源。
 */
const benchmarkArtifactSizes = (): readonly number[] => {
  const dir = `${repoRoot}${BENCHMARKS_DIR}`;
  const sizes: number[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const product = `${dir}/${entry.name}/script.js`;
    if (existsSync(product)) {
      sizes.push(readFileSync(product).byteLength);
    }
  }
  return sizes;
};

const main = (): number => {
  const ruleset = JSON.parse(read(RULESET_JSON)) as Record<string, unknown>;
  const budgetValues: Record<string, number | undefined> = {};
  for (const [key, value] of Object.entries(ruleset)) {
    if (typeof value === "number") {
      budgetValues[key] = value;
    }
  }

  const artifactSizes = benchmarkArtifactSizes();
  const report = checkBudget({
    budgetValues,
    rulesetKeysSource: read(RULESET_KEYS_SOURCE),
    rulesetSource: read(RULESET_SOURCE),
    quickjsSource: read(QUICKJS_SOURCE),
    hldSource: read(HLD_DOC),
    interruptEveryEvents: INTERRUPT_EVERY_EVENTS,
    honestAliveHeapPeakBytes: HONEST_ALIVE_HEAP_PEAK_BYTES,
    maxBenchmarkArtifactBytes: artifactSizes.length === 0 ? 0 : Math.max(...artifactSizes),
    benchmarkArtifacts: artifactSizes.length,
  });

  // 防假绿:读到 0 个预算键、或 0 个已定稿的预算键,都按失败处理——此时报「干净」什么也没断言。
  if (report.budgetKeys === 0 || report.finalizedKeys === 0) {
    process.stderr.write(
      `预算结构门禁:读到 ${report.budgetKeys} 个预算键、${report.finalizedKeys} 个已定稿键,` +
        "门禁目标失效,按失败处理。\n",
    );
    return 1;
  }

  for (const violation of report.violations) {
    process.stdout.write(`预算结构门禁不通过 [${violation.check}]:${violation.detail}\n`);
  }
  const summary =
    report.violations.length === 0
      ? `预算结构门禁:检查 ${report.budgetKeys} 个预算键(已定稿 ${report.finalizedKeys} 个),无违规。`
      : `预算结构门禁:检查 ${report.budgetKeys} 个预算键(已定稿 ${report.finalizedKeys} 个),` +
        `${report.violations.length} 处违规。`;
  process.stdout.write(`${summary}\n`);
  return report.violations.length === 0 ? 0 : 1;
};

process.exitCode = main();
