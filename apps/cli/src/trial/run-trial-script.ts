/**
 * 冻结期试跑的执行入口：gen 以子进程调它（与 `validate.ts` 调校验器同形）。
 *
 * 用法：
 * - `node run-trial-script.js --plan --root <安装根> --model <模型 slug>`
 *   → 从盘上现算事实、造**评测网格计划**，stdout 打它的 canonical JSON（含 `planSha256`），退出 0。
 * - `node run-trial-script.js <候选产物.js> --root <安装根> --model <模型 slug> [--observations <路径>] [--expected-plan <计划文件>]`
 *   → 同样由仓库现状造计划，**按计划跑满计划里的每一场**，stdout 打面向模型的反馈文本，
 *   退出码回答结论；给了 `--expected-plan` 就必须与现场重建的计划逐字段相等
 *   （不等即 infra，退出 2——那是"计划被换过"或"安装面变了"，不是候选的错）。
 * - `node run-trial-script.js <候选产物.js> --root <安装根> --model <模型 slug> --match-limit <N>`
 *   → **探针模式**：同一份完整计划，只跑**前 N 场**，stdout 打三档占用读数文本，退出码 `0`
 *   （前 N 场没越线）/ `1`（已越线）。**不写观测、不落汇总、不比对计划**（见下节）。
 *
 * ── `--model` 用来解析在位陪练，不是对手参数 ──
 *
 * 四份陪练里「在位」那份 = **正在被生成的那个模型自己最近一次冻结存档**（没有存档时用代位档）。
 * 所以造计划必须知道「给谁生成」：`--plan` 与执行模式都要它，否则两条路径造出来的计划不同源。
 *
 * ── 计划是这条缝的公共语言 ──
 *
 * 读什么：候选产物 + `<root>/rulesets/<RULESET_VERSION>.json` + `<root>/maps/<图>.json`
 * + 计划里点名的对手脚本 + wasm 与 runtime bundle。**跑哪几场、谁坐哪、什么种子、哪张图**
 * 全部来自计划（形状在 `@model-war/schema` 的 `trial-plan.ts`，构造与校验在
 * `@model-war/runner` 的 `trial-plan.ts`）——入口不再自己查常量表。计划只收事实，
 * 事实（摘要）由 `load.ts` 从盘上现算，所以 `--plan` 与默认执行模式造出来的计划同源。
 *
 * ── `--observations` 是 gen 与入口之间的私有协议，不是 `modelwar` 的用户可见参数 ──
 *
 * 它指定「无得分来源」读数的落盘点（gen 侧真源是 `@model-war/gen` 的 `observations.ts`，
 * 格式与写出纪律归同目录的 `observations.ts`）。给了就写，没给一个字都不写——手工冒烟与
 * 旧脚本按原样跑。写盘失败只在 stderr 留一行警告：**不改退出码、不改 verdict、不进回喂**
 * （旁证拿不到，不该让候选的账上多一条失败）。
 *
 * ── 退出码是 gen 的私有协议，不是 CLI 全局表 ──
 *
 * `0` 通过（含 `--plan`）；`1` 预算超限（stdout = 回喂文本）；`2` 内部/infra 错误（用法错、
 * 读不到文件、规则集/地图未过校验、计划与预期不符、作废无法判定、引擎抛错——细节打 stderr）。
 * gen 见 0/1 之外的码即大声失败，不回喂。不要把 `apps/cli/src/exit-codes.ts` 那张表套到这里：
 * 那张表的 1 是"装载期拒跑"，而这里的 1 是"拦下候选"，两码含义不同。
 *
 * ── 跑满，不再早停 ──
 *
 * 网格的观测同时是反馈与分数的原料，所以 32 场一场不少地跑：触限之后仍要跑完并写全部观测，
 * 只是退出码变成 1（拦截）。判定本身仍是零容忍（`verdictOfTrips`），没有软化。
 *
 * ── 探针模式：同一份完整计划的前缀，不是另一条执行路径 ──
 *
 * `--match-limit N` 只收窄**循环范围**（`runTrialGridSubset`），计划对象逐字节不动：
 * `match.matchIndex` / `match.candidateSeat` 仍取自完整计划，于是判座位用的是完整计划
 * （`candidateSeatOfPlan`，缺项即抛，不 `?? 0`）。先 `slice` 计划再走整张网格那条路会静默假绿
 * ——见 `grid.ts` 与 `trial.ts` 的头注。
 *
 * 三件事在这一模式下**不做**，每一件都有理由：
 *
 * - **不写观测、不落汇总**：探针不产出候选，写半张网格的观测会让「跑过几场」在读侧变成一件
 *   要靠文件名猜的事；`buildTrialGridSummary` 也拒缺场（它要整份 32 场）。
 * - **不比对 `--expected-plan`**：探针只读前缀、不产出任何证据，计划身份不是它的判据；
 *   真要比对，那 32 场的完整身份已经在 `evaluate` 那条路上逐字段比过一次。
 * - **不早停**（`stopOnFirstTrip: false`）：探针要的是跑完前缀的峰值，中途停下就拿不到
 *   「第 6 场才贴边」这种情况。
 *
 * ── 预算与组装复用 `assemble.ts` 的三处 ──
 *
 * 上限（`budgetOf`）、执行器映射（`budgetTracksOf`）、meta 头（`headForMap`）都从
 * `match/assemble.ts` 来：试跑与联赛跑在同一组阈值与同一组计数回调下，节流行为才一致。
 * 唯一不复用的是存档装载——候选此刻还不是存档（`commitArchive` 之前），脚本常驻内存。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type TrialPlan } from "@model-war/schema";
import {
  buildTrialPlan,
  canonicalJson,
  checkTrialPlan,
  readTrialPlan,
  trialPlanMismatch,
  type BuildTrialPlanInput,
} from "@model-war/runner";

import { budgetOf } from "../match/assemble.js";
import { splitArgs } from "../args.js";
import {
  gridSummaryPathOf,
  runTrialGrid,
  runTrialGridSubset,
  summaryOfGrid,
  trialScriptSha256,
  writeTrialGridSummary,
} from "./grid.js";
import { loadTrialGrid, loadTrialGridInputs, trialPlanFactsOf, type LoadedTrial } from "./load.js";
import { trialObservationLines, writeTrialObservations } from "./observations.js";
import {
  WATCHED_TRACKS,
  candidateSeatOfPlan,
  probeReportOf,
  renderTrialFeedback,
  verdictOfTrips,
  type ProbeLimits,
} from "./trial.js";

const USAGE =
  "用法: node run-trial-script.js <候选产物.js> --root <安装根> --model <模型 slug> " +
  "[--observations <观测文件路径>] [--expected-plan <计划文件>]\n" +
  "      node run-trial-script.js <候选产物.js> --root <安装根> --model <模型 slug> " +
  "--match-limit <场数>   （探针模式:只跑前 N 场,只回占用读数,不写观测）\n" +
  "      node run-trial-script.js --plan --root <安装根> --model <模型 slug>";

/** 试跑自己的退出码（见文件头：不是 CLI 全局表）。 */
const TRIAL_PASSED = 0;
const TRIAL_BLOCKED = 1;
const TRIAL_INFRA = 2;

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** 由仓库现状造计划：事实来自盘上字节，场次由事实派生。失败即 infra。 */
const planOf = (facts: BuildTrialPlanInput): TrialPlan => {
  const plan = buildTrialPlan(facts);
  checkTrialPlan(plan);
  return plan;
};

/** `--plan`：打印计划并退出 0（不读候选、不建 VM）。 */
const printPlan = (root: string, model: string): number => {
  let plan: TrialPlan;
  try {
    plan = planOf(trialPlanFactsOf(loadTrialGridInputs(root, model)));
  } catch (cause) {
    process.stderr.write(`试跑计划装载失败:${reasonOf(cause)}\n`);
    return TRIAL_INFRA;
  }
  process.stdout.write(`${canonicalJson(plan)}\n`);
  return TRIAL_PASSED;
};

/** `--expected-plan`：预期计划必须能由现场事实重建，否则指名哪一处不符并退出 infra。 */
const checkExpectedPlan = (path: string, plan: TrialPlan): void => {
  let expected: TrialPlan;
  try {
    expected = readTrialPlan(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (cause) {
    throw new Error(`预期试跑计划读不了或形状不合法:${reasonOf(cause)}`);
  }
  const mismatch = trialPlanMismatch(expected, plan);
  if (mismatch !== null) throw new Error(`预期试跑计划与现场事实不符:${mismatch}`);
};

/** 探针要报的三条轨的上限（取自规则集里**已启用**的预算键；缺一条就不显示那一条）。 */
const probeLimitsOf = (loaded: LoadedTrial): ProbeLimits => {
  const budget = budgetOf(loaded.ruleset);
  return {
    ...(budget.eventTickLimit === undefined ? {} : { eventTickLimit: budget.eventTickLimit }),
    ...(budget.apiCallTickLimit === undefined ? {} : { apiCallTickLimit: budget.apiCallTickLimit }),
    ...(budget.memoryTickCeiling === undefined
      ? {}
      : { memoryTickCeiling: budget.memoryTickCeiling }),
  };
};

/**
 * 探针模式：跑完整计划的**前 `matchLimit` 场**，回三档占用读数文案。
 *
 * 退出码沿用试跑入口那套私有协议：`0` = 前 N 场没越线（含"贴边"与"充裕"两档），`1` = 已越线，
 * `2` = infra。**它不是一个新的判据**：判定还是 `verdictOfTrips` 的零容忍规则，判座位用的是
 * **完整计划**（`candidateSeatOfPlan`），与 `evaluate` 那条路同一个函数。
 */
const runProbe = async (
  loaded: LoadedTrial,
  plan: TrialPlan,
  matchLimit: number,
): Promise<number> => {
  let ran: Awaited<ReturnType<typeof runTrialGridSubset>>;
  try {
    // `stopOnFirstTrip: false`——探针要跑完前缀的峰值（理由见文件头注《探针模式》）。
    ran = await runTrialGridSubset(loaded, plan, matchLimit, false);
  } catch (cause) {
    process.stderr.write(`探针执行失败:${reasonOf(cause)}\n`);
    return TRIAL_INFRA;
  }
  const report = probeReportOf({
    plan,
    // 跑了几场由执行侧回答（早停与否都以此为准），不按入参假定。
    matchCount: ran.matchesRun,
    trips: ran.trips,
    ...(ran.peakUsage === undefined ? {} : { peakUsage: ran.peakUsage }),
    limits: probeLimitsOf(loaded),
  });
  process.stdout.write(`${report.text}\n`);
  return report.verdict.passed ? TRIAL_PASSED : TRIAL_BLOCKED;
};

const main = async (argv: readonly string[]): Promise<number> => {
  const {
    root: rootArg,
    model,
    observationsPath,
    expectedPlanPath,
    matchLimit,
    planMode,
    positional,
  } = splitArgs(argv);
  const root = resolve(rootArg ?? process.cwd());
  if (model === undefined) {
    process.stderr.write(`缺 --model（在位陪练随模型而定，造计划必须知道给谁生成）。\n${USAGE}\n`);
    return TRIAL_INFRA;
  }
  if (planMode) return printPlan(root, model);

  const candidateArg = positional[0];
  if (candidateArg === undefined) {
    process.stderr.write(`缺候选产物参数。\n${USAGE}\n`);
    return TRIAL_INFRA;
  }

  let loaded: LoadedTrial;
  let plan: TrialPlan;
  try {
    loaded = loadTrialGrid(root, model, resolve(candidateArg));
    plan = planOf(trialPlanFactsOf(loaded));
    if (expectedPlanPath !== undefined) checkExpectedPlan(resolve(expectedPlanPath), plan);
  } catch (cause) {
    process.stderr.write(`试跑装载失败:${reasonOf(cause)}\n`);
    return TRIAL_INFRA;
  }

  // ── 探针模式 ──
  //
  // 在装载之后、跑整张网格之前分出去:探针读的是**同一份**现场重建的完整计划(上一步刚造出来),
  // 只是执行时少跑几场。它不写观测、不落汇总、不比对 `--expected-plan`(理由见文件头注)。
  if (matchLimit !== undefined) {
    const requested = Number(matchLimit);
    if (!Number.isSafeInteger(requested) || requested < 1) {
      process.stderr.write(`--match-limit 必须是正整数(收到 ${String(matchLimit)})。\n${USAGE}\n`);
      return TRIAL_INFRA;
    }
    if (observationsPath !== undefined) {
      process.stderr.write(
        "试跑注：探针模式不写观测（它跑的是计划的前缀，写半张观测会让「跑过几场」变成猜的）。\n",
      );
    }
    if (expectedPlanPath !== undefined) {
      process.stderr.write(
        "试跑注：探针模式不比对 --expected-plan（它不产出证据，计划身份不是它的判据）。\n",
      );
    }
    const limit = Math.min(requested, plan.matches.length);
    if (limit !== requested) {
      process.stderr.write(
        `试跑注：--match-limit ${String(requested)} 超过计划场数 ${String(plan.matches.length)}，按整张跑。\n`,
      );
    }
    return await runProbe(loaded, plan, limit);
  }

  let ran: Awaited<ReturnType<typeof runTrialGrid>>;
  try {
    ran = await runTrialGrid(loaded, plan);
  } catch (cause) {
    process.stderr.write(`试跑执行失败:${reasonOf(cause)}\n`);
    return TRIAL_INFRA;
  }
  const { trips, readings } = ran;
  // 座位按**完整计划**查：`?? 0` 那个兜底会把"计划被裁短"读成"候选坐 0 号位"，
  // 于是一条座位 3 的触限对不上、整张网格判成通过（细节见 `trial.ts` 的 `candidateSeatOfPlan`）。
  const candidateSeatOf = candidateSeatOfPlan(plan);

  // 证据落盘在**结论之外**：整张网格跑完之后才写，一次 invocation 内部不允许半截。
  // 网格中途 infra（两场作废等）时这一轮一个字都不写，上一次**跑完**的证据留在盘上。
  if (observationsPath !== undefined) {
    const written = writeTrialObservations(observationsPath, trialObservationLines(readings));
    if (!written.ok) {
      process.stderr.write(`试跑注：观测文件写盘失败:${written.reason}\n`);
    }
    const summary = summaryOfGrid(plan, trialScriptSha256(loaded), readings);
    const summarized = writeTrialGridSummary(gridSummaryPathOf(observationsPath), summary);
    if (!summarized.ok) {
      process.stderr.write(`试跑注：网格汇总写盘失败:${summarized.reason}\n`);
    }
  }

  const ignored = trips.filter(
    (trip) =>
      trip.seat !== candidateSeatOf(trip.matchIndex) || !WATCHED_TRACKS.includes(trip.track),
  );
  if (ignored.length > 0) {
    process.stderr.write(
      `试跑注：忽略 ${String(ignored.length)} 条非判定触限（对手座位/非看轨），不计入结论。\n`,
    );
  }

  const verdict = verdictOfTrips(trips, candidateSeatOf);
  process.stdout.write(`${renderTrialFeedback(verdict, plan)}\n`);
  return verdict.passed ? TRIAL_PASSED : TRIAL_BLOCKED;
};

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (cause) {
  process.stderr.write(`试跑未捕获异常:${reasonOf(cause)}\n`);
  process.exitCode = TRIAL_INFRA;
}
