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
 * 吃的是「读盘 + 校验之后」的世界:规则集视图、地图、种子、四份存档引用、四个策略。路径怎么来、
 * 哈希对不对得上、规则集版本三处一不一致——那些都在**装载期**由上层判完,判不过就不进本函数。
 * 于是「装载期拒跑(退出码 2)」与「跑起来(退出码 0/1)」的分界正好落在这一行。
 *
 * ── 为什么策略是**普通 TS 函数**而不是脚本文本 ──
 *
 * 见 `runner/stub.ts` 的头注:桩执行器的策略是 TS 函数,不经字符串、不经 VM。冻结脚本的**文本**
 * 怎么变成一个策略,是沙箱执行器那一格的事(它才有编译器与 QuickJS)。本票交付的是脊柱本身:
 * 一个空转的对局跑满 600 tick 到超时,回放端到端可渲染。策略暂由调用方给(演示态给的是空策略),
 * 真沙箱那一格落地后由它把脚本文本变成同签名的函数,`runMatch` 这一行不用动。
 *
 * ── 终局行怎么来的 ──
 *
 * `processTick` 的步 7 只给**触发信号** `limitReached`,不写 `state.outcome`——名次算法归票 09。
 * 于是本函数按这个次序取终局:**若 `state.outcome` 已置(票 09 之后),直接用它**;否则退到
 * 「超时 + 全部并列」。后者对**空转对局**是诚实答案(四方领土分相同,按 gdd 的排序规则就是全部并列),
 * 而不是占位:一个 `rankings: []` 的半截 `Outcome` 会被渲染器与战报当成「这局打完了」读,那更坏。
 */

import type { MapDefinition, ReplayPlayerRef, ReplayResultLine, Ruleset } from "@model-war/replay";

import { processTick } from "./processor/index.js";
import { stubRunner, type StubStrategy } from "./runner/stub.js";
import { buildMetaLine, serializeMetaLine, type MetaHead } from "./replay-writer/meta-line.js";
import type { TickSink } from "./replay-writer/sink.js";
import { loadRuleset, type RulesetView } from "./ruleset-loader/index.js";
import { createInitialState } from "./world/initial-state.js";
import type { GameState } from "./world/state.js";

/** 四个座位,下标即 `playerIndex`(hld §2.3 的串行执行序)。 */
const SEATS = [0, 1, 2, 3] as const;

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
  /** 四份存档引用(模型 / 存档路径 / 座位)。顺序与 `SEATS` 对齐,进 meta 行。 */
  readonly players: readonly ReplayPlayerRef[];
  /** 四个座位的参赛策略(普通 TS 函数,见文件头注)。空转对局给四个空策略。 */
  readonly strategies: readonly StubStrategy[];
  /** 回放写出的唯一出口。本函数**不做磁盘 I/O**(hld §2.2.8),落到哪由上层决定。 */
  readonly sink: TickSink;
};

/** `runMatch` 的返回值:终局那一行 + 收官时的状态 + 跑了多少 tick。 */
export type RunMatchResult = {
  /** 回放末行 `result`(hld §7.5)。 */
  readonly result: ReplayResultLine;
  /**
   * 收官时的完整状态。
   *
   * **`outcome` 此刻仍是 `null`**:本票一条游戏机制都不实现,判据与名次算法归票 09,
   * 而步 7 只给触发信号、不写半截 `outcome`。本票的终局结论在 `result` 那一栏(它按
   * `state.outcome` —— 票 09 之后 —— 或「超时 + 全部并列」取出)。
   * 把「`outcome` 已置」写成事实会是句假话:读它的人会拿到 `null` 去解引用。
   */
  readonly finalState: GameState;
  /** 结算过的 tick 数。`limitReached` 时它等于 `ruleset.tickLimit`。 */
  readonly tickCount: number;
};

/** 四个座位必须各有一个策略。少一个在装载期就该拒,不该在这里补一个空的。 */
const strategiesOf = (strategies: readonly StubStrategy[]) => {
  const runners = SEATS.map((seat) => {
    const strategy = strategies[seat];
    if (strategy === undefined) {
      throw new Error(
        `座位 ${String(seat)} 没有参赛策略:策略数组必须按 playerIndex 0..3 对齐,长度 4`,
      );
    }
    return stubRunner(strategy);
  });
  return runners;
};

/**
 * 终局行:优先用 `state.outcome`(票 09 之后),否则退到「超时 + 全部并列 + 领土分 0」。
 *
 * 后者对**空转对局**是诚实答案而不是占位:四方没有任何单位被消灭、没有任何点位易主,
 * 领土分相同,按 gdd 的排序规则(层内按领土分,仍相同则并列)就是全部并列。写成
 * `rankings: []` 才是占位——那会被渲染器与战报当成「这局打完了」读。
 */
const resultLineOf = (state: GameState, limitReached: boolean): ReplayResultLine => {
  if (state.outcome !== null) {
    return {
      type: "result",
      rankings: [...state.outcome.rankings],
      reason: state.outcome.reason,
      territoryScores: [...state.outcome.territoryScores],
    };
  }
  if (limitReached) {
    return {
      type: "result",
      rankings: SEATS.map(() => 1),
      reason: "timeout",
      territoryScores: SEATS.map(() => 0),
    };
  }
  // 既无 outcome 又未到 tickLimit:这不该发生(步 7 每 tick 都判),出现即引擎故障。
  throw new Error(
    "对局在未达 tickLimit 时收官且没有终局结果——引擎故障(步 7 的 limitReached 判定与终局行不一致)",
  );
};

/**
 * 跑完一局:装载 → 开局 → 逐 tick 结算并写行 → 收官写末行。
 *
 * **每 tick 的结算与写行都由 `processTick` 做**(步 6 写那一行),本函数只做编排:把四个
 * 策略包成执行器、逐 tick 把上一 tick 的返回值喂给下一 tick、直到步 7 说到顶了。
 * 「tick 的结算」这条规则因此**只有一处实现**,本函数不可能与它分叉。
 */
export const runMatch = (params: RunMatchParams): RunMatchResult => {
  const { ruleset, map, seed, head, players, strategies, sink } = params;
  const view: RulesetView = loadRuleset(ruleset);

  let state = createInitialState(ruleset, map);
  const runners = strategiesOf(strategies);

  // meta 行:第一 tick 之前落一次(hld §7.5)。十二栏的键序由 `buildMetaLine` 承担;
  // 种子从入参注入(它有**一个家**:对局输入),meta 行是它的投影而不是第二个可任填的地方。
  sink.write(serializeMetaLine(buildMetaLine(head, seed, players)));

  let tickCount = 0;
  let limitReached = false;
  while (!limitReached) {
    const ticked = processTick(state, runners, view, sink);
    state = ticked.state;
    tickCount = ticked.state.tick;
    limitReached = ticked.limitReached;
  }

  const result = resultLineOf(state, limitReached);
  sink.write(JSON.stringify(result));
  return { result, finalState: state, tickCount };
};
