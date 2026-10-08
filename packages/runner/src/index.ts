/**
 * runner 包:赛季调度、排名与报告(hld §3.1)。
 * 依赖方向单向:runner → schema;**不得 import engine**——runner 只以子进程 + 文件消费对局产物(hld §3.2)。
 * 本模块只做对局枚举:全部 4 人组合 × M 张地图 × K 个种子,每个对局带座位轮换与确定性种子。
 * 种子数 K、地图池等取值来自 `season.yaml`,不写在这里。
 * 配合 `ranker`(名次积分纯函数 `rankSeason`),runner 已不再是空壳:枚举 → 名次记账两段纯函数齐备。
 */

import { createHash } from "node:crypto";
import { RULESET_VERSION, type RulesetVersion } from "@model-war/schema";

export * from "./ranker.js";

/** 一场对局的输入指向:四个座位 + 地图 + 种子 + 组合标识 + 各下标 + 钉住的规则集版本。 */
export type MatchUp = {
  /** 与 `docs/rules-vN` / `rulesets/vN.json` 对齐;错配拒跑(hld §7.1) */
  ruleset: RulesetVersion;
  /** 四个座位上的参赛存档引用,下标即座位号 0..3。构成见 `enumerateMatchUps` 的座位轮换说明。 */
  seats: readonly [string, string, string, string];
  /** 本对局所用地图标识,取自地图池。 */
  map: string;
  /** 确定性派生的种子(非负 32 位整数),驱动地图变体。 */
  seed: number;
  /** 组合标识 `c<k>`,`k` = 组合序号(按 slug 升序的名册里 `C(4,N)` 的枚举序)。 */
  comboId: string;
  /** 组合序号,与 `comboId` 的 `<k>` 一致。 */
  comboIndex: number;
  /** 地图在地图池里的下标。 */
  mapIndex: number;
  /** 种子序号(`0..K-1`)。 */
  seedIndex: number;
};

/** `enumerateMatchUps` 的入参。 */
export type EnumerateMatchUpsOptions = {
  /** 参赛存档引用(`archive/<slug>/<runId>`),去重后按 slug 升序参与组合。 */
  readonly participants: readonly string[];
  /** 地图池(引用 `maps/` 下的 slug),下标即 `mapIndex`。 */
  readonly maps: readonly string[];
  /** 种子数 K。须满足 `M × K ≡ 0 (mod 4)`。 */
  readonly seeds: number;
  /** 赛季主种子,与组合 / 地图 / 种子序号一起决定每局种子。 */
  readonly masterSeed: string;
};

/** 每个对局的座位数。四人对称(PRD 定位),故取定长 4 元组。 */
const SEAT_COUNT = 4;

/**
 * 枚举全部 4 人组合 × M 张地图 × K 个种子,产出完整、确定的对局清单(hld §8.1)。
 *
 * 名册去重后按 **slug 升序**排序,组合因而只依赖名册的内容而不依赖入参顺序——同名输入必
 * 同输出(FR-7 AC1)。每个组合内的 4 名为基准序列,座位 = 基准序列按 `(mapIndex + seedIndex) mod 4`
 * 循环左移;种子 = `H(masterSeed, comboId, mapIndex, seedIndex)`(纯确定性,见 `deriveSeed`)。
 *
 * ── 与 hld §8.1 的一处收紧 ────────────────────────────────────────────────
 * hld §8.1 原文说 `M × K ≢ 0 (mod 4)` 时「各座位的对局数最多差 1」,把残差留给 §12 的座位胜率统计。
 * 本票(spec「枚举器扩展」)把这条**收紧成硬错误**:不满足 `M × K ≡ 0 (mod 4)` 直接抛错,
 * 不产出任何偏移的清单。理由是静默的残差不对称会让「座位对全体参赛者一致」这条承诺变成
 * 只对部分配置成立。以票为准;hld 归 hld,此处记下矛盾的一方是 hld 的宽松措辞。
 */
export const enumerateMatchUps = (options: EnumerateMatchUpsOptions): readonly MatchUp[] => {
  const { participants, maps, seeds, masterSeed } = options;
  const matchUpsPerCombo = maps.length * seeds;
  if (matchUpsPerCombo % SEAT_COUNT !== 0) {
    throw new Error(
      `对局均摊要求 M × K ≡ 0 (mod 4):当前 M=${maps.length} 张地图 × K=${seeds} 个种子 = ` +
        `${matchUpsPerCombo}(mod 4 = ${matchUpsPerCombo % SEAT_COUNT})。请调整地图池或种子数。`,
    );
  }

  const roster = [...new Set(participants)].sort(bySlug);
  const matchUps: MatchUp[] = [];
  let comboIndex = 0;
  for (let a = 0; a + 3 < roster.length; a += 1) {
    for (let b = a + 1; b + 2 < roster.length; b += 1) {
      for (let c = b + 1; c + 1 < roster.length; c += 1) {
        for (let d = c + 1; d < roster.length; d += 1) {
          const base = fourSeatsAt(roster, a, b, c, d);
          if (base === undefined) {
            continue;
          }
          const comboId = `c${comboIndex}`;
          for (let mapIndex = 0; mapIndex < maps.length; mapIndex += 1) {
            const map = maps[mapIndex];
            if (map === undefined) {
              continue;
            }
            for (let seedIndex = 0; seedIndex < seeds; seedIndex += 1) {
              matchUps.push({
                ruleset: RULESET_VERSION,
                seats: rotateSeats(base, mapIndex + seedIndex),
                map,
                seed: deriveSeed(masterSeed, comboId, mapIndex, seedIndex),
                comboId,
                comboIndex,
                mapIndex,
                seedIndex,
              });
            }
          }
          comboIndex += 1;
        }
      }
    }
  }
  return matchUps;
};

/**
 * 存档引用的排序键:第一段路径即 slug。`archive/<slug>/<runId>` → `<slug>`;无分隔符则取整串。
 *
 * **不按整串比较**:`-`(0x2D)与 `.`(0x2E)都排在 `/`(0x2F)之前,于是整串排序会把 `a-b` 放到 `a`
 * 前面,与 slug 升序不一致。排序键写死成这一种,由测试钉住。
 */
const slugOf = (archiveRef: string): string => archiveRef.split("/")[1] ?? archiveRef;

/** slug 升序,slug 相同时以整串为稳定平局键。 */
const bySlug = (left: string, right: string): number => {
  const leftSlug = slugOf(left);
  const rightSlug = slugOf(right);
  if (leftSlug !== rightSlug) {
    return leftSlug < rightSlug ? -1 : 1;
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

/**
 * 基准序列按 `shift` 循环左移:第 i 位取基准序列的 `(i + shift) mod 4` 位。
 *
 * 分隔符与位序在本函数定死,由测试钉住;`shift` 取任意整数都收敛到 `0..3`。
 */
const rotateSeats = (
  base: readonly [string, string, string, string],
  shift: number,
): readonly [string, string, string, string] => {
  const offset = ((shift % SEAT_COUNT) + SEAT_COUNT) % SEAT_COUNT;
  const rotated = [...base.slice(offset), ...base.slice(0, offset)];
  const seats = fourSeatsAt(rotated, 0, 1, 2, 3);
  if (seats === undefined) {
    throw new Error("座位轮换失败:基准序列不足 4 名");
  }
  return seats;
};

/**
 * 种子派生 `H(masterSeed, comboId, mapIndex, seedIndex)`。
 *
 * 编码写死一种并被测试钉住:`sha256("<masterSeed>|<comboId>|<mapIndex>|<seedIndex>")` 的十六进制
 * 摘要取**前 8 个字符**(32 位)→ 解析为无符号整数。产出恒为非负 32 位整数(`MatchInput.seed`
 * 要求 `integer ≥ 0`,引擎 `createRandom` 对其取模)。纯函数、无状态、可重放。
 */
const deriveSeed = (
  masterSeed: string,
  comboId: string,
  mapIndex: number,
  seedIndex: number,
): number => {
  const digest = createHash("sha256")
    .update(`${masterSeed}|${comboId}|${mapIndex}|${seedIndex}`)
    .digest("hex");
  return Number.parseInt(digest.slice(0, 8), 16) >>> 0;
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
