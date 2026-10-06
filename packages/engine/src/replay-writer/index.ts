/**
 * 回放写出路径的对外聚合面。
 *
 * 收窄到**行组装 + 一个 sink 类型**:`processTick`(结算管线)与 `runMatch`(外部缝)都从这里取,
 * 而 meta / tick 两行的形状归真源包(02b 那一格)。
 */

export { buildMetaLine, serializeMetaLine } from "./meta-line.js";
export type { MetaHead, SandboxReadings } from "./meta-line.js";
export { buildTickLine, serializeTickLine, tickLinePayload } from "./tick-line.js";
export type { TickLine, TickPayload } from "./tick-line.js";
export type { TickSink } from "./sink.js";
