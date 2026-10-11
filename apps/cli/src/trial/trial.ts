/**
 * 冻结期试跑的常量、纯判定与反馈文案（不经引擎、不起 VM）。
 *
 * ── 为什么这一格是纯的 ──
 *
 * 「触限怎么被记录下来」（runner 包装、tick 归因）归 `match-run.ts`，它经真实 `runMatch`
 * 覆盖；「记录下来后怎么判、怎么讲」归这里，断言不需要 VM。两件事拆在两处，
 * 于是本文件的测试毫秒级，而真沙箱的开销只落在必须有它的那一侧。
 *
 * ── 常量的取舍 ──
 *
 * K=3、种子固定（三场同一组种子对所有候选：可复现且公平）；地图固定 `corridor-split`
 * （三张地图同为 64 格 28 点位，"小"无差别，取赛季当前地图；赛季换图时改这一处）；
 * 对手固定三份基准脚本（登记册真源在 `packages/tools/src/benchmarks/compile.ts` 的
 * `BENCHMARK_NAMES`，这里只取三份作固定对手，漂移由测试里的存在断言盯着）；
 * 候选固定 0 号位（预算计数分座位独立，固定座位使回喂稳定）。
 */

import type { ReplaySeat } from "@model-war/schema";

/** 试跑场数：零容忍，K 场爆 1 次就打回。 */
export const TRIAL_MATCH_COUNT = 3;

/** 三场的固定种子：同一组种子对所有候选，保证可复现与公平。 */
export const TRIAL_SEEDS: readonly number[] = [101, 202, 303];

/** 试跑地图：赛季当前地图（三张地图同尺寸，"小"无差别）。 */
export const TRIAL_MAP = "corridor-split";

/** 三个固定对手：基准脚本目录名（下标 1..3 即座位，0 号位留给候选）。 */
export const TRIAL_OPPONENTS: readonly string[] = [
  "cell-a-melee-pressure",
  "cell-b-expansion-economy",
  "cell-c-claim-no-harvest",
];

/** 候选脚本的固定座位。 */
export const CANDIDATE_SEAT: ReplaySeat = 0;

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

/**
 * 按到达序取首条"候选座位在看轨上"的触限。有它即拦（零容忍），否则放行。
 *
 * 对手座位的触限（基准健康假设）与非看轨（未吞异常、内存）的触限一律忽略：
 * 前者不算候选的账，后者进联赛后靠现行三振兜着——两处分工，出局只留给真崩溃。
 */
export const verdictOfTrips = (trips: readonly RecordedTrip[]): TrialVerdict => {
  for (const trip of trips) {
    if (trip.seat === CANDIDATE_SEAT && WATCHED_TRACKS.includes(trip.track)) {
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
 * 通过：写明场数、地图与种子（可复现信息）；拦下：写明第几场、第几 tick、
 * 哪项预算、读数/上限/超出，并给一句该轨的改法提示。
 */
export const renderTrialFeedback = (verdict: TrialVerdict): string => {
  if (verdict.passed) {
    return (
      `试跑通过：${String(TRIAL_MATCH_COUNT)} 场（地图 ${TRIAL_MAP}，` +
      `种子 ${TRIAL_SEEDS.map(String).join(" / ")}）无预算超限。`
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
    `${String(TRIAL_MATCH_COUNT)} 场试跑零容忍：任一场超限即打回。${hint}。`
  );
};
