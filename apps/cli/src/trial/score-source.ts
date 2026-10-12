/**
 * 试跑的「无得分来源」观测（不进引擎、不起 VM；判定口径是纯的，追踪本身跨帧有状态）。
 *
 * ── 判据 ──
 *
 * 候选座位在整局内既无交付也无占点即命中（`noScoreSource`）。
 * - 交付：本座位单位相邻两帧的 `carrying` 下降之和。不用资源净变化——同 tick 的交付
 *   可能被同 tick 的开产扣掉，净变化会漏算。不按 `type` 过滤成工人：非农民的 `carrying`
 *   恒为 0（`world/state.ts`），下降无从发生，加那一栏只是把兵种名拖进观测面。
 * - 占点：某点位的 `owner` 从非本座位变为本座位的次数。开局的归属不计。
 * - 单位死亡时载量随之消失，不计交付。
 *
 * ── 只观测，不判定 ──
 *
 * 结论只进 stderr 留痕（见 `trial.ts` 的 `renderScoreSourceObservation`）与逐场读数文件
 * （`observations.ts`，格式与写出纪律归那一格），不改 verdict、不改退出码、不进回喂。
 * 升级为判定另票裁决。
 */

/** 观测所需的最小快照形状（结构类型：引擎的 `Snapshot` 直接满足，不在此 import 引擎）。 */
export type ScoreSourceSnapshot = {
  readonly units: readonly {
    readonly id: number;
    readonly owner: number;
    readonly carrying: number;
  }[];
  readonly sites: readonly {
    readonly id: number;
    readonly owner: number;
  }[];
};

/** 整局读数。`noScoreSource` 即 C1 命中。 */
export type ScoreSourceReading = {
  readonly delivered: number;
  readonly captures: number;
  readonly noScoreSource: boolean;
};

export type ScoreSourceTracker = {
  /** 每 tick 喂一帧快照（按 tick 升序）。 */
  readonly observe: (snapshot: ScoreSourceSnapshot) => void;
  /** 截至目前的读数。 */
  readonly reading: () => ScoreSourceReading;
};

/** 为座位建一个追踪器。它只看 `seat` 的单位与占点，其余座位的变化一律忽略。 */
export const createScoreSourceTracker = (seat: number): ScoreSourceTracker => {
  let delivered = 0;
  let captures = 0;
  const lastCarrying = new Map<number, number>();
  const lastOwner = new Map<number, number>();

  return {
    observe: (snapshot) => {
      for (const unit of snapshot.units) {
        if (unit.owner !== seat) {
          continue;
        }
        const previous = lastCarrying.get(unit.id);
        if (previous !== undefined && unit.carrying < previous) {
          delivered += previous - unit.carrying;
        }
        lastCarrying.set(unit.id, unit.carrying);
      }
      for (const site of snapshot.sites) {
        const previous = lastOwner.get(site.id);
        if (previous !== undefined && previous !== seat && site.owner === seat) {
          captures += 1;
        }
        lastOwner.set(site.id, site.owner);
      }
    },
    reading: () => ({
      delivered,
      captures,
      noScoreSource: delivered === 0 && captures === 0,
    }),
  };
};
