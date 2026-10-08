/**
 * 三条端点族的方言翻译(hld §2.2.6)。
 *
 * ── 为什么按「端点族」分,而不是按厂商分 ──
 *
 * 本期已开通的模型全落在三个**线协议**里:OpenAI 的 `/chat/completions`、Anthropic 的
 * `/messages`、OpenAI 的 `/responses`。按厂商再包一层只会让依赖面随节点扩张,而真正变的是
 * 「请求 body 怎么摆、响应怎么读回统一形状」——这正是本文件的一对函数
 * (`buildBody` / `parseResponse`)负责的翻译。HTTP 细节(鉴权、超时、状态码分类)留在 `client.ts`。
 *
 * ── 统一形状(端口 `ModelResponse`)──
 *
 * `text` / `finishReason` / `usage`。**截断一律归一成 `"length"`**:OpenAI 本就是 `"length"`,
 * Anthropic 的 `"max_tokens"` 与 Responses 的 `status: "incomplete"` 都由这里映射过来——
 * 票 06 只认这一个值来决定「重发同一轮」。
 *
 * 解析全程用 `unknown` 收窄(`no-explicit-any` 是 error):端点返回的永远是外部输入,
 * 遇到缺字段就退到安全缺省,而不是抛"取属性时 undefined"的下游崩溃。
 */

import type { ChatMessage, ModelParams, ModelResponse } from "../model-client.js";
import type { EndpointFamily, ModelConfig } from "../config.js";
import { isRecord } from "../record.js";

/** 一条端点族的翻译规则。`path` 相对 `baseUrl` 拼;`buildBody` 造请求体;`parseResponse` 读回统一形状。 */
export type EndpointSpec = {
  readonly path: string;
  readonly buildBody: (
    config: ModelConfig,
    messages: readonly ChatMessage[],
    params: ModelParams,
  ) => Record<string, unknown>;
  readonly parseResponse: (json: unknown) => ModelResponse;
};

/**
 * Anthropic `/messages` 要求 `max_tokens` 必填。模型配置可通过 `params.max_tokens` 覆盖;
 * 未给时兜一个**工程缺省**——它是 gen 内部参数,不进 `rulesets/*.json`(那管的是对局规则,不是请求预算)。
 */
const DEFAULT_MAX_TOKENS = 8192;

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** 读一个字符串字段;缺失或类型不符时返回 `undefined`(交给调用方决定缺省语义)。 */
const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

/** 线上一条消息的形状:三家端点族的共同子集(`{ role, content }`)。 */
const toWireMessage = (message: ChatMessage): Record<string, unknown> => ({
  role: message.role,
  content: message.content,
});

/** 把值收窄成键值对记录;不是记录就给空记录,免得下游取属性崩。 */
const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

// ── chat-completions(OpenAI 系)─────────────────────────────────────────────

const chatCompletionsBody: EndpointSpec["buildBody"] = (config, messages, params) => ({
  model: config.modelId,
  messages: messages.map(toWireMessage),
  ...params,
});

const parseChatCompletions: EndpointSpec["parseResponse"] = (json) => {
  const root = asRecord(json);
  const choice = asRecord(asArray(root.choices)[0]);
  const message = asRecord(choice.message);
  return {
    text: stringField(message, "content") ?? "",
    finishReason: stringField(choice, "finish_reason") ?? "stop",
    usage: root.usage,
  };
};

// ── messages(Anthropic 系)───────────────────────────────────────────────────

/** Anthropic 的 `stop_reason` 归一;不在表里的借用原值透传(重试只认 `"length"`)。 */
const MESSAGES_STOP_REASONS: Record<string, string> = {
  max_tokens: "length",
  end_turn: "stop",
  stop_sequence: "stop",
};

const messagesBody: EndpointSpec["buildBody"] = (config, messages, params) => {
  // Anthropic 没有 `role: "system"` 的消息:system 提示抽到顶层 `system` 字段,不进 `messages`。
  const systemParts: string[] = [];
  const dialog: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
    } else {
      dialog.push(toWireMessage(message));
    }
  }

  const body: Record<string, unknown> = {
    model: config.modelId,
    max_tokens: typeof params.max_tokens === "number" ? params.max_tokens : DEFAULT_MAX_TOKENS,
    ...params,
    messages: dialog,
  };
  if (systemParts.length > 0) {
    body.system = systemParts.join("\n\n");
  }
  return body;
};

const parseMessages: EndpointSpec["parseResponse"] = (json) => {
  const root = asRecord(json);
  let text = "";
  for (const block of asArray(root.content)) {
    if (isRecord(block) && block.type === "text") {
      text += stringField(block, "text") ?? "";
    }
  }
  const rawStop = stringField(root, "stop_reason");
  const finishReason = rawStop === undefined ? "stop" : (MESSAGES_STOP_REASONS[rawStop] ?? rawStop);
  return { text, finishReason, usage: root.usage };
};

// ── responses(OpenAI Responses API)──────────────────────────────────────────

const responsesBody: EndpointSpec["buildBody"] = (config, messages, params) => ({
  model: config.modelId,
  ...params,
  input: messages.map(toWireMessage),
});

const parseResponses: EndpointSpec["parseResponse"] = (json) => {
  const root = asRecord(json);
  let text = "";
  for (const item of asArray(root.output)) {
    if (!isRecord(item) || item.type !== "message") {
      continue;
    }
    for (const block of asArray(item.content)) {
      if (isRecord(block) && block.type === "output_text") {
        text += stringField(block, "text") ?? "";
      }
    }
  }

  const status = stringField(root, "status");
  let finishReason: string;
  if (status === "incomplete" || isRecord(root.incomplete_details)) {
    // `incomplete` / `incomplete_details` 都表示被预算截断 → 归一成 `"length"`(票 06 重发同一轮)。
    finishReason = "length";
  } else if (status === "completed" || status === undefined) {
    finishReason = "stop";
  } else {
    finishReason = status;
  }
  return { text, finishReason, usage: root.usage };
};

/** 取一条端点族的翻译规则。新增一族才需要在这里动分支。 */
export const endpointSpec = (family: EndpointFamily): EndpointSpec => {
  switch (family) {
    case "chat-completions":
      return {
        path: "/chat/completions",
        buildBody: chatCompletionsBody,
        parseResponse: parseChatCompletions,
      };
    case "messages":
      return { path: "/messages", buildBody: messagesBody, parseResponse: parseMessages };
    case "responses":
      return { path: "/responses", buildBody: responsesBody, parseResponse: parseResponses };
  }
};
