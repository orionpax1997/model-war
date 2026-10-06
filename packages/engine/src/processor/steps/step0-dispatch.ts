/**
 * 步 0 · dispatch:构建四方只读快照 → 按 `playerIndex 0..3` 串行执行各执行器的 `loop()`、收集 intents。
 *
 * ── 为什么这一层做预算与异常裁决 ──
 *
 * 因为这是**唯一**一个「策略被执行的时刻」:异常计数、席位暂停调用都发生在这里,
 * 它们管的是「策略跑得跑得动」,而 1–7 那七步管的是「世界怎么变」。两件事混在一步里,
 * 「这个 tick 的异常是谁的」就要靠读控制流才答得出来。
 *
 * ── 为什么四个座位共用一份快照,而不是各拷一份 ──
 *
 * 见 `snapshot/snapshot.ts` 的取舍 3:快照本来就是只读的,隔离由**深拷贝**提供而不是由四份拷贝提供。
 * 多拷三份买不到任何隔离(改不动的是同一个被冻住的对象),只买得到四倍开销。
 *
 * ── 预算与异常为什么本票不发事件 ──
 *
 * 八种事件由 04–09 各自填进自己的槽位(hld §7.5)。**本票一条事件都不实现**,
 * 所以这一层现在只做「跑四个执行器、按座位收 intents」,裁决与暂停随对应的机制票落地。
 * 收集器在这一层已经是可用的——`exception` 那个具名方法挂在步 0 上,
 * 它在那张票落地时不需要改定序规则,只需要有人调它。
 *
 * ── 观测 → 变更这条路径的接通(票 02/07)──
 *
 * 执行器的返回载荷带观测。本层在它上面**不做裁决**:种类为 `tripped` 的观测转成 `count-exception-tick`
 * 变更(累加该座位的 `exceptionTicks`),另外两类原样转发给观测出口(缺席即静默丢弃)。
 * **一条 `tripped` 计一次**(按异常事件累加),变更带上该观测的轨名——同 tick 两条不同轨
 * 各计一次(见 `apply.ts` 那条变更的注释)。阈值判定(事件/API/内存)与淘汰不在本层:
 * 阈值判定在执行器侧(构造时就拿到阈值),淘汰在步 5 的既有淘汰变更上。本层只负责把
 * 「观测 → 唯一写入口」接通。
 *
 * ── 淘汰方不再被调用(票 09)──
 *
 * 淘汰方这一 tick 交回空数组、`loop()` 不被执行;但它的单位、资源仍随快照写进后续 tick 的
 * 回放行(hld §4.3 步 5 第四条「状态保留以便重放取证」)。跳过发生在**调用点**而不是执行器里:
 * 沙箱执行器不需要知道「谁出局了」,那是引擎状态的事。
 *
 * ── 硬超时:作废而非判罚(票 09)──
 *
 * 执行器交回一个故障位(`fault`)时,本层**立即停住**:故障座位交回空 intents,后面尚未执行的
 * 座位也不再跑,`context.fault` 置上后 `processTick` 的 reduce 短路(本 tick 不写回放行)。
 * 硬超时使整场作废、不参与判罚(spec《双重计数与墙钟》),所以它不能像 `tripped` 那样落成一条
 * 状态变更。
 *
 * **多座位同时故障的合并语义**:座位是**串行**执行的(hld §2.3),而故障一出现就短路,
 * 因此同一 tick 里至多一个座位交回故障。退一步说,将来若出现多种故障值,合并规则也已定死:
 * 取**座位序最靠前者**——串行序里最先发生的那个。今天只有一个常量值(`uncertain-timeout`),
 * 于是合并在类型上无歧义、在实现上就是这一个值。
 */

import { apply } from "../../driver/apply.js";
import { buildSnapshot } from "../../snapshot/snapshot.js";
import type { PlayerIndex } from "../../world/state.js";
import type { DrainedIntents } from "../intents.js";
import type { Step, TickContext } from "../context.js";

/** 座位下标。固定 0..3;它是**编号**不是参数,所以允许出现在本包里(hld §2.2.3 的浮点禁令与之无关)。 */
const SEATS: readonly PlayerIndex[] = [0, 1, 2, 3];

/** 执行器数组必须按座位下标对齐。少一个或多一个都在装载期事故那一侧,不该静默补一个空的。 */
const runnerOf = (context: TickContext, seat: PlayerIndex) => {
  const runner = context.runners[seat];
  if (runner === undefined) {
    throw new Error(
      `座位 ${String(seat)} 没有执行器:执行器数组必须按 playerIndex 0..3 对齐,长度 4`,
    );
  }
  return runner;
};

export const step0Dispatch: Step = (context) => {
  const snapshot = buildSnapshot(context.state);
  // 座位序 = 串行序。串行不是性能选择:四方**串行**执行是 hld §2.3 的规则,沙箱共享宿主状态时
  // 并行执行的结果不可复算,而这一层正是「四方依次拿到同一份只读快照」的那一层。
  let state = context.state;
  // 本层唯一的故障来源。一出现即短路:后面尚未执行的座位也不再跑(本 tick 作废)。
  let fault = context.fault;
  // 预置四格空交回:座位对齐是这一层的不变量,故障 / 淘汰的座位保留空数组(不另造缺席)。
  // 刻意用**下标赋值**而不是 `push`:事件流的唯一出口是收集器,步目录里任何 `.push(` 都会
  // 让「定序规则没有旁路」那条断言变红(`step-order.test.ts`)。
  const drained: DrainedIntents[] = SEATS.map((seat) => ({ seat, intents: [] }));
  for (const seat of SEATS) {
    const player = state.players[seat];
    // hld §4.3 步 5 第四条:淘汰方的 `loop()` 不再执行,但状态保留以便重放取证。
    // 跳过时保留预置的空数组——「这一 tick 什么都不做」本来就有一个合法表示。
    if (fault !== null || (player !== undefined && !player.alive)) {
      continue;
    }
    const runner = runnerOf(context, seat);
    runner.setSnapshot(snapshot);
    const output = runner.drainIntents();
    // 观测在缝上**不做裁决**:每条 `tripped` 落成一条 `count-exception-tick` 变更(唯一写入口)
    // 并带上轨名,另外两类原样转发给观测出口(tick 与座位在这一层补齐)。阈值判定与淘汰不在本层。
    for (const observation of output.observations) {
      if (observation.kind === "tripped") {
        state = apply(state, context.ruleset.raw, {
          kind: "count-exception-tick",
          seat,
          count: 1,
          track: observation.track,
        });
      } else {
        context.observations?.record({
          // 与同 tick 的回放行同号:步 6 写行用的也是未自增的 `state.tick`(见 `step6-emit.ts`)。
          tick: state.tick,
          seat,
          kind: observation.kind,
          track: observation.track,
          value: observation.value,
          limit: observation.limit,
        });
      }
    }
    if (output.fault !== undefined) {
      // 硬超时:交回空 intents(不把半截意图当事实),并在本层停住。不写状态、不判罚。
      fault = output.fault;
      continue;
    }
    drained[seat] = { seat, intents: output.intents };
  }
  return { ...context, state, drained, fault };
};
