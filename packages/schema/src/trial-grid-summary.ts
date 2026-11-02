/**
 * 评测网格的**每候选汇总**：执行器跑完整张网格后写在观测文件旁挂位置的那一份身份证据。
 *
 * ── 为什么它是旁挂文件，不扩观测行 ──
 *
 * 观测行（`trial-observation.ts`）一行一场，是事实回喂的原料；「这张网格是什么」是整批的
 * 身份，不该在 32 行里各抄一遍。所以执行器另写 `<观测文件>.grid.json`：里面放**整份计划**
 * （含 `planSha256`）与逐场身份，读入端拿它与 expected plan 逐字比——「跟谁打、坐哪、
 * 哪张图、什么种子」由此可从一次生成事后复现。
 *
 * ── 分数就在这一份里，但算术不在这儿 ──
 *
 * `score` 是候选在这张网格上的**平均名次积分**：`totalPoints`（Σ 每场名次积分）、
 * `averagePoints`（`totalPoints / countedMatches`）与 `countedMatches`（分母**恒等于计划声明的场数**，
 * 当前 32）。算术与「并列均分 / timeout / all-eliminated」的语义只有一处真源——runner 的
 * `trial-score.ts`（其内部再复用 `ranker.ts` 的 `perMatchScores` / `rankSeason`）。本文件只定形状。
 *
 * 分母是计划的字段而不是自由数：`countedMatches` 恒 `TRIAL_MATCHES_PER_CANDIDATE`，
 * 于是「少跑几场凑个好看的均分」在形状层就写不出来。
 *
 * ── 形状与版本 ──
 *
 * `version` 与 `TrialPlan.version` 同步（当前 2）。单份 JSON 的形状归本文件的 JSON Schema；
 * 「计划能否由输入重建」「逐场身份是否与计划一致」归 runner 与消费端的装载期断言
 * （本包不得依赖任何包，没有 `node:crypto`）。
 */

import {
  TRIAL_MATCHES_PER_CANDIDATE,
  TRIAL_PLAN_JSON_SCHEMA,
  TRIAL_PLAN_VERSION,
  type TrialPlan,
} from "./trial-plan.js";

/** 汇总的形状版本；与计划版本同步升号。 */
export const TRIAL_GRID_SUMMARY_VERSION = TRIAL_PLAN_VERSION;

/** 汇总文件的文件名后缀：与观测文件同目录、同前缀（`<观测文件>.grid.json`）。 */
export const TRIAL_GRID_SUMMARY_SUFFIX = ".grid.json" as const;

/**
 * 名次积分表的顶（第一名 3 分）：网格总分与均分的上界由此推出。
 *
 * 与 runner `ranker.ts` 的 `DEFAULT_RANK_POINTS = [3,2,1,0]` 同值——本包不得依赖任何包，
 * 所以是同一事实的第二处写法。改积分表要同时改这里（否则汇总会被自己的形状契约拒）。
 */
export const TRIAL_GRID_TOP_RANK_POINTS = 3 as const;

/** 一张网格给候选的唯一分数：总分、均分与分母（分母恒等于计划声明的场数）。 */
export type TrialGridScore = {
  /** Σ 每场名次积分；每场最高 3 分，所以上界是 `matchesPerCandidate × 3`。 */
  readonly totalPoints: number;
  /** `totalPoints / countedMatches`；每场最高 3 分，所以上界仍是 3。 */
  readonly averagePoints: number;
  /** 均分的分母：计划声明的场数（当前 32），不因缺场/触限而缩小。 */
  readonly countedMatches: number;
};

/** 逐场的身份投影：场序、种子、候选座位、地图名与地图摘要（不重复座位表与对手身份）。 */
export type TrialGridMatch = {
  readonly matchIndex: number;
  readonly seed: number;
  readonly candidateSeat: 0 | 1 | 2 | 3;
  readonly map: string;
  readonly mapSha256: string;
};

/** 一份候选跑完一张网格后的汇总。`plan` 原样落盘，读入端拿它复算身份。 */
export type TrialGridSummary = {
  readonly version: number;
  readonly plan: TrialPlan;
  /** 候选编译产物（`script.js`）的 sha256：这 32 场说的是哪一份脚本。 */
  readonly scriptSha256: string;
  /** 网格分数（算术在 runner 的 `trial-score.ts`；这里只落结果）。 */
  readonly score: TrialGridScore;
  readonly matches: readonly TrialGridMatch[];
};

const SHA256_JSON_SCHEMA = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;

const GRID_MATCH_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matchIndex", "seed", "candidateSeat", "map", "mapSha256"],
  properties: {
    matchIndex: {
      type: "integer",
      minimum: 0,
      maximum: TRIAL_PLAN_JSON_SCHEMA.properties.matchesPerCandidate.const - 1,
    },
    seed: { type: "integer", minimum: 0 },
    candidateSeat: { type: "integer", minimum: 0, maximum: 3 },
    map: { type: "string", minLength: 1 },
    mapSha256: SHA256_JSON_SCHEMA,
  },
} as const;

const SCORE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["totalPoints", "averagePoints", "countedMatches"],
  properties: {
    // 32 × 3 = 96：每场最高 3 分，场数由计划声明。
    totalPoints: {
      type: "number",
      minimum: 0,
      maximum: TRIAL_GRID_TOP_RANK_POINTS * TRIAL_MATCHES_PER_CANDIDATE,
    },
    averagePoints: { type: "number", minimum: 0, maximum: TRIAL_GRID_TOP_RANK_POINTS },
    countedMatches: { const: TRIAL_MATCHES_PER_CANDIDATE },
  },
} as const;

/** 汇总的单份 JSON 形状（TypeScript 是形状真源，手工对齐，ADR-0003）。 */
export const TRIAL_GRID_SUMMARY_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "model-war 评测网格汇总",
  type: "object",
  additionalProperties: false,
  required: ["version", "plan", "scriptSha256", "score", "matches"],
  properties: {
    version: { const: TRIAL_GRID_SUMMARY_VERSION },
    plan: TRIAL_PLAN_JSON_SCHEMA,
    scriptSha256: SHA256_JSON_SCHEMA,
    score: SCORE_JSON_SCHEMA,
    matches: {
      type: "array",
      minItems: TRIAL_PLAN_JSON_SCHEMA.properties.matchesPerCandidate.const,
      maxItems: TRIAL_PLAN_JSON_SCHEMA.properties.matchesPerCandidate.const,
      items: GRID_MATCH_JSON_SCHEMA,
    },
  },
} as const;
