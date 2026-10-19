import { z } from "zod";
import {
  ACTION_API_NAMES,
  ACTION_EFFECT_NAMES,
  ACTION_ERROR_CODES,
  USAGE_ENUM_FIELDS,
  TRIAL_PLAYER_IDS,
  TRIAL_SEEDS,
  TRIAL_TERMINAL_SUMMARY_JSON_SCHEMA,
  type TrialActionFacts,
  type TrialObservationLine,
  type TrialTerminalPlayer,
  type TrialTerminalSummary,
  type TrialUnitTable,
} from "@model-war/schema";

/** 报告自己的白名单：日志来自旧档或外部文件，不信任 gen 的写出投影。 */
export const objectOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const numberOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const enumOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
  typeof value === "string" && allowed.includes(value as T) ? (value as T) : null;
/** 报告独立验证语义枚举；未知文本不能影响口径或进入报告。 */
export const usageEnumOf = (
  value: unknown,
  field: keyof typeof USAGE_ENUM_FIELDS,
): string | undefined =>
  value === undefined ? undefined : (enumOf(value, USAGE_ENUM_FIELDS[field]) ?? "unknown");
const statusOf = (value: unknown) =>
  enumOf(objectOf(value).status, ["unverified", "documented", "accepted", "unsupported"]);
const supportOf = (value: unknown) => ({
  official: statusOf(objectOf(value).official),
  channel: statusOf(objectOf(value).channel),
});

export const requestEvidenceOf = (value: unknown, configId: string) => {
  if (value === undefined) return null;
  const evidence = objectOf(value);
  const policy = objectOf(evidence.policy);
  const endpoint = objectOf(policy.endpoint);
  const reasoning = objectOf(policy.reasoning);
  const output = objectOf(policy.output);
  const transport = objectOf(evidence.transport);
  return {
    // 身份来自目录，不接受服务端模型名或任意证据字符串。
    configId,
    configIdMatches: evidence.configId === configId,
    endpointFamily: enumOf(evidence.endpointFamily, ["chat-completions", "messages", "responses"]),
    endpoint: {
      family: enumOf(endpoint.family, ["chat-completions", "messages", "responses"]),
      ...supportOf(endpoint),
    },
    reasoning: {
      intent: enumOf(reasoning.intent, ["high"]),
      control: enumOf(reasoning.control, [
        "unverified",
        "unsupported",
        "chat-effort",
        "responses-effort",
        "adaptive-effort",
        "thinking-enabled",
      ]),
      budgetTokens: numberOf(reasoning.budgetTokens),
      ...supportOf(reasoning),
    },
    output: {
      field: enumOf(output.field, [
        "server-default",
        "max_tokens",
        "max_completion_tokens",
        "max_output_tokens",
      ]),
      maxTokens: numberOf(output.maxTokens),
      includesReasoning: enumOf(output.includesReasoning, ["yes", "no", "unknown"]),
      ...supportOf(output),
    },
    transport: {
      authentication: enumOf(transport.authentication, ["bearer", "api-key", "both"]),
      versionHeaderRecorded: typeof transport.anthropicVersion === "string",
    },
    backendIdentity: "unverified" as const,
  };
};
export type ReportRequestEvidence = ReturnType<typeof requestEvidenceOf>;

// 原协议的未知自由文本不能进入公开报告；披露记录状态而不回显未知值。
const stopValue = (value: unknown, allowed: readonly string[]) => ({
  value: enumOf(value, allowed),
  state:
    value === undefined
      ? "missing"
      : typeof value === "string" && allowed.includes(value)
        ? "recorded"
        : "unknown",
});
export const stopEvidenceOf = (value: unknown) => {
  const log = objectOf(value);
  const details = objectOf(log.stopDetails);
  return {
    finishReason: stopValue(log.finishReason, [
      "stop",
      "length",
      "unknown",
      "incomplete",
      "tool_calls",
      "content_filter",
    ]),
    status: stopValue(details.status, [
      "completed",
      "incomplete",
      "failed",
      "cancelled",
      "queued",
      "in_progress",
    ]),
    reason: stopValue(details.reason, [
      "stop",
      "length",
      "end_turn",
      "max_tokens",
      "stop_sequence",
      "tool_use",
      "pause_turn",
      "refusal",
      "model_context_window_exceeded",
      "max_output_tokens",
      "content_filter",
      "tool_calls",
      "function_call",
    ]),
  };
};
export const paramsOf = (value: unknown) => {
  const params = objectOf(value);
  const projected: Record<string, number | string | Readonly<Record<string, number | string>>> = {};
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens", "seed"]) {
    const number = numberOf(params[key]);
    if (number !== null) projected[key] = number;
  }
  for (const key of ["temperature", "top_p", "presence_penalty", "frequency_penalty"]) {
    const number = params[key];
    if (typeof number === "number" && Number.isFinite(number)) projected[key] = number;
  }
  const effort = enumOf(params.reasoning_effort, [
    "high",
    "medium",
    "low",
    "none",
    "minimal",
    "xhigh",
  ]);
  if (effort !== null) projected.reasoning_effort = effort;
  for (const key of ["reasoning", "output_config"]) {
    const nestedEffort = enumOf(objectOf(params[key]).effort, [
      "high",
      "medium",
      "low",
      "none",
      "minimal",
      "xhigh",
    ]);
    if (nestedEffort !== null) projected[key] = { effort: nestedEffort };
  }
  const thinking = objectOf(params.thinking);
  const type = enumOf(thinking.type, ["adaptive", "enabled", "disabled"]);
  if (type !== null) {
    const budget = numberOf(thinking.budget_tokens);
    projected.thinking = { type, ...(budget === null ? {} : { budget_tokens: budget }) };
  }
  return {
    values: projected,
    // stop/logit_bias 内容有自由文本，只披露是否配置；未知键不透传。
    samplingBiasConfigured: [
      "temperature",
      "top_p",
      "seed",
      "presence_penalty",
      "frequency_penalty",
      "stop",
      "logit_bias",
    ].some((key) => Object.hasOwn(params, key)),
  };
};
// runner 是离线文件 consumer，不能为复用验证器依赖唯一联网的 gen 包；
// schema 只拥有纯数据合同。此处与 gen/terminal-summary 独立校验并投影同一合同，
// 保持相同的计分、身份、淘汰时间、competition rank 和并列积分规则。
const terminalSummarySchema = z.fromJSONSchema(
  JSON.parse(JSON.stringify(TRIAL_TERMINAL_SUMMARY_JSON_SCHEMA)) as z.core.JSONSchema.JSONSchema,
);

const consistentPlayer = (
  summary: TrialTerminalSummary,
  player: TrialTerminalPlayer,
  seat: number,
): boolean => {
  const costTerms = [
    player.survivingUnits.worker * summary.unitCosts.worker,
    player.survivingUnits.melee * summary.unitCosts.melee,
    player.survivingUnits.ranged * summary.unitCosts.ranged,
    player.survivingUnits.cavalry * summary.unitCosts.cavalry,
  ];
  const cost = costTerms.reduce((sum, term) => sum + term, 0);
  const bases = player.controlledBases * summary.weights.baseScore;
  const resources = player.controlledResources * summary.weights.resourceScore;
  const units = Math.floor(cost / summary.weights.unitCostDivisor);
  const territory = bases + resources + units;
  return (
    player.seat === seat &&
    player.player === TRIAL_PLAYER_IDS[seat] &&
    [...costTerms, cost, bases, resources, units, territory].every(Number.isSafeInteger) &&
    player.survivingUnitCost === cost &&
    player.score.bases === bases &&
    player.score.resources === resources &&
    player.score.units === units &&
    player.territoryScore === territory &&
    // 步 5 会清空所有淘汰方点位，但异常淘汰可留下单位与单位分。
    (player.alive || (player.controlledBases === 0 && player.controlledResources === 0)) &&
    player.alive === (player.eliminatedAtTick === null) &&
    (player.eliminatedAtTick === null || player.eliminatedAtTick < summary.tick)
  );
};
const consistentRanks = (summary: TrialTerminalSummary): boolean => {
  const players = summary.players;
  const hasWinner = summary.reason === "victory" || summary.reason === "shortcut";
  const first = players.filter((player) => player.rank === 1);
  if (hasWinner && (first.length !== 1 || first[0]?.alive !== true)) return false;
  if (summary.reason === "all-eliminated" && players.some((player) => player.alive)) return false;
  // 步 5 的零/单存活结局先于步 7 timeout，故 timeout 至少两方存活。
  if (summary.reason === "timeout" && players.filter((player) => player.alive).length < 2)
    return false;
  const winner = hasWinner ? first[0] : undefined;
  if (summary.reason === "shortcut" && players.filter((player) => player.alive).length !== 1)
    return false;
  // 步 5 全点位判定需要非空点位表；只核对胜者有点位、非胜者零控点，不猜地图总数。
  if (
    summary.reason === "victory" &&
    (winner === undefined ||
      (winner.controlledBases === 0 && winner.controlledResources === 0) ||
      players.some(
        (player) =>
          player !== winner && (player.controlledBases !== 0 || player.controlledResources !== 0),
      ))
  )
    return false;
  const layer = (player: TrialTerminalPlayer): number =>
    player === winner ? 0 : player.alive ? 1 : 2;
  const key = (player: TrialTerminalPlayer): number =>
    player.alive ? player.territoryScore : (player.eliminatedAtTick ?? 0);
  return players.every((player) => {
    // competition rank = 严格排在本方之前的座位数 + 1；并列不占另一名次。
    const rank =
      1 +
      players.filter(
        (other) =>
          layer(other) < layer(player) ||
          (layer(other) === layer(player) && key(other) > key(player)),
      ).length;
    if (player.rank !== rank) return false;
    const tied = players.filter((other) => other.rank === rank).length;
    const interval = summary.rankPoints.slice(rank - 1, rank - 1 + tied);
    const total = interval.reduce((sum, points) => sum + points, 0);
    // 与生产记账的公共分母一致；安全整数中间值避免浮点舍入伪造积分。
    const scaled = total * (12 / tied);
    return (
      interval.length === tied &&
      Number.isSafeInteger(total) &&
      Number.isSafeInteger(scaled) &&
      player.rankPoints === scaled / 12
    );
  });
};

const unitsOf = (value: TrialUnitTable): TrialUnitTable => ({
  worker: value.worker,
  melee: value.melee,
  ranged: value.ranged,
  cavalry: value.cavalry,
});
const playerOf = (value: TrialTerminalPlayer): TrialTerminalPlayer => ({
  seat: value.seat,
  player: value.player,
  controlledBases: value.controlledBases,
  controlledResources: value.controlledResources,
  survivingUnits: unitsOf(value.survivingUnits),
  survivingUnitCost: value.survivingUnitCost,
  score: { bases: value.score.bases, resources: value.score.resources, units: value.score.units },
  territoryScore: value.territoryScore,
  rank: value.rank,
  rankPoints: value.rankPoints,
  alive: value.alive,
  eliminatedAtTick: value.eliminatedAtTick,
});

/** 优化试跑终局的公共读入边界；非法数据返回 null，缺失不能补成零分。 */
export const parseTerminalSummary = (
  value: unknown,
  matchIndex: number,
): TrialTerminalSummary | null => {
  if (!terminalSummarySchema.safeParse(value).success) return null;
  // 仅在共享 JSON Schema 验证后恢复数据合同；公共出口始终显式逐字段重建。
  const summary = value as TrialTerminalSummary;
  if (
    summary.tick === 0 ||
    !Number.isInteger(matchIndex) ||
    summary.seed !== TRIAL_SEEDS[matchIndex] ||
    !summary.players.every((player, seat) => consistentPlayer(summary, player, seat)) ||
    !consistentRanks(summary)
  )
    return null;
  return {
    version: summary.version,
    seed: summary.seed,
    tick: summary.tick,
    reason: summary.reason,
    weights: {
      baseScore: summary.weights.baseScore,
      resourceScore: summary.weights.resourceScore,
      unitCostDivisor: summary.weights.unitCostDivisor,
    },
    unitCosts: unitsOf(summary.unitCosts),
    rankPoints: [
      summary.rankPoints[0],
      summary.rankPoints[1],
      summary.rankPoints[2],
      summary.rankPoints[3],
    ],
    players: [
      playerOf(summary.players[0]),
      playerOf(summary.players[1]),
      playerOf(summary.players[2]),
      playerOf(summary.players[3]),
    ],
  };
};

export type ReportObservationInput = Omit<TrialObservationLine, "terminalSummary"> & {
  readonly terminalSummary?: unknown;
};

/** 形状和行动归属验证后投影；终局使用报告独立的纯数据边界，不透传原观测对象。 */
export const observationEvidenceOf = (
  value: ReportObservationInput,
): TrialObservationLine | null => {
  const summary = Object.hasOwn(value, "terminalSummary")
    ? parseTerminalSummary(value.terminalSummary, value.matchIndex)
    : undefined;
  if (summary === null) return null;
  const facts = value.actionFacts;
  if (summary !== undefined && facts !== undefined && summary.seed !== facts.seed) return null;
  return {
    matchIndex: value.matchIndex,
    delivered: value.delivered,
    captures: value.captures,
    noScoreSource: value.noScoreSource,
    ...(summary === undefined ? {} : { terminalSummary: summary }),
    ...(facts === undefined
      ? {}
      : {
          actionFacts: {
            version: facts.version,
            scriptSha256: facts.scriptSha256,
            seed: facts.seed,
            seat: facts.seat,
            complete: facts.complete,
            observedTicks: facts.observedTicks,
            missingTicks: facts.missingTicks,
            calls: Object.fromEntries(
              ACTION_API_NAMES.map((name) => [name, facts.calls[name]]),
            ) as TrialActionFacts["calls"],
            errors: Object.fromEntries(
              ACTION_API_NAMES.map((name) => [
                name,
                Object.fromEntries(
                  ACTION_ERROR_CODES.map((code) => [code, facts.errors[name][code]]),
                ),
              ]),
            ) as TrialActionFacts["errors"],
            effects: Object.fromEntries(
              ACTION_EFFECT_NAMES.map((name) => [name, facts.effects[name]]),
            ) as TrialActionFacts["effects"],
          },
        }),
  };
};

export const failureClassificationOf = (value: unknown) =>
  enumOf(value, ["tsc", "contract", "transport", "selection"]) ?? "unknown";
