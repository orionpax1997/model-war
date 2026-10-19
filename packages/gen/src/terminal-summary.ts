import {
  TRIAL_PLAYER_IDS,
  TRIAL_SEEDS,
  TRIAL_TERMINAL_SUMMARY_JSON_SCHEMA,
  type TrialTerminalPlayer,
  type TrialTerminalSummary,
  type TrialUnitTable,
} from "@model-war/schema";
import { compileProtocolSchema } from "./protocol-schema.js";

const matchesSummary = compileProtocolSchema(TRIAL_TERMINAL_SUMMARY_JSON_SCHEMA);

const consistentPlayer = (
  summary: TrialTerminalSummary,
  player: TrialTerminalPlayer,
  seat: number,
): boolean => {
  const costTerms = [
    player.survivingUnits.worker * summary.unitCosts.worker,
    player.survivingUnits.melee * summary.unitCosts.melee,
    player.survivingUnits.ranged * summary.unitCosts.ranged,
    player.survivingUnits.cavalry * summary.unitCosts.cavalry,
  ];
  const cost = costTerms.reduce((sum, term) => sum + term, 0);
  const bases = player.controlledBases * summary.weights.baseScore;
  const resources = player.controlledResources * summary.weights.resourceScore;
  const units = Math.floor(cost / summary.weights.unitCostDivisor);
  const territory = bases + resources + units;
  return (
    player.seat === seat &&
    player.player === TRIAL_PLAYER_IDS[seat] &&
    [...costTerms, cost, bases, resources, units, territory].every(Number.isSafeInteger) &&
    player.survivingUnitCost === cost &&
    player.score.bases === bases &&
    player.score.resources === resources &&
    player.score.units === units &&
    player.territoryScore === territory &&
    // 步 5 会清空所有淘汰方点位，但异常淘汰可留下单位与单位分。
    (player.alive || (player.controlledBases === 0 && player.controlledResources === 0)) &&
    player.alive === (player.eliminatedAtTick === null) &&
    (player.eliminatedAtTick === null || player.eliminatedAtTick < summary.tick)
  );
};
const consistentRanks = (summary: TrialTerminalSummary): boolean => {
  const players = summary.players;
  const hasWinner = summary.reason === "victory" || summary.reason === "shortcut";
  const first = players.filter((player) => player.rank === 1);
  if (hasWinner && (first.length !== 1 || first[0]?.alive !== true)) return false;
  if (summary.reason === "all-eliminated" && players.some((player) => player.alive)) return false;
  // 步 5 的零/单存活结局先于步 7 timeout，故 timeout 至少两方存活。
  if (summary.reason === "timeout" && players.filter((player) => player.alive).length < 2)
    return false;
  const winner = hasWinner ? first[0] : undefined;
  if (summary.reason === "shortcut" && players.filter((player) => player.alive).length !== 1)
    return false;
  // 步 5 全点位判定需要非空点位表；只核对胜者有点位、非胜者零控点，不猜地图总数。
  if (
    summary.reason === "victory" &&
    (winner === undefined ||
      (winner.controlledBases === 0 && winner.controlledResources === 0) ||
      players.some(
        (player) =>
          player !== winner && (player.controlledBases !== 0 || player.controlledResources !== 0),
      ))
  )
    return false;
  const layer = (player: TrialTerminalPlayer): number =>
    player === winner ? 0 : player.alive ? 1 : 2;
  const key = (player: TrialTerminalPlayer): number =>
    player.alive ? player.territoryScore : (player.eliminatedAtTick ?? 0);
  return players.every((player) => {
    // competition rank = 严格排在本方之前的座位数 + 1；并列不占另一名次。
    const rank =
      1 +
      players.filter(
        (other) =>
          layer(other) < layer(player) ||
          (layer(other) === layer(player) && key(other) > key(player)),
      ).length;
    if (player.rank !== rank) return false;
    const tied = players.filter((other) => other.rank === rank).length;
    const interval = summary.rankPoints.slice(rank - 1, rank - 1 + tied);
    const total = interval.reduce((sum, points) => sum + points, 0);
    // 与生产记账的公共分母一致；安全整数中间值避免浮点舍入伪造积分。
    const scaled = total * (12 / tied);
    return (
      interval.length === tied &&
      Number.isSafeInteger(total) &&
      Number.isSafeInteger(scaled) &&
      player.rankPoints === scaled / 12
    );
  });
};

const unitsOf = (value: TrialUnitTable): TrialUnitTable => ({
  worker: value.worker,
  melee: value.melee,
  ranged: value.ranged,
  cavalry: value.cavalry,
});
const playerOf = (value: TrialTerminalPlayer): TrialTerminalPlayer => ({
  seat: value.seat,
  player: value.player,
  controlledBases: value.controlledBases,
  controlledResources: value.controlledResources,
  survivingUnits: unitsOf(value.survivingUnits),
  survivingUnitCost: value.survivingUnitCost,
  score: { bases: value.score.bases, resources: value.score.resources, units: value.score.units },
  territoryScore: value.territoryScore,
  rank: value.rank,
  rankPoints: value.rankPoints,
  alive: value.alive,
  eliminatedAtTick: value.eliminatedAtTick,
});

/** 优化试跑终局的公共读入边界；非法数据返回 null，缺失不能补成零分。 */
export const parseTrialTerminalSummary = (
  value: unknown,
  matchIndex: number,
): TrialTerminalSummary | null => {
  if (!matchesSummary(value)) return null;
  // 仅在共享 JSON Schema 验证后恢复数据合同；公共出口始终显式逐字段重建。
  const summary = value as TrialTerminalSummary;
  if (
    summary.tick === 0 ||
    !Number.isInteger(matchIndex) ||
    summary.seed !== TRIAL_SEEDS[matchIndex] ||
    !summary.players.every((player, seat) => consistentPlayer(summary, player, seat)) ||
    !consistentRanks(summary)
  )
    return null;
  return {
    version: summary.version,
    seed: summary.seed,
    tick: summary.tick,
    reason: summary.reason,
    weights: {
      baseScore: summary.weights.baseScore,
      resourceScore: summary.weights.resourceScore,
      unitCostDivisor: summary.weights.unitCostDivisor,
    },
    unitCosts: unitsOf(summary.unitCosts),
    rankPoints: [
      summary.rankPoints[0],
      summary.rankPoints[1],
      summary.rankPoints[2],
      summary.rankPoints[3],
    ],
    players: [
      playerOf(summary.players[0]),
      playerOf(summary.players[1]),
      playerOf(summary.players[2]),
      playerOf(summary.players[3]),
    ],
  };
};
