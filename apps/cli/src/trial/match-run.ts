/**
 * 试跑单场：包一层 trip 记录器，调引擎唯一的对外入口跑完一局。
 *
 * ── 为什么记录器包在 runner 外面，而不是改引擎 ──
 *
 * `tripped` 观测在步 0 被转成状态变更（累加 `exceptionTicks`），不进观测出口；
 * `executeMatch` 也不交回 `finalState`——走既有装载路径拿不到"第几 tick、哪项预算、
 * 超了多少"的明细。而试跑要的恰好是明细，不是胜负。所以记录器搭在缝的**调用点**上：
 * 经 `setSnapshot` 拿 tick（与步 0 同源），经 `drainIntents` 的返回载荷拿轨名/读数/上限，
 * 不动引擎、不碰结算管线。
 *
 * ── 记不记与判不判是两件事 ──
 *
 * 这里记下**全部** `tripped`（含对手座位、含未吞异常与内存轨）；"拦不拦"由 `trial.ts`
 * 的 `verdictOfTrips` 按"候选座位 + events/apis 两轨"收窄。调用方（入口脚本）可以把
 * 被忽略的触限打到 stderr 留痕，而不影响结论。
 *
 * 回放行直接丢弃：试跑要的只是一条结论与首触明细，重跑可复现，不留对局产物。
 */

import { runMatch, type RunMatchParams } from "@model-war/engine";

import type { RecordedTrip } from "./trial.js";

type TrialRunner = RunMatchParams["runners"][number];

/** 单场的试跑结论：记下的全部触限，以及作废故障（墙钟硬超时那条轨）。 */
export type TrialMatchOutcome = {
  readonly trips: readonly RecordedTrip[];
  /** 作废即无结论：本场 void，调用方按"无法判定"处理（重跑一次，仍作废则大声失败）。 */
  readonly fault: { readonly tick: number } | null;
};

/**
 * 包一层记录器：tick 在 `setSnapshot` 处记（快照的 tick 与同 tick 回放行同号），
 * 触限在 `drainIntents` 的返回载荷里收（座位是包的是第几个 runner）。
 */
const wrapWithRecorder = (
  runner: TrialRunner,
  seat: number,
  matchIndex: number,
  trips: RecordedTrip[],
): TrialRunner => {
  let tick = 0;
  return {
    setSnapshot: (snapshot) => {
      tick = snapshot.tick;
      runner.setSnapshot(snapshot);
    },
    drainIntents: () => {
      const output = runner.drainIntents();
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
 * 跑完一场试跑：四个 runner 包上记录器 → `runMatch` → 交回触限明细与作废故障。
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
}): TrialMatchOutcome => {
  const trips: RecordedTrip[] = [];
  const outcome = runMatch({
    ruleset: options.ruleset,
    map: options.map,
    seed: options.seed,
    head: options.head,
    players: options.players,
    runners: options.runners.map((runner, seat) =>
      wrapWithRecorder(runner, seat, options.matchIndex, trips),
    ),
    budget: options.budget,
    sink: { write: () => {} },
  });
  if (outcome.status === "uncertain-timeout") {
    return { trips, fault: { tick: outcome.tick } };
  }
  return { trips, fault: null };
};
