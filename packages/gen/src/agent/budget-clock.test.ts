/**
 * 单步墙钟的口径:**只计沙箱自身执行的时间,服务调用在途时冻结**。
 *
 * 判据都是可数的:额度扣到多少、计时器在不在、`onExpire` 几次。所以这里用假时钟跑,不用真
 * `sleep`——真睡会把「服务那段时间没进账」测成一件看运气的事。
 *
 * 端到端的那一半(真 bwrap 里一步调 `evaluate`、宿主服务慢到超过单步额度)在
 * `apps/cli/src/agent-real-session.test.ts`(`pnpm run verify:kernel`)。
 */

import { describe, expect, it } from "vitest";

import { createBudgetClock, type BudgetTimer } from "./budget-clock.js";

type Harness = {
  readonly clock: ReturnType<typeof createBudgetClock>;
  readonly fired: () => number;
  /** 把假时钟推进若干毫秒,顺带跑掉期间到点的计时器。 */
  readonly advance: (ms: number) => void;
  /** 当前挂着的那一枪还剩多久(`undefined` = 没有计时器在跑)。 */
  readonly armedMs: () => number | undefined;
};

const harnessOf = (wallClockMs: number): Harness => {
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, { readonly at: number; readonly fire: () => void }>();
  let fired = 0;
  const clock = createBudgetClock({
    limitMs: wallClockMs,
    onExpire: () => {
      fired += 1;
    },
    now: () => now,
    setTimer: (fire, ms): BudgetTimer => {
      sequence += 1;
      timers.set(sequence, { at: now + ms, fire });
      return sequence;
    },
    clearTimer: (timer) => {
      timers.delete(timer as number);
    },
  });
  return {
    clock,
    fired: () => fired,
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fire();
      }
      now = target;
    },
    armedMs: () => {
      const [timer] = [...timers.values()];
      return timer === undefined ? undefined : timer.at - now;
    },
  };
};

describe("服务调用在途时冻结", () => {
  it("服务里花了 5 秒,额度 1 秒也不会到点", () => {
    const clock = harnessOf(1_000);
    clock.clock.start();
    clock.advance(400);
    clock.clock.pause();
    // 一次真 `evaluate` 要跑一整张网格(实测约 75 s):这段时间这一步只是在等一行响应。
    clock.advance(5_000);
    expect(clock.fired()).toBe(0);
    // 冻结期间没有计时器在跑(否则它会在服务干活时把进程树杀掉)。
    expect(clock.armedMs()).toBeUndefined();
    clock.clock.stop();
  });

  it("续上时按**扣减后**的余额计时,服务那段时间一格不进账", () => {
    const clock = harnessOf(1_000);
    clock.clock.start();
    clock.advance(400);
    clock.clock.pause();
    clock.advance(5_000);
    clock.clock.resume();
    // 已经跑掉 400,额度 1000:续上后还剩 600(不是 1000,也不是负数)。
    expect(clock.armedMs()).toBe(600);
    clock.advance(599);
    expect(clock.fired()).toBe(0);
    clock.advance(1);
    expect(clock.fired()).toBe(1);
    clock.clock.stop();
  });

  it("在途计数而不是布尔:两条请求排队时,第一条结束不提前续上", () => {
    const clock = harnessOf(1_000);
    clock.clock.start();
    clock.clock.pause();
    clock.clock.pause();
    clock.clock.resume();
    expect(clock.armedMs()).toBeUndefined();
    clock.advance(5_000);
    expect(clock.fired()).toBe(0);
    clock.clock.resume();
    expect(clock.armedMs()).toBe(1_000);
    clock.clock.stop();
  });
});

describe("冻结之外照旧杀挂起", () => {
  it("不暂停时到点即触发(`sleep 999` 的防线没被削弱)", () => {
    const clock = harnessOf(120_000);
    clock.clock.start();
    clock.advance(119_999);
    expect(clock.fired()).toBe(0);
    clock.advance(1);
    expect(clock.fired()).toBe(1);
    clock.clock.stop();
  });

  it("沙箱自己跑的时间 + 服务时间:只有前者进账", () => {
    const clock = harnessOf(1_000);
    clock.clock.start();
    // 跑 700 → 服务 90 秒 → 再跑 299:仍未到点(101 毫秒余量)。
    clock.advance(700);
    clock.clock.pause();
    clock.advance(90_000);
    clock.clock.resume();
    clock.advance(299);
    expect(clock.fired()).toBe(0);
    clock.advance(1);
    expect(clock.fired()).toBe(1);
    clock.clock.stop();
  });

  it("`stop` 之后不再触发(进程已经结束,别再杀一次)", () => {
    const clock = harnessOf(100);
    clock.clock.start();
    clock.clock.stop();
    clock.advance(10_000);
    expect(clock.fired()).toBe(0);
  });
});

describe("读数:还剩多少 / 是否到点", () => {
  it("停表期间剩余额度不减少,继续后按余额到点", () => {
    const clock = harnessOf(1_000);
    clock.clock.start();
    expect(clock.clock.remainingMs()).toBe(1_000);
    clock.advance(400);
    expect(clock.clock.remainingMs()).toBe(600);
    clock.clock.pause();
    clock.advance(5_000);
    // 会话总墙钟与单步墙钟都靠这个读数判「还能不能再开一步」:停表期间它必须不动。
    expect(clock.clock.remainingMs()).toBe(600);
    expect(clock.clock.expired()).toBe(false);
    clock.clock.resume();
    clock.advance(600);
    expect(clock.clock.expired()).toBe(true);
    expect(clock.clock.remainingMs()).toBe(0);
    clock.clock.stop();
  });
});
