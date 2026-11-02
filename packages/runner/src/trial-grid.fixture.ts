/**
 * 网格计分测试用的夹具：一张 32 场的真计划 + 任意名次结构的终局事实。
 *
 * 放在独立文件里（不是 `.test.ts`）是为了让「试跑计划的汇总」与「网格计分」两份测试共用同一套
 * 夹具，又不互相触发对方的用例。它只造数据，不跑对局、不写盘。
 */

import {
  TRIAL_GRID_MAP_NAMES,
  TRIAL_SPARRING_LADDER,
  TRIAL_SPARRING_SUBSTITUTE,
  type TrialPlan,
  type TrialPlanMatch,
  type TrialPlanScript,
  type TrialTerminalPlayer,
  type TrialTerminalSummary,
} from "@model-war/schema";

import { DEFAULT_RANK_POINTS, perMatchScores } from "./ranker.js";
import { buildTrialPlan, type BuildTrialPlanInput } from "./trial-plan.js";
import type { TrialGridReading } from "./trial-score.js";

/** 四份陪练的事实（与 `loadSparringPool` 交回的形状一致）。 */
const sparringScripts: readonly TrialPlanScript[] = [
  ...TRIAL_SPARRING_LADDER.map((identity) => ({
    id: `${identity.role}:${identity.id}`,
    role: identity.role,
    source: `archive:${identity.id}/${identity.runId}`,
    scriptSha256: identity.scriptSha256,
  })),
  {
    id: `incumbent:${TRIAL_SPARRING_SUBSTITUTE.id}`,
    role: "incumbent" as const,
    source: `archive:${TRIAL_SPARRING_SUBSTITUTE.id}/${TRIAL_SPARRING_SUBSTITUTE.runId}#substitute`,
    scriptSha256: TRIAL_SPARRING_SUBSTITUTE.scriptSha256,
  },
];

/** 生产形状的 32 场计划（4 组合 × 4 座位 × 2 图）。 */
export const trialGridPlanFixture = (): TrialPlan =>
  buildTrialPlan({
    ruleset: "v2",
    rulesetSha256: "9".repeat(64),
    sandboxRuntimeHash: "8".repeat(64),
    scripts: sparringScripts,
    maps: [
      { name: TRIAL_GRID_MAP_NAMES[0], sha256: "f".repeat(64) },
      { name: TRIAL_GRID_MAP_NAMES[1], sha256: "e".repeat(64) },
    ],
  } satisfies BuildTrialPlanInput);

/**
 * 一场的终局事实：四方身份取本场座位表，名次按**座位序**给定（`ranks[seat]`）。
 *
 * 名次积分用 runner 自己的 `perMatchScores` 填（与真实终局同一算法），于是夹具不会自带
 * 第二套算术；计分的断言仍然只看候选的总分与均分。
 */
export const terminalSummaryFixture = (
  match: TrialPlanMatch,
  ranks: readonly number[],
  reason: TrialTerminalSummary["reason"] = "victory",
): TrialTerminalSummary => {
  const points = perMatchScores(
    `trial-${String(match.seed)}`,
    match.seats.map((player, seat) => ({ player, rank: ranks[seat] ?? 1 })),
    DEFAULT_RANK_POINTS,
  );
  const playerOf = (seat: TrialTerminalPlayer["seat"]): TrialTerminalPlayer => ({
    seat,
    player: match.seats[seat]!,
    controlledBases: 1,
    controlledResources: 1,
    survivingUnits: { worker: 2, melee: 0, ranged: 0, cavalry: 0 },
    survivingUnitCost: 8,
    score: { bases: 4, resources: 1, units: 1 },
    territoryScore: 6,
    rank: ranks[seat] ?? 1,
    rankPoints: points[seat] ?? 0,
    alive: reason !== "all-eliminated",
    eliminatedAtTick: null,
  });
  return {
    version: 1,
    seed: match.seed,
    tick: 400,
    reason,
    weights: { baseScore: 4, resourceScore: 1, unitCostDivisor: 6 },
    unitCosts: { worker: 4, melee: 8, ranged: 12, cavalry: 16 },
    rankPoints: DEFAULT_RANK_POINTS,
    players: [playerOf(0), playerOf(1), playerOf(2), playerOf(3)],
  };
};

/**
 * 候选在某一场里拿第 `rank` 名、其余三方按名次升序补满的座位序名次表。
 *
 * 「候选全胜 / 全败」这类与座位无关的口径用它，免得把「候选座位会轮转」写进断言。
 */
export const ranksWithCandidate = (match: TrialPlanMatch, rank: number): readonly number[] => {
  const rest = [1, 2, 3, 4].filter((value) => value !== rank);
  return match.seats.map((_, seat) =>
    seat === match.candidateSeat ? rank : (rest.shift() ?? rank),
  );
};

/** 一张网格的读数：`ranksOf` 给每场的座位序名次表；返回 `undefined` 表示这一场没有读数。 */
export const gridReadingsFixture = (
  plan: TrialPlan,
  ranksOf: (match: TrialPlanMatch, index: number) => readonly number[] | undefined = (match) =>
    ranksWithCandidate(match, 1),
  reasonOf: (match: TrialPlanMatch) => TrialTerminalSummary["reason"] = () => "victory",
): TrialGridReading[] =>
  plan.matches.flatMap((match, index) => {
    const ranks = ranksOf(match, index);
    if (ranks === undefined) return [];
    return [
      {
        matchIndex: match.matchIndex,
        terminalSummary: terminalSummaryFixture(match, ranks, reasonOf(match)),
      },
    ];
  });
