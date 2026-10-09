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
 * 处置不同,合并会误导读者。失败名单由 `readFailureRecords` 扫盘填充(票 09)。
 *
 * ── 人类面产物:report.md + narrative/<对局>.md(票 09) ────────────────────────
 *
 * `renderReportMarkdown` 把 `report.json` 的形状 + 代表性叙事摘要渲染成给人读的 Markdown
 * (排名表 / 代表性对局叙事 / 两份失败名单 / 规则版本标注);`renderNarrative` 把回放的
 * `events` 流渲染成一局的时间线。两者都是**纯函数**。
 *
 * 叙事**只消费 `events`**:`ReplayEvent` 只有 `{kind, subjectId}`,且 tick 行携带的是该 tick
 * 结算后的**状态**,所以叙事不能(也不该)回溯上一 tick 去补「这个单位属于谁」。玩家级事件
 * (`exception` / `economy-dead` / `player-eliminated` / `victory`)的 `subjectId` 是座位号,
 * 用 meta 行 `players[seat]` 映到模型名;单位级 / 点位级事件只能写数值 id,并在每篇开头**明说**
 * 这一信息上限(见 `renderNarrative` 的抬头行)。
 *
 * ── 纯度契约 ──────────────────────────────────────────────────────────────────
 *
 * 渲染函数(`renderReportJson` / `renderReportMarkdown` / `renderNarrative` /
 * `selectRepresentativeMatches` / `summarizeNarrative`)都是纯函数(输入 → 文本 / 选择),不碰
 * fs / 时钟 / 随机;只有薄壳(`writeReportJson` / `writeReportMarkdown` / `writeNarrative` /
 * `readFailureRecords` / `writeReportArtifacts`)落盘或读盘。依赖方向到 `@model-war/schema` /
 * `@model-war/replay` 与 `./ranker.js`,不 import engine / gen(hld §3.2 的拓扑里 `runner → replay`
 * 是一条合法边)。**读回放一律走 `@model-war/replay` 的 `parseReplay` / `readLinesOf`**
 * (spec《回放读入端(最小面)》:叙事战报与 NFR-2 复算链读同一处),不再就地实现第二条行读取。
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseReplay } from "@model-war/replay";
import {
  FAILURE_RECORD_PREFIX,
  type FailureRecord,
  type ReplayEvent,
  type ReplayEventKind,
  type ReplayLine,
  type ReplayMetaLine,
  type RulesetVersion,
} from "@model-war/schema";
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

/** 统一落盘:建父目录 + utf8 写文本(所有 Markdown 产物共用一处写盘纪律)。 */
const writeTextFile = (filePath: string, text: string): void => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, text, "utf8");
};

// ─────────────────────────────────────────────────────────────────────────────
// 叙事战报:narrative/<对局>.md(票 09;只消费 events)
// ─────────────────────────────────────────────────────────────────────────────

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * 事件的定序步号(与 `packages/engine/src/processor/events.ts` 的 `STEP_OF` 同源,hld §4.3)。
 *
 * 回放里的 `events` 已按它排好;叙事**重新按它排序**只为让输出只依赖事件的**集合**,不依赖文件
 * 行序或 `events` 数组的书写序——「叙事是 events 的纯函数」在机器上就是这条(同集合同输出)。
 */
const EVENT_STEP: Record<ReplayEventKind, number> = {
  exception: 0,
  "first-contact": 2,
  "unit-destroyed": 3,
  "site-captured": 4,
  "economy-dead": 4,
  "player-eliminated": 5,
  victory: 5,
};

/** 一条落在时间线上的事件(带它所属的 tick 与在该 tick `events[]` 里的下标,后者作稳定兜底)。 */
type TimelineEntry = {
  readonly tick: number;
  readonly index: number;
  readonly event: ReplayEvent;
};

/** 七种事件的中文文案。座位号经 `seatModel` 映到模型名;单位级 / 点位级只给数值 id。 */
const describeEvent = (event: ReplayEvent, seatModel: (seat: number) => string): string => {
  switch (event.kind) {
    case "exception":
      return `${seatModel(event.subjectId)} 异常出局`;
    case "first-contact":
      return `首触 · 单位 #${event.subjectId}`;
    case "unit-destroyed":
      return `单位 #${event.subjectId} 阵亡`;
    case "site-captured":
      return `点位 #${event.subjectId} 易主`;
    case "economy-dead":
      return `${seatModel(event.subjectId)} 经济死亡`;
    case "player-eliminated":
      return `${seatModel(event.subjectId)} 出局`;
    case "victory":
      return `${seatModel(event.subjectId)} 获胜`;
  }
};

/**
 * 把一份回放的**行集**渲染成一篇叙事战报(纯函数:同集合同文本)。
 *
 * 抬头行明说「只读 `events` 流」这一信息上限:`ReplayEvent` 只有 `{kind, subjectId}`,tick 行是
 * 结算后状态,故不回溯状态就补不出单位 / 点位的属主与兵种。座位级事件用 meta 行 `players[seat]`
 * 映到模型名;单位级 / 点位级只能写数值 id。
 *
 * 排序键 = `(tick, STEP_OF(kind), subjectId, kind, 下标)`(见 `EVENT_STEP`),于是反转 `events`
 * 或打乱行序都不改变输出——输出只由事件集合决定,不依赖文件行序。
 */
export const renderNarrative = (lines: readonly ReplayLine[]): string => {
  const meta = lines.find((line): line is ReplayMetaLine => line.type === "meta");
  const players = meta?.players ?? [];
  const seatModel = (seat: number): string =>
    players.find((player) => player.seat === seat)?.model ?? `座位 #${seat}`;

  const timeline: readonly TimelineEntry[] = lines
    .flatMap((line): readonly TimelineEntry[] =>
      line.type === "tick"
        ? line.events.map((event, index) => ({ tick: line.tick, index, event }))
        : [],
    )
    .sort(
      (left, right) =>
        left.tick - right.tick ||
        EVENT_STEP[left.event.kind] - EVENT_STEP[right.event.kind] ||
        left.event.subjectId - right.event.subjectId ||
        left.event.kind.localeCompare(right.event.kind) ||
        left.index - right.index,
    );

  const roster = players.map((player) => player.model);
  const out: string[] = [];
  out.push(roster.length === 0 ? "# 叙事战报" : `# 叙事战报:${roster.join(" / ")}`, "");
  out.push("本叙事**只读回放的 `events` 流**,不回溯任何 tick 状态(不重解析 `units` / `sites`)。");
  out.push("");
  out.push(
    "因此单位级 / 点位级事件只带数值 id——「这个单位属于哪个模型、什么兵种」是状态里的信息,这里刻意不读。",
  );
  out.push("");
  if (meta !== undefined) {
    out.push(`- 规则版本:\`${meta.ruleset}\``);
    out.push(`- 回放种子:\`${meta.seed}\``);
    out.push(`- 参赛者:${roster.length === 0 ? "(meta 未列名册)" : roster.join(" / ")}`);
    out.push("");
  }
  out.push("## 事件时间线", "");
  if (timeline.length === 0) {
    out.push("- (本局无事件)");
  } else {
    for (const { tick, event } of timeline) {
      out.push(`- \`t${tick}\` ${describeEvent(event, seatModel)}`);
    }
  }
  out.push("");
  return out.join("\n");
};

/** 薄壳:确保父目录存在后把渲染结果写盘(`narrative/<对局>.md`)。 */
export const writeNarrative = (filePath: string, lines: readonly ReplayLine[]): void => {
  writeTextFile(filePath, renderNarrative(lines));
};

/** 对一篇叙事文本做单行摘要:取前三条时间线,标注总数(供 report.md 的「代表性对局叙事」节)。 */
export const summarizeNarrative = (narrative: string): string => {
  const bullets = narrative
    .split("\n")
    .filter((line) => line.startsWith("- `t"))
    .map((line) => line.replace(/^- `/, "").replace("`", ""));
  if (bullets.length === 0) {
    return "本局无事件。";
  }
  const shown = bullets.slice(0, 3);
  const tail = bullets.length > shown.length ? `(共 ${bullets.length} 条事件)` : "";
  return `${shown.join(";")}${tail}`;
};

/**
 * 代表性对局的选择(纯函数,挑法写死):按名次表逐模型取它**名次最好**的一局,去重后取前
 * `limit` 篇。名次表已按均分降序,故输出对同一份报告是确定的。
 */
export const selectRepresentativeMatches = (report: SeasonReport, limit = 3): readonly string[] => {
  const selected: string[] = [];
  for (const entry of report.standings) {
    if (selected.length >= limit) {
      break;
    }
    let bestMatchId: string | undefined;
    let bestRank = Number.POSITIVE_INFINITY;
    for (const match of report.matches) {
      const seat = match.seats.indexOf(entry.player);
      if (seat < 0) {
        continue;
      }
      const rank = match.rankings[seat];
      if (rank === undefined) {
        continue;
      }
      if (rank < bestRank) {
        bestRank = rank;
        bestMatchId = match.matchId;
      }
    }
    if (bestMatchId !== undefined && !selected.includes(bestMatchId)) {
      selected.push(bestMatchId);
    }
  }
  return selected;
};

/**
 * 尝试读一份回放(供被剔除的局用):坏行 / 缺文件 / 被截断都返回 `undefined`,不抛。
 *
 * 正常路径(成功局)直接用 `parseReplay` 并让它抛 `ReplayReadError`;这里只用于**被剔除的局**
 * ——它们可能根本没写出回放,或只留下半截文件,此时叙事退化成「本局被排除」的说明即可,
 * 不该让一份坏回放拖垮整份报告。
 */
const tryParseReplay = (filePath: string): readonly ReplayLine[] | undefined => {
  try {
    return parseReplay(filePath);
  } catch {
    return undefined;
  }
};

/**
 * 被剔除出排名的一局的叙事战报(纯函数)。
 *
 * 有可用回放(哪怕是崩溃前写下的部分 tick 行)就把时间线附上;没有则说明本局被排除的原因与
 * 退出码。**每一局都有一篇 `narrative/<对局>.md`**(spec《报告》),故这个退化分支不是可选项。
 */
export const renderExcludedNarrative = (
  issue: MatchIssue,
  partialReplay?: readonly ReplayLine[],
): string => {
  const reason = reasonLabelOf(issue.reason);
  const exitCode = issue.exitCode === null ? "被信号终止(null)" : String(issue.exitCode);
  if (partialReplay === undefined || partialReplay.length === 0) {
    return [
      `# 叙事战报:${issue.matchId}(已排除出排名)`,
      "",
      `本局被**排除出排名**:${reason},退出码 ${exitCode},重跑 ${issue.rerunCount} 次。`,
      "",
      "本局没有可用的回放(崩溃 / 不确定超时的局通常不产出回放),故无事件时间线。",
      "",
    ].join("\n");
  }
  return renderNarrative(partialReplay).replace("# 叙事战报", `# 叙事战报(已排除出排名:${reason})`);
};

// ─────────────────────────────────────────────────────────────────────────────
// report.md:排名 + 代表性叙事 + 两份失败名单 + 规则版本标注(票 09)
// ─────────────────────────────────────────────────────────────────────────────

/** report.md 的输入:报告本身 + 已选好的代表性对局(带摘要),只引用 `narrative/<对局>.md`。 */
export type ReportMarkdownInput = {
  readonly report: SeasonReport;
  readonly representatives: readonly { readonly matchId: string; readonly summary: string }[];
};

/** Markdown 表格单元格转义(照 `packages/tools/src/generate/rules-value-table.ts` 的 `tableCell`)。 */
const tableCell = (value: string): string => value.replaceAll("|", "\\|");

/** 分数渲染:去掉浮点噪声,整数不带小数位,否则两位(均分可能是 1.5 / 2.33…)。 */
const formatScore = (value: number): string => {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
};

/** 存档引用 `archive/<slug>/<runId>` → 可读的 `<slug>`;不是该形态则原样返回。 */
const modelLabelOf = (player: string): string => {
  const parts = player.split("/");
  return parts[0] === "archive" && parts[1] !== undefined ? parts[1] : player;
};

/** `对局问题清单` 的稳定原因标签 → 中文。 */
const reasonLabelOf = (reason: MatchIssueReason): string => {
  switch (reason) {
    case "engine-crash":
      return "引擎崩溃";
    case "nondeterministic-timeout":
      return "不确定超时";
    case "memory-pressure":
      return "内存压力";
  }
};

/** 布尔 → 「是」/「否」(照 selfproof report 的 `yn` 形态)。 */
const yn = (value: boolean): string => (value ? "是" : "否");

/**
 * 渲染 `report.md`(纯函数:同输入恒同输出)。
 *
 * 结构:抬头(规则版本 / 主种子 / 名次积分表 / 计数)+ v0 免责 + 排名表 + 代表性对局叙事 +
 * **校验失败名单** + **对局问题清单**。两份失败**分两节、绝不合并**;每条都带回到来源记录的指针。
 *
 * v0 口径:不宣称名次可信、不做统计推断(报告里不出现任何此类字样,见测试的反例清单)。
 */
export const renderReportMarkdown = (input: ReportMarkdownInput): string => {
  const { report, representatives } = input;
  const out: string[] = [];

  out.push(`# 赛季报告 · 规则版本 \`${report.ruleset}\``, "");

  const excluded = report.matchIssues.filter((issue) => issue.excludedFromRanking).length;
  out.push(`- 运行标识:\`${report.runId}\``);
  out.push(`- 规则版本:\`${report.ruleset}\``);
  out.push(`- 赛季主种子:\`${report.masterSeed}\``);
  out.push(`- 名次积分表:${report.rankPoints.map((points) => String(points)).join(" / ")}`);
  out.push(`- 成功对局:${report.matches.length} 局`);
  out.push(`- 对局问题:${report.matchIssues.length} 条(其中排除出排名 ${excluded} 条)`);
  out.push(`- 校验失败:${report.validationFailures.length} 条`);
  out.push("");
  out.push("> v0 口径:名次仅供展示与观看,不做统计推断,也不代表模型之间的真实优劣。");
  out.push("");

  // ── 排名 ──
  out.push("## 排名", "");
  if (report.standings.length === 0) {
    out.push("本节为空:没有可展示的名次。", "");
  } else {
    out.push("| 名次 | 模型 | 赛季总分 | 有效局数 | 对局均分 |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const entry of report.standings) {
      out.push(
        `| ${entry.rank} | ${tableCell(modelLabelOf(entry.player))} | ` +
          `${formatScore(entry.totalPoints)} | ${entry.countedMatches} | ` +
          `${formatScore(entry.averagePoints)} |`,
      );
    }
    out.push("");
  }

  // ── 代表性对局叙事 ──
  out.push("## 代表性对局叙事", "");
  if (representatives.length === 0) {
    out.push("本节为空:没有可引用的对局叙事。", "");
  } else {
    for (const { matchId, summary } of representatives) {
      out.push(`- [${matchId}](narrative/${matchId}.md) — ${summary}`);
    }
    out.push("");
    out.push(`(每局都生成了叙事战报,见 \`narrative/\` 目录;上面只引用代表性几篇。)`);
    out.push("");
  }

  // ── 校验失败名单(本季没参赛的模型;来源 = gen 侧 failed-<runId>.json) ──
  out.push("## 校验失败名单", "");
  out.push(
    "> 来源:gen 侧 `archive/<slug>/failed-<runId>.json`,**只列本季未参赛的模型**。这些模型没通过",
  );
  out.push("> 静态校验 / 传输耗尽,**没有参赛资格**,与下面的「对局问题清单」是两回事。", "");
  if (report.validationFailures.length === 0) {
    out.push("本节为空:没有模型在校验阶段失败。", "");
  } else {
    out.push("| 模型 | 版本 | 分类 | 已收敛轮数 | 说明 | 记录 |");
    out.push("| --- | --- | --- | --- | --- | --- |");
    for (const record of report.validationFailures) {
      const pointer = `archive/${record.model}/${FAILURE_RECORD_PREFIX}${record.runId}.json`;
      out.push(
        `| ${tableCell(record.model)} | ${tableCell(record.modelVersion)} | ` +
          `${record.classification} | ${record.protocolRounds} | ` +
          `${tableCell(record.message)} | \`${pointer}\` |`,
      );
    }
    out.push("");
  }

  // ── 对局问题清单(参赛了但被剔除 / 需披露;来源 = §8.4 执行期异常) ──
  out.push("## 对局问题清单", "");
  out.push("> 来源:§8.4 执行期披露。引擎崩溃 / 不确定超时**参赛了但被排除出排名**;");
  out.push("> 内存压力是**正常结果**(退出码 0),只披露、仍计入排名。", "");
  if (report.matchIssues.length === 0) {
    out.push("本节为空:没有对局出现崩溃 / 超时 / 内存披露。", "");
  } else {
    out.push("| 对局 | 地图 | 种子 | 原因 | 退出码 | 重跑 | 排除出排名 | 输入 |");
    out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const issue of report.matchIssues) {
      const exitCode = issue.exitCode === null ? "—" : String(issue.exitCode);
      out.push(
        `| ${tableCell(issue.matchId)} | ${tableCell(issue.map)} | ${issue.seed} | ` +
          `${reasonLabelOf(issue.reason)} | ${exitCode} | ${issue.rerunCount} | ` +
          `${yn(issue.excludedFromRanking)} | \`${issue.inputPath}\` |`,
      );
    }
    out.push("");
  }

  return out.join("\n");
};

/** 薄壳:确保父目录存在后把渲染结果写盘(`report.md`)。 */
export const writeReportMarkdown = (filePath: string, input: ReportMarkdownInput): void => {
  writeTextFile(filePath, renderReportMarkdown(input));
};

/**
 * 扫 `archive/<slug>/failed-*.json` 读出校验失败名单(本季没拿到参赛资格)。
 *
 * 只按文件名前缀 `failed-` 与目录结构找记录,**不猜 runId**:赛季的 runId 与 gen 的 runId
 * 不同源,无法只凭 runId 关联到本季。故收窄口径改为按 **slug 是否本季参赛**:一个 slug 只要
 * 出现在 `participatingSlugs` 里,它遗留的历史失败记录就不算「没拿到参赛资格」(否则名单会与
 * 本季主排名自相矛盾——同一 slug 既被列进名单、又在排名里)。收录的因此只是本季未参赛模型的
 * 失败记录(按 `slug`、再按文件名升序,确定性)。
 *
 * 没走另两个候选:给 `season.yaml` 加 gen runId 引用要动契约(`season-config` / hld §9 / 范例);
 * 只把名单改名成「历史记录」不解决矛盾。比对用目录段,它与记录里的 `model` 同源(gen 侧
 * `failureRecordPath` 就用 `model` 当目录名)。
 */
export const readFailureRecords = (
  root: string,
  participatingSlugs: ReadonlySet<string>,
): readonly FailureRecord[] => {
  const archiveDir = join(root, "archive");
  let slugs: readonly string[];
  try {
    slugs = readdirSync(archiveDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    throw new Error(`读不到存档目录 ${archiveDir}:${messageOf(cause)}`);
  }
  const records: FailureRecord[] = [];
  for (const slug of slugs) {
    if (participatingSlugs.has(slug)) {
      continue;
    }
    const slugDir = join(archiveDir, slug);
    const files = readdirSync(slugDir)
      .filter((name) => name.startsWith(FAILURE_RECORD_PREFIX) && name.endsWith(".json"))
      .sort();
    for (const file of files) {
      const filePath = join(slugDir, file);
      try {
        records.push(JSON.parse(readFileSync(filePath, "utf8")) as FailureRecord);
      } catch (cause) {
        throw new Error(`失败记录 ${filePath} 不是合法 JSON:${messageOf(cause)}`);
      }
    }
  }
  return records;
};

/**
 * 落 human-facing 的两个产物:每局一篇 `narrative/<对局>.md` + 一份 `report.md`。
 *
 * 叙事**每局都生成**(spec《报告》):成功局走 `parseReplay` 读回放(坏回放原样上抛);被剔除
 * 出排名的失败局即使没写出回放,也写一篇说明「本局被排除 + 原因」的叙事(shell 见
 * `renderExcludedNarrative`)。`report.md` 只引用代表性几篇。
 */
export const writeReportArtifacts = (outputDir: string, report: SeasonReport): void => {
  const narrativePathOf = (matchId: string): string =>
    join(outputDir, "narrative", `${matchId}.md`);
  const replayPathOf = (matchId: string): string =>
    join(outputDir, "matches", matchId, "replay.jsonl");

  const narratives = new Map<string, string>();
  // 成功局:回放是「events 的纯函数」的来源;一律经 `@model-war/replay` 的 `parseReplay` 读入。
  for (const match of report.matches) {
    const text = renderNarrative(parseReplay(replayPathOf(match.matchId)));
    narratives.set(match.matchId, text);
    writeTextFile(narrativePathOf(match.matchId), text);
  }
  // 被剔除的失败局:**仍每局一篇**(没有可用回放则退化成「本局被排除」说明 + 部分回放时间线)。
  for (const issue of report.matchIssues) {
    if (!issue.excludedFromRanking) {
      continue;
    }
    writeTextFile(
      narrativePathOf(issue.matchId),
      renderExcludedNarrative(issue, tryParseReplay(replayPathOf(issue.matchId))),
    );
  }

  const representatives = selectRepresentativeMatches(report).map((matchId) => ({
    matchId,
    summary: summarizeNarrative(narratives.get(matchId) ?? ""),
  }));
  writeTextFile(join(outputDir, "report.md"), renderReportMarkdown({ report, representatives }));
};
