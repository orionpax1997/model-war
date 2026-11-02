/**
 * 冻结期试跑的**纯判定与反馈文案**（不经引擎、不起 VM）。
 *
 * ── 为什么这一格是纯的 ──
 *
 * 「触限怎么被记录下来」（runner 包装、tick 归因）归 `match-run.ts`，它经真实 `runMatch`
 * 覆盖；「记录下来后怎么判、怎么讲」归这里，断言不需要 VM。两件事拆在两处，
 * 于是本文件的测试毫秒级，而真沙箱的开销只落在必须有它的那一侧。
 *
 * ── 「跑哪几场」不再住在这里 ──
 *
 * 场数、地图、种子、座位、对手都在**试跑计划**里（形状在 `@model-war/schema` 的
 * `trial-plan.ts`，构造与校验在 `@model-war/runner` 的 `trial-plan.ts`）。本文件只接计划、
 * 判计划跑出来的触限、按计划里的取值讲结论——于是「把当前配置换成网格」不再需要改这一格。
 */

import { TRIAL_CANDIDATE_SEAT, type ReplaySeat, type TrialPlan } from "@model-war/schema";

import type { ScoreSourceReading } from "./score-source.js";

/** 试跑看的两条轨：tick 级 events/apis。其余轨（未吞异常、内存）进联赛三振，这里不判。 */
export const WATCHED_TRACKS: readonly string[] = ["eventTickLimit", "apiCallTickLimit"];

/** 执行器交回的一条触限记录：座位与 tick 由记录器在调用点补齐（与步 0 同源）。 */
export type RecordedTrip = {
  readonly matchIndex: number;
  readonly tick: number;
  readonly seat: ReplaySeat;
  /** 轨名：执行器的原生词（如 `eventTickLimit`）。 */
  readonly track: string;
  readonly value: number;
  readonly limit: number;
};

/** 试跑结论：通过，或拦下并带上首触明细（第几场、第几 tick、哪项预算、超了多少）。 */
export type TrialVerdict =
  | { readonly passed: true }
  | { readonly passed: false; readonly trip: RecordedTrip };

/** 每个场次的候选座位由计划给（v1 恒 0；网格起逐场轮转）。 */
export type CandidateSeatOf = (matchIndex: number) => ReplaySeat;

/**
 * 按到达序取首条"候选座位在看轨上"的触限。有它即拦（零容忍），否则放行。
 *
 * 对手座位的触限（基准健康假设）与非看轨（未吞异常、内存）的触限一律忽略：
 * 前者不算候选的账，后者进联赛后靠现行三振兜着——两处分工，出局只留给真崩溃。
 *
 * `candidateSeatOf` 缺省取 v1 的固定座位，便于不起计划的单元用例直接断言判定规则。
 */
export const verdictOfTrips = (
  trips: readonly RecordedTrip[],
  candidateSeatOf: CandidateSeatOf = () => TRIAL_CANDIDATE_SEAT,
): TrialVerdict => {
  for (const trip of trips) {
    if (trip.seat === candidateSeatOf(trip.matchIndex) && WATCHED_TRACKS.includes(trip.track)) {
      return { passed: false, trip };
    }
  }
  return { passed: true };
};

/** 看轨的面向模型说法（"哪项预算"这一栏的文案）。 */
const TRACK_LABELS: Record<string, string> = {
  eventTickLimit: "单 tick 控制流事件计数",
  apiCallTickLimit: "单 tick API 调用计数",
};

/** 看轨的改法提示（"下一轮怎么改"这一栏的文案）。 */
const TRACK_HINTS: Record<string, string> = {
  eventTickLimit: "请精简每 tick 的循环与函数调用，把重活摊到多个 tick 或缓存中间结果",
  apiCallTickLimit: "请减少每 tick 的 API 调用次数，把多次查询合并或缓存结果",
};

/**
 * 渲染面向模型的试跑反馈（逐字回喂，不加引擎内部诊断）。
 *
 * 通过：写明场数、地图与种子（可复现信息，全部取自计划）；拦下：写明第几场、第几 tick、
 * 哪项预算、读数/上限/超出，并给一句该轨的改法提示。
 */
export const renderTrialFeedback = (verdict: TrialVerdict, plan: TrialPlan): string => {
  const matchCount = plan.matches.length;
  if (verdict.passed) {
    return (
      `试跑通过：${String(matchCount)} 场（地图 ${plan.maps.map((map) => map.name).join(" / ")}，` +
      `种子 ${plan.matches.map((match) => String(match.seed)).join(" / ")}）无预算超限。`
    );
  }
  const { trip } = verdict;
  const label = TRACK_LABELS[trip.track] ?? trip.track;
  const hint = TRACK_HINTS[trip.track] ?? "请降低该项预算的每 tick 开销后重新提交";
  return (
    `试跑未通过：候选脚本在第 ${String(trip.matchIndex + 1)} 场` +
    `第 ${String(trip.tick)} tick 触发预算超限。\n` +
    `- ${label}超限（读数 ${String(trip.value)}，上限 ${String(trip.limit)}，` +
    `超出 ${String(trip.value - trip.limit)}）。\n` +
    `${String(matchCount)} 场试跑零容忍：任一场超限即打回。${hint}。`
  );
};

/**
 * 「无得分来源」的留痕文案（只进 stderr，**不回喂、不拦**）。未命中给 `null`。
 *
 * 只观测的理由与口径见 `score-source.ts` 头注；升级为判定另票裁决。
 *
 * 留痕行数通常等于场数：网格执行器不早停，触限之后的后场照样跑、照样有读数。
 * 某一场作废且重跑仍作废时整轮 infra，这一轮不落盘（上一轮跑完的证据留在盘上）。
 */
export const renderScoreSourceObservation = (
  matchIndex: number,
  reading: ScoreSourceReading,
): string | null => {
  if (!reading.noScoreSource) {
    return null;
  }
  return (
    `试跑观测（不拦）：候选在第 ${String(matchIndex + 1)} 场整局无交付、无占点` + `（无得分来源）。`
  );
};
