/**
 * 网格计分的两条不变量（属性测试，任意合法网格）。
 *
 * ① **每场四方名次积分之和恒等于名次积分表之和**（`3+2+1+0 = 6`）：名次积分是一局之内的
 *    零和分配——第一名多拿的那一分正是末位少拿的那一分。由此也推出候选的总分等于逐场候选
 *    积分之和（整数记账，无浮点累加顺序依赖）。
 * ② **同一张网格重算两次逐字相同**：读数次序、终局原因都不改变结果。
 *
 * 名次组合只取四方对局合法的 8 种分拆（并列 1 / 2 / 3 / 4 人各覆盖），座位分配随机打乱——
 * 候选坐在哪个座位是每场的参数，不该影响「按座位取分」这件事。
 */

import fc from "fast-check";
import { expect, it } from "vitest";
import { TRIAL_MATCHES_PER_CANDIDATE, type TrialPlanMatch } from "@model-war/schema";

import { DEFAULT_RANK_POINTS, perMatchScores } from "./ranker.js";
import { gridReadingsFixture, trialGridPlanFixture } from "./trial-grid.fixture.js";
import { scoreTrialGrid } from "./trial-score.js";

const plan = trialGridPlanFixture();

/** 四方对局全部合法的名次多重集（4 的 8 种分拆，顺序无关）。 */
const VALID_RANK_SETS = [
  [1, 1, 1, 1],
  [1, 1, 1, 4],
  [1, 1, 3, 3],
  [1, 1, 3, 4],
  [1, 2, 2, 2],
  [1, 2, 2, 4],
  [1, 2, 3, 3],
  [1, 2, 3, 4],
] as const;

/** 把一组名次按随机权重打乱到四个座位上（只依赖随机数，不依赖被测模块）。 */
const assignByWeights = (
  ranks: readonly number[],
  weights: readonly number[],
): readonly number[] => {
  const order = ranks
    .map((rank, index) => ({ rank, weight: weights[index] ?? index }))
    .sort((left, right) => left.weight - right.weight);
  return order.map((entry) => entry.rank);
};

/** 一张网格的名次表：每场一种并列结构，座位分配随机。 */
const gridRanksArb: fc.Arbitrary<readonly (readonly number[])[]> = fc
  .array(
    fc.tuple(
      fc.constantFrom(...VALID_RANK_SETS),
      fc.array(fc.nat(1000), { maxLength: 4, minLength: 4 }),
    ),
    { minLength: TRIAL_MATCHES_PER_CANDIDATE, maxLength: TRIAL_MATCHES_PER_CANDIDATE },
  )
  .map((matches) => matches.map(([ranks, weights]) => assignByWeights(ranks, weights)));

/** 候选在本场的名次积分（以 1/12 为单位的整数）：并列 t 人平分所占名次区间的积分和。 */
const candidateMilli = (match: TrialPlanMatch, ranks: readonly number[]): number => {
  const rank = ranks[match.candidateSeat] ?? 1;
  const tied = ranks.filter((value) => value === rank).length;
  let intervalSum = 0;
  for (let index = 0; index < tied; index += 1)
    intervalSum += DEFAULT_RANK_POINTS[rank - 1 + index] ?? 0;
  return intervalSum * (12 / tied);
};

it("每场四方名次积分之和恒等于名次积分表之和，候选总分等于逐场积分之和", () => {
  fc.assert(
    fc.property(gridRanksArb, (gridRanks) => {
      const score = scoreTrialGrid(
        plan,
        gridReadingsFixture(plan, (_match, index) => gridRanks[index]),
      );
      let totalMilli = 0;
      for (const match of plan.matches) {
        const ranks = gridRanks[match.matchIndex]!;
        const points = perMatchScores(
          String(match.matchIndex),
          match.seats.map((player, seat) => ({ player, rank: ranks[seat] ?? 1 })),
        );
        // ① 一局的名次积分是零和分配：四方加起来正好是积分表之和。
        expect(points.reduce((sum, value) => sum + value, 0)).toBe(6);
        totalMilli += candidateMilli(match, ranks);
      }
      // 总分 = Σ 逐场候选积分（整数记账，只除一次），均分 = 总分 / 计划场数。
      expect(score.totalPoints).toBe(totalMilli / 12);
      expect(score.averagePoints).toBe(score.totalPoints / TRIAL_MATCHES_PER_CANDIDATE);
      expect(score.countedMatches).toBe(TRIAL_MATCHES_PER_CANDIDATE);
    }),
  );
});

it("同一张网格重算两次逐字相同（读数次序与终局原因都不改变结果）", () => {
  fc.assert(
    fc.property(
      gridRanksArb,
      fc.array(fc.constantFrom("victory", "shortcut", "timeout", "all-eliminated"), {
        minLength: TRIAL_MATCHES_PER_CANDIDATE,
        maxLength: TRIAL_MATCHES_PER_CANDIDATE,
      }),
      (gridRanks, reasons) => {
        const build = (
          reasonOf: (
            match: TrialPlanMatch,
          ) => "victory" | "shortcut" | "timeout" | "all-eliminated",
        ) => gridReadingsFixture(plan, (_match, index) => gridRanks[index], reasonOf);
        const mixed = build((match) => reasons[match.matchIndex % reasons.length] ?? "victory");
        const first = scoreTrialGrid(plan, mixed);
        // 读数次序无关：同一组观测倒序送进来，结果逐字相同。
        expect(scoreTrialGrid(plan, [...mixed].reverse())).toEqual(first);
        // 终局原因不是计分口径：全换成 timeout 也不动分数（timeout 没有特例）。
        expect(
          scoreTrialGrid(
            plan,
            build(() => "timeout"),
          ),
        ).toEqual(first);
        expect(JSON.stringify(scoreTrialGrid(plan, mixed))).toBe(JSON.stringify(first));
      },
    ),
  );
});
