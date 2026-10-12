/**
 * 试跑观测文件的**写出侧**：把每一场的「无得分来源」读数渲染成 JSONL 并落盘。
 *
 * 那一格为什么存在、判据是什么，归 `score-source.ts`；留痕文案归 `trial.ts`。本文件只管
 * 「读数怎么变成文件」：gen 以 `--observations <路径>` 指定落盘点（真源在
 * `@model-war/gen` 的 `observations.ts`），入口跑完那几场后整份重写它。
 *
 * ── 为什么由入口写，而不是让 gen 收 stderr 再解析 ──
 *
 * 留痕行是给人看的中文文案；gen 若去解析它，「改一句文案」就变成「读数静默读不到」。
 * 让写出侧与渲染住在同一格，格式就不必靠字符串维持。代价是入口多认一个参数——那是
 * gen 与入口之间的私有协议（与退出码同款），`trial.ts` 与 `packages/gen/src/trial.ts`
 * 两侧的头注各有一半说明。
 *
 * ── 为什么每场都写，命中与否都写 ──
 *
 * 命中的读数**恒为** `delivered = 0`、`captures = 0`（那正是 C1 的定义），只记命中等于
 * 记下一堆 0/0：既算不出命中率的分母，也答不了「差多少」。所以这里逐场记，命中与否由
 * `noScoreSource` 这一栏说。早停（首场触限）时行数少于场数——那不是漏记，是没跑的场。
 *
 * ── 为什么写盘失败不抛 ──
 *
 * 观测是旁证：拿不到它不该让候选的账上多一条失败，更不该把退出码从「过」翻成「拦」。
 * 所以这里把异常收成 `{ ok: false }`，由调用点在 stderr 留一行警告后照常按原结论退出
 * （与「只观测、不拦」同一条纪律）。
 */

import { writeFileSync } from "node:fs";

import type { ScoreSourceReading } from "./score-source.js";

/**
 * 观测文件的一行。`matchIndex` 与试跑的场次下标同口径（0 起），三栏读数原样来自
 * `ScoreSourceReading`——形状没有第二个家，将来报告侧要读时随那次裁决提到 `@model-war/schema`。
 */
export type TrialObservationLine = {
  readonly matchIndex: number;
} & ScoreSourceReading;

/**
 * 渲染每一场的读数成 JSONL 的行（不含换行符；末尾换行由写出侧补，与回放 JSONL 同款）。
 *
 * 纯函数：不起 VM、不碰盘。键序即书写序，与行形状一致。
 */
export const trialObservationLines = (
  readings: readonly TrialObservationLine[],
): readonly string[] =>
  readings.map((reading) =>
    JSON.stringify({
      matchIndex: reading.matchIndex,
      delivered: reading.delivered,
      captures: reading.captures,
      noScoreSource: reading.noScoreSource,
    }),
  );

export type WriteObservationsResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * 把那几行落盘：**整份重写**（协议轮里每次试跑都写同一个路径，留盘上的恒是最后一次）。
 *
 * 没有读数时一个字节都不写，也不创建文件——空壳会被读档的人当成「跑了但没读数」。
 * 异常收成 `{ ok: false }`，不抛（见头注「为什么写盘失败不抛」）。
 */
export const writeTrialObservations = (
  path: string,
  lines: readonly string[],
): WriteObservationsResult => {
  if (lines.length === 0) {
    return { ok: true };
  }
  try {
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
};
