/**
 * 步 6 · emit:写 JSONL 一行(完整可渲染状态 + 事件 + `stateHash`);`tick++`(hld §4.3)。
 *
 * ── 为什么写在 `tick++` **之前** ──
 * 写出的那一行记的是**刚结算完的这一 tick**,它的 `tick` 栏就是 `state.tick` 的当前值。
 * 先加再写,整份回放的所有行都会比它描述的那个 tick 大 1——而 `stateHash` 把 `tick` 算进载荷
 * (见 `replay-writer/tick-line.ts`),于是哈希自己就错了位,排查时看不出是「写早了」还是「算错了」。
 *
 * ── 为什么 `stateHash` 在写出这一步算,不在结算里算 ──
 * 哈希计算只在**写出路径**上(hld §4.6):它不参与任何裁决,所以它落在哪一步都不改变结果,
 * 而落在写出这一步能让「结算不读回放」这条依赖方向保持单向。
 */

import { buildTickLine, serializeTickLine } from "../../replay-writer/index.js";
import type { Step } from "../context.js";

export const step6Emit: Step = (context) => {
  context.sink.write(serializeTickLine(buildTickLine(context.state, context.collector.events())));
  return { ...context, state: { ...context.state, tick: context.state.tick + 1 } };
};
