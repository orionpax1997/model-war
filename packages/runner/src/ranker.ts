/**
 * ranker:名次积分纯函数(hld §3.1 的 `runner:ranker`:名次积分、并列处理)。
 *
 * 纯度契约:无 I/O、无随机、无时钟;同输入恒同输出。因此本模块不碰 `node:*`,只做纯记账。
 * 唯一可能的不确定来源——浮点累加的入参顺序依赖——用「公共分母 12 的整数记账」消掉:
 * 一局内并列 t 人时,区间分值之和乘以 (12 / t) 累加为整数,仅在输出时除以 12。
 *
 * v0 不做 Elo:输出里没有 `elo` 字段(连 `elo: null` 都不留半成品)。
 *
 * 名次区间规则(并列名次分):并列于名次 r 的 t 名参赛者占名次 r..r+t-1,
 * 每人得分 = (rankPoints[r-1] + … + rankPoints[r+t-2]) / t。并列第 2 二人 → (2+1)/2 = 1.5。
 */

/** 名次积分表:四方对局,第 i 项 = 第 i+1 名的分值。定长 4 元组(MatchInputArchives 同款先例)。 */
export type RankPoints = readonly [number, number, number, number];

/** 默认名次积分 [3,2,1,0]。不进 `rulesets/`(它是对局调度配置,不是规则机制),由调用方按需覆写。 */
export const DEFAULT_RANK_POINTS: RankPoints = [3, 2, 1, 0];

/** 一名参赛者在某局里的名次(1 起,可并列)。 */
export type MatchStanding = {
  readonly player: string;
  readonly rank: number;
};

/** 一局已判定的对局。失败局由调用方剔除,不进这里 —— 有效局数因而只数传进来的局。 */
export type RankedMatch = {
  readonly matchId: string;
  readonly standings: readonly MatchStanding[];
};

/** 赛季里一名参赛者的记账结果。 */
export type RankedEntry = {
  readonly player: string;
  /** 赛季总分 = Σ 对局得分。 */
  readonly totalPoints: number;
  /** 有效局数 = 参与并被计分的对局数,亦即对局均分的分母(暴露小样本)。 */
  readonly countedMatches: number;
  /** 对局均分 = 赛季总分 / 有效局数;有效局数为 0 时为 0。 */
  readonly averagePoints: number;
  /** 排名(1 起)。竞争排名:同分并列,并列后下一名次跳号(如 1,1,3)。 */
  readonly rank: number;
};

/** 公共分母:LCM(1,2,3,4) = 12。四方位次下任意并列人数 t∈{1,2,3,4} 都能整除它。 */
const SCORE_DENOMINATOR = 12;

export type RankSeasonOptions = {
  /** 赛季名册(存档引用或 slug,身份由调用方定)。未参赛者也会出现在输出里(有效局数 0)。 */
  readonly players: readonly string[];
  /** 覆写名次积分表;缺省 [3,2,1,0]。 */
  readonly rankPoints?: RankPoints;
};

/**
 * 由每局名次与 `rankPoints` 算出每名参赛者的赛季总分、有效局数、对局均分与排名。
 *
 * - 失败局不进 `matches`(调用方过滤),`countedMatches` 自然只数有效局。
 * - 输出覆盖 `options.players` 全体;对局里出现但不在名册里的参赛者也会被计入(不丢数据)。
 * - 排名按对局均分降序;同分并列,输出顺序以参赛者名升序稳定排序。
 */
export const rankSeason = (
  matches: readonly RankedMatch[],
  options: RankSeasonOptions,
): readonly RankedEntry[] => {
  const rankPoints = normalizedRankPoints(options.rankPoints);

  const totalMilli = new Map<string, number>();
  const countedMatches = new Map<string, number>();
  const ensure = (player: string): void => {
    if (!totalMilli.has(player)) {
      totalMilli.set(player, 0);
      countedMatches.set(player, 0);
    }
  };

  for (const player of options.players) {
    ensure(player);
  }

  for (const rankedMatch of matches) {
    for (const [player, milli] of scoreOfMatch(rankedMatch, rankPoints)) {
      ensure(player);
      totalMilli.set(player, (totalMilli.get(player) ?? 0) + milli);
      countedMatches.set(player, (countedMatches.get(player) ?? 0) + 1);
    }
  }

  const entries = [...totalMilli.keys()].map((player): RankedEntry => {
    const totalPoints = (totalMilli.get(player) ?? 0) / SCORE_DENOMINATOR;
    const played = countedMatches.get(player) ?? 0;
    return {
      player,
      totalPoints,
      countedMatches: played,
      averagePoints: played === 0 ? 0 : totalPoints / played,
      rank: 0,
    };
  });

  const sorted = entries.sort((left, right) =>
    right.averagePoints === left.averagePoints
      ? left.player.localeCompare(right.player)
      : right.averagePoints - left.averagePoints,
  );

  let currentRank = 0;
  return sorted.map((entry, index): RankedEntry => {
    const previous = sorted[index - 1];
    if (previous === undefined || previous.averagePoints !== entry.averagePoints) {
      currentRank = index + 1;
    }
    return { ...entry, rank: currentRank };
  });
};

/**
 * 校验一份候选名次积分表:长度必须为 4、每项必须是有限数。
 *
 * 返回**第一条**问题(`season.yaml` 装载器据此聚合成"一次看完"的清单);无问题返回 `undefined`。
 * `rankSeason` 与 `loadSeasonConfig` 共用这一处判据,避免两条校验栈漂移。
 */
export const rankPointsIssue = (values: readonly unknown[]): string | undefined => {
  if (values.length !== 4) {
    return `rankPoints 长度必须为 4(四方对局),实际 ${values.length}`;
  }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `rankPoints[${index}] 必须是有限数,实际 ${String(value)}`;
    }
  }
  return undefined;
};

/** 校验并归一 `rankPoints`:长度必须为 4、每项必须是有限数。 */
const normalizedRankPoints = (input: RankPoints | undefined): RankPoints => {
  const values = input ?? DEFAULT_RANK_POINTS;
  const issue = rankPointsIssue(values);
  if (issue !== undefined) {
    throw new Error(issue);
  }
  return input ?? DEFAULT_RANK_POINTS;
};

/**
 * 一局里每**座位**的得分(下标与 `standings` 的次序一致 = 座位号),按 `rankPoints` 与并列规则算。
 *
 * 复用 `rankSeason` 的同一套公式(公共分母 12 的整数记账后除以 12),供报告侧写 `perMatchScores`:
 * 报告读者据此不必先实现 ranker 就能对分。失败局不进这里(调用方过滤)。
 *
 * `standings` 的次序即座位序(调用方按 `seats` 的下标构造);本函数不做重复参赛者去重——
 * 真实对局里一局四个座位必为互异的存档引用。
 */
export const perMatchScores = (
  matchId: string,
  standings: readonly MatchStanding[],
  rankPoints?: RankPoints,
): readonly number[] => {
  const points = normalizedRankPoints(rankPoints);
  const milliByPlayer = scoreOfMatch({ matchId, standings }, points);
  return standings.map((standing) => (milliByPlayer.get(standing.player) ?? 0) / SCORE_DENOMINATOR);
};

/** 算出一局里每名参赛者的得分(以 1/12 为单位累加的整数)。 */
const scoreOfMatch = (rankedMatch: RankedMatch, rankPoints: RankPoints): Map<string, number> => {
  const tiedCountByRank = new Map<number, number>();
  for (const standing of rankedMatch.standings) {
    tiedCountByRank.set(standing.rank, (tiedCountByRank.get(standing.rank) ?? 0) + 1);
  }

  const milliByRank = new Map<number, number>();
  for (const [rank, tiedCount] of tiedCountByRank) {
    const start = rank - 1;
    const end = start + tiedCount;
    if (!Number.isInteger(rank) || rank < 1 || end > rankPoints.length) {
      throw new Error(
        `对局 ${rankedMatch.matchId}:名次 ${rank}(并列 ${tiedCount} 人)越界——` +
          `四方对局的名次区间须落在 1..${rankPoints.length}`,
      );
    }
    if (SCORE_DENOMINATOR % tiedCount !== 0) {
      throw new Error(
        `对局 ${rankedMatch.matchId}:并列人数 ${tiedCount} 超出四方对局范围` +
          `(须整除 ${SCORE_DENOMINATOR})`,
      );
    }
    let intervalSum = 0;
    for (let index = start; index < end; index += 1) {
      intervalSum += rankPoints[index] ?? 0;
    }
    milliByRank.set(rank, intervalSum * (SCORE_DENOMINATOR / tiedCount));
  }

  const perPlayer = new Map<string, number>();
  for (const standing of rankedMatch.standings) {
    perPlayer.set(standing.player, milliByRank.get(standing.rank) ?? 0);
  }
  return perPlayer;
};
