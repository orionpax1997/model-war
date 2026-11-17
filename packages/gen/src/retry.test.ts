/**
 * 传输韧性(契约 §2.1 / §4;ADR-0036)的单元行为:**发到成功或到上限**。
 *
 * 断言对象是「可观察的发送次数、退避等待序列、收口形状」——不真等:退避用注入的 `sleep` 记录
 * 每次等待的毫秒数,抖动用注入的 `random` 钉死。这里覆盖「哪些失败重发几枪、各按哪套预算、
 * 截断走哪条路、`Retry-After` 与累计预算怎么生效、到上限长什么样」;「不消耗协议轮数」在
 * `pipeline.test.ts` 里从 `protocolRounds` 侧验。
 */

import { describe, expect, it } from "vitest";

import type { ModelResponse } from "./model-client.js";
import { RETRY, retryDelayMs, retryTransport, type RetrySleep } from "./retry.js";
import { TransportError, transportFailureKindOf } from "./transport-error.js";

const response = (text: string, finishReason = "stop"): ModelResponse => ({
  text,
  finishReason,
  usage: {},
});

/** 只记录、不真等的等待实现:断言退避序列而不用花几秒。 */
const recorder = (): { readonly waits: number[]; readonly sleep: RetrySleep } => {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
};

/** 抖动源:返回 0 让等待等于基础序列,测试才好断言具体毫秒数。 */
const noJitter = (): number => 0;

describe("retryTransport", () => {
  it("429 后成功:退避一次即收口为成功", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const outcome = await retryTransport({
      sleep,
      random: noJitter,
      send: async () => {
        calls += 1;
        if (calls === 1) {
          throw new TransportError("被限流", { retryable: true, status: 429 });
        }
        return response("完整脚本");
      },
    });

    expect(calls).toBe(2);
    expect(waits).toEqual([RETRY.rateLimited.initialDelayMs]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.response.text).toBe("完整脚本");
    }
  });

  it("5xx 一次即收口:retryable 仍为真,但按裁决不重试", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const outcome = await retryTransport({
      sleep,
      random: noJitter,
      send: async () => {
        calls += 1;
        throw new TransportError("服务不可用", { retryable: true, status: 503 });
      },
    });

    expect(calls).toBe(1);
    expect(waits).toEqual([]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.attempts).toBe(1);
      expect(outcome.failure.diagnostics).toHaveLength(1);
      expect(outcome.failure.diagnostics[0]).toContain("HTTP 503");
      // 事实与策略分开:消息说明「这是服务端自己坏了」而不是「不可重试」。
      expect(outcome.failure.message).toContain("服务端错误");
      expect(outcome.failure.message).toContain("不重试");
    }
  });

  it("连接级抖动(网络失败 / 超时)直到耗尽:两枪,序列 1s→2s", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const outcome = await retryTransport({
      sleep,
      random: noJitter,
      send: async () => {
        calls += 1;
        // 第 2 次是空闲超时(无状态码 + timedOut),其余是连接级失败:同一套预算。
        if (calls === 2) {
          throw new TransportError("请求超时", { retryable: true, timedOut: true });
        }
        throw new TransportError("请求失败:ECONNRESET", { retryable: true });
      },
    });

    expect(calls).toBe(RETRY.connection.maxRetries + 1);
    expect(waits).toEqual([1_000, 2_000]);
    expect(waits).toEqual(
      Array.from({ length: RETRY.connection.maxRetries }, (_unused, index) =>
        retryDelayMs(RETRY.connection, index + 1),
      ),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.attempts).toBe(RETRY.connection.maxRetries + 1);
      expect(outcome.failure.diagnostics).toHaveLength(RETRY.connection.maxRetries + 1);
      expect(outcome.failure.diagnostics[0]).toContain("ECONNRESET");
      expect(outcome.failure.diagnostics[1]).toContain("超时");
      expect(outcome.failure.message).toContain("重试");
    }
  });

  it("429 的 Retry-After 是等待下限:比指数退避长时听服务端的", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const outcome = await retryTransport({
      sleep,
      random: noJitter,
      send: async () => {
        calls += 1;
        if (calls === 1) {
          throw new TransportError("被限流", {
            retryable: true,
            status: 429,
            retryAfterMs: 30_000,
          });
        }
        return response("完整脚本");
      },
    });

    expect(calls).toBe(2);
    expect(waits).toEqual([30_000]);
    expect(outcome.ok).toBe(true);
  });

  it("Retry-After 超过单次封顶:封到 maxDelayMs 再重发,不空等也不提前撞", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const outcome = await retryTransport({
      sleep,
      random: noJitter,
      send: async () => {
        calls += 1;
        if (calls === 1) {
          throw new TransportError("被限流", {
            retryable: true,
            status: 429,
            retryAfterMs: 3_600_000,
          });
        }
        return response("完整脚本");
      },
    });

    expect(calls).toBe(2);
    expect(waits).toEqual([RETRY.rateLimited.maxDelayMs]);
    expect(outcome.ok).toBe(true);
  });

  it("抖动只往上加:等待落在 [封顶值, 封顶值×(1+jitterRatio)] 之间", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const outcome = await retryTransport({
      sleep,
      random: () => 0.999,
      send: async () => {
        calls += 1;
        if (calls === 1) {
          throw new TransportError("被限流", { retryable: true, status: 429 });
        }
        return response("完整脚本");
      },
    });

    expect(outcome.ok).toBe(true);
    expect(waits).toHaveLength(1);
    const [wait] = waits;
    expect(wait).toBeGreaterThanOrEqual(RETRY.rateLimited.initialDelayMs);
    expect(wait).toBeLessThanOrEqual(
      RETRY.rateLimited.initialDelayMs * (1 + RETRY.jitterRatio) + 1,
    );
  });

  it("累计退避预算用尽:到点收口,不一枪一枪把会话墙钟啃穿", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const outcome = await retryTransport({
      sleep,
      random: () => 0.999,
      send: async () => {
        calls += 1;
        throw new TransportError("被限流", {
          retryable: true,
          status: 429,
          retryAfterMs: RETRY.rateLimited.maxDelayMs,
        });
      },
    });

    const waited = waits.reduce((sum, ms) => sum + ms, 0);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.message).toContain("预算");
    }
    // 收口时累计等待没有越过预算;且没有被次数上限提前截断(说明是预算先到)。
    expect(waited).toBeLessThanOrEqual(RETRY.rateLimited.totalBudgetMs);
    expect(calls).toBeLessThanOrEqual(RETRY.rateLimited.maxRetries + 1);
  });

  it("截断(finishReason=length)重发同一轮:半截文本被丢弃,取到完整响应", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const outcome = await retryTransport({
      sleep,
      random: noJitter,
      send: async () => {
        calls += 1;
        return calls === 1 ? response("半截代码", "length") : response("完整脚本");
      },
    });

    expect(calls).toBe(2);
    expect(waits).toEqual([RETRY.truncation.initialDelayMs]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.response.text).toBe("完整脚本");
      expect(outcome.response.finishReason).toBe("stop");
    }
  });

  it("截断到上限:走自己的预算,一枪之后收口为传输失败", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const outcome = await retryTransport({
      sleep,
      random: noJitter,
      send: async () => {
        calls += 1;
        return response("半截代码", "length");
      },
    });

    expect(calls).toBe(RETRY.truncation.maxRetries + 1);
    expect(waits).toHaveLength(RETRY.truncation.maxRetries);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.attempts).toBe(RETRY.truncation.maxRetries + 1);
      expect(outcome.failure.diagnostics[0]).toContain("截断");
    }
  });

  it("截断与 429 / 连接抖动各占各的预算:互不侵占", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const outcome = await retryTransport({
      sleep,
      random: noJitter,
      send: async () => {
        calls += 1;
        if (calls === 1) {
          throw new TransportError("被限流", { retryable: true, status: 429 });
        }
        if (calls === 2) {
          throw new TransportError("请求失败:ECONNRESET", { retryable: true });
        }
        return calls === 3 ? response("半截代码", "length") : response("完整脚本");
      },
    });

    // 三类各用一次,都没有把别人的名额吃掉。
    expect(calls).toBe(4);
    expect(waits).toEqual([
      RETRY.rateLimited.initialDelayMs,
      1_000,
      RETRY.truncation.initialDelayMs,
    ]);
    expect(outcome.ok).toBe(true);
  });

  it("不可重试的 400:立即收口,不退避、不重发", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const outcome = await retryTransport({
      sleep,
      random: noJitter,
      send: async () => {
        calls += 1;
        throw new TransportError("坏请求", { retryable: false, status: 400 });
      },
    });

    expect(calls).toBe(1);
    expect(waits).toEqual([]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.attempts).toBe(1);
      expect(outcome.failure.diagnostics).toHaveLength(1);
      expect(outcome.failure.diagnostics[0]).toContain("HTTP 400");
      expect(outcome.failure.message).toContain("不可重试");
    }
  });

  it("普通 Error(缺凭证等):不可重试,立即收口", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const outcome = await retryTransport({
      sleep,
      random: noJitter,
      send: async () => {
        calls += 1;
        throw new Error("缺凭证:环境变量 GEN_TEST_KEY 未设置");
      },
    });

    expect(calls).toBe(1);
    expect(waits).toEqual([]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.attempts).toBe(1);
      expect(outcome.failure.diagnostics[0]).toContain("缺凭证");
    }
  });

  it("退避序列与封顶符合常量:initial × multiplier^(n-1),单次不超过 maxDelayMs", () => {
    expect(retryDelayMs(RETRY.rateLimited, 1)).toBe(RETRY.rateLimited.initialDelayMs);
    expect(retryDelayMs(RETRY.rateLimited, 2)).toBe(
      RETRY.rateLimited.initialDelayMs * RETRY.rateLimited.multiplier,
    );
    expect(retryDelayMs(RETRY.rateLimited, 3)).toBe(
      RETRY.rateLimited.initialDelayMs * RETRY.rateLimited.multiplier ** 2,
    );
    // 封顶:越往后越大,到上限就不再涨。
    expect(retryDelayMs(RETRY.rateLimited, RETRY.rateLimited.maxRetries)).toBeLessThanOrEqual(
      RETRY.rateLimited.maxDelayMs,
    );
    expect(retryDelayMs(RETRY.rateLimited, 100)).toBe(RETRY.rateLimited.maxDelayMs);
  });
});

describe("transportFailureKindOf", () => {
  it("状态码能说话时听状态码,不能说话时看 timedOut", () => {
    expect(transportFailureKindOf(new TransportError("x", { retryable: true, status: 429 }))).toBe(
      "rate-limited",
    );
    expect(transportFailureKindOf(new TransportError("x", { retryable: true, status: 503 }))).toBe(
      "server",
    );
    expect(transportFailureKindOf(new TransportError("x", { retryable: true }))).toBe("network");
    expect(
      transportFailureKindOf(new TransportError("x", { retryable: true, timedOut: true })),
    ).toBe("timeout");
    // 流被中途切断时状态码是 200:它不是服务端故障,归连接级。
    expect(transportFailureKindOf(new TransportError("x", { retryable: true, status: 200 }))).toBe(
      "network",
    );
  });
});
