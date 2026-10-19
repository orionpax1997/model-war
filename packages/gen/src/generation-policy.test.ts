import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { loadModelsConfig, type ModelConfig } from "./config.js";
import {
  generationParams,
  generationRequestEvidence,
  parseGenerationPolicy,
} from "./generation-policy.js";
import { policyFixture } from "./generation-policy.fixture.js";
import { projectUsage } from "./generation-evidence.js";

const canonical = `models:
  - slug: fixture
    endpointFamily: chat-completions
    baseUrl: https://fixture.invalid/v1
    modelId: fixture/model
    credentialEnvVar: UNREAD_KEY
    generationPolicy:
      endpoint:
        family: chat-completions
        official:
          status: unverified
          source: offline-fixture/endpoint
        channel:
          status: accepted
          source: offline-fixture/channel
      reasoning:
        intent: high
        control: unverified
        official:
          status: unverified
          source: offline-fixture/unverified-reasoning
        channel:
          status: unverified
          source: offline-fixture/unverified-channel
      output:
        field: server-default
        includesReasoning: unknown
        official:
          status: unverified
          source: offline-fixture/output
        channel:
          status: unverified
          source: offline-fixture/channel-output
      transport:
        authentication: bearer
`;
const scratch = mkdtempSync(join(tmpdir(), "modelwar-policy-"));
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

it.each([
  ["非法推理控制", "control: unverified", "control: mystery", /reasoning.control/],
  ["未验证不冒充支持", "control: unverified", "control: chat-effort", /未验证或明确不支持/],
  ["未验证与不支持分开", "control: unverified", "control: unsupported", /明确不支持证据/],
  ["端点映射冲突", "family: chat-completions", "family: responses", /endpoint.family/],
  [
    "输出字段冲突",
    "field: server-default",
    "field: max_output_tokens\n        maxTokens: 8192",
    /output.field/,
  ],
  [
    "未知默认上限不可伪造",
    "field: server-default",
    "field: server-default\n        maxTokens: 99999",
    /服务端默认/,
  ],
  [
    "非法版本头",
    "authentication: bearer",
    "authentication: bearer\n        anthropicVersion: tomorrow",
    /anthropicVersion/,
  ],
  ["未知字段", "intent: high", "intent: high\n        temperature: 0", /temperature:未知字段/],
  ["空证据", "source: offline-fixture/unverified-reasoning", 'source: ""', /source/],
  [
    "禁止透传覆盖",
    "    generationPolicy:",
    "    params:\n      temperature: 0\n    generationPolicy:",
    /不可与 params 混用/,
  ],
])("加载前诊断：%s", (_label, before, after, error) => {
  const path = join(scratch, "invalid.yaml");
  writeFileSync(path, canonical.replace(before, after));
  expect(() => loadModelsConfig(path)).toThrow(error);
});

const fixtureModel = (family: ModelConfig["endpointFamily"]): ModelConfig => ({
  slug: "fixture",
  endpointFamily: family,
  baseUrl: "https://fixture.invalid/v1",
  modelId: "fixture/model",
  credentialEnvVar: "UNREAD_KEY",
  generationPolicy: policyFixture(family),
});

it("官方声明不能替代代理的能力证据；未经验证不发送 native high", () => {
  const model = fixtureModel("responses");
  const policy = policyFixture("responses");
  expect(() =>
    generationParams({
      ...model,
      generationPolicy: {
        ...policy,
        reasoning: {
          ...policy.reasoning,
          channel: { status: "unverified", source: "channel not checked" },
        },
      },
    }),
  ).toThrow("未验证");
});

it("明确不支持是可见诊断，不降档、不改端点", () => {
  const model = fixtureModel("responses");
  const policy = policyFixture("responses");
  const config = {
    ...model,
    generationPolicy: {
      ...policy,
      reasoning: {
        ...policy.reasoning,
        control: "unsupported" as const,
        channel: { status: "unsupported" as const, source: "fixture rejects reasoning" },
      },
    },
  };
  expect(generationParams(config)).toEqual({ max_output_tokens: 8192 });
  expect(generationRequestEvidence(config)?.diagnostics).toContain(
    "high 未发送：渠道明确不支持推理控制",
  );
});

it.each(["chat-completions", "messages", "responses"] as const)(
  "能力映射与非法组合校验：%s",
  (family) => {
    const model = fixtureModel(family);
    expect(generationParams(model)).toEqual(
      family === "chat-completions"
        ? { reasoning_effort: "high", max_completion_tokens: 8192 }
        : family === "responses"
          ? { reasoning: { effort: "high" }, max_output_tokens: 8192 }
          : { thinking: { type: "adaptive" }, output_config: { effort: "high" }, max_tokens: 8192 },
    );
    expect(() =>
      generationParams({
        ...model,
        generationPolicy: {
          ...policyFixture(family),
          reasoning: {
            ...policyFixture(family).reasoning,
            control: family === "responses" ? "chat-effort" : "responses-effort",
          },
        },
      }),
    ).toThrow("不兼容");
  },
);

it("adaptive 中转扩展 forceAdaptiveThinking 显式声明，不污染默认映射", () => {
  const model = {
    ...fixtureModel("messages"),
    generationPolicy: policyFixture("messages", "adaptive-effort"),
  };
  expect(generationParams(model)).toEqual({
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    max_tokens: 8192,
  });
  expect(
    generationParams({
      ...model,
      generationPolicy: {
        ...model.generationPolicy,
        reasoning: { ...model.generationPolicy.reasoning, forceAdaptiveThinking: true },
      },
    }),
  ).toEqual({
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    forceAdaptiveThinking: true,
    max_tokens: 8192,
  });
  expect(() =>
    generationParams({
      ...model,
      generationPolicy: {
        ...policyFixture("messages", "thinking-enabled"),
        reasoning: {
          ...policyFixture("messages", "thinking-enabled").reasoning,
          forceAdaptiveThinking: true,
        },
      },
    }),
  ).toThrow("forceAdaptiveThinking");
  const issues: string[] = [];
  parseGenerationPolicy(
    {
      ...model.generationPolicy,
      reasoning: { ...model.generationPolicy.reasoning, forceAdaptiveThinking: "yes" },
    },
    "messages",
    "fixture",
    issues,
  );
  expect(issues.join()).toContain("forceAdaptiveThinking");
});

it("开关式 thinking 保持自身语义，预算必须合法且不越输出上限", () => {
  const model = {
    ...fixtureModel("messages"),
    generationPolicy: policyFixture("messages", "thinking-enabled"),
  };
  expect(generationParams(model)).toEqual({
    thinking: { type: "enabled", budget_tokens: 2048 },
    max_tokens: 8192,
  });
  const issues: string[] = [];
  parseGenerationPolicy(
    {
      ...model.generationPolicy,
      reasoning: { ...model.generationPolicy.reasoning, budgetTokens: 8192 },
    },
    "messages",
    "fixture",
    issues,
  );
  expect(issues.join()).toContain("小于输出预算");
});

it("用量仅保留已回报白名单，不把缺字段补零，不累加推理与总量", () => {
  expect(projectUsage(undefined)).toBeUndefined();
  expect(projectUsage({})).toBeUndefined();
  expect(
    projectUsage({
      input_tokens: 12,
      output_tokens: 7,
      total_tokens: 19,
      output_tokens_details: { reasoning_tokens: 5, prompt: "SECRET" },
      provider_error: "SECRET",
      api_key: "SECRET",
      completion_tokens: -1,
    }),
  ).toEqual({
    input_tokens: 12,
    output_tokens: 7,
    total_tokens: 19,
    output_tokens_details: { reasoning_tokens: 5 },
  });
});

it("用量对象深度与枚举闭合；已知 billing/cache/thinking 数字保留，嵌套载荷与非法数值不透传", () => {
  const secret = "PRIVATE_PROVIDER_PAYLOAD";
  expect(
    projectUsage({
      usage_semantic: "openai",
      usage_source: "anthropic",
      output_tokens_details: {
        thinking_tokens: 13094,
        prompt: secret,
        output_tokens_details: { thinking_tokens: 99 },
      },
      input_tokens_details: {
        cache_write_tokens: 20392,
        cached_tokens: Number.MAX_SAFE_INTEGER + 1,
      },
      prompt_tokens_details: { cached_creation_tokens: null },
      billing_usage: {
        source: "claude_messages",
        semantic: "anthropic",
        error: secret,
        claude_usage: {
          input_tokens: 4,
          output_tokens: 9,
          cache_creation: {
            ephemeral_5m_input_tokens: 6,
            ephemeral_1h_input_tokens: 4,
            body: secret,
          },
          prompt: secret,
        },
        arbitrary: { input_tokens: 99999 },
      },
      reasoning_tokens: Infinity,
      cache_write_tokens: -1,
      thinking_tokens: 1.5,
    }),
  ).toEqual({
    usage_semantic: "openai",
    usage_source: "anthropic",
    output_tokens_details: { thinking_tokens: 13094 },
    input_tokens_details: { cache_write_tokens: 20392 },
    prompt_tokens_details: { cached_creation_tokens: null },
    billing_usage: {
      source: "claude_messages",
      semantic: "anthropic",
      claude_usage: {
        input_tokens: 4,
        output_tokens: 9,
        cache_creation: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 4 },
      },
    },
  });
  expect(
    projectUsage({
      usage_semantic: secret,
      usage_source: secret,
      billing_usage: { source: secret, semantic: secret, claude_usage: { output_tokens: 3 } },
    }),
  ).toEqual({ billing_usage: { claude_usage: { output_tokens: 3 } } });
});
