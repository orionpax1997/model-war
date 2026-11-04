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

import { buildTrialPlan, type BuildTrialPlanInput } from "@model-war/runner";
import { TRIAL_CANDIDATE_ID, TRIAL_GRID_MAP_NAMES, TRIAL_GRID_SEED_BASE } from "@model-war/schema";

import {
  renderScoreSourceObservation,
  renderTrialFeedback,
  verdictOfTrips,
  type RecordedTrip,
} from "./trial.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** 网格计划的构造事实（摘要取固定假值：判定与文案不需要真字节）。 */
const facts: BuildTrialPlanInput = {
  ruleset: "v2",
  rulesetSha256: "9".repeat(64),
  sandboxRuntimeHash: "8".repeat(64),
  scripts: [
    { role: "top", id: "top:alpha", source: "archive:alpha/r1", scriptSha256: "1".repeat(64) },
    { role: "mid", id: "mid:beta", source: "archive:beta/r2", scriptSha256: "2".repeat(64) },
    { role: "last", id: "last:gamma", source: "archive:gamma/r3", scriptSha256: "3".repeat(64) },
    {
      role: "incumbent",
      id: "incumbent:delta",
      source: "archive:delta/r4#substitute",
      scriptSha256: "4".repeat(64),
    },
  ],
  maps: [
    { name: TRIAL_GRID_MAP_NAMES[0], sha256: "f".repeat(64) },
    { name: TRIAL_GRID_MAP_NAMES[1], sha256: "e".repeat(64) },
  ],
};
const plan = buildTrialPlan(facts);
/** 候选座位由计划给（网格里逐场轮转），判定按它收窄。 */
const candidateSeatOf = (matchIndex: number): 0 | 1 | 2 | 3 =>
  plan.matches[matchIndex]?.candidateSeat ?? 0;

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

it("网格计划：32 场、每格一个种子、两张图、四份角色限定陪练、候选四座位轮转", () => {
  expect(plan.matches).toHaveLength(32);
  expect(plan.matches.map((match) => match.seed)).toEqual(
    Array.from({ length: 32 }, (_, index) => TRIAL_GRID_SEED_BASE + index),
  );
  expect(new Set(plan.matches.map((match) => match.seed)).size).toBe(32);
  expect(plan.maps.map((map) => map.name)).toEqual([...TRIAL_GRID_MAP_NAMES]);
  expect(plan.scripts.map((script) => script.id)).toEqual([
    "top:alpha",
    "mid:beta",
    "last:gamma",
    "incumbent:delta",
  ]);
  expect(new Set(plan.matches.map((match) => match.candidateSeat))).toEqual(new Set([0, 1, 2, 3]));
  for (const match of plan.matches) {
    expect(match.seats[match.candidateSeat]).toBe(TRIAL_CANDIDATE_ID);
    expect(TRIAL_GRID_MAP_NAMES).toContain(match.map);
  }
});

it("对手登记漂移断言：基准脚本与两张图的字节都在安装面上", () => {
  // 基准仍是行为对照（选拔与回归在用）；网格的两张图必须在 maps/ 下。
  for (const name of ["corridor-split", "open-clash"]) {
    expect(existsSync(join(repoRoot, "maps", `${name}.json`)), name).toBe(true);
  }
});

it("无触限 → 通过，反馈写明场数、地图与种子（05 会重写渲染，这里只钉事实来源）", () => {
  const verdict = verdictOfTrips([]);
  expect(verdict.passed).toBe(true);
  const feedback = renderTrialFeedback(verdict, plan);
  expect(feedback).toContain("试跑通过");
  expect(feedback).toContain("32 场");
  expect(feedback).toContain(TRIAL_GRID_MAP_NAMES[0]);
  expect(feedback).toContain(TRIAL_GRID_MAP_NAMES[1]);
  expect(feedback).toContain(String(TRIAL_GRID_SEED_BASE));
  expect(feedback).toContain(String(TRIAL_GRID_SEED_BASE + 31));
});

it("候选座事件计数超限 → 拦，反馈写明第几场、第几 tick、哪项预算、读数/上限/超出", () => {
  const verdict = verdictOfTrips(
    [trip({ matchIndex: 1, tick: 42, track: "eventTickLimit", value: 55000, limit: 50000 })],
    candidateSeatOf,
  );
  expect(verdict.passed).toBe(false);
  if (verdict.passed) {
    return;
  }
  expect(verdict.trip.matchIndex).toBe(1);
  expect(verdict.trip.tick).toBe(42);
  const feedback = renderTrialFeedback(verdict, plan);
  expect(feedback).toContain("试跑未通过");
  expect(feedback).toContain("第 2 场");
  expect(feedback).toContain("第 42 tick");
  expect(feedback).toContain("控制流事件计数");
  expect(feedback).toContain("55000");
  expect(feedback).toContain("50000");
  expect(feedback).toContain("5000");
});

it("候选座 API 计数超限 → 拦，反馈点名 API 调用计数", () => {
  const verdict = verdictOfTrips(
    [trip({ matchIndex: 0, tick: 118, track: "apiCallTickLimit", value: 812, limit: 800 })],
    candidateSeatOf,
  );
  expect(verdict.passed).toBe(false);
  const feedback = renderTrialFeedback(verdict, plan);
  expect(feedback).toContain("试跑未通过");
  expect(feedback).toContain("第 1 场");
  expect(feedback).toContain("第 118 tick");
  expect(feedback).toContain("API 调用计数");
  expect(feedback).toContain("812");
  expect(feedback).toContain("800");
  expect(feedback).toContain("12");
});

it("对手座位超限 → 通过（基准健康假设：对手的触限不算候选的账）", () => {
  const verdict = verdictOfTrips(
    [
      trip({
        matchIndex: 0,
        tick: 5,
        track: "eventTickLimit",
        seat: 2,
        value: 60000,
        limit: 50000,
      }),
    ],
    candidateSeatOf,
  );
  expect(verdict.passed).toBe(true);
});

it("候选座未吞异常 / 内存触限 → 通过（试跑只看 events/apis 两轨，其余进联赛三振）", () => {
  const verdict = verdictOfTrips(
    [
      trip({ matchIndex: 0, tick: 7, track: "uncaughtException", value: 1, limit: 1 }),
      trip({ matchIndex: 1, tick: 9, track: "memoryTickCeiling", value: 600000, limit: 524288 }),
    ],
    candidateSeatOf,
  );
  expect(verdict.passed).toBe(true);
});

it("多场多触限 → 报首触（先到的场优先），反馈只讲第一条", () => {
  const verdict = verdictOfTrips(
    [
      // 第 3 场（matchIndex 2）的候选坐在 3 号位——座位来自计划，不是恒 0。
      trip({
        matchIndex: 2,
        tick: 300,
        track: "apiCallTickLimit",
        value: 900,
        limit: 800,
        seat: candidateSeatOf(2),
      }),
      trip({ matchIndex: 0, tick: 50, track: "eventTickLimit", value: 55000, limit: 50000 }),
    ],
    candidateSeatOf,
  );
  expect(verdict.passed).toBe(false);
  if (verdict.passed) {
    return;
  }
  expect(verdict.trip.matchIndex).toBe(2);
  const feedback = renderTrialFeedback(verdict, plan);
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
