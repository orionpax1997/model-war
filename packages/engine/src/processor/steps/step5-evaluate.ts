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
 * ── 判据与名次算法分居两处 ──
 *
 * 本步只负责「按这个顺序问那四个问题、把结论写进 `state.outcome`」;领土分、名次编号与胜者
 * 这类纯计算在 `processor/outcome.ts`。分开的理由是两者的自由面不同:顺序是**规则**
 * (改它要走一次有意的规则变更),而名次的排序与编号只对 `Outcome` 负责、与步位无关。
 *
 * ── 唯一的出口是 `state.outcome` ──
 *
 * 判出终局时经 `apply()` 的 `set-outcome` 变更写 `state.outcome`(唯一写入口)。步 5 写
 * `victory` / `shortcut` / `all-eliminated` 三种;`timeout` 归步 7——「`tick` 达 `tickLimit`」
 * 是步 7 的事,不是这一步的一次判定。
 *
 * 事件 `player-eliminated` 与 `victory` 都归步 5,由收集器按「步号 → 主体数值 id」定序。
 */

import { apply } from "../../driver/apply.js";
import type { PlayerIndex } from "../../world/state.js";
import type { Step, TickContext } from "../context.js";
import { outcomeOf } from "../outcome.js";

/** 一段判定。签名收到上下文,返回**改过的**上下文——判出终局时写 `state.outcome`,那是唯一出口。 */
type EvaluateStage = (context: TickContext) => TickContext;

/** 段名。中文小标题即 gdd《胜利与淘汰》里那四条,与判据的措辞对齐。 */
export const EVALUATE_STAGE_NAMES = [
  "a) 淘汰:无单位且无基地者,或累计异常达 exceptionTickLimit 者,出局",
  "b) 点位回归中立:被淘汰玩家名下残余点位全部回归中立",
  "c) 全点位归属:全部点位归属单一玩家 → 胜",
  "d) 捷径条款:仅剩一方尚存即胜(兜底)",
] as const;

/** 四个座位,下标即座位号(hld §2.3)。淘汰判定按它升序走,事件主体序因此是确定的。 */
const SEATS: readonly PlayerIndex[] = [0, 1, 2, 3];

/**
 * a) 淘汰:同时**无任何单位且无任何基地**者出局(gdd);或**累计异常达 `exceptionTickLimit`** 者
 *    判负出局(hld §5.2 第一/二/四类的共同后果,gdd《异常与出局》)。
 *
 * 条件是「或」的两支:
 * - 「无单位且无基地」是与——部队尚存就仍有翻盘可能——被夺家后靠残兵反夺基地是刻意保留的戏剧空间;
 * - 「累计异常达上限」是**独立一支**:它不看在不在场内,判的是脚本自身的失控。
 *
 * 异常支只在组装层传了 `exceptionTickLimit` 时生效(字段缺席即该轨不启用,引擎不认识「未定值」)。
 * 异常计数已在同一 tick 的步 0 由 `tripped` 观测累加进 `player.exceptionTicks`,本段读到的是
 * **更新后**的值——所以「本 tick 触发、本 tick 判负」是同一拍完成的。出局这一件事经**一条**
 * `eliminate-player` 变更同时写 `alive` 与淘汰时刻(理由见 `apply.ts`)。
 */
const eliminateStage: EvaluateStage = (context) => {
  const { ruleset, collector, budget } = context;
  const exceptionTickLimit = budget.exceptionTickLimit;
  let state = context.state;
  for (const seat of SEATS) {
    const player = state.players[seat];
    if (player === undefined || !player.alive) {
      continue;
    }
    // 异常支:达累计上限即判负(不看单位/基地)。未启用本轨时恒 false。
    const caughtByExceptions =
      exceptionTickLimit !== undefined && player.exceptionTicks >= exceptionTickLimit;
    const hasUnit = state.units.some((unit) => unit.owner === seat);
    const hasBase = state.sites.some((site) => site.kind === "base" && site.owner === seat);
    if (!caughtByExceptions && (hasUnit || hasBase)) {
      continue;
    }
    state = apply(state, ruleset.raw, { kind: "eliminate-player", seat, tick: state.tick });
    collector.playerEliminated(seat);
  }
  return { ...context, state };
};

/**
 * b) 点位回归中立:非存活席位名下的残余点位全部清回中立(gdd)。
 *
 * 读「该席位此刻是否存活」而不是「本 tick 淘汰了谁」,是因为回归中立对**任何**已出局席位都必须
 * 成立(出局那一 tick 就已清过一次,这里是幂等的)。遍历判定开始时的点位表——回归中立只改点位
 * 自身的归属,不改点位集合,互不牵连。
 */
const returnNeutralStage: EvaluateStage = (context) => {
  const { ruleset } = context;
  let state = context.state;
  for (const site of context.state.sites) {
    const owner = site.owner;
    if (owner === -1 || state.players[owner]?.alive !== false) {
      continue;
    }
    state = apply(state, ruleset.raw, { kind: "return-site-to-neutral", siteId: site.id });
  }
  return { ...context, state };
};

/**
 * c) 全点位归属:地图上全部点位属于同一名玩家 → 该玩家瞬间获胜(gdd)。
 *
 * 「全部」含中立点与敌方主基地——**一个中立点都不留**才算控制全图。所以判据是「无中立点,
 * 且所有属主相同」;点位数从点位表读,不硬编码。
 */
const allSitesStage: EvaluateStage = (context) => {
  const { ruleset, collector } = context;
  if (context.state.outcome !== null) {
    return context;
  }
  const first = context.state.sites[0];
  if (first === undefined || first.owner === -1) {
    return context;
  }
  const winner = first.owner;
  if (!context.state.sites.every((site) => site.owner === winner)) {
    return context;
  }
  collector.victory(winner);
  return {
    ...context,
    state: apply(context.state, ruleset.raw, {
      kind: "set-outcome",
      outcome: outcomeOf(context.state, ruleset, "victory", winner),
    }),
  };
};

/**
 * d) 捷径条款(兜底):除自己外三方全部被淘汰时,仅剩的一方立即获胜(gdd)。
 *
 * 这一档也是第四态 `all-eliminated` 的家:捷径要求「仅剩一方」,而**一方不剩**时(同 tick 全灭,
 * 票面那个真实边缘)主胜利与捷径都不成立——此时写 `all-eliminated`,名次按淘汰时间倒序由
 * `outcome.ts` 算,首名是最后出局的那方。后方写这一态,是为了让「淘汰 → 回归中立 → 全点位 →
 * 捷径」这条链的每一档都有确定答案,而不是落进一个没有终局的空档。
 */
const shortcutStage: EvaluateStage = (context) => {
  const { ruleset, collector } = context;
  if (context.state.outcome !== null) {
    return context;
  }
  const alive = SEATS.filter((seat) => context.state.players[seat]?.alive === true);
  if (alive.length === 1) {
    const winner = alive[0];
    if (winner === undefined) {
      return context;
    }
    collector.victory(winner);
    return {
      ...context,
      state: apply(context.state, ruleset.raw, {
        kind: "set-outcome",
        outcome: outcomeOf(context.state, ruleset, "shortcut", winner),
      }),
    };
  }
  if (alive.length === 0) {
    return {
      ...context,
      state: apply(context.state, ruleset.raw, {
        kind: "set-outcome",
        outcome: outcomeOf(context.state, ruleset, "all-eliminated", null),
      }),
    };
  }
  return context;
};

/**
 * 四段按 gdd 定的顺序排开。**这张表的顺序就是规则**,改它要走一次有意的规则变更
 * (FR-10 AC3:顺序写入 `docs/rules-v1`)。
 *
 * hld §4.3 步 5 还列了第四条「淘汰方 `loop()` 不再执行(VM 暂停调用,状态保留以便重放取证)」。
 * 它**不另起一段**:那是 a) 淘汰的**后果**而不是一次独立判定——被淘汰者在下一 tick 的步 0
 * 不再被调用,那件事落在步 0 的执行器编排上(见 `steps/step0-dispatch.ts`)。
 */
export const EVALUATE_STAGES: readonly EvaluateStage[] = [
  eliminateStage,
  returnNeutralStage,
  allSitesStage,
  shortcutStage,
];

export const step5Evaluate: Step = (context) =>
  EVALUATE_STAGES.reduce((now, stage) => stage(now), context);
