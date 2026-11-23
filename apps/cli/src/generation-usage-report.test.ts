import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it, vi } from "vitest";
import { RULESET_VERSION, type ArchiveMeta } from "@model-war/schema";
import {
  completeGridTrial,
  createHttpModelClient,
  generateOneModel,
  gridPlanFixture,
  type ModelConfig,
} from "@model-war/gen";
import { readArchiveReports, runArchiveReport } from "@model-war/runner";
import { withRealBash } from "@model-war/gen/testing";

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

/**
 * 一条 chat-completions 的 `tool_calls` 响应消息(不收参数的工具):线协议全形状。
 *
 * 夹具走**真 HTTP 适配器**,所以这里的字节就是渠道形状:解析那一侧读
 * `message.tool_calls[].function.{name,arguments}`,`arguments` 是**字符串**(不在这里解析)。
 */
const wireToolCall = (name: string) => ({
  content: null,
  tool_calls: [{ id: "call-1", type: "function", function: { name, arguments: "{}" } }],
});

const evidence = {
  official: { status: "documented" as const, source: "offline-fixture/official-contract" },
  channel: { status: "accepted" as const, source: "offline-fixture/channel-contract" },
};

/** 一次生成需要的最小工作区:安装面 + 规则集(契约正文不进首条消息,故不需要 docs/)。 */
const makeRoot = (): string => {
  const root = mkdtempSync(join(scratch, "root-"));
  for (const relative of ["node_modules", "packages", "tsconfig.scripts.json"])
    symlinkSync(join(repoRoot, relative), join(root, relative));
  mkdirSync(join(root, "rulesets"));
  writeFileSync(
    join(root, `rulesets/${RULESET_VERSION}.json`),
    readFileSync(join(repoRoot, `rulesets/${RULESET_VERSION}.json`)),
  );
  return root;
};

it.each(fixtures)("真实 HTTP 响应→生成冻结记录→公开报告：$name", async ({ usage, readings }) => {
  const root = makeRoot();
  const config: ModelConfig = {
    slug: "alpha",
    endpointFamily: "chat-completions",
    modelId: "fixture/model",
    baseUrl: "https://offline.invalid/v1",
    credentialEnvVar: "USAGE_REPORT_TEST_KEY",
    channelId: "usage-report-test-channel",
    contextLength: 100000,
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
  // 一步:直接 evaluate(脚本由测试预置在工作区里)。
  //
  // 这些用例验的是 **HTTP 响应 → 档案 → 报告的 usage 投影**,不是 loop 怎么攒脚本;所以让
  // 会话只有一步,那一步的响应就带着要验的 usage。`script.ts` 预置在工作区,于是一次
  // `evaluate` 就能提交。
  const bodies = [
    JSON.stringify({
      choices: [
        {
          message: {
            // 写脚本与 evaluate 必须是**两次工具调用**(一步恰好一次):`evaluate` 那一次才算提交;
            // 把两件事塞进同一次 `bash` 的 `command` 里只是跑了一个 shell(ADR-0032 的动作边界)。
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({
                    command: `cat > /workspace/script.ts <<'EOF'\n${script}EOF`,
                  }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        ...usage,
        prompt: secret,
        api_key: secret,
        provider_error: secret,
        arbitrary: { input_tokens: 99999, payload: secret },
      },
    }),
    JSON.stringify({
      choices: [{ message: wireToolCall("evaluate"), finish_reason: "tool_calls" }],
      // 后续步骤不带 usage:这些用例的合计口径都对着**第一步**那一条响应。
      usage: null,
    }),
    // 第三步收工:不 `finish` 的话会话会一直跑后续 evaluate 直到步数耗尽(每次都是一次调用)。
    JSON.stringify({
      choices: [{ message: wireToolCall("finish"), finish_reason: "tool_calls" }],
      // 后续步骤不带 usage:这些用例的合计口径都对着**第一步**那一条响应。
      usage: null,
    }),
  ];
  let call = 0;
  const fetch = vi.fn(async () => {
    const body = bodies[call] ?? bodies[bodies.length - 1]!;
    call += 1;
    return new Response(body, { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("USAGE_REPORT_TEST_KEY", secret);
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  try {
    const outcome = await withRealBash(workspaceDir, () =>
      generateOneModel(
        {
          root,
          runId: "r1",
          agentPrompt: { user: "任务:写 script.ts", system: "协议:每一步一个动作块" },
          createClient: createHttpModelClient,
          workspaceDir,
          // 时钟取**当下**:会话墙钟 = 起点 + 1800s,固定在过去会让第一次工具调用就被判
          // 「会话已到点」,而那与被测的 usage 投影毫无关系。
          now: () => new Date(),
          trial: completeGridTrial(),
          trialPlan: () => gridPlanFixture(),
        },
        config,
      ),
    );
    expect(outcome.kind).toBe("frozen");
    // 三步 = 三次 HTTP 调用(一步一次):写脚本 → evaluate → done。usage 取第一条日志行。
    expect(fetch).toHaveBeenCalledTimes(3);
    const meta: ArchiveMeta = JSON.parse(
      readFileSync(join(root, "archive/alpha/r1/meta.json"), "utf8"),
    );
    const log = JSON.parse(meta.generationLog[0]!);
    // 端点族在服务端没给口径时补一个（chat 族 → openai）；回显了任一字段就整对保留。
    const echoed = Object.hasOwn(usage, "usage_semantic") || Object.hasOwn(usage, "usage_source");
    const expectedUsage = echoed
      ? usage
      : { ...usage, usage_semantic: "openai", usage_source: "openai" };
    expect(log.usage).toEqual(expectedUsage);
    expect(log.attemptEvidence[0].usage).toEqual(expectedUsage);
    expect(JSON.stringify(meta.generationLog)).not.toContain(secret);
    const [report] = readArchiveReports(root);
    expect(report?.rounds[0]?.usage).toMatchObject(readings);
    expect(report?.rounds[0]?.attempts[0]?.usage).toMatchObject(readings);
    // 会话有三步、只有第一步带 usage。合计因此是 `null` 而不是第一步那个数:报告侧的既定纪律
    // 是「缺数据渲染 null,不渲染零」——把 1 步的读数冒充 3 步的合计,正是它在防的那种假。
    expect(report?.rounds).toHaveLength(3);
    for (const [metric, reading] of Object.entries(readings)) {
      const total = report?.totals[metric as keyof typeof report.totals];
      expect(total).toMatchObject({
        recordedTotal: reading.value,
        recordedRounds: reading.value === null ? 0 : 1,
        expectedRounds: 3,
      });
      // 只有「三步都带读数」口径才给 value;这里只有一步,所以缺席。
      expect(total?.value).toBeNull();
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

it("messages 族：起跑前拒跑并点名「本族未声明工具能力」,一次模型调用都不发", async () => {
  const root = makeRoot();
  const config: ModelConfig = {
    slug: "alpha",
    endpointFamily: "messages",
    modelId: "fixture/model",
    baseUrl: "https://offline.invalid/v1",
    credentialEnvVar: "USAGE_REPORT_TEST_KEY",
    channelId: "usage-report-test-channel",
    contextLength: 100000,
    generationPolicy: {
      endpoint: { family: "messages", ...evidence },
      reasoning: {
        intent: "high",
        control: "unverified",
        ...evidence,
        channel: { status: "unverified", source: "offline-fixture/unverified-channel" },
      },
      output: { field: "max_tokens", maxTokens: 16384, includesReasoning: "yes", ...evidence },
      cache: { mode: "ephemeral-1h", ...evidence },
      transport: { authentication: "bearer" },
    },
  };
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ content: [], stop_reason: "end_turn", usage: null }), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("USAGE_REPORT_TEST_KEY", secret);
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  try {
    // ── 这条用例以「拒跑」为被测行为,不是以 usage 投影为被测行为 ──
    //
    // 2026-11-20 真请求探针:该席位在 `/messages` 上**带不带 `tools` 都是 HTTP 403
    // permission_error**(整套端点被渠道拒),所以「`tool_use` / `tool_result` 能不能配对」
    // 零证据;零证据就不写翻译(票 01 / ADR-0032)。于是 agent 会话在**起跑前**被拒,
    // 而不是花 20 分钟跑到 0 候选才发现。
    //
    // 它原先覆盖的三件事仍然各有自己的家,没有丢:
    // - 缓存断点进请求体 → `packages/gen/src/http/endpoints.test.ts`(messages 族 buildBody);
    // - 口径 `anthropic` 的投影 → `packages/gen/src/generation-policy.test.ts` 的 `projectUsage`;
    // - 报告侧 `缓存写 1h` 的渲染 → `packages/runner/src/archive-report.test.ts`。
    await expect(
      withRealBash(workspaceDir, () =>
        generateOneModel(
          {
            root,
            runId: "r1",
            agentPrompt: { user: "任务:写 script.ts", system: "协议:每一步一个动作块" },
            createClient: createHttpModelClient,
            workspaceDir,
            now: () => new Date(),
            trial: completeGridTrial(),
            trialPlan: () => gridPlanFixture(),
          },
          config,
        ),
      ),
    ).rejects.toThrow(/端点位 messages 未声明工具调用能力/);
    // 拒跑在第一次模型调用之前:一分钱没花,也没有落任何档。
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(root, "archive/alpha/r1/meta.json"))).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
