/**
 * 四条端点族的方言翻译(hld §2.2.6)。
 *
 * ── 为什么按「端点族」分,而不是按厂商分 ──
 *
 * 本期已开通的模型落在四个**线协议**里:OpenAI 的 `/chat/completions`、Anthropic 的
 * `/messages`、OpenAI 的 `/responses`、Google 的 `:generateContent`。按厂商再包一层只会让
 * 依赖面随节点扩张,而真正变的是「请求 body 怎么摆、响应怎么读回统一形状」——这正是本文件的
 * 一对函数(`buildBody` / `parseResponse`)负责的翻译。HTTP 细节(鉴权、超时、状态码分类)留在 `client.ts`。
 *
 * ── 统一形状(端口 `ModelResponse`)──
 *
 * `text` / `finishReason` / `usage` / `stopDetails`。预算截断归一成 `"length"`:
 * Chat 的 `"length"`、Messages 的 `"max_tokens"`、Responses 的
 * `incomplete_details.reason: "max_output_tokens"` 与 GenerateContent 的 `"MAX_TOKENS"`。
 * 内容过滤类停止(Chat 的 `content_filter`、GenerateContent 的 `SAFETY` 等)同样有表,
 * 但**不冒充**预算截断。缺停止字段保持 `"unknown"`;原状态和原因单独保留在 `stopDetails`。
 * 重试层只认 `"length"` 重发同一轮。
 *
 * 工具调用那一轮的 `content` 常常是空串、真正的产物在 `tool_calls` 里——所以统一形状同时有
 * `text` 与 `toolCalls` 两格,两个键各自承载一种产物(见 `ModelResponse.toolCalls`)。
 *
 * 解析全程用 `unknown` 收窄(`no-explicit-any` 是 error):端点返回的永远是外部输入,
 * 遇到缺字段就退到安全缺省,而不是抛"取属性时 undefined"的下游崩溃。
 */

import type {
  ChatMessage,
  ModelParams,
  ModelResponse,
  ReasoningCarry,
  ReasoningEcho,
} from "../model-client.js";
import type { ToolCall, ToolDeclaration } from "../agent/tools.js";
import { toolCallIdAt } from "../agent/tools.js";
import type { EndpointFamily, ModelConfig } from "../config.js";
import { isRecord } from "../record.js";
import {
  chatReasoningStream,
  messagesReasoningStream,
  readChatReasoning,
  readMessagesReasoning,
  readResponsesReasoning,
  writeChatReasoning,
  writeMessagesReasoning,
  writeResponsesReasoning,
  type ReasoningPayload,
} from "./reasoning.js";

/**
 * 一条端点族的**推理回传能力声明**。
 *
 * 三族三份策略,写成声明而不是调用点上的条件分支:谁要回传、回传什么形状,由族自己说;
 * 序列化动作仍只在那族的 `buildBody` 里发生(读法/写法在 `reasoning.ts`)。
 */
export type ReasoningCapability = {
  /** 这一族的策略。`drop` = 该族没有可回传的东西(读了也丢)。 */
  readonly carry: ReasoningCarry;
  /** 从一份普通(非流式)响应里读出可回传的条目。 */
  readonly read: (root: Record<string, unknown>) => ReasoningEcho | undefined;
};

/**
 * 一条端点族的**工具调用能力声明**。
 *
 * ── 为什么是可选字段,缺省 = 不支持 ──
 *
 * 与 `streaming?: StreamingEndpoint` 同一条先例:四族的工具形状并不相同(OpenAI 是
 * `{type:"function", function:{name, description, parameters}}` + `tool_calls`,Anthropic 是
 * `{name, description, input_schema}` + `tool_use` / `tool_result` 块),而只有 `chat-completions`
 * 的工具读法被**真实会话**验证过。给没被验证过的族写一版翻译,只会造出「看起来支持」的假象
 * (已经否过一次这个形状)。所以缺省即「本族不支持工具调用」,用它的席位在**会话
 * 起跑之前**拒跑(`pipeline.ts` 的 `assertToolSurface`),而不是发一个上游认不出的请求。
 *
 * `messages` 族的现状:协议事实已有(2026-11-21 三步探针,`probes/messages-tool-roundtrip/`:
 * 声明形状被接受、返回 `tool_use`、`tool_result` 配对也被接受),但**翻译还没写**,所以这里
 * 仍然不声明。原先写在这里的理由是「带不带 `tools` 都是 403,所以零证据」——那两次 403 是
 * 链路故障而非档位事实,复测不再现,订正与原文都记在 git 历史里。
 * 「翻译没写」与「没有证据」是两件事,别再写成一个。
 */
export type ToolCapability = {
  /**
   * 这一族把工具声明写成什么形状,以及结果回来是什么形状。两件事是同一个人的同一套约定,
   * 所以合成一格:
   *
   * - `function-json-schema`(chat-completions):声明 `{type:"function", function:{name,
   *   description, parameters}}`,结果在 `tool_calls[].function.arguments`(**原文字符串**),
   *   观测用 `role:"tool"` + `tool_call_id`;
   * - `anthropic-input-schema`(messages):声明 `{name, description, input_schema}`,结果在
   *   `content[]` 的 `tool_use` 块里且 `input` 是**对象**,观测用 `role:"user"` + `tool_result` 块。
   */
  readonly shape: "function-json-schema" | "anthropic-input-schema";
};

/**
 * 一次请求的**协议面**:工具声明从这里进来,不从 `params` 进来。
 *
 * ── 为什么工具声明必须是一等入参 ──
 *
 * `ModelParams` 是**生成策略的产出面**(`generationParams()`),它的每个键都是「怎么采样」;
 * 让工具声明从那里进来,`generationPolicy` 就能意外改掉协议——于是「换 harness」与「调一个
 * 参数」在代码里长得一模一样,而二者的后果差着整整一个世界。所以它走这条独立的缝。
 *
 * 缺省(`{}`)= 没有工具声明 = 请求体与工具调用引入之前**逐字节相同**。
 */
export type EndpointRequest = {
  readonly tools?: readonly ToolDeclaration[];
};

/**
 * 一条端点族的翻译规则。`path` 相对 `baseUrl` 拼;`buildBody` 造请求体;`parseResponse` 读回统一形状。
 *
 * `path` 是按配置求值的函数而不是常量串:Google 系把模型名与流式动词都写进路径
 * (`/models/<modelId>:generateContent`),路径本身就随模型变。
 */
export type EndpointSpec = {
  readonly path: (config: ModelConfig) => string;
  readonly buildBody: (
    config: ModelConfig,
    messages: readonly ChatMessage[],
    params: ModelParams,
    request?: EndpointRequest,
  ) => Record<string, unknown>;
  readonly parseResponse: (json: unknown) => ModelResponse;
  /**
   * 工具调用能力声明(见 `ToolCapability`)。**可选 = 本族不支持**。
   *
   * 可选而不是必填:与 `reasoning` 相反的那一侧——那里的「忘了声明」是一个接错,这里的
   * 「不声明」是一个**正当答案**(这一族没有翻译,或那份翻译没被真实会话验证过)。
   */
  readonly tools?: ToolCapability;
  /**
   * 推理回传的能力声明(「reasoning 按端点族分家」)。**每族必填**。
   *
   * 必填而不是可选:可选会让「这一族忘了声明」与「这一族声明了丢弃」在代码里长得一样,
   * 而前者是一个应该当场响的接错。
   */
  readonly reasoning: ReasoningCapability;
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
 * 四族的 SSE 帧形状并不相同,也不是每族都走过真实流式验证面。给没被任何真实响应验证过的
 * 翻译写流式,只会造出「看起来支持」的假象——留成可选字段,缺省即非流式,
 * 声明它才是「这条端点族的流式读法被验证过」。
 *
 * - `buildBody` 造**带流式字段**的请求体(与非流式 `buildBody` 同源,只叠加 `stream` 之类);
 * - `createAccumulator` 造一个逐帧累积器,每次 `push` 接到一帧;`result` 给出与非流式
 *   `parseResponse` **同形**的返回值,于是端口(`ModelResponse`)不必知道传输是不是流式的。
 */
export type StreamingEndpoint = {
  readonly buildBody: EndpointSpec["buildBody"];
  readonly createAccumulator: () => StreamAccumulator;
  /**
   * 可选的流式专用路径:Google 系把流式动词写在路径里(`:streamGenerateContent?alt=sse`),
   * 不是请求体里的 `stream` 字段。缺省沿用非流式 `path`。
   */
  readonly path?: EndpointSpec["path"];
  /**
   * 这条族的流**没有收尾哨兵**:上游在最后一帧之后直接关连接(Google `:streamGenerateContent?alt=sse`)。
   * 声明它,EOF 即视为正常收尾——但仍要求累积器已经读过停止标记(`finishReason` 不是 `"unknown"`),
   * 否则与有哨兵的族一样按「网关截断」判可重试。
   */
  readonly endsOnStreamClose?: true;
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

/** 线上一条消息的形状:`{ role, content }`(`messages` / `responses` 两族里没有推理可带的那些消息)。 */
const toWireMessage = (message: ChatMessage): Record<string, unknown> => ({
  role: message.role,
  content: message.content,
});

/** 把值收窄成键值对记录;不是记录就给空记录,免得下游取属性崩。 */
const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/**
 * 读一条消息的 `tool_calls`。
 *
 * `arguments` **原样交出字符串**,不在这里 `JSON.parse`:解析失败是模型可自我修复的格式失败
 * (`malformed-arguments`,归动作层判、计一步、回纠正消息),放进传输层就变成了端点错误。
 * 同一个道理要求它**不重编码**——`JSON.stringify(JSON.parse(x))` 会改掉缩进与转义写法,而发回
 * 历史时用的就是这串字节(「与发回去的字节同源」)。
 *
 * 缺 `function.name` 或 `function.arguments` 的那一格**丢掉**,不折成空名字的调用:
 * 「说不出调了什么」不是一个可判定的动作,凑空名字只会把上游的呲变成下游的 `unknown-tool`。
 */
const toolCallsOf = (message: Record<string, unknown>): readonly ToolCall[] => {
  const calls: ToolCall[] = [];
  for (const entry of asArray(message.tool_calls)) {
    const fn = asRecord(asRecord(entry).function);
    const name = stringField(fn, "name");
    const argumentsJson = stringField(fn, "arguments");
    if (name === undefined || argumentsJson === undefined) continue;
    calls.push({ name, argumentsJson });
  }
  return calls;
};

// ── 推理回传的能力声明(「reasoning 按端点族分家」)────────────────────
//
// 三份声明跟在族的那一节之前,`buildBody`、累积器、`parseResponse` 都从它们取策略:
// 「这一族怎么回传」因此只有一个家,而不是「声明一处、写死另一处」。

/** 读出来的条目挂上这一族声明的策略;一条都没有时缺席(不挂空壳)。 */
const echoWith = (
  capability: ReasoningCapability,
  payload: ReasoningPayload | undefined,
): ReasoningEcho | undefined =>
  payload === undefined ? undefined : { carry: capability.carry, ...payload };

/** chat 族:普通推理内容丢、加密条目原样回传。 */
const CHAT_REASONING: ReasoningCapability = {
  carry: "encrypted",
  read: (root) =>
    echoWith(
      CHAT_REASONING,
      readChatReasoning(asRecord(asRecord(asArray(root.choices)[0]).message)),
    ),
};

/** messages 族:thinking 块连签名原样送回;缺签名的块丢弃。 */
const MESSAGES_REASONING: ReasoningCapability = {
  carry: "signed",
  read: (root) => echoWith(MESSAGES_REASONING, readMessagesReasoning(asArray(root.content))),
};

/** responses 族:加密推理条目原样送回。 */
const RESPONSES_REASONING: ReasoningCapability = {
  carry: "encrypted",
  read: (root) => echoWith(RESPONSES_REASONING, readResponsesReasoning(asArray(root.output))),
};

/**
 * generate-content 族:显式丢弃。
 *
 *  只裁了三族(签名回传 / 加密回传 / 普通推理丢弃),这一族的思考段(`part.thought`)
 * 既没有签名也没有加密块,所以不发明一种回传:声明成 `drop`,让「这一族不回传」成为一条
 * 写下来的事实,而不是一处省略。
 */
const GENERATE_CONTENT_REASONING: ReasoningCapability = { carry: "drop", read: () => undefined };

// ── chat-completions(OpenAI 系)─────────────────────────────────────────────

/**
 * chat 族的一条请求消息:推理回传落在 `reasoning_details` 里,与端点吐出来的位置一致;
 * 工具调用落在 `tool_calls` / `tool_call_id` 上,与端点吐出来的位置一致。
 *
 * 只有带东西的消息才多那几格:历史里其余消息仍是 `{role, content}`。
 */
const chatWireMessage = (message: ChatMessage): Record<string, unknown> => {
  const wire = toWireMessage(message);
  const echo = message.reasoning;
  if (echo !== undefined) {
    writeChatReasoning(wire, echo, CHAT_REASONING.carry);
  }
  // `tool` 角色回答的是哪一次调用:渠道要求 assistant 的 `tool_calls[i].id` 与 tool 消息的
  // `tool_call_id` 逐字相等。实证结果:配对关系服务端**不校验**,但 `id` 本身是**必填**
  // (缺它回 400 `messages.N.tool_calls.0.id expected string`)。所以两处都从 `toolCallId` 派生。
  if (message.role === "tool" && message.toolCallId !== undefined) {
    wire.tool_call_id = message.toolCallId;
  }
  // assistant 那一轮发起了什么:原样回传 `argumentsJson` 的字节,不重编码。
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    const base = message.toolCallId;
    wire.tool_calls = message.toolCalls.map((call, index) => ({
      // 缺 `toolCallId` 时退到 `call-0` 而不是漏掉这个键:漏掉会让渠道 400。
      id: toolCallIdAt(base ?? "call-0", index),
      type: "function",
      function: { name: call.name, arguments: call.argumentsJson },
    }));
  }
  return wire;
};

/**
 * 工具声明的线上形状(chat 族):`[{type:"function", function:{name, description, parameters}}]`。
 *
 * 实证形状取自 2026-11-20 的真请求探针(见票 01 的验收证据)。
 */
const chatToolsField = (tools: readonly ToolDeclaration[]): readonly unknown[] =>
  tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));

/**
 * 工具声明与 `tool_choice` 排在 `...params` **之后**。
 *
 * 这是「工具声明是一等参数」的物理实现点:`params` 是生成策略的产出面,把它写在后面就是让
 * `generationPolicy` 能意外覆盖协议。``tool_choice: "auto"` 而不是 `"required"` 的理由在
 * 的落选段:强制调用会把「我想先想想」变成一条被强迫的命令,而`auto` 下「零次调用」照旧是
 * 一条计步的拒绝档。
 */
const chatCompletionsBody: EndpointSpec["buildBody"] = (config, messages, params, request) => ({
  model: config.modelId,
  messages: messages.map(chatWireMessage),
  ...params,
  ...(request?.tools === undefined || request.tools.length === 0
    ? {}
    : { tools: chatToolsField(request.tools), tool_choice: "auto" }),
});

/**
 * 流式请求体 = 非流式请求体叠加 `stream: true` 与 `stream_options.include_usage`。
 *
 * `include_usage` 是 OpenAI 取 token 读数的标准开关:不打开时收尾帧不带 `usage`,`meta.generationLog`
 * 就整段缺 token 数。两者排在 `...params` **之后**,故调用方 params 里的同名键压不过本层——
 * 「这条请求走流式」是端点族的传输决定,不是可被模型配置覆盖的生成参数。
 */
const chatCompletionsStreamBody: EndpointSpec["buildBody"] = (
  config,
  messages,
  params,
  request,
) => ({
  ...chatCompletionsBody(config, messages, params, request),
  stream: true,
  stream_options: { include_usage: true },
});

/**
 * 逐帧累积 chat-completions 的流:正文增量拼 `text`,终点帧的 `finish_reason` 定 `finishReason`,
 * 最后一个非空 `usage` 帧定 `usage`。
 *
 * 只把 `delta.content` 拼进正文:**明文推理增量(`reasoning_content`)不是产物**——实测推理型模型
 * 先吐一大段它再吐正文,拼进去等于把半截思维链当脚本写盘、并回喂给下一轮。它对回传也没有用:
 * chat 族唯一能回传的是加密条目(`reasoning_details` 里的 `reasoning.encrypted`),二者同一份读法。
 */
const createChatCompletionsAccumulator = (): StreamAccumulator => {
  let text = "";
  let finishReason: string | undefined;
  let usage: unknown;
  const reasoning = chatReasoningStream(CHAT_REASONING.carry);
  /**
   * 按 `index` 聚合的在途工具调用。
   *
   * `delta.tool_calls` 是**分片**的:首帧常常只带 `index` 与 `function.name`,`arguments` 的文本
   * 分数帧追加。所以键是渠道给的 `index`,不是本帧的数组下标——一次响应可能有多个调用,而它们
   * 的参数帧会交错。`name` 也拼字符串(实路上只来一帧,但不赌)。
   */
  const toolCalls = new Map<number, { name: string; argumentsJson: string }>();

  return {
    push: (frame) => {
      const root = asRecord(frame);
      const choice = asRecord(asArray(root.choices)[0]);
      const delta = asRecord(choice.delta);
      text += stringField(delta, "content") ?? "";
      reasoning.push(delta);

      for (const [position, entry] of asArray(delta.tool_calls).entries()) {
        const call = asRecord(entry);
        // `index` 缺席时退到本帧里的位次:没有它就无法分辨「同一个调用的下一帧」与「另一个
        // 调用」,而推一个到末尾会把两串参数交错成一串无意义的字节。
        const index = typeof call.index === "number" ? call.index : position;
        const current = toolCalls.get(index) ?? { name: "", argumentsJson: "" };
        const fn = asRecord(call.function);
        current.name += stringField(fn, "name") ?? "";
        current.argumentsJson += stringField(fn, "arguments") ?? "";
        toolCalls.set(index, current);
      }

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
    result: () => {
      const echo = reasoning.result();
      // 按 `index` 排序:Map 的插入序在「多个调用交错返回」时不可靠(第二个可能先到一帧),而
      // 档案里的顺序得与模型发起的顺序一致。空名字或空参数的那一格与非流式同样丢掉。
      const calls = [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => call)
        .filter((call) => call.name !== "" && call.argumentsJson !== "");
      return {
        text,
        ...(calls.length === 0 ? {} : { toolCalls: calls }),
        finishReason: finishReason ?? "unknown",
        usage,
        stopDetails: finishReason === undefined ? {} : { reason: finishReason },
        ...(echo === undefined ? {} : { reasoning: echo }),
      };
    },
  };
};

const parseChatCompletions: EndpointSpec["parseResponse"] = (json) => {
  const root = asRecord(json);
  const choice = asRecord(asArray(root.choices)[0]);
  const message = asRecord(choice.message);
  const rawStop = stringField(choice, "finish_reason");
  const echo = CHAT_REASONING.read(root);
  const calls = toolCallsOf(message);
  return {
    text: stringField(message, "content") ?? "",
    ...(calls.length === 0 ? {} : { toolCalls: calls }),
    finishReason: rawStop ?? "unknown",
    usage: root.usage,
    stopDetails: rawStop === undefined ? {} : { reason: rawStop },
    ...(echo === undefined ? {} : { reasoning: echo }),
  };
};

// ── messages(Anthropic 系)───────────────────────────────────────────────────

/** Anthropic 的 `stop_reason` 归一;不在表里的借用原值透传(重试只认 `"length"`)。 */
const MESSAGES_STOP_REASONS: Record<string, string> = {
  max_tokens: "length",
  end_turn: "stop",
  stop_sequence: "stop",
  // `tool_use` 是「它要调工具」,不是「它说完了」;归一成 chat 族那个词,跨族读侧不必认两个。
  // 原值仍落在 `stopDetails.reason` 里,要看渠道原话的地方读那一格。
  tool_use: "tool_calls",
};

/**
 * 本模型的缓存断点；`undefined` = 不发断点。
 *
 * 只认 `messages` 族的 policy：chat / responses 族默认缓存前缀，加参数是多余干预。
 * TTL 选 1 小时的理由在配置侧（单轮生成可能超过 5 分钟，5m 断点在下一轮之前就失效）。
 */
const cacheControlOf = (config: ModelConfig): Record<string, unknown> | undefined => {
  const cache = config.generationPolicy?.cache;
  if (cache === undefined || cache.mode === "none") return undefined;
  return cache.mode === "ephemeral-1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
};

/** `messages` 族的工具声明线上形状:`[{name, description, input_schema}]`。 */
const messagesToolsField = (tools: readonly ToolDeclaration[]): readonly unknown[] =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // 原样搬 `parameters`,不重建:重建会丢掉 `additionalProperties`,而 `NO_PARAMETERS`
    // 正是靠这一位表达「这个工具不收参数」(见 `tools.ts` 的 `NO_PARAMETERS`)。
    input_schema: tool.parameters,
  }));

/**
 * `argumentsJson` → 本族的 `input` 对象。
 *
 * ── 本族没有「原文」这个位置 ──
 *
 * chat 族的 `arguments` 就是原文字符串,发回去的字节与落档的字节同源。本族的 `input`
 * 是**对象**,翻译必须解析,于是逐字性在这一族上没有落点——解析成功的那份对象才是本族能保住的东西。
 *
 * ── 所以兜底必须是确定的,不许抛 ──
 *
 * `argumentsJson` 可以被模型写坏(`malformed-arguments` 拒绝档的前提),而坏参数照样进历史
 * (`loop.ts` 把被拒那一步的 `toolCalls` 原样搬进 `turnHistory`)。在这里抛,等于一条坏参数
 * 炸掉整场会话,而它本来只该损失一步。兜底成 `{}`:那一步已经被拒绝档挡下、没有执行,`input`
 * 是什么都不影响真实发生的事,只影响模型下一轮读到的历史长什么样。
 *
 * 解析出来不是键值对(`[]` / `"x"` / `null` / 数字)也兜成 `{}`:本族要求 `input` 是对象,
 * 把数组塞进去是 400,而 400 在报告里与「模型写错了」同形。
 */
const toolInputOf = (call: ToolCall): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(call.argumentsJson);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/** 一次 assistant 轮次要发出去的 `tool_use` id:`call-<步>`、`call-<步>-1`…(与 chat 族同一套)。 */
const toolUseIdsOf = (message: ChatMessage): readonly string[] =>
  (message.toolCalls ?? []).map((_, index) => toolCallIdAt(message.toolCallId ?? "call-0", index));

/**
 * 并行调用被拒时,那些**没有结果的调用**用什么回。
 *
 * 一句事实,不是处方:分布上它确实没被执行(一步只执行一条,其余归 `multiple-tool-calls`),
 * 而纠正说明在真正那一条 `tool_result` 里(它就是这一步的观测文本)。
 */
const UNEXECUTED_CALL_RESULT = "这一步没有为本次调用执行任何动作:一步只执行一条调用,其余归拒绝档。";

/**
 * 一条 assistant 消息的 content 块:推理块 → 正文块(空串不发) → 每个 `toolCalls[i]` 一块
 * `tool_use`。
 *
 * 三样全空时返回空数组,调用方据此**整条不发**——Anthropic 不接受空的 `content` 数组。
 */
const messagesAssistantBlocks = (message: ChatMessage): unknown[] => {
  const blocks = writeMessagesReasoning(
    message.reasoning,
    message.content,
    MESSAGES_REASONING.carry,
  );
  const ids = toolUseIdsOf(message);
  (message.toolCalls ?? []).forEach((call, index) => {
    blocks.push({ type: "tool_use", id: ids[index], name: call.name, input: toolInputOf(call) });
  });
  return blocks;
};

/**
 * 一条观测消息的 content 块。
 *
 * ── 为什么是「按 id 补齐」而不是「一对一翻译」──
 *
 * `multiple-tool-calls` 那一档里,模型一步发了 N 条调用、我们一条都不执行,而历史里仍然只有
 * **一条**观测(`history.ts` 每条 turn 固定两条消息,与 `toolCalls` 有几条无关)。chat 族对此
 * 无所谓(实测配对关系服务端不校验),而本族要求每个 `tool_use` 都有一条对应的 `tool_result`。
 * 所以这里按 `tool_use` 的 id 铺满:对上的那条放真观测,其余补一句事实 + `is_error`。
 *
 * 这也是本族唯一发 `is_error` 的地方,而它是**翻译层自己知道的事实**(这一步没执行),不是从
 * 历史里读出来的——历史里根本没有 `isError` 这个信号(它在 `loop.ts` 的 `observationOf` 处断掉)。
 *
 * 返回空数组 = 这条 assistant 一条调用都没有,观测要当**普通 user 文本**发(见调用处)。
 */
const messagesObservationBlocks = (
  toolUseIds: readonly string[],
  observation: ChatMessage,
): unknown[] => {
  if (toolUseIds.length === 0) return [];
  const matched =
    observation.toolCallId !== undefined && toolUseIds.includes(observation.toolCallId);
  return toolUseIds.map((id, index) => {
    if (id === observation.toolCallId) {
      return { type: "tool_result", tool_use_id: id, content: observation.content };
    }
    // 观测的 id 一条都对不上(理论上不该发生):把观测正文放在第一条,别把它丢掉。
    if (!matched && index === 0) {
      return {
        type: "tool_result",
        tool_use_id: id,
        content: observation.content,
        is_error: true,
      };
    }
    return {
      type: "tool_result",
      tool_use_id: id,
      content: UNEXECUTED_CALL_RESULT,
      is_error: true,
    };
  });
};

/** 同一个角色的连续消息合并成一条:`messages` 族要求 user / assistant 交替。 */
const appendWireMessage = (
  out: Record<string, unknown>[],
  role: string,
  content: unknown,
): void => {
  const last = out[out.length - 1];
  if (last !== undefined && last.role === role) {
    const blocksOf = (value: unknown): unknown[] =>
      typeof value === "string" ? [{ type: "text", text: value }] : asArray(value).slice();
    last.content = [...blocksOf(last.content), ...blocksOf(content)];
    return;
  }
  out.push({ role, content });
};

/**
 * 把整条历史翻成 `messages` 族的线下消息。
 *
 * ── 为什么是「整条历史一次过」,不是「一条消息一个函数」──
 *
 * 观测该翻成 `tool_result` 还是普通文本,取决于**前一条 assistant 有没有 `tool_use`**:
 * `no-tool-call` 那一档模型一步零调用,观测仍带着 `call-<步>` 这个 id(历史构造是固定的),
 * 此时若照 id 翻成 `tool_result`,就是一个没有 `tool_use` 可配对的孤儿块。这个判据要往前看一格,
 * 所以形状判断从「单条消息」提升到「成对的一条 assistant + 一条观测」。
 */
const messagesDialogue = (dialog: readonly ChatMessage[]): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  let index = 0;
  while (index < dialog.length) {
    const message = dialog[index];
    if (message === undefined) break;
    if (message.role === "assistant") {
      const blocks = messagesAssistantBlocks(message);
      // 普通一条话(无推理、无调用)保持 `{role, content}` 字符串载荷:转成块数组只是多一层
      // 包裹,而「中间消息保持字符串」是这族的既有形状(缓存断点那条用例钉着它)。
      const plain =
        (message.reasoning === undefined || message.reasoning.blocks.length === 0) &&
        (message.toolCalls === undefined || message.toolCalls.length === 0);
      if (plain) {
        // 空串也不发:一条什么都没说的 assistant 消息没有内容可送(空 `content` 被拒)。
        if (message.content !== "") appendWireMessage(out, "assistant", message.content);
      } else if (blocks.length > 0) {
        appendWireMessage(out, "assistant", blocks);
      }
      const observation = dialog[index + 1];
      if (observation !== undefined && observation.role === "tool") {
        const results = messagesObservationBlocks(toolUseIdsOf(message), observation);
        // 零条调用时观测不是工具结果,是「下一步该做什么」的普通文本(并且要并进上一条 user)。
        appendWireMessage(out, "user", results.length === 0 ? observation.content : results);
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (message.role === "tool") {
      // 没有配对的 assistant:历史构造坏了(它永远成对 push)。当场抬错,而不是发一个
      // 上游认不出的孤儿 `tool_result` —— 那个 400 在报告里与「模型写错了」同形。
      throw new Error(
        'messages 族:收到没有配对 assistant 的 role:"tool" 观测消息,' +
          "这是 agent 会话的接线错误(历史构造应成对产出),不是模型写错了。",
      );
    }
    appendWireMessage(out, message.role, message.content);
    index += 1;
  }
  return out;
};

const messagesBody: EndpointSpec["buildBody"] = (config, messages, params, request) => {
  const cacheControl = cacheControlOf(config);
  // Anthropic 没有 `role: "system"` 的消息:system 提示抽到顶层 `system` 字段,不进 `messages`。
  const systemParts: string[] = [];
  const dialog: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
    } else {
      dialog.push(message);
    }
  }

  const wire = messagesDialogue(dialog);
  // 断点打在前缀末尾:中间消息保持字符串载荷,只有最后一条消息的最后一个块挂标记。
  // 工具调用轮次里那条块就是 `tool_result`(字符串 content 挂不了 `cache_control`)。
  const last = wire[wire.length - 1];
  if (cacheControl !== undefined && last !== undefined) {
    const blocks =
      typeof last.content === "string"
        ? [{ type: "text", text: last.content }]
        : asArray(last.content).slice();
    const tail = blocks[blocks.length - 1];
    if (isRecord(tail)) {
      blocks[blocks.length - 1] = { ...tail, cache_control: cacheControl };
    }
    last.content = blocks;
  }

  const body: Record<string, unknown> = {
    model: config.modelId,
    max_tokens: typeof params.max_tokens === "number" ? params.max_tokens : DEFAULT_MAX_TOKENS,
    ...params,
    messages: wire,
    // 工具字段排在 `...params` 之后:与 chat 族同一条「协议压得过生成策略」的纪律。
    ...(request?.tools === undefined || request.tools.length === 0
      ? {}
      : {
          tools: messagesToolsField(request.tools),
          // 本族的 `tool_choice` 是**对象**,不是 chat 族那个字符串。
          tool_choice: { type: "auto" },
        }),
  };
  if (systemParts.length > 0) {
    const system = systemParts.join("\n\n");
    body.system =
      cacheControl === undefined
        ? system
        : [{ type: "text", text: system, cache_control: cacheControl }];
  }
  return body;
};

/**
 * 流式请求体 = 非流式请求体叠加 `stream: true`。
 *
 * 实测新中转在非流式下长时间不回响应头(网关等上游全量生成完才回),300s 空闲超时先到;
 * 同一请求开流式后首帧 6s 即到——「这条请求走流式」是端点族的传输决定,params 压不过本层。
 */
const messagesStreamBody: EndpointSpec["buildBody"] = (config, messages, params, request) => ({
  ...messagesBody(config, messages, params, request),
  stream: true,
});

/**
 * 逐帧累积 Anthropic SSE:正文只拼 `text_delta`,推理 `thinking_delta` / `signature_delta` 不进 `text`,
 * 而是拼回可回传的签名块（「签名回传」）；停止原因取 `message_delta` 的
 * `stop_reason`（与非流式同一归一表）；usage 把起止两处合并。
 *
 * 收尾认 `message_stop` 事件（Anthropic 流没有 `[DONE]`）,由 `done()` 告诉读流循环提前结束。
 */
const createMessagesAccumulator = (): StreamAccumulator => {
  let text = "";
  let rawStop: string | undefined;
  let usage: unknown;
  let stopped = false;
  const reasoning = messagesReasoningStream(MESSAGES_REASONING.carry);
  // 在途工具调用:键是渠道给的 `index`。`content_block_start` 那帧的 `input` 通常是 `{}`,
  // 真参数在后继 `input_json_delta` 的 `partial_json` 片段里,所以这里拼的是**原文**,
  // 等 `content_block_stop` 才用它当 `argumentsJson`(与非流式那条 `JSON.stringify(input)`
  // 不同:能给原文时给原文,本族迟早要解析,留原文至少不丢字节形状)。
  const calls = new Map<
    number,
    { id: string; name: string; startInput: Record<string, unknown>; partialJson: string }
  >();
  return {
    push: (frame) => {
      const root = asRecord(frame);
      const type = stringField(root, "type");
      const blockIndex = typeof root.index === "number" ? root.index : undefined;
      if (type === "content_block_start") {
        const block = asRecord(root.content_block);
        if (stringField(block, "type") === "tool_use") {
          calls.set(blockIndex ?? 0, {
            id: stringField(block, "id") ?? "",
            name: stringField(block, "name") ?? "",
            startInput: asRecord(block.input),
            partialJson: "",
          });
        } else {
          reasoning.pushStart(block);
        }
      } else if (type === "content_block_delta") {
        const delta = asRecord(root.delta);
        const deltaType = stringField(delta, "type");
        if (deltaType === "text_delta") {
          text += stringField(delta, "text") ?? "";
        } else if (deltaType === "input_json_delta") {
          // 必须先按 `delta.type` 分派再落袋:这条以前被「非 text_delta 一律当推理」吞掉。
          const current = calls.get(blockIndex ?? 0);
          if (current !== undefined) {
            current.partialJson += stringField(delta, "partial_json") ?? "";
          }
        } else {
          // `thinking_delta` / `signature_delta`:进不透明字段,不进正文。
          reasoning.pushDelta(delta);
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
    result: () => {
      const echo = reasoning.result();
      // 按 `index` 升序:Map 的插入序在「多个块交错返回」时不可靠,而档案里的顺序得与模型
      // 发起的顺序一致。与非流式同一条纪律:缺 `name` 的块丢掉(「说不出调了什么」不是动作)。
      const toolCalls: ToolCall[] = [...calls.entries()]
        .sort(([left], [right]) => left - right)
        .filter(([, call]) => call.name !== "")
        .map(([, call]) => ({
          name: call.name,
          // 没有 `input_json_delta` 就是「参数全在起始块里」(不收参数的工具就是这样):此时
          // 用起始块那份对象,别交一个空字符串——那是 `JSON.parse` 会炸的东西,而档案里这一格
          // 的名字叫「原始 JSON 字符串」。有 delta 时 delta 才是真参数。
          argumentsJson:
            call.partialJson === "" ? JSON.stringify(call.startInput) : call.partialJson,
        }));
      return {
        text,
        finishReason:
          rawStop === undefined ? "unknown" : (MESSAGES_STOP_REASONS[rawStop] ?? rawStop),
        usage,
        stopDetails: rawStop === undefined ? {} : { reason: rawStop },
        ...(echo === undefined ? {} : { reasoning: echo }),
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
      };
    },
    done: () => stopped,
  };
};

const parseMessages: EndpointSpec["parseResponse"] = (json) => {
  const root = asRecord(json);
  const content = asArray(root.content);
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text") {
      text += stringField(block, "text") ?? "";
      continue;
    }
    if (block.type === "tool_use") {
      const name = stringField(block, "name");
      // 缺 `name` 的块丢掉:与 chat 族 `toolCallsOf` 同一条纪律(凑空名字只会把上游的呲
      // 变成下游的 `unknown-tool`)。
      if (name === undefined) continue;
      // 本族的 `input` 是对象,没有原文字节可取——`JSON.stringify` 是这里唯一能做的事,
      // 因此本族的逐字性只能保住「解析成功的那份对象」( 2026-11-21 修订段)。
      toolCalls.push({ name, argumentsJson: JSON.stringify(block.input ?? {}) });
    }
  }
  const rawStop = stringField(root, "stop_reason");
  const finishReason =
    rawStop === undefined ? "unknown" : (MESSAGES_STOP_REASONS[rawStop] ?? rawStop);
  const echo = MESSAGES_REASONING.read(root);
  return {
    text,
    finishReason,
    usage: root.usage,
    stopDetails: rawStop === undefined ? {} : { reason: rawStop },
    ...(echo === undefined ? {} : { reasoning: echo }),
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
  };
};

// ── responses(OpenAI Responses API)──────────────────────────────────────────

/**
 * responses 族的一条消息展开成的 input 条目。
 *
 * 没有推理时就是一条普通消息;带加密推理条目时，条目排在它自己之前（端点要求）。
 */
const responsesWireItems = (message: ChatMessage): unknown[] => {
  const item = toWireMessage(message);
  return message.reasoning === undefined
    ? [item]
    : writeResponsesReasoning(message.reasoning, item, RESPONSES_REASONING.carry);
};

const responsesBody: EndpointSpec["buildBody"] = (config, messages, params) => {
  for (const message of messages) {
    // 同上族:`responses` 的工具形状（`function_call` 条目 + `output` 里的 `function_call_output`）
    // 同样**零证据**，所以本族不声明工具能力。上层应该起跑前拒跑，这里只防「静默发出非法 body」。
    if (message.role === "tool") {
      throw new Error(
        'responses 族不支持工具调用（未声明工具能力）:收到 role:"tool" 的观测消息，' +
          "这是 agent 会话的接线错误。",
      );
    }
  }
  return {
    model: config.modelId,
    ...params,
    input: messages.flatMap(responsesWireItems),
  };
};

const parseResponses: EndpointSpec["parseResponse"] = (json) => {
  const root = asRecord(json);
  const output = asArray(root.output);
  let text = "";
  for (const item of output) {
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
  const echo = RESPONSES_REASONING.read(root);
  return {
    text,
    finishReason,
    usage: root.usage,
    stopDetails: {
      ...(status === undefined ? {} : { status }),
      ...(incompleteReason === undefined ? {} : { reason: incompleteReason }),
    },
    ...(echo === undefined ? {} : { reasoning: echo }),
  };
};

// ── generate-content(Google Gemini 系)────────────────────────────────

/**
 * Gemini 的 `finishReason` / `promptFeedback.blockReason` 归一。
 *
 * 预算截断是 `MAX_TOKENS → "length"`(重试层只认它);安全/内容类停止统一成 `content_filter`,
 * 与 chat-completions 的同名词汇对齐,但**不**冒充预算截断。表外原值透传,原值另存 `stopDetails.reason`。
 */
const GENERATE_CONTENT_STOP_REASONS: Record<string, string> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  BLOCKLIST: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  IMAGE_SAFETY: "content_filter",
};

/** 停止原因:候选的 `finishReason` 优先;整段被拒(无候选)时退到 `promptFeedback.blockReason`。 */
const generateContentRawStop = (root: Record<string, unknown>): string | undefined =>
  stringField(asRecord(asArray(root.candidates)[0]), "finishReason") ??
  stringField(asRecord(root.promptFeedback), "blockReason");

const normalizeGenerateContentStop = (rawStop: string | undefined): string =>
  rawStop === undefined ? "unknown" : (GENERATE_CONTENT_STOP_REASONS[rawStop] ?? rawStop);

const generateContentStopDetails = (
  rawStop: string | undefined,
): NonNullable<ModelResponse["stopDetails"]> => (rawStop === undefined ? {} : { reason: rawStop });

/**
 * 拼一个候选的正文。
 *
 * 推理段(`part.thought: true`)**不进产物**——与 chat 的 `reasoning_content`、messages 的
 * `thinking_delta` 同一条纪律:半截思维链不进盘、不回喂。一个候选也可能带多段,按顺序拼。
 */
const generateContentText = (candidate: Record<string, unknown>): string => {
  let text = "";
  for (const part of asArray(asRecord(candidate.content).parts)) {
    if (!isRecord(part) || part.thought === true) {
      continue;
    }
    text += stringField(part, "text") ?? "";
  }
  return text;
};

/**
 * `generationConfig` 的键是 Google 原生拼写(采样参数原样透传),只把 gen 的中立输出预算
 * `max_output_tokens` 翻成 `maxOutputTokens`。
 */
const generateContentConfig = (params: ModelParams): Record<string, unknown> => {
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    config[key === "max_output_tokens" ? "maxOutputTokens" : key] = value;
  }
  return config;
};

/**
 * Google 的请求体形状:system 抽到顶层 `systemInstruction`,对话进 `contents`,角色只有
 * `user` / `model`(没有 `assistant` / `system`),生成参数进 `generationConfig`。
 *
 * 同一角色的连续轮次合并成一条 `content` 的**多段**:协议要求 user/model 交替,而多轮回喂
 * 可能连着发两条同角色消息——合并同义于顺序拼接,比让上游回 400 更接近本意。
 */
const generateContentBody: EndpointSpec["buildBody"] = (_config, messages, params) => {
  const systemParts: string[] = [];
  const contents: { role: string; parts: { text: string }[] }[] = [];
  for (const message of messages) {
    // 本族不声明工具能力（今日零证据）。`tool` 角色在这里会被下面的 `?? "user"` 静默折成
    // 一条 user 消息——那是**发得出去但意思错了**的 body，比 400 更难查。所以当场抬错。
    if (message.role === "tool") {
      throw new Error(
        'generate-content 族不支持工具调用（未声明工具能力）:收到 role:"tool" 的观测消息，' +
          "这是 agent 会话的接线错误。",
      );
    }
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }
    const role = message.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last !== undefined && last.role === role) {
      last.parts.push({ text: message.content });
    } else {
      contents.push({ role, parts: [{ text: message.content }] });
    }
  }

  const generationConfig = generateContentConfig(params);
  return {
    ...(systemParts.length === 0
      ? {}
      : { systemInstruction: { parts: [{ text: systemParts.join("\n\n") }] } }),
    contents,
    // 无参数时不发空对象:没有预算/采样意图就不该在请求里留下一个空壳。
    ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig }),
  };
};

/**
 * 逐帧累积 Gemini 流:正文拼 `parts[].text`(跳过 `thought`),停止原因取最后一个非空值,
 * usage 取最后一个非空 `usageMetadata`(累计式,最后一帧最全)。
 *
 * 这条族**既没有 `[DONE]` 也没有原生收尾事件**:上游在最后一帧后直接关连接。故不提供
 * `done()`,由 `endsOnStreamClose` 告诉读流循环「EOF 即收尾」。
 */
const createGenerateContentAccumulator = (): StreamAccumulator => {
  let text = "";
  let rawStop: string | undefined;
  let usage: unknown;
  return {
    push: (frame) => {
      const root = asRecord(frame);
      text += generateContentText(asRecord(asArray(root.candidates)[0]));

      // 与 chat 一样只被「最后一个非空值」覆盖:上游可能在收尾前重发同一个停止原因。
      const frameStop = generateContentRawStop(root);
      if (frameStop !== undefined && frameStop.length > 0) {
        rawStop = frameStop;
      }

      if (root.usageMetadata !== undefined && root.usageMetadata !== null) {
        usage = root.usageMetadata;
      }
    },
    result: () => ({
      text,
      finishReason: normalizeGenerateContentStop(rawStop),
      usage,
      stopDetails: generateContentStopDetails(rawStop),
    }),
  };
};

const parseGenerateContent: EndpointSpec["parseResponse"] = (json) => {
  const root = asRecord(json);
  const rawStop = generateContentRawStop(root);
  return {
    text: generateContentText(asRecord(asArray(root.candidates)[0])),
    finishReason: normalizeGenerateContentStop(rawStop),
    usage: root.usageMetadata,
    stopDetails: generateContentStopDetails(rawStop),
  };
};

/** 取一条端点族的翻译规则。新增一族才需要在这里动分支。 */
export const endpointSpec = (family: EndpointFamily): EndpointSpec => {
  switch (family) {
    case "chat-completions":
      return {
        path: () => "/chat/completions",
        buildBody: chatCompletionsBody,
        parseResponse: parseChatCompletions,
        reasoning: CHAT_REASONING,
        // 本族的工具读法被**真实响应**验证过(2026-11-20 的两个席位各一条,证据在票 01 尾)。
        // 它是四族里唯一声明工具能力的一族。
        tools: { shape: "function-json-schema" },
        streaming: {
          buildBody: chatCompletionsStreamBody,
          createAccumulator: createChatCompletionsAccumulator,
        },
      };
    case "messages":
      return {
        path: () => "/messages",
        buildBody: messagesBody,
        parseResponse: parseMessages,
        reasoning: MESSAGES_REASONING,
        // 工具翻译已接上(协议事实见 `probes/messages-tool-roundtrip/`)。形状与 chat 族不是
        // 一份翻译:声明是 `{name, description, input_schema}`,结果在 `content[]` 的
        // `tool_use` 块里,观测是 `role:"user"` + `tool_result` 块。
        tools: { shape: "anthropic-input-schema" },
        streaming: {
          buildBody: messagesStreamBody,
          createAccumulator: createMessagesAccumulator,
        },
      };
    case "responses":
      return {
        path: () => "/responses",
        buildBody: responsesBody,
        parseResponse: parseResponses,
        reasoning: RESPONSES_REASONING,
      };
    case "generate-content":
      return {
        path: (config) => `/models/${config.modelId}:generateContent`,
        buildBody: generateContentBody,
        parseResponse: parseGenerateContent,
        reasoning: GENERATE_CONTENT_REASONING,
        streaming: {
          // Google 把「流式」写进路径而不是 body;`alt=sse` 才把分块响应当 SSE 返回。
          path: (config) => `/models/${config.modelId}:streamGenerateContent?alt=sse`,
          buildBody: generateContentBody,
          createAccumulator: createGenerateContentAccumulator,
          endsOnStreamClose: true,
        },
      };
  }
};
