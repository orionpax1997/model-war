import type { ModelConfig } from "./config.js";
import type { GenerationPolicy, ReasoningControl } from "./generation-policy.js";

/** 仅供离线契约测试：这是 fixture 能力声明，不是生产模型支持证据。 */
export const policyFixture = (
  family: ModelConfig["endpointFamily"],
  control?: ReasoningControl,
): GenerationPolicy => {
  const evidence = {
    official: { status: "documented" as const, source: "offline-fixture/official-contract" },
    channel: { status: "accepted" as const, source: "offline-fixture/channel-contract" },
  };
  // 先解出实际控制再全程使用:渠道证据必须跟**真正发出的控制**同档,
  // 不能用参数原值(缺省时它是 undefined)。
  const resolved: ReasoningControl =
    control ??
    (family === "chat-completions"
      ? "chat-effort"
      : family === "responses"
        ? "responses-effort"
        : // Google 族的 thinking 控制写作 generationConfig.thinkingConfig.thinkingLevel。
          family === "generate-content"
          ? "thinking-level"
          : "adaptive-effort");
  return {
    endpoint: { family, ...evidence },
    reasoning: {
      intent: "high",
      control: resolved,
      ...evidence,
      ...(resolved === "unverified"
        ? {
            channel: {
              status: "unverified" as const,
              source: "offline-fixture/unverified-channel",
            },
          }
        : {}),
      ...(resolved === "thinking-enabled" ? { budgetTokens: 2048 } : {}),
    },
    output: {
      field:
        family === "chat-completions"
          ? "max_completion_tokens"
          : family === "generate-content"
            ? "max_output_tokens"
            : family === "responses"
              ? "max_output_tokens"
              : "max_tokens",
      maxTokens: 8192,
      includesReasoning: "yes",
      ...evidence,
    },
    transport: {
      authentication: family === "messages" ? "api-key" : "bearer",
      ...(family === "messages" ? { anthropicVersion: "2023-06-01" } : {}),
    },
  };
};
