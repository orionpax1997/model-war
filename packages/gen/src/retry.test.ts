/**
 * 传输韧性(契约 §2.1 / §4;票 06)的单元行为:**发到成功或耗尽**。
 *
 * 断言对象是「可观察的发送次数、退避等待序列、收口形状」——不真等:退避用注入的 `sleep` 记录
 * 每次等待的毫秒数,再与 `RETRY` 常量推出的序列比。这里覆盖「哪些失败重发、哪些不重发、截断走
 * 哪条路、耗尽长什么样」;「不消耗协议轮数」在 `pipeline.test.ts` 里从 `protocolRounds` 侧验。
 */

import { describe, expect, it } from "vitest";

import type { ModelResponse } from "./model-client.js";
import { RETRY, retryDelayMs, retryTransport, type RetrySleep } from "./retry.js";
import { TransportError } from "./transport-error.js";

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

describe("retryTransport", () => {
  it("429 后成功:退避一次即收口为成功", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const outcome = await retryTransport({
      sleep,
      send: async () => {
        calls += 1;
        if (calls === 1) {
          throw new TransportError("被限流", { retryable: true, status: 429 });
        }
        return response("完整脚本");
      },
    });

    expect(calls).toBe(2);
    expect(waits).toEqual([RETRY.initialDelayMs]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.response.text).toBe("完整脚本");
    }
  });

  it("5xx / 超时直到耗尽:尝试 maxRetries+1 次,退避序列符合常量,收口为传输失败", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const outcome = await retryTransport({
      sleep,
      send: async () => {
        calls += 1;
        // 第 2 次是超时(网络失败 / 超时无状态码),其余是 503:两者都 retryable。
        if (calls === 2) {
          throw new TransportError("请求超时", { retryable: true });
        }
        throw new TransportError("服务不可用", { retryable: true, status: 503 });
      },
    });

    expect(calls).toBe(RETRY.maxRetries + 1);
    expect(waits).toEqual([500, 1000, 2000]);
    // 逐项对照公式:initial × multiplier^(n-1)。
    expect(waits).toEqual(
      Array.from({ length: RETRY.maxRetries }, (_unused, index) => retryDelayMs(index + 1)),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.attempts).toBe(RETRY.maxRetries + 1);
      expect(outcome.failure.diagnostics).toHaveLength(RETRY.maxRetries + 1);
      expect(outcome.failure.diagnostics[0]).toContain("HTTP 503");
      expect(outcome.failure.diagnostics[1]).toContain("超时");
      expect(outcome.failure.message).toContain("重试");
    }
  });

  it("截断(finishReason=length)重发同一轮:半截文本被丢弃,取到完整响应", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const outcome = await retryTransport({
      sleep,
      send: async () => {
        calls += 1;
        return calls === 1 ? response("半截代码", "length") : response("完整脚本");
      },
    });

    expect(calls).toBe(2);
    expect(waits).toEqual([RETRY.initialDelayMs]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.response.text).toBe("完整脚本");
      expect(outcome.response.finishReason).toBe("stop");
    }
  });

  it("截断直到耗尽:与传输错误共用同一预算,收口为传输失败", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const outcome = await retryTransport({
      sleep,
      send: async () => {
        calls += 1;
        return response("半截代码", "length");
      },
    });

    expect(calls).toBe(RETRY.maxRetries + 1);
    expect(waits).toHaveLength(RETRY.maxRetries);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.attempts).toBe(RETRY.maxRetries + 1);
      expect(outcome.failure.diagnostics[0]).toContain("截断");
    }
  });

  it("不可重试的 400:立即收口,不退避、不重发", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const outcome = await retryTransport({
      sleep,
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
    expect(retryDelayMs(1)).toBe(RETRY.initialDelayMs);
    expect(retryDelayMs(2)).toBe(RETRY.initialDelayMs * RETRY.multiplier);
    expect(retryDelayMs(3)).toBe(RETRY.initialDelayMs * RETRY.multiplier ** 2);
    // 封顶:越往后越大,到上限就不再涨。
    expect(retryDelayMs(RETRY.maxRetries)).toBeLessThanOrEqual(RETRY.maxDelayMs);
    expect(retryDelayMs(100)).toBe(RETRY.maxDelayMs);
  });
});
