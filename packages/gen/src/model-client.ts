/**
 * 模型客户端端口(hld §2.2.6):生成管线与"某家厂商的 HTTP 形状"之间**唯一**的缝。
 *
 * ── 为什么是端口而不是直接写 HTTP 调用 ──
 *
 * 生成协议(≤N 轮、只回喂静态校验错误)要在无网络无凭证的 CI 里被长期回归测试。
 * 若管线直接 new 一个 HTTP 客户端,测试就只剩两条路:打真厂商(要凭证、要网络)或 mock
 * `fetch`(断言落在"我们怎么拼 URL"这种实现细节上)。把「发一条消息、拿回一段文本」抽成
 * 接口后,协议本身可以喂一个**可编程桩**来钉住,而 HTTP 形状留给
 * `packages/gen/src/http/client.ts` 用本地假端点单测。
 *
 * ── 为什么响应里有 `usage` / `finishReason` ──
 *
 * 两者都要逐轮落进 `meta.generationLog`(hld §2.2.6 的生成日志行),而且 `finishReason`
 * 还决定「这轮是不是被截断了、要不要重试同一轮」(`packages/gen/src/retry.ts`)。它们归端口的返回载荷所有,
 * 由真实适配器(`packages/gen/src/http/client.ts`)从四家端点族的响应里映射成**同一个形状**——
 * 截断一律归一成 `"length"`(OpenAI 本就是 `"length"`,Anthropic 的 `"max_tokens"` 由 08 映射)。
 */

import type { ToolCall, ToolDeclaration } from "./agent/tools.js";

/**
 * 这一族怎么把推理带回去(「reasoning 按端点族分家」)。
 *
 * 它是**能力声明**而不是调用点上的条件分支:每族声明自己那一种,别处一律不判断族名。
 */
export type ReasoningCarry =
  /** `messages` 族:thinking 块连签名原样回传;缺签名的块丢弃。 */
  | "signed"
  /** `chat-completions` / `responses` 族:加密条目不透明回传。 */
  | "encrypted"
  /** 该族没有可回传的东西:推理内容一律丢。 */
  | "drop";

/**
 * 跨步带回的推理,一个**不透明**字段。
 *
 * ── 为什么是不透明 ──
 *
 * 签名与加密块对 loop、档案、报告都是无意义的字节,只有产出它的那一族端点知道它该以什么
 * 形状带回去。解释者只有一处(`http/reasoning.ts`),其余各站(历史、`ChatMessage`)只负责
 * 原样搬运——所以这里的 `blocks` 是 `unknown[]`,不给它编一个本仓的形状。
 *
 * ── 它不落档案、不进历史文本 ──
 *
 * 加密块进档案既涨体积又没有读侧用途,而读侧回放不需要推理连续性。它只住在 `ChatMessage`
 * 与 `ModelResponse` 上,随消息走完这一场会话。
 */
export type ReasoningEcho = {
  /** 产出它的那一族的策略(见 `ReasoningCarry`)。 */
  readonly carry: ReasoningCarry;
  /** 该族自己的条目,原样回送。 */
  readonly blocks: readonly unknown[];
  /** 生产侧丢掉的块数(如缺签名的 thinking);只作诊断,不进历史文本。 */
  readonly dropped: number;
};

/**
 * 一条消息的角色。真实适配器只做方言翻译,不扩取值域。
 *
 * ── 为什么 `tool` 也在里面 ──
 *
 * 它是观测消息的信封:协议从「吐围栏块」改成「吐工具调用」之后,`user` 那一档是错的——上一轮
 * assistant 只说了一次调用、没说人话,后面跟一条 `user` 会让历史读起来像自言自语。四族里只有
 * `chat-completions` 声明了工具能力(见 `EndpointSpec.tools`),别的族遇到 `tool` 角色一律在
 * **发请求之前**拒跑,而不是发一个上游认不出的 body。
 */
export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessage = {
  readonly role: ChatRole;
  readonly content: string;
  /**
   * 仅 assistant 消息有意义:上一轮响应带回来的推理,原样随消息走。
   *
   * 可选键,**不写空壳**:没有可回传的东西时这一格缺席(历史里的消息因此仍是 `{role, content}`)。
   */
  readonly reasoning?: ReasoningEcho;
  /**
   * assistant 那一轮实际发起的工具调用,**原样**回传(含 `argumentsJson` 的逐字字节)。
   *
   * 它是「模型看到的字节 = 落盘的字节」在工具调用轮次里的载体:`content` 那边常常是空串
   * (`finish_reason: "tool_calls"` 时渠道不回正文),真正的产物在这一格。
   */
  readonly toolCalls?: readonly ToolCall[];
  /**
   * **配对基准 id**:assistant 的 `tool_calls[i].id` 与 `tool` 消息的 `tool_call_id` 由它派生。
   *
   * 值是历史构造处确定性派生的 `call-<步号>`,不复用渠道 id(渠道 id 每次不同,是进档案与 digest
   * 路径的无意义字节;而 id 的唯一用途是让 assistant 与 `tool` 消息在自己的历史里配对)。
   *
   * 两处都要它而不是只在 `tool` 那一条:渠道把 `tool_calls[0].id` 判为**必填**
   * (缺它 `400 messages.N.tool_calls.0.id expected string`),而配对关系本身服务端不校验。
   * 所以两个 id 必须由同一处给出,否则就是两个会分叉的事实。
   */
  readonly toolCallId?: string;
};

/**
 * 一次请求的模型参数(temperature / max_tokens 之类)。
 *
 * 形状是开放的键值对,而不是逐字段类型:参数是**厂商/端点族相关的工程细节**,不在 schema
 * 的五类数据形状里,也不进规则集。旧配置透传；规范配置由 generationPolicy 校验、
 * 映射为冻结参数，适配器在请求前复核，再记进生成日志。
 */
export type ModelParams = Readonly<Record<string, unknown>>;

export type ModelResponse = {
  readonly text: string;
  /**
   * 这一轮发起的工具调用(可能一格都没有)。
   *
   * 与 `text` **并列**,不改名、不合并:模型可能同时说话与调用(实测 `hy4-flash` 在
   * `finish_reason: "tool_calls"` 时 `content` 是一段短文本),也可能只调用(`mimo-v2.6-flash`
   * 那边 `content: null`)。两个键各自承载一种产物,读侧按需取。
   */
  readonly toolCalls?: readonly ToolCall[];
  /** 输出预算截断归一成 "length"，缺停止字段为 "unknown"；其他状态不冒充截断。 */
  readonly finishReason: string;
  readonly usage: unknown;
  /** 协议原停止状态与原因；归一化 finishReason 仅用于既有重试判据。 */
  readonly stopDetails?: { readonly status?: string; readonly reason?: string };
  /** 这一次响应带回的推理(不透明,见 `ReasoningEcho`);该族没有可回传的东西时缺席。 */
  readonly reasoning?: ReasoningEcho;
};

/**
 * 一次 `send` 的**逐请求面**:两台东西——终止控制,与会话的工具声明。
 *
 * ── 工具声明为什么从这条缝进来(而不是 `params` 或一个新的位置参数) ──
 *
 * 不放 `params`:那个类型是**生成策略的产出面**(`generationParams()` 的每一个键都是「怎么采样」),
 * 让工具声明从那里进来,生成策略就能意外改掉协议——于是「换 harness」与「调一个参数」在代码里
 * 长得一模一样(票 01 的 `EndpointRequest` 头注写着同一件事)。
 *
 * 不新增第四个位置参数:`send(messages, params, options?, tools?)` 会让「没有控制面」的那一档
 * 必须写 `send(m, p, undefined, tools)` 这种占位。占位参数正是协议改动最容易被当成排版的地方
 * ——它看不见、但每个实现与每个测试都得跟着数逗号。`options` 已经是「这一次请求的附加面」,
 * 工具声明就属于那个面。
 */
export type SendOptions = {
  /**
   * 会话总墙钟到点:**进行中的调用必须真的被打断**。
   *
   * ── 为什么这条必须存在 ──
   *
   * 空闲超时挡不住「持续慢慢吐 token」——每读到一段数据就重置,于是一次调用可以合法地跑很久。
   * 实测到的形状:`archive/mimo-v2.6-flash/2026-11-18T08-12-18-087Z` 两次调用各吃 816 s / 928 s
   * (全是 reasoning token),1800 s 的总预算就这么没了,而会话是在第 15 步**步与步之间**
   * 才发现「预算已经用完」。所以预算必须能在调用**进行中**收口。
   *
   * 实现方应当把它接到底层请求(HTTP 适配器直接并进 `fetch` 的 signal),而不是只在入口查一次。
   */
  readonly signal?: AbortSignal;
  /**
   * 本会话的工具声明(见 `agent/tools.ts` 的 `AGENT_TOOLS`)。缺席 = 不带 `tools` 发请求。
   *
   * 只有声明了工具能力的端点族(`EndpointSpec.tools`)接受它;别族传它是一次**接线错误**,
   * 由适配器与 `pipeline.ts` 的起跑前拒跑两道防线报出来。
   */
  readonly tools?: readonly ToolDeclaration[];
};

/** 一次生成调用的端口。实现 = HTTP 适配器(`packages/gen/src/http/client.ts`)或可编程桩(测试与本地演练)。 */
export interface ModelClient {
  send(
    messages: readonly ChatMessage[],
    params: ModelParams,
    options?: SendOptions,
  ): Promise<ModelResponse>;
}
