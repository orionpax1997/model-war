/**
 * `StubRunner`:缝的一个适配器,参赛策略是**普通 TS 函数**(ADR-0005)。
 *
 * ── 硬约束:它同样做「拷一份快照、拿到 intent 数组」两件事 ──
 *
 * 拷快照那一步**不由本模块做**,而是由步 0 的 `buildSnapshot` 做,与真沙箱走的是**同一个调用点**。
 * 本模块的义务是另一半:**它只经 `setSnapshot` 拿到那份快照,绝不碰 `GameState`**。
 * 一旦它读真状态,结算管线在测试里跑的就是一条生产不走的路——FR-3 AC1
 * 「脚本读到的每个 state 对象都是只读封存/复制副本」会变得**无法证伪**:断言变绿时脚本明明
 * 读的是可写的真状态。stub 的全部价值就是让「只读封存」在每次结算管线测试里都被真跑一遍。
 *
 * ── 为什么策略是普通 TS 函数,不经字符串、不经 VM ──
 *
 * 缝存在**只为可测性**;若 stub 收脚本源码,它就得自带一次编译或解析,而那正是它存在的理由之外
 * 的全部成本(票 D 已把「校验器跑在编译产物上」钉成一条门禁,复制一份到测试夹具上是净损失)。
 * 顺带的好处:策略写错了就是 TypeScript 报错,不是运行期的 `ReferenceError`。
 *
 * ── 为什么 `drainIntents` 一个 tick 只准调一次 ──
 *
 * 策略函数就是沙箱里的 `loop()`。一个 tick 里跑它两次不是协议,是 bug——而在缝上直接抛,
 * 是唯一能让这个 bug **停在缝上**而不是渗进结算的地方(真沙箱那边第二次 drain 得到空数组,
 * 不会报错,所以这个断言在 stub 上才有意义:它是**测试专用**的更严的边)。
 */

import type { Intent } from "../processor/intents.js";
import type { Snapshot } from "../world/state.js";
import type { SeatRunner } from "./index.js";

/**
 * 一个座位的参赛策略:吃这一 tick 的只读快照,交回这一 tick 的 intents。
 *
 * 入参是**快照**而不是引擎状态:策略拿不到 `nextId`、拿不到 `outcome`,也拿不到可写副本
 * (`Snapshot` 逐字列出少掉的那两栏,理由见 `world/state.ts`)。
 */
export type StubStrategy = (snapshot: Snapshot) => readonly Intent[];

/** 缺 `setSnapshot` 就 drain,是一次协议误用而不是策略行为,所以这里不静默返回空数组。 */
const DRAINED_BEFORE_SET = "执行器在收到快照之前就被要求交回 intents(两次宿主桥调用的顺序反了)";

/** 一个 tick 里 drain 两次。第二次不是「再来一遍」,是协议被调错了。 */
const DRAINED_TWICE =
  "一个 tick 里向同一个执行器要了两次 intents(一个 tick 一次 `__drainIntents()`)";

/** 造一个桩执行器。`strategy` 就是那一份参赛脚本的全部。 */
export const stubRunner = (strategy: StubStrategy): SeatRunner => {
  let pending: Snapshot | null = null;
  let drained = false;
  return {
    setSnapshot: (snapshot) => {
      // 一次 `setSnapshot` 就是一 tick 的开始:它把「已交回」重新武装,
      // 于是「一个 tick 一次」这条边每 tick 都重新计一次,而不是整局只计一次。
      pending = snapshot;
      drained = false;
    },
    drainIntents: () => {
      if (pending === null) {
        throw new Error(DRAINED_BEFORE_SET);
      }
      if (drained) {
        throw new Error(DRAINED_TWICE);
      }
      const snapshot = pending;
      // 先落「已交回」再调策略:策略自己抛异常时,这一 tick 仍然是「已经交回过一次」,
      // 否则异常路径会把它放行到第二次 drain,于是一个异常变成两个。
      drained = true;
      // 桩没有预算事实可报,故观测恒为空数组——**这是「桩路径零回归」的成本控制**:
      // 既有桩路径测试(fixtures / determinism / `exceptionTicks` 恒 0)一行不用改。
      return { intents: strategy(snapshot), observations: [] };
    },
  };
};
