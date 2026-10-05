/**
 * 事件流与它的定序规则(hld §7.5 的八种事件、§4.3 的步位)。
 *
 * ═══ 本模块的头注就是那条定序规则本身 ═══
 *
 * **事件的全序由三样东西定,与它们被 `push` 进去的先后无关:**
 *
 * 1. **产出它的那一步**(`hld` §4.3 的编号 0–7):步号小的先出。
 * 2. **步内按对象的数值 id 升序**:单位级事件取单位 id、点位级取点位 id、玩家级取 `playerIndex`。
 * 3. 仍相同(同一步、同一主体、同一种类)才轮到登记序兜底。
 *
 * 为什么不允许事后按插入序:同一局重跑必须得到**逐项相同**的事件序列,而插入序依赖
 * 「谁先被遍历到」——那正是各步内部允许存在的实现自由度。改一处遍历顺序,历史回放里的一段战报
 * 就会静默变样,而回放是「可复算原始数据」,它变样等于证据失效。
 *
 * 排第三的那条兜底之所以可接受:八种事件里每一种的主体在一 tick 内至多出现一次
 * (一个单位同 tick 死一次、一个点位同 tick 易主一次、一个玩家同 tick 出局一次),
 * 所以兜底在规则层**几乎**不可达;它留着是为了让「本 tick 有两条同类同主体事件」这种尚未出现的
 * 情形有一个确定答案,而不是让顺序依赖实现的自由。
 *
 * ═══ 为什么每种事件一个具名方法 ═══
 *
 * 八种事件各自**绑定一个步位**。具名方法让「这个事件该由哪一步发」写在调用点上,
 * 而步号由方法自己带,于是第 1 条规则由类型与命名维持,而不是由每个调用点记得传一个步号。
 * 不允许某一步随手往数组里 `push`:出口只有 `events()` 一个,而它会先定序再交出。
 *
 * ═══ 02a 不发任何事件 ═══
 *
 * 八种事件由 04–09 各自填进自己的槽位。**本票只把收集器与定序规则立住**——
 * 规则先立、事件后填,这样每一张机制票都不必各自决定顺序。
 */

import type { PlayerIndex } from "../world/state.js";

/** 八种事件(hld §7.5)。名字是回放与战报共同读的,所以一个都不能改写。 */
export type EventKind =
  | "exception"
  | "budget-soft-warning"
  | "first-contact"
  | "unit-destroyed"
  | "site-captured"
  | "economy-dead"
  | "player-eliminated"
  | "victory";

/**
 * 一条事件。
 *
 * `subjectId` 是它的**定序主体**,同时也是事件携带的那一个对象号:单位级事件取单位 id、
 * 点位级取点位 id、玩家级取座位号。其余字段随各自的机制票回填(04–09),回放行的形状归
 * `packages/schema`(02b 那一格),本模块不替它声明。
 */
export type Event = {
  readonly kind: EventKind;
  readonly subjectId: number;
};

/** 步号(hld §4.3 的编号)。收集器用它定第一步序,所以它比事件本身更早确定。 */
export type StepNo = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** 事件 → 步位。**每个具名方法只认它自己那一栏**,写错步位是往别的方法上写,不在调用点里判断。 */
const STEP_OF: { readonly [kind in EventKind]: StepNo } = {
  // 0 dispatch:由执行器上报,不来自结算
  exception: 0,
  "budget-soft-warning": 0,
  // 2 movement / 3 combat
  "first-contact": 2,
  "unit-destroyed": 3,
  // 4 objectTick
  "site-captured": 4,
  "economy-dead": 4,
  // 5 evaluate
  "player-eliminated": 5,
  victory: 5,
};

export type EventCollector = {
  readonly exception: (player: PlayerIndex) => void;
  readonly budgetSoftWarning: (player: PlayerIndex) => void;
  readonly firstContact: (unitId: number) => void;
  readonly unitDestroyed: (unitId: number) => void;
  readonly siteCaptured: (siteId: number) => void;
  readonly economyDead: (player: PlayerIndex) => void;
  readonly playerEliminated: (player: PlayerIndex) => void;
  readonly victory: (player: PlayerIndex) => void;
  /** 出口只有一个:先定序,再交出。 */
  readonly events: () => readonly Event[];
};

const byOrder = (
  left: { readonly step: StepNo; readonly subjectId: number; readonly kind: EventKind; readonly seq: number },
  right: { readonly step: StepNo; readonly subjectId: number; readonly kind: EventKind; readonly seq: number },
): number =>
  left.step - right.step ||
  left.subjectId - right.subjectId ||
  (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0) ||
  left.seq - right.seq;

export const createEventCollector = (): EventCollector => {
  const recorded: { step: StepNo; subjectId: number; kind: EventKind; seq: number }[] = [];
  const record = (kind: EventKind, subjectId: number): void => {
    recorded.push({ step: STEP_OF[kind], subjectId, kind, seq: recorded.length });
  };
  return {
    exception: (player) => record("exception", player),
    budgetSoftWarning: (player) => record("budget-soft-warning", player),
    firstContact: (unitId) => record("first-contact", unitId),
    unitDestroyed: (unitId) => record("unit-destroyed", unitId),
    siteCaptured: (siteId) => record("site-captured", siteId),
    economyDead: (player) => record("economy-dead", player),
    playerEliminated: (player) => record("player-eliminated", player),
    victory: (player) => record("victory", player),
    events: () =>
      [...recorded].sort(byOrder).map(({ kind, subjectId }) => ({ kind, subjectId })),
  };
};