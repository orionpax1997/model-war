/**
 * `runMatch`:从一份已装载的对局输入跑到终局,产出一份可复算的回放(hld §2.2.6 的脊柱)。
 *
 * ── 为什么这是**外部接口唯一**(ADR-0005) ──
 *
 * 对外只有「跑完一局、给出回放」这一件事。`processTick` 是处理器私有的内部缝,六个 intent 各有
 * 唯一实现因而不构成缝,把它们导出等于对外承诺可替换性——那正是 ADR-0005 逐条裁掉的平行表示。
 * 引擎的导出面(hld《模块的深度》)随 `runMatch` 一起收在这里:调用方要学的东西,只有这一件。
 *
 * ── 为什么入参是**已物化**的对象而不是一条路径 ──
 *
 * hld §2.2.8 把磁盘 I/O 排除在 engine 之外,校验(ajv)归 `apps/cli` 那个唯一实例。所以本函数
 * 吃的是「读盘 + 校验之后」的世界:规则集视图、地图、种子、四份存档引用、四个执行器。路径怎么来、
 * 哈希对不对得上、规则集版本三处一不一致——那些都在**装载期**由上层判完,判不过就不进本函数。
 * 于是「装载期拒跑(退出码 1)」与「跑起来(退出码 0/2)」的分界正好落在这一行。
 *
 * ── 为什么收的是**已构造好的执行器**而不是策略 ──
 *
 * 本函数对执行器的认知止于 `setSnapshot` / `drainIntents` 两条方法(hld §4.5,ADR-0005)。
 * 建 VM 与释放归**组装层**:`stubRunner`(测试)与真沙箱执行器是同一个缝的两个适配器。
 * 预算配置与可选观测出口一并收下:解析(规则集里的未定值→启用的轨)也在组装层,引擎不认识
 * 「未定值」。真沙箱执行器把脚本文本变成 `SeatRunner` 的那一步在引擎之外,本函数不参与。
 *
 * ── 终局行怎么来的 ──
 *
 * 步 5 与步 7 各自把终局写进 `state.outcome`(唯一出口),本函数只把它搬到末行 `result`。
 * 循环跑到 `state.outcome !== null` 为止:写 `outcome` 的那一 tick 就是收官那一 tick。
 * 「收官了却没有 `outcome`」在本函数里是一个**不该发生**的状态(步 5 / 步 7 每 tick 都判),
 * 出现即抛,而不是伪造一个「超时 + 全部并列」的兜底——那会让引擎故障伪装成一局正常超时。
 */

import type { MapDefinition, ReplayPlayerRef, ReplayResultLine, Ruleset } from "@model-war/replay";

import { processTick } from "./processor/index.js";
import { createRandom, fillVariantWalls } from "./driver/random.js";
import type { ObservationSink, SeatRunner } from "./runner/index.js";
import { buildMetaLine, serializeMetaLine, type MetaHead } from "./replay-writer/meta-line.js";
import type { TickSink } from "./replay-writer/sink.js";
import { loadRuleset, type RulesetView } from "./ruleset-loader/index.js";
import { createInitialState } from "./world/initial-state.js";
import type { GameState } from "./world/state.js";

/**
 * `runMatch` 的入参。每一项都**已经过装载期校验**:规则集版本三处一致、地图合法、四份存档
 * 齐备且哈希对得上——那些都在上层判完,本函数不再重复判,也不静默降级。
 */
export type RunMatchParams = {
  /** 已校验的规则集**取值文件**。本函数只做装载期整数闭包复核,不判版本三处一致(归上层)。 */
  readonly ruleset: Ruleset;
  /** 已校验的地图定义。种子驱动的**装饰性**变体在本函数内填入(hld §7.3:变体只做微扰)。 */
  readonly map: MapDefinition;
  /** 种子。驱动地图变体与确定性随机(hld §7.5 的 meta 栏之一,也是复算的锚)。 */
  readonly seed: number;
  /** meta 行里**由本函数不知道**的那几栏:时区、地图哈希、执行器读数。判别在 `runner` 上。 */
  readonly head: MetaHead;
  /** 四份存档引用(模型 / 存档路径 / 座位)。顺序与座位对齐,进 meta 行。 */
  readonly players: readonly ReplayPlayerRef[];
  /**
   * 四个座位**已构造好**的执行器(下标即座位序)。建 VM 与释放归**组装层**——引擎对执行器的
   * 认知止于 `setSnapshot` / `drainIntents` 两条方法,不知道 VM 存在。
   */
  readonly runners: readonly SeatRunner[];
  /** 预算配置(已启用的轨 + 阈值)。字段缺席即该轨不启用。本票只定义形状,不读它。 */
  readonly budget: BudgetConfig;
  /** 回放写出的唯一出口。本函数**不做磁盘 I/O**(hld §2.2.8),落到哪由上层决定。 */
  readonly sink: TickSink;
  /** 可选观测出口。缺席时墙钟软限与内存压力两类观测静默丢弃。 */
  readonly observations?: ObservationSink;
};

/**
 * 预算配置:组装层把规则集里**已启用**的轨与阈值解析好后传进来。
 *
 * 字段缺席即该轨不启用——不需要第二个字段表达「开但值是 0」。规则集里取未定值的键,由组装层读
 * 键清单的两态字段(`calibration.state`)决定缺席;引擎不认识「未定值」这个概念
 * (解析归组装层,见 spec《未定值与预算配置》)。
 *
 * 脚本体积上限不进这里:它是编译期的事,判定点在编译/校验层(编译后产物的字节数)。
 *
 * 本票只定义形状:阈值判定与淘汰归后续票,`runMatch` 现在只把它收下,不读它。
 */
export type BudgetConfig = {
  /** 累计异常判负阈值(次/整局)。 */
  readonly exceptionTickLimit?: number;
  /** 单 tick 控制流事件计数上限(次/tick)。 */
  readonly eventTickLimit?: number;
  /** 单 tick API 调用计数上限(次/tick)。 */
  readonly apiCallTickLimit?: number;
  /** VM 线性内存分配上限(bytes)。 */
  readonly memoryLimit?: number;
  /** 内存判据判罚线(bytes,tick 末存活堆读数)。 */
  readonly memoryTickCeiling?: number;
  /** 单 tick 墙钟软限(ms,只观测)。 */
  readonly wallClockSoftLimit?: number;
  /** 墙钟硬超时(ms,只作废该场)。 */
  readonly wallClockHardTimeout?: number;
};

/** `runMatch` 的返回值:终局那一行 + 收官时的状态 + 跑了多少 tick。 */
export type RunMatchResult = {
  /** 回放末行 `result`(hld §7.5)。 */
  readonly result: ReplayResultLine;
  /**
   * 收官时的完整状态。
   *
   * **`outcome` 在这一刻必已置**(它就是循环的退出条件),与 `result` 是同一份终局的两条读法:
   * `result` 是它的行格式投影,`finalState` 是引擎侧的原样。
   */
  readonly finalState: GameState;
  /** 结算过的 tick 数。超时收官时它等于 `ruleset.tickLimit`。 */
  readonly tickCount: number;
};

/**
 * 终局行:`state.outcome` 的行格式投影。
 *
 * `state.outcome` 在收官时必已置(步 5 或步 7 写下),但类型上仍可空,故这里判一次:
 * 空即引擎故障——循环条件就是 `state.outcome === null`,能走到这里说明退出条件被绕过。
 * 不伪造「全部并列」的兜底:伪造会把一次引擎故障伪装成一局正常超时,而报告正是靠 `reason` 分类。
 */
const resultLineOf = (state: GameState): ReplayResultLine => {
  const outcome = state.outcome;
  if (outcome === null) {
    throw new Error("对局收官时没有终局结果——引擎故障(步 5 / 步 7 未写 state.outcome)");
  }
  return {
    type: "result",
    rankings: [...outcome.rankings],
    reason: outcome.reason,
    territoryScores: [...outcome.territoryScores],
  };
};

/**
 * 跑完一局:装载 → 开局 → 逐 tick 结算并写行 → 收官写末行。
 *
 * **每 tick 的结算与写行都由 `processTick` 做**(步 6 写那一行),本函数只做编排:逐 tick 把上一
 * tick 的返回值喂给下一 tick、直到某一步写下了 `state.outcome`。执行器由调用方**已构造好**传入。
 * 「tick 的结算」这条规则因此**只有一处实现**,本函数不可能与它分叉。
 */
export const runMatch = (params: RunMatchParams): RunMatchResult => {
  const { ruleset, map, seed, head, players, runners, sink, observations } = params;
  // `params.budget`:本票只把它收进入参形状;阈值判定与淘汰归后续票,这里不读它。
  const view: RulesetView = loadRuleset(ruleset);

  // 种子驱动的变体墙在开局前填一次(hld §7.3「地图 + 种子 → 地形是纯函数」)。这一步曾经缺失:
  // `fillVariantWalls` 写好了却没人调,于是地形与种子对不上、`getTerrainAt` 无源。
  // 消费顺序由 `fillVariantWalls` 自己保证(槽位声明序),这里只管把填好的地图交给开局。
  const filledMap = fillVariantWalls(createRandom(seed), map).map;
  let state = createInitialState(ruleset, filledMap);

  // meta 行:第一 tick 之前落一次(hld §7.5)。十二栏的键序由 `buildMetaLine` 承担;
  // 种子从入参注入(它有**一个家**:对局输入),meta 行是它的投影而不是第二个可任填的地方。
  sink.write(serializeMetaLine(buildMetaLine(head, seed, players)));

  let tickCount = 0;
  // `state.outcome !== null` 就是收官:写它的那一 tick 是最后结算的一 tick。
  while (state.outcome === null) {
    const ticked = processTick(state, runners, view, sink, observations);
    state = ticked.state;
    tickCount = ticked.state.tick;
  }

  const result = resultLineOf(state);
  sink.write(JSON.stringify(result));
  return { result, finalState: state, tickCount };
};
