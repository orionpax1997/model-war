import type { EndpointFamily, ModelConfig } from "./config.js";
import type { ModelParams } from "./model-client.js";
import { isRecord } from "./record.js";

/** 接受请求仅证明渠道接受字段，不证明执行了参数，也不是上游身份认证。 */
export type SupportStatus = "unverified" | "documented" | "accepted" | "unsupported";
export type SupportEvidence = { readonly status: SupportStatus; readonly source: string };
type EvidencePair = {
  readonly official: SupportEvidence;
  readonly channel: SupportEvidence;
};
export type ReasoningControl =
  | "unverified"
  | "unsupported"
  | "chat-effort"
  | "responses-effort"
  | "adaptive-effort"
  | "thinking-enabled";
export type OutputField =
  | "server-default"
  | "max_tokens"
  | "max_completion_tokens"
  | "max_output_tokens";

/** 规范配置的唯一参数入口；旧 params 配置仍可读取，不自动迁移历史产物。 */
export type GenerationPolicy = {
  readonly endpoint: EvidencePair & { readonly family: EndpointFamily };
  readonly reasoning: EvidencePair & {
    readonly intent: "high";
    readonly control: ReasoningControl;
    /** 开关式 thinking 的预算，不把它声称为三级 effort。 */
    readonly budgetTokens?: number;
    /** 仅 adaptive-effort 可用：部分 messages 中转要求顶层透传该开关。缺省不发送。 */
    readonly forceAdaptiveThinking?: boolean;
  };
  readonly output: EvidencePair & {
    readonly field: OutputField;
    readonly maxTokens?: number;
    readonly includesReasoning: "yes" | "no" | "unknown";
  };
  readonly transport: {
    readonly authentication: "bearer" | "api-key" | "both";
    readonly anthropicVersion?: string;
  };
};

const STATUSES = ["unverified", "documented", "accepted", "unsupported"] as const;
const CONTROLS = [
  "unverified",
  "unsupported",
  "chat-effort",
  "responses-effort",
  "adaptive-effort",
  "thinking-enabled",
] as const;
const OUTPUT_FIELDS = [
  "server-default",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
] as const;
const FAMILIES = ["chat-completions", "messages", "responses"] as const;
const supported = (evidence: SupportEvidence): boolean =>
  evidence.status === "documented" || evidence.status === "accepted";

const keys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  issues: string[],
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${label}.${key}:未知字段`);
  }
};
const enumField = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  issues: string[],
): T | undefined => {
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  issues.push(`${label}:应取 ${allowed.join(" / ")}`);
  return undefined;
};
const evidence = (value: unknown, label: string, issues: string[]): SupportEvidence | undefined => {
  if (!isRecord(value)) {
    issues.push(`${label}:必须包含 status 和 source`);
    return undefined;
  }
  keys(value, ["status", "source"], label, issues);
  const status = enumField(value.status, STATUSES, `${label}.status`, issues);
  if (typeof value.source !== "string" || value.source.trim().length === 0) {
    issues.push(`${label}.source:必须是非空证据来源或未验证原因`);
    return undefined;
  }
  return status === undefined ? undefined : { status, source: value.source };
};
const pair = (
  value: Record<string, unknown>,
  label: string,
  issues: string[],
): EvidencePair | undefined => {
  const official = evidence(value.official, `${label}.official`, issues);
  const channel = evidence(value.channel, `${label}.channel`, issues);
  return official === undefined || channel === undefined ? undefined : { official, channel };
};
const positiveInteger = (value: unknown, label: string, issues: string[]): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  issues.push(`${label}:必须是正安全整数`);
  return undefined;
};

/** 加载及直接编排入口共用校验；不读环境变量，不探测渠道。 */
export const parseGenerationPolicy = (
  value: unknown,
  family: EndpointFamily,
  label: string,
  issues: string[],
): GenerationPolicy | undefined => {
  if (!isRecord(value)) {
    issues.push(`${label}:必须是映射`);
    return undefined;
  }
  keys(value, ["endpoint", "reasoning", "output", "transport"], label, issues);
  const { endpoint, reasoning, output, transport } = value;
  if (!isRecord(endpoint) || !isRecord(reasoning) || !isRecord(output) || !isRecord(transport)) {
    issues.push(`${label}:endpoint / reasoning / output / transport 必须是映射`);
    return undefined;
  }
  keys(endpoint, ["family", "official", "channel"], `${label}.endpoint`, issues);
  keys(
    reasoning,
    ["intent", "control", "budgetTokens", "forceAdaptiveThinking", "official", "channel"],
    `${label}.reasoning`,
    issues,
  );
  keys(
    output,
    ["field", "maxTokens", "includesReasoning", "official", "channel"],
    `${label}.output`,
    issues,
  );
  keys(transport, ["authentication", "anthropicVersion"], `${label}.transport`, issues);
  const endpointFamily = enumField(endpoint.family, FAMILIES, `${label}.endpoint.family`, issues);
  const endpointEvidence = pair(endpoint, `${label}.endpoint`, issues);
  const intent = enumField(reasoning.intent, ["high"], `${label}.reasoning.intent`, issues);
  const control = enumField(reasoning.control, CONTROLS, `${label}.reasoning.control`, issues);
  const reasoningEvidence = pair(reasoning, `${label}.reasoning`, issues);
  const field = enumField(output.field, OUTPUT_FIELDS, `${label}.output.field`, issues);
  const outputEvidence = pair(output, `${label}.output`, issues);
  const includesReasoning = enumField(
    output.includesReasoning,
    ["yes", "no", "unknown"],
    `${label}.output.includesReasoning`,
    issues,
  );
  const authentication = enumField(
    transport.authentication,
    ["bearer", "api-key", "both"],
    `${label}.transport.authentication`,
    issues,
  );
  const budgetTokens = positiveInteger(
    reasoning.budgetTokens,
    `${label}.reasoning.budgetTokens`,
    issues,
  );
  const maxTokens = positiveInteger(output.maxTokens, `${label}.output.maxTokens`, issues);
  const forceAdaptiveThinking =
    typeof reasoning.forceAdaptiveThinking === "boolean"
      ? reasoning.forceAdaptiveThinking
      : undefined;
  const version = transport.anthropicVersion;
  if (
    version !== undefined &&
    (typeof version !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(version))
  ) {
    issues.push(`${label}.transport.anthropicVersion:必须是 YYYY-MM-DD`);
  }
  if (endpointFamily !== family) issues.push(`${label}.endpoint.family:与 endpointFamily 不一致`);
  if (endpointEvidence?.channel.status === "unsupported")
    issues.push(`${label}.endpoint:渠道明确不支持该端点`);
  if (control !== undefined && reasoningEvidence !== undefined) {
    if (control === "unverified") {
      if (reasoningEvidence.channel.status !== "unverified")
        issues.push(`${label}.reasoning:unverified 控制须保留渠道未验证状态`);
    } else if (control === "unsupported") {
      if (reasoningEvidence.channel.status !== "unsupported")
        issues.push(`${label}.reasoning:unsupported 须有渠道明确不支持证据`);
    } else {
      if (
        !supported(reasoningEvidence.channel) ||
        reasoningEvidence.official.status === "unsupported"
      )
        issues.push(`${label}.reasoning:未验证或明确不支持，不能发送 high 控制`);
      const expected =
        control === "chat-effort"
          ? "chat-completions"
          : control === "responses-effort"
            ? "responses"
            : "messages";
      if (family !== expected) issues.push(`${label}.reasoning.control:与端点族不兼容`);
    }
  }
  if (control === "thinking-enabled") {
    if (
      budgetTokens === undefined ||
      maxTokens === undefined ||
      budgetTokens < 1024 ||
      budgetTokens >= maxTokens
    )
      issues.push(`${label}.reasoning.budgetTokens:thinking-enabled 要求 ≥1024 且小于输出预算`);
  } else if (reasoning.budgetTokens !== undefined)
    issues.push(`${label}.reasoning.budgetTokens:仅 thinking-enabled 可用`);
  if (reasoning.forceAdaptiveThinking !== undefined) {
    if (typeof reasoning.forceAdaptiveThinking !== "boolean")
      issues.push(`${label}.reasoning.forceAdaptiveThinking:必须是布尔值`);
    else if (control !== "adaptive-effort")
      issues.push(`${label}.reasoning.forceAdaptiveThinking:仅 adaptive-effort 可用`);
  }
  if (field === "server-default") {
    if (output.maxTokens !== undefined || includesReasoning !== "unknown")
      issues.push(`${label}.output:服务端默认上限及推理计量必须保持未知`);
    if (family === "messages") issues.push(`${label}.output:Messages 必须显式提供 max_tokens`);
  } else if (field !== undefined) {
    if (
      maxTokens === undefined ||
      outputEvidence === undefined ||
      !supported(outputEvidence.channel) ||
      outputEvidence.official.status === "unsupported"
    )
      issues.push(`${label}.output:显式预算要求正整数及渠道支持证据`);
    if (
      (family === "messages" && field !== "max_tokens") ||
      (family === "responses" && field !== "max_output_tokens") ||
      (family === "chat-completions" && field === "max_output_tokens")
    )
      issues.push(`${label}.output.field:与端点族不兼容`);
  }
  if (family !== "messages" && (authentication !== "bearer" || version !== undefined))
    issues.push(`${label}.transport:非 Messages 使用 bearer，不发送 Anthropic 版本头`);
  if (
    endpointFamily === undefined ||
    endpointEvidence === undefined ||
    intent === undefined ||
    control === undefined ||
    reasoningEvidence === undefined ||
    field === undefined ||
    outputEvidence === undefined ||
    includesReasoning === undefined ||
    authentication === undefined ||
    (version !== undefined && typeof version !== "string")
  )
    return undefined;
  return {
    endpoint: { family: endpointFamily, ...endpointEvidence },
    reasoning: {
      intent,
      control,
      ...reasoningEvidence,
      ...(budgetTokens === undefined ? {} : { budgetTokens }),
      ...(forceAdaptiveThinking === undefined ? {} : { forceAdaptiveThinking }),
    },
    output: {
      field,
      includesReasoning,
      ...outputEvidence,
      ...(maxTokens === undefined ? {} : { maxTokens }),
    },
    transport: {
      authentication,
      ...(typeof version === "string" ? { anthropicVersion: version } : {}),
    },
  };
};

/** 一次解析后整次生成复用；修复、反馈及 HTTP 重试不得扩大预算或降档。 */
export const generationParams = (config: ModelConfig): ModelParams => {
  if (config.generationPolicy === undefined) return config.params ?? {};
  const issues: string[] = [];
  const policy = parseGenerationPolicy(
    config.generationPolicy,
    config.endpointFamily,
    `${config.slug}.generationPolicy`,
    issues,
  );
  if (config.params !== undefined && Object.keys(config.params).length > 0)
    issues.push(`${config.slug}:generationPolicy 不可与 params 混用（包括采样偏置及原生参数）`);
  if (policy === undefined || issues.length > 0)
    throw new Error(`模型参数政策无效:\n${issues.join("\n")}`);
  const params: Record<string, unknown> = {};
  if (policy.output.maxTokens !== undefined) params[policy.output.field] = policy.output.maxTokens;
  switch (policy.reasoning.control) {
    case "chat-effort":
      params.reasoning_effort = "high";
      break;
    case "responses-effort":
      params.reasoning = Object.freeze({ effort: "high" });
      break;
    case "adaptive-effort":
      params.thinking = Object.freeze({ type: "adaptive" });
      params.output_config = Object.freeze({ effort: "high" });
      if (policy.reasoning.forceAdaptiveThinking === true) params.forceAdaptiveThinking = true;
      break;
    case "thinking-enabled":
      params.thinking = Object.freeze({
        type: "enabled",
        budget_tokens: policy.reasoning.budgetTokens,
      });
      break;
    case "unverified":
    case "unsupported":
      break;
  }
  return Object.freeze(params);
};

/** 实际 HTTP 头契约；官方 Messages 要求版本和 api-key，代理严格按声明。 */
export const generationTransport = (config: ModelConfig): GenerationPolicy["transport"] => {
  if (
    config.endpointFamily === "messages" &&
    new URL(config.baseUrl).hostname === "api.anthropic.com"
  ) {
    return {
      authentication: "api-key",
      anthropicVersion: config.generationPolicy?.transport.anthropicVersion ?? "2023-06-01",
    };
  }
  return (
    config.generationPolicy?.transport ?? {
      authentication: config.endpointFamily === "messages" ? "both" : "bearer",
    }
  );
};

/** 白名单配置意图；保留缺口诊断，不把未发送的 high 宣称已生效。 */
export const generationRequestEvidence = (config: ModelConfig) => {
  const policy = config.generationPolicy;
  if (policy === undefined) return undefined;
  const issues: string[] = [];
  const projected = parseGenerationPolicy(policy, config.endpointFamily, config.slug, issues);
  if (projected === undefined || issues.length > 0) throw new Error(issues.join("\n"));
  const diagnostics: string[] = [];
  if (policy.reasoning.control === "unverified")
    diagnostics.push("high 未发送：渠道推理控制未验证");
  if (policy.reasoning.control === "unsupported")
    diagnostics.push("high 未发送：渠道明确不支持推理控制");
  if (policy.output.field === "server-default")
    diagnostics.push("输出上限未验证，使用未知服务端默认值");
  if (policy.endpoint.channel.status === "unverified") diagnostics.push("端点渠道支持未验证");
  return {
    configId: config.slug,
    endpointFamily: config.endpointFamily,
    policy: projected,
    transport: generationTransport(config),
    diagnostics,
    backendIdentity: "unverified" as const,
  };
};
