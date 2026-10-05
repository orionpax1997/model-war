/**
 * 步 3 · combat:同 tick 全部 attack **同时**结算(hld §4.3)。
 *
 * ── 为什么「同时」要由步位保证,而不是由实现自觉 ──
 *
 * 规则是两条:a) 先计算全部伤害,**攻击者本 tick 死亡不影响其攻击生效**;b) 统一扣血,归零者死亡移除。
 * 「同时」这件事在实现上的落点就是**计算与扣血分两趟**——所以它必须被固定在「同一步之内」,
 * 一旦有人把「算伤害」挪到步 2、「扣血」挪到步 4,两条规则就都破了,而管线看起来仍然跑得通。
 * 步位把这件事钉住:计算与扣血只能在**同一步**里发生。
 *
 * 本票不实现它(见 `step2-movement.ts` 头注同一条纪律):事件 `first-contact` 归步 2、
 * `unit-destroyed` 归步 3,两个具名方法在收集器上已经就位(`processor/events.ts` 的 `STEP_OF`)。
 */

import type { Step } from "../context.js";

export const step3Combat: Step = (context) => context;
