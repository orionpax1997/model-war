/**
 * 冻结期试跑的执行入口：gen 以子进程调它（与 `validate.ts` 调校验器同形）。
 *
 * 用法：`node run-trial-script.js <候选产物.js> --root <安装根> [--observations <路径>]`。
 * 读：候选产物 + `<root>/rulesets/<RULESET_VERSION>.json` + `<root>/maps/<TRIAL_MAP>.json`
 * + 三份基准脚本 + wasm 与 runtime bundle；跑 `TRIAL_SEEDS` 的三场；stdout 打面向模型的
 * 反馈文本（逐字回喂），退出码回答结论。
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
 * `0` 通过；`1` 预算超限（stdout = 回喂文本）；`2` 内部/infra 错误（用法错、读不到文件、
 * 规则集/地图未过校验、作废无法判定、引擎抛错——细节打 stderr）。gen 见 0/1 之外的码
 * 即大声失败，不回喂。不要把 `apps/cli/src/exit-codes.ts` 那张表套到这里：
 * 那张表的 1 是"装载期拒跑"，而这里的 1 是"拦下候选"，两码含义不同。
 *
 * ── 预算与组装复用 `assemble.ts` 的三处 ──
 *
 * 上限（`budgetOf`）、执行器映射（`budgetTracksOf`）、meta 头（`headForMap`）都从
 * `match/assemble.ts` 来：试跑与联赛跑在同一组阈值与同一组计数回调下，节流行为才一致。
 * 唯一不复用的是存档装载——候选此刻还不是存档（`commitArchive` 之前），脚本常驻内存。
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { type ReplayPlayerRef } from "@model-war/schema";
import { createQuickJsRunner } from "@model-war/engine/runner";

import { splitArgs } from "../args.js";
import { budgetOf, budgetTracksOf, headForMap } from "../match/assemble.js";
import { loadTrial, type LoadedTrial } from "./load.js";
import { runTrialMatch, type TrialMatchOutcome } from "./match-run.js";
import {
  trialObservationLines,
  writeTrialObservations,
  type TrialObservationLine,
} from "./observations.js";
import {
  CANDIDATE_SEAT,
  TRIAL_OPPONENTS,
  TRIAL_SEEDS,
  WATCHED_TRACKS,
  renderScoreSourceObservation,
  renderTrialFeedback,
  verdictOfTrips,
  type RecordedTrip,
} from "./trial.js";

const USAGE =
  "用法: node run-trial-script.js <候选产物.js> --root <安装根> [--observations <观测文件路径>]";

/** 试跑自己的退出码（见文件头：不是 CLI 全局表）。 */
const TRIAL_PASSED = 0;
const TRIAL_BLOCKED = 1;
const TRIAL_INFRA = 2;

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/** meta 行的四方：候选 0 号位 + 三个基准（只进 meta 行，不进判据）。 */
const trialPlayers = (): readonly ReplayPlayerRef[] => [
  { model: "trial-candidate", archiveRef: "trial/candidate", seat: 0 },
  ...TRIAL_OPPONENTS.map((name, index): ReplayPlayerRef => ({
    model: name,
    archiveRef: `trial/${name}`,
    seat: (index + 1) as ReplayPlayerRef["seat"],
  })),
];

/**
 * 跑三场：预算/执行器映射/meta 头全走 `assemble.ts` 的复用件；每场建四个 VM、跑完即释放。
 *
 * 作废（墙钟硬超时）同一种子重跑一次：仍作废则抛 infra（无法判定，大声失败，不回喂）。
 * 非判定触限（对手座位/非看轨）打到 stderr 留痕，不进 stdout（stdout 是回喂纯文本）。
 *
 * 每场的「无得分来源」读数都收进 `readings` 一并**带回**给调用方——落盘是输出副作用，
 * 归 `main`（那里才是 stdout / stderr / 退出码那一层的地盘），本函数只负责跑与收。
 */
const runThreeMatches = async (
  loaded: LoadedTrial,
): Promise<{
  readonly trips: readonly RecordedTrip[];
  readonly readings: readonly TrialObservationLine[];
}> => {
  const budget = budgetOf(loaded.ruleset);
  const tracks = budgetTracksOf(budget);
  const head = headForMap(loaded.mapSha256);
  const players = trialPlayers();
  const wasmModule = await WebAssembly.compile(loaded.wasmBytes);
  const trips: RecordedTrip[] = [];
  const readings: TrialObservationLine[] = [];
  // 哈希绑定与 runner 共用已加载的源码，不重读候选路径，也不使用前轮产物。
  const scriptSha256 = sha256(loaded.scripts[CANDIDATE_SEAT]);

  for (const [matchIndex, seed] of TRIAL_SEEDS.entries()) {
    const attempt = async (): Promise<TrialMatchOutcome> => {
      const handles = await Promise.all(
        ([0, 1, 2, 3] as const).map((seat) =>
          createQuickJsRunner({
            wasm: wasmModule,
            runtimeCode: loaded.runtimeCode,
            scriptCode: loaded.scripts[seat] ?? "",
            seat,
            ruleset: loaded.ruleset,
            ...tracks,
          }),
        ),
      );
      try {
        return runTrialMatch({
          runners: handles.map((handle) => handle.runner),
          players: [...players],
          ruleset: loaded.ruleset,
          map: loaded.map,
          seed,
          budget,
          head,
          matchIndex,
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
        `试跑注：第 ${String(matchIndex + 1)} 场在第 ${String(outcome.fault.tick)} tick 作废` +
          `（墙钟硬超时），同一种子重跑一次。\n`,
      );
      outcome = await attempt();
      if (outcome.fault !== null) {
        throw new Error(
          `第 ${String(matchIndex + 1)} 场两次作废（墙钟硬超时），无法判定候选是否超限`,
        );
      }
    }
    trips.push(...outcome.trips);
    const observation = renderScoreSourceObservation(matchIndex, outcome.scoreSource);
    if (observation !== null) {
      process.stderr.write(`${observation}\n`);
    }
    // 观测文件记的是**每一场**的读数，命中与否都记（命中的读数恒为 0/0，只记命中等于没有读数）。
    readings.push({
      matchIndex,
      ...outcome.scoreSource,
      ...(outcome.terminalSummary === undefined
        ? {}
        : { terminalSummary: outcome.terminalSummary }),
      actionFacts: {
        version: 1,
        scriptSha256,
        seed,
        seat: CANDIDATE_SEAT,
        ...outcome.actionFacts,
      },
    });
    // 早停：零容忍下首拦即定——后场的触限不可能把首触挤掉（到场序即数组序），
    // 全跑完只多花两场的 VM 时间，结论与反馈逐字相同。
    if (!verdictOfTrips(trips).passed) {
      break;
    }
  }
  return { trips, readings };
};

const main = async (argv: readonly string[]): Promise<number> => {
  const { root: rootArg, observationsPath, positional } = splitArgs(argv);
  const candidateArg = positional[0];
  if (candidateArg === undefined) {
    process.stderr.write(`缺候选产物参数。\n${USAGE}\n`);
    return TRIAL_INFRA;
  }
  const root = resolve(rootArg ?? process.cwd());

  let loaded: LoadedTrial;
  try {
    loaded = loadTrial(root, resolve(candidateArg));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`试跑装载失败:${reason}\n`);
    return TRIAL_INFRA;
  }

  let ran: {
    readonly trips: readonly RecordedTrip[];
    readonly readings: readonly TrialObservationLine[];
  };
  try {
    ran = await runThreeMatches(loaded);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`试跑执行失败:${reason}\n`);
    return TRIAL_INFRA;
  }
  const { trips, readings } = ran;

  // 观测落盘：在**结论之外**，三场跑完之后才写。早停时只有跑过的那几行（没跑的场没有读数）；
  // 某一轮试跑中途 infra（两场作废等）时这一轮一个字都不写，上一次**跑完**的读数留在盘上。
  if (observationsPath !== undefined) {
    const written = writeTrialObservations(observationsPath, trialObservationLines(readings));
    if (!written.ok) {
      process.stderr.write(`试跑注：观测文件写盘失败:${written.reason}\n`);
    }
  }

  const ignored = trips.filter(
    (trip) => trip.seat !== CANDIDATE_SEAT || !WATCHED_TRACKS.includes(trip.track),
  );
  if (ignored.length > 0) {
    process.stderr.write(
      `试跑注：忽略 ${String(ignored.length)} 条非判定触限（对手座位/非看轨），不计入结论。\n`,
    );
  }

  const verdict = verdictOfTrips(trips);
  process.stdout.write(`${renderTrialFeedback(verdict)}\n`);
  return verdict.passed ? TRIAL_PASSED : TRIAL_BLOCKED;
};

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (cause) {
  const reason = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`试跑未捕获异常:${reason}\n`);
  process.exitCode = TRIAL_INFRA;
}
