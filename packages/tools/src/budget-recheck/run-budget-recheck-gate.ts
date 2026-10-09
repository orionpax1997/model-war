/**
 * 门禁:**预算标定的复算**——重跑预算探针与三份基准脚本,判终值仍自洽(根脚本
 * `check:budget-recheck`)。
 *
 * ```
 * node --disable-warning=ExperimentalWarning \
 *   packages/tools/src/budget-recheck/run-budget-recheck-gate.ts \
 *   [--tamper-probe] [--tamper-baseline]
 * ```
 *
 * ── 它证明什么(ADR-0009 的常驻守卫) ─────────────────────────────────────────
 * 八个预算键的终值一旦落库就**不可就地修改**,只有三类事件使它失效(契约散文修订、快照结构变更、
 * 沙箱 runtime 版本或中断粒度变更),失效时开新节点重标。三类事件**都不会让任何默认门禁变红**,
 * 所以这条纪律只能靠一条可执行的失配断言:终值预算真正装上后,**探针仍被截停、基准仍不被截停**;
 * 并且终值推导(读数 × 系数)与 `rulesets/v1.json` 逐键一致。这把今天只写在
 * `.scratch/budget-calibration/readings.md` 散文里的「终值仍自洽」变成可执行断言——不一致即红。
 *
 * ── 它与另两条门禁的分工 ────────────────────────────────────────────────────
 * `check:budget`(快门禁,零构建)读**结构**:整数倍、夹逼、文档副本一致。本门禁读**失配语义**:
 * 它要真跑引擎,故归**按需→夜间**层(不进 `check:quick` / `check` / `test` / `verify:fast`)。
 * 复算的实际断言在 `packages/engine/src/runner/probe-harness.test.ts` 的三条 `复算:*` 用例里
 * (复用同一条探针缝,不新开探针格式);本脚本只**编排**它、读退出码、给出红/绿与缘由。
 *
 * ── 它补的缺口 ──────────────────────────────────────────────────────────────
 * `probe-harness.test.ts` 的诚实侧默认传 `budget: {}`(空预算,一条轨都没启用),所以「不被截停」
 * 证明不了「终值下不被截停」。本门禁设 `MW_BUDGET_RECHECK`,让探针与基准两侧都装上**终值键**
 * (键清单里 `calibration.state === "final"` 的那些轨,与组装层 `budgetOf` 同一判据)。
 *
 * ── 反例(tamper) ───────────────────────────────────────────────────────────
 * `--tamper-probe` 让一条对抗探针的上限抬到它的燃烧量之上(于是不被截停);`--tamper-baseline`
 * 把事件轨压到 1(于是三份基准脚本当场被截停)。两者都只改本进程传给被测测试的 env,不动仓库。
 * 触发说明(哪类变更 → 跑哪条命令 → 红了开重标节点)见
 * `.scratch/release-gates/budget-recheck-triggers.md`。
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 仓库根 = 本文件上溯四级(`packages/tools/src/budget-recheck/`)。 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** 复算的断言住在探针测试里;本门禁只跑它。 */
const TEST_FILE = "packages/engine/src/runner/probe-harness.test.ts";

/** 被测测试里三条 `复算:*` 用例的名字片段(用来把「红」归到失配语义的哪一侧)。 */
const PROBE_FAILURE_MARK = "终值下三类探针必被截停";
const BASELINE_FAILURE_MARK = "终值预算下三份基准脚本必不被截停";
/** 诚实侧的读数用例:基准被截停时它也可能先红,归到同一侧。 */
const HONEST_FAILURE_MARK = "诚实侧:三份基准脚本在真引擎上跑出";

type Tamper = "probe" | "baseline" | null;

const parseTamper = (argv: readonly string[]): Tamper => {
  const probe = argv.includes("--tamper-probe");
  const baseline = argv.includes("--tamper-baseline");
  if (probe && baseline) {
    throw new Error("--tamper-probe 与 --tamper-baseline 只能给一个。");
  }
  if (probe) {
    return "probe";
  }
  return baseline ? "baseline" : null;
};

/** 红的原因归到失配语义的哪一侧。 */
const reasonOf = (output: string): string => {
  if (output.includes(PROBE_FAILURE_MARK)) {
    return "探针未被截停";
  }
  if (output.includes(BASELINE_FAILURE_MARK) || output.includes(HONEST_FAILURE_MARK)) {
    return "基准被截停";
  }
  return "复算不通过";
};

const main = (argv: readonly string[]): number => {
  const tamper = parseTamper(argv);
  process.stdout.write("预算复算门禁:重跑预算探针 + 三份基准脚本,判终值仍自洽\n");
  process.stdout.write(
    `  rerun:${TEST_FILE}(MW_BUDGET_RECHECK=1${
      tamper === null ? "" : `,MW_RECHECK_TAMPER=${tamper}`
    })\n`,
  );
  if (tamper === "probe") {
    process.stdout.write("  反例:一条对抗探针的上限抬到燃烧量之上(它不被截停)\n");
  }
  if (tamper === "baseline") {
    process.stdout.write("  反例:事件轨压到 1(三份基准脚本当场被截停)\n");
  }

  const result = spawnSync(
    process.env["GATE_PNPM"] ?? "pnpm",
    ["exec", "vitest", "run", "--project", "unit", TEST_FILE],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        MW_BUDGET_RECHECK: "1",
        ...(tamper === null ? {} : { MW_RECHECK_TAMPER: tamper }),
      },
    },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  const output = `${result.stdout}${result.stderr}`;
  const status = result.status ?? -1;

  if (status === 0) {
    process.stdout.write("  探针:终值下三类探针均被截停(轨名由引擎给出)\n");
    process.stdout.write("  基准:终值预算下三份基准脚本均不被截停(无一条轨触限)\n");
    process.stdout.write("  推导:终值推导与规则集逐键自洽\n");
    process.stdout.write("预算复算门禁:绿\n");
    return 0;
  }

  // 排障线索:把被测测试的输出尾部原样带出来。
  for (const line of output.trimEnd().split("\n").slice(-40)) {
    process.stdout.write(`  | ${line}\n`);
  }
  process.stdout.write(`预算复算门禁:红(${reasonOf(output)})\n`);
  return 1;
};

process.exitCode = main(process.argv.slice(2));
