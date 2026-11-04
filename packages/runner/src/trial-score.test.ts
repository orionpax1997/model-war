/**
 * 网格计分：一张跑满的网格 → 候选唯一的分数（平均名次积分）。
 *
 * 断言对象是**外部可观察的结果**：候选的总分、均分与分母；并列名次积分按所占名次区间均分；
 * timeout / all-eliminated 不改变口径；同一组观测重算两次逐字相同；缺场 / 多场 / 重复场 /
 * 计划不认识的场次 / 读数不属于这一格，全部拒绝并指到具体场次。不跑对局、不碰盘。
 *
 * 「手工算术」在这里就是字面数字（每组用例的注释写着怎么算的），不调用被测模块的算术去
 * 自证——否则分母、并列、积分表三处任何一处错了都测不出来。
 */

import { expect, it } from "vitest";
import {
  TRIAL_MATCHES_PER_CANDIDATE,
  type TrialPlanMatch,
  type TrialTerminalSummary,
} from "@model-war/schema";

import {
  gridReadingsFixture,
  ranksWithCandidate,
  terminalSummaryFixture,
  trialGridPlanFixture,
} from "./trial-grid.fixture.js";
import { scoreTrialGrid } from "./trial-score.js";

const plan = trialGridPlanFixture();

/**
 * 候选拿第 `rank` 名、另有一人与之并列的座位序名次表。
 *
 * 二人占名次 `rank..rank+1`，其余按升序补满（四方对局里只有 `[1,2,2,4]` 这类结构合法）。
 */
const ranksTiedWithCandidate = (match: TrialPlanMatch, rank: number): readonly number[] => {
  const occupied = [rank, rank + 1];
  const rest = [1, 2, 3, 4].filter((value) => !occupied.includes(value));
  let tied = 2;
  return match.seats.map((_, seat) => {
    if (seat === match.candidateSeat || tied > 1) {
      if (seat !== match.candidateSeat) tied -= 1;
      return rank;
    }
    return rest.shift() ?? rank;
  });
};

it("全胜：32 场都是第一名 → 32 × 3 = 96，均分 3，分母恒等于计划场数", () => {
  const score = scoreTrialGrid(plan, gridReadingsFixture(plan));
  expect(score).toEqual({
    totalPoints: 96,
    averagePoints: 3,
    countedMatches: TRIAL_MATCHES_PER_CANDIDATE,
  });
});

it("四方全并列：每场每人 (3+2+1+0)/4 = 1.5 → 48，均分 1.5", () => {
  const score = scoreTrialGrid(
    plan,
    gridReadingsFixture(plan, () => [1, 1, 1, 1]),
  );
  expect(score).toEqual({
    totalPoints: 48,
    averagePoints: 1.5,
    countedMatches: TRIAL_MATCHES_PER_CANDIDATE,
  });
});

it("混合口径（含 timeout / 全灭 / 零交付）与手工算术逐位一致：24 + 12 + 16 + 0 = 52", () => {
  // 按场序每 8 场一组，各组的候选名次结构不同（候选座位在网格里轮转，所以按座位算）：
  //   0..7   候选独占第 1  → 3 分 × 8 = 24（victory）
  //   8..15  候选与一人并列第 2 → (2+1)/2 = 1.5 × 8 = 12（timeout，且这一组是零交付局）
  //   16..23 三人并列第 1 → (3+2+1)/3 = 2 × 8 = 16（all-eliminated，四方全灭）
  //   24..31 候选末位 → 0 分 × 8 = 0
  const group = (index: number): number => Math.floor(index / 8);
  const reasons = ["victory", "timeout", "all-eliminated", "timeout"] as const;
  const readings = gridReadingsFixture(
    plan,
    (match, index) => {
      switch (group(index)) {
        case 0:
          return ranksWithCandidate(match, 1);
        case 1:
          return ranksTiedWithCandidate(match, 2);
        case 2: {
          // 三人并列第 1：非候选座位里有一个吃掉剩下的第 4 名。
          const rest = [1, 1, 4];
          return match.seats.map((_, seat) =>
            seat === match.candidateSeat ? 1 : (rest.pop() ?? 4),
          );
        }
        default:
          return ranksWithCandidate(match, 4);
      }
    },
    (match) => reasons[group(match.matchIndex)] ?? "victory",
  );
  // 前两组来自字面数字，第三组确认这条用例真的包含了「后场也跑满」（32 条读数）。
  expect(readings).toHaveLength(TRIAL_MATCHES_PER_CANDIDATE);
  expect(scoreTrialGrid(plan, readings)).toEqual({
    totalPoints: 24 + 12 + 16 + 0,
    averagePoints: (24 + 12 + 16 + 0) / TRIAL_MATCHES_PER_CANDIDATE,
    countedMatches: TRIAL_MATCHES_PER_CANDIDATE,
  });
});

it("timeout 与 all-eliminated 不是特例：名次结构相同则分数逐字相同", () => {
  const ranks = (match: TrialPlanMatch): readonly number[] => ranksWithCandidate(match, 2);
  const asVictory = gridReadingsFixture(plan, ranks, () => "victory");
  const asTimeout = gridReadingsFixture(plan, ranks, () => "timeout");
  const asAllEliminated = gridReadingsFixture(plan, ranks, () => "all-eliminated");
  expect(scoreTrialGrid(plan, asTimeout)).toEqual(scoreTrialGrid(plan, asVictory));
  expect(scoreTrialGrid(plan, asAllEliminated)).toEqual(scoreTrialGrid(plan, asVictory));
});

it("同一组观测重算两次逐字相同，读数次序不影响结果", () => {
  const readings = gridReadingsFixture(plan, (match) => ranksTiedWithCandidate(match, 2));
  const first = scoreTrialGrid(plan, readings);
  const second = scoreTrialGrid(plan, [...readings].reverse());
  expect(second).toEqual(first);
  expect(JSON.stringify(scoreTrialGrid(plan, readings))).toBe(JSON.stringify(first));
});

it("缺场即拒：分母不缩小、不补零，并指出缺的是哪一场", () => {
  const readings = gridReadingsFixture(plan);
  const withoutFifth = readings.filter((reading) => reading.matchIndex !== 5);
  expect(() => scoreTrialGrid(plan, withoutFifth)).toThrow(/第 5 场没有读数/);
  expect(() => scoreTrialGrid(plan, [])).toThrow(/计划里的第 0 \/ 1 \/ 2/);
});

it("多场、重复场、计划不认识的场次都拒", () => {
  const readings = gridReadingsFixture(plan);
  expect(() =>
    scoreTrialGrid(plan, [
      ...readings,
      {
        matchIndex: TRIAL_MATCHES_PER_CANDIDATE,
        terminalSummary: readings[0]!.terminalSummary!,
      },
    ]),
  ).toThrow(new RegExp(`第 ${TRIAL_MATCHES_PER_CANDIDATE} 场不在计划里`));
  expect(() => scoreTrialGrid(plan, [...readings, readings[0]!])).toThrow(/第 0 场出现了多条读数/);
});

it("缺终局事实即拒：缺失不当成零分", () => {
  const readings = gridReadingsFixture(plan).map((reading) =>
    reading.matchIndex === 3 ? { matchIndex: reading.matchIndex } : reading,
  );
  expect(() => scoreTrialGrid(plan, readings)).toThrow(/第 3 场缺少终局事实/);
});

it("读数不属于这一格即拒：种子不符、座位身份不符、名次不成四座竞争排名", () => {
  const readings = gridReadingsFixture(plan);
  const patch = (
    matchIndex: number,
    change: (summary: TrialTerminalSummary) => TrialTerminalSummary,
  ): typeof readings =>
    readings.map((reading) =>
      reading.matchIndex === matchIndex && reading.terminalSummary !== undefined
        ? { ...reading, terminalSummary: change(reading.terminalSummary) }
        : reading,
    );

  expect(() =>
    scoreTrialGrid(
      plan,
      patch(7, (summary) => ({ ...summary, seed: summary.seed + 1 })),
    ),
  ).toThrow(/第 7 场的终局种子/);

  expect(() =>
    scoreTrialGrid(
      plan,
      patch(2, (summary) => ({
        ...summary,
        players: [
          { ...summary.players[0], player: "冒充的对手" },
          summary.players[1],
          summary.players[2],
          summary.players[3],
        ],
      })),
    ),
  ).toThrow(/第 2 场座位 0 的终局身份/);

  expect(() =>
    scoreTrialGrid(
      plan,
      patch(9, (summary) => {
        const ranks = [1, 1, 2, 4];
        return {
          ...summary,
          players: [
            { ...summary.players[0], rank: ranks[0]! },
            { ...summary.players[1], rank: ranks[1]! },
            { ...summary.players[2], rank: ranks[2]! },
            { ...summary.players[3], rank: ranks[3]! },
          ],
        };
      }),
    ),
  ).toThrow(/第 9 场：名次 1\/1\/2\/4 不是四座竞争排名/);
});

it("计划里没有候选座位时拒绝（不把「候选 0 场」算成均分 0）", () => {
  // 座位表被换成不含候选的四元组：最像「读了一份别的网格」的那种错配。
  const orphan = plan.matches.map((match) => ({
    ...match,
    seats: match.seats.map(
      (_, seat) => `top:seat-${String(seat)}`,
    ) as unknown as TrialPlanMatch["seats"],
  }));
  const planWithoutCandidate = { ...plan, matches: orphan };
  const readings = orphan.map((match) => ({
    matchIndex: match.matchIndex,
    terminalSummary: terminalSummaryFixture(match, [1, 2, 3, 4]),
  }));
  expect(() => scoreTrialGrid(planWithoutCandidate, readings)).toThrow(/候选只被计了 0 场/);
});

it("候选在每个座位各坐一次时仍按座位取分（座位是每场参数，不是身份）", () => {
  // 座位 s 固定拿第 s+1 名；候选在每个座位各 8 场 → 8×(3+2+1+0) = 48。
  const score = scoreTrialGrid(
    plan,
    gridReadingsFixture(plan, (match) => match.seats.map((_, seat) => seat + 1)),
  );
  expect(score).toEqual({
    totalPoints: 48,
    averagePoints: 1.5,
    countedMatches: TRIAL_MATCHES_PER_CANDIDATE,
  });
});
