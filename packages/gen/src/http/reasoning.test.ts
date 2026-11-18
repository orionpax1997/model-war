/**
 * 推理回传的**往返**单测:响应 → 历史 → 请求体(ADR-0032「reasoning 按端点族分家」)。
 *
 * ── 为什么三条用例都写成「往返」而不是三条「解析」加三条「拼装」 ──
 *
 * 这条通道的性质是「原样带回来」:只测解析会说「读出来对吗」,只测拼装会说「摆的位置对吗」,
 * 而真正会坏的是中间那一段——读出来的形状写不回去、或者写回去了但少了签名。往返把三站
 * (端点 → `ChatMessage` → 请求体)串成一条断言,中间任何一站改写字节都会红。
 *
 * 历史那一站刻意**手写**:`agent/history.ts` 的同一条形状由它自己的单测钉,这里只借用
 * `{role:"assistant", content, reasoning}` 这个形状——两处都复用它会让「历史构造改错了」
 * 与「回传通道坏了」在同一个红里分不开。
 */

import { expect, it } from "vitest";
import type { ModelConfig } from "../config.js";
import type { ChatMessage, ReasoningEcho } from "../model-client.js";
import { endpointSpec } from "./endpoints.js";
import { chatReasoningStream, messagesReasoningStream } from "./reasoning.js";

const config = (family: ModelConfig["endpointFamily"]): ModelConfig => ({
  slug: "model-x",
  endpointFamily: family,
  baseUrl: "https://example.invalid/v1",
  modelId: "vendor/model-x",
  credentialEnvVar: "TEST_KEY",
  channelId: "test-channel",
});

/** 历史的三段头:system + 首条 user + 一步的 assistant 原文。观测(user)在后面补。 */
const historyWith = (raw: string, reasoning: ReasoningEcho | undefined): ChatMessage[] => [
  { role: "system", content: "协议" },
  { role: "user", content: "任务" },
  {
    role: "assistant",
    content: raw,
    ...(reasoning === undefined ? {} : { reasoning }),
  },
];

const ENCRYPTED_ENTRY = {
  type: "reasoning.encrypted",
  data: "gwst1.only-the-server-can-read-this",
  format: "stealth-v1",
};

it("messages 族:签名块连签名原样送回,正文仍是不改写的那一段", () => {
  const response = endpointSpec("messages").parseResponse({
    content: [
      { type: "thinking", thinking: "先读契约再改脚本", signature: "sig-abc" },
      { type: "text", text: "```bash\nls /contract\n```" },
    ],
    stop_reason: "end_turn",
  });
  expect(response.reasoning).toEqual({
    carry: "signed",
    blocks: [{ type: "thinking", thinking: "先读契约再改脚本", signature: "sig-abc" }],
    dropped: 0,
  });
  expect(response.text).toBe("```bash\nls /contract\n```");

  const body = endpointSpec("messages").buildBody(
    config("messages"),
    historyWith(response.text, response.reasoning),
    {},
  );
  const dialog = body.messages as Record<string, unknown>[];
  expect(dialog).toHaveLength(2);
  // 签名与正文都回来了。
  expect(dialog[1]).toEqual({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "先读契约再改脚本", signature: "sig-abc" },
      { type: "text", text: "```bash\nls /contract\n```" },
    ],
  });
});

it("messages 族:缺签名的 thinking 块被丢掉并记一条标记,送回时不带它", () => {
  const response = endpointSpec("messages").parseResponse({
    content: [
      { type: "thinking", thinking: "这段没有签名" },
      { type: "text", text: "正文" },
    ],
    stop_reason: "end_turn",
  });
  expect(response.reasoning).toEqual({ carry: "signed", blocks: [], dropped: 1 });

  const body = endpointSpec("messages").buildBody(
    config("messages"),
    historyWith(response.text, response.reasoning),
    {},
  );
  const dialog = body.messages as Record<string, unknown>[];
  // 没有签名就整块不带:只带正文时不留块数组空壳。
  expect(dialog[1]).toEqual({ role: "assistant", content: "正文" });
});

it("chat 族:普通推理内容被丢,加密条目原样回传", () => {
  const response = endpointSpec("chat-completions").parseResponse({
    choices: [
      {
        message: {
          content: "```bash\ncat /contract/README.md\n```",
          reasoning_content: "半截思维链(明文,丢弃)",
          reasoning_details: [ENCRYPTED_ENTRY, { type: "reasoning.text", text: "半截思维链" }],
        },
        finish_reason: "stop",
      },
    ],
  });
  expect(response.reasoning).toEqual({
    carry: "encrypted",
    blocks: [ENCRYPTED_ENTRY],
    dropped: 1,
  });
  // 明文推理既不进正文也不进回传。
  expect(response.text).toBe("```bash\ncat /contract/README.md\n```");

  const body = endpointSpec("chat-completions").buildBody(
    config("chat-completions"),
    historyWith(response.text, response.reasoning),
    {},
  );
  const messages = body.messages as Record<string, unknown>[];
  // chat 族的 system 就住在 `messages` 里,所以 assistant 是第三条。
  expect(messages[2]).toEqual({
    role: "assistant",
    content: "```bash\ncat /contract/README.md\n```",
    reasoning_details: [ENCRYPTED_ENTRY],
  });
  // 普通推理内容一个字节都没进请求体。
  expect(JSON.stringify(body)).not.toContain("半截思维链");
});

it("responses 族:加密推理条目原样送回,排在它自己那条消息之前", () => {
  const item = {
    type: "reasoning",
    id: "rs_01",
    encrypted_content: "gAAAA-only-the-server-can-read-this",
    summary: [{ type: "summary_text", text: "读了契约" }],
  };
  const response = endpointSpec("responses").parseResponse({
    status: "completed",
    output: [item, { type: "message", content: [{ type: "output_text", text: "正文" }] }],
  });
  expect(response.reasoning).toEqual({ carry: "encrypted", blocks: [item], dropped: 0 });

  const body = endpointSpec("responses").buildBody(
    config("responses"),
    historyWith(response.text, response.reasoning),
    {},
  );
  expect(body.input).toEqual([
    { role: "system", content: "协议" },
    { role: "user", content: "任务" },
    item,
    { role: "assistant", content: "正文" },
  ]);
});

it("四条端点族的能力声明各自钉死", () => {
  expect(endpointSpec("messages").reasoning.carry).toBe("signed");
  expect(endpointSpec("chat-completions").reasoning.carry).toBe("encrypted");
  expect(endpointSpec("responses").reasoning.carry).toBe("encrypted");
  // ADR-0032 只裁了三族:google 的思考段没有签名也没有加密块,显式声明为丢弃。
  expect(endpointSpec("generate-content").reasoning.carry).toBe("drop");
  expect(
    endpointSpec("generate-content").reasoning.read({
      candidates: [{ content: { parts: [{ thought: true, text: "思维链" }] } }],
    }),
  ).toBeUndefined();
});

it("跨族复用推理回传当场响,而不是变成一次静默 400", () => {
  // 一份 messages 族的签名块被塞进 chat 族的消息里。
  const signed: ReasoningEcho = {
    carry: "signed",
    blocks: [{ type: "thinking", thinking: "x", signature: "sig" }],
    dropped: 0,
  };
  expect(() =>
    endpointSpec("chat-completions").buildBody(
      config("chat-completions"),
      historyWith("正文", signed),
      {},
    ),
  ).toThrow(/chat-completions:推理条目的策略是 signed/);
});

it("chat 流的累积器:加密条目按 id 去重,普通推理条目丢弃", () => {
  const stream = chatReasoningStream("encrypted");
  stream.push({ reasoning_content: "明文增量" });
  stream.push({ reasoning_details: [ENCRYPTED_ENTRY] });
  stream.push({ reasoning_details: [{ ...ENCRYPTED_ENTRY, id: "dup-1" }] });
  stream.push({ reasoning_details: [{ ...ENCRYPTED_ENTRY, id: "dup-1" }] });
  stream.push({ reasoning_details: [{ type: "reasoning.text", text: "明文" }] });
  expect(stream.result()).toEqual({
    carry: "encrypted",
    blocks: [ENCRYPTED_ENTRY, { ...ENCRYPTED_ENTRY, id: "dup-1" }],
    dropped: 1,
  });
});

it("messages 流的累积器:thinking 增量拼回块,签名单独到也能拼上", () => {
  const stream = messagesReasoningStream("signed");
  stream.pushStart({ type: "thinking" });
  stream.pushDelta({ type: "thinking_delta", thinking: "先看契约" });
  stream.pushDelta({ type: "thinking_delta", thinking: ",再改脚本" });
  stream.pushDelta({ type: "signature_delta", signature: "sig-stream" });
  expect(stream.result()).toEqual({
    carry: "signed",
    blocks: [{ type: "thinking", thinking: "先看契约,再改脚本", signature: "sig-stream" }],
    dropped: 0,
  });
});

it("响应侧的累积器把推理带上 `ModelResponse`,不改写正文", () => {
  const accumulator = endpointSpec("chat-completions").streaming?.createAccumulator();
  expect(accumulator).toBeDefined();
  accumulator?.push({
    choices: [
      {
        delta: {
          content: "```bash\n",
          reasoning_details: [ENCRYPTED_ENTRY],
        },
      },
    ],
  });
  accumulator?.push({ choices: [{ delta: { content: "ls\n```" }, finish_reason: "stop" }] });
  const result = accumulator?.result();
  expect(result?.text).toBe("```bash\nls\n```");
  expect(result?.reasoning).toEqual({ carry: "encrypted", blocks: [ENCRYPTED_ENTRY], dropped: 0 });
});
