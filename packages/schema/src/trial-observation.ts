import type { ReplayOutcomeReason, ReplaySeat } from "./replay-line.js";

/** 试跑观测旁挂文件的命名前缀；最终候选与独立 round 文件共享。 */
export const OBSERVATIONS_FILE_PREFIX = "observed-";

/** 固定行动名；与公开注入面目录的 action 投影逐字对齐，由公共数据测试兜住漂移。 */
export const ACTION_API_NAMES = [
  "move",
  "moveTo",
  "attack",
  "harvest",
  "transfer",
  "spawnUnit",
] as const;

/** 公开即时错误码；guest 保留轻量投影，不在运行时导入整个 schema。 */
export const ACTION_ERROR_CODES = [
  "ERR_NOT_ENOUGH_RESOURCES",
  "ERR_INVALID_UNIT",
  "ERR_NOT_OWNER",
  "ERR_OUT_OF_RANGE",
  "ERR_INVALID_TARGET",
  "ERR_INVALID_SITE",
  "ERR_BAD_ARGS",
] as const;

type ActionApiName = (typeof ACTION_API_NAMES)[number];
type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number];

/** 真实动作函数入口次数；不包含查询或错误判别 helper。 */
export type ActionCallCounts = Readonly<Record<ActionApiName, number>>;

/** 每动作均带完整七个公开错误码的计数；undefined 不计为成功。 */
export type ActionErrorCounts = Readonly<
  Record<keyof ActionCallCounts, Readonly<Record<ActionErrorCode, number>>>
>;

/** 宿主聚合的只读零值模板；累加前复制，guest 仍使用自己的轻量投影。 */
export const ACTION_ZERO_CALLS = {
  move: 0,
  moveTo: 0,
  attack: 0,
  harvest: 0,
  transfer: 0,
  spawnUnit: 0,
} as const satisfies ActionCallCounts;

const ZERO_ERROR_COUNTS = {
  ERR_NOT_ENOUGH_RESOURCES: 0,
  ERR_INVALID_UNIT: 0,
  ERR_NOT_OWNER: 0,
  ERR_OUT_OF_RANGE: 0,
  ERR_INVALID_TARGET: 0,
  ERR_INVALID_SITE: 0,
  ERR_BAD_ARGS: 0,
} as const satisfies Readonly<Record<ActionErrorCode, number>>;

/** 各动作共享只读错误零值；宿主累加前须分别复制每个动作的错误表。 */
export const ACTION_ZERO_ERRORS = {
  move: ZERO_ERROR_COUNTS,
  moveTo: ZERO_ERROR_COUNTS,
  attack: ZERO_ERROR_COUNTS,
  harvest: ZERO_ERROR_COUNTS,
  transfer: ZERO_ERROR_COUNTS,
  spawnUnit: ZERO_ERROR_COUNTS,
} as const satisfies ActionErrorCounts;

/** 宿主实际施加的结算效果名，独立于调用与快照得分来源读数。 */
export const ACTION_EFFECT_NAMES = [
  "movedSteps",
  "harvestedAmount",
  "deliveredAmount",
  "captureEvents",
  "productionOrdersStarted",
] as const;

type ActionEffectName = (typeof ACTION_EFFECT_NAMES)[number];
export type ActionEffects = Readonly<Record<ActionEffectName, number>>;

/** 一场候选座位的行动事实；所有计数都是非负安全整数。 */
export type TrialActionFacts = {
  readonly version: 1;
  readonly scriptSha256: string;
  readonly seed: number;
  readonly seat: 0;
  /** 当且仅当 missingTicks 为零；缺失 tick 不补零。 */
  readonly complete: boolean;
  readonly observedTicks: number;
  readonly missingTicks: number;
  readonly calls: ActionCallCounts;
  /** 各动作的错误总数不得超过其 calls，严格读入端校验这个跨字段约束。 */
  readonly errors: ActionErrorCounts;
  readonly effects: ActionEffects;
};

/** 终局场上未销毁单位的数量/造价表；造价取当局 ruleset，不包含在建订单。 */
export type TrialUnitTable = {
  readonly worker: number;
  readonly melee: number;
  readonly ranged: number;
  readonly cavalry: number;
};

/** 四方按 seat 顺序记录；候选身份恒为 candidate，基准为实际脚本目录名。 */
export type TrialTerminalPlayer = {
  readonly seat: ReplaySeat;
  readonly player: string;
  readonly controlledBases: number;
  readonly controlledResources: number;
  /** finalState 中仍在场的单位；异常淘汰方也可能保留单位，不按 alive 补零。 */
  readonly survivingUnits: TrialUnitTable;
  readonly survivingUnitCost: number;
  readonly score: { readonly bases: number; readonly resources: number; readonly units: number };
  readonly territoryScore: number;
  readonly rank: number;
  readonly rankPoints: number;
  readonly alive: boolean;
  readonly eliminatedAtTick: number | null;
};

/** completed 的纯数据投影。跨字段复算与身份校验归 consumer；缺失表示未知，不能补零。 */
export type TrialTerminalSummary = {
  readonly version: 1;
  readonly seed: number;
  /** finalState.tick === tickCount：已执行 tick 数／下一 tick 编号；最后已结算 tick 为 tick - 1。 */
  readonly tick: number;
  readonly reason: ReplayOutcomeReason;
  readonly weights: {
    readonly baseScore: number;
    readonly resourceScore: number;
    readonly unitCostDivisor: number;
  };
  readonly unitCosts: TrialUnitTable;
  /** runner 的实际名次积分表，消费者无需另立配置。 */
  readonly rankPoints: readonly [number, number, number, number];
  readonly players: readonly [
    TrialTerminalPlayer,
    TrialTerminalPlayer,
    TrialTerminalPlayer,
    TrialTerminalPlayer,
  ];
};

/** 冻结期试跑逐对局观测；只记录事实，不参与预算 verdict。 */
export type TrialObservationLine = {
  /** 实际完成的对局下标（0 起）。 */
  readonly matchIndex: number;
  readonly delivered: number;
  readonly captures: number;
  readonly noScoreSource: boolean;
  readonly actionFacts?: TrialActionFacts;
  readonly terminalSummary?: TrialTerminalSummary;
};

const COUNT_JSON_SCHEMA = {
  type: "integer",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;
const POSITIVE_COUNT_JSON_SCHEMA = { ...COUNT_JSON_SCHEMA, minimum: 1 } as const;
const UNIT_TABLE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["worker", "melee", "ranged", "cavalry"],
  properties: {
    worker: COUNT_JSON_SCHEMA,
    melee: COUNT_JSON_SCHEMA,
    ranged: COUNT_JSON_SCHEMA,
    cavalry: COUNT_JSON_SCHEMA,
  },
} as const;
const TERMINAL_PLAYER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "seat",
    "player",
    "controlledBases",
    "controlledResources",
    "survivingUnits",
    "survivingUnitCost",
    "score",
    "territoryScore",
    "rank",
    "rankPoints",
    "alive",
    "eliminatedAtTick",
  ],
  properties: {
    seat: { type: "integer", minimum: 0, maximum: 3 },
    player: { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-z0-9][a-z0-9-]*$" },
    controlledBases: COUNT_JSON_SCHEMA,
    controlledResources: COUNT_JSON_SCHEMA,
    survivingUnits: UNIT_TABLE_JSON_SCHEMA,
    survivingUnitCost: COUNT_JSON_SCHEMA,
    score: {
      type: "object",
      additionalProperties: false,
      required: ["bases", "resources", "units"],
      properties: {
        bases: COUNT_JSON_SCHEMA,
        resources: COUNT_JSON_SCHEMA,
        units: COUNT_JSON_SCHEMA,
      },
    },
    territoryScore: COUNT_JSON_SCHEMA,
    rank: { type: "integer", minimum: 1, maximum: 4 },
    rankPoints: { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    alive: { type: "boolean" },
    eliminatedAtTick: { anyOf: [COUNT_JSON_SCHEMA, { type: "null" }] },
  },
} as const;

/** 纯形状与数值域；seat 唯一、积分/计分复算等语义约束留给消费边界。 */
export const TRIAL_TERMINAL_SUMMARY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "seed", "tick", "reason", "weights", "unitCosts", "rankPoints", "players"],
  properties: {
    version: { const: 1 },
    seed: COUNT_JSON_SCHEMA,
    tick: COUNT_JSON_SCHEMA,
    reason: { enum: ["victory", "shortcut", "timeout", "all-eliminated"] },
    weights: {
      type: "object",
      additionalProperties: false,
      required: ["baseScore", "resourceScore", "unitCostDivisor"],
      properties: {
        baseScore: COUNT_JSON_SCHEMA,
        resourceScore: COUNT_JSON_SCHEMA,
        unitCostDivisor: POSITIVE_COUNT_JSON_SCHEMA,
      },
    },
    unitCosts: UNIT_TABLE_JSON_SCHEMA,
    rankPoints: { type: "array", minItems: 4, maxItems: 4, items: COUNT_JSON_SCHEMA },
    players: { type: "array", minItems: 4, maxItems: 4, items: TERMINAL_PLAYER_JSON_SCHEMA },
  },
} as const;

const ERROR_COUNTS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ACTION_ERROR_CODES,
  properties: {
    ERR_NOT_ENOUGH_RESOURCES: COUNT_JSON_SCHEMA,
    ERR_INVALID_UNIT: COUNT_JSON_SCHEMA,
    ERR_NOT_OWNER: COUNT_JSON_SCHEMA,
    ERR_OUT_OF_RANGE: COUNT_JSON_SCHEMA,
    ERR_INVALID_TARGET: COUNT_JSON_SCHEMA,
    ERR_INVALID_SITE: COUNT_JSON_SCHEMA,
    ERR_BAD_ARGS: COUNT_JSON_SCHEMA,
  },
} as const;

/** TypeScript 是真源，JSON Schema 手工对齐（ADR-0003）。 */
export const TRIAL_OBSERVATION_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "model-war 试跑逐对局观测",
  type: "object",
  additionalProperties: false,
  required: ["matchIndex", "delivered", "captures", "noScoreSource"],
  properties: {
    matchIndex: { type: "integer", minimum: 0 },
    delivered: { type: "integer", minimum: 0 },
    captures: { type: "integer", minimum: 0 },
    noScoreSource: { type: "boolean" },
    terminalSummary: TRIAL_TERMINAL_SUMMARY_JSON_SCHEMA,
    actionFacts: {
      type: "object",
      additionalProperties: false,
      required: [
        "version",
        "scriptSha256",
        "seed",
        "seat",
        "complete",
        "observedTicks",
        "missingTicks",
        "calls",
        "errors",
        "effects",
      ],
      properties: {
        version: { const: 1 },
        scriptSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        seed: COUNT_JSON_SCHEMA,
        seat: { const: 0 },
        complete: { type: "boolean" },
        observedTicks: COUNT_JSON_SCHEMA,
        missingTicks: COUNT_JSON_SCHEMA,
        calls: {
          type: "object",
          additionalProperties: false,
          required: ACTION_API_NAMES,
          properties: {
            move: COUNT_JSON_SCHEMA,
            moveTo: COUNT_JSON_SCHEMA,
            attack: COUNT_JSON_SCHEMA,
            harvest: COUNT_JSON_SCHEMA,
            transfer: COUNT_JSON_SCHEMA,
            spawnUnit: COUNT_JSON_SCHEMA,
          },
        },
        errors: {
          type: "object",
          additionalProperties: false,
          required: ACTION_API_NAMES,
          properties: {
            move: ERROR_COUNTS_JSON_SCHEMA,
            moveTo: ERROR_COUNTS_JSON_SCHEMA,
            attack: ERROR_COUNTS_JSON_SCHEMA,
            harvest: ERROR_COUNTS_JSON_SCHEMA,
            transfer: ERROR_COUNTS_JSON_SCHEMA,
            spawnUnit: ERROR_COUNTS_JSON_SCHEMA,
          },
        },
        effects: {
          type: "object",
          additionalProperties: false,
          required: ACTION_EFFECT_NAMES,
          properties: {
            movedSteps: COUNT_JSON_SCHEMA,
            harvestedAmount: COUNT_JSON_SCHEMA,
            deliveredAmount: COUNT_JSON_SCHEMA,
            captureEvents: COUNT_JSON_SCHEMA,
            productionOrdersStarted: COUNT_JSON_SCHEMA,
          },
        },
      },
      if: { properties: { missingTicks: { const: 0 } } },
      // JSON Schema 的条件分支是数据键，不是 Promise 的 thenable 方法。
      // oxlint-disable-next-line unicorn/no-thenable
      then: { properties: { complete: { const: true } } },
      else: { properties: { complete: { const: false } } },
    },
  },
} as const;
