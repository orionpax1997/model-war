/**
 * 假试跑用的**跑满整张网格**夹具（`TrialProbe` 的一种实现，只给测试与 gate 用）。
 *
 * ── 为什么单测需要它 ──
 *
 * 一次 `evaluate` 的判据里有一半是**网格的形状**：32 场齐不齐、观测行归不归这份产物、旁挂的
 * `.grid.json` 说的是不是这张计划。用「跑一个真子进程」验这些，单测就从毫秒级变成分钟级；用
 * 「什么都不写」验，验的又不是那条路径。所以这里造一份**形状真实**的网格：32 行观测（每行带
 * 终局事实与行动事实）、一份与计划逐字同源的 `.grid.json`、产物摘要按本次编译产物现算。
 *
 * ── 它不猜计划 ──
 *
 * 计划由调用方给（服务把它交给探针，见 `TrialProbe.plan`）：假网格必须与**本次会话那张计划**
 * 同源，否则 `readTrialObservations` 第一行就会拒——那说明夹具与生产路径对不上，正是它该报的。
 *
 * 分数按夹具的终局事实算：四方并列第一 → 每场 1.5 分，整张网格平均 1.5。它不是「真的跑出来的
 * 分数」（算术真源在 runner 的 `trial-score.ts`），只是形状合法的一份读数。
 */

import { readFileSync, writeFileSync } from "node:fs";

import {
  ACTION_API_NAMES,
  ACTION_ERROR_CODES,
  TRIAL_GRID_SUMMARY_VERSION,
  type TrialGridScore,
  type TrialObservationLine,
  type TrialPlan,
} from "@model-war/schema";

import { sha256Hex } from "./archive.js";
import { terminalSummaryFixture } from "./terminal-summary.fixture.js";
import { gridSummaryPathOf } from "./trial-grid.js";
import { gridPlanFixture } from "./trial-plan.fixture.js";
import type { TrialProbe } from "./trial.js";

/** 夹具网格的分数：夹具的终局事实是「四方并列第一」，每场 1.5 分。 */
export const FIXTURE_AVERAGE_POINTS = 1.5;

/** 夹具里那一场的行动事实：完整、零调用、零错误（形状真实，数值不是重点）。 */
const fixtureActionFacts = (scriptSha256: string, seed: number, seat: 0 | 1 | 2 | 3) => ({
  version: 1 as const,
  scriptSha256,
  seed,
  seat,
  complete: true,
  observedTicks: 1,
  missingTicks: 0,
  calls: Object.fromEntries(ACTION_API_NAMES.map((name) => [name, 0])) as Record<
    (typeof ACTION_API_NAMES)[number],
    number
  >,
  errors: Object.fromEntries(
    ACTION_API_NAMES.map((name) => [
      name,
      Object.fromEntries(ACTION_ERROR_CODES.map((code) => [code, 0])),
    ]),
  ) as Record<
    (typeof ACTION_API_NAMES)[number],
    Record<(typeof ACTION_ERROR_CODES)[number], number>
  >,
  effects: {
    movedSteps: 0,
    harvestedAmount: 0,
    deliveredAmount: 0,
    productionOrdersStarted: 0,
    captureEvents: 0,
  },
});

/** 一份夹具网格的观测行：计划前 `count` 场各一行，其余场次缺席（= 缺场那条路径）。 */
export const fixtureReadings = (
  plan: TrialPlan,
  scriptSha256: string,
  count: number = plan.matches.length,
): readonly TrialObservationLine[] =>
  plan.matches.slice(0, count).map((match) => ({
    matchIndex: match.matchIndex,
    delivered: 0,
    captures: 0,
    noScoreSource: true,
    actionFacts: fixtureActionFacts(scriptSha256, match.seed, match.candidateSeat),
    terminalSummary: terminalSummaryFixture(match.seed, "timeout", match.seats),
  }));

/** 一整张网格的观测文本（一行一场，JSONL）。 */
export const fixtureObservationsText = (
  plan: TrialPlan,
  scriptSha256: string,
  count?: number,
): string =>
  fixtureReadings(plan, scriptSha256, count)
    .map((reading) => `${JSON.stringify(reading)}\n`)
    .join("");

/** 一份与计划逐字同源的网格汇总（`.grid.json` 的形状）。 */
export const fixtureGridSummary = (
  plan: TrialPlan,
  scriptSha256: string,
  score?: TrialGridScore,
) => ({
  version: TRIAL_GRID_SUMMARY_VERSION,
  plan,
  scriptSha256,
  score: score ?? {
    totalPoints: plan.matchesPerCandidate * FIXTURE_AVERAGE_POINTS,
    averagePoints: FIXTURE_AVERAGE_POINTS,
    countedMatches: plan.matchesPerCandidate,
  },
  matches: plan.matches.map((match) => ({
    matchIndex: match.matchIndex,
    seed: match.seed,
    candidateSeat: match.candidateSeat,
    map: match.map,
    mapSha256: match.mapSha256,
  })),
});

/** 假试跑的入参；`score` 只影响 `.grid.json`（候选条目里的成绩就来自它）。 */
export type CompleteGridTrialOptions = {
  /** 计划；缺省用 `gridPlanFixture()`（与服务交过来的那份同源时更好，见文件头注）。 */
  readonly plan?: TrialPlan;
  /** 试跑结论：`false` = 预算触限（拦下）。缺省通过。 */
  readonly passed?: boolean;
  /** 试跑 stdout 的首行会成为 stdout 上的判定行（拦下时是原因）。 */
  readonly stdout?: string;
  /** 写几行观测：少于计划场数就是「缺场」。缺省写满。 */
  readonly matches?: number;
  /** 完全不写观测与汇总（试跑入口没落盘那条路径）。 */
  readonly writeEvidence?: boolean;
  /** `.grid.json` 里的成绩；缺省按夹具的终局事实给。 */
  readonly score?: TrialGridScore;
  /** 记下每次调用（用例据此断言「试跑真的被调了几次」）。 */
  readonly calls?: Array<{ readonly artifactPath: string; readonly observationsPath: string }>;
};

/**
 * 造一个「跑满整张网格」的假试跑探针。
 *
 * 它会：按调用方给的产物现算摘要 → 把观测与汇总写进 `observationsPath`（与真入口同一约定）
 * → 回一个结论。判据全在消费端（服务与 pipeline），这里只造形状。
 */
export const completeGridTrial =
  (options: CompleteGridTrialOptions = {}): TrialProbe =>
  (request) => {
    const plan = options.plan ?? request.plan ?? gridPlanFixture();
    const scriptSha256 = sha256Hex(readFileSync(request.artifactPath));
    options.calls?.push({
      artifactPath: request.artifactPath,
      observationsPath: request.observationsPath,
    });
    if (options.writeEvidence !== false) {
      writeFileSync(
        request.observationsPath,
        fixtureObservationsText(plan, scriptSha256, options.matches),
        "utf8",
      );
      writeFileSync(
        gridSummaryPathOf(request.observationsPath),
        `${JSON.stringify(fixtureGridSummary(plan, scriptSha256, options.score))}\n`,
        "utf8",
      );
    }
    return {
      passed: options.passed ?? true,
      stdout: options.stdout ?? `试跑通过：${String(plan.matches.length)} 场无预算超限。\n`,
    };
  };
