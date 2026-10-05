/**
 * 步 7 · loop guard:`tick` 达规则集的 `tickLimit` → 超时,按 gdd《胜利与淘汰》的领土分规则定名次。
 *
 * ── 为什么判的是「写出行之后的 `state.tick`」 ──
 * 步 6 已经 `tick++`,所以到这里 `state.tick` 是**下一 tick 的编号**。「tick 达 `tickLimit`」
 * 说的正是下一 tick 越界那一拍:最后一个被结算的 tick 的编号是 `tickLimit - 1`。
 * 拿 `state.tick` 之前判,会早一 tick 收官;拿 `state.tick + 1` 判,会晚一 tick,
 * 两者都会让「第 N 行 tick 栏」与「规则以为的 N」差一格,而这类差一格在回放里极难看出来。
 *
 * ── 本票只做到「判超时」,名次算法留给票 09 ──
 * 名次要按 gdd 的四层排序(胜者第一、存活分层、层内按领土分或淘汰时间、仍相同则并列),
 * 而领土分要用**控制基地数**与**存活单位造价**——后者的来源是步 4 的生产记录,
 * 04–09 落地之前算不出真实的领土分。故本步只产出**触发信号** `limitReached`,
 * 票 09 把它换成 `state.outcome`。信号走返回值而不是写 `outcome` 的半截形状:
 * 一个 `reason: "timeout"` 而 `rankings` 还是空数组的 `Outcome`,会被渲染器与战报当成
 * 「这局打完了」读。
 */

import type { Step } from "../context.js";

export const step7LoopGuard: Step = (context) => ({
  ...context,
  limitReached: context.state.tick >= context.ruleset.raw.tickLimit,
});
