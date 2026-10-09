import { expect, it } from "vitest";
import { RULESET_VERSION } from "@model-war/schema";
import { enumerateMatchUps, type EnumerateMatchUpsOptions, type MatchUp } from "./index.js";

/** M=3 × K=4 = 12 ≡ 0 (mod 4),与首季配置同形。 */
const MAPS = ["corridor-split", "fortress-core", "open-clash"] as const;
const SEEDS = 4;
const MASTER_SEED = "master";

const enumerate = (
  options: Partial<EnumerateMatchUpsOptions> & { participants: readonly string[] },
) =>
  enumerateMatchUps({
    maps: MAPS,
    seeds: SEEDS,
    masterSeed: MASTER_SEED,
    ...options,
  });

const comboCount = (matchUps: readonly MatchUp[]): number =>
  new Set(matchUps.map((matchUp) => matchUp.comboId)).size;

it("C(4,N) 组合的数量正确", () => {
  expect(comboCount(enumerate({ participants: ["a", "b", "c", "d"] }))).toBe(1);
  expect(comboCount(enumerate({ participants: ["a", "b", "c", "d", "e"] }))).toBe(5);
  expect(comboCount(enumerate({ participants: ["a", "b", "c", "d", "e", "f"] }))).toBe(15);
});

it("对局总数 = C(4,N) × M × K", () => {
  expect(enumerate({ participants: ["a", "b", "c", "d"] })).toHaveLength(1 * 3 * 4);
  expect(enumerate({ participants: ["a", "b", "c", "d", "e"] })).toHaveLength(5 * 3 * 4);
  expect(enumerate({ participants: ["a", "b", "c", "d", "e", "f"] })).toHaveLength(15 * 3 * 4);
});

it("不足四人时不产生组合", () => {
  expect(enumerate({ participants: ["a", "b", "c"] })).toHaveLength(0);
});

it("每个组合是四个互不相同的座位", () => {
  for (const matchUp of enumerate({ participants: ["a", "b", "c", "d", "e", "f"] })) {
    expect(new Set(matchUp.seats).size).toBe(4);
  }
});

it("结果只依赖名册内容,不依赖入参顺序", () => {
  expect(enumerate({ participants: ["e", "b", "d", "a", "c"] })).toEqual(
    enumerate({ participants: ["a", "b", "c", "d", "e"] }),
  );
});

it("名册去重后重复名不再参与组合", () => {
  expect(comboCount(enumerate({ participants: ["a", "a", "b", "c", "d"] }))).toBe(1);
});

it("每个组合都钉住规则集版本", () => {
  for (const matchUp of enumerate({ participants: ["a", "b", "c", "d"] })) {
    expect(matchUp.ruleset).toBe(RULESET_VERSION);
  }
});

it("M × K ≡ 0 (mod 4) 时每个座位的对局数精确相等", () => {
  const matchUps = enumerate({ participants: ["a", "b", "c", "d"] });
  // counts[参赛者][座位] = 该参赛者在该座位上的对局数
  const counts = new Map<string, number[]>(
    ["a", "b", "c", "d"].map((player) => [player, [0, 0, 0, 0]]),
  );
  for (const matchUp of matchUps) {
    matchUp.seats.forEach((player, seat) => {
      const row = counts.get(player);
      if (row !== undefined) {
        row[seat] = (row[seat] ?? 0) + 1;
      }
    });
  }
  // 12 局 ÷ 4 座位 = 3
  for (const player of ["a", "b", "c", "d"]) {
    expect(counts.get(player)).toEqual([3, 3, 3, 3]);
  }
});

it("M × K ≢ 0 (mod 4) 时抛错而非静默偏移", () => {
  expect(() => enumerate({ participants: ["a", "b", "c", "d"], seeds: 2 })).toThrow(/M × K/);
  expect(() => enumerate({ participants: ["a", "b", "c", "d"], seeds: 3 })).toThrow(/mod 4/);
});

it("座位 = 组合成员按 slug 升序的基准序列,按 (mapIndex+seedIndex) mod 4 循环移位", () => {
  const matchUps = enumerate({
    participants: ["d", "b", "c", "a"],
    maps: ["only-map"],
    seeds: 4,
  });
  // 基准序列按 slug 升序 = [a,b,c,d];shift = seedIndex(仅 1 张图)
  expect(matchUps.map((matchUp) => matchUp.seats)).toEqual([
    ["a", "b", "c", "d"],
    ["b", "c", "d", "a"],
    ["c", "d", "a", "b"],
    ["d", "a", "b", "c"],
  ]);
});

it("排序键是存档引用的 slug,而非整串", () => {
  // 整串比较会把 `a-b`(含 `-`)排到 `a` 之前;slug 升序则 `a` 先。
  const matchUps = enumerate({
    participants: ["archive/zeta/r1", "archive/a-b/r1", "archive/a/r1", "archive/mid/r1"],
    maps: ["only-map"],
    seeds: 4,
  });
  expect(matchUps[0]?.seats).toEqual([
    "archive/a/r1",
    "archive/a-b/r1",
    "archive/mid/r1",
    "archive/zeta/r1",
  ]);
});

it("同一配置的种子完全确定,且地图/种子序号进入输出", () => {
  const options = { participants: ["a", "b", "c", "d"], maps: MAPS, seeds: SEEDS, masterSeed: "x" };
  expect(enumerateMatchUps(options)).toEqual(enumerateMatchUps(options));

  const first = enumerateMatchUps(options);
  expect(first[0]).toMatchObject({ map: MAPS[0], seedIndex: 0, mapIndex: 0 });
  expect(first[SEEDS]).toMatchObject({ map: MAPS[1], mapIndex: 1, seedIndex: 0 });
  // 同组合不同种子的种子值互异
  const combo0 = first.filter((matchUp) => matchUp.comboId === "c0");
  expect(new Set(combo0.map((matchUp) => matchUp.seed)).size).toBe(combo0.length);
  for (const matchUp of first) {
    expect(Number.isInteger(matchUp.seed)).toBe(true);
    expect(matchUp.seed).toBeGreaterThanOrEqual(0);
    expect(matchUp.seed).toBeLessThanOrEqual(0xffffffff);
  }
});

it("种子派生编码被钉住(sha256 前 8 hex → 无符号整数)", () => {
  const [first] = enumerateMatchUps({
    participants: ["a", "b", "c", "d"],
    maps: ["only-map"],
    seeds: 4,
    masterSeed: "master",
  });
  // sha256("master|c0|0|0").slice(0,8) = "d47d6e71"
  expect(first?.seed).toBe(0xd47d6e71);
});
