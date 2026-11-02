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
 * ── 这一版不放分数 ──
 *
 * 分数（网格平均名次积分、分母恒 32）是另一票的事：它的定义在 runner 的 `trial-score.ts`，
 * 落档在存档那一票。这里只放身份与计划，**不预留空壳字段**（空缺字段会被误读成「算过但是空」）。
 *
 * ── 形状与版本 ──
 *
 * `version` 与 `TrialPlan.version` 同步（当前 2）。单份 JSON 的形状归本文件的 JSON Schema；
 * 「计划能否由输入重建」「逐场身份是否与计划一致」归 runner 与消费端的装载期断言
 * （本包不得依赖任何包，没有 `node:crypto`）。
 */

import { TRIAL_PLAN_JSON_SCHEMA, TRIAL_PLAN_VERSION, type TrialPlan } from "./trial-plan.js";

/** 汇总的形状版本；与计划版本同步升号。 */
export const TRIAL_GRID_SUMMARY_VERSION = TRIAL_PLAN_VERSION;

/** 汇总文件的文件名后缀：与观测文件同目录、同前缀（`<观测文件>.grid.json`）。 */
export const TRIAL_GRID_SUMMARY_SUFFIX = ".grid.json" as const;

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

/** 汇总的单份 JSON 形状（TypeScript 是形状真源，手工对齐，ADR-0003）。 */
export const TRIAL_GRID_SUMMARY_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "model-war 评测网格汇总",
  type: "object",
  additionalProperties: false,
  required: ["version", "plan", "scriptSha256", "matches"],
  properties: {
    version: { const: TRIAL_GRID_SUMMARY_VERSION },
    plan: TRIAL_PLAN_JSON_SCHEMA,
    scriptSha256: SHA256_JSON_SCHEMA,
    matches: {
      type: "array",
      minItems: TRIAL_PLAN_JSON_SCHEMA.properties.matchesPerCandidate.const,
      maxItems: TRIAL_PLAN_JSON_SCHEMA.properties.matchesPerCandidate.const,
      items: GRID_MATCH_JSON_SCHEMA,
    },
  },
} as const;
