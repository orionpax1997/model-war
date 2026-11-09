/**
 * 变异可解释性诊断的入口:读分片报告 → 算诊断 → 落一份 Markdown 报告。
 *
 * ── 归属与纪律 ──────────────────────────────────────────────────────────────
 *
 * - **按需跑,不进任何常跑链**。它是观测,不是判据:判据是 `diagnose.ts` 的桶与
 *   `structural-attribution.ts` 的归因表,这两者都有单测;这份报告是它们的产物。
 * - **不改任何基线**。诊断读报告、读基线,只写 `reports/mutation/diagnosis.md` 与
 *   `reports/mutation/diagnosis.html`(产物目录,不入库)。抬基线的命令仍然只有
 *   `pnpm run mutation:baseline:raise` 一条,
 *   且它不在本脚本的路径上。
 * - **缺报告不判红**。没跑过的分片就是没跑过,报告里列出来即可;硬判红会让人
 *   为了让报告好看而去跑全部分片。
 *
 * 用法:
 *   pnpm run mutation:diagnose            # 全部有报告的分片
 *   pnpm run mutation:diagnose -- schema   # 只诊断指定的分片
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { diagnoseShard, type DiagnosableReport, type ShardDiagnosis } from "./diagnose.ts";
import { renderDiagnosisHtml } from "./diagnose-html.ts";
import { renderDiagnosisMarkdown } from "./diagnose-markdown.ts";
import {
  ATTRIBUTION_ENTRIES,
  MECHANISM_ATTRIBUTION,
  compileAttributions,
} from "./structural-attribution.ts";
import { MUTATION_SHARDS } from "./shards.ts";

/** 仓库根 = 上溯四级(本文件在 `packages/tools/src/mutation/`,比 `gates-harness.ts` 深一层)。 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** 报告目录:产物,不入库(根 `.gitignore` 忽略 `reports/`)。 */
const reportDir = `${repoRoot}reports/mutation`;

/** 诊断报告的落点:一份 Markdown(在终端里读)、一份 HTML(给人看)。 */
const OUTPUT = `${reportDir}/diagnosis.md`;
const HTML_OUTPUT = `${reportDir}/diagnosis.html`;

/**
 * 分片配置里声明的 mutate 范围(读文本:`.mjs` 没有类型声明,import 会让 `tsc -b` 找不到声明)。
 *
 * 抽不出来就返回空数组——诊断会把「拿不到声明范围」当作「不判范围」,不会误报。
 */
const mutateGlobsOf = (path: string): readonly string[] => {
  const array = /mutate:\s*\[([\s\S]*?)\]/.exec(readFileSync(path, "utf8"))?.[1] ?? "";
  return [...array.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
};

const readReport = (shard: string): { report: DiagnosableReport; mtime: string } | undefined => {
  const path = `${reportDir}/${shard}.json`;
  try {
    statSync(path);
  } catch {
    return undefined;
  }
  const report = JSON.parse(readFileSync(path, "utf8")) as DiagnosableReport;
  return { report, mtime: statSync(path).mtime.toISOString() };
};

/** 命令行里点名的分片;没点名就诊断全部有报告的片。 */
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));

const known = new Set(MUTATION_SHARDS.map((shard) => shard.name));
const selected = requested.length > 0 ? requested : [...known];

const unknownShards = selected.filter((name) => !known.has(name));
if (unknownShards.length > 0) {
  process.stderr.write(`不认识的分片名:${unknownShards.join("、")}\n`);
  process.stderr.write(`已知分片:${[...known].join("、")}\n`);
  process.exit(1);
}

const attributions = compileAttributions(ATTRIBUTION_ENTRIES);
const diagnoses: ShardDiagnosis[] = [];
const reportTimes: Record<string, string> = {};
const missingShards: string[] = [];

for (const shard of selected) {
  const loaded = readReport(shard);
  if (!loaded) {
    missingShards.push(shard);
    continue;
  }
  reportTimes[shard] = loaded.mtime;
  const declaredScope = mutateGlobsOf(`${repoRoot}stryker/${shard}.mjs`);
  diagnoses.push(diagnoseShard(shard, loaded.report, attributions, { declaredScope }));
}

if (diagnoses.length === 0) {
  process.stderr.write("没有可诊断的分片报告(先跑 `pnpm run mutate:<分片>`)。\n");
  process.exit(1);
}

const meta = {
  generatedAt: new Date().toISOString(),
  reportTimes,
  missingShards,
  mechanism: MECHANISM_ATTRIBUTION,
};

// 两份渲染吃的是同一份 `diagnoses` 与同一份 `meta`,不可能说出不同的事:
// Markdown 是仓库里的交付形态,HTML 是给人看的形态(要拍板的人不该在终端里做心算)。
writeFileSync(OUTPUT, renderDiagnosisMarkdown(diagnoses, meta), "utf8");
writeFileSync(HTML_OUTPUT, renderDiagnosisHtml(diagnoses, meta), "utf8");

// stdout 给一份短摘要:诊断报告是给人读的,但 CI/终端里先看到的是这个。
for (const d of diagnoses) {
  const b = d.buckets;
  process.stdout.write(
    `${d.shard.padEnd(16)} 有效 ${String(d.valid).padStart(5)} ` +
      `真杀 ${String(b.killed).padStart(5)} 超时 ${String(b.timeout).padStart(4)} ` +
      `存活 ${String(b["survived-value"] + b["survived-structure"] + b["survived-logic"]).padStart(5)} ` +
      `未覆盖 ${String(b.uncovered + b.unobservable).padStart(5)} ` +
      `原始 ${d.score.toFixed(2)}% 去超时 ${d.scoreExcludingTimeout.toFixed(2)}% ` +
      `可信 ${d.credibleScore.toFixed(2)}%  ${d.headline}\n`,
  );
}
process.stdout.write(`\n报告:${OUTPUT}\n`);
process.stdout.write(`人读版:${HTML_OUTPUT}\n`);
if (missingShards.length > 0) {
  process.stdout.write(`缺报告的分片:${missingShards.join("、")}\n`);
}
