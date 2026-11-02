/**
 * 选拔的**决胜顺序**：唯一一处写法，v1（历史档）与 v2（评测网格）共用。
 *
 * 顺序是四条，依次比：平均分（降序）→ 较晚阶段 → 更早协议轮 → 脚本摘要（字典序）。
 * 前三条决定理由（`reason`），第四条只用于在两份完全一样的候选之间给一个确定的顺序——
 * 「同分、同阶段、同轮」时谁胜都不该由输入顺序决定，否则同一批候选重跑两次会选出不同的脚本。
 *
 * ── 为什么 `earlier-stage` 仍在这张表里 ──
 *
 * 历史档（v1）里冻结着按「更早阶段优先」决出的胜者。读它时必须按**它当时的算法**复算，
 * 否则历史档会以「胜者不符」被拒。所以这里保留 `stageReason`，由调用方给：新生产结果一律
 * `"later-stage"`，只有复算历史档才传 `"earlier-stage"`。v2 的 JSON 形状里干脆没有这个理由
 * （见 `selection-plan.ts`），新结果写不出来。
 *
 * ── 为什么平均分能直接减 ──
 *
 * 平均分是 `totalPoints / countedMatches`，两种情况的值域都小且都是「半个积分」的整数倍
 * （每场名次积分是 0 / 0.5 / 1 / 1.5 / 2 / 2.5 / 3，32 或 12 场之和再除分母，二进制可精确表示），
 * 差值的符号就是比较结果，不需要引入容差——容差会让「差一位」变成「打平」，那正是复算要防的事。
 */

/** 参与决胜的四项；v1 与 v2 的候选都能投影成它。 */
export type SelectionOrdering = {
  /** 平均名次积分（v1 = 12 场均分，v2 = 生成阶段那张网格的均分）。 */
  readonly averagePoints: number;
  readonly stage: number;
  readonly protocolRound: number;
  readonly scriptSha256: string;
};

/** 阶段理由：新结果 `later-stage`；复算历史档按它当时记的 `earlier-stage`。 */
export type SelectionStageReason = "later-stage" | "earlier-stage";

/** 四条决胜顺序（见文件头注）。负数 = `a` 在前。 */
export const compareSelectionCandidates = (
  a: SelectionOrdering,
  b: SelectionOrdering,
  stageReason: SelectionStageReason,
): number =>
  b.averagePoints - a.averagePoints ||
  (stageReason === "later-stage" ? b.stage - a.stage : a.stage - b.stage) ||
  a.protocolRound - b.protocolRound ||
  (a.scriptSha256 < b.scriptSha256 ? -1 : a.scriptSha256 > b.scriptSha256 ? 1 : 0);

/**
 * 胜者与第二名的差异落在哪一条上——即 `reason` 那一栏。
 *
 * 返回值跟 `stageReason` 的类型收窄：传 `"later-stage"` 时结果里根本没有 `earlier-stage`
 * （v2 的 shape 也不接受它），传联合类型时才可能返回历史语义。
 */
export const selectionReasonOf = <Reason extends SelectionStageReason>(
  winner: SelectionOrdering,
  second: SelectionOrdering,
  stageReason: Reason,
): "highest-average-points" | Reason | "earlier-protocol-round" | "script-hash" =>
  winner.averagePoints !== second.averagePoints
    ? "highest-average-points"
    : winner.stage !== second.stage
      ? stageReason
      : winner.protocolRound !== second.protocolRound
        ? "earlier-protocol-round"
        : "script-hash";
