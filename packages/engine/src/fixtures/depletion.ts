/**
 * 夹具 #7「资源枯竭的定位」(`docs/gdd.md` §8 #7)的可跑宿主。
 *
 * ── 原桩那条探针的定义(逐字抽自取证表与聚合器) ──
 *
 * 原桩在每 tick 的步 6 采样「全图资源点剩余储量之和」(`sim/engine.mjs:308-313`),收口时用
 * `computeDepletion`(`sim/harness.mjs:446`)算「储量被采到 25% / 50% / 75% / 100% 的 tick」:
 *
 *     const consumed = 1 - remainingSamples[t] / total;   // total = 资源点数量 × resourcePerSite
 *     if (consumed >= 1/4) p25 = t; ...   // 阈值按整数比判,见下方实现
 *
 * 聚合器把四个阈值按分布印成一行(`sim/tables.mjs` §6.1,取证表 §6)。**本夹具量同一个量、
 * 同一个判据**:逐 tick 从回放行读资源点的 `remaining` 求和,对照 `25/50/75/100%` 四个阈值。
 *
 * ── 它拿什么复算 ──
 *
 * 逐 tick 的 `remaining` 只在回放的 `sites` 栏里,`terrain` 不在 tick 行(所以体量不随 `size: 64`
 * 膨胀)。「100% 采空」的 tick 就是枯竭时点;复验时拿这批 tick 去对 §8 #7 与记录 #13 那条
 * 「采空中位落在哪个窗口」的证据——**本票不下结论**,只把分布量出来。
 */

import type { Ruleset } from "@model-war/replay";

import type { FixtureMatch } from "./harness.js";
import { tickLinesOf } from "./harness.js";

/** 一条对局里的枯竭读数。`ticks.*` 为 `null` = 到终局都没采到那个阈值。 */
export type DepletionReading = {
  /** 全图总储量 = 资源点数量 × `resourcePerSite`(与桩同口径)。 */
  readonly total: number;
  readonly ticks: {
    readonly p25: number | null;
    readonly p50: number | null;
    readonly p75: number | null;
    readonly p100: number | null;
  };
  /** 终局时全图剩余储量,占 `total` 的百分比。 */
  readonly remainingEndPct: number;
};

/** 逐 tick 的全图资源点剩余储量之和(下标即 tick,与桩的 `remainingSamples` 一致)。 */
export const remainingSamplesOf = (match: FixtureMatch): readonly number[] =>
  tickLinesOf(match.parsed).map((line) =>
    line.sites
      .filter((site) => site.kind === "resource")
      .reduce((sum, site) => sum + (site.remaining ?? 0), 0),
  );

/** 一条对局的枯竭读数。 */
export const depletionOf = (match: FixtureMatch, ruleset: Ruleset): DepletionReading => {
  const samples = remainingSamplesOf(match);
  const resourceSites =
    tickLinesOf(match.parsed)[0]?.sites.filter((site) => site.kind === "resource").length ?? 0;
  const total = resourceSites * ruleset.resourcePerSite;
  const ticks = { p25: null, p50: null, p75: null, p100: null } as {
    p25: number | null;
    p50: number | null;
    p75: number | null;
    p100: number | null;
  };
  samples.forEach((remaining, tick) => {
    // 阈值按整数比判,不写浮点字面量(本仓禁浮点门禁同管非测试运行时代码):
    // consumed >= k/4 ⟺ (total - remaining) * 4 >= total * k;100% 采空用 remaining * 1000 <= total。
    const consumedTimes4 = (total - remaining) * 4;
    if (ticks.p25 === null && consumedTimes4 >= total) {
      ticks.p25 = tick;
    }
    if (ticks.p50 === null && consumedTimes4 >= total * 2) {
      ticks.p50 = tick;
    }
    if (ticks.p75 === null && consumedTimes4 >= total * 3) {
      ticks.p75 = tick;
    }
    if (ticks.p100 === null && remaining * 1000 <= total) {
      ticks.p100 = tick;
    }
  });
  const remainingEnd = samples.at(-1) ?? total;
  return {
    total,
    ticks,
    remainingEndPct: total === 0 ? 0 : Math.round((remainingEnd / total) * 1000) / 10,
  };
};

/** 一批对局的枯竭读数。 */
export const depletionReadingsOf = (
  matches: readonly FixtureMatch[],
  ruleset: Ruleset,
): readonly DepletionReading[] => matches.map((match) => depletionOf(match, ruleset));
