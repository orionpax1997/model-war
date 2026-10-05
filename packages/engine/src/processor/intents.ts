/**
 * intent:hld §4.2 的判别联合,逐字照抄(hld 是这份形状的家)。
 *
 * ── 六个 intent 不构成缝 ──
 *
 * 每个 intent 各有**且只有一个**实现(`check()` 与 `run()` 同文件、同一条注册表条目),
 * 于是它们不是可替换的部件,而是一段固定流程的六个分支。把它们做成六个带公开接口的模块
 * 是六条浅缝:接口面积大、实现小,调用方要学的东西多于它拿到的能力。真正会变的东西只有执行器一处。
 *
 * 本模块**只声明形状**,不实现任何一个分支:裁决与执行随 04–09 落地。
 */

import type { PlayerIndex, UnitType } from "../world/state.js";

export type Intent =
  | {
      readonly kind: "move";
      readonly unitId: number;
      readonly dx: -1 | 0 | 1;
      readonly dy: -1 | 0 | 1;
    }
  | { readonly kind: "moveTo"; readonly unitId: number; readonly x: number; readonly y: number }
  | { readonly kind: "attack"; readonly unitId: number; readonly targetId: number }
  | { readonly kind: "harvest"; readonly unitId: number; readonly siteId: number }
  | { readonly kind: "transfer"; readonly unitId: number }
  | { readonly kind: "spawnUnit"; readonly baseId: number; readonly unitType: UnitType };

/** 一个座位这一 tick 交回来的 intent。座位号不在 intent 身上,而是执行器那一侧的绑定。 */
export type DrainedIntents = {
  readonly seat: PlayerIndex;
  readonly intents: readonly Intent[];
};

/**
 * 单位级 intent:每单位至多一条,按单位分组。`spawnUnit` 是玩家级,不在其中。
 *
 * 这一栏也是「本 seat 交回来的这一批」的唯一分组依据,所以它必须**收窄判别式**再取 id:
 * `unitId` 在 `spawnUnit` 上不存在,靠一个返回 `number | null` 的辅助函数拿它等于把收窄
 * 重新藏进一个函数里,判别式在那一行就失效了。
 */
const orderOf = (intent: Intent): number =>
  intent.kind === "spawnUnit" ? intent.baseId : intent.unitId;

/**
 * hld §4.3 第 1 步的前半:intent 先按单位分组、每单位只留最后一个(静默丢弃、不计异常),
 * 分组后按 `playerIndex 0..3` 再按对象数值 id 升序。
 *
 * ── 为什么座位序是第一排序键,而不是「单位级整段在前」 ──
 *
 * hld §4.3 的那行字是「按 `playerIndex 0..3` 再按 unitId 升序逐条校验」:**座位是第一键,
 * 对象数值 id 是第二键**,单位级与玩家级混在**同一个序列**里排。
 * 排成「单位级一段、玩家级一段」是一个看上去更整齐、实则破坏座位序的写法:它让座位 3 的
 * `spawnUnit` 排在座位 0 的 `move` 之后,于是**按这个序施加预算/异常裁决时**,先到的是低座位里
 * 单位级那一段,后到的才是高座位里玩家级那一段——**同一座位内部的相对序对了,跨座位的相对序错了**。
 * 而「谁先谁后」在 04–09 会真的落到预算与异常配额上(高座位能先花光预算),这就不是排序洁癖而是对局偏差。
 * 故此处**一次排序**把两类 intent 一起排掉,排序键只有 `seat` 与 `orderOf` 两级。
 *
 * **静默丢弃**是规则的一部分(gdd/hld §4.2「不视为异常,不占用异常配额」),所以这里没有事件、
 * 也没有诊断输出:一个单位连下三条 move,前两条消失得像没发生过。
 *
 * 为什么分组要先于校验:一个单位本 tick 至多一条意图是**结算层的形状**,不是脚本的写法约束。
 * 先分组再校验,「留哪一个」的答案才与「哪一个有效」无关——否则一条非法意图会挤掉一条合法意图,
 * 而丢弃的原因会变得不可预测。
 *
 * `spawnUnit` 是玩家级:同一玩家对多个基地各下一单是合法的,它们之间不互相顶替,
 * 排序按 `baseId` 升序(与全局的「按对象数值 id 升序」同一条定序语义)。
 */
/** 排序键:先座位(`playerIndex` 0..3 串行),再对象数值 id 升序。 */
type KeyedIntent = {
  readonly seat: PlayerIndex;
  readonly intent: Intent;
};

const bySeatThenId = (left: KeyedIntent, right: KeyedIntent): number =>
  left.seat - right.seat || orderOf(left.intent) - orderOf(right.intent);

export const groupIntents = (drained: readonly DrainedIntents[]): readonly Intent[] => {
  // 键带上座位:「按单位分组」是**每座位各自**分组(hld §4.3 第 1 步按 playerIndex 0..3 串行),
  // 即使单位 id 全局唯一,也不让两席位的同号单位互相顶替。
  const keptPerUnit = new Map<string, KeyedIntent>();
  const playerLevel: KeyedIntent[] = [];
  for (const { seat, intents } of drained) {
    for (const intent of intents) {
      if (intent.kind === "spawnUnit") {
        playerLevel.push({ seat, intent });
      } else {
        // 后写的覆盖先写的:「取该单位最后一个」。静默丢弃,没有事件也没有诊断。
        keptPerUnit.set(`${String(seat)}:${String(intent.unitId)}`, { seat, intent });
      }
    }
  }
  // 一次排序把两类 intent 一起排掉,而不是各自排完再前后拼接(理由见头注)。
  return [...keptPerUnit.values(), ...playerLevel].sort(bySeatThenId).map(({ intent }) => intent);
};
