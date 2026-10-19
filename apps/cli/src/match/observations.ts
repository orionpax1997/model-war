/**
 * 观测记录 → `observations.jsonl`：软观测每玩家每类只记首条，异常详情逐条保留。
 *
 * ── 为什么去重在这一层，而不是在执行器或引擎里 ──
 *
 * 执行器每 tick 都可能报同一条软限/内存压力(读数逐 tick 重算),引擎侧出口只负责**转发**。
 * 「文件有界」这件事是**写出侧**的承诺:每玩家每类只记首触,首触 tick 足够回答「有没有触发」
 * (spec《观测通道》)。将来要计数是加栏,不是改形——所以去重是这一层的事,不是形状的事。
 *
 * ── 为什么它是纯函数、单独一格 ──
 *
 * 投影(引擎载荷 → 行)与去重是这条链上唯一有判断的两步,而它们不碰磁盘、不碰 VM。抽成纯函数
 * 之后,「同一玩家第二类仍记、同一类第二条丢弃」这类断言不必拉起真沙箱就能钉住。
 */

import type {
  MatchObservationLine,
  ObservationLine,
  ReplaySeat,
  ScriptExceptionDiagnostic,
} from "@model-war/schema";

/** 投一条观测行所需的五栏(引擎载荷里多出来的 `track` 在这一步丢掉:`kind` 已唯一对应一条轨)。 */
export type ObservationInput =
  | {
      readonly tick: number;
      readonly seat: ReplaySeat;
      readonly kind: ObservationLine["kind"];
      readonly value: number;
      readonly limit: number;
    }
  | {
      readonly tick: number;
      readonly seat: ReplaySeat;
      readonly kind: "exception";
      readonly exceptionTickLimit?: number;
      readonly diagnostic: ScriptExceptionDiagnostic;
    };

/**
 * 把按时间序到来的记录投影成 sidecar 行，软观测每玩家每类只保留首条，异常不去重。
 *
 * 判据是 `seat` + `kind` 两栏:同一个座位同一类第二次触发即丢弃,不同座位、不同类互不影响。
 */
export const observationLinesOf = (
  records: readonly ObservationInput[],
): readonly MatchObservationLine[] => {
  const seen = new Set<string>();
  const lines: MatchObservationLine[] = [];
  for (const record of records) {
    if (record.kind === "exception") {
      lines.push({
        type: "exception",
        tick: record.tick,
        seat: record.seat,
        diagnostic: record.diagnostic,
        ...(record.exceptionTickLimit === undefined
          ? {}
          : { exceptionTickLimit: record.exceptionTickLimit }),
      });
      continue;
    }
    const key = `${String(record.seat)}/${record.kind}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    lines.push({
      type: "observation",
      tick: record.tick,
      seat: record.seat,
      kind: record.kind,
      value: record.value,
      limit: record.limit,
    });
  }
  return lines;
};
