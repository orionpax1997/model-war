import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it, vi } from "vitest";
import { RULESET_VERSION, type ArchiveMeta } from "@model-war/schema";
import {
  createHttpModelClient,
  generateOneModel,
  type ModelConfig,
  readRuleDocs,
  loadBaseTemplate,
} from "@model-war/gen";
import { readArchiveReports, runArchiveReport } from "@model-war/runner";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "usage-report-pipeline-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const script = "function loop() {}\n";
const secret = "PRIVATE_USAGE_PROMPT_CREDENTIAL_PROVIDER_BODY";
const fixtures = [
  {
    name: "Opus 兼容响应的枚举、重叠字段和缓存写",
    usage: {
      usage_semantic: "openai",
      usage_source: "anthropic",
      prompt_tokens: 27772,
      completion_tokens: 3292,
      total_tokens: 31064,
      input_tokens: 27772,
      output_tokens: 0,
      prompt_tokens_details: {
        cached_tokens: 0,
        cached_creation_tokens: 27768,
        cache_write_tokens: 27768,
      },
      completion_tokens_details: { reasoning_tokens: 0 },
      billing_usage: {
        source: "claude_messages",
        semantic: "anthropic",
        claude_usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 27768,
          cache_read_input_tokens: 0,
          output_tokens: 3292,
          cache_creation: { ephemeral_5m_input_tokens: 27768 },
        },
      },
    },
    readings: {
      input: { value: 27772 },
      output: { value: 3292, conflict: true },
      cacheRead: { value: 0 },
      cacheWrite: { value: 27768 },
      reasoning: { value: 0 },
    },
  },
  {
    name: "Haiku thinking_tokens",
    usage: { output_tokens_details: { thinking_tokens: 13094 } },
    readings: {
      reasoning: { value: 13094, source: "usage.output_tokens_details.thinking_tokens" },
      input: { value: null, state: "missing" },
    },
  },
  {
    name: "Luna cache_write_tokens",
    usage: { input_tokens_details: { cache_write_tokens: 20392 } },
    readings: {
      cacheWrite: { value: 20392, source: "usage.input_tokens_details.cache_write_tokens" },
    },
  },
  {
    name: "Anthropic 明确口径优先对应字段，不累加重叠的 prompt/output",
    usage: {
      usage_semantic: "anthropic",
      usage_source: "anthropic",
      prompt_tokens: 100,
      input_tokens: 4,
      cache_read_input_tokens: 6,
      cache_creation_input_tokens: 10,
      completion_tokens: 0,
      output_tokens: 9,
      completion_tokens_details: { reasoning_tokens: 0 },
      output_tokens_details: { thinking_tokens: 8 },
      cache_creation: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 4 },
    },
    readings: {
      input: { value: 20 },
      output: { value: 9 },
      cacheRead: { value: 6 },
      cacheWrite: { value: 10 },
      reasoning: { value: 8 },
    },
  },
  {
    name: "billing_usage-only 保留完整输入分量及缓存时长明细",
    usage: {
      billing_usage: {
        semantic: "anthropic",
        source: "claude_messages",
        claude_usage: {
          input_tokens: 4,
          cache_read_input_tokens: 6,
          cache_creation_input_tokens: 10,
          output_tokens: 9,
          cache_creation: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 4 },
        },
      },
    },
    readings: {
      input: { value: 20 },
      output: { value: 9 },
      cacheRead: { value: 6 },
      cacheWrite: { value: 10 },
    },
  },
  {
    name: "OpenAI input_tokens 总输入口径与显式 null，不被缓存写别名覆盖",
    usage: {
      usage_semantic: "openai",
      input_tokens: 12,
      output_tokens: 7,
      prompt_tokens_details: { cached_creation_tokens: null, cache_write_tokens: 4 },
    },
    readings: {
      input: { value: 12, state: "recorded" },
      output: { value: 7 },
      cacheWrite: { value: null, state: "null" },
    },
  },
  {
    name: "原生输入缺缓存分量仍未知，不把缺失写成零",
    usage: { usage_semantic: "anthropic", input_tokens: 4, output_tokens: 9 },
    readings: {
      input: { value: null, state: "missing" },
      cacheRead: { value: null, state: "missing" },
      cacheWrite: { value: null, state: "missing" },
    },
  },
];

it.each(fixtures)("真实 HTTP 响应→生成冻结记录→公开报告：$name", async ({ usage, readings }) => {
  const root = mkdtempSync(join(scratch, "root-"));
  for (const relative of ["node_modules", "packages", "tsconfig.scripts.json"])
    symlinkSync(join(repoRoot, relative), join(root, relative));
  mkdirSync(join(root, "docs/rules-v2"), { recursive: true });
  writeFileSync(join(root, "docs/rules-v2/rules.md"), "# rules\n机制契约\n");
  writeFileSync(join(root, "docs/rules-v2/api.md"), "# API\n接口契约\n");
  mkdirSync(join(root, "prompts"));
  writeFileSync(join(root, "prompts/base.md"), "契约:\n{{contract}}\n");
  mkdirSync(join(root, "rulesets"));
  writeFileSync(
    join(root, `rulesets/${RULESET_VERSION}.json`),
    readFileSync(join(repoRoot, `rulesets/${RULESET_VERSION}.json`)),
  );
  const evidence = {
    official: { status: "documented" as const, source: "offline-fixture/official-contract" },
    channel: { status: "accepted" as const, source: "offline-fixture/channel-contract" },
  };
  const config: ModelConfig = {
    slug: "alpha",
    endpointFamily: "chat-completions",
    modelId: "fixture/model",
    baseUrl: "https://offline.invalid/v1",
    credentialEnvVar: "USAGE_REPORT_TEST_KEY",
    generationPolicy: {
      endpoint: { family: "chat-completions", ...evidence },
      reasoning: {
        intent: "high",
        control: "unverified",
        ...evidence,
        channel: { status: "unverified", source: "offline-fixture/unverified-channel" },
      },
      output: { field: "server-default", includesReasoning: "unknown", ...evidence },
      transport: { authentication: "bearer" },
    },
  };
  // 使用真实 HTTP 适配器与线协议解析；唯一替换的是 fetch 返回的离线响应字节。
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: script }, finish_reason: "stop" }],
          usage: {
            ...usage,
            prompt: secret,
            api_key: secret,
            provider_error: secret,
            arbitrary: { input_tokens: 99999, payload: secret },
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("USAGE_REPORT_TEST_KEY", secret);
  try {
    const outcome = await generateOneModel(
      {
        root,
        runId: "r1",
        docs: readRuleDocs(root),
        template: loadBaseTemplate(root),
        createClient: createHttpModelClient,
        now: () => new Date("2026-10-13T00:00:00Z"),
        trial: () => ({ passed: true, stdout: "" }),
      },
      config,
    );
    expect(outcome.kind).toBe("frozen");
    expect(fetch).toHaveBeenCalledTimes(1);
    const meta: ArchiveMeta = JSON.parse(
      readFileSync(join(root, "archive/alpha/r1/meta.json"), "utf8"),
    );
    const log = JSON.parse(meta.generationLog[0]!);
    expect(log.usage).toEqual(usage);
    expect(log.attemptEvidence[0].usage).toEqual(usage);
    expect(JSON.stringify(meta.generationLog)).not.toContain(secret);
    const [report] = readArchiveReports(root);
    expect(report?.rounds[0]?.usage).toMatchObject(readings);
    expect(report?.rounds[0]?.attempts[0]?.usage).toMatchObject(readings);
    for (const [metric, reading] of Object.entries(readings)) {
      expect(report?.totals[metric as keyof typeof report.totals]).toMatchObject({
        value: reading.value,
        recordedTotal: reading.value,
        recordedRounds: reading.value === null ? 0 : 1,
        expectedRounds: 1,
      });
    }
    for (const json of [true, false]) {
      const output: string[] = [];
      const errors: string[] = [];
      expect(
        await runArchiveReport(["--root", root, ...(json ? ["--json"] : [])], {
          stdout: (text) => output.push(text),
          stderr: (text) => errors.push(text),
        }),
      ).toBe(0);
      expect(errors).toEqual([]);
      expect(output.join("")).not.toContain(secret);
      if (json) expect(JSON.parse(output.join(""))[0].rounds[0].usage).toMatchObject(readings);
      else expect(output.join("")).toContain("不相加作账单");
    }
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
