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

/** 一条消息的角色。三个取值与四家端点族的共同子集一致(真实适配器只做方言翻译,不扩取值域)。 */
export type ChatRole = "system" | "user" | "assistant";

/**
 * 这一族怎么把推理带回去(ADR-0032「reasoning 按端点族分家」)。
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

export type ChatMessage = {
  readonly role: ChatRole;
  readonly content: string;
  /**
   * 仅 assistant 消息有意义:上一轮响应带回来的推理,原样随消息走。
   *
   * 可选键,**不写空壳**:没有可回传的东西时这一格缺席(历史里的消息因此仍是 `{role, content}`)。
   */
  readonly reasoning?: ReasoningEcho;
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
  /** 输出预算截断归一成 "length"，缺停止字段为 "unknown"；其他状态不冒充截断。 */
  readonly finishReason: string;
  readonly usage: unknown;
  /** 协议原停止状态与原因；归一化 finishReason 仅用于既有重试判据。 */
  readonly stopDetails?: { readonly status?: string; readonly reason?: string };
  /** 这一次响应带回的推理(不透明,见 `ReasoningEcho`);该族没有可回传的东西时缺席。 */
  readonly reasoning?: ReasoningEcho;
};

/** 一次 `send` 的控制面。目前只有「中止」,而它不是可选项:见 `SendOptions.signal`。 */
export type SendOptions = {
  /**
   * 会话总墙钟到点(ADR-0029/0035):**进行中的调用必须真的被打断**。
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
};

/** 一次生成调用的端口。实现 = HTTP 适配器(`packages/gen/src/http/client.ts`)或可编程桩(测试与本地演练)。 */
export interface ModelClient {
  send(
    messages: readonly ChatMessage[],
    params: ModelParams,
    options?: SendOptions,
  ): Promise<ModelResponse>;
}
