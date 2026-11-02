import {
  TRIAL_BENCHMARK_IDS,
  TRIAL_CANDIDATE_ID,
  type TrialTerminalPlayer,
  type TrialTerminalSummary,
} from "@model-war/schema";

/** 四方身份缺省走 v1 口径（候选 + 三份基准）；网格用例传计划里的 `seats`。 */
const v1Seats = [TRIAL_CANDIDATE_ID, ...TRIAL_BENCHMARK_IDS] as const;

/** 01 的真实 tickLimit=1 输出：每方基地4+资源1+两worker单位分1，总分6，四方并列积分1.5。 */
export const terminalSummaryFixture = (
  seed = 101,
  reason: TrialTerminalSummary["reason"] = "timeout",
  seats: readonly [string, string, string, string] = v1Seats,
) => {
  const player = (seat: TrialTerminalPlayer["seat"], id: string) => ({
    seat,
    player: id,
    controlledBases: 1,
    controlledResources: 1,
    survivingUnits: { worker: 2, melee: 0, ranged: 0, cavalry: 0 },
    survivingUnitCost: 8,
    score: { bases: 4, resources: 1, units: 1 },
    territoryScore: 6,
    rank: 1,
    rankPoints: 1.5,
    alive: true,
    eliminatedAtTick: null as number | null,
  });
  return {
    version: 1 as const,
    seed,
    tick: 1,
    reason,
    weights: { baseScore: 4, resourceScore: 1, unitCostDivisor: 6 },
    unitCosts: { worker: 4, melee: 8, ranged: 12, cavalry: 16 },
    rankPoints: [3, 2, 1, 0] satisfies TrialTerminalSummary["rankPoints"],
    players: [
      player(0, seats[0]),
      player(1, seats[1]),
      player(2, seats[2]),
      player(3, seats[3]),
    ] satisfies TrialTerminalSummary["players"],
  } satisfies TrialTerminalSummary;
};
