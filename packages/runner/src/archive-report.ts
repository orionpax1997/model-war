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
  ARCHIVE_OPTIMIZATION_CANDIDATE_JSON_SCHEMA,
  ARCHIVE_SELECTION_JSON_SCHEMA,
  OPTIMIZATION_GRID_VERSION,
  OPTIMIZATION_STAGES,
  SELECTION_GRID_VERSION,
  SELECTION_VERSION,
  TRIAL_PLAN_JSON_SHAPE,
  type ArchiveOptimization,
  type ArchiveSelection,
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

import { optimizationMetaOf } from "./archive-optimization.js";
import { buildSelectionPlan } from "./selection.js";
import { checkTrialPlan } from "./trial-plan.js";
import {
  objectOf,
  numberOf,
  paramsOf,
  requestEvidenceOf,
  stopEvidenceOf,
  failureClassificationOf,
  usageEnumOf,
  observationEvidenceOf,
  type ObservationMatch,
  type ReportRequestEvidence,
} from "./archive-report-evidence.js";

/**
 * 选拔候选的分数投影：v1 把总分 / 均分 / 分母摊在候选自己身上，v2 把它们收进 `score`
 * （生成阶段那张网格的分数）。**两版的分数口径不同**（v1 = 选拔自有的 12 场单图；
 * v2 = 生成阶段 32 场网格的复算读数），所以它只是一处「选拔读数」，不进三类分数分列，
 * 分列见 `ReportCandidateScores`。
 */
const selectionCandidateScoreOf = (
  candidate: SelectionCandidate | SelectionGridCandidate,
): TrialGridScore =>
  "score" in candidate
    ? candidate.score
    : {
        totalPoints: candidate.totalPoints,
        averagePoints: candidate.averagePoints,
        countedMatches: candidate.countedMatches,
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
  const grid = optimization.version === OPTIMIZATION_GRID_VERSION;
  return optimization.candidates.map((candidate, index) => {
    const generation = grid ? gridScoreOf(candidate.score) : NOT_APPLICABLE_SCORE;
    const selectionReading =
      selection === undefined
        ? NOT_APPLICABLE_SCORE
        : selection.version === SELECTION_GRID_VERSION
          ? gridScoreOf(selection.candidates[index]?.score)
          : legacyScoreReadingOf(selection.candidates[index]);
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

export type UsageReading = {
  readonly value: number | null;
  readonly source: string | null;
  readonly state: "recorded" | "missing" | "null" | "invalid" | "unknown";
  readonly semantic: "total-input" | "unknown" | null;
  readonly conflict: boolean;
  readonly candidates: readonly { readonly source: string; readonly value: number | null }[];
};
export type ReportUsage = Readonly<
  Record<"input" | "output" | "cacheRead" | "cacheWrite" | "reasoning", UsageReading>
>;

export type ArchiveReportRound = {
  readonly round: number;
  readonly sendMs: number | null;
  readonly responseConverged: boolean;
  readonly params: ReturnType<typeof paramsOf>;
  readonly requestEvidence: ReportRequestEvidence;
  readonly stop: ReturnType<typeof stopEvidenceOf>;
  readonly attempts: readonly ReportAttempt[];
  readonly attemptCoverage: "recorded" | "missing" | "partial";
  readonly usageState: "missing" | "null" | "recorded" | "invalid";
  readonly usage: ReportUsage;
};

export type ReportAttempt = {
  readonly attempt: number;
  readonly outcome: "response" | "transport-error";
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

export type ReportCandidate = ArchiveOptimizationCandidate & {
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
     * 选拔记录版本：1 = 历史档（12 场 / 三基准 / 单图），2 = 评测网格（32 场 / 四陪练 / 两图）。
     * 计划口径按 `plan.kind` 分流，且**不互相冒充**（见 `ReportGridPlan` / `ReportLegacySelectionPlan`）。
     */
    readonly version: 1 | 2;
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
    /** 每个候选的选拔读数（身份 + 分数）；三类分数的分列视图是 `scores`，两处同源。 */
    readonly candidates: readonly (SelectionCandidateIdentity & {
      readonly averagePoints: number;
      readonly totalPoints: number;
      readonly countedMatches: number;
      readonly reusedFromStage: number | null;
    })[];
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
  readonly runId: string;
  readonly source: string;
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
    source.startsWith("usage.output_tokens_details.");
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
    reasoning: pickUsageField(raw, USAGE_READING_PATHS.reasoning),
  };
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
  | { readonly kind: "grid"; readonly plan: TrialPlan };

/** 按下标取这一场的期待身份；`undefined` = 这个下标不属这一档的计划。 */
const expectedMatchOf = (
  caliber: ObservationCaliber,
  matchIndex: number,
): ObservationMatch | undefined => {
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
      const expected = expectedMatchOf(options.caliber, matchIndex);
      if (expected === undefined) throw new Error("观测对局下标不属于试跑计划");
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
 * 失败记录自带的已有候选描述（统一优化中途失败时 pipeline 写入；旧记录缺席）。
 * 防御式读栏：任一项不合形状即整体视为缺席，走旧逐轮列表，不抛（失败记录本身必须可读）。
 * basename 与 hash 模式同 `archive-meta.ts` 的候选约束，形状真源仍在 schema。
 */
const failureCandidateSchema = z.fromJSONSchema(
  JSON.parse(
    JSON.stringify(ARCHIVE_OPTIMIZATION_CANDIDATE_JSON_SCHEMA),
  ) as z.core.JSONSchema.JSONSchema,
);

const failureCandidatesOf = (record: unknown): ArchiveOptimizationCandidate[] => {
  if (typeof record !== "object" || record === null) return [];
  const raw = (record as { candidates?: unknown }).candidates;
  if (!Array.isArray(raw) || raw.length > (objectOf(record).classification === "selection" ? 3 : 2))
    return [];
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
    ...(descriptor.params === undefined ? {} : { params: descriptor.params }),
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
      return [
        {
          round,
          sendMs: numberOf(log.sendMs),
          responseConverged: !transport,
          params: paramsOf(log.params),
          requestEvidence: requestEvidenceOf(log.requestEvidence, slug),
          stop: stopEvidenceOf(transport ? undefined : log),
          ...attemptsOf(log.attemptEvidence),
          usageState,
          usage: normalizeUsage(transport ? undefined : log.usage),
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
  const failureDescriptors = kind === "failure" ? failureCandidatesOf(record) : [];
  const failedSelection =
    kind === "failure" ? selectionFailureOf(record, failureDescriptors, protocolRounds) : null;
  /**
   * 观测行的期待口径：v2 网格档逐场由计划给（种子 / 候选座位 / 四座身份），v1 历史档查旧表。
   * 失败档没有 `optimization`，但 v2 的选拔失败旁证里带的是同一张计划。
   */
  const caliber: ObservationCaliber =
    optimizationMeta?.optimization?.version === OPTIMIZATION_GRID_VERSION
      ? { kind: "grid", plan: optimizationMeta.optimization.plan }
      : failedSelection !== null && !("seeds" in failedSelection.plan)
        ? { kind: "grid", plan: failedSelection.plan }
        : { kind: "legacy" };
  const optimizationCandidates =
    optimizationMeta?.optimization?.candidates.map((descriptor) =>
      candidateReportOf(
        root,
        `archive/${slug}`,
        descriptor,
        optimizationMeta.scriptSha256,
        runId,
        caliber,
        optimizationMeta.selection?.selected.stage ?? 2,
        optimizationMeta.selection?.candidates[descriptor.stage]?.sourceSha256,
      ),
    ) ?? [];
  if (
    kind === "success" &&
    optimizationMeta?.selection !== undefined &&
    optimizationCandidates.some((candidate) => candidate.scriptState !== "verified")
  )
    throw new Error("选拔档冻结或候选 TS/JS 身份无法核实");
  // 失败档可有三个有效阶段，但没有冻结脚本；不读取不存在的冻结目录。
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
  const optimizedFinal = optimizationCandidates[2];
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
    optimizedFinal === undefined
      ? kind === "success" &&
        observations.state === "recorded" &&
        lastCandidate?.state === "recorded" &&
        sameObservationFile(root, observations.source, lastCandidate.source)
      : optimizedFinal.scriptState === "verified" && observations.state === "recorded";
  const convergedRounds = rounds.filter((round) => round.responseConverged);
  const allAttempts = rounds.flatMap((round) => round.attempts);
  const selection = optimizationMeta?.selection;
  const optimization = optimizationMeta?.optimization;
  // v1 历史档没有计划字段：不适用（`null`），不迁移、不回填。
  const plan =
    optimization?.version === OPTIMIZATION_GRID_VERSION
      ? gridPlanReportOf(optimization.plan, `${source}#optimization.plan`)
      : null;
  const scores = candidateScoresOf(optimization, selection);
  const stages = describedCandidates.length;
  const expectedAttempts =
    protocolRounds + (kind === "failure" && record.classification === "transport" ? 1 : 0);
  return {
    kind,
    model: slug,
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
        maximumConvergedResponses:
          optimizationMeta?.optimization !== undefined || stages > 0
            ? OPTIMIZATION_STAGES.length * 5
            : null,
        maximumResponsesPerStage:
          optimizationMeta?.optimization !== undefined || stages > 0 ? 5 : null,
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
        selectionMaximumMatches:
          selection === undefined && failedSelection === null
            ? null
            : OPTIMIZATION_STAGES.length * (selection ?? failedSelection)!.plan.matchesPerCandidate,
        selectionExecutedMatches:
          selection === undefined
            ? null
            : selection.candidates.filter((candidate) => candidate.reusedFromStage === undefined)
                .length * selection.plan.matchesPerCandidate,
        selectionReusedMatches:
          selection === undefined
            ? null
            : selection.candidates.filter((candidate) => candidate.reusedFromStage !== undefined)
                .length * selection.plan.matchesPerCandidate,
      },
    },
    initialCandidate: optimizationCandidates[0] ?? failureDescribed[0] ?? null,
    intermediateCandidates:
      optimizationMeta !== undefined
        ? optimizationCandidates.slice(1, -1)
        : failureDescribed.filter((candidate) => candidate.stage === 1),
    finalCandidate: optimizationCandidates[2] ?? failureDescribed[2] ?? null,
    frozenCandidate:
      optimizationCandidates[optimizationMeta?.selection?.selected.stage ?? 2] ?? null,
    selection:
      optimizationMeta?.selection === undefined
        ? null
        : {
            version: optimizationMeta.selection.version,
            stage: optimizationMeta.selection.selected.stage,
            protocolRound: optimizationMeta.selection.selected.protocolRound,
            scriptSha256: optimizationMeta.selection.selected.scriptSha256,
            sourceSha256: optimizationMeta.selection.selected.sourceSha256,
            averagePoints: selectionCandidateScoreOf(
              optimizationMeta.selection.candidates[optimizationMeta.selection.selected.stage]!,
            ).averagePoints,
            countedMatches: optimizationMeta.selection.plan.matchesPerCandidate,
            reason: optimizationMeta.selection.reason,
            planSha256: optimizationMeta.selection.plan.planSha256,
            distinctScripts: new Set(
              optimizationMeta.selection.candidates.map((candidate) => candidate.scriptSha256),
            ).size,
            reusedFromStage:
              optimizationMeta.selection.candidates[optimizationMeta.selection.selected.stage]!
                .reusedFromStage ?? null,
            candidates: optimizationMeta.selection.candidates.map((candidate) => {
              const score = selectionCandidateScoreOf(candidate);
              return {
                stage: candidate.stage,
                protocolRound: candidate.protocolRound,
                scriptSha256: candidate.scriptSha256,
                sourceSha256: candidate.sourceSha256,
                averagePoints: score.averagePoints,
                totalPoints: score.totalPoints,
                countedMatches: score.countedMatches,
                reusedFromStage: candidate.reusedFromStage ?? null,
              };
            }),
            executedMatches:
              optimizationMeta.selection.candidates.filter(
                (candidate) => candidate.reusedFromStage === undefined,
              ).length * optimizationMeta.selection.plan.matchesPerCandidate,
            reusedMatches:
              optimizationMeta.selection.candidates.filter(
                (candidate) => candidate.reusedFromStage !== undefined,
              ).length * optimizationMeta.selection.plan.matchesPerCandidate,
            rulesetSha256: optimizationMeta.selection.plan.rulesetSha256,
            sandboxRuntimeHash: optimizationMeta.selection.plan.sandboxRuntimeHash,
            // 选拔计划本身（不搬 32 场明文）：v2 = 生成阶段那张网格，v1 = 12 场单图。
            plan:
              optimizationMeta.selection.version === SELECTION_GRID_VERSION
                ? gridPlanReportOf(optimizationMeta.selection.plan, `${source}#selection.plan`)
                : legacySelectionPlanReportOf(
                    optimizationMeta.selection.plan,
                    `${source}#selection.plan`,
                  ),
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
      reasoning: total(
        convergedRounds.map((round) => round.usage.reasoning.value),
        protocolRounds,
      ),
    },
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
  const fields = ["sendMs", "input", "output", "cacheRead", "cacheWrite", "reasoning"] as const;
  const labels = {
    sendMs: "sendMs",
    input: "输入 token",
    output: "输出 token",
    cacheRead: "缓存读",
    cacheWrite: "缓存写",
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
    "> usage 的 cache / reasoning 是组成明细，不重复加总。缺失用 null；部分数据只给已记录小计。收敛响应与全部 HTTP 尝试是重叠证据，不相加作账单；传输错误消费未知。",
    "> 三类分数互不替代：生成阶段（网格平均名次积分，分母 = 每候选场数）／选拔复算（独立子进程重跑同一张网格，只作校验读数，不是第二个排名依据）／赛季（赛季报告口径，本报告不冒充）。不属本档口径的分数写「不适用」，不补零、不留空。",
    "> 配置和渠道能力是请求意图与支持声明；HTTP 接受不证明参数执行，服务端模型回报不认证后端身份。证据来源自由文本、prompt、原响应与诊断不公开。",
    "> --run-id 显式指定本轮标识：其它记录为历史；未指定时全部未分轮，不将历史失败当作本轮失败或参赛资格。",
    "> 最终观测独立读取 observed-<runId>.jsonl；旧档标记最后完成试跑，可能在 infra 后留旧读数。回喂前后的候选按协议 round 单列，不合并命中数。成功档最后 round 与最终文件精确匹配且新事实 hash 符合 meta 编译 JS hash 时标记最终候选。",
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
    );
    if (report.failure !== null)
      out.push(
        `- 失败分类：${escape(report.failure.classification)}`,
        `- 诊断条数：${report.failure.diagnosticsCount}（原文不公开）`,
      );
    out.push(
      "",
      "| 轮次 | sendMs | 输入 token | 输出 token | 缓存读 | 缓存写 | 推理 |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const round of report.rounds)
      out.push(
        `| ${round.responseConverged ? round.round : `${round.round}（未收敛 transport）`} | ${round.sendMs ?? "null"} | ${round.usage.input.value ?? "null"} | ${round.usage.output.value ?? "null"} | ${round.usage.cacheRead.value ?? "null"} | ${round.usage.cacheWrite.value ?? "null"} | ${round.usage.reasoning.value ?? "null"} |`,
      );
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
          `- 请求头契约：authentication=${request.transport.authentication ?? "null"}；版本头有记录=${request.transport.versionHeaderRecorded}`,
        );
      out.push(`- 停止：${escape(JSON.stringify(round.stop))}；尝试证据=${round.attemptCoverage}`);
      for (const attempt of round.attempts) {
        out.push(
          `- 第 ${round.round} 轮 attempt ${attempt.attempt}：${attempt.outcome}；停止 ${escape(JSON.stringify(attempt.stop))}；token ${fields
            .filter((field) => field !== "sendMs")
            .map((field) => `${labels[field]}=${attempt.usage[field].value ?? "null"}`)
            .join("；")}`,
        );
      }
    }
    out.push("", "### 计划、陪练与三类分数", "");
    if (report.plan === null)
      out.push("- 生成阶段计划：不适用（版本 1 历史档没有计划字段，不迁移、不回填）");
    else out.push(...renderGridPlan(report.plan));
    out.push(
      "- 同字节直读：看下表「复用来源」列——标出阶段号的是编译产物与那一阶段字节相同、复用它的网格结果",
      "- 不适用 = 该口径不属本档（v1 历史档没有网格分数；无选拔段时没有复算读数；赛季分数恒不适用）",
    );
    if (report.scores.length === 0)
      out.push("- 候选分数：不适用（本档没有优化旁证，无三阶段候选可出分数）");
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
        `- 实际冻结 stage=${report.frozenCandidate?.stage ?? "null"}；冻结字节校验=${report.frozenCandidate?.scriptState ?? "null"}；最后生成阶段仍是 stage2`,
      );
    }
    if (report.failure?.classification === "selection")
      out.push("- 选拔失败：无胜者、无冻结脚本；未完成对局数与用量保持未知，不按部分结果计分。");
    if (report.selectionFailure !== null)
      out.push(
        `- 失败选拔计划=${report.selectionFailure.planSha256}；每候选固定分母=${report.selectionFailure.matchesPerCandidate}；候选 TS/JS 身份=${escape(JSON.stringify(report.selectionFailure.candidates))}`,
      );
    out.push("", "### 合计（仅收敛响应）", "");
    for (const field of fields) {
      const summary = report.totals[field];
      out.push(
        `- ${labels[field]}：${summary.value ?? "null"}（已记录小计 ${summary.recordedTotal ?? "null"}；覆盖 ${summary.recordedRounds}/${summary.expectedRounds}）`,
      );
    }
    out.push("", "### 逐轮字段来源", "");
    for (const round of report.rounds) {
      out.push(`- 第 ${round.round} 轮 sendMs：${round.sendMs ?? "null"}（generationLog.sendMs）`);
      for (const [name, usage] of Object.entries(round.usage)) {
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
    for (const [label, candidate] of [
      ["初次候选", report.initialCandidate],
      ...report.intermediateCandidates.map((candidate) => ["中间候选", candidate] as const),
      ["最终候选", report.finalCandidate],
    ] as const) {
      if (candidate === null) continue;
      out.push(
        "",
        `### ${label}（协议轮 ${candidate.protocolRound}）`,
        "",
        `- JS 来源：${escape(candidate.scriptSource)}；状态：${candidate.scriptState}`,
        `- scriptSha256=${candidate.scriptSha256}；实际 hash=${candidate.actualScriptSha256 ?? "null"}`,
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
