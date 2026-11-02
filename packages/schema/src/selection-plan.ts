/**
 * 独立选拔的版本化数据契约；执行与跨字段验证归 runner。
 *
 * ── 两版并行：v1 是历史档的形状，v2 是现在的选拔 ──
 *
 * - **v1**（`SELECTION_VERSION`，`archive/` 里已冻结的档）：12 场单图、固定三个种子
 *   （401/402/403）、三份基准脚本、候选恒 0 号位。这一版**不迁移、不回填**，读入端按
 *   `version` 分派；它的构造、校验与读取路径（runner 的 `buildSelectionPlan` /
 *   `validateSelection`）原样保留。
 * - **v2**（`SELECTION_GRID_VERSION`）：计划就是生成阶段那张评测网格（`TrialPlan`，32 场），
 *   证据是让候选跑满那张网格得到的**逐场观测行**与它唯一的分数（网格平均名次积分）。
 *
 * ── v2 为什么不再有「选拔自己的计划常量」 ──
 *
 * 选拔不再是「条件不同的新实验」：排序直接用生成阶段算出的网格分数，选拔只负责定版与
 * 复算校验。于是「跑哪几场、谁坐哪、什么种子、哪张图、对哪四份陪练」全部来自生成阶段的
 * 同一份计划（`planSha256` 相等）——本文件不另立种子、场数或地图常量，免得同一件事有
 * 第二个家。
 *
 * ── v2 为什么只落逐场摘要，不落整场比赛的回放行 ──
 *
 * 复算的凭据是「这一场的观测行与生成阶段那一场逐字相同」。观测行本身很长（四方终局 + 行动
 * 事实），存三份进存档只是把生成阶段的观测文件抄一遍；所以落的是它的**内容摘要**
 * （`observationSha256`，规范序列化的 sha256）与单场身份（`inputSha256`，计划摘要 + 候选
 * 脚本摘要 + 该场）。比对归 runner（`selection.ts` 按 `version` 分派），摘要怎么算归 runner
 * 的 `canonical.ts`——本包不得依赖任何包（没有 `node:crypto`）。
 */
import type { ReplayResultLine } from "./replay-line.js";
import { REPLAY_RESULT_LINE_JSON_SCHEMA } from "./replay-line.js";
import { TRIAL_GRID_SCORE_JSON_SCHEMA, type TrialGridScore } from "./trial-grid-summary.js";
import {
  TRIAL_PLAN_JSON_SHAPE,
  TRIAL_MATCHES_PER_CANDIDATE,
  type TrialPlan,
} from "./trial-plan.js";

/** v1：历史档的形状版本（12 场 / 三基准 / 种子 401–403）。 */
export const SELECTION_VERSION = 1 as const;
/** v2：评测网格形态（计划 = 生成阶段那张 `TrialPlan`，证据 = 逐场观测行摘要 + 分数）。 */
export const SELECTION_GRID_VERSION = 2 as const;
export const SELECTION_SEEDS = [401, 402, 403] as const;
export const SELECTION_MATCHES_PER_CANDIDATE = 12 as const;
export const SELECTION_REASONS = [
  "highest-average-points",
  "later-stage",
  // 仅用于读取历史选拔档；新生产结果不得使用。
  "earlier-stage",
  "earlier-protocol-round",
  "script-hash",
] as const;
export type SelectionReason = (typeof SELECTION_REASONS)[number];
/** 新生产结果可用的理由：`earlier-stage` 只留给历史档读取（v2 的形状里就写不出来）。 */
export const SELECTION_NEW_REASONS = [
  "highest-average-points",
  "later-stage",
  "earlier-protocol-round",
  "script-hash",
] as const;

export type SelectionScript = { readonly id: string; readonly scriptSha256: string };
export type SelectionCandidateIdentity = {
  readonly stage: 0 | 1 | 2;
  readonly protocolRound: number;
  readonly scriptSha256: string;
  /** 对应阶段的原始 TS 字节，不因重复 JS 而合并身份。 */
  readonly sourceSha256: string;
};
export type SelectionMatch = {
  readonly matchIndex: number;
  readonly seed: number;
  readonly rotation: number;
  readonly candidateSeat: number;
  /** candidate 为占位身份；其余为三基准 id，整组循环左移。 */
  readonly seats: readonly [string, string, string, string];
};
export type SelectionPlan = {
  readonly version: typeof SELECTION_VERSION;
  readonly seeds: typeof SELECTION_SEEDS;
  readonly matchesPerCandidate: typeof SELECTION_MATCHES_PER_CANDIDATE;
  readonly ruleset: string;
  readonly rulesetSha256: string;
  readonly sandboxRuntimeHash: string;
  readonly map: string;
  readonly mapSha256: string;
  readonly baselines: readonly [SelectionScript, SelectionScript, SelectionScript];
  readonly matches: readonly SelectionMatch[];
  readonly planSha256: string;
};
export type SelectionMatchResult = {
  readonly matchIndex: number;
  /** 摘要覆盖计划、候选 JS、种子、座位和执行环境；不是正式 input.json。 */
  readonly inputSha256: string;
  readonly result: ReplayResultLine;
  readonly candidatePoints: number;
};
export type SelectionCandidate = SelectionCandidateIdentity & {
  readonly matches: readonly SelectionMatchResult[];
  readonly totalPoints: number;
  readonly averagePoints: number;
  readonly countedMatches: typeof SELECTION_MATCHES_PER_CANDIDATE;
  /** 可复用同 JS 的更早阶段结果；须逐场同输入、同完整结果。 */
  readonly reusedFromStage?: 0 | 1 | 2;
};
/** v1 的选拔记录（历史档形状；构造、校验与读取路径原样保留）。 */
export type ArchiveSelectionV1 = {
  readonly version: typeof SELECTION_VERSION;
  readonly plan: SelectionPlan;
  readonly candidates: readonly SelectionCandidate[];
  readonly selected: SelectionCandidateIdentity;
  readonly reason: SelectionReason;
};

/**
 * v2 的单场证据：这一格跑出来的那一行观测，与它给候选挣到的分数。
 *
 * `observationSha256` 是生成阶段那一条观测行（`TrialObservationLine`）按规范序列化后的
 * sha256；复算重跑同一张网格后逐场比它——总分相同但某一场不同，同样算不确定。
 */
export type SelectionGridMatch = {
  readonly matchIndex: number;
  /** 单场身份：计划摘要 + 候选脚本摘要 + 该场的座位/种子/地图（与试跑同一口径）。 */
  readonly inputSha256: string;
  /** 生成阶段这一场观测行的内容摘要（逐场逐字比对的凭据）。 */
  readonly observationSha256: string;
  /** 这一场候选拿到的名次积分（0..3）；逐场之和必须等于分数里的 `totalPoints`。 */
  readonly candidatePoints: number;
};

/**
 * v2 的候选：身份 + **生成阶段的**网格分数 + 逐场证据。
 *
 * 排序直接用 `score`（生成阶段算出的那一份），选拔的复算只校不对：复算结果与它逐位不同
 * 即整次生成失败。`sourceSha256` 仍按阶段保留——复算认编译产物，不因重复 JS 合并身份。
 */
export type SelectionGridCandidate = SelectionCandidateIdentity & {
  readonly score: TrialGridScore;
  readonly matches: readonly SelectionGridMatch[];
  /** 编译产物字节与更早阶段相同时，复算复用的是哪一阶段的证据（逐场必须与来源完全一致）。 */
  readonly reusedFromStage?: 0 | 1 | 2;
};

/** v2 的选拔记录：计划 = 生成阶段那张网格，候选 = 分数 + 逐场证据。 */
export type ArchiveGridSelection = {
  readonly version: typeof SELECTION_GRID_VERSION;
  readonly plan: TrialPlan;
  readonly candidates: readonly SelectionGridCandidate[];
  readonly selected: SelectionCandidateIdentity;
  readonly reason: Exclude<SelectionReason, "earlier-stage">;
};

/** 存档里的选拔段：两版并行，按 `version` 分派（历史档不迁移）。 */
export type ArchiveSelection = ArchiveSelectionV1 | ArchiveGridSelection;

const SHA256 = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;
const IDENTITY = {
  stage: { type: "integer", enum: [0, 1, 2] },
  protocolRound: { type: "integer", minimum: 1 },
  scriptSha256: SHA256,
  sourceSha256: SHA256,
} as const;
const IDENTITY_KEYS = ["stage", "protocolRound", "scriptSha256", "sourceSha256"] as const;
export const ARCHIVE_SELECTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "plan", "candidates", "selected", "reason"],
  properties: {
    version: { type: "integer", const: SELECTION_VERSION },
    plan: {
      type: "object",
      additionalProperties: false,
      required: [
        "version",
        "seeds",
        "matchesPerCandidate",
        "ruleset",
        "rulesetSha256",
        "sandboxRuntimeHash",
        "map",
        "mapSha256",
        "baselines",
        "matches",
        "planSha256",
      ],
      properties: {
        version: { type: "integer", const: SELECTION_VERSION },
        seeds: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: [
            { type: "integer", const: SELECTION_SEEDS[0] },
            { type: "integer", const: SELECTION_SEEDS[1] },
            { type: "integer", const: SELECTION_SEEDS[2] },
          ],
          additionalItems: false,
        },
        matchesPerCandidate: { type: "integer", const: SELECTION_MATCHES_PER_CANDIDATE },
        ruleset: { type: "string", minLength: 1 },
        rulesetSha256: SHA256,
        sandboxRuntimeHash: SHA256,
        map: { type: "string", minLength: 1 },
        mapSha256: SHA256,
        baselines: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "scriptSha256"],
            properties: { id: { type: "string", minLength: 1 }, scriptSha256: SHA256 },
          },
        },
        matches: {
          type: "array",
          minItems: 12,
          maxItems: 12,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["matchIndex", "seed", "rotation", "candidateSeat", "seats"],
            properties: {
              matchIndex: { type: "integer", minimum: 0, maximum: 11 },
              seed: { type: "integer", enum: SELECTION_SEEDS },
              rotation: { type: "integer", minimum: 0, maximum: 3 },
              candidateSeat: { type: "integer", minimum: 0, maximum: 3 },
              seats: {
                type: "array",
                minItems: 4,
                maxItems: 4,
                items: { type: "string", minLength: 1 },
              },
            },
          },
        },
        planSha256: SHA256,
      },
    },
    candidates: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: [...IDENTITY_KEYS, "matches", "totalPoints", "averagePoints", "countedMatches"],
        properties: {
          ...IDENTITY,
          matches: {
            type: "array",
            minItems: 12,
            maxItems: 12,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["matchIndex", "inputSha256", "result", "candidatePoints"],
              properties: {
                matchIndex: { type: "integer", minimum: 0, maximum: 11 },
                inputSha256: SHA256,
                result: REPLAY_RESULT_LINE_JSON_SCHEMA,
                candidatePoints: { type: "number", minimum: 0, maximum: 3 },
              },
            },
          },
          totalPoints: { type: "number", minimum: 0, maximum: 36 },
          averagePoints: { type: "number", minimum: 0, maximum: 3 },
          countedMatches: { type: "integer", const: SELECTION_MATCHES_PER_CANDIDATE },
          reusedFromStage: { type: "integer", enum: [0, 1, 2] },
        },
      },
    },
    selected: {
      type: "object",
      additionalProperties: false,
      required: IDENTITY_KEYS,
      properties: IDENTITY,
    },
    reason: { enum: SELECTION_REASONS },
  },
} as const;

const GRID_MATCH_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matchIndex", "inputSha256", "observationSha256", "candidatePoints"],
  properties: {
    matchIndex: { type: "integer", minimum: 0, maximum: TRIAL_MATCHES_PER_CANDIDATE - 1 },
    inputSha256: SHA256,
    observationSha256: SHA256,
    candidatePoints: { type: "number", minimum: 0, maximum: 3 },
  },
} as const;

const GRID_CANDIDATE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...IDENTITY_KEYS, "score", "matches"],
  properties: {
    ...IDENTITY,
    score: TRIAL_GRID_SCORE_JSON_SCHEMA,
    matches: {
      type: "array",
      minItems: TRIAL_MATCHES_PER_CANDIDATE,
      maxItems: TRIAL_MATCHES_PER_CANDIDATE,
      items: GRID_MATCH_JSON_SCHEMA,
    },
    reusedFromStage: { type: "integer", enum: [0, 1, 2] },
  },
} as const;

/**
 * v2 选拔记录的单份 JSON 形状（TypeScript 是形状真源，手工对齐，ADR-0003）。
 *
 * 计划直接嵌 `TRIAL_PLAN_JSON_SHAPE`（与存档 `optimization.plan` 同一处写法）：选拔用的计划
 * 与生成阶段的网格是同一份，形状不该有第二个家。「能否由事实重建」归 runner 的
 * `checkTrialPlan`，不在这里。
 */
export const ARCHIVE_GRID_SELECTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "plan", "candidates", "selected", "reason"],
  properties: {
    version: { type: "integer", const: SELECTION_GRID_VERSION },
    plan: TRIAL_PLAN_JSON_SHAPE,
    candidates: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: GRID_CANDIDATE_JSON_SCHEMA,
    },
    selected: {
      type: "object",
      additionalProperties: false,
      required: IDENTITY_KEYS,
      properties: IDENTITY,
    },
    // v2 的形状里没有 `earlier-stage`：新生产结果不得使用历史决胜规则。
    reason: { enum: SELECTION_NEW_REASONS },
  },
} as const;
