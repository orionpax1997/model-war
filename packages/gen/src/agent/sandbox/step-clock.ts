/**
 * 单步墙钟:这一步**沙箱自己**跑了多久,以及到点时的处置(`sandbox.run` 用它杀进程树)。
 *
 * ── 它只杀挂起,不是 deadline(ADR-0029) ──
 *
 * 单步墙钟的职责只有一条:杀掉 `sleep 999`、死循环这类**挂起**,让一步不至于把整场会话卡死。
 * 它不是成绩判据,任何取值都不该影响判读。于是它不是「这一步的一切耗时」的闸门。
 *
 * ── 服务调用不进这个钟(ADR-0029 原话) ──
 *
 * 「服务调用不受单步约束,只受总墙钟约束」:宿主侧的服务(`evaluate` 要跑一整张网格,约 75 s)
 * 在干活的时候,沙箱里那一步**什么都没做**——它只是在等一行响应。把这段时间算进单步墙钟的
 * 后果不是「慢」,而是错杀:一次真网格叠上模型自己写脚本的时间就会撞上 120 s,于是这一步被
 * 杀掉,而宿主侧的观测原料与网格汇总已经落盘——会话留下半个提交,第二个候选凭空消失。
 *
 * 所以服务请求**在途**期间这个钟是冻结的(`pause` / `resume`),判据是「有一个宿主请求正在
 * 处理」这个事实,不是「这一块命令里出现了工具名」——后者要靠 shell 解析,而 ADR-0032 明确
 * 不做。
 *
 * ── 为什么冻钟不削弱防挂起 ──
 *
 * 服务调用跑在宿主的同步路径上(`runTrialScript` 一次 `spawnSync`):那一整段时间里宿主的事件
 * 循环是阻塞的,`setTimeout` 本来也跑不起来。也就是说这个钟从来不是「服务挂死」的兜底,
 * 兜底是会话总墙钟(dispatcher 在**发请求时**判)与人。冻钟只是把「本来就没被这条判据管到」
 * 的那段时间从账上划掉,不改任何真实边界。
 */

/** 单步墙钟:三档操作。`stop` 无条件调(进程 `close` / `error` 都算结束)。 */
export type StepClock = {
  /** 开始计时(每步一次):从满额开始。 */
  readonly start: () => void;
  /** 一个宿主服务请求开始处理:冻结计时。 */
  readonly pause: () => void;
  /** 那个请求结束了(含抛错):按剩余额度续上。 */
  readonly resume: () => void;
  /** 收尾:清掉计时器。之后 `onExpire` 不会再被调到。 */
  readonly stop: () => void;
};

export type StepClockOptions = {
  /** 单步额度的满额(毫秒)。 */
  readonly wallClockMs: number;
  /** 到点时的处置:调用方负责杀进程树(先 SIGTERM、再宽限后 SIGKILL)。 */
  readonly onExpire: () => void;
  /** 时钟注入缝(测试用);缺省 `Date.now`。 */
  readonly now?: () => number;
  /** 计时器注入缝(测试用);缺省 `setTimeout`。 */
  readonly setTimer?: (fn: () => void, ms: number) => StepTimer;
  readonly clearTimer?: (timer: StepTimer) => void;
};

/** 计时器句柄:缺省实现是 `setTimeout` 的返回值,测试注入的假计时器也可以用数字。 */
export type StepTimer = ReturnType<typeof setTimeout> | number;

/**
 * 造一个单步墙钟。
 *
 * 剩余额度是**扣出来的**:每次冻结把「这一轮已经跑掉的时间」从额度里减掉,续上时按剩下的重排
 * 一枪。所以「跑 0.5 s → 服务 75 s → 再跑 0.5 s」在 1 s 的额度里仍是准点到点,而服务那 75 s
 * 一格不进账。
 *
 * 在途计数是**数**而不是布尔:通道是串行的,但「一条请求正在处理、另一条已经排队」是常态,
 * 用布尔会在第二条结束时提前续上计时。
 */
export const createStepClock = (options: StepClockOptions): StepClock => {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((timer: StepTimer) => clearTimeout(timer));
  let remainingMs = options.wallClockMs;
  let armedAt: number | undefined;
  let timer: StepTimer | undefined;
  let inFlight = 0;
  let stopped = false;

  /** 冻结:把这一轮已经用掉的时间扣掉,并拆掉计时器。 */
  const disarm = (): void => {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
    remainingMs = Math.max(0, remainingMs - (now() - (armedAt ?? now())));
    armedAt = undefined;
  };

  /** 续上:按剩余额度重排一枪。已在计时或已收尾时是空操作。 */
  const arm = (): void => {
    if (stopped || timer !== undefined) return;
    armedAt = now();
    timer = setTimer(() => {
      timer = undefined;
      armedAt = undefined;
      remainingMs = 0;
      options.onExpire();
    }, remainingMs);
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
  };
};
