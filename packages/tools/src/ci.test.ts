/**
 * 流水线冒烟验证:`.github/workflows/*.yml` 必须只调命名脚本,且两条链的成员与规格一致。
 *
 * ── 断言对象是「yaml 里的事实」,不是某段实现 ──
 * 票 07 的验收是「改错即红的冒烟验证」。这里只做两件事:把真实 workflow 文本喂给
 * `ci-workflows.ts` 的纯函数,断言它对每个 `run:` 步的判决为「干净」;再把「主链成员」
 * 「夜间硬门禁」「夜间观测项」这三份清单与 workflow 文本对齐。
 *
 * ── 反例与位置纪律 ──
 * 照 `gates.test.ts` 的反例形态:先给纯函数喂一份**好**的 workflow 断言它绿,再喂两份**坏**的
 * (直调 `node` 入口 / 引用不存在的脚本)断言它红,最后给夜间链抽掉一道硬门禁断言成员立即不符。
 * 反例不落文件、不 spawn 进程——被断言的是纯函数本身,所以一份坏文本就够把它弄红。
 *
 * 它归 `unit` project(默认 `test` 的一条),因此主链的 `pnpm run test` 自己就会跑它:
 * fast.yml 改了却没过这条,快链当场红。
 */

import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import {
  hardGateScripts,
  matrixLegs,
  namedScripts,
  observationalScripts,
  runStepViolations,
} from "./ci-workflows.ts";
import { manifest, repoRoot } from "./gates-harness.ts";

const scripts = new Set(Object.keys(manifest().scripts));

const workflowText = (name: string): string =>
  readFileSync(`${repoRoot}.github/workflows/${name}`, "utf8");

const fast = workflowText("fast.yml");
const nightly = workflowText("nightly.yml");

/** 主链成员(ADR-0010:PR/合入触发的快链 = `check:quick` + `test`)。 */
const FAST_MEMBERS = ["check:quick", "test"] as const;

/** 夜间硬门禁:任一红 = 夜间链红。 */
const NIGHTLY_HARD_GATES = [
  "check",
  "test:gates",
  "test:slow",
  "check:selfproof",
  "check:cross-process",
  "check:limits",
  "check:budget-recheck",
] as const;

/** 夜间观测项:只落盘不设红线,红不阻断(ADR-0010、spec §7)。 */
const NIGHTLY_OBSERVATIONS = ["mutate", "scan"] as const;

const sorted = (values: readonly string[]): readonly string[] => [...values].sort();

// ── 只调命名脚本:两条链的每个 run 步都合法 ──────────────────────────────────

it("主与夜间流水线只调命名脚本,引用的脚本都在 package.json.scripts 里", () => {
  for (const [name, text] of [
    ["fast.yml", fast],
    ["nightly.yml", nightly],
  ] as const) {
    const violations = runStepViolations(text, scripts);
    expect(violations, `${name} 里出现非命名脚本命令:\n${violations.join("\n")}`).toEqual([]);
  }
});

it("反例:直调 node 入口的 workflow 会被判红", () => {
  const bad = [
    "jobs:",
    "  x:",
    "    steps:",
    "      - name: 直调入口",
    "        run: node packages/tools/src/gate/run-no-float-gate.ts",
    "",
  ].join("\n");
  const violations = runStepViolations(bad, scripts);
  expect(violations.length).toBeGreaterThan(0);
  expect(violations.join("\n")).toContain("直调入口");
});

it("反例:引用不存在脚本的 workflow 会被判红", () => {
  const bad = ["jobs:", "  x:", "    steps:", "      - run: pnpm run does-not-exist", ""].join(
    "\n",
  );
  const violations = runStepViolations(bad, scripts);
  expect(violations.join("\n")).toContain("引用了不存在的脚本:pnpm run does-not-exist");
});

it("反例:裸 pnpm exec 调工具也会被判红", () => {
  const bad = ["jobs:", "  x:", "    steps:", "      - run: pnpm exec vitest run", ""].join("\n");
  expect(runStepViolations(bad, scripts).length).toBeGreaterThan(0);
});

it("正例:一份只调命名脚本的最小 workflow 判绿", () => {
  const good = [
    "jobs:",
    "  x:",
    "    steps:",
    "      - run: pnpm install --frozen-lockfile",
    "      - run: pnpm run check:quick",
    "",
  ].join("\n");
  expect(runStepViolations(good, scripts)).toEqual([]);
});

// ── 成员清单:主链 / 夜间硬门禁 / 夜间观测项 ─────────────────────────────────

it("主链成员 = check:quick + test", () => {
  expect(sorted(namedScripts(fast))).toEqual(sorted(FAST_MEMBERS));
});

it("夜间链硬门禁齐全,观测项恰为 mutate / scan", () => {
  expect(sorted(hardGateScripts(nightly))).toEqual(sorted(NIGHTLY_HARD_GATES));
  expect(sorted(observationalScripts(nightly))).toEqual(sorted(NIGHTLY_OBSERVATIONS));

  // 矩阵里点名的每个脚本都必须真实存在,否则夜间腿会以「脚本不存在」起手失败。
  for (const leg of matrixLegs(nightly)) {
    expect(scripts.has(leg.script), `夜间矩阵引用了不存在的脚本:${leg.script}`).toBe(true);
  }
});

it("反例:夜间链抽掉一道硬门禁,成员清单立即不符", () => {
  const tampered = nightly.replace(
    '          - { script: "check:limits", advisory: false, timeout: 60 }\n',
    "",
  );
  expect(sorted(hardGateScripts(tampered))).not.toEqual(sorted(NIGHTLY_HARD_GATES));
});

// ── 观测项只落盘不阻断,但红要留痕 ───────────────────────────────────────────

it("夜间链:观测项走 step 级 continue-on-error,且 outcome 写进产物", () => {
  // job 级 continue-on-error 会把红吞成 success;这里必须是矩阵项级表达式(step 级)。
  expect(nightly).toContain("continue-on-error: ${{ matrix.advisory }}");
  // fail-fast: false 是硬要求,否则第一条红会取消还在排队的观测项。
  expect(nightly).toContain("fail-fast: false");
  // 读 outcome 而不是 conclusion:continue-on-error 下 conclusion 恒为 success。
  expect(nightly).toContain("${{ steps.run.outcome }}");
  // 产物:门禁红了也传(if: always())。
  expect(nightly).toContain("if: always()");
  expect(nightly).toContain("uses: actions/upload-artifact@");
});

// ── 触发与权限 ───────────────────────────────────────────────────────────────

it("主链按 PR 与合入 main 触发,不挂定时", () => {
  expect(fast).toContain("pull_request:");
  expect(fast).toContain("push:");
  expect(fast).toContain("branches: [main]");
  expect(fast).toContain("workflow_dispatch:");
  expect(fast).not.toContain("schedule:");
});

it("夜间链按 cron(UTC)与手动触发", () => {
  expect(nightly).toContain("schedule:");
  expect(nightly).toContain("cron:");
  expect(nightly).toContain("workflow_dispatch:");
  expect(nightly).not.toContain("pull_request:");
});

it("两条链都用最小权限,且不出现任何凭证引用", () => {
  for (const [name, text] of [
    ["fast.yml", fast],
    ["nightly.yml", nightly],
  ] as const) {
    expect(text, `${name} 缺少最小权限声明`).toContain("permissions:");
    expect(text, `${name} 缺少 contents: read`).toContain("contents: read");
    // 「CI 无凭证」唯一可执行的检验:workflow 里 grep 不到 secrets.*
    expect(text, `${name} 里出现了凭证引用`).not.toContain("secrets.");
  }
});
