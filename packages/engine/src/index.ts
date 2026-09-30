/**
 * engine 包:确定性内核 + 沙箱(hld §3.1)。
 * 依赖方向单向:engine → replay → schema;不得 import runner / gen(hld §3.2)。
 * 运行时只允许 `node:crypto` 一个内置模块;wasm 字节由上层读盘后传入,本包不做磁盘 I/O。
 *
 * 状态模型用 `type` 而非 `interface`:要进入回放的形状必须可赋给 schema 的 `JsonValue`,
 * 而只有类型别名拿得到隐式索引签名。
 */

import { stateHashOf } from "@model-war/replay";

/** 座位下标。固定 0..3,顺序即 playerIndex 串行执行顺序(hld §2.3)。 */
export type PlayerIndex = 0 | 1 | 2 | 3;

export type UnitType = "worker" | "melee" | "ranged" | "cavalry";

export type Player = {
  index: PlayerIndex;
  /** 全局共享资源池,无上限。全整数(FR-2 AC3)。 */
  resources: number;
  alive: boolean;
  /** 累计异常 tick 数;随 JSONL 持久化,VM 重建后由持久化值续算不清零(hld §5.2)。 */
  exceptionTicks: number;
};

export type Unit = {
  id: number;
  owner: PlayerIndex;
  type: UnitType;
  x: number;
  y: number;
  hp: number;
  /** 农民携带量;其余兵种恒 0。 */
  carrying: number;
};

export type Site = {
  id: number;
  kind: "base" | "resource";
  x: number;
  y: number;
  /** -1 为中立 */
  owner: -1 | PlayerIndex;
  progressOwner: -1 | PlayerIndex;
  progress: number;
};

export type Production = {
  baseId: number;
  type: UnitType;
  ticksLeft: number;
};

export type Outcome = {
  /** rankings[i] = 玩家 i 的名次(1 起,可并列) */
  rankings: readonly number[];
  reason: "victory" | "shortcut" | "timeout";
  territoryScores: readonly number[];
};

/** 对局状态。units/sites 按数值 id 升序维护——该不变量是回放哈希可复算的前提(hld §4.6)。 */
export type GameState = {
  /** 唯一时间单位 */
  tick: number;
  players: readonly Player[];
  units: readonly Unit[];
  sites: readonly Site[];
  productions: readonly Production[];
  /** 全局单调递增,对象创建时分配 */
  nextId: number;
  outcome: Outcome | null;
};

/**
 * 序列化一个 tick 的回放行(hld §7.5 的 tick 行格式)。
 *
 * 写向由调用方负责:本包返回行文本,不碰 fs(hld §2.2.8)。
 * `events` 在空壳阶段恒为空数组——事件流由结算管线填充,此处不预造行为。
 * `nextId` / `outcome` 不进 tick 行(它们是状态机与末行 result 的事,hld §7.5)。
 */
export const replayTickLine = (state: GameState): string => {
  const { tick, players, units, sites, productions } = state;
  const settled = { players, units, sites, productions };
  return JSON.stringify({
    type: "tick",
    tick,
    ...settled,
    events: [],
    stateHash: stateHashOf(settled),
  });
};
