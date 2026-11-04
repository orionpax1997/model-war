/**
 * 评测网格的执行与证据落盘（**不起进程副作用**，入口脚本只做参数与退出码那一层）。
 *
 * ── 为什么单独一格 ──
 *
 * 入口脚本顶层就有 `process.exitCode = await main(...)`，import 它等于跑一次入口。于是
 * 「按计划跑满整张网格」与「写旁挂证据」搬到这里，让测试能对**缩小网格**（1 组合 × 2 座位 ×
 * 1 图）用真引擎直接断言，而不用在单元测试里跑满 32 场。
 *
 * ── 跑满，不再早停 ──
 *
 * 零容忍判定（`verdictOfTrips`）没变：任一场在候选座位的看轨上触限即打回。但网格的观测同时是
 * 反馈与分数的原料，所以**每一场都跑**，触限之后的后场照样记录；退出码仍由 `main` 按判定给 1。
 * 早停只会让后场没有读数，那在网格里等于丢样本。
 *
 * ── 单场仍可作废，重跑一次 ──
 *
 * 墙钟硬超时（`fault`）说明这一局没有结论：同种子重跑一次，两次都作废即 infra（大声失败，
 * 不写证据、不回喂）。非判定触限（对手座位/非看轨）只留痕，不进结论。
 */
import { createHash, randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";

import {
  TRIAL_CANDIDATE_ID,
  TRIAL_GRID_SUMMARY_SUFFIX,
  type ReplayPlayerRef,
  type ReplaySeat,
  type TrialGridSummary,
  type TrialPlan,
  type TrialPlanMatch,
} from "@model-war/schema";
import { buildTrialGridSummary } from "@model-war/runner";
import { createQuickJsRunner } from "@model-war/engine/runner";

import { budgetOf, budgetTracksOf, headForMap } from "../match/assemble.js";
import type { LoadedTrial } from "./load.js";
import { runTrialMatch, type TrialMatchOutcome } from "./match-run.js";
import type { TrialObservationLine } from "./observations.js";
import { renderScoreSourceObservation, type RecordedTrip } from "./trial.js";

/** 汇总文件的落点：与观测文件同目录、同前缀（`<观测文件>.grid.json`）。 */
export const gridSummaryPathOf = (observationsPath: string): string =>
  `${observationsPath}${TRIAL_GRID_SUMMARY_SUFFIX}`;

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

/** 一张跑完的网格交回的东西：触限记录（判定用）与逐场读数（证据用）。 */
export type TrialGridRun = {
  readonly trips: readonly RecordedTrip[];
  readonly readings: readonly TrialObservationLine[];
};

/**
 * 跑满计划里的每一场：预算/执行器映射/meta 头全走 `assemble.ts` 的复用件；
 * 每场建四个 VM、跑完即释放。
 *
 * 作废（墙钟硬超时）同一种子重跑一次：仍作废则抛 infra（无法判定，大声失败，不回喂）。
 * 非判定触限（对手座位/非看轨）只留痕，不进结论。**没有早停**（见文件头注）。
 */
export const runTrialGrid = async (loaded: LoadedTrial, plan: TrialPlan): Promise<TrialGridRun> => {
  const budget = budgetOf(loaded.ruleset);
  const tracks = budgetTracksOf(budget);
  const codes = codesOf(loaded);
  const wasmModule = await WebAssembly.compile(loaded.wasmBytes);
  const trips: RecordedTrip[] = [];
  const readings: TrialObservationLine[] = [];
  // 哈希绑定与 runner 共用已加载的源码，不重读候选路径，也不使用前轮产物。
  const scriptSha256 = trialScriptSha256(loaded);

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
        // 座位是每场参数（计划给），不是候选身份：网格里候选四个座位各坐一次。
        seat: match.candidateSeat,
        ...outcome.actionFacts,
      },
    });
  }
  return { trips, readings };
};

/** 候选编译产物摘要（执行器绑定观测行与汇总用的同一份字节）。 */
export const trialScriptSha256 = (loaded: LoadedTrial): string =>
  createHash("sha256").update(loaded.candidateCode).digest("hex");

/** 网格汇总 = 计划的投影；少一场/多一场由 runner 拒绝（不缩分母、不补零）。 */
export const summaryOfGrid = (
  plan: TrialPlan,
  scriptSha256: string,
  readings: readonly TrialObservationLine[],
): TrialGridSummary => buildTrialGridSummary({ plan, scriptSha256, readings });

/** 原子写汇总：同目录写 `.tmp-*` 再 rename（不覆盖半截文件）。失败收成原因，不抛。 */
export const writeTrialGridSummary = (
  path: string,
  summary: TrialGridSummary,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`);
    renameSync(temporary, path);
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
};
