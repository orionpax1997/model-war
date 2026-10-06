/**
 * 结算管线的**上下文**:一步与一步之间传的东西只有这一份。
 *
 * ── 为什么一步是一个 `TickContext → TickContext` 的纯函数 ──
 *
 * 顺序即规范(hld §4.3):八步的次序本身**就是规则**,所以它必须是一件**可以被单独断言**的事。
 * 若一步直接改一个可变的环境对象,「第七步在第六步前面跑会怎样」只能靠整体行为去观察;
 * 而纯函数让每一步的输入输出是值,顺序断言就是断言 `STEPS` 那张表本身。
 *
 * 上下文的**只读部分**(规则集、执行器、收集器、sink)在一整条管线上不变,`state` / `intents`
 * 这两栏被各步换掉。把它做成一个整体替换而不是逐栏可变,是为了让「这一步改了状态」在类型上
 * 看得见——没有可变的 `state` 引用可以被某一步偷偷改掉。
 *
 * ── 为什么收集器挂在上下文里而不是每步各建一个 ──
 *
 * 定序规则写在 `events.ts` 的头注里,那**一份**规则要对整条管线生效。收集器是那条规则的载体,
 * 每步各建一个等于定序规则各自为政,最后一步交出的那一份就成了唯一真相。
 */

import type { RulesetView } from "../ruleset-loader/index.js";
import type { SeatRunner } from "../runner/index.js";
import type { TickSink } from "../replay-writer/index.js";
import type { DrainedIntents, IssuedIntent } from "./intents.js";
import type { EventCollector } from "./events.js";
import type { GameState } from "../world/state.js";

/** 一个 tick 的输入与中间量。`state` 走完八步之后就是下一 tick 的输入。 */
export type TickContext = {
  readonly ruleset: RulesetView;
  /** 四个座位的执行器,下标即 `playerIndex`——**座位序是数组序**,不另有一张映射表。 */
  readonly runners: readonly SeatRunner[];
  /** 输出 sink。步 6 往它写一行;不写盘(hld §2.2.8)。 */
  readonly sink: TickSink;
  /** 事件收集器,整条管线共用一个。 */
  readonly collector: EventCollector;
  /** 步 0 之后:各座位交回的 intents,按 `playerIndex 0..3` 串行排列。 */
  readonly drained: readonly DrainedIntents[];
  /** 步 1 之后:分组、定序并**带上座位**的 intent(校验的落点;本票只留移动两条)。 */
  readonly intents: readonly IssuedIntent[];
  readonly state: GameState;
  /**
   * 寻路调用量,下标即座位(票 04)。
   *
   * 这是给预算层的**账**,不是罚:hld §4.7 要求寻路计入脚本 API 调用预算,而本层不实现预算判罚
   * (§5.3:判据锚定 host 侧可测量量,预算层落地时把它并进 `apiCallTickLimit` 的记账)。
   * 挂在上下文里而不是步 2 的局部量里,是因为 `TickResult` 要把它交给测试与将来的预算层。
   */
  readonly pathfindingCalls: readonly number[];
};

/** 一步。纯函数:换一份上下文,不碰别处。 */
export type Step = (context: TickContext) => TickContext;

/** 步 0 之前的上下文:`drained` / `intents` 两个派生栏还没有内容。 */
export const initialContext = (
  ruleset: RulesetView,
  runners: readonly SeatRunner[],
  sink: TickSink,
  collector: EventCollector,
  state: GameState,
): TickContext => ({
  ruleset,
  runners,
  sink,
  collector,
  drained: [],
  intents: [],
  pathfindingCalls: [0, 0, 0, 0],
  state,
});
