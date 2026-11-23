/**
 * 试跑单场：runner 记录触限/调用载荷，宿主只读出口记录实际结算效果。
 * 两类事实只聚合候选座位；旧 score-source 快照 tracker 保留原口径。
 *
 * ── 为什么记录器包在 runner 外面，而不是改引擎 ──
 *
 * `tripped` 观测在步 0 被转成状态变更（累加 `exceptionTicks`），不进观测出口；
 * `executeMatch` 也不交回 `finalState`——走既有装载路径拿不到"第几 tick、哪项预算、
 * 超了多少"的明细。而试跑要的恰好是明细，不是胜负。所以记录器搭在缝的**调用点**上：
 * 经 `setSnapshot` 拿 tick（与步 0 同源），经 `drainIntents` 的返回载荷拿轨名/读数/上限，
 * 不动判定。实际结算效果经 `runMatch.actionEffects` 独立收集，不从快照倒推。
 *
 * ── 记不记与判不判是两件事 ──
 *
 * 这里记下**全部** `tripped`（含对手座位、含未吞异常与内存轨）；"拦不拦"由 `trial.ts`
 * 的 `verdictOfTrips` 按"候选座位 + events/apis 两轨"收窄。调用方（入口脚本）可以把
 * 被忽略的触限打到 stderr 留痕，而不影响结论。
 *
 * 回放行直接丢弃：试跑要的只是一条结论与首触明细，重跑可复现，不留对局产物。
 *
 * ── 占用读数：只对候选座位聚合，且只披露 ──
 *
 * 执行器每 tick 在返回载荷里带一行 `peakUsage`（这一 tick 用了多少），记录器逐 tick 取更坏值。
 * 它是**只披露**的读数，与 `tripped` 走的那条判定链不相交：`verdictOfTrips` 的零容忍规则
 * 一个字不改，这里也不产出任何能被判定读到的形状。
 *
 * 只聚合**候选座位**：对手座位的占用不是候选的账——与 `verdictOfTrips` 把触限收窄到候选座位、
 * `score-source` 的 tracker 只认 `owner` 是同一条纪律。
 */

import { runMatch, type RunMatchParams } from "@model-war/engine";
import {
  TRIAL_CANDIDATE_SEAT,
  type ReplaySeat,
  type TrialTerminalSummary,
} from "@model-war/schema";

import { terminalSummaryOf } from "./terminal-summary.js";

import {
  mergePeakUsage,
  peakUsageOf,
  type PeakUsageAccumulator,
  type PeakUsageReading,
} from "./peak-usage.js";
import type { RecordedTrip } from "./trial.js";
import {
  createScoreSourceTracker,
  createActionFactsTracker,
  type TrialActionReading,
  type ScoreSourceReading,
  type ScoreSourceSnapshot,
} from "./score-source.js";

type TrialRunner = RunMatchParams["runners"][number];

/** 单场的试跑结论：记下的全部触限，以及作废故障（墙钟硬超时那条轨）。 */
export type TrialMatchOutcome = {
  readonly trips: readonly RecordedTrip[];
  /** 候选座位的「无得分来源」读数（只观测，不参与判定）。 */
  readonly scoreSource: ScoreSourceReading;
  /** 仅候选座位；这里尚未绑定实际 JS/hash/seed。 */
  readonly actionFacts: TrialActionReading;
  /** 仅 completed 有真实终局；作废未知，不补零。 */
  readonly terminalSummary?: TrialTerminalSummary;
  /** 作废即无结论：本场 void，调用方按"无法判定"处理（重跑一次，仍作废则大声失败）。 */
  readonly fault: { readonly tick: number } | null;
  /**
   * 候选座位逐 tick 的最坏占用读数（跨全部 tick 取更坏值）。**只披露、不判罚**。
   *
   * 缺席 = 整场一条读数都没采到。早退的那些 tick 只带事件计数，所以这里可能只有 `eventCount`
   * ——那是这一场真实的采样面，不补零。
   */
  readonly peakUsage?: PeakUsageReading;
};

/**
 * 包一层记录器：tick 在 `setSnapshot` 处记（快照的 tick 与同 tick 回放行同号），
 * 触限在 `drainIntents` 的返回载荷里收（座位是包的是第几个 runner）。
 *
 * `observe` 是可选的旁挂：它接到哪一侧**不影响读数**——四个 runner 拿到的是同一份
 * 全世界的只读快照（步 0 只建一次），而「只算本座位」的真源是 tracker 内部的 `owner` 比较
 * （`score-source.ts`，那边有对应用例）。挑候选座位那一侧挂只是因为它最省：座位被淘汰后
 * 步 0 不再给它的 runner 发快照（`step0-dispatch.ts`），而常规淘汰的那一刻它已无单位也无基地
 * （`step5-evaluate.ts` 的淘汰条件即此），之后不可能再有交付或占点——观测到淘汰为止等于观测了
 * 整局。例外是异常轨淘汰（`exceptionTickLimit` 打满）：那时单位还留着，只是收不到 intent 而
 * 采不了；这里不追那条边。
 */
const wrapWithRecorder = (
  runner: TrialRunner,
  seat: number,
  matchIndex: number,
  trips: RecordedTrip[],
  observe: ((snapshot: ScoreSourceSnapshot) => void) | null,
  observeActions: ReturnType<typeof createActionFactsTracker>["observeTick"] | null,
  peak: PeakUsageAccumulator | null,
): TrialRunner => {
  let tick = 0;
  return {
    setSnapshot: (snapshot) => {
      tick = snapshot.tick;
      observe?.(snapshot);
      runner.setSnapshot(snapshot);
    },
    drainIntents: () => {
      const output = runner.drainIntents();
      observeActions?.(output.actionFacts);
      // 占用读数逐 tick 取更坏值：它是「这条轨最坏用了多少」，不是这一 tick 的瞬时值。
      // 只对候选座位挂累加器（`peak` 在别的座位上是 null），理由见文件头注。
      if (peak !== null) mergePeakUsage(peak, output.peakUsage);
      for (const observation of output.observations) {
        if (observation.kind === "tripped") {
          trips.push({
            matchIndex,
            tick,
            seat: seat as RecordedTrip["seat"],
            track: observation.track,
            value: observation.value,
            limit: observation.limit,
          });
        }
      }
      return output;
    },
  };
};

/**
 * 跑完一场试跑：四个 runner 包上记录器 → `runMatch` → 交回事实、触限明细与作废故障。
 *
 * runners 下标即座位（与引擎的座位对齐约定一致）；调用方负责 runner 的创建与释放，
 * 这里只包不建、不释放。
 */
export const runTrialMatch = (options: {
  readonly runners: readonly TrialRunner[];
  readonly players: RunMatchParams["players"];
  readonly ruleset: RunMatchParams["ruleset"];
  readonly map: RunMatchParams["map"];
  readonly seed: number;
  readonly budget: RunMatchParams["budget"];
  readonly head: RunMatchParams["head"];
  readonly matchIndex: number;
  /** 候选在本场坐哪：计划给（v1 恒 0）；缺省取 v1 默认座位。 */
  readonly candidateSeat?: ReplaySeat;
}): TrialMatchOutcome => {
  const candidateSeat = options.candidateSeat ?? TRIAL_CANDIDATE_SEAT;
  const trips: RecordedTrip[] = [];
  const tracker = createScoreSourceTracker(candidateSeat);
  const actions = createActionFactsTracker(candidateSeat);
  const peak: PeakUsageAccumulator = {};
  const outcome = runMatch({
    ruleset: options.ruleset,
    map: options.map,
    seed: options.seed,
    head: options.head,
    players: options.players,
    runners: options.runners.map((runner, seat) =>
      wrapWithRecorder(
        runner,
        seat,
        options.matchIndex,
        trips,
        seat === candidateSeat ? tracker.observe : null,
        seat === candidateSeat ? actions.observeTick : null,
        seat === candidateSeat ? peak : null,
      ),
    ),
    budget: options.budget,
    sink: { write: () => {} },
    actionEffects: { record: actions.recordEffect },
  });
  const scoreSource = tracker.reading();
  const actionFacts = actions.reading();
  const peakUsage = peakUsageOf(peak);
  const usage = peakUsage === undefined ? {} : { peakUsage };
  if (outcome.status === "uncertain-timeout") {
    return { trips, scoreSource, actionFacts, fault: { tick: outcome.tick }, ...usage };
  }
  return {
    trips,
    scoreSource,
    actionFacts,
    terminalSummary: terminalSummaryOf(outcome, { ...options, candidateSeat }),
    fault: null,
    ...usage,
  };
};
