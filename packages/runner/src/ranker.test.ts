import { expect, it } from "vitest";
import type { RankPoints, RankedEntry, RankedMatch } from "./ranker.js";
import { DEFAULT_RANK_POINTS, rankSeason } from "./ranker.js";
import { rankSeason as rankSeasonFromIndex } from "./index.js";

const players = ["a", "b", "c", "d"] as const;

/** 用固定名册 a/b/c/d 造一局;`ranks[i]` 是玩家 i 的名次。 */
const match = (matchId: string, ranks: readonly number[]): RankedMatch => ({
  matchId,
  standings: players.map((player, index) => ({ player, rank: ranks[index] ?? 1 })),
});

const byPlayer = (entries: readonly RankedEntry[]) =>
  new Map(entries.map((entry) => [entry.player, entry]));

it("默认名次积分是 [3,2,1,0]", () => {
  expect(DEFAULT_RANK_POINTS).toEqual([3, 2, 1, 0]);
});

it("并列第 2 得分为区间之和的一半(1.5)", () => {
  const entries = rankSeason([match("m1", [1, 2, 2, 4])], { players });
  const index = byPlayer(entries);
  expect(index.get("a")?.totalPoints).toBe(3);
  expect(index.get("b")?.totalPoints).toBe(1.5);
  expect(index.get("c")?.totalPoints).toBe(1.5);
  expect(index.get("d")?.totalPoints).toBe(0);
});

it("并列区间与人数变化时,得分 = 区间分值之和 ÷ 并列人数", () => {
  const threeWay = byPlayer(rankSeason([match("m1", [1, 2, 2, 2])], { players }));
  for (const player of ["b", "c", "d"]) {
    // 并列第 2 的三人占名次 2..4:(2+1+0)/3 = 1
    expect(threeWay.get(player)?.totalPoints).toBe(1);
  }
  expect(threeWay.get("a")?.totalPoints).toBe(3);

  const fourWay = byPlayer(rankSeason([match("m1", [1, 1, 1, 1])], { players }));
  for (const player of players) {
    // 四人并列第 1 占名次 1..4:(3+2+1+0)/4 = 1.5
    expect(fourWay.get(player)?.totalPoints).toBe(1.5);
  }
});

it("剔除失败局后,分母 = 有效局数,并被输出为 countedMatches", () => {
  // 调用方已把失败局剔除,只传两局有效局
  const entries = rankSeason([match("m1", [1, 2, 3, 4]), match("m2", [1, 2, 3, 4])], {
    players,
  });
  const first = entries.find((entry) => entry.player === "a");
  expect(first?.countedMatches).toBe(2);
  expect(first?.totalPoints).toBe(6);
  expect(first?.averagePoints).toBe(3);
  expect(Object.keys(first ?? {})).toContain("countedMatches");
});

it("rankPoints 可覆写", () => {
  const index = byPlayer(
    rankSeason([match("m1", [1, 2, 3, 4])], { players, rankPoints: [10, 6, 3, 0] }),
  );
  expect(index.get("a")?.totalPoints).toBe(10);
  expect(index.get("b")?.totalPoints).toBe(6);
  expect(index.get("c")?.totalPoints).toBe(3);
  expect(index.get("d")?.totalPoints).toBe(0);
});

it("rankPoints 长度不是 4 时报清晰错误", () => {
  expect(() =>
    rankSeason([match("m1", [1, 2, 3, 4])], {
      players,
      rankPoints: [3, 2, 1] as unknown as RankPoints,
    }),
  ).toThrow(/长度/);
});

it("rankPoints 含非有限数时报清晰错误", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() =>
      rankSeason([match("m1", [1, 2, 3, 4])], {
        players,
        rankPoints: [3, 2, 1, bad] as unknown as RankPoints,
      }),
    ).toThrow(/有限/);
  }
});

it("名次区间的越界被清晰拒绝", () => {
  expect(() => rankSeason([match("m1", [1, 1, 4, 4])], { players })).toThrow(/越界/);
});

it("排名是竞争排名:同分并列,下一名次跳号", () => {
  const index = byPlayer(rankSeason([match("m1", [1, 2, 2, 4])], { players }));
  expect(index.get("a")?.rank).toBe(1);
  expect(index.get("b")?.rank).toBe(2);
  expect(index.get("c")?.rank).toBe(2);
  expect(index.get("d")?.rank).toBe(4);
});

it("未参赛者也在输出里,有效局数 0、对局均分 0", () => {
  const entry = rankSeason([match("m1", [1, 2, 3, 4])], {
    players: [...players, "e"],
  }).find((candidate) => candidate.player === "e");
  expect(entry?.countedMatches).toBe(0);
  expect(entry?.totalPoints).toBe(0);
  expect(entry?.averagePoints).toBe(0);
});

it("同输入恒同输出(纯函数)", () => {
  const matches = [match("m1", [1, 2, 2, 4]), match("m2", [2, 1, 3, 4])];
  expect(rankSeason(matches, { players })).toEqual(rankSeason(matches, { players }));
});

it("结果与对局入参顺序无关(整数记账)", () => {
  const first = match("m1", [1, 2, 2, 4]);
  const second = match("m2", [2, 1, 3, 4]);
  expect(rankSeason([first, second], { players })).toEqual(
    rankSeason([second, first], { players }),
  );
});

it("输出里不含 elo 字段(v0 不做 Elo)", () => {
  const entries = rankSeason([match("m1", [1, 2, 3, 4])], { players });
  for (const entry of entries) {
    expect(Object.keys(entry)).not.toContain("elo");
  }
  expect(JSON.stringify(entries)).not.toContain("elo");
});

it("rankSeason 从包入口 re-export", () => {
  expect(rankSeasonFromIndex).toBe(rankSeason);
});
