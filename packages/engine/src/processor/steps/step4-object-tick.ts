/**
 * 步 4 · objectTick:按对象数值 id 升序结算四件事(hld §4.3)。
 *
 * 占领(a) / 采集(b) / 交付(c) / 生产(d)。「按对象数值 id 升序」是第 5 条跨票不变量,
 * 它在这一步第一次真正起作用:一个 tick 里多个对象同时推进,遍历次序就成了规则。
 *
 * 四段的顺序不可换:采集取的是矿的储量、交付进的是玩家池,而生产花钱也走玩家池——
 * 交付(c)在生产(d)之前,于是「这一 tick 交了货之后能不能立刻用这笔钱下单」有确定答案。
 * 反过来会让同一份脚本在两种遍历序下得到不同结果,而回放要求逐项可复算。
 *
 * ── 四段各自的家 ──
 * a) 占领与 a→d 之间的接缝(易主 → 取消队列 + 退款)由票 05/06 落地(家:`processor/capture.ts`
 * 与 `processor/production.ts`);b) 采集、c) 交付与经济死亡由票 07 落地(家:`processor/economy.ts`)。
 * 槽位与定序规则在这里,机制在各自的模块里。
 *
 * ── 易主发生在 a) 段,而它引发的「队列取消 + 退款」也必须在 a) 那一刻完成 ──
 *
 * 队列的存在与否要在 d) 推进之前定下来,否则一个刚易主的基地会在同一 tick 里替**新主**把
 * **原主的单**推进一步。所以接缝写在 a) 的循环里、落在 d) 之前——顺序在这里是规则,不是排版。
 *
 * ── b) 与 c) 为什么可以分两段而不互相干扰 ──
 *
 * 两条都是**单位级**意图,且由步 1 的分组保证「每单位每 tick 至多一条」(见 `processor/intents.ts`)——
 * 一个单位不可能同一 tick 既采又交。于是 b) 只改「提交采集的单位的 `carrying`」与「对应矿的
 * `remaining`」,c) 只改「提交交付的单位的 `carrying`」与「该单位的玩家池」,两个载体集合不相交,
 * 且交付不读任何矿的 `remaining`。所以换 b/c 的先后,最终状态逐字相同——不是「顺序无关」,而是
 * 两者作用在**不相交的载体**上(交付读写的玩家池与采集读写的矿不是同一类对象)。
 *
 * ── d) 的两件事与先后 ──
 *
 * 1. **下单占线**:本 tick 通过步 1 校验的 `spawnUnit` 意图,逐条在**当前**状态上 `runSpawn()`。
 *    在这里(而不是步 1)落子,是因为步 1 只判「这条意图单看是否合法」;同一玩家一 tick 下多单、
 *    资金要按处理序逐单消耗时,只有按当前状态重判才答得对。资金不足 / 产线忙 → `runSpawn()`
 *    返回 `null`,**压根没有变更被造出来**(静默丢弃,不扣款、不占队列)。
 * 2. **推进队列**:每个有订单的基地按数值 id 升序推进;归零且出兵格空 → 出兵 + 清空;
 *    被任意单位占据 → 挂起(语义见 `production.ts` 的 `productionChangesOf`)。
 *
 * 先下单再推进:本 tick 刚下的单也吃本 tick 的一次推进,于是「下单那一 tick 计入生产耗时」——
 * 一个 `spawnTicks = 2` 的兵在下单后第 2 个 tick 的 d) 里归零出兵(理由与用例见 `production.test.ts`)。
 *
 * ── 经济死亡为什么排在本步最后(四段之后) ──
 *
 * 它的形式定义吃的是「本 tick 结算完之后的玩家经济」:d) 会出兵(可能补回一个农民)与退款,
 * 若把判定提到 d) 之前,一个刚把工人产出来的玩家会在同一 tick 被错报成「无农民」。
 * 这与首触「判在移动之后」同源:判据问的是结算之后的事实,不是结算之前的。
 *
 * ── 占领进度的家在哪(gdd §8 记录 #14)──
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
 * `economy-dead` 也是步 4 的事件,**判据归票 07(即本票)**:形式判据在
 * `processor/economy.ts` 的 `isEconomyDead`,在 b/c/d 全部落定之后按座位 0..3 升序判,
 * 每席**每局至多一条**——闩是 `state.economyDeadAtTick`(与首触的 `firstContactTick` 同性质),
 * 重复成立不再发。生产本身(下单 / 推进 / 出兵 / 退款)与采集/交付**都不发事件**——
 * 八种事件里没有对应的那一种。
 */

import { apply } from "../../driver/apply.js";
import { captureChangeOf, isCapture } from "../capture.js";
import {
  harvestChangeOf,
  isEconomyDead,
  isHarvestIntent,
  isTransferIntent,
  transferChangeOf,
} from "../economy.js";
import { cancelOnCaptureOf, isSpawnIntent, productionChangesOf, runSpawn } from "../production.js";
import type { PlayerIndex } from "../../world/state.js";
import type { Step } from "../context.js";

/** 四个座位,下标即座位号(hld §2.3)。经济死亡按它升序判,事件主体序因此是确定的。 */
const SEATS: readonly PlayerIndex[] = [0, 1, 2, 3];

export const step4ObjectTick: Step = (context) => {
  const { ruleset, collector } = context;
  // 遍历 **tick 开始时的**点位表:每个点位本 tick 只被看一次,结果互不牵连(占领读的是单位占位与
  // 点位自己的轨道,见 `capture.ts`)。`state.sites` 由状态不变量保证升序,这里不重排。
  const sites = context.state.sites;
  let state = context.state;

  // a) 占领,以及易主那一刻的接缝:队列取消 + 全额退款给原主。
  for (const site of sites) {
    const change = captureChangeOf(site, state.units, ruleset);
    if (change === null) {
      // 保留不动:无人站立,或驱动者与属主同阵营。什么都不写。
      continue;
    }
    state = apply(state, ruleset.raw, change);
    if (!isCapture(change)) {
      continue;
    }
    collector.siteCaptured(site.id);
    // 接缝:原主从变更单上来的 `previousOwner` 读(显式,不靠「易主前的状态还能读到」)。
    // 订单从步首快照里那个点位对象读——`state` 已被本步 a) 换过,但那一次 apply 只改属主与进度,
    // 不改 `producing`;用步首对象更直白:它就是易主前的订单。
    const cancel = cancelOnCaptureOf(site, change.previousOwner, ruleset);
    if (cancel !== null) {
      state = apply(state, ruleset.raw, cancel);
    }
  }

  // b) 采集。`context.intents` 已按 `(seat, 对象数值 id)` 升序(见 `processor/intents.ts`),
  // 所以段内序列确定。逐条在**当前**状态上重判:同 tick 前一个采集者把矿采空之后,
  // 后一个采集者读到的 `remaining` 是更新过的,不会超采。无效意图 → `null` → 没有变更被造出来
  // (静默丢弃,不发事件、不计异常)。
  for (const { seat, intent } of context.intents) {
    if (!isHarvestIntent(intent)) {
      continue;
    }
    const change = harvestChangeOf(state, seat, ruleset, intent);
    if (change !== null) {
      state = apply(state, ruleset.raw, change);
    }
  }

  // c) 交付。与 b) 同序规则;必须在 d) 之前——交付加的是玩家池,d) 下单花的也是玩家池。
  for (const { seat, intent } of context.intents) {
    if (!isTransferIntent(intent)) {
      continue;
    }
    const change = transferChangeOf(state, seat, ruleset, intent);
    if (change !== null) {
      state = apply(state, ruleset.raw, change);
    }
  }

  // d) 生产。先落本 tick 的 spawnUnit 意图(下单占线),再推进所有队列(含刚下的单)。
  for (const { seat, intent } of context.intents) {
    if (!isSpawnIntent(intent)) {
      continue;
    }
    // 在当前状态上重判:资金按处理序逐单消耗、易主后的基地不再接受原主下单,都靠这一步。
    const change = runSpawn(state, seat, ruleset, intent);
    if (change !== null) {
      state = apply(state, ruleset.raw, change);
    }
  }
  for (const site of state.sites) {
    for (const change of productionChangesOf(site, state.units)) {
      state = apply(state, ruleset.raw, change);
    }
  }

  // 经济死亡:在 b/c/d 全部落定之后按座位升序判(理由见头注),每席**每局至多一条**。
  // 闩读的是 `economyDeadAtTick`——它记的是「这条事件发过了」,判据本身不读它(见 economy.ts)。
  for (const seat of SEATS) {
    if (state.economyDeadAtTick[seat] !== null) {
      continue;
    }
    if (!isEconomyDead(state, seat, ruleset)) {
      continue;
    }
    collector.economyDead(seat);
    state = apply(state, ruleset.raw, { kind: "mark-economy-dead", seat, tick: state.tick });
  }

  return { ...context, state };
};
