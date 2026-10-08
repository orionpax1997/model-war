/**
 * reporter:赛季报告的形状与序列化(hld §3.1 的 `runner:reporter`;票 08)。
 *
 * ── `report.json` 从「每局结果列表」升级成「可复算的排名数据」 ────────────────
 *
 * 票 06 写出一份最小 `report.json`(每局的输入引用 + 名次 + 问题清单)。票 08 就地扩展成
 * **可凭它 + 存档 + 种子独立重算排名**(NFR-2)的产物:
 *   - 每局:`matchId` / `inputPath`(仓库根相对)/ `comboId` / `mapIndex` / `seedIndex` /
 *     `map` / `seed` / `seats`(4 条存档引用,下标 = `playerIndex`)/ `rankings`(下标 = 座位)/
 *     `reason` / `perMatchScores`(每座位得分);
 *   - 赛季:`runId` / `ruleset`(规则版本标注)/ `masterSeed` / `rankPoints`(取自赛季配置)/
 *     `standings`(`rankSeason` 的输出**原样**,含 `countedMatches`)/ `validationFailures[]` /
 *     `matchIssues[]`。
 *
 * **被剔除的失败局不进 `matches`、也不进对局均分的分母**:`countedMatches` 只由 `rankSeason`
 * 计,报告侧不另算一遍。剔除的局改记在 `matchIssues`(带 `excludedFromRanking: true` +
 * 退出码 + 重跑次数),不静默丢弃。
 *
 * ── 两份「失败」分两节,绝不合并(hld §8.4 / spec《报告》) ────────────────────
 *
 *   - `validationFailures`:gen 侧 `archive/<slug>/failed-<runId>.json`(模型没拿到参赛资格);
 *   - `matchIssues`:§8.4 的崩溃 / 超时 / 内存披露(参赛了但被剔除或需披露)。
 * 处置不同,合并会误导读者。失败名单的读盘在票 09 落地,本票先把形状钉住(可为空数组)。
 *
 * ── 纯度契约 ──────────────────────────────────────────────────────────────────
 *
 * `renderReportJson` 是纯函数(输入 → JSON 文本),不碰 fs / 时钟 / 随机;只有薄壳
 * `writeReportJson` 落盘。依赖方向只到 `@model-war/schema` 与 `./ranker.js` 的类型,
 * 不 import engine / gen(hld §3.2)。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FailureRecord, RulesetVersion } from "@model-war/schema";
import type { RankedEntry, RankPoints } from "./ranker.js";

/**
 * 一局入报告的最小集:凭它 + 存档 + 种子即可独立重算这局的名次与得分(NFR-2)。
 *
 * `seats` / `rankings` / `perMatchScores` 三栏**同序**:下标即座位号(即 `playerIndex`)。
 */
export type SeasonMatchReport = {
  /** 对局目录名 `<comboId>-<map>-s<seedIndex>`(确定性命名)。 */
  readonly matchId: string;
  /** `input.json` 相对赛季根(`root`)的路径,供复算。 */
  readonly inputPath: string;
  /** 组合标识 `c<k>`,与目录名同源。 */
  readonly comboId: string;
  /** 地图在地图池里的下标。 */
  readonly mapIndex: number;
  /** 种子序号(`0..K-1`)。 */
  readonly seedIndex: number;
  /** 地图标识,取自地图池。 */
  readonly map: string;
  /** 写进 `input.json` 的确定性派生种子。 */
  readonly seed: number;
  /** 四个座位上的存档引用,下标即座位号。 */
  readonly seats: readonly [string, string, string, string];
  /** 回放末行 `result.rankings`,下标即座位,值 1 起、可并列。 */
  readonly rankings: readonly [number, number, number, number];
  /** 回放末行 `result.reason`。 */
  readonly reason: string;
  /** 按 `rankPoints` 算出的每座位得分,下标即座位(供复算者不实现 ranker 也能对分)。 */
  readonly perMatchScores: readonly number[];
};

/**
 * 对局问题清单里一条的原因:退出码 2 / 3 的崩溃 / 超时,或退出码 0 的内存压力披露(hld §8.4)。
 *
 * `memory-pressure` 是**正常结果**(exit 0、计入排名),只作披露;前两者参赛了但被剔除。
 */
export type MatchIssueReason = "engine-crash" | "nondeterministic-timeout" | "memory-pressure";

/**
 * 对局问题清单里的一局(hld §8.4)。
 *
 * 被剔除的局(`excludedFromRanking: true`)带退出码与重跑次数;内存披露(`exitCode: 0`、
 * `excludedFromRanking: false`)也落在这里,但**仍计入排名**。
 */
export type MatchIssue = {
  /** 对局目录名。 */
  readonly matchId: string;
  /** `input.json` 相对赛季根(`root`)的路径。 */
  readonly inputPath: string;
  /** 组合标识 `c<k>`。 */
  readonly comboId: string;
  /** 地图在地图池里的下标。 */
  readonly mapIndex: number;
  /** 种子序号。 */
  readonly seedIndex: number;
  /** 地图标识。 */
  readonly map: string;
  /** 该局派生种子。 */
  readonly seed: number;
  /** 稳定原因标签(供渲染与统计)。 */
  readonly reason: MatchIssueReason;
  /** 观察到的退出码;被信号杀为 `null`。 */
  readonly exitCode: number | null;
  /** 重跑次数(首发 1 + 重跑 1 ⇒ 1)。 */
  readonly rerunCount: number;
  /** 是否已排除出排名(剔除的失败局 = `true`;内存披露 = `false`)。 */
  readonly excludedFromRanking: boolean;
};

/**
 * `report.json` 的完整形状(NFR-2 的可复算性全押在这里)。
 *
 * `matches` 只含成功局(码 0);被剔除的失败局见 `matchIssues`(不在此、不计入均分分母)。
 */
export type SeasonReport = {
  /** 赛季运行标识,与产物目录名同源。 */
  readonly runId: string;
  /** 赛季唯一规则版本(报告标注)。 */
  readonly ruleset: RulesetVersion;
  /** 赛季主种子,复算每局种子要靠它。 */
  readonly masterSeed: string;
  /** 名次积分表,取自赛季配置(缺省 `[3,2,1,0]`)。 */
  readonly rankPoints: RankPoints;
  /** 成功局(码 0),按 `(combo, mapIndex, seedIndex)` 确定序。 */
  readonly matches: readonly SeasonMatchReport[];
  /** `rankSeason` 的输出原样:每模型赛季总分 / 有效局数 / 对局均分 / 排名。 */
  readonly standings: readonly RankedEntry[];
  /** gen 侧 `failed-<runId>.json` 的机器可读字段(校验失败名单;票 09 读盘填充)。 */
  readonly validationFailures: readonly FailureRecord[];
  /** §8.4 的崩溃 / 超时 / 内存披露(对局问题清单)。 */
  readonly matchIssues: readonly MatchIssue[];
};

/**
 * 把报告对象渲染成 `report.json` 的文本(纯函数:同输入恒同输出)。
 *
 * 采用 `JSON.stringify(report, null, 2)` + 末尾换行(与 gen 的 `writeFailureRecord` 同款,
 * 也保证并发与串行产出逐字节相同)。
 */
export const renderReportJson = (report: SeasonReport): string =>
  `${JSON.stringify(report, null, 2)}\n`;

/** 薄壳:确保父目录存在后把渲染结果写盘(`report.json`)。 */
export const writeReportJson = (filePath: string, report: SeasonReport): void => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, renderReportJson(report), "utf8");
};
