/**
 * 快照边界(hld §4.5:快照 = `GameState` 的深拷贝,`Object.freeze` 由引擎侧在深拷贝上执行)。
 *
 * ── 四条取舍,每条都有代价 ──
 * 1. **一次 `structuredClone`**,不做「逐字段手抄」:手抄漏一个字段就是一处静默不同步,而快照是
 *    每 tick 的主要开销,一次原生深拷贝比一段人手映射既快又不会漏。
 * 2. **不用 JSON 往返**:`JSON.parse(JSON.stringify(x))` 会顺手把对象键序规范化成书写顺序,
 *    而 `stateHash` 另有一套规范化(键升序)。两套规范化合成一套之后,「键序为什么变了」就成了
 *    一道要靠读实现才答得出的题,而它会发生在拷贝里而不是发生在该发生的地方。
 *    `structuredClone` 是全局不是 `node:` 导入,也不碰依赖巡航约束。
 * 3. **一份快照四方共用**,不做四份:每 tick 四倍开销买不到任何东西——快照本来就是只读的,
 *    真正的隔离由「深拷贝」提供(座位 0 改不动座位 1 读到的东西,因为它们读的是同一个只读对象)。
 * 4. **深 freeze**:`Object.freeze` 是浅的。冻住顶层之后嵌套的单位数组仍可写,而四个座位**串行**执行,
 *    座位 0 若经任何路径改了嵌套字段,座位 1 读到的就是脏的——这条 bug 在整场对局里表现为
 *    「某一方的策略莫名其妙更聪明」,几乎不可查。
 *
 * ── 深 freeze 与 `stateHash` 的规范化是两次遍历,不许合并 ──
 *
 * 合并看起来省一半开销,代价是「这一 tick 冻没冻」开始依赖「这一 tick 算没算 hash」:
 * 某条路径算了 hash 没冻快照,某条路径冻了快照没算 hash,而这两条路径的差异只会在**脏写**
 * 真正发生时显形。规则层要的是「冻没冻」这件事与别的事情无关,所以本模块的深 freeze 自己走
 * 自己的一次递归,与 `packages/replay` 的规范化序列化不共享任何一行遍历代码。
 *
 * ── 引擎真状态永远不 freeze ──
 *
 * 它要被 `apply()` 写。这里冻的是**拷贝**,不是状态。
 */

import type { GameState, Snapshot } from "../world/state.js";

/**
 * 一次递归遍历的深 freeze。
 *
 * 遍历与冻结**同一次下降**:每进入一个对象/数组就把它冻掉,再按引用继续往下走。
 * 两趟(先遍历后冻)会让「冻到一半抛错」这件事留下一个半冻的快照,那比不冻更坏。
 */
const freezeDeep = <T>(value: T): T => {
  if (value === null || typeof value !== "object") {
    return value;
  }
  for (const nested of Object.values(value)) {
    freezeDeep(nested);
  }
  return Object.freeze(value) as T;
};

/** 快照的几栏是**逐字列出**的,不是 `Pick<GameState, …>`(理由见 state.ts 的 `Snapshot` 注释)。 */
const snapshotShapeOf = (state: GameState): Snapshot => ({
  tick: state.tick,
  players: state.players,
  units: state.units,
  sites: state.sites,
});

/**
 * 每 tick 一次:深拷贝 + 深 freeze,交给四个座位共用。
 *
 * 返回的这份对象**下 tick 全部作废**,对象身份不跨 tick 保证(hld §4.5)。
 * 脚本跨 tick 只能用自己的记忆与数值 id,不得缓存对象引用。
 */
export const buildSnapshot = (state: GameState): Snapshot =>
  freezeDeep(structuredClone(snapshotShapeOf(state)));
