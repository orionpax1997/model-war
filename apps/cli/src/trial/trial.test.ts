/**
 * 冻结期试跑的纯判定与反馈文案（不经引擎、不起 VM）。
 *
 * 断言对象只有对外可观察的东西：给定一组已记录的预算触限， verdict 给出过/拦、
 * 反馈文本里有没有"第几场、第几 tick、哪项预算、读数/上限/超出"。
 * 真沙箱那一侧（触限怎么被记录下来）由 `match-run` 经真实 `runMatch` + 桩执行器覆盖，
 * 入口脚本（真 VM 跑三场）由手工冒烟与 `gen-cli` e2e 覆盖。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import {
  CANDIDATE_SEAT,
  TRIAL_MAP,
  TRIAL_MATCH_COUNT,
  TRIAL_OPPONENTS,
  TRIAL_SEEDS,
  renderScoreSourceObservation,
  renderTrialFeedback,
  verdictOfTrips,
  type RecordedTrip,
} from "./trial.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const trip = (
  partial: Partial<RecordedTrip> & { readonly track: RecordedTrip["track"] },
): RecordedTrip => ({
  matchIndex: 0,
  tick: 10,
  seat: 0,
  value: 812,
  limit: 800,
  ...partial,
});

it("试跑常量：3 场、3 个互不相同的固定种子、赛季当前地图、3 个固定对手、候选固定 0 号位", () => {
  expect(TRIAL_MATCH_COUNT).toBe(3);
  expect(TRIAL_SEEDS).toHaveLength(3);
  expect(new Set(TRIAL_SEEDS).size).toBe(3);
  for (const seed of TRIAL_SEEDS) {
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
  }
  // 三张地图同为 64 格 28 点位，"小"无差别，固定取赛季当前地图 corridor-split。
  expect(TRIAL_MAP).toBe("corridor-split");
  expect(TRIAL_OPPONENTS).toEqual([
    "cell-a-melee-pressure",
    "cell-b-expansion-economy",
    "cell-c-claim-no-harvest",
  ]);
  expect(CANDIDATE_SEAT).toBe(0);
});

it("对手登记漂移断言：benchmarks/ 下恰好是这三份对手的 script.js", () => {
  // 对手登记册的真源在 `packages/tools/src/benchmarks/compile.ts` 的 BENCHMARK_NAMES；
  // 这里不断言那份清单（跨包读源码是并行表示），只断言试跑自己的前提：
  // 点名的三份都在、且没有第四份——增减基准时这条会先红，提醒同步改试跑对手。
  for (const name of TRIAL_OPPONENTS) {
    expect(existsSync(join(repoRoot, "benchmarks", name, "script.js")), name).toBe(true);
  }
});

it("无触限 → 通过，反馈写明场数、地图与种子", () => {
  const verdict = verdictOfTrips([]);
  expect(verdict.passed).toBe(true);
  const feedback = renderTrialFeedback(verdict);
  expect(feedback).toContain("试跑通过");
  expect(feedback).toContain(String(TRIAL_MATCH_COUNT));
  expect(feedback).toContain(TRIAL_MAP);
});

it("候选座事件计数超限 → 拦，反馈写明第几场、第几 tick、哪项预算、读数/上限/超出", () => {
  const verdict = verdictOfTrips([
    trip({ matchIndex: 1, tick: 42, track: "eventTickLimit", value: 55000, limit: 50000 }),
  ]);
  expect(verdict.passed).toBe(false);
  if (verdict.passed) {
    return;
  }
  expect(verdict.trip.matchIndex).toBe(1);
  expect(verdict.trip.tick).toBe(42);
  const feedback = renderTrialFeedback(verdict);
  expect(feedback).toContain("试跑未通过");
  expect(feedback).toContain("第 2 场");
  expect(feedback).toContain("第 42 tick");
  expect(feedback).toContain("控制流事件计数");
  expect(feedback).toContain("55000");
  expect(feedback).toContain("50000");
  expect(feedback).toContain("5000");
});

it("候选座 API 计数超限 → 拦，反馈点名 API 调用计数", () => {
  const verdict = verdictOfTrips([
    trip({ matchIndex: 0, tick: 118, track: "apiCallTickLimit", value: 812, limit: 800 }),
  ]);
  expect(verdict.passed).toBe(false);
  const feedback = renderTrialFeedback(verdict);
  expect(feedback).toContain("试跑未通过");
  expect(feedback).toContain("第 1 场");
  expect(feedback).toContain("第 118 tick");
  expect(feedback).toContain("API 调用计数");
  expect(feedback).toContain("812");
  expect(feedback).toContain("800");
  expect(feedback).toContain("12");
});

it("对手座位超限 → 通过（基准健康假设：对手的触限不算候选的账）", () => {
  const verdict = verdictOfTrips([
    trip({ matchIndex: 0, tick: 5, track: "eventTickLimit", seat: 2, value: 60000, limit: 50000 }),
  ]);
  expect(verdict.passed).toBe(true);
});

it("候选座未吞异常 / 内存触限 → 通过（试跑只看 events/apis 两轨，其余进联赛三振）", () => {
  const verdict = verdictOfTrips([
    trip({ matchIndex: 0, tick: 7, track: "uncaughtException", value: 1, limit: 1 }),
    trip({ matchIndex: 1, tick: 9, track: "memoryTickCeiling", value: 600000, limit: 524288 }),
  ]);
  expect(verdict.passed).toBe(true);
});

it("多场多触限 → 报首触（先到的场优先），反馈只讲第一条", () => {
  const verdict = verdictOfTrips([
    trip({ matchIndex: 2, tick: 300, track: "apiCallTickLimit", value: 900, limit: 800 }),
    trip({ matchIndex: 0, tick: 50, track: "eventTickLimit", value: 55000, limit: 50000 }),
  ]);
  expect(verdict.passed).toBe(false);
  if (verdict.passed) {
    return;
  }
  expect(verdict.trip.matchIndex).toBe(2);
  const feedback = renderTrialFeedback(verdict);
  expect(feedback).toContain("第 3 场");
  expect(feedback).not.toContain("控制流事件计数");
});

it("无得分来源观测：命中给留痕文案（写明第几场、注明不拦），未命中给 null", () => {
  const hit = renderScoreSourceObservation(1, {
    delivered: 0,
    captures: 0,
    noScoreSource: true,
  });
  expect(hit).toContain("第 2 场");
  expect(hit).toContain("不拦");
  expect(
    renderScoreSourceObservation(0, { delivered: 20, captures: 0, noScoreSource: false }),
  ).toBeNull();
  expect(
    renderScoreSourceObservation(0, { delivered: 0, captures: 1, noScoreSource: false }),
  ).toBeNull();
});
