/** 只读的实际结算增量；不含对象 ID、坐标、快照或策略参数，不进入状态与回放。 */
import type { PlayerIndex } from "../world/state.js";

export type ActionEffect = {
  readonly seat: PlayerIndex;
  readonly kind:
    | "movedSteps"
    | "harvestedAmount"
    | "deliveredAmount"
    | "captureEvents"
    | "productionOrdersStarted";
  readonly amount: number;
};

export type ActionEffectSink = {
  readonly record: (effect: ActionEffect) => void;
};
