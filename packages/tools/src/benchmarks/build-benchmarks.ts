/**
 * 基准脚本编译产物的**写回**(根脚本 `bench:build`)。
 *
 * 用法:`node packages/tools/src/benchmarks/build-benchmarks.ts [目录名 ...]`
 * 不给目录名就是三份全写。给目录名只写那几份——改一份脚本时重跑它不必把另两份也重编译一次。
 *
 * ── 它做什么、不做什么 ───────────────────────────────────────────────────────
 * 做:按 `tsconfig.scripts.json` 编译 `benchmarks/<目录名>/script.ts`,把产物写回同目录的 `script.js`。
 * 不做:不改源码一个字节、不补类型声明、不做任何「让编译变绿」的事。
 * 类型面未回填时编译必然非零退出,而产物照样落盘(理由见 `compile.ts` 的头注)——
 * **写回产物不等于编译通过**,判定「这份编译算不算数」的是 `run-benchmarks-gate.ts` 与
 * `benchmarks.test.ts`(诊断分类那一侧)。
 *
 * 退出码:全部产物落盘且没有「三类之外」的诊断即 0,否则 1。诊断逐条打到标准输出。
 */

import { readFileSync, writeFileSync } from "node:fs";

import {
  BENCHMARK_NAMES,
  PRODUCT_FILE,
  SOURCE_FILE,
  benchmarkFile,
  compileBenchmarkSource,
  type BenchmarkName,
  type Diagnostic,
} from "./compile.ts";

/** 参数表里的目录名逐个要落在登记册里;写错一个名字就当场红,不猜。 */
const selected = process.argv.slice(2);
const names: readonly BenchmarkName[] =
  selected.length === 0
    ? BENCHMARK_NAMES
    : selected.map((raw) => {
        const name = BENCHMARK_NAMES.find((candidate) => candidate === raw);
        if (name === undefined) {
          console.error(`未登记的基准目录 \`${raw}\`;登记册只有:${BENCHMARK_NAMES.join(" / ")}`);
          process.exit(1);
        }
        return name;
      });

const unexpected = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
  diagnostics.filter((diagnostic) => diagnostic.cls === "unexpected");

let failed = 0;
for (const name of names) {
  const source = readFileSync(benchmarkFile(name, SOURCE_FILE), "utf8");
  const compiled = compileBenchmarkSource(source);

  const counts = new Map<string, number>();
  for (const diagnostic of compiled.diagnostics) {
    counts.set(diagnostic.cls, (counts.get(diagnostic.cls) ?? 0) + 1);
  }
  const summary = [...counts].map(([cls, n]) => `${cls} ${n}`).join(", ");

  if (compiled.products === "") {
    console.error(`${name}:没有产物(tsc 退出码 ${compiled.status})`);
    for (const diagnostic of compiled.diagnostics) console.error(`  ${diagnostic.line}`);
    failed += 1;
    continue;
  }

  writeFileSync(benchmarkFile(name, PRODUCT_FILE), compiled.products, "utf8");
  console.log(
    `${name}:写入 ${PRODUCT_FILE}(${Buffer.byteLength(compiled.products)} 字节;` +
      `tsc 退出码 ${compiled.status};诊断 ${summary || "无"})`,
  );

  const odd = unexpected(compiled.diagnostics);
  if (odd.length > 0) {
    for (const diagnostic of odd) console.error(`  非预期诊断:${diagnostic.line}`);
    failed += 1;
  }
}

process.exit(failed === 0 ? 0 : 1);
