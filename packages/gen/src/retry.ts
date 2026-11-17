/**
 * 传输韧性:把「发一次」包成「发到成功或到上限」(hld §2.2.6 / §7.4;契约 §2.1 / §4;ADR-0036)。
 *
 * ── 为什么重试层在 `send` 之外,而不是让每个适配器自己退避 ──
 *
 * 「这一轮该不该重发」是一条**与厂商无关的判据**:429 / 网络失败 / 超时都可能重发成功,
 * 其余 4xx 只是浪费。真实适配器(`packages/gen/src/http/client.ts`)只负责把 HTTP 方言翻译成
 * `TransportError{retryable, status, timedOut, retryAfterMs}` 或 `ModelResponse`,退避策略收在这里一处;
 * 四个端点族共享同一套重试语义,不必各写一份。
 *
 * ── 三套预算,互不侵占(ADR-0036) ──
 *
 * 原先只有一套预算,429 / 5xx / 网络失败 / 截断都从里面取号。agent 形态把每模型的调用数从 ~15
 * 抬到 30–60,「一次 429 花掉了本该留给网络抖动的耐心」这件事从理论变成常态,所以拆成三类:
 *
 * | 类别 | 语义 | 策略 |
 * |---|---|---|
 * | `rate-limited`(429) | 服务端还好,只是现在不给你 | 长预算 + 听 `Retry-After` + 抖动 |
 * | `connection`(网络失败 / 空闲超时) | 无语义的抖动 | 两枪,`1s → 2s` |
 * | `truncated`(`finishReason=length`) | 模型的输出形状,不是传输失败 | 一枪(ADR-0032) |
 *
 * **5xx 不在这张表里**——它 `retryable: true`(事实:重发可能成功),但按裁决**不重试**:
 * 服务端自己坏了,重发只是撞同一堵墙。事实与策略因此分开住:`TransportError.retryable` 不撒谎,
 * 是否值得等由本文件的 `classifyCause` 决定。
 *
 * ── 不消耗协议轮数 ──
 *
 * 协议轮(`protocolRounds`)只数「校验驱动的迭代」。重试发生在**一次 `send` 之内**:messages
 * 不变、不追加,退避重发成功与否都不涨协议轮数。`pipeline.ts` 只把本包装的**成功**结果当作一轮的响应。
 *
 * ── 退避是工程参数,不进规则集 ──
 *
 * 退避参数(初始间隔 / 倍数 / 上限 / 最大重试 / 抖动)是 **gen 内部常量**:它们是运行韧性参数,
 * 不描述任何对局规则,因此**不进 `rulesets/*.json`**,也不进 `harnessDigest`(ADR-0036):
 * 它们是**测量条件的抗噪设置**,不是模型能感知的行为面。
 */

import type { ModelResponse } from "./model-client.js";
import { TransportError, transportFailureKindOf } from "./transport-error.js";

/** 一类退避预算。`maxDelayMs` 是**单次**等待的封顶;`totalBudgetMs` 是**累计**等待的上限。 */
export type RetryBudget = {
  /** 最多重发几次(不含首次)。 */
  readonly maxRetries: number;
  /** 首次重试前的等待(毫秒)。 */
  readonly initialDelayMs: number;
  /** 每次退避的倍数。 */
  readonly multiplier: number;
  /** 单次等待的封顶(毫秒)。 */
  readonly maxDelayMs: number;
  /** 累计等待的上限(毫秒);缺席 = 只受 `maxRetries` 约束。 */
  readonly totalBudgetMs?: number;
};

/**
 * 退避参数(**工程参数,不进 `rulesets/*.json`**,见 ADR-0036)。
 *
 * 第 n 次重试(1 起)前等 `min(initialDelayMs × multiplier^(n-1), maxDelayMs)` 毫秒,
 * 429 另取 `max(上式, Retry-After)` 并叠加向上抖动。
 */
export const RETRY = {
  /** 向上抖动的比例;只作用于 429。0.25 = 最多多等四分之一。 */
  jitterRatio: 0.25,
  /**
   * 429:五枪,单次封顶 60 s,累计封顶 300 s(= 会话总墙钟 1800 s 的 1/6)。
   *
   * 300 s 不是「好数字」,是**认输点**:超过这个量级,重跑一次会话已经比继续等便宜。
   * 配额耗尽型 429(等多久都不会好)由这个上限兜底,速率限制型由 `Retry-After` 兜底。
   */
  rateLimited: {
    maxRetries: 5,
    initialDelayMs: 1_000,
    multiplier: 2,
    maxDelayMs: 60_000,
    totalBudgetMs: 300_000,
  },
  /** 连接级抖动(网络失败 / 空闲超时):两枪,`1s → 2s`,不设总预算——两枪的总量本来就可忽略。 */
  connection: {
    maxRetries: 2,
    initialDelayMs: 1_000,
    multiplier: 2,
    maxDelayMs: 2_000,
  },
  /** 截断:一枪(ADR-0032)。one-shot 下第二次仍截断即判传输失败;agent 形态改为格式反馈。 */
  truncation: {
    maxRetries: 1,
    initialDelayMs: 500,
    multiplier: 2,
    maxDelayMs: 2_000,
  },
} as const;

/** 退避预算的三个类别。5xx 与其余 4xx 不在其中——它们不重试。 */
export type RetryClassification = "rate-limited" | "connection" | "truncated";

/** 类别 → 预算。两个命名空间刻意不合并:类别是失败的性质,预算是工程参数。 */
const budgetOf = (classification: RetryClassification): RetryBudget =>
  classification === "rate-limited"
    ? RETRY.rateLimited
    : classification === "connection"
      ? RETRY.connection
      : RETRY.truncation;

/** 第 `retry` 次重发前该等多久(毫秒,未含抖动、未含 `Retry-After`)。 */
export const retryDelayMs = (budget: RetryBudget, retry: number): number =>
  Math.min(budget.initialDelayMs * budget.multiplier ** (retry - 1), budget.maxDelayMs);

/** 等待实现。测试注入一个只记录、不真等的实现,断言退避序列而不用真等几秒。 */
export type RetrySleep = (ms: number) => Promise<void>;

/** 抖动源。测试注入 `() => 0` 得到确定的等待序列,注入 `() => 0.999` 验上界。 */
export type RetryRandom = () => number;

const realSleep: RetrySleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 端口把四家端点族的截断归一到 `"length"`(契约 §2.1):它是「重发同一轮」的判据。 */
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
 * 策略层:这次失败该不该再发一枪,该进哪套预算。
 *
 * `"fatal"` 不是「不该重发」的同义词——它涵盖三种不同的理由,由 `stopReasonOf` 分别叙述:
 * 请求本身有问题(其余 4xx)、服务端自己坏了(5xx)、以及根本不是传输问题(缺凭证等)。
 */
export const classifyCause = (cause: unknown): RetryClassification | "fatal" => {
  if (!(cause instanceof TransportError) || !cause.retryable) {
    return "fatal";
  }
  const kind = transportFailureKindOf(cause);
  if (kind === "server") {
    // 事实是「重发可能成功」,裁决是「不值得等」:服务端自己坏了。ADR-0036 的界线。
    return "fatal";
  }
  return kind === "rate-limited" ? "rate-limited" : "connection";
};

/** 不再重发时,一句话说清是哪种「不再」。 */
const stopReasonOf = (cause: unknown): string => {
  if (!(cause instanceof TransportError)) {
    return `不可重试的错误:${messageOf(cause)}`;
  }
  const kind = transportFailureKindOf(cause);
  if (kind === "server") {
    return `服务端错误(HTTP ${String(cause.status)}):重发只会撞同一堵墙,按裁决不重试`;
  }
  if (!cause.retryable) {
    return `不可重试的错误:${messageOf(cause)}`;
  }
  return `不可重试的错误:${messageOf(cause)}`;
};

/**
 * 发到成功或到上限。
 *
 * - 429 → `rateLimited` 预算,等 `max(指数, Retry-After)` 封顶 60 s、叠加上向抖动、累计封顶 300 s。
 * - 网络失败 / 空闲超时 → `connection` 预算,`1s → 2s` 两枪。
 * - `finishReason === "length"` → `truncation` 预算,一枪。
 * - 5xx / 其余 4xx / 普通 `Error`(缺凭证)→ **立即**收口,不重发。
 * - 到上限都不抛异常,统一以 `{ ok:false, failure }` 返回,由调用方转成 `transport` 失败
 *   (不是「崩了这一批」)。
 */
export const retryTransport = async (options: {
  readonly send: () => Promise<ModelResponse>;
  /** 注入的等待实现;缺省真等(`realSleep`)。 */
  readonly sleep?: RetrySleep;
  /** 注入的抖动源;缺省 `Math.random`。 */
  readonly random?: RetryRandom;
}): Promise<RetryOutcome> => {
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  const diagnostics: string[] = [];
  const retries: Record<RetryClassification, number> = {
    "rate-limited": 0,
    connection: 0,
    truncated: 0,
  };
  const waited: Record<RetryClassification, number> = {
    "rate-limited": 0,
    connection: 0,
    truncated: 0,
  };
  let attempt = 0;

  const giveUp = (reason: string): RetryOutcome => ({
    ok: false,
    failure: {
      attempts: attempt,
      diagnostics,
      message: `${reason}(共 ${String(attempt)} 次尝试)`,
    },
  });

  for (;;) {
    attempt += 1;
    let classification: RetryClassification;
    let cause: unknown;
    try {
      const response = await options.send();
      if (!isTruncated(response)) {
        return { ok: true, response };
      }
      // 截断:半截文本直接丢掉,不回喂、不当产物(回喂等于把一段编译不过的文本当模型的回答)。
      classification = "truncated";
      diagnostics.push(`第 ${String(attempt)} 次响应被截断(finishReason=length),丢弃并重发同一轮`);
    } catch (error) {
      const classified = classifyCause(error);
      diagnostics.push(describeError(error));
      if (classified === "fatal") {
        return giveUp(stopReasonOf(error));
      }
      classification = classified;
      cause = error;
    }

    const budget: RetryBudget = budgetOf(classification);
    retries[classification] += 1;
    const retry = retries[classification];
    if (retry > budget.maxRetries) {
      return giveUp(`重试 ${String(retry - 1)} 次后仍失败`);
    }

    const base = retryDelayMs(budget, retry);
    // `Retry-After` 是服务端给的下限:早于它重发只会再撞一次。
    const serverFloor =
      cause instanceof TransportError && cause.retryAfterMs !== undefined ? cause.retryAfterMs : 0;
    const capped = Math.min(Math.max(base, serverFloor), budget.maxDelayMs);
    // 抖动只往上加:不早了服务端要求的时间,却打散了并发进程的重发相位。
    const delayMs =
      classification === "rate-limited"
        ? capped + Math.round(random() * capped * RETRY.jitterRatio)
        : capped;

    if (
      budget.totalBudgetMs !== undefined &&
      waited[classification] + delayMs > budget.totalBudgetMs
    ) {
      return giveUp(
        `退避累计将超过 ${String(budget.totalBudgetMs)}ms 预算,不再等(已等 ${String(waited[classification])}ms)`,
      );
    }
    waited[classification] += delayMs;
    await sleep(delayMs);
  }
};
