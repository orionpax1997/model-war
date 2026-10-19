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

import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

export type { TrialObservationLine } from "@model-war/schema";
import type {
  TrialObservationLine,
  TrialTerminalSummary,
  TrialTerminalPlayer,
  TrialUnitTable,
} from "@model-war/schema";

const unitTableOf = (table: TrialUnitTable): TrialUnitTable => ({
  worker: table.worker,
  melee: table.melee,
  ranged: table.ranged,
  cavalry: table.cavalry,
});

const terminalPlayerOf = (player: TrialTerminalPlayer): TrialTerminalPlayer => ({
  seat: player.seat,
  player: player.player,
  controlledBases: player.controlledBases,
  controlledResources: player.controlledResources,
  survivingUnits: unitTableOf(player.survivingUnits),
  survivingUnitCost: player.survivingUnitCost,
  score: {
    bases: player.score.bases,
    resources: player.score.resources,
    units: player.score.units,
  },
  territoryScore: player.territoryScore,
  rank: player.rank,
  rankPoints: player.rankPoints,
  alive: player.alive,
  eliminatedAtTick: player.eliminatedAtTick,
});

/** 白名单投影逐层关闭额外键，不把宿主内部状态作为观测发布。 */
const terminalSummaryOf = (summary: TrialTerminalSummary): TrialTerminalSummary => ({
  version: summary.version,
  seed: summary.seed,
  tick: summary.tick,
  reason: summary.reason,
  weights: {
    baseScore: summary.weights.baseScore,
    resourceScore: summary.weights.resourceScore,
    unitCostDivisor: summary.weights.unitCostDivisor,
  },
  unitCosts: unitTableOf(summary.unitCosts),
  rankPoints: [...summary.rankPoints],
  players: [
    terminalPlayerOf(summary.players[0]),
    terminalPlayerOf(summary.players[1]),
    terminalPlayerOf(summary.players[2]),
    terminalPlayerOf(summary.players[3]),
  ],
});

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
      ...(reading.actionFacts === undefined ? {} : { actionFacts: reading.actionFacts }),
      ...(reading.terminalSummary === undefined
        ? {}
        : { terminalSummary: terminalSummaryOf(reading.terminalSummary) }),
    }),
  );

export type WriteObservationsResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * 把那几行落盘：**整份重写**（路径由 trial invocation 给出；显式回喂时每协议轮独立）。
 *
 * 同目录唯一临时旁挂写完整后才 rename：失败时旧完整文件保留，首次写出不留半截目标。
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
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
    return { ok: true };
  } catch (cause) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // 清理失败也不抛，保留原始写盘原因，由调用点留警告。
    }
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
};
