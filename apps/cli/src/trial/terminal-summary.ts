/** completed 的真实 finalState/result 投影；排名直接读引擎，积分复用 runner。 */
import type { runMatch, RunMatchParams } from "@model-war/engine";
import { DEFAULT_RANK_POINTS, perMatchScores } from "@model-war/runner";
import type { ReplaySeat, TrialTerminalPlayer, TrialTerminalSummary } from "@model-war/schema";

import { CANDIDATE_SEAT } from "./trial.js";

type CompletedMatch = Extract<ReturnType<typeof runMatch>, { readonly status: "completed" }>;

export const terminalSummaryOf = (
  outcome: CompletedMatch,
  options: {
    readonly seed: number;
    readonly ruleset: RunMatchParams["ruleset"];
    readonly players: RunMatchParams["players"];
  },
): TrialTerminalSummary => {
  const { finalState: state, result } = outcome;
  const { ruleset } = options;
  const weights = {
    baseScore: ruleset.baseScore,
    resourceScore: ruleset.resourceScore,
    unitCostDivisor: ruleset.unitCostDivisor,
  };
  const unitCosts = {
    worker: ruleset.worker.cost,
    melee: ruleset.melee.cost,
    ranged: ruleset.ranged.cost,
    cavalry: ruleset.cavalry.cost,
  };
  const playerOf = (seat: ReplaySeat): Omit<TrialTerminalPlayer, "rankPoints"> => {
    const reference = options.players[seat];
    const player = state.players[seat];
    const rank = result.rankings[seat];
    const territoryScore = result.territoryScores[seat];
    const eliminatedAtTick = state.eliminatedAtTick[seat];
    if (
      reference?.seat !== seat ||
      player === undefined ||
      rank === undefined ||
      territoryScore === undefined ||
      eliminatedAtTick === undefined
    ) {
      throw new Error(`试跑 completed 缺少座位 ${String(seat)} 的真实终局数据`);
    }
    const controlledBases = state.sites.filter(
      (site) => site.owner === seat && site.kind === "base",
    ).length;
    const controlledResources = state.sites.filter(
      (site) => site.owner === seat && site.kind === "resource",
    ).length;
    const survivingUnits = { worker: 0, melee: 0, ranged: 0, cavalry: 0 };
    let survivingUnitCost = 0;
    for (const unit of state.units) {
      if (unit.owner === seat) {
        survivingUnits[unit.type] += 1;
        survivingUnitCost += unitCosts[unit.type];
      }
    }
    const score = {
      bases: controlledBases * weights.baseScore,
      resources: controlledResources * weights.resourceScore,
      units: Math.floor(survivingUnitCost / weights.unitCostDivisor),
    };
    if (score.bases + score.resources + score.units !== territoryScore) {
      throw new Error(`试跑座位 ${String(seat)} 终局计分依据与引擎 result 不一致`);
    }
    return {
      seat,
      player: seat === CANDIDATE_SEAT ? "candidate" : reference.model,
      controlledBases,
      controlledResources,
      survivingUnits,
      survivingUnitCost,
      score,
      territoryScore,
      rank,
      alive: player.alive,
      eliminatedAtTick,
    };
  };
  const players = [playerOf(0), playerOf(1), playerOf(2), playerOf(3)] as const;
  const scores = perMatchScores(
    `trial-${String(options.seed)}`,
    players.map(({ player, rank }) => ({ player, rank })),
    DEFAULT_RANK_POINTS,
  );
  const withPoints = (player: Omit<TrialTerminalPlayer, "rankPoints">): TrialTerminalPlayer => {
    const rankPoints = scores[player.seat];
    if (rankPoints === undefined) {
      throw new Error(`试跑座位 ${String(player.seat)} 缺少名次积分`);
    }
    return { ...player, rankPoints };
  };
  return {
    version: 1,
    seed: options.seed,
    tick: state.tick,
    reason: result.reason,
    weights,
    unitCosts,
    rankPoints: [...DEFAULT_RANK_POINTS],
    players: [
      withPoints(players[0]),
      withPoints(players[1]),
      withPoints(players[2]),
      withPoints(players[3]),
    ],
  };
};
