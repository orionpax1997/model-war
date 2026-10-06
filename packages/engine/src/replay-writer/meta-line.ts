/**
 * 回放写出:meta 行的**取值组装**(hld §7.5 的回放 JSONL 第 1 行)。
 *
 * ── 本包不做磁盘 I/O ──
 *
 * 写出走**注入的输出 sink**。hld §2.2.8 把磁盘 I/O 排除在 engine 之外,而回放文件的大小、
 * 写到哪、要不要压缩都是上层(`runMatch` 的调用方)的事;把它压进一个回调,本包就仍然只有一行字符串。
 * 于是测试能断言「写出了什么」,而不必先造一个目录。
 *
 * ── 「行的形状」与「行的取值」是两份东西 ──
 *
 * 形状(键名、键序、类型、JSON Schema)归真源包 `packages/schema` 的 `replay-line.ts` 所有
 * (hld §7.5,ADR-0003),本文件**只声明返回值的类型**、不重声明形状。所以下面没有第二个 `MetaLine`:
 * 那样的类型在形状落库之后就是同一份栏位清单的第二次书写,而两次书写里总有一次不更新。
 */

import {
  CURRENT_SCHEMA_VERSION,
  RULESET_VERSION,
  type ReplayMetaLine,
  type ReplayPlayerRef,
} from "@model-war/replay";

export type { TickSink } from "./sink.js";

/** 真沙箱那四栏的读数。四栏之间没有派生关系,所以是一个平铺的对象而不是四个位置参数。 */
export type SandboxReadings = {
  readonly quickjsWasiVersion: string;
  readonly sandboxRuntimeHash: string;
  readonly wasiClock: string;
  readonly wasiRandomFill: string;
};

/**
 * meta 行里**由装载方知道**的那几栏。判别在 `runner` 上:桩执行器那一支**没有**沙箱读数可填。
 *
 * 写成判别联合而不是「四个可空栏由调用方决定填不填」,是为了让「桩跑的局没有 QuickJS 版本」
 * 这件事成为**类型上无法表达错**的事实,而不是一条靠自觉的纪律——调用方在 `runner: "stub"`
 * 那一支上就算想填也**没有栏可填**。
 *
 * `seed` **不在**这里:它是 `runMatch` 的入参(复算的锚),由 `runMatch` 注入 meta 行——
 * 种子有**一个家**(对局输入),而 meta 行是它的投影,不是它第二个可以任填的地方。
 * `players` 同理:四方参赛者由 `runMatch` 从四个座位装配,它手里本来就是那四份存档的引用。
 */
export type MetaHead = {
  readonly timezoneOffset: string;
  readonly mapHash: string;
} & ({ readonly runner: "stub" } | ({ readonly runner: "quickjs" } & SandboxReadings));

/**
 * 拼 meta 行。**十二栏**,`runner` 是第 12 栏(hld §7.5 的十栏 + 递增的第 12 栏),
 * 键序即写入顺序——它由下面这个对象的字面书写序承担,`meta-line.test.ts` 逐字钉住。
 *
 * 四个沙箱栏的 `null` **由本函数按 `runner` 决定**,不由调用方填:桩执行器压根没启动过 WASI,
 * 「没测过」与「测出来是空串」在报告里必须分得开,所以未发生一律 `null`,不写 `""`、不写 `0`。
 */
export const buildMetaLine = (
  head: MetaHead,
  seed: number,
  players: readonly ReplayPlayerRef[],
): ReplayMetaLine =>
  // 键序逐字写出(而不是靠展开或联合分支的位置决定):它就是写入顺序本身,
  // 而展开出来的顺序由书写位置决定,改一行 import 就可能悄悄换序。
  head.runner === "stub"
    ? {
        type: "meta",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        ruleset: RULESET_VERSION,
        quickjsWasiVersion: null,
        sandboxRuntimeHash: null,
        wasiClock: null,
        wasiRandomFill: null,
        timezoneOffset: head.timezoneOffset,
        mapHash: head.mapHash,
        seed,
        players,
        runner: "stub",
      }
    : {
        type: "meta",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        ruleset: RULESET_VERSION,
        quickjsWasiVersion: head.quickjsWasiVersion,
        sandboxRuntimeHash: head.sandboxRuntimeHash,
        wasiClock: head.wasiClock,
        wasiRandomFill: head.wasiRandomFill,
        timezoneOffset: head.timezoneOffset,
        mapHash: head.mapHash,
        seed,
        players,
        runner: "quickjs",
      };

/** meta 行是一次性的:它在第一个 tick 之前落,`buildMetaLine` 产一次、`serialize` 一次。 */
export const serializeMetaLine = (line: ReplayMetaLine): string => JSON.stringify(line);
