/**
 * 步 1 · validate:intent 先按单位分组、每单位只留最后一个(静默丢弃、不计异常),
 * 分组后按 `playerIndex 0..3` 再按对象数值 id 升序逐条校验;无效者丢弃(hld §4.3)。
 *
 * ── 本票的校验覆盖移动两条、攻击一条、采集两条与生产一条 ──
 *
 * 六条 intent 里,`harvest` / `transfer` 的 `check()` 归 07(本票)。两条都是**单位级**意图,
 * 与其余单位级意图一起分组、定序。
 *
 * `spawnUnit` 是**玩家级**意图(不带单位 id),由 `groupIssuedIntents` 与单位级意图混在同一个序列里
 * 按「座位 → 对象数值 id」排,且**不参与「每单位只留最后一个」那条分组**(见 intents.ts)。
 *
 * ── 为什么 `harvest` / `transfer` 也用 tick 开始的状态校验,而步 4 会再判一次 ──
 *
 * 与 `attack` 同形:步 1 判「这条意图单看是否合法」,真正的落子步(步 4)在**当前**状态上重判——
 * 同 tick 的占领(a 段)可能已把矿/基地易主,采集也可能已把矿采空。两次判读的是同一份只读视图,
 * 重判不在步 1 之外另立一套判据。
 *
 * ── 丢弃为什么不发事件、不计异常 ──
 *
 * hld §4.2 一方面说「无效 intent 丢弃并写入当 tick 事件流(调试可观测)」,另一方面
 * hld §7.5 的八种事件里**没有**「意图无效」这一类,而收集器也没有对应方法。本票按后者办:
 * **静默丢弃**。这是要记下的一处文档不一致(加第九种事件会改跨进程形状,不归本票)。
 * 「丢弃不触发异常判罚」本身是明确的:异常判罚只针对脚本抛异常与超预算。
 */

import { checkAttack, isAttackIntent } from "../combat.js";
import { checkHarvest, checkTransfer, isHarvestIntent, isTransferIntent } from "../economy.js";
import { groupIssuedIntents } from "../intents.js";
import { checkMove, isMoveIntent } from "../movement.js";
import { checkSpawn, isSpawnIntent } from "../production.js";
import type { Step } from "../context.js";

export const step1Validate: Step = (context) => {
  // `GameState` 结构上就是 `MovementView` / `AttackView` / `ProductionView`(每型每栏 readonly),
  // 直接传,不做一层拷贝。
  const view = context.state;
  const intents = groupIssuedIntents(context.drained).filter(({ seat, intent }) => {
    if (isMoveIntent(intent)) {
      return checkMove(view, seat, intent);
    }
    if (isAttackIntent(intent)) {
      return checkAttack(view, seat, context.ruleset, intent);
    }
    if (isSpawnIntent(intent)) {
      return checkSpawn(view, seat, context.ruleset, intent);
    }
    if (isHarvestIntent(intent)) {
      return checkHarvest(view, seat, context.ruleset, intent);
    }
    if (isTransferIntent(intent)) {
      return checkTransfer(view, seat, context.ruleset, intent);
    }
    // 六条 intent 已全部覆盖;走到这里只可能是类型层加了新的一条而这里没跟上。
    return false;
  });
  return { ...context, intents };
};
