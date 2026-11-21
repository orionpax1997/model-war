/**
 * 生成归档的只读报告边界（CONTEXT《冻结脚本》《校验失败记录》）。
 * 与赛季排名报告同属 runner；不加载脚本、不执行对局、不依赖 gen/engine。
 *
 * 完整合计要求每个实际协议轮都有该字段；部分数据另给小计与覆盖轮数。
 * usage 只保留白名单数字与固定来源，cache/reasoning 只作为明细；观测精确读旁挂 basename，
 * 不把回喂前 round 文件并入最后完成试跑（旧档可能在 infra 后留旧数据）。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  USAGE_NUMERIC_FIELDS,
  USAGE_READING_PATHS,
  USAGE_ANTHROPIC_INPUT_PATHS,
  USAGE_BILLING_INPUT_PATHS,
  ACTION_API_NAMES,
  ACTION_ERROR_CODES,
  ACTION_EFFECT_NAMES,
  ARCHIVE_OPTIMIZATION_CANDIDATE_AGENT_JSON_SCHEMA,
  ARCHIVE_OPTIMIZATION_CANDIDATE_JSON_SCHEMA,
  ARCHIVE_SELECTION_JSON_SCHEMA,
  OPTIMIZATION_AGENT_VERSION,
  OPTIMIZATION_CANDIDATE_LIMIT,
  OPTIMIZATION_GRID_VERSION,
  OPTIMIZATION_STAGES,
  SELECTION_AGENT_VERSION,
  SELECTION_VERSION,
  TRIAL_PLAN_JSON_SHAPE,
  TRIAL_GRID_SUMMARY_SUFFIX,
  TRIAL_SCRIPT_ID_SEPARATOR,
  TRIAL_SUBSTITUTE_SOURCE_SUFFIX,
  type ArchiveOptimization,
  type ArchiveOptimizationCandidateAgent,
  type ArchiveSelection,
  type SelectionAgentCandidate,
  type SelectionAgentIdentity,
  type SelectionCandidate,
  type SelectionPlan,
  type SelectionCandidateIdentity,
  type SelectionGridCandidate,
  type TrialGridScore,
  type TrialPlan,
  FAILURE_RECORD_PREFIX,
  OBSERVATIONS_FILE_PREFIX,
  TRIAL_CANDIDATE_SEAT,
  TRIAL_OBSERVATION_JSON_SCHEMA,
  TRIAL_PLAYER_IDS,
  TRIAL_SEEDS,
  type ArchiveOptimizationCandidate,
  type TrialObservationLine,
} from "@model-war/schema";

import {
  archiveShapeVersionOf,
  isAgentShape,
  isLegacyOptimization,
  isLegacySelection,
  optimizationMetaOf,
} from "./archive-optimization.js";
import {
  archiveShapeOf,
  contaminationOf,
  CONTAMINATION_THRESHOLDS,
  stepsOf,
  stepGroupsOf,
  type ReportArchiveShape,
  type ReportContamination,
  type ReportPercentiles,
  type ReportSteps,
} from "./archive-report-steps.js";
import { buildSelectionPlan } from "./selection.js";
import { checkTrialPlan, readTrialPlan } from "./trial-plan.js";
import {
  objectOf,
  numberOf,
  paramsOf,
  type ReportObservationInput,
  requestEvidenceOf,
  stopEvidenceOf,
  attemptFailureKindOf,
  failureClassificationOf,
  usageEnumOf,
  observationEvidenceOf,
  type ObservationMatch,
  type ReportRequestEvidence,
} from "./archive-report-evidence.js";

/**
 * 选拔候选的分数投影：v1 把总分 / 均分 / 分母摊在候选自己身上，v2 / v3 把它们收进 `score`
 * （生成阶段那张网格的分数）。**三版的分数口径不同**（v1 = 选拔自有的 12 场单图；
 * v2 / v3 = 生成阶段 32 场网格的读数），所以它只是一处「选拔读数」，不进三类分数分列，
 * 分列见 `ReportCandidateScores`。
 */
const selectionCandidateScoreOf = (
  candidate: SelectionCandidate | SelectionGridCandidate | SelectionAgentCandidate,
): TrialGridScore =>
  "score" in candidate
    ? candidate.score
    : {
        totalPoints: candidate.totalPoints,
        averagePoints: candidate.averagePoints,
        countedMatches: candidate.countedMatches,
      };

/**
 * v3 的候选 → 报告内部使用的同形候选：**位置读成 `stage`、步号读成 `protocolRound`**。
 *
 * 这是位次映射，不是把「阶段」这个概念偷回来：ADR-0031 定的是「候选的数组下标就是第几次
 * `evaluate`」，而报告这一侧需要的恰好是「第几个候选」。把 `stage` 这个**报告字段名**的收口
 * （换成步级列）留在度量票（07），本票只保证「候选按位置可读」。
 *
 * `position` 只能取 0..2（候选上限就是配额 3），所以越界不该发生——但「不该发生」不是
 * 一个类型,把它写成 `as 0 | 1 | 2` 会让越界静默读成一个不存在的阶段。这里逐个认,认不出就
 * 大声失败。
 */
const stageOfPosition = (position: number): 0 | 1 | 2 => {
  if (position === 0) return 0;
  if (position === 1) return 1;
  if (position === 2) return 2;
  throw new Error(
    `v3 候选位置 ${String(position)} 越界：候选上限是 ${String(OPTIMIZATION_CANDIDATE_LIMIT)} 条`,
  );
};

const projectAgentCandidate = (
  candidate: ArchiveOptimizationCandidateAgent,
  position: number,
): ArchiveOptimizationCandidate => ({
  stage: stageOfPosition(position),
  protocolRound: candidate.step,
  scriptFile: candidate.scriptFile,
  observationsFile: candidate.observationsFile,
  scriptSha256: candidate.scriptSha256,
  ...(candidate.params === undefined ? {} : { params: candidate.params }),
  score: candidate.score,
  matchCount: candidate.matchCount,
});

/** 优化段 → 报告内部同形候选（v1 / v2 原样；v3 按位置投影）。 */
const reportCandidatesOf = (
  optimization: ArchiveOptimization | undefined,
): readonly ArchiveOptimizationCandidate[] => {
  if (optimization === undefined) return [];
  if (optimization.version !== OPTIMIZATION_AGENT_VERSION) return optimization.candidates;
  return optimization.candidates.map(projectAgentCandidate);
};

/** 不适用（非零、非空）：某类分数不属本档口径时用它。 */
const NOT_APPLICABLE_SCORE: ReportScoreReading = {
  state: "not-applicable",
  totalPoints: null,
  averagePoints: null,
  countedMatches: null,
};

/** 计划的事实投影（种子 / 场数）。判据：v1 的选拔计划有 `seeds`，v2 就是生成阶段那张网格。 */
const planFactsOf = (
  plan: SelectionPlan | TrialPlan,
): { readonly seeds: readonly number[]; readonly matchesPerCandidate: number } =>
  "seeds" in plan
    ? { seeds: [...plan.seeds], matchesPerCandidate: plan.matchesPerCandidate }
    : {
        seeds: plan.matches.map((match) => match.seed),
        matchesPerCandidate: plan.matchesPerCandidate,
      };

/**
 * 网格分数的读数。
 *
 * v2 的 schema 把 `score` 写进 **required**，装载期（`optimizationMetaOf`）先把缺项的档拖掉了；
 * 走到这里还缺，就明确报错而不是补零——报告从不把「没记」说成「零分」。
 */
const gridScoreOf = (score: TrialGridScore | undefined): ReportScoreReading => {
  if (score === undefined) throw new Error("网格候选缺少分数，归档报告不补零");
  return {
    state: "recorded",
    totalPoints: score.totalPoints,
    averagePoints: score.averagePoints,
    countedMatches: score.countedMatches,
  };
};

/** v1 历史档的选拔读数（12 场单图口径，摊在候选自己身上）。 */
const legacyScoreReadingOf = (candidate: SelectionCandidate | undefined): ReportScoreReading => {
  if (candidate === undefined) throw new Error("选拔候选缺少分数，归档报告不补零");
  return {
    state: "recorded",
    totalPoints: candidate.totalPoints,
    averagePoints: candidate.averagePoints,
    countedMatches: candidate.countedMatches,
  };
};

/** 两读是否逐位相同（分母也算：分母不同的均分不可比）。 */
const sameScoreReading = (a: ReportScoreReading, b: ReportScoreReading): boolean =>
  a.state === "recorded" &&
  b.state === "recorded" &&
  a.totalPoints === b.totalPoints &&
  a.averagePoints === b.averagePoints &&
  a.countedMatches === b.countedMatches;

/**
 * 三类分数分列：生成阶段 / 选拔复算 / 赛季，一个候选一行。
 *
 * 三者**不互相替代**：
 * - 生成阶段分数（v2 才有）= 生成阶段跑的那张网格的平均名次积分，分母 32；
 * - 选拔复算读数 = 独立子进程重跑同一张网格得到的分数，只作校验（装载期已强制逐位相同）；
 * - 赛季分数属赛季报告口径（`runs/` 的排名），归档报告恒写**不适用**，不用上面两类冒充。
 * v1 历史档没有网格分数，所以它的生成阶段写不适用、选拔读数就是它自己的 12 场口径。
 */
const candidateScoresOf = (
  optimization: ArchiveOptimization | undefined,
  selection: ArchiveSelection | undefined,
): readonly ReportCandidateScores[] => {
  if (optimization === undefined) return [];
  // v2 / v3 都有网格分数（v3 的候选把分数直接写在身上）；v1 历史档没有。
  const grid = !isLegacyOptimization(optimization);
  return reportCandidatesOf(optimization).map((candidate, index) => {
    const generation = grid ? gridScoreOf(candidate.score) : NOT_APPLICABLE_SCORE;
    const selectionReading =
      selection === undefined
        ? NOT_APPLICABLE_SCORE
        : isLegacySelection(selection)
          ? legacyScoreReadingOf(selection.candidates[index])
          : gridScoreOf(selection.candidates[index]?.score);
    return {
      stage: candidate.stage,
      protocolRound: candidate.protocolRound,
      scriptSha256: candidate.scriptSha256,
      sourceSha256: selection?.candidates[index]?.sourceSha256 ?? null,
      reusedFromStage: candidate.reusedFromStage ?? null,
      generation,
      selection: selectionReading,
      season: NOT_APPLICABLE_SCORE,
      agreement: sameScoreReading(generation, selectionReading) ? "identical" : "unavailable",
    };
  });
};

/**
 * 网格计划 → 报告投影（不搬 32 场明文）。
 *
 * 「跟谁打」= `scripts` + 每个组合的 `sitOut`；「坐哪」= 每个组合的 `candidateSeats`；
 * 「哪张图」= `maps` 与每个组合的 `maps`。逐场细节（哪个种子、哪一号位）以 `source` 指向的
 * 计划正文为准——报告不复写一份。
 */
const gridPlanReportOf = (plan: TrialPlan, source: string): ReportGridPlan => {
  const scriptIds = plan.scripts.map((script) => script.id);
  const combos = [...new Set(plan.matches.map((match) => match.comboIndex))]
    .sort((a, b) => a - b)
    .map((comboIndex) => {
      const matches = plan.matches.filter((match) => match.comboIndex === comboIndex);
      // 轮空的是「四份身份里这个组合一次也没上场的那个」；对不上就不猜。
      const seated = new Set(matches.flatMap((match) => match.seats));
      const absent = scriptIds.filter((id) => !seated.has(id));
      return {
        comboIndex,
        sitOut: absent.length === 1 ? absent[0]! : null,
        firstMatchIndex: Math.min(...matches.map((match) => match.matchIndex)),
        matchCount: matches.length,
        candidateSeats: [...new Set(matches.map((match) => match.candidateSeat))].sort(
          (a, b) => a - b,
        ),
        maps: [...new Set(matches.map((match) => match.map))],
      };
    });
  return {
    kind: "grid",
    version: plan.version,
    planSha256: plan.planSha256,
    source,
    matchesPerCandidate: plan.matchesPerCandidate,
    seeds: plan.matches.map((match) => match.seed),
    maps: plan.maps.map(({ name, sha256 }) => ({ name, sha256 })),
    scripts: plan.scripts.map(({ id, role, source: from, scriptSha256 }) => ({
      id,
      role,
      source: from,
      scriptSha256,
    })),
    combos,
  };
};

/** v1 选拔计划 → 报告投影（12 场单图 / 三份基准 / 种子 401–403）。 */
const legacySelectionPlanReportOf = (
  plan: SelectionPlan,
  source: string,
): ReportLegacySelectionPlan => ({
  kind: "legacy-selection",
  version: plan.version,
  planSha256: plan.planSha256,
  source,
  matchesPerCandidate: plan.matchesPerCandidate,
  seeds: [...plan.seeds],
  map: { name: plan.map, sha256: plan.mapSha256 },
  baselines: plan.baselines.map(({ id, scriptSha256 }) => ({ id, scriptSha256 })),
});

export type ReportTotal = {
  readonly value: number | null;
  readonly recordedTotal: number | null;
  readonly recordedRounds: number;
  readonly expectedRounds: number;
};

/**
 * 缓存命中率的合计。比率不可相加，分母单列：只累加「缓存读与总输入都记到」的轮，
 * 缺项不补零；覆盖不完整时 `value` 保持 null，与加总型 `ReportTotal` 同一口径。
 */
export type ReportCacheHitRate = {
  readonly value: number | null;
  readonly recordedValue: number | null;
  readonly cacheReadTotal: number | null;
  readonly inputTotal: number | null;
  readonly recordedRounds: number;
  readonly expectedRounds: number;
};

export type UsageReading = {
  readonly value: number | null;
  readonly source: string | null;
  readonly state: "recorded" | "missing" | "null" | "invalid" | "unknown";
  readonly semantic: "total-input" | "unknown" | null;
  readonly conflict: boolean;
  readonly candidates: readonly { readonly source: string; readonly value: number | null }[];
};
export type ReportUsage = Readonly<
  Record<
    "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite5m" | "cacheWrite1h" | "reasoning",
    UsageReading
  >
>;

/** 缓存写的 TTL 分档：组成明细，只对 Anthropic 族有值。 */
const TTL_WRITE_FIELDS = ["cacheWrite5m", "cacheWrite1h"] as const;

export type ArchiveReportRound = {
  readonly round: number;
  readonly sendMs: number | null;
  /**
   * 这一轮的退避等待（毫秒）。ADR-0036 定的记账字段：`sendMs` 含退避，而 deadline 按不含退避的
   * 口径判，所以退避要单独可读。生成侧今天还不写这一格 → `null`，不补零。
   */
  readonly backoffMs: number | null;
  readonly responseConverged: boolean;
  readonly params: ReturnType<typeof paramsOf>;
  readonly requestEvidence: ReportRequestEvidence;
  readonly stop: ReturnType<typeof stopEvidenceOf>;
  readonly attempts: readonly ReportAttempt[];
  readonly attemptCoverage: "recorded" | "missing" | "partial";
  readonly usageState: "missing" | "null" | "recorded" | "invalid";
  readonly usage: ReportUsage;
  /** 缓存读 / 总输入；缺任一项或分母为零时为 null（不把缺数据读成 0% 命中）。 */
  readonly cacheHitRate: number | null;
};

export type ReportAttempt = {
  readonly attempt: number;
  readonly outcome: "response" | "transport-error";
  /**
   * 传输失败的细分（ADR-0036）：`rate-limited` / `server` / `network` / `timeout`。
   * 成功尝试与历史档为 `null`——**「重试救回来的 429」也带它**，否则限流压力在数据里不存在。
   */
  readonly failureKind: "rate-limited" | "server" | "network" | "timeout" | null;
  readonly stop: ReturnType<typeof stopEvidenceOf>;
  readonly usage: ReportUsage;
};

export type ReportObservations = {
  readonly state: "recorded" | "missing" | "empty" | "partial" | "unreadable";
  readonly source: string;
  readonly observedMatches: number | null;
  readonly noScoreSource: number | null;
  readonly readings: readonly TrialObservationLine[];
  readonly issues: readonly { readonly line: number; readonly reason: string }[];
};

/**
 * 三类分数里的一类。
 *
 * **`not-applicable` 与「零分」是两件事**：某类分数不属本档口径时写不适用（各顶点皆 `null`），
 * 绝不用 `0` 或空串顶上；台账里真没有这个读数时装载端先拖（见 `gridScoreOf`），不靠报告补零。
 */
export type ReportScoreReading =
  | {
      readonly state: "recorded";
      readonly totalPoints: number;
      readonly averagePoints: number;
      readonly countedMatches: number;
    }
  | {
      readonly state: "not-applicable";
      readonly totalPoints: null;
      readonly averagePoints: null;
      readonly countedMatches: null;
    };

/**
 * 每个候选一行：身份 + 同字节复用来源 + **三类分数分列**（互不替代）。
 *
 * - `generation`：生成阶段那张网格的平均名次积分（分母 32，来自 `optimization.candidates[].score`）。
 * - `selection`：选拔独立子进程全量复算的读数，**只作校验**，不是第二个排名依据。
 *   v2 的 `agreement` 恒为 `identical`（装载期已逐位比对）；v1 历史档没有网格分数，写 `unavailable`。
 * - `season`：属赛季报告口径（`runs/` 的赛季排名），归档报告不得用上面任一类冒充，恒写不适用。
 */
export type ReportCandidateScores = {
  readonly stage: number;
  readonly protocolRound: number;
  /** 编译产物摘要：三阶段是否字节相同，看这一列与 `reusedFromStage`。 */
  readonly scriptSha256: string;
  /** 对应阶段的原始 TS 摘要；没有选拔段时 `null`（不补）。 */
  readonly sourceSha256: string | null;
  /** 编译产物与更早阶段相同时，复用的是哪一阶段的网格结果；`null` = 本轮自己跑了网格。 */
  readonly reusedFromStage: number | null;
  readonly generation: ReportScoreReading;
  readonly selection: ReportScoreReading;
  readonly season: ReportScoreReading;
  /** 生成与选拔两读的关系；`unavailable` = 两读至少一侧不属本档口径。 */
  readonly agreement: "identical" | "unavailable";
};

/** 计划里的一张图（名字 + 内容摘要）。 */
export type ReportPlanMap = { readonly name: string; readonly sha256: string };

/** 计划里的一份陪练身份（与存档 `sparring[]` 同形）。 */
export type ReportPlanScript = {
  readonly id: string;
  readonly role: string;
  readonly source: string;
  readonly scriptSha256: string;
};

/**
 * 一个候选**旁挂网格汇总**（`<观测文件>.grid.json`）里的陪练身份。
 *
 * ── 为什么报告要去读旁挂件 ──
 * v3 分步档的优化段不装计划（ADR-0035 / ADR-0031），于是「这 32 场跟谁打」在存档 `meta`
 * 里根本没有。但执行器跑每一次 `evaluate` 都把整份计划写在了观测文件旁的 `.grid.json` 里
 * （`packages/gen/src/trial-grid.ts`）：报告只**读**它，不新增采集、不改档案形状。
 *
 * ── 只记录不裁决 ──
 * 跨会话分数可不可比是 A2 的事。这里只回答三件事：跟谁打（四份身份）、计划是哪一份
 * （`planSha256`）、在位那份是不是**本席位自己的上一场**。最后一条不自带走：`selfReference`
 * 只在两个条件同时成立时非 `null`（见 `sparringSelfReferenceOf`）。
 */
export type ReportCandidateSparring = {
  /** 这条证据属于哪个候选（v3 里就是那次 `evaluate` 的步号）。 */
  readonly protocolRound: number;
  /** 旁挂汇总在档里的相对位置（`<目录>/<观测文件>.grid.json`）。 */
  readonly source: string;
  /** 计划摘要；读不到时 `null`。 */
  readonly planSha256: string | null;
  /**
   * 四份陪练身份（`id` / `role` / `source` / `scriptSha256`）；**`null` = 读不到**。
   *
   * 文件不在 / 没有 `plan` / 形状不合，一律是 `null`——渲染成「未记录」，不猜、不抛。
   */
  readonly scripts: readonly ReportPlanScript[] | null;
  /** 自指：在位陪练就是本席位的上一场冻结存档。 */
  readonly selfReference: ReportSparringSelfReference | null;
};

/** 「陪练 = 本席位上一场」的那一场：席位与运行标识（两个都进报告，不只看 runId）。 */
export type ReportSparringSelfReference = {
  readonly slug: string;
  readonly runId: string;
};

/**
 * 一个「轮空一份陪练」组合的覆盖范围。
 *
 * 报告**不搬 32 场明文**：计划正文就在 `ReportGridPlan.source` 指向的存档里；这里只给
 * 「跟谁打、坐哪、哪张图」的直读摘要（组合 → 谁轮空 / 哪几张图 / 覆盖哪几场）。
 */
export type ReportPlanCombo = {
  readonly comboIndex: number;
  /** 该组合里一次也没上场的那份陪练 id；与四份身份对不上时 `null`（不猜）。 */
  readonly sitOut: string | null;
  /** 该组合的第一场与场数；逐场座位/种子/地图以计划正文为准。 */
  readonly firstMatchIndex: number;
  readonly matchCount: number;
  /** 该组合里候选坐过的座位（升序；v2 恒为 0/1/2/3）。 */
  readonly candidateSeats: readonly number[];
  /** 该组合跑过的图名（顺序即计划顺序）。 */
  readonly maps: readonly string[];
};

/**
 * 网格计划（v2）的报告投影。
 *
 * 四份陪练身份、两张图、计划版本与 `planSha256` 都在这里；`source` 是计划正文在档里的
 * JSON 指针（`<记录来源>#optimization.plan` 或 `#selection.plan`），复现就从那里读。
 */
export type ReportGridPlan = {
  readonly kind: "grid";
  /** 计划形状版本（`TrialPlan.version`），不是存档或观测行的版本。 */
  readonly version: number;
  readonly planSha256: string;
  readonly source: string;
  readonly matchesPerCandidate: number;
  /** 逐场种子（计划顺序）；v2 网格每格一个固定值。 */
  readonly seeds: readonly number[];
  readonly maps: readonly ReportPlanMap[];
  readonly scripts: readonly ReportPlanScript[];
  readonly combos: readonly ReportPlanCombo[];
};

/**
 * 历史档（v1）选拔计划的报告投影：12 场单图、三份基准、种子 401–403。
 *
 * 不做成网格的「退化成单值」形状：历史档没有变，变的是报告不再把 v2 往这几个单值栏位里塞。
 */
export type ReportLegacySelectionPlan = {
  readonly kind: "legacy-selection";
  readonly version: typeof SELECTION_VERSION;
  readonly planSha256: string;
  readonly source: string;
  readonly matchesPerCandidate: number;
  readonly seeds: readonly number[];
  readonly map: ReportPlanMap;
  readonly baselines: readonly { readonly id: string; readonly scriptSha256: string }[];
};

/**
 * 一个候选一行。
 *
 * `params` **不是**存档里那份端点原生参数，而是与逐轮日志同一套白名单投影（见 `paramsOf`）：
 * 存档原值只能断定数值 / 布尔 / 已知枚举那几格，`stop` / `logit_bias` 的内容与白名单外的键
 * 不进报告（hld §8.3）。旧档没有这栏就不写，不追填。
 */
export type ReportCandidate = Omit<ArchiveOptimizationCandidate, "params"> & {
  readonly params?: ReturnType<typeof paramsOf>;
  readonly scriptSource: string;
  readonly scriptState: "verified" | "missing" | "unreadable" | "mismatch";
  readonly actualScriptSha256: string | null;
  readonly observations: ReportObservations;
};

export type ArchiveReport = {
  readonly initialCandidate: ReportCandidate | null;
  readonly intermediateCandidates: readonly ReportCandidate[];
  readonly finalCandidate: ReportCandidate | null;
  /** 最后生成阶段与实际冻结阶段分别保留；旧档冻结第三阶段。 */
  readonly frozenCandidate: ReportCandidate | null;
  readonly selection: {
    /**
     * 选拔记录版本：1 = 历史档（12 场 / 三基准 / 单图），2 = 评测网格（32 场 / 四陪练 / 两图），
     * 3 = 分步形态（同一张网格，但胜者指向**候选序里的某一位**而不是某个阶段）。
     * 计划口径按 `plan.kind` 分流，且**不互相冒充**（见 `ReportGridPlan` / `ReportLegacySelectionPlan`）。
     *
     * 下面那些 `stage` / `protocolRound` 字段在 v3 档里读作「候选序位置」与「步号」——字段名
     * 的收口（换成步级列）归度量票 07。
     */
    readonly version: 1 | 2 | 3;
    readonly stage: number;
    readonly protocolRound: number;
    readonly scriptSha256: string;
    readonly sourceSha256: string;
    /** 胜者的选拔读数；与生成阶段网格分数逐位相同时才与 `scores` 一致。 */
    readonly averagePoints: number;
    readonly countedMatches: number;
    readonly reason: string;
    readonly planSha256: string;
    readonly distinctScripts: number;
    readonly reusedFromStage: number | null;
    /**
     * 每个候选的选拔读数（身份 + 分数）；三类分数的分列视图是 `scores`，两处同源。
     *
     * `stage` 在这一层是**位置**（不是 `0|1|2` 的阶段号）：v3 的候选没有 `stage` 字段，
     * 报告按候选序下标填它。`protocolRound` 同理在 v3 里读作步号。
     */
    readonly candidates: readonly {
      readonly stage: number;
      readonly protocolRound: number;
      readonly scriptSha256: string;
      readonly sourceSha256: string;
      readonly averagePoints: number;
      readonly totalPoints: number;
      readonly countedMatches: number;
      readonly reusedFromStage: number | null;
    }[];
    readonly executedMatches: number;
    readonly reusedMatches: number;
    readonly rulesetSha256: string;
    readonly sandboxRuntimeHash: string;
    /** 选拔计划：v2 就是生成阶段那张网格（`planSha256` 相同），v1 是选拔自有的 12 场单图。 */
    readonly plan: ReportGridPlan | ReportLegacySelectionPlan;
  } | null;
  readonly selectionFailure: {
    readonly planSha256: string;
    readonly seeds: readonly number[];
    readonly matchesPerCandidate: number;
    readonly candidates: readonly SelectionCandidateIdentity[];
  } | null;
  /**
   * 生成阶段计划：v2 才有（v1 历史档没有计划字段，不迁移、不回填）。`null` = 不适用。
   */
  readonly plan: ReportGridPlan | null;
  /**
   * 各候选旁挂网格汇总（`<观测文件>.grid.json`）里的陪练身份（v3 才有，旧档为空数组）。
   *
   * 一个候选一条：v3 每次 `evaluate` 各跑一张网格，各自的旁挂件是那一次的证据。
   * 空数组 = 本档没有可读的计划（v1 / v2 的计划在 `plan` 那一节）。
   */
  readonly sparring: readonly ReportCandidateSparring[];
  /** 三类分数分列，每个候选一行；没有优化旁证（失败档等）时为空数组。 */
  readonly scores: readonly ReportCandidateScores[];
  readonly candidateStages: number;
  readonly distinctScripts: number;
  readonly runScope: "current-run" | "historical" | "unscoped";
  readonly budget: {
    readonly model: {
      readonly convergedResponses: number;
      readonly recordedAttempts: number;
      readonly attemptEvidenceRounds: number;
      readonly expectedAttemptEvidenceRounds: number;
      readonly responseAttemptsWithUsage: number;
      readonly transportErrors: number;
      readonly unknownConsumptionAttempts: number;
      readonly maximumConvergedResponses: number | null;
      readonly maximumResponsesPerStage: number | null;
    };
    readonly local: {
      readonly optimizationObservedMatches: number | null;
      readonly selectionMaximumMatches: number | null;
      readonly selectionExecutedMatches: number | null;
      readonly selectionReusedMatches: number | null;
    };
  };
  readonly kind: "success" | "failure";
  readonly model: string;
  /** 生成时的模型版本；与 `shape.harnessDigest` 一起构成步级分位的分组维度。 */
  readonly modelVersion: string | null;
  readonly runId: string;
  readonly source: string;
  /**
   * 档案形状的读法分派与形状事实（ADR-0031 / ADR-0029）。
   *
   * `archiveSchemaVersion: "legacy"` 是**分派结果**而不是历史档的一个字段：旧档没有这一格，
   * 报告按它决定「要不要渲染步列」。
   */
  readonly shape: ReportArchiveShape;
  /**
   * 过程记录与步级度量。`null` = 这一档没有过程记录（v1 / v2 历史档）——**不是零步**：
   * 零步会话是 `steps` 在场、`entries: []`（ADR-0031 的合法形状），两者不混用。
   */
  readonly steps: ReportSteps | null;
  /**
   * 受污染会话的分层（ADR-0036）。`null` = 这一档不属本口径（one-shot 档读不到不完整会话）。
   */
  readonly contamination: ReportContamination | null;
  readonly failure: {
    readonly classification: string;
    readonly diagnosticsCount: number;
  } | null;
  readonly observations: ReportObservations & {
    readonly candidate: "last-completed-trial" | "final-candidate" | null;
    readonly protocolRound: number | null;
  };
  readonly candidateObservations: readonly (ReportObservations & {
    readonly protocolRound: number;
  })[];
  readonly protocolRounds: number;
  readonly log: {
    readonly state: "complete" | "partial" | "empty";
    readonly recordedLines: number;
    readonly readableRounds: number;
    readonly issues: readonly {
      readonly line: number;
      readonly reason: string;
    }[];
  };
  readonly rounds: readonly ArchiveReportRound[];
  readonly totals: Readonly<Record<"sendMs" | keyof ReportUsage, ReportTotal>>;
  readonly cacheHitRate: ReportCacheHitRate;
};

const total = (values: readonly (number | null)[], expectedRounds: number): ReportTotal => {
  const recorded = values.filter((value): value is number => value !== null);
  const recordedTotal =
    recorded.length === 0 ? null : recorded.reduce((sum, value) => sum + value, 0);
  return {
    value: recorded.length === expectedRounds && expectedRounds > 0 ? recordedTotal : null,
    recordedTotal,
    recordedRounds: recorded.length,
    expectedRounds,
  };
};

const cacheHitRateTotal = (
  rounds: readonly ArchiveReportRound[],
  expectedRounds: number,
): ReportCacheHitRate => {
  const pairs = rounds
    .map((round) => cachePairOf(round.usage))
    .filter((pair): pair is { readonly read: number; readonly input: number } => pair !== null);
  const cacheReadTotal =
    pairs.length === 0 ? null : pairs.reduce((sum, pair) => sum + pair.read, 0);
  const inputTotal = pairs.length === 0 ? null : pairs.reduce((sum, pair) => sum + pair.input, 0);
  const recordedValue =
    cacheReadTotal === null || inputTotal === null ? null : cacheReadTotal / inputTotal;
  return {
    value:
      recordedValue !== null && pairs.length === expectedRounds && expectedRounds > 0
        ? recordedValue
        : null,
    recordedValue,
    cacheReadTotal,
    inputTotal,
    recordedRounds: pairs.length,
    expectedRounds,
  };
};

const pickUsageField = (usage: unknown, paths: readonly string[]): UsageReading => {
  const candidates = paths.flatMap((path) => {
    const parts = path.split(".");
    const key = parts.pop()!;
    // 独立执行数字白名单，不以生成端已经投影为信任依据（旧档可直接含原载荷）。
    const fields = USAGE_NUMERIC_FIELDS[parts.join(".") as keyof typeof USAGE_NUMERIC_FIELDS];
    if (fields === undefined || !(fields as readonly string[]).includes(key)) return [];
    const parent = parts.reduce<unknown>((value, part) => objectOf(value)[part], usage);
    return Object.hasOwn(objectOf(parent), key)
      ? [
          {
            source: `usage.${path}`,
            value: numberOf(objectOf(parent)[key]),
            state:
              objectOf(parent)[key] === null
                ? ("null" as const)
                : numberOf(objectOf(parent)[key]) === null
                  ? ("invalid" as const)
                  : ("recorded" as const),
          },
        ]
      : [];
  });
  const semantic = usageEnumOf(objectOf(usage).usage_semantic, "usage_semantic");
  const anthropicPath = (source: string): boolean =>
    source === "usage.input_tokens" ||
    source === "usage.output_tokens" ||
    source === "usage.cache_read_input_tokens" ||
    source === "usage.cache_creation_input_tokens" ||
    source.startsWith("usage.billing_usage.claude_usage.") ||
    source.startsWith("usage.output_tokens_details.") ||
    source.startsWith("usage.cache_creation.");
  const preferred = candidates.filter((candidate) =>
    semantic === "anthropic"
      ? anthropicPath(candidate.source)
      : semantic === "openai"
        ? !candidate.source.startsWith("usage.billing_usage.") &&
          candidate.source !== "usage.cache_read_input_tokens" &&
          candidate.source !== "usage.cache_creation_input_tokens"
        : true,
  );
  const selected = preferred[0] ?? candidates[0];
  const value = numberOf(selected?.value);
  const conflict =
    new Set(
      candidates.map((candidate) => numberOf(candidate.value)).filter((value) => value !== null),
    ).size > 1;
  if (conflict && (preferred.length === 0 || (semantic !== "openai" && semantic !== "anthropic")))
    return {
      value: null,
      semantic: "unknown",
      source: null,
      state: "unknown",
      conflict,
      candidates,
    };
  return {
    value,
    semantic: null,
    source: selected?.source ?? null,
    state:
      selected === undefined
        ? "missing"
        : selected.state === "null"
          ? "null"
          : value === null
            ? "invalid"
            : "recorded",
    conflict,
    candidates,
  };
};
const sumUsageFields = (raw: unknown, paths: readonly string[]): UsageReading => {
  const parts = paths.map((path) => pickUsageField(raw, [path]));
  const complete = parts.every((part) => part.value !== null);
  return {
    semantic: "total-input",
    value: complete ? parts.reduce((sum, part) => sum + (part.value ?? 0), 0) : null,
    source: paths.map((path) => `usage.${path}`).join(" + "),
    state: complete
      ? "recorded"
      : (parts.find((part) => part.state !== "recorded")?.state ?? "invalid"),
    conflict: false,
    candidates: parts.flatMap((part) => part.candidates),
  };
};
const normalizeUsage = (raw: unknown): ReportUsage => {
  let input = pickUsageField(raw, USAGE_READING_PATHS.input);
  const root = objectOf(raw);
  const semantic = usageEnumOf(root.usage_semantic, "usage_semantic");
  const openaiInput =
    semantic === "openai" ||
    (semantic === undefined && Object.hasOwn(objectOf(root.input_tokens_details), "cached_tokens"));
  const anthropicInput =
    semantic === "anthropic" ||
    (semantic === undefined &&
      (usageEnumOf(root.usage_source, "usage_source") === "anthropic" ||
        Object.hasOwn(root, "cache_read_input_tokens") ||
        Object.hasOwn(root, "cache_creation_input_tokens")));
  // messages 输入为未缓存量；完整输入须三项齐全，不能替缺缓存补零。
  input = { ...input, semantic: input.state === "unknown" ? "unknown" : "total-input" };
  if (semantic === "anthropic" || (!Object.hasOwn(root, "prompt_tokens") && anthropicInput)) {
    const paths = USAGE_ANTHROPIC_INPUT_PATHS;
    input = sumUsageFields(raw, paths);
  }
  if (
    !Object.hasOwn(root, "prompt_tokens") &&
    Object.hasOwn(root, "input_tokens") &&
    !anthropicInput &&
    !openaiInput
  ) {
    input = { ...input, value: null, state: "unknown", semantic: "unknown" };
  }
  if (
    !Object.hasOwn(root, "prompt_tokens") &&
    !Object.hasOwn(root, "input_tokens") &&
    Object.hasOwn(objectOf(objectOf(root.billing_usage).claude_usage), "input_tokens")
  ) {
    const paths = USAGE_BILLING_INPUT_PATHS;
    input = sumUsageFields(raw, paths);
  }
  return {
    input,
    output: pickUsageField(raw, USAGE_READING_PATHS.output),
    cacheRead: pickUsageField(raw, USAGE_READING_PATHS.cacheRead),
    cacheWrite: pickUsageField(raw, USAGE_READING_PATHS.cacheWrite),
    cacheWrite5m: pickUsageField(raw, USAGE_READING_PATHS.cacheWrite5m),
    cacheWrite1h: pickUsageField(raw, USAGE_READING_PATHS.cacheWrite1h),
    reasoning: pickUsageField(raw, USAGE_READING_PATHS.reasoning),
  };
};

/**
 * 命中率的分子分母对：缺任一项、分母为零、或缓存读比总输入还多是 null。
 * 后者说明字段口径对不上（不该发生），不据它算比率。逐轮与合计共用这一处判据。
 */
const cachePairOf = (
  usage: ReportUsage,
): { readonly read: number; readonly input: number } | null => {
  const read = usage.cacheRead.value;
  const input = usage.input.value;
  if (read === null || input === null || input <= 0 || read > input) return null;
  return { read, input };
};

/** 缓存命中率 = 缓存读 / 总输入；缺数据不读成 0%。 */
const cacheHitRateOf = (usage: ReportUsage): number | null => {
  const pair = cachePairOf(usage);
  return pair === null ? null : pair.read / pair.input;
};

// zod 的 JSON Schema 适配暂不支持 if/then/else；完整性关系在读入时检查。
// 其余形状（含可选属性、嵌套闭合键和计数范围）均来自共享真源。
const actionFactsShape = Object.fromEntries(
  Object.entries(TRIAL_OBSERVATION_JSON_SCHEMA.properties.actionFacts).filter(
    ([key]) => key !== "if" && key !== "then" && key !== "else",
  ),
);
const observationSchema = z.fromJSONSchema(
  JSON.parse(
    JSON.stringify({
      ...TRIAL_OBSERVATION_JSON_SCHEMA,
      properties: { ...TRIAL_OBSERVATION_JSON_SCHEMA.properties, actionFacts: actionFactsShape },
    }),
  ) as z.core.JSONSchema.JSONSchema,
);

/** 原异常只可映射回本地已知原因，不能成为另一条载荷回显通道。 */
const issueReasonOf = (cause: unknown, allowed: readonly string[], fallback: string): string =>
  cause instanceof Error && allowed.includes(cause.message) ? cause.message : fallback;

/**
 * 观测行的期待口径：两版档各有自己的「这一场是谁跟谁打」。
 *
 * - `legacy`：v1 历史档（三场单图、候选恒 0 号位、种子 101/202/303、三份基准），图表不变。
 * - `grid`：v2 网格档，种子/候选座位/四座选手全部逐场由计划给（`archive-meta.ts` 头注
 *   说的「网格档的计划口径」）。
 */
type ObservationCaliber =
  | { readonly kind: "legacy" }
  | { readonly kind: "grid"; readonly plan: TrialPlan }
  /**
   * `self` = **没有计划可核**（v3 的优化段不装计划，选拔段又缺席时就是这样）：每行按它自己
   * 给出的种子 / 座位 / 四座身份做行内自洽校验。它不是「独立核对」，所以不能与 `grid` 混用
   * 一个名字——那会让人以为这份档案的逐场身份被交叉验证过。
   */
  | { readonly kind: "self" };

/**
 * `self` 口径的期待身份：**由这一行自己给出**（种子与座位取行动事实，四座身份取终局四方）。
 *
 * 它只证明行内自洽，不证明「这一场就是计划里那一场」——后者要计划，而 v3 的优化段不装计划。
 * 取不到完整身份时返回 `undefined`，交给调用方按「无法核对」记 issue，而不是猜一个。
 */
const selfExpectationOf = (row: ReportObservationInput): ObservationMatch | undefined => {
  const facts = row.actionFacts;
  const summary = objectOf(row.terminalSummary);
  const players = Array.isArray(summary["players"]) ? summary["players"] : [];
  const seats = players.flatMap((player) => {
    const id = objectOf(player)["player"];
    return typeof id === "string" ? [id] : [];
  });
  const seed = facts?.seed ?? numberOf(summary["seed"]);
  if (seed === null || seats.length !== 4) return undefined;
  return {
    seed,
    candidateSeat: facts?.seat ?? TRIAL_CANDIDATE_SEAT,
    seats: [seats[0]!, seats[1]!, seats[2]!, seats[3]!],
  };
};

/** 按下标取这一场的期待身份；`undefined` = 这个下标不属这一档的计划（或口径要求行内自查）。 */
const expectedMatchOf = (
  caliber: ObservationCaliber,
  matchIndex: number,
  row: ReportObservationInput,
): ObservationMatch | undefined => {
  if (caliber.kind === "self") return selfExpectationOf(row);
  if (caliber.kind === "legacy") {
    const seed = TRIAL_SEEDS[matchIndex];
    return seed === undefined
      ? undefined
      : { seed, candidateSeat: TRIAL_CANDIDATE_SEAT, seats: TRIAL_PLAYER_IDS };
  }
  const match = caliber.plan.matches.find((entry) => entry.matchIndex === matchIndex);
  return match === undefined
    ? undefined
    : { seed: match.seed, candidateSeat: match.candidateSeat, seats: match.seats };
};

const observationsOf = (
  root: string,
  relative: string,
  options: {
    readonly caliber: ObservationCaliber;
    /** 候选自己那份编译产物摘要（`meta.scriptSha256`）；给了就逐行对。 */
    readonly scriptSha256?: string;
  },
): ReportObservations => {
  const path = join(root, relative);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    const missing = objectOf(cause).code === "ENOENT";
    return {
      state: missing ? "missing" : "unreadable",
      source: relative,
      observedMatches: null,
      noScoreSource: null,
      readings: [],
      issues: missing ? [] : [{ line: 0, reason: "观测文件无法读取" }],
    };
  }
  if (text.trim() === "")
    return {
      state: "empty",
      source: relative,
      observedMatches: 0,
      noScoreSource: 0,
      readings: [],
      issues: [],
    };
  const readings: TrialObservationLine[] = [];
  let factsHash: string | undefined;
  const seen = new Set<number>();
  const issues: { line: number; reason: string }[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    try {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        // JSON.parse 的原错误可能包含载荷片段,报告只披露固定原因。
        throw new Error("观测行 JSON 不合法");
      }
      const parsed = observationSchema.safeParse(value);
      if (!parsed.success) throw new Error("观测行形状不合法");
      const candidate = parsed.data as TrialObservationLine;
      const { matchIndex, delivered, captures } = candidate;
      if (
        matchIndex === null ||
        delivered === null ||
        captures === null ||
        typeof candidate.noScoreSource !== "boolean"
      )
        throw new Error("观测行形状不合法");
      const expected = expectedMatchOf(options.caliber, matchIndex, candidate);
      if (expected === undefined)
        throw new Error(
          options.caliber.kind === "self"
            ? "观测行缺少可核对的种子、座位或四座身份"
            : "观测对局下标不属于试跑计划",
        );
      const facts = candidate.actionFacts;
      if (
        facts !== undefined &&
        (facts.complete !== (facts.missingTicks === 0) ||
          facts.seed !== expected.seed ||
          // 座位是每场参数：v1 历史档候选恒 0 号位，v2 网格档逐场由计划给。
          facts.seat !== expected.candidateSeat ||
          ACTION_API_NAMES.some(
            (name) =>
              (facts.observedTicks === 0 && facts.calls[name] > 0) ||
              ACTION_ERROR_CODES.reduce((sum, code) => sum + facts.errors[name][code], 0) >
                facts.calls[name],
          ))
      )
        throw new Error("行动事实完整性、错误计数或 seed 归属不合法");
      if (
        facts !== undefined &&
        options.scriptSha256 !== undefined &&
        facts.scriptSha256 !== options.scriptSha256
      )
        throw new Error("行动事实与 meta 编译 JS hash 不一致");
      if (seen.has(matchIndex)) throw new Error("对局下标重复");
      if (candidate.noScoreSource !== (delivered === 0 && captures === 0))
        throw new Error("noScoreSource 与读数矛盾");
      if (facts !== undefined && factsHash !== undefined && facts.scriptSha256 !== factsHash)
        throw new Error("同一候选行动事实的编译 JS hash 不一致");
      const evidence = observationEvidenceOf(candidate, expected);
      if (evidence === null) throw new Error("终局事实计分、名次或归属不合法");
      seen.add(matchIndex);
      if (facts !== undefined) factsHash = facts.scriptSha256;
      readings.push(evidence);
    } catch (cause) {
      issues.push({
        line: index + 1,
        reason: issueReasonOf(
          cause,
          [
            "观测行 JSON 不合法",
            "观测行形状不合法",
            "观测对局下标不属于试跑计划",
            "观测行缺少可核对的种子、座位或四座身份",
            "行动事实完整性、错误计数或 seed 归属不合法",
            "行动事实与 meta 编译 JS hash 不一致",
            "对局下标重复",
            "noScoreSource 与读数矛盾",
            "同一候选行动事实的编译 JS hash 不一致",
            "终局事实计分、名次或归属不合法",
          ],
          "观测行形状不合法",
        ),
      });
    }
  }
  return {
    state: issues.length > 0 ? "partial" : "recorded",
    source: relative,
    observedMatches: readings.length,
    noScoreSource: readings.filter((reading) => reading.noScoreSource).length,
    readings,
    issues,
  };
};

/**
 * 网格汇总（`.grid.json`）里的计划 → 那 32 场跟谁打。
 *
 * ── 只读，不改形状 ──
 * 文件就在候选观测文件旁边（`<观测文件>.grid.json`，见 `trial-grid.ts` 的落点约定与
 * `observationsOf` 读观测文件的那一行）：路径按同一个约定算，不另记一份。
 *
 * ── 读不到就是读不到 ──
 * 文件不在 / 不是合法 JSON / 没有 `plan` / 计划读取失败，四种都是 `scripts: null`（渲染成
 * 「未记录」）。报告是只读面：不因一份旁挂件坏了就不出整份报告，也不拿今天的陪练池堆一个
 * 「大概是谁」——那会把 A2 要判断的事提前变成一个编造的事实。
 *
 * ── 为什么只对 v3 读 ──
 * v1 / v2 的计划本来就在 `meta` 里（`optimization.plan`），那一节已经把四份身份列出来了；
 * 再到旁挂件读一遍就是第二个家。v3 的优化段不装计划（ADR-0035），旁挂件是唯一处——这一节
 * 只补那个缺口。
 */
const candidateSparringOf = (options: {
  readonly root: string;
  /** 档案目录（`archive/<slug>`），与读观测文件那一处同一个写法。 */
  readonly directory: string;
  /** 档案所属席位 slug（= `archive/` 下的一级目录名）。 */
  readonly model: string;
  /** 本档运行标识：判「上一场」要拿它和来源里的 runId 比。 */
  readonly runId: string;
  readonly candidate: ArchiveOptimizationCandidate;
}): ReportCandidateSparring => {
  const source = `${options.directory}/${options.candidate.observationsFile}${TRIAL_GRID_SUMMARY_SUFFIX}`;
  const reading = {
    protocolRound: options.candidate.protocolRound,
    source,
    planSha256: null,
    scripts: null,
    selfReference: null,
  } as const;
  let text: string;
  try {
    text = readFileSync(join(options.root, source), "utf8");
  } catch {
    return reading;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return reading;
  }
  const plan = objectOf(value)["plan"];
  if (plan === undefined) return reading;
  let parsed: TrialPlan;
  try {
    parsed = readTrialPlan(plan);
  } catch {
    return reading;
  }
  const scripts = parsed.scripts.map(({ id, role, source: from, scriptSha256 }) => ({
    id,
    role,
    source: from,
    scriptSha256,
  }));
  return {
    ...reading,
    planSha256: parsed.planSha256,
    scripts,
    selfReference: sparringSelfReferenceOf({
      scripts,
      model: options.model,
      runId: options.runId,
    }),
  };
};

/**
 * 自指判据：这一场的在位陪练是不是**本席位自己的上一场**。
 *
 * 三个条件同时成立才标（差一个就不标——宁可不说，也不说错）：
 * 1. `incumbent:<slug>` 的 `<slug>` 等于档案所属席位（`archive/<slug>/` 一级目录名）；
 * 2. 来源 `archive:<slug>/<runId>` 里的 `runId` 不是本档的 `runId`（它是「上一场」，不是「本场」）；
 * 3. 来源的 `<slug>` 也等于档案所属席位。
 *
 * ── 为何第 3 条比票面更严，以及为何不改成票面那两条 ──
 * 票写的是「`incumbent:<slug>` 的 slug 是本席位，且 `source` 的 runId 不同于本档」。但那句话
 * 把「陪练是谁的上一场」这句话拆给了两个字段各说一半：运行时报告的标题是「陪练 = 本席位上一场」，
 * 这是一个**合取命题**，而它的真假要由两个独立的指针都指向本席位才能成立。
 *
 * 两个字段不一致时（`id` 说 `incumbent:gpt-6-luna`、`source` 说 `archive:hy4-flash/<runId>`），
 * 只有一个解释：计划装配时一处用了本席位、另一处用了别的档（代位、手改、或写盘时的一个 bug）。
 * 此时只读一个字段会**凭空造出一条声称**：说「你家上一场」——而可核的那个指针指着别家。
 * 那个代价不是渲染难看，是 A2 拿这一行去判「能不能跨会话比」。所以这里选「不猜」：
 * 两处都说本席位才标，一处说了就当作「未记录」（渲染仍然出四份身份，只是不附那句自指注）。
 *
 * 这也解释了两侧为何都不因为这个加固而变松：它只会**少标**不会多标；而票真正要防的那个
 * 误读（自家上一场被当成能力提升）在正常档上两处本就一致——加固只是把「两处不一致时怎么办」
 * 定成一个有理由的答案，不再是隐含的「取第一个字段」。
 *
 * 代位（`#substitute`）的 slug 是另一份档，所以它天然不会命中；它的 `source` 仍然是
 * `archive:` 开头，所以这里不靠前缀排除，靠 slug 不等。
 */
const sparringSelfReferenceOf = (options: {
  readonly scripts: readonly ReportPlanScript[];
  readonly model: string;
  readonly runId: string;
}): ReportSparringSelfReference | null => {
  const incumbent = options.scripts.find((script) => script.role === "incumbent");
  if (incumbent === undefined) return null;
  const separator = incumbent.id.indexOf(TRIAL_SCRIPT_ID_SEPARATOR);
  if (separator === -1) return null;
  const idSlug = incumbent.id.slice(separator + TRIAL_SCRIPT_ID_SEPARATOR.length);
  if (idSlug !== options.model) return null;
  const from = archiveSourceOf(incumbent.source);
  if (from === null || from.slug !== options.model) return null;
  if (from.runId === options.runId) return null;
  return { slug: options.model, runId: from.runId };
};

/**
 * 来源指针的读法：`archive:<slug>/<runId>`（代位带 `#substitute` 后缀）。
 *
 * 形态对不上就交回 `null`——这个函数只服务于「上一场」那一条判断，没有第二种容错语义。
 */
const archiveSourceOf = (
  source: string,
): { readonly slug: string; readonly runId: string } | null => {
  const prefix = "archive:";
  if (!source.startsWith(prefix)) return null;
  const rest = source.slice(prefix.length);
  const withoutSubstitute = rest.endsWith(TRIAL_SUBSTITUTE_SOURCE_SUFFIX)
    ? rest.slice(0, -TRIAL_SUBSTITUTE_SOURCE_SUFFIX.length)
    : rest;
  const slash = withoutSubstitute.lastIndexOf("/");
  if (slash <= 0 || slash === withoutSubstitute.length - 1) return null;
  return {
    slug: withoutSubstitute.slice(0, slash),
    runId: withoutSubstitute.slice(slash + 1),
  };
};

const candidateObservationsOf = (
  root: string,
  model: string,
  runId: string,
  protocolRounds: number,
): ArchiveReport["candidateObservations"] => {
  const directory = `archive/${model}`;
  const prefix = `${OBSERVATIONS_FILE_PREFIX}${runId}-round-`;
  return readdirSync(join(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".jsonl"))
        return [];
      const suffix = entry.name.slice(prefix.length, -6);
      const protocolRound = numberOf(Number(suffix));
      if (
        protocolRound === null ||
        protocolRound < 1 ||
        protocolRound > protocolRounds ||
        suffix !== String(protocolRound)
      )
        return [];
      return [
        {
          ...observationsOf(root, `${directory}/${entry.name}`, { caliber: { kind: "legacy" } }),
          protocolRound,
        },
      ];
    })
    .sort((a, b) => a.protocolRound - b.protocolRound);
};

/**
 * 失败记录自带的已有候选描述（优化中途失败时 pipeline 写入；旧记录缺席）。
 * 防御式读栏：任一项不合形状即整体视为缺席，走旧逐轮列表，不抛（失败记录本身必须可读）。
 * basename 与 hash 模式同 `archive-meta.ts` 的候选约束，形状真源仍在 schema。
 *
 * **条数上限按版本分派**：one-shot 失败档的候选只能是「已入档的有效阶段」（非选拔失败最多
 * 2 个、选拔失败 3 个），agent 失败档的候选则是 1..3 次 `evaluate` 的自然结果（三次是配额，
 * 不是下限）。拿一个数字代表两种档案，正是 ADR-0031 点名的那条散落判据。
 */
const failureCandidateSchema = z.fromJSONSchema(
  JSON.parse(
    JSON.stringify(ARCHIVE_OPTIMIZATION_CANDIDATE_JSON_SCHEMA),
  ) as z.core.JSONSchema.JSONSchema,
);
const failureAgentCandidateSchema = z.fromJSONSchema(
  JSON.parse(
    JSON.stringify(ARCHIVE_OPTIMIZATION_CANDIDATE_AGENT_JSON_SCHEMA),
  ) as z.core.JSONSchema.JSONSchema,
);

/** v3 失败档的候选：无 `stage`，步号递增，按位置投影成报告内部同形候选。 */
const agentFailureCandidatesOf = (raw: readonly unknown[]): ArchiveOptimizationCandidate[] => {
  if (raw.length < 1 || raw.length > OPTIMIZATION_CANDIDATE_LIMIT) return [];
  const seen = new Set<string>();
  const out: ArchiveOptimizationCandidate[] = [];
  for (const item of raw) {
    const parsed = failureAgentCandidateSchema.safeParse(item);
    if (!parsed.success) return [];
    const candidate = parsed.data as ArchiveOptimizationCandidateAgent;
    if (
      candidate.step <= (out[out.length - 1]?.protocolRound ?? 0) ||
      seen.has(candidate.scriptFile) ||
      seen.has(candidate.observationsFile) ||
      candidate.scriptFile !== `${candidate.observationsFile}.candidate.js` ||
      !candidate.observationsFile.endsWith(`-round-${String(candidate.step)}.jsonl`)
    )
      return [];
    seen.add(candidate.scriptFile);
    seen.add(candidate.observationsFile);
    out.push(projectAgentCandidate(candidate, out.length));
  }
  return out;
};

const failureCandidatesOf = (record: unknown): ArchiveOptimizationCandidate[] => {
  if (typeof record !== "object" || record === null) return [];
  const raw = (record as { candidates?: unknown }).candidates;
  if (!Array.isArray(raw)) return [];
  // agent 形状的失败档用 v3 候选序读法（`step` 而不是 `stage`）——v3 与 v4 在候选序上是同一版。
  if (isAgentShape(archiveShapeVersionOf(record))) return agentFailureCandidatesOf(raw);
  if (raw.length > (objectOf(record).classification === "selection" ? 3 : 2)) return [];
  const seen = new Set<string>();
  const out: ArchiveOptimizationCandidate[] = [];
  for (const [index, item] of raw.entries()) {
    const parsed = failureCandidateSchema.safeParse(item);
    if (!parsed.success) return [];
    const candidate = parsed.data as ArchiveOptimizationCandidate;
    if (
      candidate.stage !== index ||
      candidate.protocolRound <= (out[index - 1]?.protocolRound ?? 0) ||
      seen.has(candidate.scriptFile) ||
      seen.has(candidate.observationsFile) ||
      candidate.scriptFile !== `${candidate.observationsFile}.candidate.js` ||
      !candidate.observationsFile.endsWith(`-round-${String(candidate.protocolRound)}.jsonl`)
    )
      return [];
    seen.add(candidate.scriptFile);
    seen.add(candidate.observationsFile);
    out.push(candidate);
  }
  return out;
};

/**
 * 失败旁证里的计划：v1 是 12 场选拔计划，v2 是生成阶段那张网格（`TrialPlan`）。
 *
 * 两版形状互斥（有 `seeds` 的是 v1），所以用联合而不是就地改检查：历史失败记录不迁移，
 * 新失败记录带的是网格计划。
 */
const selectionFailureSchema = z
  .object({
    plan: z.union([
      z.fromJSONSchema(
        ARCHIVE_SELECTION_JSON_SCHEMA.properties.plan as unknown as z.core.JSONSchema.JSONSchema,
      ),
      z.fromJSONSchema(TRIAL_PLAN_JSON_SHAPE as unknown as z.core.JSONSchema.JSONSchema),
    ]),
    candidates: z
      .array(
        z.fromJSONSchema(
          ARCHIVE_SELECTION_JSON_SCHEMA.properties
            .selected as unknown as z.core.JSONSchema.JSONSchema,
        ),
      )
      .length(3),
  })
  .strict();

/** 计划能否由它自己的事实重建：v1 用选拔计划的构造，v2 用 `checkTrialPlan`。 */
const rebuiltSelectionFailurePlan = (
  plan: SelectionPlan | TrialPlan,
): SelectionPlan | TrialPlan => {
  if (!("seeds" in plan)) {
    checkTrialPlan(plan);
    return plan;
  }
  return buildSelectionPlan(plan);
};

const selectionFailureOf = (
  record: Record<string, unknown>,
  descriptors: readonly ArchiveOptimizationCandidate[],
  protocolRounds: number,
): { plan: SelectionPlan | TrialPlan; candidates: SelectionCandidateIdentity[] } | null => {
  if (record.selectionFailure === undefined) return null;
  const parsed = selectionFailureSchema.safeParse(record.selectionFailure);
  if (!parsed.success || record.classification !== "selection" || descriptors.length !== 3)
    throw new Error("选拔失败旁证形状不合法");
  const value = parsed.data as {
    plan: SelectionPlan | TrialPlan;
    candidates: SelectionCandidateIdentity[];
  };
  const expected = rebuiltSelectionFailurePlan(value.plan);
  if (
    JSON.stringify(expected) !== JSON.stringify(value.plan) ||
    value.candidates.some((identity, index) => {
      const candidate = descriptors[index]!;
      return (
        identity.stage !== candidate.stage ||
        identity.protocolRound !== candidate.protocolRound ||
        identity.protocolRound > protocolRounds ||
        identity.scriptSha256 !== candidate.scriptSha256
      );
    })
  )
    throw new Error("选拔失败计划或候选身份不一致");
  return value;
};

const attemptsOf = (raw: unknown): Pick<ArchiveReportRound, "attempts" | "attemptCoverage"> => {
  if (!Array.isArray(raw)) return { attempts: [], attemptCoverage: "missing" };
  const attempts: ReportAttempt[] = [];
  let partial = raw.length === 0;
  for (const [index, item] of raw.entries()) {
    const value = objectOf(item);
    if (
      value.attempt !== index + 1 ||
      (value.outcome !== "response" && value.outcome !== "transport-error")
    ) {
      partial = true;
      continue;
    }
    const response = value.outcome === "response";
    attempts.push({
      attempt: index + 1,
      outcome: value.outcome,
      // 细分只对「传输失败」有意义；成功尝试上写了也不采（它两个格说的是两件事）。
      failureKind: response ? null : attemptFailureKindOf(value.failureKind),
      stop: stopEvidenceOf(response ? value : undefined),
      usage: normalizeUsage(response ? value.usage : undefined),
    });
  }
  return { attempts, attemptCoverage: partial ? "partial" : "recorded" };
};

const candidateReportOf = (
  root: string,
  directory: string,
  descriptor: ArchiveOptimizationCandidate,
  finalHash: string,
  runId: string,
  caliber: ObservationCaliber,
  frozenStage: number | null = 2,
  candidateSourceHash?: string,
): ReportCandidate => {
  const scriptSource = `${directory}/${descriptor.scriptFile}`;
  let actualScriptSha256: string | null = null;
  let scriptState: ReportCandidate["scriptState"];
  try {
    actualScriptSha256 = createHash("sha256")
      .update(readFileSync(join(root, scriptSource)))
      .digest("hex");
    scriptState = actualScriptSha256 === descriptor.scriptSha256 ? "verified" : "mismatch";
    if (
      descriptor.stage === frozenStage &&
      createHash("sha256")
        .update(readFileSync(join(root, directory, runId, "script.js")))
        .digest("hex") !== finalHash
    )
      scriptState = "mismatch";
    if (
      candidateSourceHash !== undefined &&
      createHash("sha256")
        .update(readFileSync(join(root, directory, descriptor.scriptFile.replace(/\.js$/, ".ts"))))
        .digest("hex") !== candidateSourceHash
    )
      scriptState = "mismatch";
    if (
      descriptor.stage === frozenStage &&
      candidateSourceHash !== undefined &&
      createHash("sha256")
        .update(readFileSync(join(root, directory, runId, "script.ts")))
        .digest("hex") !== candidateSourceHash
    )
      scriptState = "mismatch";
  } catch (cause) {
    scriptState = objectOf(cause).code === "ENOENT" ? "missing" : "unreadable";
  }
  const observations = observationsOf(root, `${directory}/${descriptor.observationsFile}`, {
    caliber,
    scriptSha256: descriptor.scriptSha256,
  });
  return {
    stage: descriptor.stage,
    protocolRound: descriptor.protocolRound,
    scriptFile: descriptor.scriptFile,
    observationsFile: descriptor.observationsFile,
    scriptSha256: descriptor.scriptSha256,
    // 档里有才搬：v1 历史档没有分数、场数与复用来源，不追填、不补零。
    ...(descriptor.score === undefined ? {} : { score: descriptor.score }),
    ...(descriptor.matchCount === undefined ? {} : { matchCount: descriptor.matchCount }),
    ...(descriptor.reusedFromStage === undefined
      ? {}
      : { reusedFromStage: descriptor.reusedFromStage }),
    // 存档里的端点原生参数只过白名单投影再进报告：原值含自由文本（`stop` / `logit_bias`）。
    ...(descriptor.params === undefined ? {} : { params: paramsOf(descriptor.params) }),
    scriptSource,
    scriptState,
    actualScriptSha256,
    observations:
      scriptState === "verified" ||
      observations.state === "missing" ||
      observations.state === "unreadable"
        ? observations
        : {
            ...observations,
            state: "partial",
            observedMatches: null,
            noScoreSource: null,
            readings: [],
            issues: [
              ...observations.issues,
              { line: 0, reason: `候选 JS ${scriptState}，观测归属无法核实` },
            ],
          },
  };
};

/**
 * 选拔候选的身份字段在 v3 换了名（`stage` / `protocolRound` → `step`，`reusedFromStage` →
 * `reusedFromStep`）。报告这一侧把位置一律读成**候选序下标**、把步号读成 `protocolRound`，
 * 于是三种版本的候选走同一张表——`stage` 这个**报告字段名**的收口（换成步级列）归度量票 07。
 */
const selectionStepOf = (
  candidate: SelectionCandidate | SelectionGridCandidate | SelectionAgentCandidate,
): number => ("step" in candidate ? candidate.step : candidate.protocolRound);

const selectionReusedFromOf = (
  candidate: SelectionCandidate | SelectionGridCandidate | SelectionAgentCandidate,
): number | null =>
  ("step" in candidate ? candidate.reusedFromStep : candidate.reusedFromStage) ?? null;

const selectionIdentityStepOf = (
  identity: SelectionCandidateIdentity | SelectionAgentIdentity,
): number => ("step" in identity ? identity.step : identity.protocolRound);

/** 选拔胜者在候选序里的位置；v1/v2 的 `stage` 本来就是位置，v3 用步号反查（找不到即拒，不猜）。 */
const selectedPositionOf = (selection: ArchiveSelection): number => {
  if (selection.version !== SELECTION_AGENT_VERSION) return selection.selected.stage;
  const position = selection.candidates.findIndex(
    (candidate) => candidate.step === selection.selected.step,
  );
  if (position < 0) throw new Error("选拔胜者不在候选序里");
  return position;
};

const sameObservationFile = (root: string, a: string, b: string): boolean => {
  try {
    return readFileSync(join(root, a)).equals(readFileSync(join(root, b)));
  } catch {
    return false;
  }
};

const readRecord = (
  root: string,
  source: string,
  slug: string,
  kind: "success" | "failure",
  runId: string,
  currentRunId?: string,
): ArchiveReport => {
  let record: Record<string, unknown>;
  try {
    record = objectOf(JSON.parse(readFileSync(join(root, source), "utf8")));
  } catch {
    throw new Error("记录 JSON 无法读取或不合法");
  }
  const optimizationMeta = optimizationMetaOf(record);
  const protocolRounds = numberOf(record.protocolRounds);
  if (protocolRounds === null || typeof record.model !== "string") {
    throw new Error(`报告记录 ${source} 缺模型名或实际协议轮数`);
  }
  if (record.model !== slug) {
    throw new Error(`报告记录 ${source} 的 model 与目录 slug 不一致`);
  }
  const lines = Array.isArray(record.generationLog) ? record.generationLog : [];
  /**
   * 形状版本在这里就定下来（在**逐行解析之前**）：日志行的读法按版本分派——v3 的行只装发送侧
   * 证据，结果侧（驱动来源 `kind` 与 `errorCodes`）的真源在过程记录里（ADR-0031）。
   */
  const shape = archiveShapeVersionOf(record);
  const issues: { line: number; reason: string }[] = [];
  const seen = new Set<number>();
  const rounds: ArchiveReportRound[] = lines.flatMap((line: unknown, index: number) => {
    try {
      if (typeof line !== "string") throw new Error("日志行不是 JSON 字符串");
      let log: Record<string, unknown>;
      try {
        log = objectOf(JSON.parse(line));
      } catch {
        throw new Error("日志行 JSON 不合法");
      }
      if (isAgentShape(shape)) {
        // 旧档的行里有这两个键，那时代它们就是结果侧证据；agent 形状不许再带——复写让同一个事实
        // 有了两个家，而后者迟早是陈的（ADR-0031「一个事实一个家」）。显式拒读，不静默忽略。
        // 文案不写版本号：v3 与 v4 共用这条判据，写死一个会把另一版的拒读理由说错。
        if (Object.hasOwn(log, "errorCodes"))
          throw new Error("agent 形状的日志行不带结果侧 errorCodes 字段");
        if (log.kind !== undefined && log.kind !== "converged" && log.kind !== "transport")
          throw new Error("agent 形状日志行的 kind 只能是行类型标记");
      }
      const transport =
        kind === "failure" &&
        record.classification === "transport" &&
        index === lines.length - 1 &&
        log.kind === "transport" &&
        log.responseConverged === false &&
        log.round === protocolRounds + 1;
      if ((log.responseConverged === false || log.kind === "transport") && !transport)
        throw new Error("未收敛日志只能是传输失败末行");
      const round = numberOf(log.round);
      if (
        round === null ||
        round < 1 ||
        round > protocolRounds + (transport ? 1 : 0) ||
        seen.has(round)
      ) {
        throw new Error("轮号缺失、越界或重复");
      }
      seen.add(round);
      const usageState =
        transport || !Object.hasOwn(log, "usage")
          ? "missing"
          : log.usage === null
            ? "null"
            : typeof log.usage === "object" && !Array.isArray(log.usage)
              ? "recorded"
              : "invalid";
      const usage = normalizeUsage(transport ? undefined : log.usage);
      return [
        {
          round,
          sendMs: numberOf(log.sendMs),
          backoffMs: numberOf(log.backoffMs),
          responseConverged: !transport,
          params: paramsOf(log.params),
          requestEvidence: requestEvidenceOf(log.requestEvidence, slug),
          stop: stopEvidenceOf(transport ? undefined : log),
          ...attemptsOf(log.attemptEvidence),
          usageState,
          usage,
          cacheHitRate: cacheHitRateOf(usage),
        },
      ];
    } catch (cause) {
      issues.push({
        line: index + 1,
        reason: issueReasonOf(
          cause,
          [
            "日志行不是 JSON 字符串",
            "日志行 JSON 不合法",
            "agent 形状的日志行不带结果侧 errorCodes 字段",
            "agent 形状日志行的 kind 只能是行类型标记",
            "未收敛日志只能是传输失败末行",
            "轮号缺失、越界或重复",
          ],
          "日志证据形状不合法",
        ),
      });
      return [];
    }
  });
  rounds.sort((a, b) => a.round - b.round);
  /** agent 形态（v3 / v4）：步列、终止原因与受污染分层都按它分派。两版在这些读法上同形。 */
  const agentShape = isAgentShape(shape);
  const failureDescriptors = kind === "failure" ? failureCandidatesOf(record) : [];
  const failedSelection =
    kind === "failure" ? selectionFailureOf(record, failureDescriptors, protocolRounds) : null;
  const optimization = optimizationMeta?.optimization;
  const selection = optimizationMeta?.selection;
  const descriptors = reportCandidatesOf(optimization);
  /**
   * 观测行的期待口径：v2 网格档逐场由计划给（种子 / 候选座位 / 四座身份），v1 历史档查旧表。
   * 失败档没有 `optimization`，但 v2 的选拔失败旁证里带的是同一张计划。
   *
   * v3 的优化段里**没有计划**（ADR-0031 定的形状），所以只有选拔段存在时才有网格计划可核；
   * 连它也没有时口径是 `self`：每行按自己的种子 / 座位 / 四座身份做**行内自洽**校验，不冒充
   * 独立核对。这条缺口的收口（计划要不要进档案）归度量票与网格票，不在这里发明。
   */
  const caliber: ObservationCaliber =
    optimization?.version === OPTIMIZATION_GRID_VERSION
      ? { kind: "grid", plan: optimization.plan }
      : selection?.version === SELECTION_AGENT_VERSION
        ? { kind: "grid", plan: selection.plan }
        : failedSelection !== null && !("seeds" in failedSelection.plan)
          ? { kind: "grid", plan: failedSelection.plan }
          : agentShape
            ? { kind: "self" }
            : { kind: "legacy" };
  /**
   * 冻结候选的**位置**：v3 = 选拔胜者所在的位置、选拔缺席时 = 候选序末位（ADR-0031）；
   * one-shot 档保持原判据（选拔胜者的 `stage`、缺席时第三阶段 2），旧档照旧。
   */
  const frozenPosition =
    selection === undefined
      ? agentShape
        ? descriptors.length - 1
        : 2
      : selectedPositionOf(selection);
  const optimizationCandidates = descriptors.map((descriptor) =>
    candidateReportOf(
      root,
      `archive/${slug}`,
      descriptor,
      optimizationMeta?.scriptSha256 ?? "",
      runId,
      caliber,
      frozenPosition,
      selection?.candidates[descriptor.stage]?.sourceSha256,
    ),
  );
  if (
    kind === "success" &&
    optimizationMeta?.selection !== undefined &&
    optimizationCandidates.some((candidate) => candidate.scriptState !== "verified")
  )
    throw new Error("选拔档冻结或候选 TS/JS 身份无法核实");
  // 失败档的候选没有冻结脚本；不读取不存在的冻结目录。
  const failureDescribed =
    kind === "failure"
      ? failureDescriptors.map((descriptor) =>
          candidateReportOf(
            root,
            `archive/${slug}`,
            descriptor,
            "",
            runId,
            caliber,
            null,
            failedSelection?.candidates[descriptor.stage]?.sourceSha256,
          ),
        )
      : [];
  /** 末位候选：v3 是候选序末位；one-shot 档仍是第三阶段（旧判据不改）。 */
  const finalCandidateOf = (candidates: readonly ReportCandidate[]): ReportCandidate | null =>
    agentShape ? (candidates[candidates.length - 1] ?? null) : (candidates[2] ?? null);
  const optimizedFinal = finalCandidateOf(optimizationCandidates);
  const observations =
    optimizedFinal?.observations ??
    observationsOf(root, `archive/${slug}/${OBSERVATIONS_FILE_PREFIX}${runId}.jsonl`, {
      caliber,
      ...(kind === "success" && typeof record.scriptSha256 === "string"
        ? { scriptSha256: record.scriptSha256 }
        : {}),
    });
  const describedCandidates =
    optimizationMeta !== undefined ? optimizationCandidates : failureDescribed;
  const candidateObservations =
    optimizationMeta !== undefined || failureDescribed.length > 0
      ? describedCandidates.map((candidate) => ({
          ...candidate.observations,
          protocolRound: candidate.protocolRound,
        }))
      : candidateObservationsOf(root, slug, runId, protocolRounds);
  const lastCandidate = candidateObservations.find(
    (candidate) => candidate.protocolRound === protocolRounds,
  );
  const finalCandidate =
    optimizedFinal === null
      ? kind === "success" &&
        observations.state === "recorded" &&
        lastCandidate?.state === "recorded" &&
        sameObservationFile(root, observations.source, lastCandidate.source)
      : optimizedFinal.scriptState === "verified" && observations.state === "recorded";
  const convergedRounds = rounds.filter((round) => round.responseConverged);
  const allAttempts = rounds.flatMap((round) => round.attempts);
  // v1 历史档与 v3（优化段里没有计划）都不适用：`null`，不迁移、不回填。
  const plan =
    optimization?.version === OPTIMIZATION_GRID_VERSION
      ? gridPlanReportOf(optimization.plan, `${source}#optimization.plan`)
      : null;
  const scores = candidateScoresOf(optimization, selection);
  const stages = describedCandidates.length;
  /**
   * 陪练身份：**只对 v3 读**旁挂的 `.grid.json`（v1 / v2 的计划在 `meta` 里，见 `candidateSparringOf`）。
   * 一个候选一条：v3 每次 `evaluate` 各跑一张网格，各自那份汇总才是那一次的证据。
   */
  const sparring = agentShape
    ? describedCandidates.map((candidate) =>
        candidateSparringOf({
          root,
          directory: `archive/${slug}`,
          model: slug,
          runId,
          candidate,
        }),
      )
    : [];
  const expectedAttempts =
    protocolRounds + (kind === "failure" && record.classification === "transport" ? 1 : 0);
  /**
   * 步列与受污染分层：两者都按**版本**分派（v1 / v2 档没有步，那一列就恒 `null`）。
   * `stepsOf` 会拒读「步号不是 1..n」的 v3 档——那意味着按号数的左连接不再成立，不能静默降级。
   */
  const steps = stepsOf({ record, shape, rounds, protocolRounds });
  return {
    kind,
    model: slug,
    modelVersion: typeof record.modelVersion === "string" ? record.modelVersion : null,
    shape: archiveShapeOf(record, shape),
    steps,
    contamination: contaminationOf({ shape, rounds }),
    runId,
    source,
    runScope:
      currentRunId === undefined
        ? "unscoped"
        : currentRunId === runId
          ? "current-run"
          : "historical",
    candidateStages: stages,
    plan,
    sparring,
    scores,
    distinctScripts: new Set(describedCandidates.map((candidate) => candidate.scriptSha256)).size,
    selectionFailure:
      failedSelection === null
        ? null
        : {
            planSha256: failedSelection.plan.planSha256,
            seeds: planFactsOf(failedSelection.plan).seeds,
            matchesPerCandidate: failedSelection.plan.matchesPerCandidate,
            candidates: failedSelection.candidates.map((identity) => ({
              stage: identity.stage,
              protocolRound: identity.protocolRound,
              scriptSha256: identity.scriptSha256,
              sourceSha256: identity.sourceSha256,
            })),
          },
    budget: {
      model: {
        convergedResponses: protocolRounds,
        recordedAttempts: allAttempts.length,
        attemptEvidenceRounds: rounds.filter((round) => round.attemptCoverage === "recorded")
          .length,
        expectedAttemptEvidenceRounds: expectedAttempts,
        responseAttemptsWithUsage: allAttempts.filter((attempt) =>
          Object.values(attempt.usage).some((reading) => reading.value !== null),
        ).length,
        transportErrors: allAttempts.filter((attempt) => attempt.outcome === "transport-error")
          .length,
        unknownConsumptionAttempts: allAttempts.filter(
          (attempt) =>
            attempt.outcome === "transport-error" ||
            Object.values(attempt.usage).every((reading) => reading.value === null),
        ).length,
        // v3 的响应预算由步数上限决定，而上限是**身份项**（`harnessDigest` 的清单里），
        // 不在档案里可读——所以这一档对 v3 写「不适用」，不拿 one-shot 的 3×5 冒充。
        // 步级预算列归度量票（07）。
        maximumConvergedResponses: agentShape
          ? null
          : optimizationMeta?.optimization !== undefined || stages > 0
            ? OPTIMIZATION_STAGES.length * 5
            : null,
        maximumResponsesPerStage: agentShape
          ? null
          : optimizationMeta?.optimization !== undefined || stages > 0
            ? 5
            : null,
      },
      local: {
        optimizationObservedMatches:
          stages === 0 ||
          describedCandidates.some((candidate) => candidate.observations.observedMatches === null)
            ? null
            : describedCandidates.reduce(
                (sum, candidate) => sum + candidate.observations.observedMatches!,
                0,
              ),
        // 上限 = 候选数 × 每候选场数；候选数按**版本**分派（v3 = 真实候选数，one-shot = 三阶段）。
        selectionMaximumMatches:
          selection === undefined && failedSelection === null
            ? null
            : (agentShape ? (selection?.candidates.length ?? stages) : OPTIMIZATION_STAGES.length) *
              (selection ?? failedSelection)!.plan.matchesPerCandidate,
        selectionExecutedMatches:
          selection === undefined
            ? null
            : selection.candidates.filter((candidate) => selectionReusedFromOf(candidate) === null)
                .length * selection.plan.matchesPerCandidate,
        selectionReusedMatches:
          selection === undefined
            ? null
            : selection.candidates.filter((candidate) => selectionReusedFromOf(candidate) !== null)
                .length * selection.plan.matchesPerCandidate,
      },
    },
    initialCandidate: optimizationCandidates[0] ?? failureDescribed[0] ?? null,
    intermediateCandidates:
      optimizationMeta !== undefined
        ? optimizationCandidates.slice(1, -1)
        : // one-shot 失败档的中间候选仍是第二阶段（旧判据不改）；v3 失败档按位置取中间。
          agentShape
          ? failureDescribed.slice(1, -1)
          : failureDescribed.filter((candidate) => candidate.stage === 1),
    finalCandidate: finalCandidateOf(optimizationCandidates) ?? finalCandidateOf(failureDescribed),
    frozenCandidate: optimizationCandidates[frozenPosition] ?? null,
    selection:
      selection === undefined
        ? null
        : {
            version: selection.version,
            // 位置与步号：v1/v2 读 `selected.stage` / `protocolRound`，v3 读候选序位置 / `step`。
            stage: selectedPositionOf(selection),
            protocolRound: selectionIdentityStepOf(selection.selected),
            scriptSha256: selection.selected.scriptSha256,
            sourceSha256: selection.selected.sourceSha256,
            averagePoints: selectionCandidateScoreOf(
              selection.candidates[selectedPositionOf(selection)]!,
            ).averagePoints,
            countedMatches: selection.plan.matchesPerCandidate,
            reason: selection.reason,
            planSha256: selection.plan.planSha256,
            distinctScripts: new Set(
              selection.candidates.map((candidate) => candidate.scriptSha256),
            ).size,
            reusedFromStage: selectionReusedFromOf(
              selection.candidates[selectedPositionOf(selection)]!,
            ),
            candidates: selection.candidates.map((candidate, position) => {
              const score = selectionCandidateScoreOf(candidate);
              return {
                stage: position,
                protocolRound: selectionStepOf(candidate),
                scriptSha256: candidate.scriptSha256,
                sourceSha256: candidate.sourceSha256,
                averagePoints: score.averagePoints,
                totalPoints: score.totalPoints,
                countedMatches: score.countedMatches,
                reusedFromStage: selectionReusedFromOf(candidate),
              };
            }),
            executedMatches:
              selection.candidates.filter((candidate) => selectionReusedFromOf(candidate) === null)
                .length * selection.plan.matchesPerCandidate,
            reusedMatches:
              selection.candidates.filter((candidate) => selectionReusedFromOf(candidate) !== null)
                .length * selection.plan.matchesPerCandidate,
            rulesetSha256: selection.plan.rulesetSha256,
            sandboxRuntimeHash: selection.plan.sandboxRuntimeHash,
            // 选拔计划本身（不搬 32 场明文）：v2 / v3 = 生成阶段那张网格，v1 = 12 场单图。
            plan: isLegacySelection(selection)
              ? legacySelectionPlanReportOf(selection.plan, `${source}#selection.plan`)
              : gridPlanReportOf(selection.plan, `${source}#selection.plan`),
          },
    protocolRounds,
    rounds,
    log: {
      state:
        lines.length === 0
          ? "empty"
          : convergedRounds.length === protocolRounds && issues.length === 0
            ? "complete"
            : "partial",
      recordedLines: lines.length,
      readableRounds: convergedRounds.length,
      issues,
    },
    observations: {
      ...observations,
      candidate: finalCandidate
        ? "final-candidate"
        : optimizationMeta !== undefined ||
            observations.state === "missing" ||
            observations.state === "unreadable"
          ? null
          : "last-completed-trial",
      protocolRound: finalCandidate ? (optimizedFinal?.protocolRound ?? protocolRounds) : null,
    },
    candidateObservations,
    failure:
      kind === "failure"
        ? {
            classification: failureClassificationOf(record.classification),
            diagnosticsCount: Array.isArray(record.diagnostics) ? record.diagnostics.length : 0,
          }
        : null,
    totals: {
      sendMs: total(
        convergedRounds.map((round) => round.sendMs),
        protocolRounds,
      ),
      input: total(
        convergedRounds.map((round) => round.usage.input.value),
        protocolRounds,
      ),
      output: total(
        convergedRounds.map((round) => round.usage.output.value),
        protocolRounds,
      ),
      cacheRead: total(
        convergedRounds.map((round) => round.usage.cacheRead.value),
        protocolRounds,
      ),
      cacheWrite: total(
        convergedRounds.map((round) => round.usage.cacheWrite.value),
        protocolRounds,
      ),
      cacheWrite5m: total(
        convergedRounds.map((round) => round.usage.cacheWrite5m.value),
        protocolRounds,
      ),
      cacheWrite1h: total(
        convergedRounds.map((round) => round.usage.cacheWrite1h.value),
        protocolRounds,
      ),
      reasoning: total(
        convergedRounds.map((round) => round.usage.reasoning.value),
        protocolRounds,
      ),
    },
    cacheHitRate: cacheHitRateTotal(convergedRounds, protocolRounds),
  };
};

export type ArchiveReportReadIssue = {
  readonly source: string;
  readonly reason: string;
};

/** 只返回可读记录；逐记录拒绝原因通过 onReadIssue 披露，不伪造报告。 */
export const readArchiveReports = (
  root: string,
  options: {
    readonly model?: string;
    /** 显式给出本轮标识；未提供时不将任何历史失败认定为本轮失败。 */
    readonly runId?: string;
    readonly onReadIssue?: (issue: ArchiveReportReadIssue) => void;
  } = {},
): readonly ArchiveReport[] => {
  const reports: ArchiveReport[] = [];
  const archive = join(root, "archive");
  for (const slug of readdirSync(archive, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && (options.model === undefined || entry.name === options.model),
    )
    .sort((a, b) => a.name.localeCompare(b.name))) {
    for (const entry of readdirSync(join(archive, slug.name), { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (entry.name.startsWith(".tmp-")) continue;
      let source: string;
      let kind: "success" | "failure";
      let runId: string;
      if (entry.isDirectory() && existsSync(join(archive, slug.name, entry.name, "meta.json"))) {
        source = `archive/${slug.name}/${entry.name}/meta.json`;
        kind = "success";
        runId = entry.name;
      } else if (
        entry.isFile() &&
        entry.name.startsWith(FAILURE_RECORD_PREFIX) &&
        entry.name.endsWith(".json")
      ) {
        source = `archive/${slug.name}/${entry.name}`;
        kind = "failure";
        runId = entry.name.slice(FAILURE_RECORD_PREFIX.length, -5);
      } else {
        continue;
      }
      try {
        reports.push(readRecord(root, source, slug.name, kind, runId, options.runId));
      } catch {
        const reason = "记录 JSON、优化/选拔元数据或候选身份不合法，无法生成摘要";
        if (options.onReadIssue === undefined) throw new Error(reason);
        options.onReadIssue({ source, reason });
      }
    }
  }
  return reports;
};

const renderArchiveMarkdown = (reports: readonly ArchiveReport[]): string => {
  const escape = (value: string): string =>
    value.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", " ");
  /**
   * 三类分数的一个格子。**不适用就是「不适用」**：不写 0，也不留空。
   * 三类各有各的口径（见头部说明），不可互相代替。
   */
  const renderScore = (reading: ReportScoreReading): string =>
    reading.state === "recorded"
      ? `均分 ${reading.averagePoints}（总分 ${reading.totalPoints} / 分母 ${reading.countedMatches}）`
      : "不适用";
  /** 种子集合：连续的写区间（v1 = 三个固定种子，v2 = 每格一个固定值）。 */
  const renderSeeds = (seeds: readonly number[]): string => {
    const distinct = [...new Set(seeds)];
    if (distinct.length === 0) return "不适用";
    const contiguous = distinct.every(
      (seed, index) => index === 0 || seed === distinct[index - 1]! + 1,
    );
    return contiguous && distinct.length > 1
      ? `${distinct[0]}–${distinct[distinct.length - 1]}（${distinct.length} 个种子）`
      : distinct.join("/");
  };
  /** 一份陪练身份：四要素齐（id / role / source / scriptSha256），复现「跟谁打」用它。 */
  const renderPlanScript = (script: ReportPlanScript): string =>
    `${escape(script.id)}（role=${script.role}；source=${escape(script.source)}；scriptSha256=${script.scriptSha256}）`;
  const renderGridPlan = (plan: ReportGridPlan): string[] => [
    `- 生成阶段计划：v${plan.version}；planSha256=${plan.planSha256}；每候选场数=${plan.matchesPerCandidate}；正文 ${escape(plan.source)}（逐场座位/种子/地图从那里读，本报告不搬明文）`,
    `- 地图（${plan.maps.length} 张）：${plan.maps.map((map) => `${escape(map.name)}=${map.sha256}`).join("；")}`,
    `- 陪练身份（${plan.scripts.length} 份）：${plan.scripts.map(renderPlanScript).join("；")}`,
    `- 组合（${plan.combos.length}）：${plan.combos
      .map(
        (combo) =>
          `组合 ${combo.comboIndex} 轮空 ${combo.sitOut === null ? "null" : escape(combo.sitOut)}；候选座位 ${combo.candidateSeats.join("/")}；图 ${combo.maps.map(escape).join("/")}；场次 ${combo.firstMatchIndex}–${combo.firstMatchIndex + combo.matchCount - 1}`,
      )
      .join("；")}`,
    `- 逐场种子：${renderSeeds(plan.seeds)}`,
  ];
  /**
   * 陪练一节（v3）：计划不进 `meta`（ADR-0035），四份身份只在候选旁挂的 `.grid.json` 里。
   *
   * ── 为什么每候选一组，而不是合并成一份 ──
   * v3 每次 `evaluate` 各跑一张网格，各自那份旁挂件才是那一次的证据（真档里两次提交之间可能
   * 换了陪练池，或者还停在旧的一份）。合并展示会把「第 2 次评测跟第 1 次是同一张网格吗」
   * 这个可查的事实抹平。
   *
   * ── 为何又去重，与**谁**比 ──
   * 真档（`archive/gpt-6-luna/2026-11-19T01-33-42-820Z`）两个候选的两份 `.grid.json` 是**逐字
   * 相同**的（同一 `planSha256`）：把那四行再排一遍只会让人以为两次评测的对手变了。所以
   * 逐字相同的就写「与第 N 步候选逐字相同」，不重复四份身份——但两个候选各自的文件仍是
   * 分开读的（上一条的那句话只有在两份都读过之后才能说得出来）。
   *
   * 比对的是**首次出现的那一份**，不是「上一份」：三份档里若第 1、3 份同、第 2 份不同，
   * 把第 3 份说成「与上一份相同」是假话（上一份恰好是那一份不同的）。指向首次出现的那一份，
   * 说出的那个步号永远是真的；而「中间隔了一份别的网格」这个事实在别处（上面那份的完整列表）
   * 已经写出来了，不需要靠去重行去暗示。
   *
   * 读不到就写「未记录」（并指名找的是哪个文件）——不猜、不抛。
   */
  const renderSparring = (sparring: readonly ReportCandidateSparring[]): string[] => {
    const lines: string[] = [];
    // 首次出现且身份可读的那一份：下面每份都与它比，写出来的步号就永远指得到那份真列表。
    let first: ReportCandidateSparring | undefined;
    for (const reading of sparring) {
      const where = `来源 ${escape(reading.source)}${
        reading.planSha256 === null ? "" : `；planSha256=${reading.planSha256}`
      }`;
      if (reading.scripts === null) {
        lines.push(`- 陪练：未记录（第 ${reading.protocolRound} 步候选，${where}）`);
        continue;
      }
      const sameAs = first;
      if (
        sameAs !== undefined &&
        JSON.stringify(sameAs.scripts) === JSON.stringify(reading.scripts) &&
        sameAs.planSha256 === reading.planSha256
      ) {
        lines.push(
          `- 陪练（第 ${reading.protocolRound} 步候选，${where}）：与第 ${sameAs.protocolRound} 步候选逐字相同（同一张网格，四份身份不重列）`,
        );
        // 去重只去「四份身份」那几行；自指是**这一份**自己的判定，仍单独说一句。
        if (reading.selfReference !== null)
          lines.push(
            `  - **陪练 = 本席位上一场（\`${reading.selfReference.runId}\`）；本场与它不可直接比**`,
          );
        continue;
      }
      lines.push(`- 陪练（第 ${reading.protocolRound} 步候选，${where}）：`);
      for (const script of reading.scripts) lines.push(`  - ${renderPlanScript(script)}`);
      // 自指单独一行：它不是第四份身份的注，而是「这一场的分数不能当能力提升读」那句。
      if (reading.selfReference !== null)
        lines.push(
          `  - **陪练 = 本席位上一场（\`${reading.selfReference.runId}\`）；本场与它不可直接比**`,
        );
      first ??= reading;
    }
    return lines;
  };
  const fields = [
    "sendMs",
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "cacheWrite5m",
    "cacheWrite1h",
    "reasoning",
  ] as const;
  /**
   * 百分比只用于渲染：JSON 里保留原比率，不把四舍五入后的值当读数。
   * 缺失就是 null，不渲染成 0%——没记录和真实零命中是两件事。
   */
  const percent = (value: number | null): string =>
    value === null ? "null" : `${(value * 100).toFixed(1)}%`;
  /** 空集合写「无」（关联失败的那一侧真的没有），不写 0。 */
  const renderNumbers = (values: readonly number[]): string =>
    values.length === 0 ? "无" : values.join(" / ");
  /** 分位一格：`count: 0` 写「不适用」——缺数据不写 0。 */
  const renderPercentiles = (reading: ReportPercentiles): string =>
    reading.count === 0
      ? "不适用"
      : `${reading.p50} / ${reading.p95} / ${reading.max}（n=${reading.count}）`;
  /**
   * 受污染那一格的三态：`null`（one-shot 档不属本口径）/ `clean` / `contaminated`。
   * 累计退避是 `null` 时写 null 并注明原因，不写成 0 秒。
   */
  const renderContamination = (reading: ReportContamination | null): string => {
    if (reading === null)
      return "不适用（one-shot 档该列恒 null：`readFailureRecords` 刻意跳过参赛模型，本报告不改那条口径——不是「没撞过限流」）";
    const backoff =
      reading.backoffMs === null
        ? "null（旧档的日志行没有 backoffMs：缺数据不补零）"
        : `${reading.backoffMs} ms`;
    return `${reading.state}（429 尝试 ${reading.rateLimitedAttempts} 次；累计退避 ${backoff}；命中判据=${reading.reasons.length === 0 ? "无" : reading.reasons.join(" / ")}）`;
  };
  const labels = {
    sendMs: "sendMs",
    input: "输入 token",
    output: "输出 token",
    cacheRead: "缓存读",
    cacheWrite: "缓存写",
    cacheWrite5m: "缓存写 5m",
    cacheWrite1h: "缓存写 1h",
    reasoning: "推理",
  };
  const renderTerminal = (reading: TrialObservationLine): string[] => {
    const summary = reading.terminalSummary;
    if (summary === undefined) return ["- 终局事实未知；缺失不解释为零分、零名次积分或未淘汰。"];
    const unitTable = (table: typeof summary.unitCosts): string =>
      `worker=${table.worker}；melee=${table.melee}；ranged=${table.ranged}；cavalry=${table.cavalry}`;
    return [
      `- 终局事实 v${summary.version}：seed=${summary.seed}；tick=${summary.tick}（已执行 tick 数／下一 tick 编号）；reason=${summary.reason}`,
      `- 计分权重：baseScore=${summary.weights.baseScore}；resourceScore=${summary.weights.resourceScore}；unitCostDivisor=${summary.weights.unitCostDivisor}`,
      `- 单位造价：${unitTable(summary.unitCosts)}；名次积分表：${summary.rankPoints.join("/")}`,
      ...summary.players.flatMap((player) => [
        `- seat=${player.seat}；player=${escape(player.player)}；controlledBases=${player.controlledBases}；controlledResources=${player.controlledResources}`,
        `  - survivingUnits：${unitTable(player.survivingUnits)}；survivingUnitCost=${player.survivingUnitCost}`,
        `  - score：bases=${player.score.bases}；resources=${player.score.resources}；units=${player.score.units}`,
        `  - territoryScore=${player.territoryScore}；rank=${player.rank}；rankPoints=${player.rankPoints}；alive=${player.alive}；eliminatedAtTick=${player.eliminatedAtTick ?? "null"}`,
      ]),
    ];
  };
  const renderFacts = (observations: ReportObservations): string[] => {
    return observations.readings.flatMap((reading) => {
      const lines = [
        `- 对局下标 ${reading.matchIndex}；快照读数：delivered=${reading.delivered}，captures=${reading.captures}；noScoreSource=${reading.noScoreSource}`,
        ...renderTerminal(reading),
      ];
      const facts = reading.actionFacts;
      if (facts === undefined) return [...lines, "- 行动事实缺失；缺失不解释为零行动。"];
      lines.push(
        `- 行动事实 v${facts.version}：scriptSha256=${facts.scriptSha256}；seed=${facts.seed}；seat=${facts.seat}；complete=${facts.complete}；覆盖 observedTicks=${facts.observedTicks}，missingTicks=${facts.missingTicks}`,
      );
      if (!facts.complete) return [...lines, "- 不完整行动事实：计数未展示；缺失不解释为零行动。"];
      lines.push(
        `- 调用数（不等于成功）：${ACTION_API_NAMES.map((name) => `${name}=${facts.calls[name]}`).join("；")}`,
        "- 公开即时错误返回数：",
        ...ACTION_API_NAMES.map(
          (name) =>
            `  - ${name}: ${ACTION_ERROR_CODES.map((code) => `${code}=${facts.errors[name][code]}`).join("；")}`,
        ),
        `- 宿主结算效果：${ACTION_EFFECT_NAMES.map((name) => `${name}=${facts.effects[name]}`).join(
          "；",
        )}`,
      );
      return lines;
    });
  };
  const out = [
    "# 生成归档报告",
    "",
    "> usage 的 cache / reasoning 是组成明细，不重复加总。缺失用 null；部分数据只给已记录小计。缓存写再按 TTL 分 5m / 1h 两档，它们与总量是组成关系而非互相冲突；缓存命中率 = 缓存读 / 总输入，只算两项都记到的轮，合计覆盖不完整时不给值。收敛响应与全部 HTTP 尝试是重叠证据，不相加作账单；传输错误消费未知。",
    "> 三类分数互不替代：生成阶段（网格平均名次积分，分母 = 每候选场数）／选拔复算（独立子进程重跑同一张网格，只作校验读数，不是第二个排名依据）／赛季（赛季报告口径，本报告不冒充）。不属本档口径的分数写「不适用」，不补零、不留空。",
    "> 配置和渠道能力是请求意图与支持声明；HTTP 接受不证明参数执行，服务端模型回报不认证后端身份。证据来源自由文本、prompt、原响应与诊断不公开。",
    "> --run-id 显式指定本轮标识：其它记录为历史；未指定时全部未分轮，不将历史失败当作本轮失败或参赛资格。",
    "> 最终观测独立读取 observed-<runId>.jsonl；旧档标记最后完成试跑，可能在 infra 后留旧读数。回喂前后的候选按协议 round 单列，不合并命中数。成功档最后 round 与最终文件精确匹配且新事实 hash 符合 meta 编译 JS hash 时标记最终候选。",
    // 命中率的口径必须写在报告正面：它一旦被当效率指标读，结论就会反。
    "> 缓存命中率是**回归哨兵**，不是效率指标：agent 形态每步重发完整历史，分子分母同步长，命中率是步数的函数而不是缓存效率的函数。它低于该步的理论值只说明前缀被打断了（时间戳注入、序列化不确定、中途改 system）——那是别处看不见的真 bug 信号。有信息量的是每步 prompt 大小与增长。",
    "> 步级耗时是诊断列，不是排名主指标：`stepMs = sendMs + harnessMs`（模型慢还是沙箱慢由两列分开回答），会话总墙钟由 `max(atMs + sendMs + harnessMs)` 跨步聚合，档案顶层不另放一份。分位按最近秩（不插值）；缺数据写 null，不写 0。",
    "",
  ];
  if (reports.length === 0) out.push("没有匹配的生成档案。", "");
  for (const [scope, label] of [
    ["current-run", "本轮"],
    ["historical", "历史"],
    ["unscoped", "未分轮"],
  ] as const) {
    const scoped = reports.filter((report) => report.runScope === scope);
    out.push(
      `- ${label}：成功记录 ${scoped.filter((report) => report.kind === "success").length}；失败记录 ${scoped.filter((report) => report.kind === "failure").length}（记录数，不是参赛模型数）`,
    );
  }
  out.push("");
  for (const report of reports) {
    /**
     * TTL 分档只在该报告真记到时出现：chat 族没有这两档，不留两列恒 null 的列/小计噪声。
     * 判据看收敛轮与全部尝试——尝试证据里记到的分档同样不该被隐藏。
     */
    const ttlRecorded = report.rounds.some(
      (round) =>
        round.usage.cacheWrite5m.state === "recorded" ||
        round.usage.cacheWrite1h.state === "recorded" ||
        round.attempts.some(
          (attempt) =>
            attempt.usage.cacheWrite5m.state === "recorded" ||
            attempt.usage.cacheWrite1h.state === "recorded",
        ),
    );
    const shownFields = fields.filter(
      (field) => ttlRecorded || !(TTL_WRITE_FIELDS as readonly string[]).includes(field),
    );
    /**
     * 过程记录里出现过几步——失败档渲染候选那一行时的第二列。
     *
     * 它**不是**「这一跑 evaluate 了几次」：那个数以前由动作列数出来（`action === "evaluate"`），
     * 而动作标签是人读的注解——模型把 `check` 与 `evaluate` 写进同一块时它记成 `bash`，据此计数
     * 只会少数（真档里 2 个候选记成 1 次）。评测过几次在过程记录里根本没有结构化的落点，所以报
     * 告不造这个数：把两个能数的事实并置（候选描述符数 / 过程记录步数），差额叫「未保留」。
     */
    const stepEntries = report.steps?.entries.length ?? 0;
    out.push(
      `## ${escape(report.model)} · ${report.kind}`,
      "",
      `- 来源：\`${escape(report.source)}\``,
      `- 运行标识：${escape(report.runId)}；归属：${report.runScope}`,
      `- 协议轮数：${report.protocolRounds}（已收敛，不含 transport 末行）`,
      `- 已记录有效阶段数：${report.candidateStages}；不同 JS 数：${report.distinctScripts}`,
      `- 模型预算：每阶段收敛响应上限 ${report.budget.model.maximumResponsesPerStage ?? "null"}；全程上限 ${report.budget.model.maximumConvergedResponses ?? "null"}；实际已收敛 ${report.budget.model.convergedResponses}`,
      `- HTTP 尝试：已记录 ${report.budget.model.recordedAttempts}；完整尝试证据覆盖 ${report.budget.model.attemptEvidenceRounds}/${report.budget.model.expectedAttemptEvidenceRounds} 轮；带 token 统计响应 ${report.budget.model.responseAttemptsWithUsage}；传输错误 ${report.budget.model.transportErrors}；已记录但消费未知 ${report.budget.model.unknownConsumptionAttempts}`,
      `- 本地预算：有效候选优化观测 ${report.budget.local.optimizationObservedMatches ?? "null"} 场（不代表全部重跑/无效候选执行）；选拔上限 ${report.budget.local.selectionMaximumMatches ?? "null"} 场；已证实执行 ${report.budget.local.selectionExecutedMatches ?? "null"} 场；复用 ${report.budget.local.selectionReusedMatches ?? "null"} 场`,
      `- 日志：${report.log.state}（收敛可读 ${report.log.readableRounds}/${report.protocolRounds} 轮；记录 ${report.log.recordedLines} 行）`,
      // 分组维度与形状事实：步级分位的分组键就是这两格（ADR-0035）。
      `- 分组键：modelVersion=${escape(report.modelVersion ?? "null")}；harnessDigest=${escape(report.shape.harnessDigest ?? "null")}`,
      `- 形状：archiveSchemaVersion=${report.shape.archiveSchemaVersion}；harness=${escape(report.shape.harnessVersion ?? "null")}；上下文窗口=${report.shape.contextLength ?? "null"}；终止=${report.shape.termination ?? "null"}${report.shape.atStep === null ? "" : `（第 ${report.shape.atStep} 步）`}`,
      `- 受污染：${renderContamination(report.contamination)}`,
    );
    if (report.failure !== null)
      out.push(
        `- 失败分类：${escape(report.failure.classification)}`,
        `- 诊断条数：${report.failure.diagnosticsCount}（原文不公开）`,
      );
    const ttlCells = (round: ArchiveReportRound): string =>
      ttlRecorded
        ? `${round.usage.cacheWrite5m.value ?? "null"} | ${round.usage.cacheWrite1h.value ?? "null"} | `
        : "";
    out.push(
      "",
      ttlRecorded
        ? "| 轮次 | sendMs | 输入 token | 输出 token | 缓存读 | 缓存写 | 缓存写 5m | 缓存写 1h | 推理 | 缓存命中率 |"
        : "| 轮次 | sendMs | 输入 token | 输出 token | 缓存读 | 缓存写 | 推理 | 缓存命中率 |",
      ttlRecorded
        ? "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
        : "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const round of report.rounds)
      out.push(
        `| ${round.responseConverged ? round.round : `${round.round}（未收敛 transport）`} | ${round.sendMs ?? "null"} | ${round.usage.input.value ?? "null"} | ${round.usage.output.value ?? "null"} | ${round.usage.cacheRead.value ?? "null"} | ${round.usage.cacheWrite.value ?? "null"} | ${ttlCells(round)}${round.usage.reasoning.value ?? "null"} | ${percent(round.cacheHitRate)} |`,
      );
    /**
     * 步级表**只在该档真有过程记录条目时出现**：v1 / v2 没有 `steps`（`report.steps === null`），
     * 零步会话是 `entries: []`。两种都不渲染步列——没数据不渲染 0，也不留空表头。
     */
    if (report.steps !== null && report.steps.entries.length > 0) {
      const steps = report.steps;
      const stats = steps.stats;
      out.push(
        "",
        "### 步级度量（轮号 = 步号）",
        "",
        `- 步数：${stats.steps}；轮 × 步关联：${steps.join.matched}/${steps.entries.length} 匹配（缺日志行的步=${renderNumbers(steps.join.stepsWithoutRound)}；缺过程记录的轮=${renderNumbers(steps.join.roundsWithoutStep)}；传输末行不占步，不算不匹配）`,
        `- 步级耗时 p50/p95/max：stepMs=${renderPercentiles(stats.stepMs)}；sendMs=${renderPercentiles(stats.sendMs)}；会话中位数 stepMs=${stats.sessionMedianStepMs ?? "null"}；会话总墙钟（max of atMs+stepMs）=${stats.sessionWallClockMs ?? "null"}`,
        `- prompt 大小 p50/p95/max：${renderPercentiles(stats.inputTokens)}；每步增长 input[i]−input[i−1] 的最大值=${stats.maxInputGrowth ?? "null"}（首步是 null，不是 0）`,
        "",
        "| 步 | 动作 | stepMs | sendMs | harnessMs | atMs | 输入 token | 增长 | 缓存命中率 | 结果 | 关联 |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
      );
      for (const step of steps.entries)
        out.push(
          `| ${step.step} | ${step.action ?? "null"} | ${step.stepMs ?? "null"} | ${step.sendMs ?? "null"} | ${step.harnessMs ?? "null"} | ${step.atMs ?? "null"} | ${step.inputTokens ?? "null"} | ${step.inputGrowth ?? "null"} | ${percent(step.cacheHitRate)} | ${step.result === null ? "null" : `${step.result.kind}（${step.result.errorCodes.length} 个错误码）`} | ${step.roundLinked ? "round==step" : "缺日志行"} |`,
        );
      /**
       * 候选序与步：序的**真源是候选描述符**（`optimization.candidates` 的
       * `step` / `scriptSha256` / `score`），不是「动作标签等于 `evaluate` 的那些步」。
       *
       * 两者的区别是真会话上撞见的：模型把 `check` 与 `evaluate` 写进同一块时动作记成 `bash`，
       * 于是档案里有 2 个候选、报告只列出 1 条。动作标签是**人读的注解**，不能承担「有没有提交
       * 过」的判据——它现在只回答「这一步除提交之外还跑了什么」。
       *
       * 这里**不猜模型命令写了什么**（那要 grep 自由文本，ADR-0036 已否掉那种分类法），只报
       * 结构事实：候选在第几步、两次之间过了几步、两次提交的字节同不同。
       */
      // 一条候选描述符 = 一次提交（ADR-0030）；序按步号递增，装载期已核过。
      const commits = report.scores;
      if (commits.length > 0) {
        out.push(
          "",
          "候选序（`evaluate` 即提交）：",
          "- 真源：候选描述符（`optimization.candidates`）；动作标签只作注，不参与筛选",
        );
        for (const [index, commit] of commits.entries()) {
          const previous = commits[index - 1];
          const between =
            previous === undefined
              ? []
              : steps.entries.filter(
                  (entry) =>
                    entry.step > previous.protocolRound && entry.step < commit.protocolRound,
                );
          // 动作标签降级为注：是 `evaluate`（提交）时注为空，否则注出「这一步的动作不是提交」。
          //
          // 旧文案是「这一步**还**跑了别的命令」——那个「还」说的是同一块里并存两件事（`check`
          // 与 `evaluate` 写在一起）。新世界里一次调用就是一步，并行性根本不存在，所以那句话
          // 现在是无意义的：动作标签不是 `evaluate` 就只是「这一格不是提交」，没有第二个动作
          // 可「还」。
          //
          // 不说「不产出候选」：这一行本身就是一条候选（它来自描述符），那么写会有两句真话
          // 互相打脸。v4 里这一注只在档案自相矛盾时（有候选而动作标签不是 `evaluate`）才渲染；
          // v3 真档里它渲染说明那时 `check` 与 `evaluate` 写在同一块——正是这条注要说清的事。
          const stepEntry = steps.entries.find((entry) => entry.step === commit.protocolRound);
          const actionNote =
            stepEntry === undefined
              ? "；这一步不在过程记录里（动作未知）"
              : stepEntry.action === "evaluate"
                ? ""
                : `；这一步的动作是 ${stepEntry.action ?? "null"}，不是提交`;
          out.push(
            `- 第 ${commit.protocolRound} 步：scriptSha256=${commit.scriptSha256}${actionNote}` +
              (previous === undefined
                ? ""
                : `；与上一次提交（第 ${previous.protocolRound} 步）${previous.scriptSha256 === commit.scriptSha256 ? "**字节相同**" : "字节不同"}；之间经过 ${between.length} 步（${between.length === 0 ? "无" : between.map((entry) => `${entry.step}:${entry.action ?? "null"}`).join(" / ")}）`),
          );
        }
      }
      /**
       * 工具调用：**逐字字节**与**解析值**并排（v4 才有这一格）。
       *
       * `argumentsJson` 必须**原样**出现：这条证据的全部意义是「发回历史的 `arguments` 与
       * 这里逐字相同」（ADR-0031）。所以报告只搬 `steps[i].toolCall.argumentsJson`，**不按
       * `action.command` 重编码**——两者可以不同形（转义写法、多余空格），而重编码等于
       * 悄悄换掉发回去的东西。
       *
       * `command` 是另一个家：`action.command` 的解析值（写侧算好、原样落档）。它在这里是为了
       * 回答「`raw` 是空串的那一步到底干了什么」——逐字字节读不出人话，而解析值又不能拿来
       * 充当「发回去的那串」；两个都给，读者才看得出它们在哪里分岔。
       *
       * 只有 `bash` 那一档有 `command`（其余四个工具不收参数），所以那一格缺席时不渲染半边。
       * v3 档没有 `toolCall`（那时还没有工具调用信封），整节不渲染。
       */
      const calls = steps.entries.filter((step) => step.toolCall !== null);
      if (calls.length > 0) {
        out.push(
          "",
          "工具调用（`argumentsJson` 是逐字字节，发回历史的 `arguments` 与这里相同；`command` 是 `action.command` 的解析值，只有 `bash` 那一档有）：",
        );
        for (const step of calls)
          out.push(
            `- 第 ${step.step} 步：name=${escape(step.toolCall!.name)}${step.command === null ? "" : `；command=${escape(step.command)}`}；argumentsJson=${escape(step.toolCall!.argumentsJson)}`,
          );
      }
      const results = steps.entries.filter((step) => step.result !== null);
      // `result` 缺席（这一步没有结果）**不渲染**；`errorCodes: []` 渲染成空（跑过了、没错误）。
      if (results.length > 0) {
        out.push("", "结果侧证据（真源在过程记录）：");
        for (const step of results)
          out.push(
            `- 第 ${step.step} 步：kind=${step.result!.kind}；errorCodes=${step.result!.errorCodes.length === 0 ? "（空）" : step.result!.errorCodes.map(escape).join(" / ")}`,
          );
      }
    } else if (report.steps !== null)
      out.push("", "- 步级度量：不适用（本档过程记录为空——零步会话，不是「没记」）");
    out.push("", "### 参数与尝试证据", "");
    for (const round of report.rounds) {
      out.push(
        `- 第 ${round.round} 轮：${round.responseConverged ? "已收敛响应" : "未收敛 transport 尝试"}；实际参数 ${escape(JSON.stringify(round.params.values))}；采样偏置已配置=${round.params.samplingBiasConfigured}`,
      );
      const request = round.requestEvidence;
      if (request === null) out.push("- 规范政策证据缺失（旧档不追填）。");
      else
        out.push(
          `- 配置 ID=${escape(request.configId)}；ID 匹配=${request.configIdMatches}；端点族=${request.endpointFamily ?? "null"}；后端身份=${request.backendIdentity}`,
          `- 端点能力：official=${request.endpoint.official ?? "null"}；channel=${request.endpoint.channel ?? "null"}`,
          `- 推理意图=${request.reasoning.intent ?? "null"}；控制=${request.reasoning.control ?? "null"}；thinking 预算=${request.reasoning.budgetTokens ?? "null"}；official=${request.reasoning.official ?? "null"}；channel=${request.reasoning.channel ?? "null"}`,
          `- 输出字段=${request.output.field ?? "null"}；上限=${request.output.maxTokens ?? "null"}；含推理=${request.output.includesReasoning ?? "null"}；official=${request.output.official ?? "null"}；channel=${request.output.channel ?? "null"}`,
          `- 缓存断点：mode=${request.cache?.mode ?? "null"}；official=${request.cache?.official ?? "null"}；channel=${request.cache?.channel ?? "null"}`,
          `- 请求头契约：authentication=${request.transport.authentication ?? "null"}；版本头有记录=${request.transport.versionHeaderRecorded}`,
        );
      out.push(`- 停止：${escape(JSON.stringify(round.stop))}；尝试证据=${round.attemptCoverage}`);
      for (const attempt of round.attempts) {
        out.push(
          `- 第 ${round.round} 轮 attempt ${attempt.attempt}：${attempt.outcome}；失败细分=${attempt.failureKind ?? "null"}；停止 ${escape(JSON.stringify(attempt.stop))}；token ${shownFields
            .filter((field) => field !== "sendMs")
            .map((field) => `${labels[field]}=${attempt.usage[field].value ?? "null"}`)
            .join("；")}`,
        );
      }
    }
    out.push("", "### 计划、陪练与三类分数", "");
    if (report.plan === null)
      out.push(
        // 「不追填」说的是**档案**不回填；v3 的陪练身份改从旁挂件读（下一节），不是把它堵在档里。
        "- 生成阶段计划：不适用（版本 1 历史档没有计划字段，不迁移、不回填）" +
          "；v3 分步档的优化段也不装计划——网格计划不进档案" +
          (report.sparring.length > 0
            ? "；这一跑跟谁打从候选旁挂的 `.grid.json` 读（见下）"
            : "，不追填"),
      );
    else out.push(...renderGridPlan(report.plan));
    if (report.sparring.length > 0) out.push(...renderSparring(report.sparring));
    out.push(
      "- 同字节直读：看下表「复用来源」列——标出阶段号的是编译产物与那一阶段字节相同、复用它的网格结果",
      "- 不适用 = 该口径不属本档（v1 历史档没有网格分数；无选拔段时没有复算读数；赛季分数恒不适用）",
    );
    if (report.scores.length === 0)
      out.push(
        // 失败档的候选**字节**随清理撤掉了，于是描述符也不写进记录（`failure.ts` 的
        // `retainedCandidatesOf`）。两列并置：记录里留了几个候选描述符、过程记录里出现过几步。
        // 差额按上一轮口径渲染成「未保留」，**不渲染成异常**——这是我们主动没留，不是搬运事故。
        // 这里不再从动作列数「这一跑 evaluate 了几次」：动作标签是注解，不能当计数（见 `stepEntries`）。
        report.kind === "failure" && stepEntries > 0
          ? `- 候选：未保留（候选描述符数 ${report.candidateStages}；过程记录里出现过的步数 ${stepEntries}；差额按「未保留」记，不当作异常——描述符与字节随失败清理一并撤掉，动作列不是计数判据）`
          : "- 候选分数：不适用（本档没有优化旁证，没有候选可出分数）",
      );
    else
      out.push(
        "",
        "| 阶段 | 协议轮 | JS hash | TS hash | 复用来源 | 生成阶段分数 | 选拔复算（校验读数） | 赛季分数 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        ...report.scores.map(
          (score) =>
            `| ${score.stage} | ${score.protocolRound} | ${score.scriptSha256} | ${score.sourceSha256 ?? "null"} | ${score.reusedFromStage === null ? "null" : `stage${score.reusedFromStage}`} | ${renderScore(score.generation)} | ${renderScore(score.selection)}${score.agreement === "identical" ? "（与生成阶段逐位相同）" : ""} | ${renderScore(score.season)} |`,
        ),
      );
    if (report.selection !== null) {
      const selection = report.selection;
      const plan = selection.plan;
      out.push(
        "",
        "### 有效候选选拔",
        "",
        `- 胜者 stage=${selection.stage}；协议轮=${selection.protocolRound}；JS=${selection.scriptSha256}；TS=${selection.sourceSha256}`,
        `- 胜者选拔读数：平均名次积分=${selection.averagePoints}；固定分母=${selection.countedMatches}；理由=${selection.reason}；胜者复用来源=${selection.reusedFromStage === null ? "null" : `stage${selection.reusedFromStage}`}`,
        `- 选拔计划：v${plan.version}；planSha256=${selection.planSha256}；每候选场数=${plan.matchesPerCandidate}；正文 ${escape(plan.source)}`,
        ...(plan.kind === "grid"
          ? [
              "- 选拔计划口径：评测网格（四陪练 × 四座位 × 两图），与生成阶段计划逐字相同；陪练身份、地图与组合见上节，这里不重列",
            ]
          : [
              `- 地图（1 张）：${escape(plan.map.name)}=${plan.map.sha256}`,
              `- 基准（${plan.baselines.length} 份）：${plan.baselines.map((baseline) => `${escape(baseline.id)}=${baseline.scriptSha256}`).join("；")}`,
            ]),
        `- 独立 seeds=${renderSeeds(plan.seeds)}；不同 JS=${selection.distinctScripts}；已执行 ${selection.executedMatches} 场；复用 ${selection.reusedMatches} 场`,
        `- 环境：rulesetSha256=${selection.rulesetSha256}；runtime=${selection.sandboxRuntimeHash}`,
        `- 实际冻结候选位置=${report.frozenCandidate?.stage ?? "null"}；冻结字节校验=${report.frozenCandidate?.scriptState ?? "null"}；末位候选位置=${report.finalCandidate?.stage ?? "null"}`,
      );
    }
    if (report.failure?.classification === "selection")
      out.push("- 选拔失败：无胜者、无冻结脚本；未完成对局数与用量保持未知，不按部分结果计分。");
    if (report.selectionFailure !== null)
      out.push(
        `- 失败选拔计划=${report.selectionFailure.planSha256}；每候选固定分母=${report.selectionFailure.matchesPerCandidate}；候选 TS/JS 身份=${escape(JSON.stringify(report.selectionFailure.candidates))}`,
      );
    out.push("", "### 合计（仅收敛响应）", "");
    for (const field of shownFields) {
      const summary = report.totals[field];
      out.push(
        `- ${labels[field]}：${summary.value ?? "null"}（已记录小计 ${summary.recordedTotal ?? "null"}；覆盖 ${summary.recordedRounds}/${summary.expectedRounds}）`,
      );
    }
    const hit = report.cacheHitRate;
    const hitTotals = `缓存读 ${hit.cacheReadTotal ?? "null"} / 输入 ${hit.inputTotal ?? "null"}；覆盖 ${hit.recordedRounds}/${hit.expectedRounds}`;
    out.push(
      `- 缓存命中率：${percent(hit.value)}（已记录 ${percent(hit.recordedValue)}；${hitTotals}）`,
    );
    out.push("", "### 逐轮字段来源", "");
    for (const round of report.rounds) {
      out.push(`- 第 ${round.round} 轮 sendMs：${round.sendMs ?? "null"}（generationLog.sendMs）`);
      for (const [name, usage] of Object.entries(round.usage)) {
        if (!ttlRecorded && (TTL_WRITE_FIELDS as readonly string[]).includes(name)) continue;
        const state = usage.state === "null" ? "显式 null" : usage.state;
        const candidates = usage.conflict
          ? `；冲突：${usage.candidates.map((candidate) => `${candidate.source}=${String(candidate.value)}`).join("；")}`
          : "";
        out.push(
          `- 第 ${round.round} 轮 ${labels[name as keyof ReportUsage]}：${usage.value ?? "null"}（${state}）；采用 ${escape(usage.source ?? "null")}${usage.semantic === null ? "" : `；口径 ${usage.semantic}`}${escape(candidates)}`,
        );
      }
    }
    for (const issue of report.log.issues)
      out.push(`- 日志第 ${issue.line} 行：${escape(issue.reason)}`);
    /**
     * 候选分节：**同一份候选只列一次**。
     *
     * v3 的候选可能是 1 个，那时「初次」与「最终」是同一份（末位即最终候选），逐节列会把同
     * 一份字节写两遍——读起来像两次评测。所以按候选身份（source + hash）合并标签：重复的那几
     * 份只出一节，标题写全它担任的角色。
     */
    const candidateSections: { labels: string[]; candidate: ReportCandidate }[] = [];
    for (const [label, candidate] of [
      ["初次候选", report.initialCandidate],
      ...report.intermediateCandidates.map((candidate) => ["中间候选", candidate] as const),
      ["最终候选", report.finalCandidate],
    ] as const) {
      if (candidate === null) continue;
      const listed = candidateSections.find(
        (section) =>
          section.candidate.scriptSource === candidate.scriptSource &&
          section.candidate.scriptSha256 === candidate.scriptSha256,
      );
      if (listed === undefined) candidateSections.push({ labels: [label], candidate });
      else if (!listed.labels.includes(label)) listed.labels.push(label);
    }
    /**
     * 候选字节的读数**按档分派**。
     *
     * 失败档的发布不变量是「只写 `failed-<runId>.json`」,所以那一档的候选字节本来就该不在
     * (`packages/gen/src/pipeline.ts` 的 `finally` 清掉,描述符按「字节还在才写」落盘)。给它写
     * `missing` 会把「我们主动没留」说成「字节丢了」——那是搬运事故的读数,不是这一档的事实。
     * 数据层(`ReportCandidate.scriptState`)照旧是 `missing`(盘上确实没有),只有渲染改口:
     * 判据不因为措辞而放宽。
     */
    const scriptStateLabel = (state: ReportCandidate["scriptState"]): string =>
      report.kind === "failure" && state === "missing"
        ? "未保留（失败档只留 failed-<runId>.json，候选字节随清理撤掉）"
        : state;
    for (const { labels, candidate } of candidateSections) {
      const label = labels.join("兼");
      out.push(
        "",
        `### ${label}（协议轮 ${candidate.protocolRound}）`,
        "",
        `- JS 来源：${escape(candidate.scriptSource)}；状态：${scriptStateLabel(candidate.scriptState)}`,
        `- scriptSha256=${candidate.scriptSha256}；实际 hash=${candidate.actualScriptSha256 ?? "null"}`,
        // 参数只写白名单投影（与逐轮同一套）：原值含 `stop` / `logit_bias` 的自由文本，不回显。
        ...(candidate.params === undefined
          ? ["- 实际参数：旧档未记录（不追填）"]
          : [
              `- 实际参数（白名单投影）：${escape(JSON.stringify(candidate.params.values))}；采样偏置已配置=${candidate.params.samplingBiasConfigured}`,
            ]),
        `- 观测状态：${candidate.observations.state}；来源：${escape(candidate.observations.source)}`,
        `- 实际场数 ${candidate.observations.observedMatches ?? "null"}；noScoreSource ${candidate.observations.noScoreSource ?? "null"}`,
        ...renderFacts(candidate.observations),
        ...candidate.observations.issues.map(
          (issue) => `- 观测第 ${issue.line} 行：${escape(issue.reason)}`,
        ),
      );
    }
    if (report.initialCandidate !== null) {
      out.push("");
      continue;
    }
    const observations = report.observations;
    out.push(
      "",
      `- 观测状态：${observations.state}；来源：${observations.source ?? "null"}`,
      `- ${observations.candidate === "final-candidate" ? `最终候选（协议轮 ${observations.protocolRound}）` : observations.candidate === null ? "无可用观测" : "最后完成试跑"}：实际场数 ${observations.observedMatches ?? "null"}；noScoreSource ${observations.noScoreSource ?? "null"}`,
      `- 候选标记：${observations.candidate ?? "null"}`,
    );
    for (const issue of observations.issues)
      out.push(`- 观测第 ${issue.line} 行：${escape(issue.reason)}`);
    out.push(...renderFacts(observations));
    out.push("", "### 逐候选观测（不合计）", "");
    for (const candidate of report.candidateObservations) {
      out.push(
        `- 协议轮 ${candidate.protocolRound}：${candidate.state}；实际场数 ${candidate.observedMatches ?? "null"}；noScoreSource ${candidate.noScoreSource ?? "null"}；来源：${escape(candidate.source)}`,
      );
      out.push(...renderFacts(candidate));
      for (const issue of candidate.issues)
        out.push(
          `- 协议轮 ${candidate.protocolRound} 观测第 ${issue.line} 行：${escape(issue.reason)}`,
        );
    }
    out.push("");
  }
  /**
   * 跨记录的步级分位：分组维度是 `modelVersion + harnessDigest`（ADR-0035 与榜键一致）。
   * 没步的档（v1 / v2）不进任何分组——它们没有可比的步。
   */
  const groups = stepGroupsOf(reports);
  if (groups.length > 0) {
    out.push(
      "",
      "## 步级分位（按 modelVersion + harnessDigest 分组）",
      "",
      "> 分位按会话里每一步的读数汇总（最近秩，不插值）；会话中位数是各会话中位数的中位数。受污染会话按 ADR-0036 单列在下一张表、不参与本表分位——「已单列」一列把排除做成可见，而不是让它静默地少几行。步级成本全是诊断列，不是排名主指标。",
      "",
      "| modelVersion | harnessDigest | 干净会话 | 步数 | stepMs p50/p95/max | sendMs p50/p95/max | 会话中位数 stepMs | 已单列（受污染） |",
      "| --- | --- | ---: | ---: | --- | --- | ---: | ---: |",
      ...groups.map(
        (group) =>
          `| ${escape(group.modelVersion ?? "null")} | ${escape(group.harnessDigest ?? "null")} | ${group.sessions} | ${group.steps} | ${renderPercentiles(group.stepMs)} | ${renderPercentiles(group.sendMs)} | ${group.sessionMedianStepMs ?? "null"} | ${group.contaminatedSessions} |`,
      ),
    );
  }
  /** 受污染会话：成绩保留，但单列。阈值由常量渲染进脚注，不藏在代码里。 */
  const contaminated = reports.filter((report) => report.contamination?.state === "contaminated");
  if (reports.length > 0) {
    out.push(
      "",
      "## 受污染会话（单列，成绩保留）",
      "",
      `> 判据在报告侧（ADR-0036）：累计退避 > ${CONTAMINATION_THRESHOLDS.backoffMs} ms 或 429 次数 ≥ ${CONTAMINATION_THRESHOLDS.rateLimitedAttempts} 即受污染。两个数都是估值不是实测；返第一季数据时改的只是报告侧阈值，不动采集。撞过限流的会话**成绩不作废**：步数、被挡次数、等了多少秒、分数都在下面的表里。`,
      "> one-shot 档这一格恒 null：`readFailureRecords` 刻意跳过参赛模型（`reporter.ts`），本报告不为封存的历史榜改那条口径——所以「没有受污染会话」不等于「所有会话都干净」。累计退避读的是日志行的 `backoffMs`（生成侧按**实测**等待写：没有退避写 0）；旧档没有这一格时写 null 而不是 0：缺数据不补零，那些会话的判据仍只由 429 次数承担。",
      "",
    );
    if (contaminated.length === 0)
      out.push("- 本次报告里没有受污染会话（one-shot 档该列恒 null，不代表干净）。");
    else
      out.push(
        "| 模型 | 运行标识 | modelVersion | harnessDigest | 步数 | 429 次数 | 累计退避 | stepMs p50 | 最终候选成绩 | 终止 |",
        "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
        ...contaminated.map((report) => {
          const contamination = report.contamination!;
          const finalScore = report.scores[report.scores.length - 1];
          return `| ${escape(report.model)} | ${escape(report.runId)} | ${escape(report.modelVersion ?? "null")} | ${escape(report.shape.harnessDigest ?? "null")} | ${report.steps?.entries.length ?? "null"} | ${contamination.rateLimitedAttempts} | ${contamination.backoffMs ?? "null"} | ${report.steps?.stats.stepMs.p50 ?? "null"} | ${finalScore === undefined ? "不适用" : renderScore(finalScore.generation)} | ${report.shape.termination ?? "null"} |`;
        }),
      );
  }
  return `${out.join("\n")}\n`;
};

export const runArchiveReport = async (
  args: readonly string[],
  io: { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void } = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> => {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: {
        root: { type: "string" },
        model: { type: "string" },
        "run-id": { type: "string" },
        json: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    });
    const readIssues: ArchiveReportReadIssue[] = [];
    const reports = readArchiveReports(resolve(values.root ?? process.cwd()), {
      ...(values.model === undefined ? {} : { model: values.model }),
      ...(values["run-id"] === undefined ? {} : { runId: values["run-id"] }),
      onReadIssue: (issue) => readIssues.push(issue),
    });
    io.stdout(
      values.json === true
        ? `${JSON.stringify(reports, null, 2)}\n`
        : renderArchiveMarkdown(reports),
    );
    for (const issue of readIssues)
      io.stderr(`modelwar report: 读取记录失败 ${issue.source}: ${issue.reason}\n`);
    return readIssues.length === 0 ? 0 : 1;
  } catch {
    io.stderr("modelwar report: 参数、归档目录或记录无法读取\n");
    return 1;
  }
};
