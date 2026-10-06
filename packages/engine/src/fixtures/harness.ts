/**
 * 真引擎上的**薄跑批 harness**:`runMatch` 一个对局是引擎唯一的粒度,而票 11 的三条桩结论要的
 * 是「一批对局的分布」。这一层只做三件事——把一个对局包起来、把回放行解析出来、把一批组织起来。
 *
 * ── 为什么它不做磁盘 I/O ──
 *
 * hld §2.2.8 把磁盘 I/O 排除在 engine 之外(依赖门禁也拦 `node:*`)。本目录是非测试运行时代码,
 * 所以**读 `rulesets/*.json` / `maps/*.json` 是调用方的事**:夹具的 `*.test.ts` 用 `node:fs`
 * 读盘、把已物化的对象传进来(先例见 `run-match.test.ts` 的 `read`)。harness 收下的是对象。
 *
 * ── 为什么它是「一批」而不是「一场」 ──
 *
 * 桩探针(`.scratch/rules-calibration/sim/`)量的一律是**分布**(min / 中位 / max、某种结局的
 * 占比),不是一个对局的一次读数。把它落成「接受一组种子的 `runBatch`」而不是让每个夹具各写一层
 * `for` 循环:批量这一层只有一个实现,三个夹具与首触复核共用它。
 *
 * ── 读回放 vs 读返回值 ──
 *
 * 本层同时交回 **`lines`(已落盘回放的字面读法)** 与 **`finalState`(引擎返回的终局)**。
 * 两者是同一局的两条读法;哪一条是某个探针的口径,由那个探针自己选并写清(票 11 §2.3)。
 */

import type {
  MapDefinition,
  ReplayLine,
  ReplayPlayerRef,
  ReplayResultLine,
  ReplayTickLine,
  Ruleset,
} from "@model-war/replay";

import { runMatch } from "../index.js";
import type { StubStrategy } from "../runner/stub.js";
import type { GameState, PlayerIndex } from "../world/state.js";

/** 四个座位,下标即 `playerIndex`(hld §2.3)。 */
export const SEATS: readonly PlayerIndex[] = [0, 1, 2, 3];

/** 桩执行器跑出来的局在 meta 行里的标记。夹具一律走桩,不留第二值。 */
const FIXTURE_MAP_HASH = "f".repeat(64);

/**
 * 夹具里的参赛者引用。名字带 `proxy-` 前缀,就是为了让任何从回放里读到的读数一眼看出
 * 「这不是那 12 个真脚本,是票 11 的代理策略」(口径可比性的前提)。
 */
export const proxyPlayers = (): readonly ReplayPlayerRef[] =>
  SEATS.map((seat) => ({
    model: `proxy-${String(seat)}`,
    archiveRef: `archive/proxy-${String(seat)}/r1`,
    seat,
  }));

/** 一个座位的策略工厂:吃座位、种子与规则集,交回该座位这一局用的策略。 */
export type SeatStrategyOf = (context: {
  readonly seat: PlayerIndex;
  readonly seed: number;
  readonly ruleset: Ruleset;
}) => StubStrategy;

/** 一局跑完之后手上有的三样东西。 */
export type FixtureMatch = {
  /** 已落盘回放的字面内容(每行一条字符串,含 meta / tick / result)。 */
  readonly lines: readonly string[];
  /** 上面那份字面内容解析后的行(hld §7.5)。 */
  readonly parsed: readonly ReplayLine[];
  /** 末行 `result`。 */
  readonly result: ReplayResultLine;
  /** 引擎返回的终局状态(与 `result` 是同一份终局的两条读法)。 */
  readonly finalState: GameState;
  /** 结算过的 tick 数。超时收官时等于 `ruleset.tickLimit`。 */
  readonly tickCount: number;
};

export type FixtureMatchInput = {
  readonly ruleset: Ruleset;
  readonly map: MapDefinition;
  readonly seed: number;
  readonly strategies: readonly StubStrategy[];
};

/** 跑一局:收集 sink 到一个字符串数组,再解析回来。磁盘 I/O 留在调用方。 */
export const playMatch = (input: FixtureMatchInput): FixtureMatch => {
  const lines: string[] = [];
  const outcome = runMatch({
    ruleset: input.ruleset,
    map: input.map,
    seed: input.seed,
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: FIXTURE_MAP_HASH },
    players: proxyPlayers(),
    strategies: input.strategies,
    sink: { write: (line) => void lines.push(line) },
  });
  return {
    lines,
    parsed: lines.map((line) => JSON.parse(line) as ReplayLine),
    result: outcome.result,
    finalState: outcome.finalState,
    tickCount: outcome.tickCount,
  };
};

/** 一批:同一张图、同一组种子、同一个策略工厂。每个座位每局拿一份新策略。 */
export type BatchInput = {
  readonly ruleset: Ruleset;
  readonly map: MapDefinition;
  readonly seeds: readonly number[];
  readonly strategyOf: SeatStrategyOf;
};

export const runBatch = (input: BatchInput): readonly FixtureMatch[] =>
  input.seeds.map((seed) =>
    playMatch({
      ruleset: input.ruleset,
      map: input.map,
      seed,
      strategies: SEATS.map((seat) => input.strategyOf({ seat, seed, ruleset: input.ruleset })),
    }),
  );

/** 一套种子。种子只经开局前的变体填墙进对局(hld《确定性》,记录 #12),所以取连续值即可。 */
export const seedsFrom = (count: number, start = 11): readonly number[] =>
  Array.from({ length: count }, (_unused, index) => start + index);

/** tick 行,按 tick 升序(回放里本来就是有序的,这里只做判别与类型收窄)。 */
export const tickLinesOf = (parsed: readonly ReplayLine[]): readonly ReplayTickLine[] =>
  parsed.filter((line): line is ReplayTickLine => line.type === "tick");

/**
 * 每 tick 的 `stateHash` 列(FR-2 AC1 的读数就是「十列彼此相等」)。
 * 按 tick 升序,且校验行号连续——少一格就不是同一条时间轴了。
 */
export const stateHashesOf = (parsed: readonly ReplayLine[]): readonly string[] =>
  tickLinesOf(parsed).map((line) => line.stateHash);

/** 分布读数。与桩 `tables.mjs` 的 `dist` 同一口径:min / p25 / 中位 / p75 / max / 均值。 */
export type Distribution = {
  readonly n: number;
  readonly min: number | null;
  readonly p25: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly max: number | null;
  readonly mean: number | null;
};

const quantile = (sorted: readonly number[], numerator: number, denominator: number): number => {
  const position = ((sorted.length - 1) * numerator) / denominator;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const lowValue = sorted[low] ?? 0;
  const highValue = sorted[high] ?? 0;
  return low === high ? lowValue : lowValue + (highValue - lowValue) * (position - low);
};

export const distributionOf = (values: readonly number[]): Distribution => {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) {
    return { n: 0, min: null, p25: null, p50: null, p75: null, max: null, mean: null };
  }
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p25: quantile(sorted, 1, 4),
    p50: quantile(sorted, 1, 2),
    p75: quantile(sorted, 3, 4),
    max: sorted.at(-1) ?? null,
    mean: sum / sorted.length,
  };
};

/** 中位数(与上面的 `p50` 同一条算术,单独导出给读数用)。 */
export const medianOf = (values: readonly number[]): number | null => distributionOf(values).p50;
