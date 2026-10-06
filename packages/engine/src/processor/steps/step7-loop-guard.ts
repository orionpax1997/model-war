/**
 * 步 7 · loop guard:`tick` 达规则集的 `tickLimit` → 超时,写 `state.outcome` 的第四种原因。
 *
 * ── 为什么判的是「写出行之后的 `state.tick`」 ──
 * 步 6 已经 `tick++`,所以到这里 `state.tick` 是**下一 tick 的编号**。「tick 达 `tickLimit`」
 * 说的正是下一 tick 越界那一拍:最后一个被结算的 tick 的编号是 `tickLimit - 1`。
 * 拿 `state.tick` 之前判,会早一 tick 收官;拿 `state.tick + 1` 判,会晚一 tick,
 * 两者都会让「第 N 行 tick 栏」与「规则以为的 N」差一格,而这类差一格在回放里极难看出来。
 *
 * ── 为什么先看 `state.outcome` 再判超时 ──
 * 步 5 可能在**恰是最后一 tick** 上判出 victory / shortcut / all-eliminated(胜负先于超时);那时
 * `outcome` 已置,本步不得把它覆盖成 timeout——「打满 600 tick」与「第 600 tick 分出胜负」是报告
 * 靠 `reason` 区分的两件事,覆盖就是把后者读成前者。
 *
 * ── 名次算法在哪 ──
 * 领土分、名次编号与胜者的纯计算在 `processor/outcome.ts`;本步只负责把 `timeout` 这一档
 * (无胜者)交给它,经 `apply()` 的 `set-outcome` 变更落进 `state.outcome`(唯一写入口)。
 */

import { apply } from "../../driver/apply.js";
import type { Step } from "../context.js";
import { outcomeOf } from "../outcome.js";

export const step7LoopGuard: Step = (context) => {
  if (context.state.outcome !== null) {
    return context;
  }
  if (context.state.tick < context.ruleset.raw.tickLimit) {
    return context;
  }
  return {
    ...context,
    state: apply(context.state, context.ruleset.raw, {
      kind: "set-outcome",
      outcome: outcomeOf(context.state, context.ruleset, "timeout", null),
    }),
  };
};
