/** 独立选拔的版本化数据契约；执行与跨字段验证归 runner。 */
import type { ReplayResultLine } from "./replay-line.js";
import { REPLAY_RESULT_LINE_JSON_SCHEMA } from "./replay-line.js";

export const SELECTION_VERSION = 1 as const;
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
export type ArchiveSelection = {
  readonly version: typeof SELECTION_VERSION;
  readonly plan: SelectionPlan;
  readonly candidates: readonly SelectionCandidate[];
  readonly selected: SelectionCandidateIdentity;
  readonly reason: (typeof SELECTION_REASONS)[number];
};

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
