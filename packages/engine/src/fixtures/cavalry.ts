/**
 * 夹具 #10「骑兵的实战闲置与 R2 唯一解缺口」(`docs/gdd.md` §8 #10)的可跑宿主。
 *
 * ── 原桩那两条探针的定义(逐字抽自聚合器与取证表) ──
 *
 * 1. **骑兵的实战存在感**(§7):骑兵输出伤害份额、击杀、被击杀,以及「哪些脚本会造它」。
 * 2. **M7 骑兵开关实验**(§10.2):同一份探针源码、同几何、2v2 同场、4 轮转摊平座位先后手,
 *    两臂**只改生产序列**(造骑兵 vs 不造骑兵),量每臂的 `席位(对局)`、`平均终局名次`、
 *    `第 1 名占比`、`领土分中位`、`结局 tick 中位`、`超时率`。
 *
 * ── 本夹具量得到哪一半 ──
 *
 * 第 2 条**整体可搬**:本夹具按 M7 的形状跑两臂,臂差只落在「基地造 `cavalry` 还是 `melee`」
 * 这一处(其余策略逐字相同),把 §10.2 那六栏在真引擎上重新量一遍。
 *
 * 第 1 条只能量**「是否出产/使用」**那一半:骑兵是不是真的被造出来了、在哪一席、峰值几支。
 * 「伤害份额」那一半**本夹具量不到**——回放里没有伤害通道(八种事件里没有一条带伤害量,
 * tick 行的 `units` 只有 HP),要量它得先给回放加一条战斗统计栏。这是一处真实缺口,记在
 * `## Answer`,不在本票修。
 *
 * 复验时拿这批读数去对 §10.2 的「造骑兵是不是劣势」与 §7 的「骑兵实战闲置」;**本票不下结论**。
 */

import type { FixtureMatch } from "./harness.js";
import { tickLinesOf } from "./harness.js";
import type { PlayerIndex } from "../world/state.js";

/** 一条对局里某一席的骑兵存在感。 */
export type CavalryPresence = {
  readonly seat: PlayerIndex;
  /** 全场任意一 tick 里出现过该席的骑兵 = 真的出产过。 */
  readonly everProduced: boolean;
  /** 全场任意一 tick 里该席骑兵数量的峰值。 */
  readonly peakCavalry: number;
  /** 终局该席骑兵数量。 */
  readonly cavalryEnd: number;
  /** 终局该席单位总数。 */
  readonly unitsEnd: number;
};

export const cavalryPresenceOf = (match: FixtureMatch): readonly CavalryPresence[] => {
  const lines = tickLinesOf(match.parsed);
  return ([0, 1, 2, 3] as const).map((seat) => {
    let peak = 0;
    for (const line of lines) {
      const count = line.units.filter(
        (unit) => unit.owner === seat && unit.type === "cavalry",
      ).length;
      if (count > peak) {
        peak = count;
      }
    }
    const end = lines.at(-1);
    const cavalryEnd =
      end?.units.filter((unit) => unit.owner === seat && unit.type === "cavalry").length ?? 0;
    const unitsEnd = end?.units.filter((unit) => unit.owner === seat).length ?? 0;
    return { seat, everProduced: peak > 0, peakCavalry: peak, cavalryEnd, unitsEnd };
  });
};

/** M7 的两臂。 */
export type CavalryArm = "cavalry" | "melee";

/**
 * 某一席在某个轮转下属于哪一臂:前两席造骑兵、后两席不造(其余策略逐字相同)。
 * 轮转 0..3 把「哪两席造骑兵」转一圈,摊平座位先后手(与 §10.2 的 4 轮转同形)。
 */
export const armOfSeat = (seat: PlayerIndex, rotation: number): CavalryArm =>
  (seat - rotation + 4) % 4 < 2 ? "cavalry" : "melee";

/** 某一席在一条对局里的终局读数(臂对比的每一行)。 */
export type CavalrySeatRow = {
  readonly arm: CavalryArm;
  readonly seat: PlayerIndex;
  readonly finalRank: number;
  readonly territoryScore: number;
  readonly outcomeTick: number;
  readonly timeout: boolean;
  readonly cavalryProduced: boolean;
};

/** 把一条对局的四席摊成四行,标上它属于哪一臂。 */
export const cavalrySeatRowsOf = (
  match: FixtureMatch,
  rotation: number,
): readonly CavalrySeatRow[] => {
  const presence = cavalryPresenceOf(match);
  return presence.map((entry) => ({
    arm: armOfSeat(entry.seat, rotation),
    seat: entry.seat,
    finalRank: match.result.rankings[entry.seat] ?? 0,
    territoryScore: match.result.territoryScores[entry.seat] ?? 0,
    outcomeTick: match.tickCount,
    timeout: match.result.reason === "timeout",
    cavalryProduced: entry.everProduced,
  }));
};

/** 每个臂的造兵选择:造骑兵臂造 `cavalry`,对照臂造 `melee`(造价更低)。 */
export const spawnTypeOfArm = (arm: CavalryArm): "cavalry" | "melee" =>
  arm === "cavalry" ? "cavalry" : "melee";
