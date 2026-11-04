/**
 * 网格计分：一张跑满的评测网格 → 候选**唯一**的分数（平均名次积分）。
 *
 * ── 分数只有一种定义 ──
 *
 * `totalPoints` = Σ 每场名次积分；`averagePoints` = `totalPoints / countedMatches`；
 * `countedMatches` **恒等于计划声明的场数**（`plan.matchesPerCandidate`，网格当前 32）。
 * 于是「候选有多好」在试跑、存档、选拔三处是同一个数，不再各有一把尺子。
 *
 * ── 算术不在这里，也不许在这里另写一套 ──
 *
 * 一局里四方怎么分名次积分（并列占名次区间均分——并列第 2 的二人各得 (2+1)/2 = 1.5）、
 * 以及跨场累计，唯一真源是 `ranker.ts`：本模块只用它的 `rankSeason`（内部与选拔逐场用的
 * `perMatchScores` 是同一段 `scoreOfMatch`，用公共分母 12 的整数记账，不引入浮点累加顺序依赖）。
 * timeout 与 all-eliminated 在计分上**没有特例**：名次照算、积分照给——这一点与选拔逐字一致
 * （选拔侧 `scoreOfMatch` 同样不看 `reason`）。
 *
 * ── 缺场不缩分母，缺失不当零分 ──
 *
 * 网格的完整性只回答一件事：计划里的每一场是不是都有一份属于自己的终局。少一场、多一场、
 * 同一场两条读数、`matchIndex` 不在计划里——一律拒绝，并**指到具体场次**。读数里的终局若说的
 * 不是这一场（种子不符、座位上的身份不符、名次不成四座竞争排名），同样拒绝：那是「这份读数
 * 不属于这个格子」，把它算进来等于悄悄换了一场比赛。
 *
 * 纯度：无 I/O、无随机、无时钟；同输入恒同输出（`totalPoints` 由整数记账后一次性除出，
 * 所以同一组观测重算两次逐字相同）。
 */

import {
  TRIAL_CANDIDATE_ID,
  type TrialGridScore,
  type TrialPlan,
  type TrialTerminalSummary,
} from "@model-war/schema";

import { competitiveRankingIssue, rankSeason, type RankedMatch } from "./ranker.js";

export type { TrialGridScore };

/** 计分只吃这两样：这一场是哪一格、它的终局事实（`TrialObservationLine` 结构兼容）。 */
export type TrialGridReading = {
  readonly matchIndex: number;
  readonly terminalSummary?: TrialTerminalSummary;
};

/** 拒绝的理由统一带上「哪一票的口径」前缀，便于从 gen / CLI 的报错里认出来源。 */
const errorOf = (reason: string): Error => new Error(`试跑网格无法计分：${reason}`);

/**
 * 一张跑满的网格 → 候选的分数。
 *
 * `readings` 的次序无关（按计划的 `matchIndex` 对齐）；缺场、多场、重复场、计划不认识的
 * `matchIndex`、以及「读数不属于这个格子」全部抛错并指明场次。
 */
export const scoreTrialGrid = (
  plan: TrialPlan,
  readings: readonly TrialGridReading[],
): TrialGridScore => {
  const byMatchIndex = new Map<number, TrialGridReading>();
  for (const reading of readings) {
    if (byMatchIndex.has(reading.matchIndex))
      throw errorOf(`第 ${String(reading.matchIndex)} 场出现了多条读数（一份网格每格恰好一场）`);
    byMatchIndex.set(reading.matchIndex, reading);
  }
  const planned = new Set(plan.matches.map((match) => match.matchIndex));
  const unknown = [...byMatchIndex.keys()].filter((matchIndex) => !planned.has(matchIndex));
  if (unknown.length > 0) throw errorOf(`第 ${unknown.join(" / ")} 场不在计划里`);
  const missing = plan.matches
    .filter((match) => !byMatchIndex.has(match.matchIndex))
    .map((match) => match.matchIndex);
  if (missing.length > 0)
    throw errorOf(`计划里的第 ${missing.join(" / ")} 场没有读数（不缩分母、不补零）`);

  const ranked = plan.matches
    .map((match): RankedMatch => {
      const reading = byMatchIndex.get(match.matchIndex);
      if (reading === undefined)
        throw errorOf(`计划里的第 ${String(match.matchIndex)} 场没有读数（不缩分母、不补零）`);
      const terminal = reading.terminalSummary;
      if (terminal === undefined)
        throw errorOf(`第 ${String(match.matchIndex)} 场缺少终局事实（缺失不当成零分）`);
      if (terminal.seed !== match.seed)
        throw errorOf(
          `第 ${String(match.matchIndex)} 场的终局种子 ${String(terminal.seed)}` +
            `与本场计划种子 ${String(match.seed)} 不符`,
        );
      const ranks = terminal.players.map((player, seat) => {
        if (player.seat !== seat)
          throw errorOf(
            `第 ${String(match.matchIndex)} 场的终局第 ${String(seat)} 格记的是` +
              `座位 ${String(player.seat)}`,
          );
        const expected = match.seats[seat]!;
        if (player.player !== expected)
          throw errorOf(
            `第 ${String(match.matchIndex)} 场座位 ${String(seat)} 的终局身份 ${player.player}` +
              `与本场座位表的 ${expected} 不符`,
          );
        return player.rank;
      });
      const issue = competitiveRankingIssue(ranks);
      if (issue !== undefined) throw errorOf(`第 ${String(match.matchIndex)} 场：${issue}`);
      return {
        matchId: String(match.matchIndex),
        standings: match.seats.map((player, seat) => ({
          player,
          rank: ranks[seat]!,
        })),
      };
    })
    .sort((left, right) => Number(left.matchId) - Number(right.matchId));

  const entry = rankSeason(ranked, { players: [TRIAL_CANDIDATE_ID] }).find(
    (candidate) => candidate.player === TRIAL_CANDIDATE_ID,
  );
  if (entry === undefined) throw errorOf("名次记账里没有候选这一行");
  if (entry.countedMatches !== plan.matchesPerCandidate)
    throw errorOf(
      `候选只被计了 ${String(entry.countedMatches)} 场，` +
        `计划声明 ${String(plan.matchesPerCandidate)} 场（不缩分母、不补零）`,
    );
  return {
    totalPoints: entry.totalPoints,
    averagePoints: entry.averagePoints,
    countedMatches: plan.matchesPerCandidate,
  };
};
