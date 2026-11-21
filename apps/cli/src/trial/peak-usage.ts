/**
 * 候选座位的**占用读数**(只披露、不判罚):每一条预算轨最坏的那一次读到多少。
 *
 * ── 为什么它是 CLI 的一格,而不是引擎的 `RunnerOutput` 里再长一点 ──
 *
 * 引擎按 tick 报**这一 tick**的读数(`PeakUsage`,`packages/engine/src/runner/index.ts`);
 * 「整场/整张网格最坏那一次」是**聚合**,而聚合的粒度是调用方的口径(试跑按场聚合、
 * 探针按前缀聚合)。放在引擎里就得多一个跨 tick 的可变状态,而跨场聚合引擎根本看不见。
 *
 * ── 为什么逐字段累加而不是存一串读数 ──
 *
 * 探针要的只是"最坏读数:480/500",不是回归曲线;而存一串会立刻引出"这一串怎么落盘、
 * 怎么进档案"这两件本票不做的事(占用读数不写观测、不进档案)。
 *
 * 缺席的字段**不被 0 覆盖**:一条轨这一 tick 没采到,就把上一次的值留着——聚合里唯一能造成的
 * 静默错误是"把没量写成用了 0"。
 */

/**
 * 一条预算轨的最坏读数。三个字段各自可缺席,含义与 `PeakUsage` 逐字相同(见那里):
 * 缺席 = 这一条**一次都没采到**,不是 0。
 */
export type PeakUsageReading = {
  readonly eventCount?: number;
  readonly apiCalls?: number;
  readonly memoryBytes?: number;
};

/** 累加器:同一份形状,可写。只在本格内被 `merge` 改。 */
export type PeakUsageAccumulator = {
  eventCount?: number;
  apiCalls?: number;
  memoryBytes?: number;
};

/** 取更坏值:缺席不动它;两边都在场取大者。`undefined` 表示「这一条仍然没采到」。 */
const worse = (current: number | undefined, next: number | undefined): number | undefined => {
  if (next === undefined) return current;
  if (current === undefined) return next;
  return Math.max(current, next);
};

/**
 * 写回只走这一处:某条轨这次仍没采到就**不碰**累加器里的旧值。
 *
 * 不写成 `accumulator.x = worse(...)`:`exactOptionalPropertyTypes` 下那是一次
 * 「把 `undefined` 写进可选字段」,而它的语义恰恰是「这个字段等于不存在」——两件事。
 */
const keep = (next: number | undefined, set: (value: number) => void): void => {
  if (next !== undefined) set(next);
};

/**
 * 把一条 tick 读数并进累加器(逐轨取更坏值)。
 *
 * `next` 缺席(这一 tick 一条都没采到)时累加器原样不动——早退路径(墙钟硬超时 / 事件轨截停 /
 * 未吞异常)正是这种 tick,它们只带事件计数,不该把 API 与内存的已有读数抹掉。
 */
export const mergePeakUsage = (
  accumulator: PeakUsageAccumulator,
  next: PeakUsageReading | undefined,
): void => {
  if (next === undefined) return;
  keep(worse(accumulator.eventCount, next.eventCount), (value) => {
    accumulator.eventCount = value;
  });
  keep(worse(accumulator.apiCalls, next.apiCalls), (value) => {
    accumulator.apiCalls = value;
  });
  keep(worse(accumulator.memoryBytes, next.memoryBytes), (value) => {
    accumulator.memoryBytes = value;
  });
};

/** 累加器的只读快照;一条读数都没采到即 `undefined`(缺席 ≠ 全 0)。 */
export const peakUsageOf = (accumulator: PeakUsageAccumulator): PeakUsageReading | undefined => {
  const reading: PeakUsageReading = {
    ...(accumulator.eventCount === undefined ? {} : { eventCount: accumulator.eventCount }),
    ...(accumulator.apiCalls === undefined ? {} : { apiCalls: accumulator.apiCalls }),
    ...(accumulator.memoryBytes === undefined ? {} : { memoryBytes: accumulator.memoryBytes }),
  };
  return Object.keys(reading).length === 0 ? undefined : reading;
};
