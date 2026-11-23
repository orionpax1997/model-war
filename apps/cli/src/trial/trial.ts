/**
 * 冻结期试跑的**纯判定与反馈文案**（不经引擎、不起 VM）。
 *
 * ── 为什么这一格是纯的 ──
 *
 * 「触限怎么被记录下来」（runner 包装、tick 归因）归 `match-run.ts`，它经真实 `runMatch`
 * 覆盖；「记录下来后怎么判、怎么讲」归这里，断言不需要 VM。两件事拆在两处，
 * 于是本文件的测试毫秒级，而真沙箱的开销只落在必须有它的那一侧。
 *
 * ── 探针的三档文案也在这里，理由同一条 ──
 *
 * 探针的「已越线」那一档**直接调** `renderBlockedTrip`：不是"也写了一份相似的话"，而是同一次调用
 * ——分叉的形状是「模型在探针里读到 X、evaluate 里读到 Y」，读侧完全看不出来。
 *
 * 另两档（贴边 / 充裕）的读数栏另有自己的说法（`PROBE_TRACK_NAMES`），两层不是同一张表：
 * 拦下话术说的是"某某**计数**超限（读数…）"（句子的主语是轨名，而轨名的真源是
 * `TRACK_LABELS`）；读数栏说的是"轨名 + 值/上限（占比）"的**键值对**，那里三条轨都在
 * （含内存），而 `TRACK_LABELS` 只覆盖会被判负的两条轨：内存不产生触限记录，它在拦下话术里
 * 没有句子可用。所以两张表**不重叠也不应合并**：一张是判负句子的词汇，一张是读数行的列名。
 *
 * 场数、地图、种子、座位、对手都在**试跑计划**里（形状在 `@model-war/schema` 的
 * `trial-plan.ts`，构造与校验在 `@model-war/runner` 的 `trial-plan.ts`）。本文件只接计划、
 * 判计划跑出来的触限、按计划里的取值讲结论——于是「把当前配置换成网格」不再需要改这一格。
 */

import {
  PROBE_MATCH_LIMIT,
  PROBE_NEAR_LIMIT_RATIO,
  TRIAL_CANDIDATE_SEAT,
  type ReplaySeat,
  type TrialPlan,
} from "@model-war/schema";

import type { PeakUsageReading } from "./peak-usage.js";
import type { ScoreSourceReading } from "./score-source.js";

/** 试跑看的两条轨：tick 级 events/apis。其余轨（未吞异常、内存）进联赛三振，这里不判。 */
export const WATCHED_TRACKS: readonly string[] = ["eventTickLimit", "apiCallTickLimit"];

/** 执行器交回的一条触限记录：座位与 tick 由记录器在调用点补齐（与步 0 同源）。 */
export type RecordedTrip = {
  readonly matchIndex: number;
  readonly tick: number;
  readonly seat: ReplaySeat;
  /** 轨名：执行器的原生词（如 `eventTickLimit`）。 */
  readonly track: string;
  readonly value: number;
  readonly limit: number;
};

/** 试跑结论：通过，或拦下并带上首触明细（第几场、第几 tick、哪项预算、超了多少）。 */
export type TrialVerdict =
  | { readonly passed: true }
  | { readonly passed: false; readonly trip: RecordedTrip };

/** 每个场次的候选座位由计划给（v1 恒 0；网格起逐场轮转）。 */
export type CandidateSeatOf = (matchIndex: number) => ReplaySeat;

/**
 * 按到达序取首条"候选座位在看轨上"的触限。有它即拦（零容忍），否则放行。
 *
 * 对手座位的触限（基准健康假设）与非看轨（未吞异常、内存）的触限一律忽略：
 * 前者不算候选的账，后者进联赛后靠现行三振兜着——两处分工，出局只留给真崩溃。
 *
 * `candidateSeatOf` 缺省取 v1 的固定座位，便于不起计划的单元用例直接断言判定规则。
 */
export const verdictOfTrips = (
  trips: readonly RecordedTrip[],
  candidateSeatOf: CandidateSeatOf = () => TRIAL_CANDIDATE_SEAT,
): TrialVerdict => {
  for (const trip of trips) {
    if (trip.seat === candidateSeatOf(trip.matchIndex) && WATCHED_TRACKS.includes(trip.track)) {
      return { passed: false, trip };
    }
  }
  return { passed: true };
};

/**
 * 按**完整计划**查候选座位；查不到就**抛**，不 `?? 0`。
 *
 * ── 为什么不是 `plan.matches[i]?.candidateSeat ?? 0` ──
 *
 * 那个兜底是一个静默假绿的入口：计划被裁短（比如有人为了「只跑前 8 场」把计划 `slice` 一遍）
 * 之后，`matches[10]` 缺席 → 座位算成 0 → 座位 3 的触限与它不符 → `verdictOfTrips` 判成
 * **通过**。触限还在，结论翻了，而日志里一个字都看不出来。
 *
 * 探针跑的就是计划的前缀，所以它必须拿**完整计划**查座位（`grid.ts` 的 `runTrialGridSubset`
 * 只收窄循环范围，不裁计划对象），缺项则大声失败而不是给一个座位。
 */
export const candidateSeatOfPlan = (plan: TrialPlan): CandidateSeatOf => {
  return (matchIndex: number): ReplaySeat => {
    const match = plan.matches.find((candidate) => candidate.matchIndex === matchIndex);
    if (match === undefined) {
      throw new Error(
        `候选座位查不到：计划里没有第 ${String(matchIndex)} 场` +
          "（判座位必须拿完整计划；裁剪过的计划会把触限判成通过）",
      );
    }
    return match.candidateSeat;
  };
};

/** 看轨的面向模型说法（"哪项预算"这一栏的文案）。 */
const TRACK_LABELS: Record<string, string> = {
  eventTickLimit: "单 tick 控制流事件计数",
  apiCallTickLimit: "单 tick API 调用计数",
};

/** 看轨的改法提示（"下一轮怎么改"这一栏的文案）。 */
const TRACK_HINTS: Record<string, string> = {
  eventTickLimit: "请精简每 tick 的循环与函数调用，把重活摊到多个 tick 或缓存中间结果",
  apiCallTickLimit: "请减少每 tick 的 API 调用次数，把多次查询合并或缓存结果",
};

/**
 * 渲染面向模型的试跑反馈（逐字回喂，不加引擎内部诊断）。
 *
 * 通过：写明场数、地图与种子（可复现信息，全部取自计划）；拦下：写明第几场、第几 tick、
 * 哪项预算、读数/上限/超出，并给一句该轨的改法提示。
 */
export const renderTrialFeedback = (verdict: TrialVerdict, plan: TrialPlan): string => {
  const matchCount = plan.matches.length;
  if (verdict.passed) {
    return (
      `试跑通过：${String(matchCount)} 场（地图 ${plan.maps.map((map) => map.name).join(" / ")}，` +
      `种子 ${plan.matches.map((match) => String(match.seed)).join(" / ")}）无预算超限。`
    );
  }
  return renderBlockedTrip(verdict.trip, matchCount);
};

/**
 * 拦下时的那段话术（**唯一一份**）：`evaluate` 的反馈与探针的「已越线」档都用它。
 *
 * `matchCount` 是"这一轮算几场"：`evaluate` 传计划的整场数，探针传它实际跑的前缀场数。
 * 两档的差别只在这一个数，措辞逐字相同——探针里读到的那句「哪项预算超限、怎么改」必须与
 * evaluate 拦下时读到的一字不差。
 */
const renderBlockedTrip = (trip: RecordedTrip, matchCount: number): string => {
  const label = TRACK_LABELS[trip.track] ?? trip.track;
  const hint = TRACK_HINTS[trip.track] ?? "请降低该项预算的每 tick 开销后重新提交";
  return (
    `试跑未通过：候选脚本在第 ${String(trip.matchIndex + 1)} 场` +
    `第 ${String(trip.tick)} tick 触发预算超限。\n` +
    `- ${label}超限（读数 ${String(trip.value)}，上限 ${String(trip.limit)}，` +
    `超出 ${String(trip.value - trip.limit)}）。\n` +
    `${String(matchCount)} 场试跑零容忍：任一场超限即打回。${hint}。`
  );
};

/**
 * 「无得分来源」的留痕文案（只进 stderr，**不回喂、不拦**）。未命中给 `null`。
 *
 * 只观测的理由与口径见 `score-source.ts` 头注；升级为判定另票裁决。
 *
 * 留痕行数通常等于场数：网格执行器不早停，触限之后的后场照样跑、照样有读数。
 * 某一场作废且重跑仍作废时整轮 infra，这一轮不落盘（上一轮跑完的证据留在盘上）。
 */
export const renderScoreSourceObservation = (
  matchIndex: number,
  reading: ScoreSourceReading,
): string | null => {
  if (!reading.noScoreSource) {
    return null;
  }
  return (
    `试跑观测（不拦）：候选在第 ${String(matchIndex + 1)} 场整局无交付、无占点` + `（无得分来源）。`
  );
};

/** 一 MiB 的字节数：内存读数按 MB 讲（`1.1/4.0 MB`），与试探时的直觉同一量级。 */
const MIB = 1024 * 1024;

/**
 * 探针要讲的三条轨的上限（取自 `budgetOf(ruleset)`）。缺席 = 该轨未启用，不显示。
 *
 * 内存那条用的是 `memoryTickCeiling`（tick 末存活堆的判罚线），**不是** `memoryLimit`
 * （VM 分配上限）：探针报的是"这条轨最坏用了多少"，判那条轨的线才是可比的对照物。
 */
export type ProbeLimits = {
  readonly eventTickLimit?: number;
  readonly apiCallTickLimit?: number;
  readonly memoryTickCeiling?: number;
};

/** 一条轨在探针文案里的读数：轨名（长/短两种写法）+ 读到的值 + 它的上限。 */
type ProbeTrack = {
  readonly track: "eventTickLimit" | "apiCallTickLimit" | "memoryTickCeiling";
  /** 贴边档用的完整说法（"单 tick 控制流事件 480/500（96%）"）。 */
  readonly label: string;
  /** 充裕档用的短说法（"事件 120/500（24%）"）。 */
  readonly short: string;
  readonly value: number;
  readonly limit: number;
};

/**
 * 读数行的列名：拦下话术那一张表（`TRACK_LABELS`）不覆盖内存，见文件头注那段。
 *
 * `label` 比 `TRACK_LABELS` 少两个字（"计数"）：那两个字在拦下句子里是主语的一部分
 * （"…计数超限（读数 61234，上限 50000）"），而在一条读数行里紧跟着数字（"…事件
 * 48000/50000（96%）"）就成了重复。两种说法服务两种句式，不是两份真源。
 */
const PROBE_TRACK_NAMES = {
  eventTickLimit: { label: "单 tick 控制流事件", short: "事件" },
  apiCallTickLimit: { label: "单 tick API 调用", short: "API" },
  memoryTickCeiling: { label: "内存", short: "内存" },
} as const;

/**
 * 探针的读数列：只列**采到且启用着**的轨。
 *
 * 一条轨没采到就不列——写成 `0/500` 是这一整条通道唯一能造成的静默错误（"没量"读成"用了 0"）。
 * 三条都没采到时上层走"没采到读数"那一档，而不是假装全 0。
 */
const probeTracksOf = (
  peakUsage: PeakUsageReading | undefined,
  limits: ProbeLimits,
): readonly ProbeTrack[] => {
  if (peakUsage === undefined) return [];
  const tracks: ProbeTrack[] = [];
  const push = (
    track: ProbeTrack["track"],
    value: number | undefined,
    limit: number | undefined,
  ): void => {
    // `limit <= 0` 等于这条轨没启用（预算键缺席时不传字段，值 0 也没有判据意义）。
    if (value === undefined || limit === undefined || limit <= 0) return;
    tracks.push({ track, ...PROBE_TRACK_NAMES[track], value, limit });
  };
  push("eventTickLimit", peakUsage.eventCount, limits.eventTickLimit);
  push("apiCallTickLimit", peakUsage.apiCalls, limits.apiCallTickLimit);
  push("memoryTickCeiling", peakUsage.memoryBytes, limits.memoryTickCeiling);
  return tracks;
};

/** 一个读数怎么写进文案：计数按整数，内存按 MB（一位小数），都带占用比例。 */
const describeTrack = (track: ProbeTrack, form: "label" | "short"): string => {
  const percent = `${String(Math.round((track.value / track.limit) * 100))}%`;
  const name = form === "label" ? track.label : track.short;
  const value =
    track.track === "memoryTickCeiling"
      ? `${(track.value / MIB).toFixed(1)}/${(track.limit / MIB).toFixed(1)} MB`
      : `${String(track.value)}/${String(track.limit)}`;
  return `${name} ${value}（${percent}）`;
};

/** 探针报告：三档文案里选一档，并把判定一起交回（退出码与文案必须同源）。 */
export type ProbeReport = {
  /** 逐字回喂给模型的那段话（唯一允许回喂的内容）。 */
  readonly text: string;
  /** 前 N 场在候选座位上看轨的判定（`evaluate` 的零容忍规则，一个字不改）。 */
  readonly verdict: TrialVerdict;
  /** 有轨贴边（≥ `PROBE_NEAR_LIMIT_RATIO`）或已越线。 */
  readonly nearLimit: boolean;
};

/**
 * 探针的三档文案（`probe` 工具回给模型的那一段）。
 *
 * ── 三档，不是两档 ──
 *
 * **已越线**：与 `evaluate` 拦下时**逐字同源**（`renderBlockedTrip`），只说"哪项预算、第几场
 * 第几 tick、怎么改"。**贴边**（任一条轨 ≥ 80%）：没越线但换个地图或组合就可能越线，这一档
 * 是"绿色也有信息量"的落点。**充裕**（全部 < 80%）：把三条轨的最坏读数一起报出来。
 *
 * ── 后两档必须自带两句免责 ──
 *
 * 1. **这不等于整张网格通过**：探针只跑前缀，窗外那些场若越线 `evaluate` 仍会拦下；
 * 2. **漏检率**：真档四例预算触限里，前缀只抓得到一半。
 *
 * 两句都不是客套：没有它们，"探针绿了"会被读成"整张网格过了"，而那是 50% 的错误率。
 * N=8 与 80% 的来历、以及那四例的场号与 2/4 只写在 `@model-war/schema` 的 `probe-limits.ts`
 * （它头注的漏检率一段是那组读数的唯一一份：这一格与 `host/probe-service.ts` 都只说结论）。
 *
 * ── 后两档还有第三句：读数对应的是**哪一版**脚本 ──
 *
 * 探针量的是**当前**脚本，而读数会被模型带过好几步。真档（mimo 2026-11-20 那场）第 18 步读到
 * 充裕 60%，第 19–20 步整份重写脚本，第 22 步**没再 probe** 就 `evaluate`——评的是新脚本，手里
 * 是旧读数，于是第二次 `evaluate`（总共三次）直接被拦在第 6 场。所以有读数的那两档都要说一句
 * 「改过脚本就重新 probe」。
 *
 * 三档里**只有已越线档不说这句**：那一档回的是 `renderTrialFeedback` 的逐字复用话术（越线时
 * 该做的是改，不是复测），加一句就与 `evaluate` 的拦下文案不再同源。
 */
export const probeReportOf = (options: {
  readonly plan: TrialPlan;
  /** 实际跑了几场（探针的前缀场数，通常 `PROBE_MATCH_LIMIT`）。 */
  readonly matchCount: number;
  readonly trips: readonly RecordedTrip[];
  /** 候选座位逐 tick 的最坏占用读数；缺席 = 一条都没采到。 */
  readonly peakUsage?: PeakUsageReading;
  readonly limits?: ProbeLimits;
}): ProbeReport => {
  const covered = options.plan.matches.slice(0, Math.max(0, options.matchCount));
  const shape =
    `${String(new Set(covered.map((match) => match.comboIndex)).size)} 组组合 × ` +
    `${String(new Set(covered.map((match) => match.candidateSeat)).size)} 座位 × ` +
    `${String(new Set(covered.map((match) => match.map)).size)} 地图`;
  const head = `probe：前 ${String(options.matchCount)} 场（${shape}）跑完。`;
  // ── 判定的窗口是**前 matchCount 场**，这是探针的契约 ──
  //
  // 窗口外的触限不进判定：探针只跑前缀，它回答的是"这 N 场怎么样"。那 N 场之外的场次有没有
  // 越线，探针**不知道**——这正是每份文案都带「这不等于整张 32 场通过」的理由。真实调用点
  // （`runTrialGridSubset`）本来就只产窗口内的 trips，这条过滤是窗口定义，不是"顺手丢点东西"。
  const windowed = options.trips.filter((trip) => trip.matchIndex < options.matchCount);
  // 座位按**完整计划**查（`candidateSeatOfPlan` 缺项即抛），不看有没有被裁过。
  const verdict = verdictOfTrips(windowed, candidateSeatOfPlan(options.plan));
  if (!verdict.passed) {
    // 拦下那一段与 `evaluate` **逐字相同**（含"32 场试跑零容忍"那句：零容忍规则是整张网格的
    // 规则，不因为探针只跑了前缀而变）。
    return {
      text: `${head}**已经越线**：整张网格的 evaluate 会照同一段话术拦下。\n${renderBlockedTrip(
        verdict.trip,
        options.plan.matches.length,
      )}`,
      verdict,
      nearLimit: true,
    };
  }

  const total = options.plan.matches.length;
  const remaining = Math.max(0, total - options.matchCount);
  const disclaimer =
    `**这不等于整张 ${String(total)} 场通过**：另 ${String(remaining)} 场若越线，` +
    "evaluate 仍会拦下。";
  // 漏检率那句只说**事实**（前缀只抓得到一半），不逐场列号：四个场号与 2/4 的唯一一份在
  // `@model-war/schema` 的 `probe-limits.ts` 头注。模型需要的只是"绿了也不等于赢了"，不需要
  // 知道老档里那四例是哪几场（那是给人查的证据，不是给它看的任务）。
  const missRate =
    `漏检率：真档四例预算触限里，前 ${String(PROBE_MATCH_LIMIT)} 场只抓得到两例（2/4）——` +
    "另外两例落在窗口外，这一次的读数看不到它们。";
  // 有读数的两档共用这一句（来历见函数头注第三段）：防止模型拿旧读数去 evaluate 新脚本。
  const retest =
    "改过脚本之后要重新 probe 再 evaluate：否则 evaluate 评的是新脚本，" +
    "而你手上这份读数是上一版脚本的。";

  const tracks = probeTracksOf(options.peakUsage, options.limits ?? {});
  if (tracks.length === 0) {
    return {
      text: `${head}最坏读数：这一轮没采到任何占用读数（缺席不是「用了 0」）。\n${disclaimer}\n${missRate}`,
      verdict,
      nearLimit: false,
    };
  }
  const near = tracks.filter((track) => track.value >= track.limit * PROBE_NEAR_LIMIT_RATIO);
  if (near.length > 0) {
    const readings = near.map((track) => describeTrack(track, "label")).join("、");
    return {
      text:
        `${head}最坏读数：${readings}。**已经贴边**：换个地图或组合就可能越线，` +
        `建议先降下来再 evaluate。\n${retest}\n${disclaimer}\n${missRate}`,
      verdict,
      nearLimit: true,
    };
  }
  const readings = tracks.map((track) => describeTrack(track, "short")).join("、");
  return {
    text: `${head}最坏读数：${readings}。` + `${retest}\n${disclaimer}\n${missRate}`,
    verdict,
    nearLimit: false,
  };
};

/** 只取文案（多数调用点只要这一段）。 */
export const renderProbeFeedback = (options: Parameters<typeof probeReportOf>[0]): string =>
  probeReportOf(options).text;
