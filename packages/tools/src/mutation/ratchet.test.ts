/**
 * 棘轮判定层(`ratchet.ts`)的单元测试:纯函数的行为,不 spawn、不读盘。
 *
 * 为什么这层要有自己的反例:门禁走命名脚本缝时只验证「夹具 → 红/绿/首次」,
 * 那条缝一旦判错(比如把「等于」判成「低」),夹具会把错的口径一起固化下来。
 * 所以判定本身在这里用三组输入钉住:低 → `regressed`,等于/高于 → `ok`,无基线 → `first-run`。
 *
 * 这一层归 `unit` project(默认 `pnpm run test`),因此棘轮的口径在每个 PR 上都在门里。
 */

import { describe, expect, it } from "vitest";

import {
  SHARD_INCOMPARABLE_NOTE,
  baselineFromCounts,
  compareToBaseline,
  countsFromReport,
  coverageBasedScore,
  isShardBaseline,
  mutationScore,
  scoreGapPercent,
} from "./ratchet.ts";

/** 造一份最小可用的 Stryker 报告:只给 `status`,其余字段本层一概不看。 */
const reportWith = (...statuses: readonly string[]) => ({
  schemaVersion: "1.0",
  files: {
    "packages/x/src/a.ts": {
      language: "typescript",
      mutants: statuses.map((status, index) => ({ id: String(index), status })),
    },
  },
});

describe("从报告数出 detected / valid", () => {
  it("detected = Killed + Timeout,valid 再加上 Survived + NoCoverage", () => {
    const counts = countsFromReport(
      reportWith("Killed", "Killed", "Timeout", "Survived", "NoCoverage"),
    );
    expect(counts).toEqual({ detected: 3, valid: 5, survived: 1 });
    // 与 mutation-testing-metrics 的 mutationScore 同式:3/5。
    expect(mutationScore(counts)).toBeCloseTo(60, 6);
  });

  it("RuntimeError / CompileError / Ignored / Pending 不进 valid,也不进 detected", () => {
    const counts = countsFromReport(
      reportWith("RuntimeError", "CompileError", "Ignored", "Pending", "Killed"),
    );
    expect(counts).toEqual({ detected: 1, valid: 1, survived: 0 });
  });

  it("跨文件的变异体合在一起数,不是逐文件取平均", () => {
    const counts = countsFromReport({
      files: {
        "packages/x/src/a.ts": { mutants: [{ status: "Killed" }] },
        "packages/x/src/b.ts": { mutants: [{ status: "Survived" }, { status: "Survived" }] },
      },
    });
    expect(counts).toEqual({ detected: 1, valid: 3, survived: 2 });
  });

  it("缺 files / 缺 mutants 数出全 0:不认识的形态宁可数少,让空转检测去判红", () => {
    expect(countsFromReport({})).toEqual({ detected: 0, valid: 0, survived: 0 });
    expect(countsFromReport({ files: {} })).toEqual({ detected: 0, valid: 0, survived: 0 });
    expect(countsFromReport(reportWith("NoSuchStatus"))).toEqual({
      detected: 0,
      valid: 0,
      survived: 0,
    });
  });

  it("覆盖内分只把被测到过的算进分母(Survived 在分母,NoCoverage 不在)", () => {
    const counts = countsFromReport(reportWith("Killed", "Survived", "NoCoverage"));
    expect(counts.valid).toBe(3);
    expect(coverageBasedScore(counts)).toBeCloseTo(50, 6);
    // 全 NoCoverage 时覆盖内分为 0,不抛、不是 NaN。
    expect(coverageBasedScore(countsFromReport(reportWith("NoCoverage")))).toBe(0);
  });
});

describe("棘轮判决:三种", () => {
  const baseline = { detected: 8, valid: 10 };

  it("低于基线 → regressed", () => {
    const verdict = compareToBaseline({ detected: 7, valid: 10 }, baseline);
    expect(verdict.kind).toBe("regressed");
  });

  it("等于基线 → ok(棘轮只拦退化)", () => {
    expect(compareToBaseline({ detected: 8, valid: 10 }, baseline).kind).toBe("ok");
    // 同分不同形也判绿:8/10 与 16/20 是同一个分数。
    expect(compareToBaseline({ detected: 16, valid: 20 }, baseline).kind).toBe("ok");
  });

  it("高于基线 → ok", () => {
    expect(compareToBaseline({ detected: 9, valid: 10 }, baseline).kind).toBe("ok");
    expect(compareToBaseline({ detected: 80, valid: 100 }, baseline).kind).toBe("ok");
  });

  it("没有基线 → first-run,而且不是红", () => {
    const verdict = compareToBaseline({ detected: 0, valid: 0 }, null);
    expect(verdict.kind).toBe("first-run");
    expect(verdict.kind === "regressed").toBe(false);
  });

  it("比较用整数交叉相乘:分子分母同步放大不改变判决", () => {
    // 1000/3000 与 999/2997 严格相等 → ok。若先算百分比再比,这一对会落进四舍五入的灰区。
    expect(
      compareToBaseline({ detected: 1000, valid: 3000 }, { detected: 999, valid: 2997 }).kind,
    ).toBe("ok");
    // 反过来,分数相同而分母更大的那个不是「更高」:它只是样本更多。
    expect(compareToBaseline({ detected: 2, valid: 3 }, { detected: 66, valid: 99 }).kind).toBe(
      "ok",
    );
  });

  it("两位小数看起来一样、整数上确实低了的,判红", () => {
    // 33.33% vs 33.34%:打印成两位小数时几乎分不开,整数比较分得开。
    expect(
      compareToBaseline({ detected: 3333, valid: 10000 }, { detected: 3334, valid: 10000 }).kind,
    ).toBe("regressed");
  });

  it("差值只给打印用:符号与判决一致", () => {
    expect(scoreGapPercent({ detected: 7, valid: 10 }, baseline)).toBeLessThan(0);
    expect(scoreGapPercent({ detected: 8, valid: 10 }, baseline)).toBe(0);
    expect(scoreGapPercent({ detected: 9, valid: 10 }, baseline)).toBeGreaterThan(0);
  });
});

describe("抬升命令造基线的纯函数", () => {
  it("把三个计数装成基线:两个百分比收成两位小数,判决要用的两个整数原样保留", () => {
    const baseline = baselineFromCounts("replay", { detected: 2, valid: 3, survived: 1 });
    // 2/3 与 2/(2+1) 都是 66.666…%:文件里只保留两位,判决用的仍是 2 与 3。
    expect(baseline).toEqual({
      shard: "replay",
      detected: 2,
      valid: 3,
      score: 66.67,
      coverageBased: 66.67,
    });
    // 造出来的东西必须过得了门禁那一侧的守卫,否则抬升写出的文件自己就把门禁弄红。
    expect(isShardBaseline(baseline)).toBe(true);
  });

  it("source 缺省不写,给了就如实带上(「这个数字打哪来」)", () => {
    const counts = { detected: 8, valid: 10, survived: 2 };
    expect("source" in baselineFromCounts("replay", counts)).toBe(false);
    expect(baselineFromCounts("replay", counts, "reports/mutation/replay.json").source).toBe(
      "reports/mutation/replay.json",
    );
  });
});

describe("基线文件的形状守卫", () => {
  const wellFormed = {
    shard: "replay",
    detected: 236,
    valid: 338,
    score: 69.82,
    coverageBased: 71.52,
  };

  it("五个字段齐全且前两个是非负整数 → 认", () => {
    expect(isShardBaseline(wellFormed)).toBe(true);
    expect(isShardBaseline({ ...wellFormed, source: "reports/mutation/replay.json" })).toBe(true);
  });

  it("缺字段、类型不对、负数 → 不认(否则 NaN 会把判决悄悄变成 ok)", () => {
    expect(isShardBaseline(null)).toBe(false);
    expect(isShardBaseline({})).toBe(false);
    expect(isShardBaseline({ ...wellFormed, detected: "236" })).toBe(false);
    expect(isShardBaseline({ ...wellFormed, valid: -1 })).toBe(false);
    expect(isShardBaseline({ ...wellFormed, score: undefined })).toBe(false);
    expect(isShardBaseline({ ...wellFormed, shard: undefined })).toBe(false);
  });
});

describe("分片之间不可横向比较这件事被写下来了", () => {
  it("提示里点明不可横向比较,且指向 stryker/base.mjs 头注", () => {
    expect(SHARD_INCOMPARABLE_NOTE).toContain("不可横向比较");
    expect(SHARD_INCOMPARABLE_NOTE).toContain("stryker/base.mjs");
    expect(SHARD_INCOMPARABLE_NOTE).toContain("同一个分片");
  });
});
