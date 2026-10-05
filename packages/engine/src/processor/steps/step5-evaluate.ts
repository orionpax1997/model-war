/**
 * 步 5 · evaluate:胜负判定(**顺序即规范**,gdd《胜利与淘汰》)。
 *
 * ── 四段的顺序为什么不可换 ──
 *
 * gdd 把结算顺序写死成一条链:每 tick **先判淘汰 → 被淘汰者点位回归中立 → 再判全点位归属 →
 * 最后判捷径条款(兜底)**。前两段是后两段的**前提**:
 * - 「回归中立可能破坏『全点位』条件时,由捷径条款接住」——所以捷径条款必须在全点位判定**之后**,
 *   提前判它就会在一局「四家同时出局」里判出一个不存在的胜者;
 * - 淘汰与回归中立不能反:先判「全点位归属」再淘汰,会把一个刚被清空的席位算进「有人控制全部点位」,
 *   于是灭族的那个席位反而先赢一步。
 *
 * ── 本票只立**顺序骨架**,判据留给票 09 ──
 *
 * 四段各一个具名闭包,现在全是空的。空的含义是「判据尚未落」,不是「判据是恒假」——
 * 这正是本票**一条事件机制都不实现**的代价与收益:顺序先立,判据后填,于是票 09 不必
 * 重新决定顺序,只须决定判据。`EVALUATE_STAGES` 是这一段的唯一一份顺序声明,
 * `step5-evaluate.test.ts` 直接对着它断言段名与段序。
 *
 * 事件 `player-eliminated` 与 `victory` 都归步 5,收集器上的具名方法已经就位。
 */

import type { Step, TickContext } from "../context.js";

/** 一段判定。签名收到上下文,返回**改过的**上下文——判出终局时写 `state.outcome`,那是唯一出口。 */
type EvaluateStage = (context: TickContext) => TickContext;

/** 段名。中文小标题即 gdd《胜利与淘汰》里那四条,与判据的措辞对齐。 */
export const EVALUATE_STAGE_NAMES = [
  "a) 淘汰:满足淘汰条件者出局(同时无任何单位且无任何基地)",
  "b) 点位回归中立:被淘汰玩家名下残余点位全部回归中立",
  "c) 全点位归属:全部点位归属单一玩家 → 胜",
  "d) 捷径条款:仅剩一方尚存即胜(兜底)",
] as const;

/**
 * 四段按 gdd 定的顺序排开。**这张表的顺序就是规则**,改它要走一次有意的规则变更
 * (FR-10 AC3:顺序写入 `docs/rules-v1`)。
 *
 * hld §4.3 步 5 还列了第四条「淘汰方 `loop()` 不再执行(VM 暂停调用,状态保留以便重放取证)」。
 * 它**不另起一段**:那是 a) 淘汰的**后果**而不是一次独立判定——被淘汰者在下一 tick 的步 0
 * 不再被调用,那件事落在步 0 的执行器编排上(04–09 那一格)。多起一段只会多一处需要
 * 保持同步的「谁算已出局」名单。
 */
export const EVALUATE_STAGES: readonly EvaluateStage[] = [
  (context) => context,
  (context) => context,
  (context) => context,
  (context) => context,
];

export const step5Evaluate: Step = (context) =>
  EVALUATE_STAGES.reduce((now, stage) => stage(now), context);
