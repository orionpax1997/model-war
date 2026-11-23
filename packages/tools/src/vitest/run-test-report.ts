/**
 * 入口:跑两遍测试 → 慢测试长尾与不稳定用例的报告。
 *
 * ── 为什么跑两遍 ────────────────────────────────────────────────────────────
 *
 * 「偶发红」只有两次以上运行才谈得上:一次失败可能是真缺陷,两次状态不同才是不稳定。
 * 这里跑两遍是**下限**,报告里如实写明「两遍只够证伪稳定性,不够证成」。
 *
 * **不用 vitest 的 `retry`**:retry 会把偶发红藏起来(重试过就绿,报告上什么都看不见)。
 * 仓库对假绿敏感,「先重跑一次、再记账」的语义已经存在(引擎故障轨,hld §2.2.4),
 * 这里照它:跑两遍、拿两次状态对比,不稳定就写进报告,不藏。
 *
 * ── 它是观测,不是门禁 ──────────────────────────────────────────────────────
 *
 * 只跑测试、只写报告,不判定任何东西、不改任何东西。它要跑两遍全量测试,
 * 代价是分钟级,所以不进任何常跑链(那条纪律由 `packages/tools/src/gates.test.ts` 钉住)。
 *
 * 退出码:0 = 报告已生成;1 = 一遍都没跑起来(空转,不是「干净」)。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  compareRuns,
  consistentlyFailing,
  isParseProblem,
  parseVitestResults,
  slowTail,
  type FlakyFinding,
  type TestRun,
} from "./test-report.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * 默认只观测 `unit` + `property`(与 `pnpm run test` 一致)。
 *
 * 这个默认值是**有代价的**:`gates`(约 176s)与 `slow`(约 266s)不在视野里,于是它们合起来
 * 那 440s 从来没有出现在任何一份耗时报告上——想找「哪些测试慢」的人看到的永远是那 94s 的
 * 另一部分。`--all` 把它们补进来,代价是一次完整的五 project 串行(约 12 分钟)。
 *
 * `--runs=1` 与之配对:两遍是为了判不稳定,看耗时只需要一遍;`gates` / `slow` 跑两遍
 * 是二十分钟,而那二十分钟买到的不是耗时的精度,是 flaky 的证据。
 */
const ALL_PROJECTS = ["unit", "property", "gates", "slow", "sandbox"] as const;
const DEFAULT_PROJECTS = ["unit", "property"] as const;

/** 慢测试长尾取前几条。 */
const SLOW_LIMIT = 30;

const outputDir = `${repoRoot}reports/tests`;

/**
 * 跑一遍测试,把 json reporter 的输出落盘并读回来。
 *
 * **逐 project 串行 spawn,不把它们塞进同一条 vitest 命令**。多个 `--project` 会让 vitest
 * 并行跑这些 project,而 `gates` 与 `slow` 的用例内部都在 spawn 全量门禁——两条腿并行时
 * 互相争 CPU,读出来的耗时会是争抢后的数字,比实际慢一倍。逐 project 起进程多花的几次
 * vitest 启动(每次约 2s)是这份数据可比的代价。
 */
const runOnce = (label: string): TestRun | undefined => {
  const testResults: unknown[] = [];
  for (const project of scope.projects) {
    const outputPath = `${outputDir}/results-${label}-${project}.json`;
    const result = spawnSync(
      process.env["GATE_PNPM"] ?? "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--project",
        project,
        "--reporter=json",
        `--outputFile=${outputPath}`,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    if (result.error !== undefined) {
      process.stderr.write(`跑测试失败(${label}/${project}):${result.error.message}\n`);
      return undefined;
    }
    // 退出码非 0 照样要读:失败用例的耗时同样属于「哪些测试慢」,而 flaky 判据要的正是失败态。
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(outputPath, "utf8"));
    } catch {
      process.stderr.write(`读不到 ${label}/${project} 的 json 报告(测试可能没跑起来)\n`);
      return undefined;
    }
    const entries = (raw as { testResults?: unknown }).testResults;
    if (!Array.isArray(entries)) {
      process.stderr.write(`${label}/${project} 的 json 报告里没有 testResults\n`);
      return undefined;
    }
    testResults.push(...entries);
  }
  const parsed = parseVitestResults({ testResults });
  if (isParseProblem(parsed)) {
    process.stderr.write(`${label} 的 json 报告形状不对:${parsed.message}\n`);
    return undefined;
  }
  return parsed;
};

const ms = (value: number): string => `${value.toFixed(0)} ms`;

const renderSlow = (
  run: TestRun,
  slow: readonly {
    file: string;
    fullName: string;
    durationMs: number;
    shareOfTotal: number;
  }[],
  quantiles: { p50: number; p90: number; p99: number; max: number },
): string => {
  const lines: string[] = [];
  lines.push("# 慢测试长尾");
  lines.push("");
  lines.push(`覆盖范围:${scope.projects.map((project) => `\`${project}\``).join(" / ")}。`);
  lines.push("");
  lines.push(
    `一次运行里最慢的 ${slow.length} 条用例。耗时是**用例级**的:文件级耗时只能说「这个文件慢」,`,
    "而文件里往往有十几条用例,只有用例级的数字能指到要动的那一处。",
  );
  lines.push("");
  lines.push("## 分位");
  lines.push("");
  lines.push("| p50 | p90 | p99 | max |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| ${ms(quantiles.p50)} | ${ms(quantiles.p90)} | ${ms(quantiles.p99)} | ${ms(quantiles.max)} |`,
  );
  lines.push("");
  lines.push("## 明细");
  lines.push("");
  lines.push("| # | 用例 | 文件 | 耗时 | 占总耗时 |");
  lines.push("|---|---|---|---|---|");
  slow.forEach((entry, index) => {
    lines.push(
      `| ${index + 1} | ${entry.fullName} | \`${entry.file}\` | ${ms(entry.durationMs)} | ${(entry.shareOfTotal * 100).toFixed(2)}% |`,
    );
  });
  lines.push("");
  return `${lines.join("\n")}\n`;
};

const renderFlaky = (
  flaky: readonly FlakyFinding[],
  failing: readonly { file: string; fullName: string; durationMs: number }[],
  first: TestRun,
  second: TestRun,
): string => {
  const lines: string[] = [];
  lines.push("# 不稳定的用例");
  lines.push("");
  lines.push(
    "同一批测试跑**两遍**,拿两次的状态对比。判据只有一条:**同一条用例在两次 run 里状态不同**。",
  );
  lines.push("");
  lines.push("## 结论");
  lines.push("");
  lines.push(
    `- 不稳定用例:**${flaky.length} 条**(两次状态不同)。`,
    `- 两次都失败:${failing.length} 条 —— 那是**真缺陷**,不是不稳定,归「稳定失败」那一栏。`,
    "- **两遍只够证伪稳定性**:没出现在这一栏的用例,这次两次都绿;它是不是稳定的,",
    "  一次跑不出来。要给某条用例定性,得把它多跑几遍。",
  );
  lines.push("");
  lines.push("## 两次状态不同的用例");
  lines.push("");
  if (flaky.length === 0) {
    lines.push("(这一轮没有状态不一致的用例。)");
  } else {
    lines.push("| 用例 | 文件 | 第一次 | 第二次 | 第一次耗时 | 第二次耗时 |");
    lines.push("|---|---|---|---|---|---|");
    for (const finding of flaky) {
      lines.push(
        `| ${finding.fullName} | \`${finding.file}\` | ${finding.firstStatus} | ${finding.secondStatus} | ${ms(finding.firstDurationMs)} | ${ms(finding.secondDurationMs)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## 两次都失败的用例(真缺陷)");
  lines.push("");
  if (failing.length === 0) {
    lines.push("(这一轮没有两次都失败的用例。)");
  } else {
    lines.push("| 用例 | 文件 | 耗时 |");
    lines.push("|---|---|---|");
    for (const entry of failing) {
      lines.push(`| ${entry.fullName} | \`${entry.file}\` | ${ms(entry.durationMs)} |`);
    }
  }
  lines.push("");
  lines.push("## 两遍的对照");
  lines.push("");
  lines.push("| | 用例数 | 通过 | 失败 | 挂起 |");
  lines.push("|---|---|---|---|---|");
  lines.push(
    `| 第一遍 | ${first.totalTests} | ${first.passedTests} | ${first.failedTests} | ${first.pendingTests} |`,
  );
  lines.push(
    `| 第二遍 | ${second.totalTests} | ${second.passedTests} | ${second.failedTests} | ${second.pendingTests} |`,
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
};

/** 这一次观测的范围与遍数。落盘文件名带上它,免得 `--all` 的结果覆盖默认口径的那份。 */
const scope = ((): {
  readonly projects: readonly string[];
  readonly runs: number;
  readonly tag: string;
} => {
  const argv = process.argv.slice(2);
  const all = argv.includes("--all");
  const runsArg = argv.find((arg) => arg.startsWith("--runs="));
  const runs = runsArg === undefined ? 2 : Number(runsArg.slice("--runs=".length));
  return {
    projects: all ? ALL_PROJECTS : DEFAULT_PROJECTS,
    runs: Number.isInteger(runs) && runs >= 1 ? runs : 0,
    tag: all ? "all" : "default",
  };
})();

const main = (): number => {
  if (scope.runs === 0) {
    process.stderr.write("--runs= 要一个 ≥1 的整数。\n");
    return 1;
  }
  mkdirSync(outputDir, { recursive: true });
  const scopeLabel = scope.projects.join(" + ");
  process.stdout.write(`跑第一遍(${scopeLabel})…\n`);
  const first = runOnce(`${scope.tag}-first`);
  if (first === undefined) {
    process.stderr.write("第一遍没跑起来:没有结论。\n");
    return 1;
  }

  const [slow, quantiles] = slowTail(first, SLOW_LIMIT);
  const slowPath = `${outputDir}/slow-${scope.tag}.md`;
  writeFileSync(slowPath, renderSlow(first, slow, quantiles), "utf8");
  const written = [slowPath];

  let flakySummary = "不稳定用例:未观测(--runs=1:单遍数据不足以判不稳定)。";
  if (scope.runs >= 2) {
    process.stdout.write(`跑第二遍(${scopeLabel})…\n`);
    const second = runOnce(`${scope.tag}-second`);
    if (second === undefined) {
      process.stderr.write("第二遍没跑起来:没有结论(单遍的数据不足以判不稳定)。\n");
      return 1;
    }
    const flaky = compareRuns(first, second);
    const failing = consistentlyFailing(first, second);
    const flakyPath = `${outputDir}/flaky-${scope.tag}.md`;
    writeFileSync(flakyPath, renderFlaky(flaky, failing, first, second), "utf8");
    written.push(flakyPath);
    flakySummary = `不稳定用例:${flaky.length} 条;两次都失败:${failing.length} 条。`;
  }

  process.stdout.write(
    [
      `慢测试长尾:${slow.length} 条(p90=${quantiles.p90.toFixed(0)}ms)。`,
      flakySummary,
      "",
      ...written.map((path) => `报告:${path}`),
      "",
    ].join("\n"),
  );
  return 0;
};

process.exitCode = main();
