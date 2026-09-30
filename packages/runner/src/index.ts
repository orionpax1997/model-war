/**
 * runner 包:赛季调度、排名与报告(hld §3.1)。
 * 依赖方向单向:runner → schema;**不得 import engine**——runner 只以子进程 + 文件消费对局产物(hld §3.2)。
 * 空壳阶段只落场次枚举的第一步:四方组合。地图 × 种子 × 座位轮换的展开随调度器落地,
 * 种子数 K 等取值是 rulesets 参数,不写在这里。
 */

import { RULESET_VERSION, type RulesetVersion } from "@model-war/schema";

/** 一场对局的输入指向:四个座位 + 钉住的规则集版本。 */
export type MatchUp = {
  /** 与 `docs/rules-vN` / `rulesets/vN.json` 对齐;错配拒跑(hld §7.1) */
  ruleset: RulesetVersion;
  seats: readonly [string, string, string, string];
};

/**
 * 枚举 C(4, N) 四方组合(hld §2.1 的场次调度第一段)。
 *
 * 名册去重后按字典序排序,组合因而只依赖名册的内容而不依赖入参顺序——
 * 同名输入必同输出(FR-7 AC1)。座位按排序后的顺序落位;座位轮换是后续步骤。
 */
export const enumerateMatchUps = (players: readonly string[]): readonly MatchUp[] => {
  const roster = [...new Set(players)].sort();
  const matchUps: MatchUp[] = [];
  for (let a = 0; a + 3 < roster.length; a += 1) {
    for (let b = a + 1; b + 2 < roster.length; b += 1) {
      for (let c = b + 1; c + 1 < roster.length; c += 1) {
        for (let d = c + 1; d < roster.length; d += 1) {
          const seats = fourSeatsAt(roster, a, b, c, d);
          if (seats !== undefined) {
            matchUps.push({ ruleset: RULESET_VERSION, seats });
          }
        }
      }
    }
  }
  return matchUps;
};

const fourSeatsAt = (
  roster: readonly string[],
  a: number,
  b: number,
  c: number,
  d: number,
): readonly [string, string, string, string] | undefined => {
  const [first, second, third, fourth] = [roster[a], roster[b], roster[c], roster[d]];
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    return undefined;
  }
  return [first, second, third, fourth];
};
