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
import {
  PROBE_CALL_LIMIT,
  PROBE_MATCH_LIMIT,
  PROBE_NEAR_LIMIT_RATIO,
  TRIAL_CANDIDATE_ID,
  TRIAL_GRID_MAP_NAMES,
  TRIAL_GRID_SEED_BASE,
} from "@model-war/schema";

import {
  candidateSeatOfPlan,
  probeReportOf,
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

// ── 探针的三档文案(判据 1 / 2 / 3) ───────────────────────────────────────────
//
// 票面引的那两个夹具**都不存在**(`budget-mismatch.test.ts` 全仓无;`minimax` 那份
// `observed-*-round-21.jsonl.candidate.ts` 也没有 —— 那一跑三次 evaluate 全被预算拦下,
// 没有产出候选)。所以判据 2 与判据 3 的夹具在这里**按形状构造**:一份"会越线"的 trips 与一份
// "前 8 场不越线、后 24 场才越线"的 trips。判定与文案都不需要 VM,故它们属于这一格。

/** 探针的上限:计划里那三条轨都启用着(与 `budgetOf(ruleset)` 同一形状)。 */
const PROBE_LIMITS = { eventTickLimit: 50000, apiCallTickLimit: 800, memoryTickCeiling: 524288 };

it("N=8 与 80% 这两个常量的来历在 schema 里,且与文案用的数一致", () => {
  expect(PROBE_MATCH_LIMIT).toBe(8);
  expect(PROBE_NEAR_LIMIT_RATIO).toBe(0.8);
  expect(PROBE_CALL_LIMIT).toBe(5);
});

it("判据 1（地基）：只用约 60% 预算 → 「充裕」档，三条轨的读数都报出来且非零", () => {
  const report = probeReportOf({
    plan,
    matchCount: PROBE_MATCH_LIMIT,
    trips: [],
    peakUsage: { eventCount: 30000, apiCalls: 480, memoryBytes: 300000 },
    limits: PROBE_LIMITS,
  });
  expect(report.verdict.passed).toBe(true);
  expect(report.nearLimit).toBe(false);
  const text = report.text;
  // 前 8 场 = 1 个组合 × 4 个座位 × 2 张地图（形状取自计划，不手写）。
  // 三档的开头都是同一个 `head`（形状那句话也在里面），充裕档不再另写一遍。
  expect(text).toContain("前 8 场");
  expect(text).toContain("最坏读数");
  // 三条轨的最坏读数都在，且带占用比例。
  expect(text).toContain("事件 30000/50000（60%）");
  expect(text).toContain("API 480/800（60%）");
  expect(text).toContain("内存 0.3/0.5 MB（57%）");
  // 读数非零（这一条是整张票的地基：二值时代这里什么数都没有）。
  expect(text).not.toContain("事件 0/");
  expect(text).not.toContain("API 0/");
  // 充裕档必须自带两句免责。
  expect(text).toContain("这不等于整张 32 场通过");
  // 漏检率那句：场数派生自 `PROBE_MATCH_LIMIT`，而四个场号只写在 `probe-limits.ts`
  // （那组读数的唯一一份）——文案里**不逐场列号**，这一条盯的就是那个边界。
  expect(text).toContain("漏检率：真档四例预算触限里");
  expect(text).toContain("2/4");
  expect(text).not.toContain("第 1、8、25、11 场");
});

it("充裕档与贴边档都催复测：改过脚本就得重新 probe，否则读数对不上被评的那一版", () => {
  // 真档（mimo 2026-11-20）第 18 步读到充裕就把脚本整份重写、第 22 步直接 evaluate，
  // 白烧一次（总共三次）。充裕档原本没有这句话，贴边档原本只有「先降下来再 evaluate」。
  const ample = probeReportOf({
    plan,
    matchCount: PROBE_MATCH_LIMIT,
    trips: [],
    peakUsage: { eventCount: 30000, apiCalls: 480, memoryBytes: 300000 },
    limits: PROBE_LIMITS,
  });
  expect(ample.nearLimit).toBe(false);
  expect(ample.text).toContain("重新 probe");
  expect(ample.text).toContain("改过脚本之后");

  const nearLimit = probeReportOf({
    plan,
    matchCount: PROBE_MATCH_LIMIT,
    trips: [],
    peakUsage: { eventCount: 48000, apiCalls: 100, memoryBytes: 200000 },
    limits: PROBE_LIMITS,
  });
  expect(nearLimit.nearLimit).toBe(true);
  expect(nearLimit.text).toContain("重新 probe");
});

it("已越线档不催复测：那一档与 evaluate 的拦下话术逐字同源，不许多一句", () => {
  // 越线时该做的是改，不是复测；加一句就与 `renderTrialFeedback` 的逐字复用不再一致。
  const seat = candidateSeatOfPlan(plan)(0);
  const report = probeReportOf({
    plan,
    matchCount: PROBE_MATCH_LIMIT,
    trips: [
      { matchIndex: 0, tick: 102, seat, track: "eventTickLimit", value: 61234, limit: 50000 },
    ],
    peakUsage: { eventCount: 61234, apiCalls: 120 },
    limits: PROBE_LIMITS,
  });
  expect(report.text).not.toContain("重新 probe");
});

it("判据 2（已越线）：一位候选在第 1 场某 tick 越线 → 「已越线」+ evaluate 的同一段话术", () => {
  // 夹具按形状构造：候选在第 1 场（matchIndex 0）坐在计划给的座位上。
  const seat = candidateSeatOfPlan(plan)(0);
  const trips: readonly RecordedTrip[] = [
    { matchIndex: 0, tick: 102, seat, track: "eventTickLimit", value: 61234, limit: 50000 },
  ];
  const report = probeReportOf({
    plan,
    matchCount: PROBE_MATCH_LIMIT,
    trips,
    peakUsage: { eventCount: 61234, apiCalls: 120 },
    limits: PROBE_LIMITS,
  });
  expect(report.verdict.passed).toBe(false);
  expect(report.nearLimit).toBe(true);
  const text = report.text;
  expect(text).toContain("已经越线");
  // 票面要求的那句：文案含「单 tick 控制流事件计数」（与 evaluate 逐字同源）。
  expect(text).toContain("单 tick 控制流事件计数");
  expect(text).toContain("第 1 场");
  expect(text).toContain("第 102 tick");
  // 逐字复用：越线档里那一段与 evaluate 拦下时的文案**完全一致**（只换场数那句话）。
  if (report.verdict.passed) return;
  expect(text).toContain(renderTrialFeedback(report.verdict, plan));
});

it("判据 3（假绿反例，不许删）：前 8 场不越线、第 25 场越线 → 「充裕」/「贴边」+ 两句免责", () => {
  // 这一份就是真档漏检的那一例：触限发生在第 25 场（matchIndex 24），前 8 场抓不到。
  const seat = candidateSeatOfPlan(plan)(24);
  const trips: readonly RecordedTrip[] = [
    { matchIndex: 24, tick: 73, seat, track: "apiCallTickLimit", value: 900, limit: 800 },
  ];
  const report = probeReportOf({
    plan,
    matchCount: PROBE_MATCH_LIMIT,
    trips,
    peakUsage: { eventCount: 12000, apiCalls: 200 },
    limits: PROBE_LIMITS,
  });
  // 探针只看前 8 场 → 那一条不在窗口里，判"没越线"。
  expect(report.verdict.passed).toBe(true);
  // 但文案必须写出「这不等于整张 32 场通过」，否则模型会把绿色读成"整张过了"。
  expect(report.text).toContain("这不等于整张 32 场通过");
  expect(report.text).toContain("另 24 场若越线");
});

it("判据 3 的另一半：候选座位判据用的是**完整计划**（裁剪计划这条会挂）", () => {
  // 第 25 场的候选坐哪个座位由计划给（网格里逐场轮转，不恒 0）。
  const seatOf25 = candidateSeatOfPlan(plan)(24);
  const trip25: RecordedTrip = {
    matchIndex: 24,
    tick: 73,
    seat: seatOf25,
    track: "apiCallTickLimit",
    value: 900,
    limit: 800,
  };

  // ① 完整计划 + 全部 trips：拦下（真判定）。
  expect(verdictOfTrips([trip25], candidateSeatOfPlan(plan)).passed).toBe(false);

  // ② 这一份 trips 在**裁剪过的计划**下会静默假绿：`matches[24]` 缺席 → 兜底座位 0 →
  //    座位 `seatOf25` 的触限对不上 → 判成通过。这正是坑①，一句断言钉住它。
  const cropped: typeof plan = {
    ...plan,
    matches: plan.matches.slice(0, PROBE_MATCH_LIMIT),
    matchesPerCandidate: PROBE_MATCH_LIMIT,
  };
  const lenient = verdictOfTrips([trip25], (index) => cropped.matches[index]?.candidateSeat ?? 0);
  // 只有候选真的不坐 0 号位时这条反例才「绿成假的」。
  if (seatOf25 !== 0) {
    expect(lenient.passed).toBe(true);
  }
  // ③ 而按完整计划查座位**不会**给出那个兜底：它要么是计划里的座位，要么大声失败。
  expect(candidateSeatOfPlan(plan)(24)).toBe(seatOf25);
  expect(() => candidateSeatOfPlan(cropped)(24)).toThrow(/计划里没有第 24 场/);
});

it("贴边档：任一条轨 ≥ 80% 即切档，且带「已经贴边」与那句改法提示", () => {
  const report = probeReportOf({
    plan,
    matchCount: PROBE_MATCH_LIMIT,
    trips: [],
    peakUsage: { eventCount: 48000, apiCalls: 100, memoryBytes: 200000 },
    limits: PROBE_LIMITS,
  });
  expect(report.verdict.passed).toBe(true);
  expect(report.nearLimit).toBe(true);
  expect(report.text).toContain("已经贴边");
  expect(report.text).toContain("48000/50000（96%）");
  // 贴边档报出这一轮的覆盖形状（1 组组合 × 4 座位 × 2 地图 = 前 8 场，由计划派生）。
  expect(report.text).toContain("1 组组合 × 4 座位 × 2 地图");
  // 充裕档的那句"最坏读数全表"不出现（贴边档只点贴边的那几条）。
  expect(report.text).not.toContain("API 100/800");
  // 免责两句照样在：贴边也不是"整张通过"。
  expect(report.text).toContain("这不等于整张 32 场通过");
  // 催复测那句也在这档（充裕档见上一条用例）。
  expect(report.text).toContain("重新 probe");
});

it("没采到读数时不假装全 0：缺席就写「没采到」，不写 0/50000", () => {
  const report = probeReportOf({
    plan,
    matchCount: PROBE_MATCH_LIMIT,
    trips: [],
    limits: PROBE_LIMITS,
  });
  expect(report.text).toContain("没采到任何占用读数");
  expect(report.text).not.toContain("0/");
  expect(report.text).toContain("这不等于整张 32 场通过");
});

it("未启用的轨不显示（预算键缺席 → 那一栏不出现，而不是 `0/0`）", () => {
  const report = probeReportOf({
    plan,
    matchCount: PROBE_MATCH_LIMIT,
    trips: [],
    peakUsage: { eventCount: 1000, apiCalls: 20, memoryBytes: 100000 },
    limits: { eventTickLimit: 50000 },
  });
  expect(report.text).toContain("事件 1000/50000");
  expect(report.text).not.toContain("API");
  expect(report.text).not.toContain("内存");
});
