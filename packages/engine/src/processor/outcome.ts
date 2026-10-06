/**
 * 终局结果的构造:领土分、名次与胜者(gdd《胜利与淘汰》)。**这一节就是那份算法的家**。
 *
 * ── 名次四条(逐字照 gdd) ──
 *
 * 1) 获胜者(胜利或捷径条款)为第 1 名;
 * 2) 其余参赛者按存活状态分层:存活者排在已淘汰者之前;
 * 3) 层内:存活者按领土分降序;已淘汰者按淘汰时间倒序(后出局者名次更前);
 * 4) 仍完全相同 → 并列同名次(赛季记分处理见 hld《排名》)。
 *
 * ── 为什么名次算法只写一处 ──
 *
 * 第 1 名与「并列」不是两套规则:它们是**同一次排序 + 同一次名次编号**的两个读法。胜者只是
 * 被排在首位、且它的并列键与别人都不同,于是名次编号自然给出它 1。若给「胜者第 1」单开一个
 * 分支,那个分支就与「并列」那条各写一次名次数字,两处必然漂移(一处把并列位跳过了、另一处没跳)。
 * `competitionRanks` 是那次编号的唯一实现,两种情形共用它——占用的名次位按并列人数跳过
 * (并列第 2 的两方都记 2,下一个是第 4)。
 *
 * ── 全整数 ──
 *
 * 领土分三项全从 `ruleset.raw` 读,代码里不出现 4 / 1 / 6 这类取值。除法 `Math.floor(总造价 / unitCostDivisor)`
 * 仍是整数闭包:两个操作数都是远小于 `2^53` 的整数,浮点中间值精确,`Math.floor` 落在 `Math` 白名单内,
 * 结果是一个整数。门禁禁的是**浮点字面量**,不是 `/` 运算符;这里既没有浮点字面量,也不引入
 * `Math.round` 一类会把中间值带出整数域的东西。
 *
 * ── 已淘汰者的领土分恒为 0 —— 它是公式的推论,不是特例 ──
 *
 * 一个已淘汰的座位名下没有单位(淘汰条件之一)、点位也已在步 5 的 b) 段全部回归中立,于是
 * `baseCount = resourceCount = unitCost = 0`、三项全 0。这里**不写**「已淘汰 → 0」的分支:
 * 写它就是给那个推论单开一条路,而那条路会在「淘汰与回归中立之间」的中间态上给出和公式不同的答案。
 */

import type { RulesetView } from "../ruleset-loader/index.js";
import type { GameState, Outcome, OutcomeReason, PlayerIndex, UnitType } from "../world/state.js";

/** 四个座位,下标即座位号(hld §2.3)。名次数组与领土分数组都按它排。 */
const SEATS: readonly PlayerIndex[] = [0, 1, 2, 3];

/** 一个座位的领土分(gdd《胜利与淘汰》的那条公式)。中立点位(`owner === -1`)不计入任何人。 */
export const territoryScoreOf = (
  state: GameState,
  ruleset: RulesetView,
  seat: PlayerIndex,
): number => {
  let bases = 0;
  let resources = 0;
  for (const site of state.sites) {
    if (site.owner !== seat) {
      continue;
    }
    if (site.kind === "base") {
      bases += 1;
    } else {
      resources += 1;
    }
  }
  let unitCost = 0;
  for (const unit of state.units) {
    if (unit.owner === seat) {
      unitCost += costOf(ruleset, unit.type);
    }
  }
  return (
    ruleset.raw.baseScore * bases +
    ruleset.raw.resourceScore * resources +
    Math.floor(unitCost / ruleset.raw.unitCostDivisor)
  );
};

/**
 * 一个座位在排序里的层与并列键。
 *
 * 层是一个数:0 = 胜者(至多一个)、1 = 存活、2 = 已淘汰。层与键**一起**决定「仍完全相同」:
 * 同层且同键才并列,存活者与已淘汰者即使数值相同也**不**并列(第 2 条分层优先于第 4 条)。
 * 键在层内降序:存活层是领土分,已淘汰层是淘汰时刻。已淘汰者的 `eliminatedAtTick` 在正常
 * 路径上必非 `null`(淘汰与记录是同一条变更写下的),但类型上仍是可空的,故取 `?? -1` 兜底。
 */
type RankKey = { readonly layer: 0 | 1 | 2; readonly key: number };

const rankKeyOf = (
  state: GameState,
  ruleset: RulesetView,
  seat: PlayerIndex,
  winnerSeat: PlayerIndex | null,
): RankKey => {
  if (seat === winnerSeat) {
    return { layer: 0, key: 0 };
  }
  if (state.players[seat]?.alive === true) {
    return { layer: 1, key: territoryScoreOf(state, ruleset, seat) };
  }
  return { layer: 2, key: state.eliminatedAtTick[seat] ?? -1 };
};

/**
 * 竞争名次编号:名次数字 = 该并列组在排序里的**首个位置 + 1**,下一个非并列者跳过被占的位次。
 * **只有这一处**把「第几名」变成一个数字。
 */
const competitionRanks = (keys: readonly RankKey[]): readonly number[] => {
  const ranks: number[] = [];
  let rank = 0;
  keys.forEach((key, index) => {
    const previous = keys[index - 1];
    if (previous === undefined || previous.layer !== key.layer || previous.key !== key.key) {
      rank = index + 1;
    }
    ranks.push(rank);
  });
  return ranks;
};

/**
 * 造一份终局结果。`winnerSeat` 是对应原因算出的胜者(无胜者的原因传 `null`)。
 *
 * 排序键:层升序 → 层内键降序 → 座位号升序(最后一条只为让输出确定;并列者名次相同,
 * 组内先后不影响名次数组)。
 */
export const outcomeOf = (
  state: GameState,
  ruleset: RulesetView,
  reason: OutcomeReason,
  winnerSeat: PlayerIndex | null,
): Outcome => {
  const ordered = SEATS.map((seat) => ({
    seat,
    rank: rankKeyOf(state, ruleset, seat, winnerSeat),
  })).sort(
    (left, right) =>
      left.rank.layer - right.rank.layer ||
      right.rank.key - left.rank.key ||
      left.seat - right.seat,
  );
  const ranks = competitionRanks(ordered.map((entry) => entry.rank));
  const rankings: number[] = SEATS.map(() => 0);
  ordered.forEach((entry, index) => {
    rankings[entry.seat] = ranks[index] ?? 0;
  });
  return {
    rankings,
    reason,
    territoryScores: SEATS.map((seat) => territoryScoreOf(state, ruleset, seat)),
  };
};

/**
 * 无胜者的原因。`victory` / `shortcut` 之外的两种:超时与四方全灭——它们没有胜者,
 * 名次第 1 名归「层内最前」的那一方,而不是某个被特判的赢家。
 */
const seatOfRankOne = (rankings: readonly number[]): PlayerIndex | null => {
  const seat = rankings.findIndex((rank) => rank === 1);
  return seat < 0 ? null : (SEATS[seat] ?? null);
};

/**
 * 终局原因 → 胜者座位;无胜者的原因返回 `null`。步 5 用它决定要不要发 `victory` 事件。
 *
 * ── 这个 switch 是一个**编译期哨兵** ──
 *
 * `default` 里的 `never` 赋值让「四个取值里漏了一档」变成编译错误:在 `packages/schema` 的
 * `ReplayOutcomeReason` 上加第五个取值而不在下面两条 `case` 里处理,`tsc -b` 当场红——
 * 这正是「判别联合带穷尽性断言」那句话的机器形态。胜者恒是第 1 名(名次算法把胜者排在首位且
 * 给它唯一的并列键),故 `victory` / `shortcut` 直接从名次里读出那一个座位。
 */
export const winnerSeatOf = (outcome: Outcome): PlayerIndex | null => {
  switch (outcome.reason) {
    case "victory":
    case "shortcut":
      return seatOfRankOne(outcome.rankings);
    case "timeout":
    case "all-eliminated":
      return null;
    default: {
      const unreachable: never = outcome.reason;
      throw new Error(`未登记的终局原因:${String(unreachable)}`);
    }
  }
};

/** 兵种造价查表只从规则集读;本函数留在这里是为了让「造价」这件事也只有一处。 */
export const costOf = (ruleset: RulesetView, unitType: UnitType): number =>
  ruleset.statsOf(unitType).cost;
