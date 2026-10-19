import type { TrialTerminalPlayer, TrialTerminalSummary } from "@model-war/schema";

/** 01 的真实 tickLimit=1 输出：每方基地4+资源1+两worker单位分1，总分6，四方并列积分1.5。 */
export const terminalSummaryFixture = (
  seed = 101,
  reason: TrialTerminalSummary["reason"] = "timeout",
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
      player(0, "candidate"),
      player(1, "cell-a-melee-pressure"),
      player(2, "cell-b-expansion-economy"),
      player(3, "cell-c-claim-no-harvest"),
    ] satisfies TrialTerminalSummary["players"],
  } satisfies TrialTerminalSummary;
};
