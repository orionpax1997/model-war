/**
 * 变异分数趋势(纯函数层):一组分片基线 → 每片的历史序列与结论。
 *
 * ── 口径:分片之间不可横向比较 ────────────────────────────────────────────────
 *
 * 比较粒度是**分片**:分片的物理依据(同一套 mutate 范围、同一批排除项、同一套统计口径)
 * 写在 `stryker/base.mjs` 头注里,跨包覆盖会被静默记成 Survived / NoCoverage——
 * 那不会伪装成「测试弱」,它伪装成「没测」。所以这一层**只做片内比较**,
 * 绝不把不同分片的分数放在一起排名、汇总成总分。
 *
 * 趋势的历史来源是**入库基线文件里的 `history`**,不是 `reports/` 里的产物:
 * 产物会过期(夜间 artifact 只留 14 天),基线不会。历史随仓库走、随 diff 可见。
 *
 * 不碰文件系统、不读时钟:同一组基线永远得到同一份结论。
 */

import type { BaselineHistoryEntry, ShardBaseline } from "./ratchet.ts";

/** 一片的历史与结论。 */
export type ShardHistory = {
  readonly shard: string;
  readonly entries: readonly BaselineHistoryEntry[];
  /** 第一个点到最后一个点的分数变化(百分点)。没有历史时为 0。 */
  readonly netChange: number;
  /** 方向:`up` / `down` / `flat` / `unknown`(没有可比的历史)。 */
  readonly direction: "up" | "down" | "flat" | "unknown";
  /** 这一片有没有可比的历史(至少两条)。 */
  readonly comparable: boolean;
};

/** 全部分片的历史。 */
export type HistoryDiagnosis = {
  readonly shards: readonly ShardHistory[];
  /** 有可比历史的分片数。 */
  readonly comparableShards: number;
  /** 有历史的分片数(哪怕只有一条)。 */
  readonly shardsWithHistory: number;
};

/**
 * 分数变化的判据:与棘轮判决同源——整数交叉相乘,不用浮点分数。
 *
 * `current.detected * baseline.valid < baseline.detected * current.valid` → 下降。
 * 这与 `compareToBaseline` 的口径一致:趋势与判决说同一件事,只是时间方向不同。
 */
const isLower = (baseline: BaselineHistoryEntry, current: BaselineHistoryEntry): boolean =>
  current.detected * baseline.valid < baseline.detected * current.valid;

/** 一片的历史序列与结论。 */
export const shardHistory = (shard: string, baseline: ShardBaseline): ShardHistory => {
  const entries = baseline.history ?? [];
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first === undefined || last === undefined || entries.length < 2) {
    return {
      shard,
      entries,
      netChange: 0,
      direction: "unknown",
      comparable: false,
    };
  }
  const netChange = Math.round((last.score - first.score) * 100) / 100;
  const direction: ShardHistory["direction"] = isLower(first, last)
    ? "down"
    : netChange > 0
      ? "up"
      : "flat";
  return { shard, entries, netChange, direction, comparable: true };
};

/** 汇总全部分片的历史。 */
export const diagnoseHistory = (baselines: readonly ShardBaseline[]): HistoryDiagnosis => {
  const shards = [...baselines]
    .map((baseline) => shardHistory(baseline.shard, baseline))
    .sort((left, right) => left.shard.localeCompare(right.shard));
  return {
    shards,
    comparableShards: shards.filter((shard) => shard.comparable).length,
    shardsWithHistory: shards.filter((shard) => shard.entries.length > 0).length,
  };
};
