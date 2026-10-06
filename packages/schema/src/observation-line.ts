/**
 * 观测行:回放**之外**那份 `observations.jsonl` 的一行(hld §5.3 / §7.5)。
 * **类型与 JSON Schema 同文件、同一次书写**,纪律与 `map.ts` / `replay-line.ts` 一致
 * (ADR-0003:TypeScript 是真源,JSON Schema 手工对齐)。
 *
 * ── 为什么它单独一个文件、单独一种行 ──
 *
 * 墙钟软限与内存压力这两类**只在观测层披露、不参与判罚**的读数必须有家,而回放线的纯度是
 * 「它就是回放」:`verify` 会逐 tick 比它,墙钟受机器负载影响、不可复算,混进去等于让回放
 * 跨机器不一致(hld §4.6:事件流与状态共同构成这一 tick 的事实,故都进 `stateHash`)。
 * 所以它们进一个与回放**同级但独立**的文件,格式在此定死。
 *
 * ── 为什么栏就这五样 ──
 *
 * `tick` / `seat` / `kind` / `value` / `limit` 各自回答一句话:「什么时候、谁的、哪一类、
 * 读到多少、当时那条轨的上限是多少」。「每玩家每类只记首条」由写出侧去重(文件因此有界),
 * 而不是由形状承担——将来要计数是**加栏**,不是改形(spec《观测通道》)。
 *
 * `track`(轨名)刻意**不进**这一行:两个 `kind` 各自唯一对应一条轨
 * (`wall-clock-soft` → `wallClockSoftLimit`、`memory-pressure` → `memoryTickCeiling`),
 * 再写一栏就是同一个事实的第二个家。引擎侧的载荷仍带 `track`(那是执行器的原生词),
 * 由写出侧投影掉。
 *
 * ── `tripped` 为什么不在这里 ──
 *
 * 触限(`tripped`)是**判罚**事实,它落成一条状态变更(累加 `exceptionTicks`)并随 tick 行进
 * 回放,报告从状态里读它。本文件只收「只披露、不判罚」的两类。
 */

import type { ReplaySeat } from "./index.js";

/** 只披露、不判罚的两类观测。`tripped` 不进这个文件(它落成状态变更)。 */
export type ObservationLineKind = "wall-clock-soft" | "memory-pressure";

/**
 * 一行观测。`type` 是行判别式(与回放三类行同一种做法):这份文件将来若收第二种行,
 * 读入端按它分派,而不必靠「看它像不像」。
 */
export type ObservationLine = {
  readonly type: "observation";
  /** 发生这条观测的那一 tick(与同 tick 的回放行 `tick` 栏同号)。 */
  readonly tick: number;
  /** 发生这条观测的座位(0..3)。 */
  readonly seat: ReplaySeat;
  readonly kind: ObservationLineKind;
  /** 观测量读数:墙钟是毫秒、内存是字节(存活堆口径)。 */
  readonly value: number;
  /** 当时那条轨的上限:墙钟软限是软限、内存是软阈(判罚线的推导项)。 */
  readonly limit: number;
};

/** 键序即 `required` 序、书写序,不容另定一处。 */
const OBSERVATION_LINE_REQUIRED_KEYS = ["type", "tick", "seat", "kind", "value", "limit"] as const;

/**
 * 观测行的 JSON Schema。六栏全必填,`additionalProperties: false`。
 *
 * `value` 与 `limit` 都收成非负整数:墙钟读数在写出侧由 `Math.floor` 落成整数毫秒
 * (观测不参与判罚,取整不改变任何结论),内存读数本来就是整数字节。
 */
export const OBSERVATION_LINE_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "model-war 观测行",
  description:
    "回放之外那份 observations.jsonl 的一行(hld §5.3):只披露、不判罚的两类观测。" +
    "每玩家每类只记首条(写出侧去重),文件因此有界。",
  type: "object",
  additionalProperties: false,
  required: OBSERVATION_LINE_REQUIRED_KEYS,
  properties: {
    type: { enum: ["observation"] },
    tick: { type: "integer", minimum: 0, description: "发生这条观测的 tick。" },
    seat: { enum: [0, 1, 2, 3], description: "发生这条观测的座位号。" },
    kind: {
      enum: ["wall-clock-soft", "memory-pressure"],
      description: "只披露、不判罚的两类观测之一。",
    },
    value: { type: "integer", minimum: 0, description: "观测量读数:墙钟毫秒 / 内存字节。" },
    limit: { type: "integer", minimum: 0, description: "当时那条轨的上限值。" },
  },
} as const;
