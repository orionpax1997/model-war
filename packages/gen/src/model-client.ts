/**
 * 模型客户端端口(hld §2.2.6):生成管线与"某家厂商的 HTTP 形状"之间**唯一**的缝。
 *
 * ── 为什么是端口而不是直接写 HTTP 调用 ──
 *
 * FR-5 的协议(≤N 轮、只回喂静态校验错误)要在无网络无凭证的 CI 里被长期回归测试。
 * 若管线直接 new 一个 HTTP 客户端,测试就只剩两条路:打真厂商(要凭证、要网络)或 mock
 * `fetch`(断言落在"我们怎么拼 URL"这种实现细节上)。把「发一条消息、拿回一段文本」抽成
 * 接口后,协议本身可以喂一个**可编程桩**来钉住,而 HTTP 形状留到票 08 用本地假端点单测。
 *
 * ── 为什么响应里有 `usage` / `finishReason` ──
 *
 * 两者都要逐轮落进 `meta.generationLog`(hld §2.2.6 的生成日志行),而且 `finishReason`
 * 还决定「这轮是不是被截断了、要不要重试同一轮」(票 06)。它们归端口的返回载荷所有,
 * 由真实适配器(票 08)从三家端点族的响应里映射成**同一个形状**——
 * 截断一律归一成 `"length"`(OpenAI 本就是 `"length"`,Anthropic 的 `"max_tokens"` 由 08 映射)。
 */

/** 一条消息的角色。三个取值与三家端点族的共同子集一致(票 08 只做方言翻译,不扩取值域)。 */
export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  readonly role: ChatRole;
  readonly content: string;
};

/**
 * 一次请求的模型参数(temperature / max_tokens 之类)。
 *
 * 形状是开放的键值对,而不是逐字段类型:参数是**厂商/端点族相关的工程细节**,不在 schema
 * 的五类数据形状里,也不进规则集;gen 只把它原样透传给适配器并记进生成日志。
 */
export type ModelParams = Readonly<Record<string, unknown>>;

export type ModelResponse = {
  readonly text: string;
  /** 截断一律归一成 `"length"`(OpenAI 是 `"length"`,Anthropic 的 `"max_tokens"` 由 08 映射过来) */
  readonly finishReason: string;
  readonly usage: unknown;
};

/** 一次生成调用的端口。实现 = HTTP 适配器(票 08)或可编程桩(测试与本地演练)。 */
export interface ModelClient {
  send(messages: readonly ChatMessage[], params: ModelParams): Promise<ModelResponse>;
}
