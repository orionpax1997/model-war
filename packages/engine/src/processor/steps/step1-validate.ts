/**
 * 步 1 · validate:intent 先按单位分组、每单位只留最后一个(静默丢弃、不计异常),
 * 分组后按 `playerIndex 0..3` 再按对象数值 id 升序逐条校验;无效者丢弃(hld §4.3)。
 *
 * ── 本票的校验只覆盖移动两条,其余四条是「尚未实现」而不是「非法」 ──
 *
 * 六条 intent 里,`attack` / `harvest` / `transfer` / `spawnUnit` 的 `check()` 归 05–09。
 * 本步现在把它们**丢弃**。写清楚这是**尚未实现**:不写,后来者会把「一条 attack 被丢掉」
 * 读成「attack 是真的非法」,而那不是本层的语义。丢弃的原因是本票只交付移动。
 *
 * ── 丢弃为什么不发事件、不计异常 ──
 *
 * hld §4.2 一方面说「无效 intent 丢弃并写入当 tick 事件流(调试可观测)」,另一方面
 * hld §7.5 的八种事件里**没有**「意图无效」这一类,而收集器也没有对应方法。本票按后者办:
 * **静默丢弃**。这是要记下的一处文档不一致(加第九种事件会改跨进程形状,不归本票)。
 * 「丢弃不触发异常判罚」本身是明确的:异常判罚只针对脚本抛异常与超预算。
 */

import { groupIssuedIntents } from "../intents.js";
import { checkMove, isMoveIntent } from "../movement.js";
import type { Step } from "../context.js";

export const step1Validate: Step = (context) => {
  // `GameState` 结构上就是 `MovementView`(那一型每栏 readonly),直接传,不做一层拷贝。
  const view = context.state;
  const intents = groupIssuedIntents(context.drained).filter(({ seat, intent }) => {
    if (!isMoveIntent(intent)) {
      // 尚未实现,不是非法。静默丢弃,不发事件、不计异常(见头注)。
      return false;
    }
    return checkMove(view, seat, intent);
  });
  return { ...context, intents };
};
