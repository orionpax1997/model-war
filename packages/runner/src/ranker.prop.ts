import fc from "fast-check";
import { expect, it } from "vitest";
import type { RankedMatch } from "./ranker.js";
import { rankSeason } from "./ranker.js";

const players = ["a", "b", "c", "d"] as const;

/**
 * 四方对局的全部合法名次多重集(4 的 8 种分拆,顺序无关)。
 * 每个多重集对应一种「并列结构」,覆盖 1 / 2 / 3 / 4 人并列。
 */
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

const rankSet: fc.Arbitrary<readonly number[]> = fc.constantFrom(...VALID_RANK_SETS);

const matchArb: fc.Arbitrary<RankedMatch> = fc
  .tuple(fc.integer({ min: 0, max: 999 }), rankSet)
  .map(([id, ranks]) => ({
    matchId: `m${String(id)}`,
    standings: players.map((player, index) => ({ player, rank: ranks[index] ?? 1 })),
  }));

const matchesArb = fc.array(matchArb, { maxLength: 8 });

it("对局入参顺序不影响结果(整数记账无浮点累加顺序依赖)", () => {
  fc.assert(
    fc.property(matchesArb, (matches) => {
      const forward = rankSeason(matches, { players });
      const backward = rankSeason([...matches].reverse(), { players });
      expect(backward).toEqual(forward);
    }),
  );
});

it("有效局数等于该参赛者出现的对局数", () => {
  fc.assert(
    fc.property(matchesArb, (matches) => {
      for (const entry of rankSeason(matches, { players })) {
        const appearances = matches.filter((match) =>
          match.standings.some((standing) => standing.player === entry.player),
        ).length;
        expect(entry.countedMatches).toBe(appearances);
      }
    }),
  );
});

it("任意名次组合都不产出 elo 字段", () => {
  fc.assert(
    fc.property(matchesArb, (matches) => {
      expect(JSON.stringify(rankSeason(matches, { players }))).not.toContain("elo");
    }),
  );
});
