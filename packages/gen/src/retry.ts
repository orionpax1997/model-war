/**
 * 传输韧性:把「发一次」包成「发到成功或耗尽」(hld §2.2.6 / §7.4;契约 §2.1 / §4;票 06)。
 *
 * ── 为什么重试层在 `send` 之外,而不是让每个适配器自己退避 ──
 *
 * 「这一轮该不该重发」是一条**与厂商无关的判据**:429 / 5xx / 网络失败 / 超时都可能重发成功,
 * 其余 4xx 只是浪费。票 08 的适配器只负责把 HTTP 方言翻译成 `TransportError{retryable}` 或
 * `ModelResponse`,退避策略收在这里一处;三个端点族共享同一套重试语义,不必各写一份。
 *
 * ── 截断为什么和传输错误共用一个预算 ──
 *
 * `finishReason === "length"` 时模型给的是半截代码:它不是产物,也**绝不能**回喂(回喂等于
 * 把一段编译不过的半截文本当「上一轮模型回文本」),于是它也走「同一轮重发」。截断与
 * 429/5xx/超时是两种不同的失败,但对待方式相同(都重发同一轮、都不消耗协议轮数),所以共用
 * 同一个重试预算。
 *
 * ── 不消耗协议轮数 ──
 *
 * 协议轮(`protocolRounds`)只数「校验驱动的迭代」。重试发生在**一次 `send` 之内**:messages
 * 不变、不追加、不写生成日志,退避重发成功与否都不涨协议轮数。`pipeline.ts` 只把本包装的
 * **成功**结果当作一轮的响应。
 *
 * ── 退避是工程参数,不进规则集 ──
 *
 * 退避参数(初始间隔 / 倍数 / 上限 / 最大重试)是 **gen 内部常量**:它们是运行韧性参数,不描述
 * 任何对局规则,因此**不进 `rulesets/*.json`**——规则集的真源只放规则侧取值,别把工程参数混进去。
 */

import type { ModelResponse } from "./model-client.js";
import { TransportError } from "./transport-error.js";

/**
 * 指数退避参数(**工程参数,不进 `rulesets/*.json`**)。
 *
 * 第 n 次重试(1 起)前等 `min(initialDelayMs × multiplier^(n-1), maxDelayMs)` 毫秒;最多重发
 * `maxRetries` 次(不含首次),即一次 `send` 最多尝试 `maxRetries + 1` 次。
 */
export const RETRY = {
  /** 首次重试前的等待(毫秒)。 */
  initialDelayMs: 500,
  /** 每次退避的倍数。 */
  multiplier: 2,
  /** 单次等待的封顶(毫秒),防止重试越往后等得越离谱。 */
  maxDelayMs: 8_000,
  /** 最多重发几次(不含首次);耗尽记为传输失败。 */
  maxRetries: 3,
} as const;

/** 第 `retry` 次重试(1 起)前的等待毫秒数:`initial × multiplier^(retry-1)`,封顶 `maxDelayMs`。 */
export const retryDelayMs = (retry: number): number =>
  Math.min(RETRY.initialDelayMs * RETRY.multiplier ** (retry - 1), RETRY.maxDelayMs);

/** 等待实现。测试注入一个只记录、不真等的实现,断言退避序列而不用真等几秒。 */
export type RetrySleep = (ms: number) => Promise<void>;

const realSleep: RetrySleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 端口把三家端点族的截断归一到 `"length"`(契约 §2.1):它是「重发同一轮」的判据。 */
export const isTruncated = (response: ModelResponse): boolean => response.finishReason === "length";

/** 重试耗尽 / 不可重试的收口形状。`pipeline.ts` 据它拼出 `transport` 分类的失败。 */
export type TransportFailure = {
  /** 实际尝试次数(含首次);不可重试时恒为 1。 */
  readonly attempts: number;
  /** 每次失败 / 截断各一条诊断,按发生序。 */
  readonly diagnostics: readonly string[];
  /** 一行人类可读原因。 */
  readonly message: string;
};

export type RetryOutcome =
  | { readonly ok: true; readonly response: ModelResponse }
  | { readonly ok: false; readonly failure: TransportFailure };

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** 一条诊断:区分「传输错误(带状态码更好定位)」与「非传输错误(缺凭证等普通 Error)」。 */
const describeError = (cause: unknown): string => {
  if (cause instanceof TransportError) {
    return cause.status === undefined
      ? `传输错误:${cause.message}`
      : `传输错误(HTTP ${String(cause.status)}):${cause.message}`;
  }
  return `非传输错误:${messageOf(cause)}`;
};

/**
 * 发到成功或耗尽。
 *
 * - `retryable === true` 的 `TransportError`(429 / 5xx / 网络失败 / 超时)与截断
 *   (`finishReason === "length"`)→ 指数退避重发**同一轮**(同一份 messages),最多 `maxRetries`
 *   次。
 * - `retryable === false` 的 `TransportError`(400 等)与普通 `Error`(缺凭证)→ **立即**收口,
 *   不重发:重发只是浪费,凭证问题更不会因重发而消失。
 * - 耗尽 / 不可重试都不抛异常,统一以 `{ ok:false, failure }` 返回,由调用方转成 `transport` 失败
 *   (不是"崩了这一批")。
 */
export const retryTransport = async (options: {
  readonly send: () => Promise<ModelResponse>;
  /** 注入的等待实现;缺省真等(`realSleep`)。 */
  readonly sleep?: RetrySleep;
}): Promise<RetryOutcome> => {
  const sleep = options.sleep ?? realSleep;
  const diagnostics: string[] = [];
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const response = await options.send();
      if (!isTruncated(response)) {
        return { ok: true, response };
      }
      // 截断:半截代码直接丢掉,不回喂、不当产物;与传输错误共用重试预算。
      diagnostics.push(`第 ${String(attempt)} 次响应被截断(finishReason=length),丢弃并重发同一轮`);
    } catch (cause) {
      if (!(cause instanceof TransportError) || !cause.retryable) {
        diagnostics.push(describeError(cause));
        return {
          ok: false,
          failure: {
            attempts: attempt,
            diagnostics,
            message: `不可重试的错误:${messageOf(cause)}`,
          },
        };
      }
      diagnostics.push(describeError(cause));
    }

    if (attempt > RETRY.maxRetries) {
      return {
        ok: false,
        failure: {
          attempts: attempt,
          diagnostics,
          message: `重试 ${String(RETRY.maxRetries)} 次后仍失败(共 ${String(attempt)} 次尝试)`,
        },
      };
    }
    await sleep(retryDelayMs(attempt));
  }
};
