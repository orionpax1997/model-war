/**
 * 四端点族的**纯翻译**单测:不经网络,只喂 `buildBody` / `parseResponse` 输入,断言请求体形状与
 * 归一后的 `ModelResponse`。网络行为(鉴权头、状态码分类、超时)在 `client.test.ts` 用本地假端点覆盖。
 */

import { expect, it } from "vitest";
import type { ModelConfig } from "../config.js";
import { policyFixture } from "../generation-policy.fixture.js";
import type { ChatMessage } from "../model-client.js";
import { AGENT_TOOLS } from "../agent/tools.js";
import { endpointSpec } from "./endpoints.js";

const config = (family: ModelConfig["endpointFamily"]): ModelConfig => ({
  slug: "model-x",
  endpointFamily: family,
  baseUrl: "https://example.invalid/v1",
  modelId: "vendor/model-x",
  credentialEnvVar: "TEST_KEY",
  channelId: "test-channel",
});

/** Google 族的模型 id 直接进路径,用真实形状的 id 才能看见路径是不是拼对了。 */
const geminiConfig: ModelConfig = { ...config("generate-content"), modelId: "gemini-4-argon" };

it("四条端点族的路径各自钉死", () => {
  expect(endpointSpec("chat-completions").path(config("chat-completions"))).toBe(
    "/chat/completions",
  );
  expect(endpointSpec("messages").path(config("messages"))).toBe("/messages");
  expect(endpointSpec("responses").path(config("responses"))).toBe("/responses");
  // Google 把模型名写进路径,故路径是真源里的函数而不是常量串。
  expect(endpointSpec("generate-content").path(geminiConfig)).toBe(
    "/models/gemini-4-argon:generateContent",
  );
});

it("chat-completions 请求体:无工具声明时仍只有 model + messages + params 三个键(逐字)", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
  ];
  // 「不带工具声明的请求字节与今天完全一致」是票 01 的硬约束:一次性形态那条路一个字不动。
  // 所以这里驳的不仅是「多不多 tools」,而是整份请求体的键集合。
  expect(
    endpointSpec("chat-completions").buildBody(config("chat-completions"), messages, {
      temperature: 0.2,
    }),
  ).toEqual({
    model: "vendor/model-x",
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ],
    temperature: 0.2,
  });
  // 声明的缺省也是「没有」:空数组不等于「带上一个空 tools」。
  expect(
    endpointSpec("chat-completions").buildBody(
      config("chat-completions"),
      messages,
      {},
      {
        tools: [],
      },
    ),
  ).toEqual({ model: "vendor/model-x", messages });
});

it("chat-completions 请求体:有工具声明时多 tools 与 tool_choice,且 params 压不过声明", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "u" }];
  const body = endpointSpec("chat-completions").buildBody(
    config("chat-completions"),
    messages,
    // 生成策略的产出面完全可能恰好带同名键(这里是故意的反例):它**压不动**协议。
    { temperature: 0.2, tools: [], tool_choice: "none" },
    { tools: AGENT_TOOLS },
  );
  expect(body.tool_choice).toBe("auto");
  const tools = body.tools as readonly { type: string; function: Record<string, unknown> }[];
  expect(tools).toHaveLength(5);
  expect(tools.map((tool) => tool.function.name)).toEqual([
    "bash",
    "check",
    "probe",
    "evaluate",
    "finish",
  ]);
  for (const tool of tools) expect(tool.type).toBe("function");
  // 声明逐字进请求体的 `function`(名字 / 描述 / 参数 Schema 都不重写)。
  expect(tools[0]?.function).toEqual({
    name: AGENT_TOOLS[0].name,
    description: AGENT_TOOLS[0].description,
    parameters: AGENT_TOOLS[0].parameters,
  });
  expect(body.temperature).toBe(0.2);
  expect(body.model).toBe("vendor/model-x");
});

it("chat-completions 响应:取 choices[0].message.content / finish_reason / usage", () => {
  const response = endpointSpec("chat-completions").parseResponse({
    choices: [{ message: { content: "脚本正文" }, finish_reason: "length" }],
    usage: { total_tokens: 11 },
  });
  expect(response).toMatchObject({
    text: "脚本正文",
    finishReason: "length",
    usage: { total_tokens: 11 },
  });
});

it("chat-completions 缺停止字段时保持未知，不伪造 stop", () => {
  expect(endpointSpec("chat-completions").parseResponse({})).toMatchObject({
    text: "",
    finishReason: "unknown",
    usage: undefined,
  });
  expect(endpointSpec("chat-completions").parseResponse("not an object")).toMatchObject({
    text: "",
    finishReason: "unknown",
    usage: undefined,
  });
});

/**
 * 一次**真**工具调用响应的形状(`xiaomi/mimo-v2.6-flash` 与 `tencent/hy4-flash` 的实测读音,
 * 只留断言要用的键)。
 *
 * ── 这条夹具是 inkling 那场的死因 ──
 *
 * `archive/inkling-2-small/failed-2026-11-19T10-54-29-233Z.json` 里 `steps[0..2].raw === ""`、
 * `finishReason: "tool_calls"`、`completion_tokens: 55`、`termination: "action-parse"`、0 候选。
 * 模型**不是没说话**,它说的话全在 `tool_calls` 里,而旧解析器只读 `content`——于是「55 个 token
 * 的产物」在档案里是一条 0 字节的步。改完之后它必须是活的:`text: ""` 但 `toolCalls` 在场。
 *
 * 两个键同时可给:实测 `hy4-flash` 在 `finish_reason: "tool_calls"` 时 `content` 是一段短文本
 * (78 字符),`mimo-v2.6-flash` 那边是 `null`。两种形状都要能读。
 */
const TOOL_CALL_RESPONSE = {
  choices: [
    {
      finish_reason: "tool_calls",
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1b5d910870c9444ca6fea2d4",
            type: "function",
            function: {
              name: "bash",
              arguments: '{"command": "ls -la /contract; echo ---; wc -l /contract/*.md"}',
            },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 1360, completion_tokens: 55, total_tokens: 1415 },
};

it("chat-completions 响应:`content: null` + `finish_reason: tool_calls` → text 空串 + toolCalls 在场", () => {
  const response = endpointSpec("chat-completions").parseResponse(TOOL_CALL_RESPONSE);
  expect(response).toEqual({
    text: "",
    toolCalls: [
      {
        name: "bash",
        argumentsJson: '{"command": "ls -la /contract; echo ---; wc -l /contract/*.md"}',
      },
    ],
    finishReason: "tool_calls",
    usage: { prompt_tokens: 1360, completion_tokens: 55, total_tokens: 1415 },
    stopDetails: { reason: "tool_calls" },
  });
});

it("chat-completions 响应:同时说话与调用时两个键各盖一件事,`arguments` 逐字不重编码", () => {
  // 渠道给的原始字节里带它自己的空格与转义写法;`JSON.parse` 再 `JSON.stringify` 会改掉它,
  // 而下一轮发回历史用的就是这串字节(ADR-0031「与发回去的字节同源」)。
  const argumentsJson = '{ "command" : "printf \\u003cb\\u003e" }';
  const response = endpointSpec("chat-completions").parseResponse({
    ...TOOL_CALL_RESPONSE,
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "我先看一下契约。",
          tool_calls: [
            {
              id: "chatcmpl-tool-97e8f97317c35d2e",
              function: { name: "bash", arguments: argumentsJson },
            },
            // 缺 `function.name` 的那一格丢掉:说不出调了什么,不是一个可判定的动作。
            { id: "x", function: { arguments: "{}" } },
          ],
        },
      },
    ],
  });
  expect(response.text).toBe("我先看一下契约。");
  expect(response.toolCalls).toEqual([{ name: "bash", argumentsJson }]);
});

it("chat-completions 响应:零次调用时不挂 `toolCalls` 空壳", () => {
  const response = endpointSpec("chat-completions").parseResponse({
    choices: [{ message: { content: "只说不动" }, finish_reason: "stop" }],
  });
  expect("toolCalls" in response).toBe(false);
  // 显式空数组则归一成缺席:两种写法是同一个事实,不该在读侧长得不一样。
  expect(
    "toolCalls" in
      endpointSpec("chat-completions").parseResponse({
        choices: [{ message: { content: "", tool_calls: [] } }],
      }),
  ).toBe(false);
});

it("chat-completions 请求消息:assistant 的 `tool_calls` 与 tool 角色的 `tool_call_id` 按角色分支写", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "读契约" },
    {
      role: "assistant",
      content: "",
      // 配对基准 id:两处(assistant 的 `tool_calls[i].id` 与 tool 的 `tool_call_id`)都由它派生。
      toolCallId: "call-1",
      toolCalls: [{ name: "bash", argumentsJson: '{"command": "cat /contract/README.md"}' }],
    },
    { role: "tool", toolCallId: "call-1", content: "exit code: 0" },
  ];
  const body = endpointSpec("chat-completions").buildBody(
    config("chat-completions"),
    messages,
    {},
    { tools: AGENT_TOOLS },
  );
  expect(body.messages).toEqual([
    { role: "user", content: "读契约" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          // `id` 是**必填**:缺它渠道回 400 `messages.N.tool_calls.0.id expected string`
          // (2026-11-20 真请求探针)。值是我们自己确定性派生的,不是渠道给的。
          id: "call-1",
          type: "function",
          function: { name: "bash", arguments: '{"command": "cat /contract/README.md"}' },
        },
      ],
    },
    { role: "tool", content: "exit code: 0", tool_call_id: "call-1" },
  ]);
});

it("chat-completions 请求消息:同一轮多条调用各有 id,首条就是配对基准", () => {
  // 一步只执行一次调用(票 02 的判据),但历史里可能出现一轮多条(那一步被拒、照样回喂)。
  // 每条都必须有 `id`——两条共用一个 id 会让工具消息的归属不可读。
  const body = endpointSpec("chat-completions").buildBody(
    config("chat-completions"),
    [
      {
        role: "assistant",
        content: "",
        toolCallId: "call-7",
        toolCalls: [
          { name: "bash", argumentsJson: "{}" },
          { name: "bash", argumentsJson: "{}" },
        ],
      },
    ],
    {},
  );
  const calls = (body.messages as { tool_calls: { id: string }[] }[])[0]?.tool_calls;
  expect(calls?.map((call) => call.id)).toEqual(["call-7", "call-7-1"]);
});

it("chat-completions 请求消息:缺 `toolCallId` 时也写 id(漏掉这个键就是上游 400)", () => {
  const body = endpointSpec("chat-completions").buildBody(
    config("chat-completions"),
    [{ role: "assistant", content: "", toolCalls: [{ name: "bash", argumentsJson: "{}" }] }],
    {},
  );
  const calls = (body.messages as { tool_calls: { id?: string }[] }[])[0]?.tool_calls;
  expect(calls?.[0]?.id).toBe("call-0");
});

it("messages / responses / generate-content 族不声明工具能力:用它们的席位在会话起跑前拒跑", () => {
  // 可选 = 不支持。`messages` 族的协议事实已经拿到(`probes/messages-tool-roundtrip/`),
  // 但翻译还没写;`responses` / `generate-content` 连协议事实都还在别处。声明了才是
  // 「这条翻译被真实会话验证过」。
  expect(endpointSpec("chat-completions").tools).toEqual({ shape: "function-json-schema" });
  expect(endpointSpec("messages").tools).toBeUndefined();
  expect(endpointSpec("responses").tools).toBeUndefined();
  expect(endpointSpec("generate-content").tools).toBeUndefined();
});

it.each(["messages", "responses", "generate-content"] as const)(
  "%s 族遇到 `tool` 角色观测消息时当场抬错,不发一个上游认不出的 body",
  (family) => {
    // 这道防线是「上层忘了起跑前拒跑」的最后一层:一个能发出去但意思错了的 body,在报告里
    // 与「模型写错了」同形。三条族各自的形状不同,但同一条判据。
    expect(() =>
      endpointSpec(family).buildBody(
        config(family),
        [{ role: "tool", toolCallId: "call-1", content: "x" }],
        {},
      ),
    ).toThrow(/不支持工具调用/);
  },
);

it("messages 请求体:system 抽到顶层,不进 messages;max_tokens 缺省由工程常量兜底", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "第一条系统提示" },
    { role: "system", content: "第二条系统提示" },
    { role: "user", content: "u" },
  ];
  const body = endpointSpec("messages").buildBody(config("messages"), messages, {
    temperature: 0.4,
  });
  expect(body).toEqual({
    model: "vendor/model-x",
    max_tokens: 8192,
    temperature: 0.4,
    messages: [{ role: "user", content: "u" }],
    system: "第一条系统提示\n\n第二条系统提示",
  });
});

it("messages 请求体:params 里的 max_tokens 覆盖缺省;无 system 时不挂 system 键", () => {
  const body = endpointSpec("messages").buildBody(
    config("messages"),
    [{ role: "user", content: "u" }],
    {
      max_tokens: 512,
    },
  );
  expect(body.max_tokens).toBe(512);
  expect("system" in body).toBe(false);
});

/**
 * 缓存断点的配置面：只给 messages 族写这一段，其余族不写（缺省即不干预）。
 * 这里用 fixture 证据声明，不冒充生产模型的渠道证据。
 */
const cachedConfig = (
  family: ModelConfig["endpointFamily"],
  mode: "none" | "ephemeral" | "ephemeral-1h",
): ModelConfig => ({
  ...config(family),
  generationPolicy: {
    ...policyFixture(family),
    cache: {
      mode,
      official: { status: "documented", source: "offline-fixture/cache-official" },
      channel: { status: "accepted", source: "offline-fixture/cache-channel" },
    },
  },
});

it("messages 缓存断点:system 与最后一条 user 消息的最后一个块打 cache_control(1h)", () => {
  const body = endpointSpec("messages").buildBody(
    cachedConfig("messages", "ephemeral-1h"),
    [
      { role: "system", content: "契约前缀" },
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "第一版脚本" },
      { role: "user", content: "第二轮" },
    ],
    { max_tokens: 512 },
  );
  const control = { type: "ephemeral", ttl: "1h" };
  expect(body.system).toEqual([{ type: "text", text: "契约前缀", cache_control: control }]);
  // 断点在前缀末尾：中间消息保持字符串载荷，只有最后一条消息的最后一个块挂标记。
  expect(body.messages).toEqual([
    { role: "user", content: "第一轮" },
    { role: "assistant", content: "第一版脚本" },
    { role: "user", content: [{ type: "text", text: "第二轮", cache_control: control }] },
  ]);
});

it("messages 缓存断点:ephemeral 不带 ttl;mode none、未配置、非 messages 族都保持字符串载荷", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
  ];
  const ephemeral = endpointSpec("messages").buildBody(
    cachedConfig("messages", "ephemeral"),
    messages,
    {},
  );
  expect(ephemeral.system).toEqual([
    { type: "text", text: "s", cache_control: { type: "ephemeral" } },
  ]);
  expect(ephemeral.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "u", cache_control: { type: "ephemeral" } }] },
  ]);
  for (const candidate of [
    endpointSpec("messages").buildBody(cachedConfig("messages", "none"), messages, {}),
    endpointSpec("messages").buildBody(config("messages"), messages, {}),
  ]) {
    expect(candidate.system).toBe("s");
    expect(candidate.messages).toEqual([{ role: "user", content: "u" }]);
  }
  // chat 族的服务端默认缓存已经生效，加任何缓存参数都是多余干预。
  expect(
    endpointSpec("chat-completions").buildBody(
      cachedConfig("chat-completions", "ephemeral-1h"),
      messages,
      {},
    ),
  ).toEqual({
    model: "vendor/model-x",
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ],
  });
});

it("messages 流式请求体同样带缓存断点，stream 不覆盖断点", () => {
  const body = requireStreaming("messages").buildBody(
    cachedConfig("messages", "ephemeral-1h"),
    [{ role: "user", content: "u" }],
    { max_tokens: 512 },
  );
  expect(body).toEqual({
    model: "vendor/model-x",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "u", cache_control: { type: "ephemeral", ttl: "1h" } }],
      },
    ],
    stream: true,
  });
});

it("messages 响应:content 里只拼 type=text 的块;stop_reason 归一", () => {
  const spec = endpointSpec("messages");
  const response = spec.parseResponse({
    content: [
      { type: "text", text: "ab" },
      { type: "thinking", thinking: "忽略我" },
      { type: "text", text: "cd" },
    ],
    stop_reason: "max_tokens",
    usage: { output_tokens: 9 },
  });
  expect(response).toMatchObject({
    text: "abcd",
    finishReason: "length",
    usage: { output_tokens: 9 },
  });
});

it("messages 响应:end_turn → stop,stop_sequence → stop,未知原因透传,缺 stop_reason → unknown", () => {
  const spec = endpointSpec("messages");
  const reason = (stopReason: string | undefined): string =>
    spec.parseResponse(stopReason === undefined ? {} : { stop_reason: stopReason }).finishReason;
  expect(reason("end_turn")).toBe("stop");
  expect(reason("stop_sequence")).toBe("stop");
  expect(reason("pause_turn")).toBe("pause_turn");
  expect(reason(undefined)).toBe("unknown");
});

it("responses 请求体:model + input(含 system);params 透传", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
  ];
  expect(
    endpointSpec("responses").buildBody(config("responses"), messages, { temperature: 0.1 }),
  ).toEqual({
    model: "vendor/model-x",
    temperature: 0.1,
    input: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ],
  });
});

it("responses 响应:拼 output 里 message 的 output_text;completed → stop;incomplete → length", () => {
  const spec = endpointSpec("responses");
  const output = [
    { type: "reasoning", summary: [] },
    {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "part1" },
        { type: "output_text", text: "part2" },
      ],
    },
  ];
  expect(
    spec.parseResponse({ status: "completed", output, usage: { total_tokens: 3 } }),
  ).toMatchObject({
    text: "part1part2",
    finishReason: "stop",
    usage: { total_tokens: 3 },
  });
  expect(
    spec.parseResponse({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output,
    }).finishReason,
  ).toBe("length");
  expect(
    spec.parseResponse({ incomplete_details: { reason: "max_output_tokens" }, output })
      .finishReason,
  ).toBe("length");
});

// ── 流式能力:chat-completions 与 messages 声明;responses 缺省即非流式 ─────────────

// 声明了流式能力的族缺一个,直接抛比把 `undefined` 当成功更能指出问题。
const requireStreaming = (family: ModelConfig["endpointFamily"]) => {
  const streaming = endpointSpec(family).streaming;
  if (streaming === undefined) {
    throw new Error(`${family} 没有声明流式能力`);
  }
  return streaming;
};

it("流式能力是可选字段:chat-completions / messages / generate-content 声明,responses 缺省即非流式", () => {
  expect(endpointSpec("chat-completions").streaming).toBeDefined();
  expect(endpointSpec("messages").streaming).toBeDefined();
  expect(endpointSpec("generate-content").streaming).toBeDefined();
  expect(endpointSpec("responses").streaming).toBeUndefined();
});

it("generate-content 流式路径换动词并带 alt=sse;非流式路径不带", () => {
  const streaming = requireStreaming("generate-content");
  expect(streaming.path?.(geminiConfig)).toBe(
    "/models/gemini-4-argon:streamGenerateContent?alt=sse",
  );
  // 无哨兵:上游最后一条数据帧后直接关连接。
  expect(streaming.endsOnStreamClose).toBe(true);
});

it("chat-completions 流式请求体 = 非流式体 + stream:true + include_usage;params 同名键压不过本层", () => {
  const body = requireStreaming("chat-completions").buildBody(
    config("chat-completions"),
    [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ],
    { temperature: 0.2, stream: false, stream_options: { include_usage: false } },
  );
  expect(body).toEqual({
    model: "vendor/model-x",
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ],
    temperature: 0.2,
    stream: true,
    stream_options: { include_usage: true },
  });
});

it("chat-completions 流累积器:只拼 delta.content,忽略 reasoning_content", () => {
  const accumulator = requireStreaming("chat-completions").createAccumulator();
  accumulator.push({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  accumulator.push({ choices: [{ delta: { reasoning_content: "The" }, finish_reason: null }] });
  accumulator.push({ choices: [{ delta: { reasoning_content: " answer is" } }] });
  accumulator.push({ choices: [{ delta: { content: "脚本" }, finish_reason: null }] });
  accumulator.push({ choices: [{ delta: { content: "正文" }, finish_reason: null }] });
  accumulator.push({ choices: [{ delta: {}, finish_reason: "stop" }] });

  expect(accumulator.result()).toMatchObject({
    text: "脚本正文",
    finishReason: "stop",
    usage: undefined,
  });
});

it("chat-completions 流累积器:`delta.tool_calls` 按 index 拼分片,结果与非流式逐字相等", () => {
  // 一次真工具调用切成 3 帧:首帧只带 `name`(`arguments` 是空串),中帧把 `arguments` 分两片。
  // 这是上游的**真形状**——SSE 是一串增量,不是一整份 JSON。
  const argumentsJson = '{"command": "ls -la /contract; echo ---; wc -l /contract/*.md"}';
  const accumulator = requireStreaming("chat-completions").createAccumulator();
  accumulator.push({
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_1b5d910870c9444ca6fea2d4",
              type: "function",
              function: { name: "bash", arguments: "" },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  accumulator.push({
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: argumentsJson.slice(0, 20) } }] },
        finish_reason: null,
      },
    ],
  });
  accumulator.push({
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: argumentsJson.slice(20) } }] },
        finish_reason: null,
      },
    ],
  });
  accumulator.push({
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 1360, completion_tokens: 55 },
  });

  const streamed = accumulator.result();
  // 两边比的是**整份统一形状**:走不走流式不能得到两个 `argumentsJson`——那串字节要原样
  // 发回下一轮,而「发回去的 == 落盘的」不允许两个读法各造一份。
  expect(streamed).toEqual(
    endpointSpec("chat-completions").parseResponse({
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1b5d910870c9444ca6fea2d4",
                type: "function",
                function: { name: "bash", arguments: argumentsJson },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1360, completion_tokens: 55 },
    }),
  );
  expect(streamed.toolCalls).toEqual([{ name: "bash", argumentsJson }]);
  expect(streamed.text).toBe("");
});

it("chat-completions 流累积器:多个调用按 index 归位,不因交错抵达而串成一串", () => {
  // 实测 `mimo-v2.6-flash` 一次回两条调用。分片交错时若按「推一个到末尾」聚合,
  // 第二个调用的参数会被接到第一个后面,而那是一个**看起来像模型写坏了 JSON** 的假象。
  const accumulator = requireStreaming("chat-completions").createAccumulator();
  accumulator.push({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, function: { name: "bash", arguments: '{"command": "' } },
            { index: 1, function: { name: "check", arguments: "{" } },
          ],
        },
      },
    ],
  });
  accumulator.push({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 1, function: { arguments: "}" } },
            { index: 0, function: { arguments: 'ls"}' } },
          ],
        },
      },
    ],
  });
  expect(accumulator.result().toolCalls).toEqual([
    { name: "bash", argumentsJson: '{"command": "ls"}' },
    { name: "check", argumentsJson: "{}" },
  ]);
});

it("chat-completions 流累积器:usage 取最后一个非空帧,`usage:null` 中途帧不清掉它", () => {
  const accumulator = requireStreaming("chat-completions").createAccumulator();
  accumulator.push({ choices: [{ delta: { content: "x" }, finish_reason: null }] });
  accumulator.push({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  accumulator.push({ choices: [], usage: null });
  accumulator.push({
    choices: [],
    usage: {
      prompt_tokens: 17800,
      completion_tokens: 900,
      completion_tokens_details: { reasoning_tokens: 640 },
    },
  });

  expect(accumulator.result()).toMatchObject({
    text: "x",
    finishReason: "unknown",
    usage: {
      prompt_tokens: 17800,
      completion_tokens: 900,
      completion_tokens_details: { reasoning_tokens: 640 },
    },
  });
});

it("chat-completions 流累积器:finish_reason 取最后一个非空值(截断的 length),非终点帧的 null 不算", () => {
  const accumulator = requireStreaming("chat-completions").createAccumulator();
  accumulator.push({ choices: [{ delta: { content: "半截" }, finish_reason: null }] });
  accumulator.push({ choices: [{ delta: {}, finish_reason: "length" }] });
  expect(accumulator.result()).toMatchObject({
    text: "半截",
    finishReason: "length",
    usage: undefined,
  });
});

it("messages 流式请求体 = 非流式体 + stream:true;params 同名键压不过本层", () => {
  const body = requireStreaming("messages").buildBody(
    config("messages"),
    [{ role: "user", content: "u" }],
    { max_tokens: 512, stream: false },
  );
  expect(body).toEqual({
    model: "vendor/model-x",
    max_tokens: 512,
    messages: [{ role: "user", content: "u" }],
    stream: true,
  });
});

it("messages 流累积器:只拼 text_delta,thinking_delta/签名不进正文;message_stop 收尾", () => {
  const accumulator = requireStreaming("messages").createAccumulator();
  expect(accumulator.done?.()).toBe(false);
  accumulator.push({ type: "message_start", message: { usage: { input_tokens: 32 } } });
  accumulator.push({ type: "content_block_start", index: 0, content_block: { type: "text" } });
  accumulator.push({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "先想" },
  });
  accumulator.push({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "脚本" },
  });
  accumulator.push({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "正文" },
  });
  accumulator.push({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 2 },
  });
  expect(accumulator.done?.()).toBe(false);
  accumulator.push({ type: "message_stop" });
  expect(accumulator.done?.()).toBe(true);
  expect(accumulator.result()).toMatchObject({
    text: "脚本正文",
    finishReason: "stop",
    usage: { input_tokens: 32, output_tokens: 2 },
    stopDetails: { reason: "end_turn" },
  });
});

it("messages 流累积器:max_tokens → length;空累积器与非流式缺字段同一缺省", () => {
  const accumulator = requireStreaming("messages").createAccumulator();
  accumulator.push({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: {} });
  accumulator.push({ type: "message_stop" });
  expect(accumulator.result()).toMatchObject({ text: "", finishReason: "length" });
  expect(requireStreaming("messages").createAccumulator().result()).toMatchObject({
    text: "",
    finishReason: "unknown",
    usage: undefined,
  });
});

it("chat-completions 流累积器:一帧都没喂 / 空帧 → 与非流式缺字段时同一缺省", () => {
  expect(requireStreaming("chat-completions").createAccumulator().result()).toMatchObject({
    text: "",
    finishReason: "unknown",
    usage: undefined,
  });
  const accumulator = requireStreaming("chat-completions").createAccumulator();
  accumulator.push({ choices: [{ delta: {}, finish_reason: "" }] });
  accumulator.push("not an object");
  expect(accumulator.result()).toMatchObject({
    text: "",
    finishReason: "unknown",
    usage: undefined,
  });
});

// ── generate-content(Google Gemini 系)──────────────────────────────

it("generate-content 请求体:system 抽到 systemInstruction,assistant 换名 model,参数进 generationConfig", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "第一条系统提示" },
    { role: "system", content: "第二条系统提示" },
    { role: "user", content: "契约" },
    { role: "assistant", content: "上一轮回复" },
    { role: "user", content: "诊断反馈" },
  ];
  expect(
    endpointSpec("generate-content").buildBody(geminiConfig, messages, {
      temperature: 0.5,
      max_output_tokens: 4096,
    }),
  ).toEqual({
    systemInstruction: { parts: [{ text: "第一条系统提示\n\n第二条系统提示" }] },
    contents: [
      { role: "user", parts: [{ text: "契约" }] },
      { role: "model", parts: [{ text: "上一轮回复" }] },
      { role: "user", parts: [{ text: "诊断反馈" }] },
    ],
    generationConfig: { temperature: 0.5, maxOutputTokens: 4096 },
  });
});

it("generate-content 请求体:无 system / 无参数时不挂空壳;同角色连续轮次合并成多段", () => {
  const body = endpointSpec("generate-content").buildBody(
    geminiConfig,
    [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ],
    {},
  );
  expect(body).toEqual({ contents: [{ role: "user", parts: [{ text: "a" }, { text: "b" }] }] });
  expect("systemInstruction" in body).toBe(false);
  expect("generationConfig" in body).toBe(false);
});

it("generate-content 响应:拼 parts 正文、跳过 thought 段;MAX_TOKENS 归一 length;usageMetadata 原样保留", () => {
  const response = endpointSpec("generate-content").parseResponse({
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: "先想", thought: true }, { text: "脚本" }, { text: "正文" }],
        },
        finishReason: "MAX_TOKENS",
      },
    ],
    usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 900, thoughtsTokenCount: 640 },
  });
  expect(response).toEqual({
    text: "脚本正文",
    finishReason: "length",
    usage: { promptTokenCount: 17, candidatesTokenCount: 900, thoughtsTokenCount: 640 },
    stopDetails: { reason: "MAX_TOKENS" },
  });
});

it.each([
  [{ candidates: [{ finishReason: "STOP" }] }, "stop", { reason: "STOP" }],
  [{ candidates: [{ finishReason: "SAFETY" }] }, "content_filter", { reason: "SAFETY" }],
  // 整段被拒时没有候选,只能读 promptFeedback.blockReason。
  [
    { promptFeedback: { blockReason: "PROHIBITED_CONTENT" } },
    "content_filter",
    { reason: "PROHIBITED_CONTENT" },
  ],
  [{ candidates: [{ finishReason: "OTHER" }] }, "OTHER", { reason: "OTHER" }],
  [{}, "unknown", {}],
] as const)("generate-content 停止原因归一并保留原值：%j", (body, finishReason, stopDetails) => {
  expect(endpointSpec("generate-content").parseResponse(body)).toMatchObject({
    text: "",
    finishReason,
    stopDetails,
    usage: undefined,
  });
});

it("generate-content 流累积器:无收尾哨兵,正文/停止原因/usage 与非流式同形", () => {
  const streaming = requireStreaming("generate-content");
  const accumulator = streaming.createAccumulator();
  expect(accumulator.done).toBeUndefined();
  accumulator.push({
    candidates: [{ content: { role: "model", parts: [{ text: "先想", thought: true }] } }],
  });
  accumulator.push({ candidates: [{ content: { parts: [{ text: "脚本" }] } }] });
  accumulator.push({
    candidates: [{ content: { parts: [{ text: "正文" }] } }],
    usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 2 },
  });
  // 收尾帧可能不带正文,停止原因与全量 usage 都在它身上。
  accumulator.push({
    candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 900, thoughtsTokenCount: 640 },
  });
  expect(accumulator.result()).toEqual({
    text: "脚本正文",
    finishReason: "stop",
    usage: { promptTokenCount: 17, candidatesTokenCount: 900, thoughtsTokenCount: 640 },
    stopDetails: { reason: "STOP" },
  });
  expect(streaming.createAccumulator().result()).toMatchObject({
    text: "",
    finishReason: "unknown",
    usage: undefined,
  });
});

it.each([
  [
    "chat-completions",
    { choices: [{ finish_reason: "content_filter" }] },
    "content_filter",
    { reason: "content_filter" },
  ],
  ["messages", { stop_reason: "max_tokens" }, "length", { reason: "max_tokens" }],
  ["messages", { stop_reason: "refusal" }, "refusal", { reason: "refusal" }],
  [
    "responses",
    { status: "incomplete", incomplete_details: { reason: "content_filter" } },
    "incomplete",
    { status: "incomplete", reason: "content_filter" },
  ],
  ["responses", { status: "failed" }, "failed", { status: "failed" }],
  ["responses", {}, "unknown", {}],
] as const)("停止证据保持原协议值：%s %j", (family, body, finishReason, stopDetails) => {
  expect(endpointSpec(family).parseResponse(body)).toMatchObject({
    finishReason,
    stopDetails,
    usage: undefined,
  });
});
