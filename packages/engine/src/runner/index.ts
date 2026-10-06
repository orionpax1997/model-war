/**
 * 执行器缝:**只有两次宿主桥调用,中间不设任何表示**(hld §4.5,ADR-0005)。
 *
 * ── 为什么这里没有 `Runner` 基类、没有工厂、没有生命周期协议 ──
 *
 * ADR-0005 把那三个方案逐条裁掉了,理由它们各自成立:缝收「一个纯参数一个纯返回值」会与
 * hld §4.5 的两次桥调用构成**两套平行的表示**;缝收一个持有 VM 生命周期的 session 对象会逼
 * `StubRunner` 造一个每个方法都「什么都不做」的空壳 VM。本模块的对外面积就是下面那两个方法,
 * 后来的沙箱执行器(票 G)要做的只是**提供这两个方法**,不是**继承**一个什么。
 *
 * ── 为什么桥名要由 `HOST_BRIDGE_PREFIX` 拼出来,而不是写在类型里 ──
 *
 * 宿主桥函数名有**两份必须一致的地方**:真源包的前缀常量(`packages/schema` 的
 * `HOST_BRIDGE_PREFIX`,`__`)与 hld §4.5 的协议描述。本仓对 `__*` 前缀有一条静态全禁的纪律
 * (hld §6.2),它和「宿主注入什么」是同一道纪律的两端:一边禁脚本碰到 `__*`,一边由宿主自己
 * 按同一个前缀**拼**出注入的名字。任何一处手写字面量 `__setSnapshot`,这条纪律就只剩下一半。
 * 故本模块导出两个由该常量拼出的名字,`runner/index.test.ts` 钉住「缝上的方法名 === 拼出来的桥名」。
 *
 * ── `RunnerKind` 为什么在这里 ──
 *
 * 「这一局是谁跑的」是执行器的事实(meta 行第 12 栏就是它),而 meta 行由回放写出侧组装。
 * 这个判别联合跟着**谁跑**这件事走,所以它的家在执行器这一格,不在写出侧。
 */

import { HOST_BRIDGE_PREFIX } from "@model-war/replay";
import type { Intent } from "../processor/intents.js";
import type { Snapshot } from "../world/state.js";

/** 进的那次桥:`__setSnapshot(snapshot)`。名字由前缀常量拼,不手写字面量。 */
export const HOST_BRIDGE_SET_SNAPSHOT = `${HOST_BRIDGE_PREFIX}setSnapshot`;

/** 出的那次桥:`__drainIntents()`。同上。 */
export const HOST_BRIDGE_DRAIN_INTENTS = `${HOST_BRIDGE_PREFIX}drainIntents`;

/** 哪一个执行器跑的。meta 行第 12 栏的取值域,`quickjs` 那一值随票 G 落地。 */
export type RunnerKind = "stub" | "quickjs";

/**
 * 观测种类:预算裁决的计量全在执行器侧(计数器住宿主闭包、内存读数要强制回收后取),
 * 而状态写入必须走引擎的 `apply()` 唯一写入口。于是观测只能搭**那一次返回载荷**回来,
 * 由种类分成三条去向:
 *
 * - `tripped`:某条轨已触限——由步 0 落成状态变更(累加 `exceptionTicks`)。判据由执行器算好,
 *   引擎**不做裁决**。阈值判定与淘汰不在本票。
 * - `wall-clock-soft`:墙钟软限观测,只披露不判罚——转发给观测出口。
 * - `memory-pressure`:内存压力观测,只披露不判罚——转发给观测出口。
 */
export type ObservationKind = "tripped" | "wall-clock-soft" | "memory-pressure";

/**
 * 一条观测:种类 + 轨名 + 观测值 + 上限值。
 *
 * `track` 是规则集里那条轨的名字(如 `eventTickLimit`),用来读数与定位。`value` 是观测读数,
 * `limit` 是当时那条轨的上限。引擎在这条载荷上不做裁决:它只把 `tripped` 交给唯一写入口、
 * 把另外两类原样转发。
 */
export type Observation = {
  readonly kind: ObservationKind;
  readonly track: string;
  readonly value: number;
  readonly limit: number;
};

/**
 * `drainIntents()` 的返回载荷:**intents 加观测**。
 *
 * 这不新增中间表示、也不新增桥调用——ADR-0005 的「缝就是那两次宿主桥调用」原样成立,
 * 只是回来的那一次载荷多了几栏。`observations` 为空数组时,这一 tick 没有任何预算事实要报。
 */
export type RunnerOutput = {
  readonly intents: readonly Intent[];
  readonly observations: readonly Observation[];
};

/**
 * 观测出口。**可选**:缺席时另外两类观测静默丢弃,这样引擎单测不必关心它。
 *
 * 与回放 sink 平行但独立:观测永远不进回放、更不进 `stateHash`(hld《观测通道》)。
 */
export type ObservationSink = {
  readonly record: (observation: Observation) => void;
};

/**
 * 一个座位的一个执行器。**这就是缝的全部**:两个方法,中间没有任何表示。
 *
 * 两个方法的签名就是 hld §4.5 那两次桥调用的签名,不多一栏(没有 `load` / `dispose` / `turn`)。
 * 「每 tick 一次」由**调用点**保证而不是由协议对象保证——协议对象每加一个方法,就多一处
 * 「这一步该不该调它」要由调用方记着的地方。建 VM 与释放归组装层,缝上不持生命周期。
 */
export type SeatRunner = {
  /** 把这一 tick 的只读快照交给执行器。快照下 tick 全部作废,对象身份不跨 tick 保证。 */
  readonly setSnapshot: (snapshot: Snapshot) => void;
  /**
   * 交回这一 tick 的 intents 与观测。**空数组也是一种合法交回**(这一 tick 什么都不做)。
   * 观测搭同一次载荷回来,不另开一条查询方法(理由见 `ObservationKind` 的注释)。
   */
  readonly drainIntents: () => RunnerOutput;
};
