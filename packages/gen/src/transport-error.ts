/**
 * 传输层错误(契约 §2.1):票 08 的 HTTP 适配器抛出,票 06 的退避重试据此分类。
 *
 * ── 为什么单独一个类,而不是复用 `Error` + 读 `message` ──
 *
 * 「这一轮该不该重发」是**可判定的**:429 / 5xx / 网络失败 / 超时是同一类(重发可能成功),
 * 其余 4xx 是另一类(重发只是浪费)。把这条判据编进一个 `retryable` 字段,重试层就不必去解析
 * 各家端点族五花八门的错误文案;字段名与语义被契约钉死,票 06 直接 `import` 它。
 *
 * ── 截断不走这里 ──
 *
 * 模型输出被截断(`finishReason === "length"`)不是传输失败,它在端口返回形状里表达,
 * 由票 06 的另一条分支处理。把两件事混进同一个异常会让「重试耗尽」的失败分类失真。
 */

/** `TransportError` 的构造参数。`status` 仅在拿到了 HTTP 状态码时给(网络失败 / 超时没有)。 */
export type TransportErrorOptions = {
  /** true = 重发同一轮可能成功(429 / 5xx / 网络失败 / 超时);false = 重发无益(其余 4xx)。 */
  readonly retryable: boolean;
  /** HTTP 状态码;网络失败与超时时缺席。 */
  readonly status?: number;
};

/**
 * 传输层失败:429 / 5xx / 网络失败 / 超时 → `retryable: true`;其余 4xx → `retryable: false`。
 *
 * **绝不携带凭证**:调用方拼消息时只许写 URL、状态码与响应体片段,不准把 `Authorization` 的值带进来。
 */
export class TransportError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: TransportErrorOptions) {
    super(message);
    this.name = "TransportError";
    this.retryable = options.retryable;
    // `exactOptionalPropertyTypes` 下可选属性要么缺席、要么是 number:只在真拿到状态码时挂上。
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}
