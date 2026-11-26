/**
 * 传输层错误(契约 §2.1):HTTP 适配器(`packages/gen/src/http/client.ts`)抛出,退避重试
 * (`packages/gen/src/retry.ts`)据此分类。
 *
 * ── 为什么单独一个类,而不是复用 `Error` + 读 `message` ──
 *
 * 「这一轮该不该重发」是**可判定的**:429 / 5xx / 网络失败 / 超时是同一类(重发可能成功),
 * 其余 4xx 是另一类(重发只是浪费)。把这条判据编进一个 `retryable` 字段,重试层就不必去解析
 * 各家端点族五花八门的错误文案;字段名与语义被契约钉死,`packages/gen/src/retry.ts` 直接 `import` 它。
 *
 * ── 截断不走这里 ──
 *
 * 模型输出被截断(`finishReason === "length"`)不是传输失败,它在端口返回形状里表达,
 * 由 `packages/gen/src/retry.ts` 的另一条分支处理。把两件事混进同一个异常会让「重试耗尽」的失败分类失真。
 */

/**
 * 传输失败的**细分**:四种,厂商无关,由 `status` / `timedOut` 判定而来。
 *
 * 它比 `retryable` 粗一级、比状态码粗得更多:读侧要的是「这是什么性质的事」,不是「哪个号段」。
 * 两个字段各管一件事——`retryable` 是**事实**(重发可能成功吗),这一条是**性质**(谁的问题)。
 * 两者不重合正是本仓库需要策略层的理由:5xx 是 `retryable: true` 但按裁决不重试。
 */
export type TransportFailureKind = "rate-limited" | "server" | "network" | "timeout";

/** `TransportError` 的构造参数。`status` 仅在拿到了 HTTP 状态码时给(网络失败 / 超时没有)。 */
export type TransportErrorOptions = {
  /** true = 重发同一轮可能成功(429 / 5xx / 网络失败 / 超时);false = 重发无益(其余 4xx)。 */
  readonly retryable: boolean;
  /** HTTP 状态码;网络失败与超时时缺席。 */
  readonly status?: number;
  /** 无状态码时的细分:空闲超时(true)还是连接级失败(缺席)。有状态码时被 `status` 覆盖。 */
  readonly timedOut?: boolean;
  /** 服务端 `Retry-After` 换算成的毫秒数;缺席 = 服务端没给这条提示。 */
  readonly retryAfterMs?: number;
};

/**
 * 传输层失败:429 / 5xx / 网络失败 / 超时 → `retryable: true`;其余 4xx → `retryable: false`。
 *
 * **绝不携带凭证**:调用方拼消息时只许写 URL、状态码与响应体片段,不准把 `Authorization` 的值带进来。
 */
export class TransportError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly timedOut: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, options: TransportErrorOptions) {
    super(message);
    this.name = "TransportError";
    this.retryable = options.retryable;
    this.timedOut = options.timedOut === true;
    // `exactOptionalPropertyTypes` 下可选属性要么缺席、要么是 number:只在真拿到时挂上。
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

/**
 * 传输失败的细分判定:状态码能说话时听状态码,不能说话时才看 `timedOut`。
 *
 * 429 与 5xx **不共用**一档——前者是「服务端还好,只是现在不给你」,后者是「服务端自己坏了」;
 * 这条界线就是「等一等有没有意义」的判据。
 */
export const transportFailureKindOf = (cause: TransportError): TransportFailureKind => {
  if (cause.status === 429) {
    return "rate-limited";
  }
  if (cause.status !== undefined && cause.status >= 500) {
    return "server";
  }
  return cause.timedOut ? "timeout" : "network";
};
