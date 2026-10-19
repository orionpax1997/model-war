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
 * `text` / `finishReason` / `usage` / `stopDetails`。预算截断归一成 `"length"`:
 * Chat 的 `"length"`、Messages 的 `"max_tokens"` 与 Responses 的
 * `incomplete_details.reason: "max_output_tokens"`。其他 incomplete 不冒充预算截断，
 * 缺停止字段保持 `"unknown"`；原状态和原因单独保留。重试层只认 `"length"` 重发同一轮。
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
  /** 可选流式能力;不声明即非流式(响应按 content-type 回退到一次性 JSON)。见 `StreamingEndpoint`。 */
  readonly streaming?: StreamingEndpoint;
};

/** 逐帧累积器:SSE 把一次响应摊成多帧,累积器把它重新拼回 `ModelResponse`。 */
export type StreamAccumulator = {
  /** 喂一帧(已 `JSON.parse` 过的帧);端点族自己决定读哪些字段。 */
  readonly push: (frame: unknown) => void;
  /** 收流(`[DONE]`)后的统一形状;缺省语义与非流式 `parseResponse` 保持一致。 */
  readonly result: () => ModelResponse;
  /** 可选的端点原生收尾:Anthropic 系以 `message_stop` 事件收尾,没有 `[DONE]`。缺省即只认 `[DONE]`。 */
  readonly done?: () => boolean;
};

/**
 * 一条端点族的**流式能力**。
 *
 * ── 为什么是可选字段,不是人人都有 ──
 *
 * 三族的 SSE 帧形状并不相同,而本期只有 `chat-completions` 走过真实流式验证面。给另两族写
 * 没被任何真实响应验证过的翻译,只会造出「看起来支持」的假象——留成可选字段,缺省即非流式,
 * 声明它才是「这条端点族的流式读法被验证过」。
 *
 * - `buildBody` 造**带流式字段**的请求体(与非流式 `buildBody` 同源,只叠加 `stream` 之类);
 * - `createAccumulator` 造一个逐帧累积器,每次 `push` 接到一帧;`result` 给出与非流式
 *   `parseResponse` **同形**的返回值,于是端口(`ModelResponse`)不必知道传输是不是流式的。
 */
export type StreamingEndpoint = {
  readonly buildBody: EndpointSpec["buildBody"];
  readonly createAccumulator: () => StreamAccumulator;
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

/**
 * 流式请求体 = 非流式请求体叠加 `stream: true` 与 `stream_options.include_usage`。
 *
 * `include_usage` 是 OpenAI 取 token 读数的标准开关:不打开时收尾帧不带 `usage`,`meta.generationLog`
 * 就整段缺 token 数。两者排在 `...params` **之后**,故调用方 params 里的同名键压不过本层——
 * 「这条请求走流式」是端点族的传输决定,不是可被模型配置覆盖的生成参数。
 */
const chatCompletionsStreamBody: EndpointSpec["buildBody"] = (config, messages, params) => ({
  ...chatCompletionsBody(config, messages, params),
  stream: true,
  stream_options: { include_usage: true },
});

/**
 * 逐帧累积 chat-completions 的流:正文增量拼 `text`,终点帧的 `finish_reason` 定 `finishReason`,
 * 最后一个非空 `usage` 帧定 `usage`。
 *
 * 只认 `delta.content`:**不认 `delta.reasoning_content`**。推理增量不是产物(实测推理型模型先吐
 * 一大段 `reasoning_content` 再吐正文),把它拼进 `text` 等于把半截思维链当脚本写盘、并回喂给下一轮。
 */
const createChatCompletionsAccumulator = (): StreamAccumulator => {
  let text = "";
  let finishReason: string | undefined;
  let usage: unknown;

  return {
    push: (frame) => {
      const root = asRecord(frame);
      const choice = asRecord(asArray(root.choices)[0]);
      const delta = asRecord(choice.delta);
      text += stringField(delta, "content") ?? "";

      // 首帧与中途帧都带 `finish_reason: null`;只被「最后一个非空值」覆盖(终点帧 / 截断的 length)。
      const frameFinish = stringField(choice, "finish_reason");
      if (frameFinish !== undefined && frameFinish.length > 0) {
        finishReason = frameFinish;
      }

      // usage 只在开 `include_usage` 时的收尾帧出现,而中途帧可能带 `usage: null`——取最后一个
      // **非空**值,别被后者清掉。保持 OpenAI 原形(含 `completion_tokens_details.reasoning_tokens`)。
      if (root.usage !== undefined && root.usage !== null) {
        usage = root.usage;
      }
    },
    result: () => ({
      text,
      finishReason: finishReason ?? "unknown",
      usage,
      stopDetails: finishReason === undefined ? {} : { reason: finishReason },
    }),
  };
};

const parseChatCompletions: EndpointSpec["parseResponse"] = (json) => {
  const root = asRecord(json);
  const choice = asRecord(asArray(root.choices)[0]);
  const message = asRecord(choice.message);
  const rawStop = stringField(choice, "finish_reason");
  return {
    text: stringField(message, "content") ?? "",
    finishReason: rawStop ?? "unknown",
    usage: root.usage,
    stopDetails: rawStop === undefined ? {} : { reason: rawStop },
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

/**
 * 流式请求体 = 非流式请求体叠加 `stream: true`。
 *
 * 实测新中转在非流式下长时间不回响应头(网关等上游全量生成完才回),300s 空闲超时先到;
 * 同一请求开流式后首帧 6s 即到——「这条请求走流式」是端点族的传输决定,params 压不过本层。
 */
const messagesStreamBody: EndpointSpec["buildBody"] = (config, messages, params) => ({
  ...messagesBody(config, messages, params),
  stream: true,
});

/**
 * 逐帧累积 Anthropic SSE:正文只拼 `text_delta`,推理 `thinking_delta` / 签名等绝不进 `text`;
 * 停止原因取 `message_delta` 的 `stop_reason`(与非流式同一归一表);usage 把起止两处合并。
 *
 * 收尾认 `message_stop` 事件(Anthropic 流没有 `[DONE]`),由 `done()` 告诉读流循环提前结束。
 */
const createMessagesAccumulator = (): StreamAccumulator => {
  let text = "";
  let rawStop: string | undefined;
  let usage: unknown;
  let stopped = false;
  return {
    push: (frame) => {
      const root = asRecord(frame);
      const type = stringField(root, "type");
      if (type === "content_block_delta") {
        const delta = asRecord(root.delta);
        if (stringField(delta, "type") === "text_delta") {
          text += stringField(delta, "text") ?? "";
        }
      } else if (type === "message_delta") {
        const stop = stringField(asRecord(root.delta), "stop_reason");
        if (stop !== undefined) {
          rawStop = stop;
        }
        if (root.usage !== undefined && root.usage !== null) {
          usage = { ...asRecord(usage), ...asRecord(root.usage) };
        }
      } else if (type === "message_start") {
        const messageUsage = asRecord(root.message).usage;
        if (messageUsage !== undefined && messageUsage !== null) {
          usage = messageUsage;
        }
      } else if (type === "message_stop") {
        stopped = true;
      }
    },
    result: () => ({
      text,
      finishReason: rawStop === undefined ? "unknown" : (MESSAGES_STOP_REASONS[rawStop] ?? rawStop),
      usage,
      stopDetails: rawStop === undefined ? {} : { reason: rawStop },
    }),
    done: () => stopped,
  };
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
  const finishReason =
    rawStop === undefined ? "unknown" : (MESSAGES_STOP_REASONS[rawStop] ?? rawStop);
  return {
    text,
    finishReason,
    usage: root.usage,
    stopDetails: rawStop === undefined ? {} : { reason: rawStop },
  };
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
  const incompleteReason = stringField(asRecord(root.incomplete_details), "reason");
  if (status === "incomplete" || isRecord(root.incomplete_details)) {
    // 只有输出预算截断可重试；内容过滤等 incomplete 不伪装成预算耗尽。
    finishReason = incompleteReason === "max_output_tokens" ? "length" : "incomplete";
  } else if (status === "completed") {
    finishReason = "stop";
  } else {
    finishReason = status ?? "unknown";
  }
  return {
    text,
    finishReason,
    usage: root.usage,
    stopDetails: {
      ...(status === undefined ? {} : { status }),
      ...(incompleteReason === undefined ? {} : { reason: incompleteReason }),
    },
  };
};

/** 取一条端点族的翻译规则。新增一族才需要在这里动分支。 */
export const endpointSpec = (family: EndpointFamily): EndpointSpec => {
  switch (family) {
    case "chat-completions":
      return {
        path: "/chat/completions",
        buildBody: chatCompletionsBody,
        parseResponse: parseChatCompletions,
        streaming: {
          buildBody: chatCompletionsStreamBody,
          createAccumulator: createChatCompletionsAccumulator,
        },
      };
    case "messages":
      return {
        path: "/messages",
        buildBody: messagesBody,
        parseResponse: parseMessages,
        streaming: {
          buildBody: messagesStreamBody,
          createAccumulator: createMessagesAccumulator,
        },
      };
    case "responses":
      return { path: "/responses", buildBody: responsesBody, parseResponse: parseResponses };
  }
};
