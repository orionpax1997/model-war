/**
 * 状态模型(hld §4.1)。**本文件是那份形状的唯一家**:快照、回放行、脚本类型面读的都是它。
 *
 * ── 为什么产线订单挂在 `Site` 上,而不是一张独立的 `Production[]` ──
 *
 * 契约面 `docs/rules-v1/api.md` 已经对模型承诺了 `producing: { type, remainingTicks } | null`
 * 挂在点位上,并宣告「字段名在这段声明期间不改」;而 hld §4.1 当年写的是 `productions: Production[]`。
 * 两条路可选:状态保留队列表、快照投影成点位上的那一栏,或者让状态模型直接长成契约承诺的形状。
 * 选后者,因为 hld §4.5 已经裁定「快照 = GameState 的**深拷贝**」——一旦引入投影,快照就多一层
 * 需要同步的表示,那是**新的漂移面**;而契约面那句「投影回来」会一直等下去(它等的是投影这件事本身)。
 * 选后者的结果是三处(契约面 / 状态模型 / 回放行)用**同一个形状**,`api.md` 那句「还没有对应的投影」直接消掉。
 *
 * ── 一切数值不在结构里 ──
 *
 * HP、造价、速度、阈值、上限一个都不出现在本文件里:它们由 `rulesets/*.json` 装载
 * (hld §4.1)。这个文件里出现的整数只有座位号 `0..3` 与中立的 `-1`,它们是编号不是参数。
 *
 * 类型一律用 `type` 而非 `interface`:进回放的形状必须可赋给 `JsonValue`,而只有类型别名拿得到隐式索引签名。
 */

/** 座位下标。固定 0..3,顺序即 playerIndex 串行执行顺序(hld §2.3)。 */
export type PlayerIndex = 0 | 1 | 2 | 3;

/**
 * 地形:整局静态的板面(hld §7.3「地图 + 种子 → 地形是纯函数」)。
 *
 * ── 为什么是布尔格而不是行字符串 ──
 * 地形进状态之后,引擎侧**唯一**会问它的问题是「(x, y) 是不是墙」(移动裁决与寻路两处),
 * 而脚本侧的 `getTerrainAt` 要的也正是这一个答案。行字符串(`"."`/`"#"`)每次查询都要
 * 先切片再比字符,等于把地图的**书写格式**带进状态的读取路径;布尔格让那个问题退化成一次下标。
 * 地图那一侧仍旧以行字符串书写(`MapDefinition.terrain`,由地图图的作者编辑),转换只在
 * `createInitialState` 那一次发生。
 *
 * `true` = 墙(不可通行),`false` = 平原。越界由读取方判,不在这里表达。
 */
export type Terrain = readonly (readonly boolean[])[];

/** 中立。点位属主的取值域比座位号宽一格(hld §4.1)。 */
export type NeutralOwner = -1;

/** 点位属主:座位或中立。 */
export type Owner = NeutralOwner | PlayerIndex;

export type UnitType = "worker" | "melee" | "ranged" | "cavalry";

/** 四条兵种线的一个封闭集合。判定用它而不是 `string`:地图声明的初始兵种名要过这一关。 */
export const UNIT_TYPES: readonly UnitType[] = ["worker", "melee", "ranged", "cavalry"];

export const isUnitType = (value: string): value is UnitType =>
  UNIT_TYPES.includes(value as UnitType);

export type Player = {
  readonly index: PlayerIndex;
  /** 全局共享资源池,无上限、不按基地分池。全整数(FR-2 AC3)。 */
  readonly resources: number;
  readonly alive: boolean;
  /**
   * 累计异常 tick 数;随 JSONL 持久化,VM 重建后由持久化值续算不清零(hld §5.2)。
   * 经济死亡**不设字段**(它是两个谓词的与、可推导),席位**不在任何字段里**(只从 `getMyIndex()` 读)。
   */
  readonly exceptionTicks: number;
};

export type Unit = {
  readonly id: number;
  readonly owner: PlayerIndex;
  readonly type: UnitType;
  readonly x: number;
  readonly y: number;
  readonly hp: number;
  /** 农民携带量;其余兵种恒 0。 */
  readonly carrying: number;
};

/**
 * 一条产线当前的订单。字段名照契约面 `api.md` 的声明:改它要走一次有意的变更,像改一个错误码名。
 */
export type SiteProduction = {
  readonly type: UnitType;
  readonly remainingTicks: number;
};

export type SiteKind = "base" | "resource";

export type Site = {
  readonly id: number;
  readonly kind: SiteKind;
  readonly x: number;
  readonly y: number;
  /** -1 为中立。 */
  readonly owner: Owner;
  readonly progressOwner: Owner;
  readonly progress: number;
  /**
   * 仅资源点有:这个矿还剩多少资源。
   *
   * 用**可选**而不是哨兵值:「不是资源点」与「是资源点但已采空」是两件事,后者是 `0`、
   * 前者是**键不存在**。写成 `remaining: number` 再拿一个魔数当「无」会把两者压成一个取值。
   */
  readonly remaining?: number;
  /** 这一条产线当前的订单,没有订单时是 `null`。开局每条产线都是空的。 */
  readonly producing: SiteProduction | null;
};

/** 终局原因。四个值,判别联合的穷尽性由 `satisfies never` 一类断言兜住(见 outcome.test)。 */
export type OutcomeReason = "victory" | "shortcut" | "timeout" | "all-eliminated";

export type Outcome = {
  /** rankings[i] = 玩家 i 的名次(1 起,可并列),由 gdd《胜利与淘汰》的排序规则产生。 */
  readonly rankings: readonly number[];
  readonly reason: OutcomeReason;
  /** 已淘汰玩家的领土分恒为 0(点位已回归中立、存活单位造价为 0)。 */
  readonly territoryScores: readonly number[];
};

/**
 * 对局状态。
 *
 * **units / sites 按数值 id 升序维护**,不是只在写出前排一次:该不变量是回放哈希可复算的前提
 * (hld §4.1/§4.6)——`stateHashOf` 保序不重排,所以「维护时乱序」会直接表现为哈希变化。
 */
export type GameState = {
  /** 唯一时间单位。 */
  readonly tick: number;
  /**
   * 网格边长。
   *
   * ── 为什么地形与尺寸进状态,而不是留在开局输入里 ──
   * hld §4.5 的脚本查询面里有 `getTerrainAt`,而脚本看到的**只有快照**;快照已定稿为
   * 「`GameState` 的深拷贝」(02a)。地形不进状态,`getTerrainAt` 就没有来源——给快照开一条
   * 「除状态之外再传一份板面」的第二条路,等于让「快照 = 状态的深拷贝」这句话不再成立。
   * 移动裁决也要判「目标格是不是墙」,同样只能从这里读。
   */
  readonly size: number;
  /** 地形。整局静态、随状态走;不进 tick 行、不进 `stateHash`(理由见 `replay-writer/tick-line.ts`)。 */
  readonly terrain: Terrain;
  readonly players: readonly Player[];
  readonly units: readonly Unit[];
  readonly sites: readonly Site[];
  /** 全局单调递增,对象创建时分配;被销毁对象的号不回收。 */
  readonly nextId: number;
  readonly outcome: Outcome | null;
  /**
   * 首触(任意敌对单位 Chebyshev ≤ 2)发生的那一 tick;**整局一条**,未发生为 `null`。
   *
   * ── 为什么是一个「时刻」而不是一个布尔 ──
   * 收集器每 tick 新建,而「全局一条」要求跨 tick 记忆——能跨 tick 的只有 `GameState`。
   * 回放也必须能复现「这是第一次」,所以记忆不能藏在收集器或某处模块级变量里。
   * 记**时刻**而不是布尔:hld §8.3 的叙事时间线上,首触是要标一个时间点的那件事,
   * 而布尔的读法 `true` 会把这个时刻丢掉;`null` 与数字的区分同时承担了「有没有发生过」。
   * 它**不进快照**(脚本不该读到引擎的内部记账,先例是 `nextId` 与 `outcome`)。
   */
  readonly firstContactTick: number | null;
};

/**
 * 脚本这一 tick 读到的那份只读快照。
 *
 * 它**刻意不是 `Pick<GameState, …>`**:快照不是状态的一个子集视图,而是另一份**逐字列出**的形状——
 * 契约面对模型承诺了字段名,「字段名在这段声明期间不改」,于是这份清单只能被显式地写出来,
 * 靠一个 `Pick` 隐式跟着状态走的话,给状态加一栏会**静默**把那一栏塞进脚本可见面。
 *
 * 少掉的几栏是有理由的:对象 id 的分配器(`nextId`)、终局结果(`outcome`)与首触记账
 * (`firstContactTick`)是引擎内部的,契约面点名它们「不在快照里,别去找」。
 *
 * `size` / `terrain` 在快照里**是为了 `getTerrainAt`**,不是因为「顺手多带一路板面」:
 * hld §4.5 的脚本查询面需要它,而快照是脚本唯一能看到的世界。
 */
export type Snapshot = {
  readonly tick: number;
  readonly size: number;
  readonly terrain: Terrain;
  readonly players: readonly Player[];
  readonly units: readonly Unit[];
  readonly sites: readonly Site[];
};
