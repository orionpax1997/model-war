/**
 * 冻结期试跑的执行入口：gen 以子进程调它（与 `validate.ts` 调校验器同形）。
 *
 * 用法：
 * - `node run-trial-script.js --plan --root <安装根>`
 *   → 从盘上现算事实、造**试跑计划**，stdout 打它的 canonical JSON（含 `planSha256`），退出 0。
 * - `node run-trial-script.js <候选产物.js> --root <安装根> [--observations <路径>] [--expected-plan <计划文件>]`
 *   → 同样由仓库现状造计划，**按计划跑满计划里的每一场**，stdout 打面向模型的反馈文本，
 *   退出码回答结论；给了 `--expected-plan` 就必须与现场重建的计划逐字段相等
 *   （不等即 infra，退出 2——那是"计划被换过"或"安装面变了"，不是候选的错）。
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
 * ── 早停仍在（01 行为不变的边界） ──
 *
 * 零容忍下首拦即定：首场触限就 `break`，于是观测行数可能少于场数。那不是漏记，是没跑的场。
 * 「跑满整个网格再取分数」是评分采样的另一条路（网格票），不在这条零容忍判定的路径上。
 *
 * ── 预算与组装复用 `assemble.ts` 的三处 ──
 *
 * 上限（`budgetOf`）、执行器映射（`budgetTracksOf`）、meta 头（`headForMap`）都从
 * `match/assemble.ts` 来：试跑与联赛跑在同一组阈值与同一组计数回调下，节流行为才一致。
 * 唯一不复用的是存档装载——候选此刻还不是存档（`commitArchive` 之前），脚本常驻内存。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  TRIAL_CANDIDATE_ID,
  TRIAL_CANDIDATE_SEAT,
  type ReplayPlayerRef,
  type ReplaySeat,
  type TrialPlan,
  type TrialPlanMatch,
} from "@model-war/schema";
import {
  buildTrialPlan,
  canonicalJson,
  checkTrialPlan,
  readTrialPlan,
  trialPlanMismatch,
  type BuildTrialPlanInput,
} from "@model-war/runner";
import { createQuickJsRunner } from "@model-war/engine/runner";

import { splitArgs } from "../args.js";
import { budgetOf, budgetTracksOf, headForMap } from "../match/assemble.js";
import { loadTrial, loadTrialPlanInputs, trialPlanFactsOf, type LoadedTrial } from "./load.js";
import { runTrialMatch, type TrialMatchOutcome } from "./match-run.js";
import {
  trialObservationLines,
  writeTrialObservations,
  type TrialObservationLine,
} from "./observations.js";
import {
  WATCHED_TRACKS,
  renderScoreSourceObservation,
  renderTrialFeedback,
  verdictOfTrips,
  type CandidateSeatOf,
  type RecordedTrip,
} from "./trial.js";

const USAGE =
  "用法: node run-trial-script.js <候选产物.js> --root <安装根> [--observations <观测文件路径>] " +
  "[--expected-plan <计划文件>]\n" +
  "      node run-trial-script.js --plan --root <安装根>";

/** 试跑自己的退出码（见文件头：不是 CLI 全局表）。 */
const TRIAL_PASSED = 0;
const TRIAL_BLOCKED = 1;
const TRIAL_INFRA = 2;

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** 计划 → 四座位的选手头（只进 meta 行，不进判据）。候选恒用试跑自己的占位身份。 */
const playersOf = (match: TrialPlanMatch): readonly ReplayPlayerRef[] =>
  match.seats.map((id, seat) => ({
    model: id === TRIAL_CANDIDATE_ID ? "trial-candidate" : id,
    archiveRef: `trial/${id}`,
    seat: seat as ReplaySeat,
  }));

/** 座位上的脚本源码：候选与计划点名的对手各一份（点名却装载不到即 infra）。 */
const codesOf = (loaded: LoadedTrial): ReadonlyMap<string, string> =>
  new Map<string, string>([
    [TRIAL_CANDIDATE_ID, loaded.candidateCode],
    ...loaded.opponents.map((opponent): [string, string] => [opponent.script.id, opponent.code]),
  ]);

/**
 * 跑满计划里的每一场：预算/执行器映射/meta 头全走 `assemble.ts` 的复用件；
 * 每场建四个 VM、跑完即释放。
 *
 * 作废（墙钟硬超时）同一种子重跑一次：仍作废则抛 infra（无法判定，大声失败，不回喂）。
 * 非判定触限（对手座位/非看轨）只留痕，不进结论。
 *
 * 每场的「无得分来源」读数都收进 `readings` 一并**带回**给调用方——落盘是输出副作用，
 * 归 `main`（那里才是 stdout / stderr / 退出码那一层的地盘），本函数只负责跑与收。
 */
const runPlanMatches = async (
  loaded: LoadedTrial,
  plan: TrialPlan,
): Promise<{
  readonly trips: readonly RecordedTrip[];
  readonly readings: readonly TrialObservationLine[];
}> => {
  const budget = budgetOf(loaded.ruleset);
  const tracks = budgetTracksOf(budget);
  const codes = codesOf(loaded);
  const wasmModule = await WebAssembly.compile(loaded.wasmBytes);
  const trips: RecordedTrip[] = [];
  const readings: TrialObservationLine[] = [];
  const candidateSeatOf: CandidateSeatOf = (matchIndex) =>
    plan.matches[matchIndex]?.candidateSeat ?? TRIAL_CANDIDATE_SEAT;
  // 哈希绑定与 runner 共用已加载的源码，不重读候选路径，也不使用前轮产物。
  const scriptSha256 = sha256(loaded.candidateCode);

  for (const match of plan.matches) {
    const map = loaded.maps.find((candidate) => candidate.name === match.map);
    if (map === undefined) throw new Error(`计划里的地图 ${match.map} 不在装载面上`);
    if (map.sha256 !== match.mapSha256)
      throw new Error(`计划里的地图 ${match.map} 摘要与盘上字节不符`);
    const head = headForMap(map.sha256);
    const players = playersOf(match);
    const attempt = async (): Promise<TrialMatchOutcome> => {
      const handles: Awaited<ReturnType<typeof createQuickJsRunner>>[] = [];
      try {
        // 顺序创建：任何一次创建失败也要释放已建的 VM，不改变沙箱/游戏预算。
        for (const [seat, id] of match.seats.entries()) {
          const code = codes.get(id);
          if (code === undefined) throw new Error(`计划里的对手 ${id} 不在装载面上`);
          handles.push(
            await createQuickJsRunner({
              wasm: wasmModule,
              runtimeCode: loaded.runtimeCode,
              scriptCode: code,
              seat: seat as ReplaySeat,
              ruleset: loaded.ruleset,
              ...tracks,
            }),
          );
        }
        return runTrialMatch({
          runners: handles.map((handle) => handle.runner),
          players,
          ruleset: loaded.ruleset,
          map: map.definition,
          seed: match.seed,
          budget,
          head,
          matchIndex: match.matchIndex,
          candidateSeat: match.candidateSeat,
        });
      } finally {
        for (const handle of handles) {
          handle.dispose();
        }
      }
    };

    let outcome = await attempt();
    if (outcome.fault !== null) {
      process.stderr.write(
        `试跑注：第 ${String(match.matchIndex + 1)} 场在第 ${String(outcome.fault.tick)} tick 作废` +
          `（墙钟硬超时），同一种子重跑一次。\n`,
      );
      outcome = await attempt();
      if (outcome.fault !== null) {
        throw new Error(
          `第 ${String(match.matchIndex + 1)} 场两次作废（墙钟硬超时），无法判定候选是否超限`,
        );
      }
    }
    trips.push(...outcome.trips);
    const observation = renderScoreSourceObservation(match.matchIndex, outcome.scoreSource);
    if (observation !== null) {
      process.stderr.write(`${observation}\n`);
    }
    // 观测文件记的是**每一场**的读数，命中与否都记（命中的读数恒为 0/0，只记命中等于没有读数）。
    readings.push({
      matchIndex: match.matchIndex,
      ...outcome.scoreSource,
      ...(outcome.terminalSummary === undefined
        ? {}
        : { terminalSummary: outcome.terminalSummary }),
      actionFacts: {
        version: 1,
        scriptSha256,
        seed: match.seed,
        // 观测行 v1 的 `seat` 是形状常量（候选恒 0 号位，归 schema）；计划里的座位是每场参数，
        // 网格让候选换座位时随观测行版本一起升（另票）。
        seat: TRIAL_CANDIDATE_SEAT,
        ...outcome.actionFacts,
      },
    });
    // 早停：零容忍下首拦即定——后场的触限不可能把首触挤掉（到场序即数组序），
    // 全跑完只多花几场的 VM 时间，结论与反馈逐字相同。
    if (!verdictOfTrips(trips, candidateSeatOf).passed) {
      break;
    }
  }
  return { trips, readings };
};

/** 由仓库现状造计划：事实来自盘上字节，场次由事实派生。失败即 infra。 */
const planOf = (facts: BuildTrialPlanInput): TrialPlan => {
  const plan = buildTrialPlan(facts);
  checkTrialPlan(plan);
  return plan;
};

/** `--plan`：打印计划并退出 0（不读候选、不建 VM）。 */
const printPlan = (root: string): number => {
  let plan: TrialPlan;
  try {
    plan = planOf(trialPlanFactsOf(loadTrialPlanInputs(root)));
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

const main = async (argv: readonly string[]): Promise<number> => {
  const {
    root: rootArg,
    observationsPath,
    expectedPlanPath,
    planMode,
    positional,
  } = splitArgs(argv);
  const root = resolve(rootArg ?? process.cwd());
  if (planMode) return printPlan(root);

  const candidateArg = positional[0];
  if (candidateArg === undefined) {
    process.stderr.write(`缺候选产物参数。\n${USAGE}\n`);
    return TRIAL_INFRA;
  }

  let loaded: LoadedTrial;
  let plan: TrialPlan;
  try {
    loaded = loadTrial(root, resolve(candidateArg));
    plan = planOf(trialPlanFactsOf(loaded));
    if (expectedPlanPath !== undefined) checkExpectedPlan(resolve(expectedPlanPath), plan);
  } catch (cause) {
    process.stderr.write(`试跑装载失败:${reasonOf(cause)}\n`);
    return TRIAL_INFRA;
  }

  let ran: {
    readonly trips: readonly RecordedTrip[];
    readonly readings: readonly TrialObservationLine[];
  };
  try {
    ran = await runPlanMatches(loaded, plan);
  } catch (cause) {
    process.stderr.write(`试跑执行失败:${reasonOf(cause)}\n`);
    return TRIAL_INFRA;
  }
  const { trips, readings } = ran;
  const candidateSeatOf: CandidateSeatOf = (matchIndex) =>
    plan.matches[matchIndex]?.candidateSeat ?? TRIAL_CANDIDATE_SEAT;

  // 观测落盘：在**结论之外**，计划里的那几场跑完之后才写。早停时只有跑过的那几行
  // （没跑的场没有读数）；某一轮试跑中途 infra（两场作废等）时这一轮一个字都不写，
  // 上一次**跑完**的读数留在盘上。
  if (observationsPath !== undefined) {
    const written = writeTrialObservations(observationsPath, trialObservationLines(readings));
    if (!written.ok) {
      process.stderr.write(`试跑注：观测文件写盘失败:${written.reason}\n`);
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
