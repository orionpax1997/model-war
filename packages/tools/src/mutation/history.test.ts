import { describe, expect, it } from "vitest";
import { diagnoseHistory, shardHistory } from "./history.ts";
import { isShardBaseline, nextHistory, type ShardBaseline } from "./ratchet.ts";

const baseline = (overrides: Partial<ShardBaseline> = {}): ShardBaseline => ({
  shard: "replay",
  detected: 10,
  valid: 10,
  score: 100,
  coverageBased: 100,
  ...overrides,
});

describe("历史推进", () => {
  it("旧基线不在场 → 历史从这一条开始", () => {
    const history = nextHistory(
      undefined,
      { detected: 5, valid: 10, survived: 5 },
      "2026-01-01T00:00:00.000Z",
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.detected).toBe(5);
    expect(history[0]?.score).toBe(50);
  });

  it("旧基线在场但没有历史 → 旧值补成第一条,再追加新的", () => {
    const history = nextHistory(
      baseline({ detected: 8, valid: 10, score: 80 }),
      { detected: 9, valid: 10, survived: 1 },
      "2026-01-02T00:00:00.000Z",
    );
    expect(history).toHaveLength(2);
    expect(history[0]?.detected).toBe(8);
    expect(history[0]?.at).toBe("unknown");
    expect(history[1]?.detected).toBe(9);
  });

  it("旧基线已有历史 → 直接追加,旧条目不动", () => {
    const previous = baseline({
      history: [{ at: "2026-01-01T00:00:00.000Z", detected: 8, valid: 10, score: 80 }],
    });
    const history = nextHistory(
      previous,
      { detected: 9, valid: 10, survived: 1 },
      "2026-01-02T00:00:00.000Z",
    );
    expect(history).toHaveLength(2);
    expect(history[0]?.at).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("基线形状", () => {
  it("没有 history 字段的旧基线仍然合法", () => {
    expect(isShardBaseline(baseline())).toBe(true);
  });

  it("history 形状不对 → 判不合规(坏历史不能静默通过)", () => {
    expect(
      isShardBaseline({ ...baseline(), history: [{ at: 1, detected: 1, valid: 1, score: 1 }] }),
    ).toBe(false);
    expect(isShardBaseline({ ...baseline(), history: "nope" })).toBe(false);
  });

  it("反例:history 形状正确 → 判合规", () => {
    expect(
      isShardBaseline({
        ...baseline(),
        history: [{ at: "2026-01-01T00:00:00.000Z", detected: 1, valid: 1, score: 1 }],
      }),
    ).toBe(true);
  });
});

describe("趋势结论", () => {
  const withHistory = (
    entries: readonly { at: string; detected: number; valid: number; score: number }[],
  ): ShardBaseline =>
    baseline({
      detected: entries[entries.length - 1]?.detected ?? 0,
      valid: entries[entries.length - 1]?.valid ?? 0,
      score: entries[entries.length - 1]?.score ?? 0,
      history: entries,
    });

  it("只有一条记录 → 不可比", () => {
    const history = shardHistory(
      "replay",
      withHistory([{ at: "2026-01-01T00:00:00.000Z", detected: 8, valid: 10, score: 80 }]),
    );
    expect(history.comparable).toBe(false);
    expect(history.direction).toBe("unknown");
  });

  it("分数升了 → 方向是上", () => {
    const history = shardHistory(
      "replay",
      withHistory([
        { at: "2026-01-01T00:00:00.000Z", detected: 8, valid: 10, score: 80 },
        { at: "2026-01-02T00:00:00.000Z", detected: 9, valid: 10, score: 90 },
      ]),
    );
    expect(history.comparable).toBe(true);
    expect(history.direction).toBe("up");
    expect(history.netChange).toBe(10);
  });

  it("分数降了 → 方向是下", () => {
    const history = shardHistory(
      "replay",
      withHistory([
        { at: "2026-01-01T00:00:00.000Z", detected: 9, valid: 10, score: 90 },
        { at: "2026-01-02T00:00:00.000Z", detected: 8, valid: 10, score: 80 },
      ]),
    );
    expect(history.direction).toBe("down");
    expect(history.netChange).toBe(-10);
  });

  it("全部分片汇总:数出有可比历史的分片", () => {
    const diagnosis = diagnoseHistory([
      withHistory([
        { at: "2026-01-01T00:00:00.000Z", detected: 8, valid: 10, score: 80 },
        { at: "2026-01-02T00:00:00.000Z", detected: 9, valid: 10, score: 90 },
      ]),
      baseline({ shard: "runner" }),
    ]);
    expect(diagnosis.comparableShards).toBe(1);
    expect(diagnosis.shardsWithHistory).toBe(1);
    expect(diagnosis.shards).toHaveLength(2);
  });
});
