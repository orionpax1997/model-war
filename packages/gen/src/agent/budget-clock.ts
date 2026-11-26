/**
 * 会话预算的**时钟**,两个消费者共用一份机制:单步墙钟(沙箱)与会话总墙钟(整场)。
 *
 * ── 它是什么 ──
 *
 * 一个「只在**该计的时间**里走表」的倒计时:到点调一次 `onExpire`,期间可以被 `pause` / `resume`。
 * 两个消费者各要一份:
 *
 * | 谁 | 额度 | 什么时候停表 | 到点的处置 |
 * |---|---|---|---|
 * | 单步墙钟 | `DEFAULT_STEP_WALL_CLOCK_MS` | 宿主服务请求在途 | 杀这一步的进程树 |
 * | 会话总墙钟 | `AGENT_TOTAL_WALL_CLOCK_MS` | 退避等待 | 中止进行中的模型调用 |
 *
 * ── 为什么要停表,而不是「事后扣掉」 ──
 *
 * 停表是为了让**到点那一刻**也是对的。事后扣只能改账面:一个 75 秒的服务调用在 120 秒的额度里
 * 会被当场杀掉(`archive/minimax-m3.1-flash/2026-11-18T08-48-17-718Z` 第 18 步的 124),而
 * 「先跑 100 秒、再等 300 秒退避、再跑 30 秒」在 1800 秒的会话预算里也不该因为退避而提前收场。
 *
 * ── 剩余额度是扣出来的 ──
 *
 * 每次停表把「这一轮已经走掉的时间」从额度里减掉,继续时按剩下的重排一枪。所以「跑 0.5 s →
 * 停 75 s → 再跑 0.5 s」在 1 s 的额度里仍是准点到点,而停表那 75 s 一格不进账。
 *
 * 在途计数是**数**而不是布尔:两条请求可以同时处在「在处理 / 已排队」,用布尔会在第一条结束时
 * 提前开表。
 */

/** 计时器句柄:缺省实现是 `setTimeout` 的返回值,测试注入的假计时器也可以用数字。 */
export type BudgetTimer = ReturnType<typeof setTimeout> | number;

/** 倒计时:四档操作 + 两个读数。`stop` 无条件调(进程 `close` / 会话收口都算结束)。 */
export type BudgetClock = {
  /** 开始计时:从满额开始。重复调是空操作。 */
  readonly start: () => void;
  /** 停表(在途计数 +1)。 */
  readonly pause: () => void;
  /** 继续(在途计数 -1;归零才重新开表)。 */
  readonly resume: () => void;
  /** 收尾:清掉计时器,之后 `onExpire` 不会再被调到。 */
  readonly stop: () => void;
  /** 还剩多少**该计的时间**(停表期间不减少)。 */
  readonly remainingMs: () => number;
  /** 额度是否已经到点。 */
  readonly expired: () => boolean;
};

export type BudgetClockOptions = {
  /** 额度的满额(毫秒)。 */
  readonly limitMs: number;
  /** 到点时的处置。调用方负责「杀进程树」「中止调用」这类动作。 */
  readonly onExpire: () => void;
  /** 时钟注入缝(测试用);缺省 `Date.now`。 */
  readonly now?: () => number;
  /** 计时器注入缝(测试用);缺省 `setTimeout`。 */
  readonly setTimer?: (fn: () => void, ms: number) => BudgetTimer;
  readonly clearTimer?: (timer: BudgetTimer) => void;
};

export const createBudgetClock = (options: BudgetClockOptions): BudgetClock => {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((timer: BudgetTimer) => clearTimeout(timer));
  let remainingMs = options.limitMs;
  let armedAt: number | undefined;
  let timer: BudgetTimer | undefined;
  let inFlight = 0;
  let stopped = false;
  let expired = false;

  /** 停表:把这一轮已经走掉的时间扣掉,并拆掉计时器。 */
  const disarm = (): void => {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
    remainingMs = Math.max(0, remainingMs - (now() - (armedAt ?? now())));
    armedAt = undefined;
  };

  /** 开表:按剩余额度重排一枪。已在计时或已收尾时是空操作。 */
  const arm = (): void => {
    if (stopped || expired || timer !== undefined) return;
    armedAt = now();
    timer = setTimer(() => {
      timer = undefined;
      armedAt = undefined;
      remainingMs = 0;
      expired = true;
      options.onExpire();
    }, remainingMs);
    // 别让一只几十分钟的计时器把进程留住(它只在一个会话的生命期里有意义)。
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
  };

  return {
    start: arm,
    pause: () => {
      inFlight += 1;
      if (inFlight === 1) disarm();
    },
    resume: () => {
      inFlight = Math.max(0, inFlight - 1);
      if (inFlight === 0) arm();
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
    },
    remainingMs: () => {
      if (expired) return 0;
      if (timer === undefined) return remainingMs;
      return Math.max(0, remainingMs - (now() - (armedAt ?? now())));
    },
    expired: () => expired,
  };
};
