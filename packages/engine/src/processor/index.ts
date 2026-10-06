/**
 * 结算管线(hld §4.3 的 0–7 步):`processTick` 是**处理器自己的私有内部缝**。
 *
 * ── 它不进 `packages/engine/src/index.ts` 的导出面 ──
 * 外部缝**唯一**是 `runMatch`(02b 落)。`processTick` 只给处理器自己的测试当构造器:
 * 测试要造一个「某个状态 + 某批 intents」的 tick,若走 `runMatch` 就得先造四份冻结脚本存档、
 * 一个沙箱和一个回放 sink,于是「这一步到底改了什么」这件事没法被断言。
 * 把两处合成一处,调用方要学的东西少于它拿到的能力(hld《模块的深度》)。
 *
 * ── 测试侧参赛策略的写法约束(ADR-0005) ──
 * 测试里的参赛脚本是**普通 TS 函数**,经 `stubRunner` 接进这个缝:不经字符串、不经 VM。
 * 所以本模块的调用点里**不出现任何脚本文本**——出现的那一刻,测试就在验一条生产不走的路。
 *
 * ── **顺序即规范** ──
 * 八步的次序是规则(hld §4.3 原文:「任何顺序调整都是规则变更」),所以它落成
 * **`STEPS` 这一张表**,而不是八个写死的调用。`step-order.test.ts` 断言的正是这张表的序,
 * 以及「把第七步提到第六步前面」会红。表是 `as const` 的元组:步号(`0..7`)的排布
 * 由**下标**承担,而不是由名字里的数字承担——名字里的数字会被人手改,下标不会。
 */

import { createEventCollector, type Event } from "./events.js";
import { initialContext, type Step, type TickContext } from "./context.js";
import type { IssuedIntent } from "./intents.js";
import type { TickSink } from "../replay-writer/index.js";
import type { RulesetView } from "../ruleset-loader/index.js";
import type { SeatRunner } from "../runner/index.js";
import type { GameState } from "../world/state.js";
import { step0Dispatch } from "./steps/step0-dispatch.js";
import { step1Validate } from "./steps/step1-validate.js";
import { step2Movement } from "./steps/step2-movement.js";
import { step3Combat } from "./steps/step3-combat.js";
import { step4ObjectTick } from "./steps/step4-object-tick.js";
import { step5Evaluate } from "./steps/step5-evaluate.js";
import { step6Emit } from "./steps/step6-emit.js";
import { step7LoopGuard } from "./steps/step7-loop-guard.js";

/**
 * 步 0–7。**下标即步号**,hld §4.3 的编号是这套下标的来源。
 *
 * 刻意不做「按名字找步」的注册表:那需要一个字符串到函数的映射,于是步号从「下标」
 * 变成「字符串里那两个字符」——而那正是最容易被人手挪一格的地方。
 */
export const STEPS = [
  step0Dispatch,
  step1Validate,
  step2Movement,
  step3Combat,
  step4ObjectTick,
  step5Evaluate,
  step6Emit,
  step7LoopGuard,
] as const satisfies readonly Step[];

/** 步数。八。hld §4.3 写的是 0–7。 */
export const STEP_COUNT = STEPS.length;

/** 一个 tick 结算完的结果。 */
export type TickResult = {
  /** 结算后的状态。步 6 已经 `tick++`,所以它就是下一 tick 的输入。 */
  readonly state: GameState;
  /** 事件流。由收集器定序后交出(hld §4.3 的定序规则,见 `processor/events.ts` 头注)。 */
  readonly events: readonly Event[];
  /** 步 1 之后的那批 intent(带上座位,移动两条才有内容)。交出来是给测试断言用的。 */
  readonly intents: readonly IssuedIntent[];
  /** 本 tick 按座位计的寻路调用量(票 04)。预算层的输入,本层不判罚。 */
  readonly pathfindingCalls: readonly number[];
  /** 步 7 的结论:`tick` 达 `tickLimit`。票 09 把它换成 `state.outcome`。 */
  readonly limitReached: boolean;
};

/**
 * 结算一个 tick。
 *
 * `runners` 按 `playerIndex 0..3` 对齐(下标即座位),`sink` 收步 6 写出的那一行。
 * 返回值是**新状态**:调用方拿着旧状态继续读不算错,但下一 tick 必须用返回值(hld §4.1)。
 */
export const processTick = (
  state: GameState,
  runners: readonly SeatRunner[],
  ruleset: RulesetView,
  sink: TickSink,
): TickResult => {
  const context = STEPS.reduce<TickContext>(
    (now, step) => step(now),
    initialContext(ruleset, runners, sink, createEventCollector(), state),
  );
  return {
    state: context.state,
    events: context.collector.events(),
    intents: context.intents,
    pathfindingCalls: context.pathfindingCalls,
    limitReached: context.limitReached,
  };
};
