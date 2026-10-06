/**
 * 步 0 · dispatch:构建四方只读快照 → 按 `playerIndex 0..3` 串行执行各执行器的 `loop()`、收集 intents。
 *
 * ── 为什么这一层做预算与异常裁决 ──
 *
 * 因为这是**唯一**一个「策略被执行的时刻」:预算软警告、异常计数、席位暂停调用都发生在这里,
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
 * 收集器在这一层已经是可用的——`exception` / `budgetSoftWarning` 两个具名方法挂在步 0 上,
 * 它们在那两票落地时不需要改定序规则,只需要有人调它们。
 *
 * ── 观测 → 变更这条路径的接通(票 02)──
 *
 * 执行器的返回载荷现在带观测。本层在它上面**不做裁决**:种类为 `tripped` 的观测转成一条
 * `count-exception-tick` 变更(累加该座位的 `exceptionTicks`),另外两类原样转发给观测出口
 * (缺席即静默丢弃)。阈值判定与淘汰归后续票;本层只负责把「观测 → 唯一写入口」接通。
 *
 * ── 淘汰方不再被调用(票 09)──
 *
 * 淘汰方这一 tick 交回空数组、`loop()` 不被执行;但它的单位、资源仍随快照写进后续 tick 的
 * 回放行(hld §4.3 步 5 第四条「状态保留以便重放取证」)。跳过发生在**调用点**而不是执行器里:
 * 沙箱执行器不需要知道「谁出局了」,那是引擎状态的事。
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
  const drained: DrainedIntents[] = SEATS.map((seat) => {
    const player = state.players[seat];
    // hld §4.3 步 5 第四条:淘汰方的 `loop()` 不再执行,但状态保留以便重放取证。
    // 跳过时交**空数组**而不是不交条目——`DrainedIntents[]` 的四项对齐是这一层的不变量,
    // 「这一 tick 什么都不做」本来就有一个合法表示(空数组),不必另造一个缺席。
    if (player !== undefined && !player.alive) {
      return { seat, intents: [] };
    }
    const runner = runnerOf(context, seat);
    runner.setSnapshot(snapshot);
    const output = runner.drainIntents();
    // 观测在缝上**不做裁决**:`tripped` 落成一条 `count-exception-tick` 变更(唯一写入口),
    // 另外两类原样转发给观测出口。阈值判定与淘汰归后续票。
    let tripped = 0;
    for (const observation of output.observations) {
      if (observation.kind === "tripped") {
        tripped += 1;
      } else {
        context.observations?.record(observation);
      }
    }
    if (tripped > 0) {
      state = apply(state, context.ruleset.raw, {
        kind: "count-exception-tick",
        seat,
        count: tripped,
      });
    }
    return { seat, intents: output.intents };
  });
  return { ...context, state, drained };
};
