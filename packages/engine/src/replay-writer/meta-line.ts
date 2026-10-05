/**
 * 回放写出:meta 行与 tick 行的**取值组装**(hld §7.5 的回放 JSONL)。
 *
 * ── 本包不做磁盘 I/O ──
 *
 * 写出走**注入的输出 sink**。hld §2.2.8 把磁盘 I/O 排除在 engine 之外,而回放文件的大小、
 * 写到哪、要不要压缩都是上层(02b 那一格)的事;把它压进一个回调,本包就仍然只有一行字符串。
 * 于是测试能断言「写出了什么」,而不必先造一个目录。
 *
 * ── 「行的形状」与「行的取值」是两份东西 ──
 *
 * 形状(键名、类型、JSON Schema)归真源包 `packages/schema` 所有(hld §7.5,ADR-0003),那一格是
 * 02b。本模块只负责**取值的组装**:哪几栏、哪几栏在桩执行器下必须是 `null`、哪几栏进哈希。
 * 所以下面那两个 `*Line` 类型都带一句「组装面」的头注,并在 02b 落库后删掉——
 * 它们不是行的类型的第二个家,它们是一次调用的返回值。
 */

import { CURRENT_SCHEMA_VERSION, RULESET_VERSION, type RulesetVersion } from "@model-war/replay";
import type { RunnerKind } from "../runner/index.js";
import type { PlayerIndex } from "../world/state.js";

export type { TickSink } from "./sink.js";

/** 一个座位在 meta 行里的三栏。`archiveRef` 是冻结脚本存档的引用(指向 `archive/<modelSlug>/<runId>/`)。 */
export type ReplayPlayerRef = {
  readonly model: string;
  readonly archiveRef: string;
  readonly seat: PlayerIndex;
};

/** 真沙箱那四栏的读数。四栏之间没有派生关系,所以是一个平铺的对象而不是四个位置参数。 */
export type SandboxReadings = {
  readonly quickjsWasiVersion: string;
  readonly sandboxRuntimeHash: string;
  readonly wasiClock: string;
  readonly wasiRandomFill: string;
};

/**
 * meta 行的入参。**判别在 `runner` 上**:桩执行器那一支**没有**沙箱读数可填。
 *
 * 写成判别联合而不是「四个可空栏由调用方决定填不填」,是为了让「桩跑的局没有 QuickJS 版本」
 * 这件事成为**类型上无法表达错**的事实,而不是一条靠自觉的纪律——调用方在 `runner: "stub"`
 * 那一支上就算想填也**没有栏可填**。
 */
export type MetaInput = {
  readonly timezoneOffset: string;
  readonly mapHash: string;
  readonly seed: number;
  readonly players: readonly ReplayPlayerRef[];
} & ({ readonly runner: "stub" } | ({ readonly runner: "quickjs" } & SandboxReadings));

/**
 * meta 行的组装面。**十二栏**,`runner` 是第 12 栏(hld §7.5 的十栏 + 递增的第 12 栏)。
 *
 * 形状的家在 `packages/schema`(02b);见文件头「形状与取值是两份东西」。
 */
export type MetaLine = {
  readonly type: "meta";
  readonly schemaVersion: number;
  readonly ruleset: RulesetVersion;
  /** 四个沙箱栏在桩执行器下恒为 `null`——「未发生」与「恰好是空串」要能区分。 */
  readonly quickjsWasiVersion: string | null;
  readonly sandboxRuntimeHash: string | null;
  readonly wasiClock: string | null;
  readonly wasiRandomFill: string | null;
  readonly timezoneOffset: string;
  readonly mapHash: string;
  readonly seed: number;
  readonly players: readonly ReplayPlayerRef[];
  readonly runner: RunnerKind;
};

/**
 * 拼 meta 行。
 *
 * 四个沙箱栏的 `null` **由本函数按 `runner` 决定**,不由调用方填:桩执行器压根没启动过 WASI,
 * 「没测过」与「测出来是空串」在报告里必须分得开,所以未发生一律 `null`,不写 `""`、不写 `0`。
 */
export const buildMetaLine = (input: MetaInput): MetaLine => {
  const sandbox: SandboxReadings | null = input.runner === "quickjs" ? input : null;
  return {
    type: "meta",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ruleset: RULESET_VERSION,
    quickjsWasiVersion: sandbox?.quickjsWasiVersion ?? null,
    sandboxRuntimeHash: sandbox?.sandboxRuntimeHash ?? null,
    wasiClock: sandbox?.wasiClock ?? null,
    wasiRandomFill: sandbox?.wasiRandomFill ?? null,
    timezoneOffset: input.timezoneOffset,
    mapHash: input.mapHash,
    seed: input.seed,
    players: input.players,
    runner: input.runner,
  };
};

/** meta 行是一次性的:它在第一个 tick 之前落,`buildMetaLine` 产一次、`serialize` 一次。 */
export const serializeMetaLine = (line: MetaLine): string => JSON.stringify(line);
