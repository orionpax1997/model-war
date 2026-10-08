/**
 * 三端点族的**纯翻译**单测:不经网络,只喂 `buildBody` / `parseResponse` 输入,断言请求体形状与
 * 归一后的 `ModelResponse`。网络行为(鉴权头、状态码分类、超时)在 `client.test.ts` 用本地假端点覆盖。
 */

import { expect, it } from "vitest";
import type { ModelConfig } from "../config.js";
import type { ChatMessage } from "../model-client.js";
import { endpointSpec } from "./endpoints.js";

const config = (family: ModelConfig["endpointFamily"]): ModelConfig => ({
  slug: "model-x",
  endpointFamily: family,
  baseUrl: "https://example.invalid/v1",
  modelId: "vendor/model-x",
  credentialEnvVar: "TEST_KEY",
});

it("三条端点族的路径各自钉死", () => {
  expect(endpointSpec("chat-completions").path).toBe("/chat/completions");
  expect(endpointSpec("messages").path).toBe("/messages");
  expect(endpointSpec("responses").path).toBe("/responses");
});

it("chat-completions 请求体:model + messages(system 留在 messages 里)+ params 透传", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
  ];
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
});

it("chat-completions 响应:取 choices[0].message.content / finish_reason / usage", () => {
  const response = endpointSpec("chat-completions").parseResponse({
    choices: [{ message: { content: "脚本正文" }, finish_reason: "length" }],
    usage: { total_tokens: 11 },
  });
  expect(response).toEqual({
    text: "脚本正文",
    finishReason: "length",
    usage: { total_tokens: 11 },
  });
});

it("chat-completions 响应缺字段时不崩,退到安全缺省", () => {
  expect(endpointSpec("chat-completions").parseResponse({})).toEqual({
    text: "",
    finishReason: "stop",
    usage: undefined,
  });
  expect(endpointSpec("chat-completions").parseResponse("not an object")).toEqual({
    text: "",
    finishReason: "stop",
    usage: undefined,
  });
});

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
  expect(response).toEqual({ text: "abcd", finishReason: "length", usage: { output_tokens: 9 } });
});

it("messages 响应:end_turn → stop,stop_sequence → stop,未知原因透传,缺 stop_reason → stop", () => {
  const spec = endpointSpec("messages");
  const reason = (stopReason: string | undefined): string =>
    spec.parseResponse(stopReason === undefined ? {} : { stop_reason: stopReason }).finishReason;
  expect(reason("end_turn")).toBe("stop");
  expect(reason("stop_sequence")).toBe("stop");
  expect(reason("pause_turn")).toBe("pause_turn");
  expect(reason(undefined)).toBe("stop");
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
  expect(spec.parseResponse({ status: "completed", output, usage: { total_tokens: 3 } })).toEqual({
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
