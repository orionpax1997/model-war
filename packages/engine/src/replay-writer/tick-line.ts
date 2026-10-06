/**
 * tick 行:hld §7.5 的「第 n 行」。**载荷是整行去掉 `stateHash` 自身**(hld §4.6)。
 *
 * ── 为什么载荷是「整行去掉自身」而不是一份字段清单 ──
 *
 * 字段清单的代价是**它自己会漂移**:给 tick 行加一栏(比如某张机制票要给点位补一栏进度),
 * 忘了同步清单,那一栏就静默不进哈希——而回放行里明明写着它。于是「哪些字段进哈希」变成一份
 * 没人复核的第二份清单,漂了也没有任何一处会红。把载荷定义成「整行去掉 `stateHash`」之后,
 * **行内容的自摘要**这件事是结构性的:加一栏就自动进哈希,想让它不进哈希反而要专门写代码。
 *
 * ── 为什么 `nextId` 与 `outcome` 不在行里 ──
 *
 * 它们不进**行**,所以也不进**载荷**:载荷是行减去自身。`nextId` 是 id 分配器的内部状态
 * (它是「下一个号」,不是本 tick 的任何一个对象),`outcome` 是**终局**结果,归末行 `result`。
 * 让它们进 tick 行,等于让每一行都带一个「这局还没结束」的标记,渲染器与战报都得先判它。
 *
 * ── 为什么 `events` 进哈希 ──
 *
 * 战报只消费 `events`,不重新解析状态(事件流是「叙事战报的统一来源」)。于是事件序列与状态
 * 共同构成这一 tick 的事实;两者不同序或不同内容,回放就该算出不同的哈希。
 *
 * 形状的家在 `packages/schema` 的 `replay-line.ts`(02b),见 `meta-line.ts` 文件头同一条纪律。
 */

import { stateHashOf, type ReplayTickLine, type ReplayTickPayload } from "@model-war/replay";
import type { Event } from "../processor/events.js";
import type { GameState } from "../world/state.js";

/**
 * tick 行的载荷 = 行内容的自摘要。**加一栏只需把它写进真源包那份形状**,它自动进哈希。
 *
 * 它是真源包那份形状的**别名**,不是第二次声明:一条 `= ReplayTickPayload` 就把两份读法绑成
 * 同一个事实。曾经这里逐栏重列过一份本地类型,那在形状落库之后就是同一份栏位清单的第二次书写,
 * 而两次书写里总有一次不更新——加一栏只改一处、另一处静默旧着,正是本仓明令要避的那种漂移。
 *
 * 引擎状态(`GameState` 里的 `Player` / `Unit` / `Site` 与 `Event`)到这几份跨进程形状的
 * **可赋值性**由 `buildTickLine` 的返回值与 `replay-line.test.ts` 的双向断言当场盯着:
 * 两边一旦岔开就是编译期红,而不是等到读盘端把一栏读成 `undefined`。
 */
export type TickPayload = ReplayTickPayload;

/** tick 行的组装面 = 真源包那一份。`stateHash` 是**最后一栏**,因为它是「前头所有栏的摘要」这件事的字面顺序。 */
export type TickLine = ReplayTickLine;

const TICK_LINE_TYPE = "tick";

/**
 * 取一行 tick 的**载荷**:整行去掉 `stateHash` 自身。
 *
 * ── 为什么逐栏重列不是那份「会漂移的清单」 ──
 *
 * 会漂移的清单是 `stateHashOf({ players, units, sites })` 这种**手挑子集**:加一栏时忘了同步,
 * 回放行里明明写着它、哈希却没算它,而**没有任何一处会红**。
 * 这里不同:返回值类型是 `TickPayload`,于是加一栏会**编译不过**,直到有人把它补进来。
 * 「逐栏重列」在这里不是纪律,是**由类型兜住的那一半**。
 *
 * 导出是因为这条规则**必须只有一处实现**:写出侧算哈希用它,测试断言「哈希就是载荷的摘要」也用它。
 */
export const tickLinePayload = (line: TickLine): TickPayload => {
  const { type, tick, players, units, sites, events } = line;
  return { type, tick, players, units, sites, events };
};

/** 载荷:行内容的自摘要。加一栏只需写进这里,它自动进哈希。 */
const tickPayload = (state: GameState, events: readonly Event[]): TickPayload => ({
  type: TICK_LINE_TYPE,
  tick: state.tick,
  players: state.players,
  units: state.units,
  sites: state.sites,
  events,
});

/** 拼一行 tick。`state.units` / `state.sites` 的 id 升序**由状态不变量**保证(hld §4.1),这里不重排。 */
export const buildTickLine = (state: GameState, events: readonly Event[]): TickLine => {
  const payload = tickPayload(state, events);
  return { ...payload, stateHash: stateHashOf(payload) };
};

export const serializeTickLine = (line: TickLine): string => JSON.stringify(line);
