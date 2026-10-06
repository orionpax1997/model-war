/**
 * 步 4 · objectTick:按对象数值 id 升序结算四件事(hld §4.3)。
 *
 * 占领(a) / 采集与交付(b、c) / 生产(d)。「按对象数值 id 升序」是第 5 条跨票不变量,
 * 它在这一步第一次真正起作用:一个 tick 里多个对象同时推进,遍历次序就成了规则。
 *
 * 四段的顺序不可换:交付(c)在生产(d)之前,是因为**交付进的是玩家池**,而生产花钱也走玩家池——
 * 反过来会让「这一 tick 卖掉矿之后能不能立刻出兵」在两种遍历序下得到不同答案。
 *
 * ── 本票只交付第一段(a)占领 ──
 *
 * b) 采集 / c) 交付 / d) 生产三段归**票 06/07**。这里只把 a) 接上,配电盘(b/c/d 的槽位、
 * 步位与定序规则)已经就位:三段各自落到本步里遍历 `/units` 或 `/sites` 的位置,顺序不许换。
 *
 * ── 占领进度机的家在哪(gdd §8 记录 #14)──
 *
 * 进度机的**家是 gdd §3.2《占领机制》**,机制实现在 `processor/capture.ts`(这里只做接线)。
 * 面向模型的契约面 `docs/rules-v1/rules.md` 的 **§5「占领」是占位**(原文写着「本节未排期」):
 * 终稿契约下盲写三舱全部撞上它、各自猜出一套互斥机制。规则侧不缺机制,缺的是契约面那一节散文——
 * 它归下一轮机制契约散文,本轮不手改生成物。**下一轮补 §5 时以 §3.2 为准,不在契约面另立一套。**
 *
 * ── 事件 ──
 *
 * `site-captured` 在**易主那一刻**发,主体是点位号(`subjectId` 的定序主体是点位 id);
 * `STEP_OF` 已把它挂在步 4(见 `processor/events.ts`),本步不改那张步位表。
 * 「按对象数值 id 升序」由这里遍历升序的 `state.sites` 保证;同一 tick 多个点位易主时,
 * 同一主体在事件全序里由点位 id 定序(定序规则见 `events.ts` 头注)。
 *
 * `economy-dead` 也是步 4 的事件,但**不归本票**:它的判据归票 09。别顺手发。
 */

import { apply } from "../../driver/apply.js";
import { captureChangeOf, isCapture } from "../capture.js";
import type { Step } from "../context.js";

export const step4ObjectTick: Step = (context) => {
  const { ruleset, collector } = context;
  // 遍历 **tick 开始时的**点位表:每个点位本 tick 只被看一次,结果互不牵连(占领读的是单位占位与
  // 点位自己的轨道,见 `capture.ts`)。`state.sites` 由状态不变量保证升序,这里不重排。
  const sites = context.state.sites;
  let state = context.state;

  for (const site of sites) {
    const change = captureChangeOf(site, state.units, ruleset);
    if (change === null) {
      // 保留不动:无人站立,或驱动者与属主同阵营。什么都不写。
      continue;
    }
    state = apply(state, ruleset.raw, change);
    if (isCapture(change)) {
      collector.siteCaptured(site.id);
    }
  }

  return { ...context, state };
};
