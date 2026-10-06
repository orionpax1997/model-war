/**
 * 步 3 · combat:同 tick 全部 attack **同时**结算(hld §4.3 步 3、gdd §6.2)。
 *
 * ── 为什么「同时」要由步位保证,而不是由实现自觉 ──
 *
 * 规则是两条:a) 先计算全部伤害,**攻击者本 tick 死亡不影响其攻击生效**;b) 统一扣血,归零者死亡移除。
 * 「同时」这件事在实现上的落点就是**计算与扣血分两趟**——所以它必须被固定在「同一步之内」,
 * 一旦有人把「算伤害」挪到步 2、「扣血」挪到步 4,两条规则就都破了,而管线看起来仍然跑得通。
 * 步位把这件事钉住:计算与扣血只能在**同一步**里发生。本步内部即那两趟:
 *
 * 1. **第一趟**:对本 tick 全部有效 attack 意图算出伤害条,**只读基线 `context.state`,中途不改**。
 *    攻击条是在任何扣血**之前**算出来的,所以「攻击者本 tick 死亡不影响其攻击生效」自动成立。
 * 2. **第二趟**:同一目标的伤害**求和**(单一血池),按目标数值 id 升序统一扣血;归零者发
 *    `destroy-unit` 移除。
 *
 * ── 死亡移除与事件 ──
 *
 * 移除按对象数值 id 升序(票面要求)。因为伤害在第一趟已全部算完,移除**不影响**同 tick 其余伤害。
 * 事件 `unit-destroyed` 归本步(`events.ts` 的 `STEP_OF`),具名方法 `collector.unitDestroyed`。
 *
 * ── 「聚合」的口径 ──
 *
 * hld §7.5 把 `unit-destroyed` 标成「(聚合)」,而 `Event` 的形状是 `{kind, subjectId}`(一个事件
 * 一个主体,加不了第二个字段)。所以「聚合」在本仓能落成的形态只有一种:**按被消灭的单位聚合**——
 * 同 tick 每个被消灭的单位发一条事件(主体是单位 id),而**不是**按「攻击者-目标对」发一条。
 * 于是两个攻击者打死同一个单位 → **恰好一条** `unit-destroyed`(有用例钉住)。这条形状归
 * `packages/schema`,本票不动它。
 *
 * ── hp 取法 ──
 *
 * `hp - 求和伤害`,**允许取到 0 或负数**(过杀)。负值只在本步内瞬时存在:归零者在同一次迭代里
 * 紧接着被 `destroy-unit` 移除,所以步 6 写出时它已经不在了——任何写出的 tick 行里都不会出现负 hp
 * (有用例解析写出行断言)。取「允许负值再移除」而不是「钳到 0」,是为了让「忘了移除」这件事在
 * 断言下当场变红(钳到 0 会把一个零血活单位留进写出的一行)。
 *
 * ── 攻击者重复提交 ──
 *
 * 由步 1 的分组挡掉(每单位只留最后一条),本步不重复处理。
 */

import { apply } from "../../driver/apply.js";
import { isAttackIntent, runAttack } from "../combat.js";
import type { Step } from "../context.js";

export const step3Combat: Step = (context) => {
  const { ruleset, collector } = context;
  // 基线:本 tick 全部攻击都从这一份状态读,中途不改它——这就是「同时」。攻击者在这一 tick
  // 里死没死,不影响它在这里能不能算出伤害(它读的是基线)。
  const view = context.state;

  // 第一趟:算出全部伤害条。只读基线,故「攻击者本 tick 死亡不影响其攻击生效」天然成立。
  const damages = context.intents.flatMap(({ seat, intent }) => {
    if (!isAttackIntent(intent)) {
      return [];
    }
    const damage = runAttack(view, seat, ruleset, intent);
    return damage === null ? [] : [damage];
  });

  // 第二趟:同一目标伤害求和(单一血池),按目标数值 id 升序统一扣血,归零者移除。
  const totalByTarget = new Map<number, number>();
  for (const { targetId, damage } of damages) {
    totalByTarget.set(targetId, (totalByTarget.get(targetId) ?? 0) + damage);
  }

  let state = view;
  let destroyed: readonly number[] = [];
  for (const targetId of [...totalByTarget.keys()].sort((left, right) => left - right)) {
    const target = view.units.find((unit) => unit.id === targetId);
    if (target === undefined) {
      // 目标只可能在基线里缺席(伤害条由 runAttack 保证命中过它),防御一下,不静默改别的。
      continue;
    }
    const remaining = target.hp - (totalByTarget.get(targetId) ?? 0);
    state = apply(state, ruleset.raw, { kind: "set-unit-hp", unitId: targetId, hp: remaining });
    if (remaining <= 0) {
      state = apply(state, ruleset.raw, { kind: "destroy-unit", unitId: targetId });
      destroyed = [...destroyed, targetId];
    }
  }

  // 事件按被消灭的单位一条;主体升序(收集器本就会按主体定序,这里也保持升序,不依赖它兜底)。
  for (const unitId of destroyed) {
    collector.unitDestroyed(unitId);
  }

  return { ...context, state };
};
