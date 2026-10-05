/**
 * 步 4 · objectTick:按对象数值 id 升序结算四件事(hld §4.3)。
 *
 * 占领(a) / 采集与交付(b、c) / 生产(d)。「按对象数值 id 升序」是第 5 条跨票不变量,
 * 它在这一步第一次真正起作用:一个 tick 里多个对象同时推进,遍历次序就成了规则。
 *
 * 四段的顺序不可换:交付(c)在生产(d)之前,是因为**交付进的是玩家池**,而生产花钱也走玩家池——
 * 反过来会让「这一 tick 卖掉矿之后能不能立刻出兵」在两种遍历序下得到不同答案。
 *
 * 本票不实现它(见 `step2-movement.ts` 头注同一条纪律)。事件 `site-captured` 与 `economy-dead`
 * 都归步 4,收集器上的具名方法已经就位。
 */

import type { Step } from "../context.js";

export const step4ObjectTick: Step = (context) => context;
