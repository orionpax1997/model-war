/**
 * 终局:领土分与名次的算法(`outcome.ts`)与四段判据的接线(步 5 / 步 7 / 步 0),票 09。
 *
 * ── 这份文件钉住三件事 ──
 *
 * 1. **名次四条**(gdd《胜利与淘汰》):胜者第 1;存活层排在已淘汰层之前;层内存活者按领土分降序、
 *    已淘汰者按淘汰时间倒序;仍相同则并列同名次(名次数字按并列人数跳过)。
 * 2. **四段判据与顺序**:淘汰(缺一不算)→ 回归中立 → 全点位 → 捷径兜底(含第四态 all-eliminated)。
 * 3. **两处接线**:淘汰方不再被调用(状态保留)、步 7 写 timeout。
 *
 * 每条用例的注释写明「改什么会让它红」——尤其那几处反例与 `.scratch/engine-core/issues/09-…` 的
 * 反例表一一对应。
 */

import { expect, it } from "vitest";
import type { Ruleset } from "@model-war/replay";

import { processTick } from "./index.js";
import { outcomeOf, territoryScoreOf, winnerSeatOf } from "./outcome.js";
import { loadRuleset } from "../ruleset-loader/index.js";
import { stubRunner } from "../runner/stub.js";
import type { TickSink } from "../replay-writer/index.js";
import type { Intent } from "./intents.js";
import { buildSnapshot } from "../snapshot/snapshot.js";
import type {
  GameState,
  Player,
  PlayerIndex,
  Site,
  Terrain,
  Unit,
  UnitType,
} from "../world/state.js";

const RULESET: Ruleset = {
  tickLimit: 600,
  captureTicks: 10,
  initialResources: 16,
  harvestRate: 1,
  carryLimit: 20,
  resourcePerSite: 200,
  worker: { cost: 4, hp: 2, damage: 0, range: 1, speed: 1, spawnTicks: 2 },
  melee: { cost: 8, hp: 12, damage: 3, range: 1, speed: 1, spawnTicks: 4 },
  ranged: { cost: 12, hp: 4, damage: 2, range: 2, speed: 1, spawnTicks: 6 },
  cavalry: { cost: 16, hp: 6, damage: 2, range: 1, speed: 2, spawnTicks: 8 },
  baseScore: 4,
  resourceScore: 1,
  unitCostDivisor: 6,
  exceptionTickLimit: 0,
  eventTickLimit: 0,
  apiCallTickLimit: 0,
  memoryLimit: 0,
  memoryTickCeiling: 0,
  wallClockSoftLimit: 0,
  wallClockHardTimeout: 0,
  scriptSizeLimit: 0,
};

const RULESET_VIEW = loadRuleset(RULESET);
const NO_ELIMINATIONS: readonly (number | null)[] = [null, null, null, null];

const plain = (size: number): Terrain =>
  Array.from({ length: size }, () => Array.from({ length: size }, () => false));

const playerOf = (index: PlayerIndex, alive = true): Player => ({
  index,
  resources: 16,
  alive,
  exceptionTicks: 0,
});

const unit = (
  id: number,
  owner: PlayerIndex,
  type: UnitType,
  x: number,
  y: number,
  hp: number,
): Unit => ({ id, owner, type, x, y, hp, carrying: 0 });

/** 点位统一落在 y = 7:用例里的单位都在 y ≤ 3,于是不会顺手触发占领(步 4)。 */
const site = (id: number, kind: Site["kind"], owner: Site["owner"]): Site => ({
  id,
  kind,
  x: id,
  y: 7,
  owner,
  progressOwner: -1,
  progress: 0,
  producing: null,
});

const makeState = (parts: {
  readonly units?: readonly Unit[];
  readonly sites?: readonly Site[];
  readonly players?: readonly Player[];
  readonly tick?: number;
  readonly eliminatedAtTick?: readonly (number | null)[];
}): GameState => ({
  tick: parts.tick ?? 0,
  size: 8,
  terrain: plain(8),
  players: parts.players ?? [0, 1, 2, 3].map((index) => playerOf(index as PlayerIndex)),
  units: parts.units ?? [],
  sites: parts.sites ?? [],
  nextId: 100,
  outcome: null,
  eliminatedAtTick: parts.eliminatedAtTick ?? NO_ELIMINATIONS,
  // 非 null:本文件的用例不观察首触,别让它混进事件流(战斗用例同款处理)。
  firstContactTick: 0,
});

const idleRunner = () => stubRunner(() => []);
const SINK: TickSink = { write: () => {} };

const capturingSink = (): { readonly lines: string[]; readonly sink: TickSink } => {
  const lines: string[] = [];
  return { lines, sink: { write: (line: string) => lines.push(line) } };
};

/** 四份空策略跑一个 tick。 */
const run = (state: GameState) =>
  processTick(state, [idleRunner(), idleRunner(), idleRunner(), idleRunner()], RULESET_VIEW, SINK);

// ── 领土分(gdd《胜利与淘汰》的那条公式)────────────────────────────────────────

it("领土分 = baseScore×基地数 + resourceScore×资源点数 + ⌊Σ存活单位造价 / unitCostDivisor⌋", () => {
  const state = makeState({
    units: [
      unit(1, 0, "worker", 0, 0, 2),
      unit(2, 0, "melee", 1, 0, 12),
      unit(3, 0, "melee", 2, 0, 12),
    ],
    sites: [
      site(10, "base", 0),
      site(11, "base", 0),
      site(12, "resource", 0),
      site(13, "resource", 0),
      site(14, "resource", 0),
    ],
  });
  // 2×4 + 3×1 + ⌊(4+8+8)/6⌋ = 8 + 3 + 3 = 14。权重与除数全从 ruleset.raw 读,代码里不出现 4/1/6。
  expect(territoryScoreOf(state, RULESET_VIEW, 0)).toBe(14);
  // 反例:把 unitCostDivisor 当整数除法以外的东西(或写成 Math.round)会让这三项对不上。
  expect(territoryScoreOf(state, RULESET_VIEW, 1)).toBe(0);
});

it("已淘汰玩家的领土分恒为 0——它是公式的推论,不是一条特例分支", () => {
  // 出局者名下无单位、无基地、也无残余点位(已回归中立),三项全 0。
  const state = makeState({
    players: [playerOf(0, false), playerOf(1), playerOf(2), playerOf(3)],
    eliminatedAtTick: [7, null, null, null],
  });
  expect(territoryScoreOf(state, RULESET_VIEW, 0)).toBe(0);
});

it("中立点位的资源不计入任何人", () => {
  const state = makeState({ sites: [site(10, "resource", -1)] });
  expect(territoryScoreOf(state, RULESET_VIEW, 0)).toBe(0);
});

// ── 名次四条 ──────────────────────────────────────────────────────────────────

it("名次:胜者第 1,其余存活者按领土分降序,存活层整体排在已淘汰层之前", () => {
  const state = makeState({
    players: [playerOf(0), playerOf(1), playerOf(2), playerOf(3)],
    units: [unit(1, 1, "ranged", 1, 0, 4)],
    sites: [site(10, "base", 2), site(11, "resource", 3)],
  });
  // 无胜者(timeout):存活层按领土分 0?—— 这里让各席位领土分不同:座位 2 一基地(4)、座位 3 一资源(1)。
  const outcome = outcomeOf(state, RULESET_VIEW, "timeout", null);
  expect(outcome.territoryScores).toEqual([0, 2, 4, 1]);
  // 排序:座位 2(4) → 座位 1(2) → 座位 3(1) → 座位 0(0)。
  expect(outcome.rankings).toEqual([4, 2, 1, 3]);
});

it("名次:已淘汰者按淘汰时间倒序;同 tick 淘汰者并列同名次,名次数字跳过被占的位", () => {
  const state = makeState({
    players: [playerOf(0, false), playerOf(1, false), playerOf(2, false), playerOf(3, false)],
    // 座位 0 出局于 5、座位 1 与 3 同出局于 2、座位 2 出局于 9。
    eliminatedAtTick: [5, 2, 9, 2],
  });
  const outcome = outcomeOf(state, RULESET_VIEW, "all-eliminated", null);
  // 降序:座位 2(9)=1;座位 0(5)=2;座位 1 与 3(2)并列第 3(占用两个位,下一位是第 5,这里没有下一个)。
  expect(outcome.rankings).toEqual([2, 3, 1, 3]);
  expect(outcome.territoryScores).toEqual([0, 0, 0, 0]);
});

it("winnerSeatOf:有胜者的原因读出第 1 名那一席;timeout / all-eliminated 无胜者", () => {
  const state = makeState({ sites: [site(10, "base", 2)] });
  expect(winnerSeatOf(outcomeOf(state, RULESET_VIEW, "victory", 2))).toBe(2);
  expect(winnerSeatOf(outcomeOf(state, RULESET_VIEW, "shortcut", 1))).toBe(1);
  // 无胜者:第 1 名是「层内最前」的那一方,但不是被特判的赢家。
  expect(winnerSeatOf(outcomeOf(state, RULESET_VIEW, "timeout", null))).toBeNull();
  expect(winnerSeatOf(outcomeOf(state, RULESET_VIEW, "all-eliminated", null))).toBeNull();
});

// ── 步 5 · 四段判据 ────────────────────────────────────────────────────────────

it("c) 全点位归属:单一玩家控制地图上全部点位(含中立点)→ 瞬间 victory", () => {
  const units = [
    unit(1, 0, "worker", 0, 0, 2),
    // 另三席各留一个单位,才不会被淘汰步顺手清掉——本用例只观察「全点位」那一段。
    unit(2, 1, "worker", 7, 0, 2),
    unit(3, 2, "worker", 0, 7, 2),
    unit(4, 3, "worker", 7, 7, 2),
  ];
  const state = makeState({ units, sites: [site(10, "base", 0), site(11, "resource", 0)] });
  const result = run(state);
  expect(result.state.outcome?.reason).toBe("victory");
  expect(result.state.outcome?.rankings).toEqual([1, 2, 2, 2]);
  expect(result.events).toContainEqual({ kind: "victory", subjectId: 0 });
  // 反例:把「含中立点与敌方主基地」放宽成「所有**非中立**点位」会让一个留着中立点的局面提前胜出。
  // 点位数从点位表读,不硬编码:给同一个局面多添一个中立点,「全点位」就不再成立。
  const withNeutral = makeState({
    units,
    sites: [site(10, "base", 0), site(11, "resource", 0), site(12, "resource", -1)],
  });
  expect(run(withNeutral).state.outcome).toBeNull();
});

it("d) 捷径条款:其余三方全被淘汰时,仅剩方立即 shortcut", () => {
  const state = makeState({
    units: [unit(1, 0, "worker", 0, 0, 2)],
    // 一个中立基地让「全点位」不成立,于是只剩捷径条款能收口——正是这条兜底存在的理由。
    sites: [site(10, "base", 0), site(11, "base", -1)],
  });
  const result = run(state);
  expect(result.state.outcome?.reason).toBe("shortcut");
  expect(result.state.outcome?.rankings).toEqual([1, 2, 2, 2]);
  expect(result.state.eliminatedAtTick).toEqual([null, 0, 0, 0]);
});

it("a) 淘汰条件是「与」:有兵无基地 → 不淘汰;有基地无兵 → 不淘汰;两者皆无 → 淘汰", () => {
  // 座位 1 有兵无基地;座位 2 有基地无兵;座位 3 两者皆无(且持一个资源点)。
  const state = makeState({
    units: [
      unit(1, 0, "worker", 0, 0, 2),
      unit(2, 1, "worker", 7, 0, 2),
      unit(3, 0, "worker", 0, 7, 2),
    ],
    sites: [site(10, "base", 0), site(11, "base", 2), site(12, "resource", 3)],
  });
  const result = run(state);
  // 反例:把条件改成「无单位**或**无基地」,座位 1 与座位 2 会当场出局 → 这里红。
  expect(result.state.players.map((player) => player.alive)).toEqual([true, true, true, false]);
  expect(result.state.eliminatedAtTick).toEqual([null, null, null, 0]);
  // 被淘汰者名下残余点位回归中立。
  expect(result.state.sites.find((item) => item.id === 12)?.owner).toBe(-1);
  expect(result.events).toContainEqual({ kind: "player-eliminated", subjectId: 3 });
  // 三方尚存 → 没有终局。
  expect(result.state.outcome).toBeNull();
});

it("b) 回归中立会破坏「全点位」,由捷径条款接住——顺序反了会让已出局者先「胜」", () => {
  // 构造:不存在任何基地点位,座位 1 持有**全部**点位却无单位、无基地,故在 a) 段出局。
  // 正确的顺序里,b) 段先把它的点位清回中立,c) 段才判——没有人持全点位;d) 段把胜给唯一幸存的座位 0。
  const state = makeState({
    units: [unit(1, 0, "worker", 0, 0, 2)],
    sites: [site(10, "resource", 1), site(11, "resource", 1), site(12, "resource", 1)],
  });
  const result = run(state);
  // 反例(票面那条):把 b) 与 c) 调换,座位 1(已出局)会被判成「控制全部点位」的胜者 → reason 变 victory、
  // 名次首名变座位 1,下面两条一起红。
  expect(result.state.outcome?.reason).toBe("shortcut");
  expect(result.state.outcome?.rankings[0]).toBe(1);
  expect(result.state.players[1]?.alive).toBe(false);
});

it("all-eliminated 可达:双方最后一名单位同 tick 互杀 → 四方全淘汰、无胜者、并列同名次", () => {
  const state = makeState({
    units: [unit(1, 0, "melee", 0, 0, 3), unit(2, 1, "melee", 1, 0, 3)],
    // 唯一一个点位是中立基地:不是任何人的基地(故四方都能满足淘汰条件),也破坏「全点位」。
    sites: [site(10, "base", -1)],
  });
  const attack = (unitId: number, targetId: number): Intent => ({
    kind: "attack",
    unitId,
    targetId,
  });
  const result = processTick(
    state,
    [
      stubRunner(() => [attack(1, 2)]),
      stubRunner(() => [attack(2, 1)]),
      idleRunner(),
      idleRunner(),
    ],
    RULESET_VIEW,
    SINK,
  );
  // 同 tick 同归于尽 → 四方全淘汰,主胜利与捷径都不成立。
  expect(result.state.units).toEqual([]);
  expect(result.state.eliminatedAtTick).toEqual([0, 0, 0, 0]);
  expect(result.state.outcome?.reason).toBe("all-eliminated");
  // 无存活层 → 按淘汰时间倒序;四者同 tick → 全部并列第 1。
  expect(result.state.outcome?.rankings).toEqual([1, 1, 1, 1]);
  expect(result.state.outcome?.territoryScores).toEqual([0, 0, 0, 0]);
  expect(result.events.filter((event) => event.kind === "player-eliminated")).toEqual([
    { kind: "player-eliminated", subjectId: 0 },
    { kind: "player-eliminated", subjectId: 1 },
    { kind: "player-eliminated", subjectId: 2 },
    { kind: "player-eliminated", subjectId: 3 },
  ]);
});

// ── 步 0 · 淘汰方不再被调用,状态保留 ──────────────────────────────────────────

it("淘汰方的 loop() 不再被调用,但它的单位与资源仍写进回放行", () => {
  let calls = 0;
  const spy = (): readonly Intent[] => {
    calls += 1;
    return [];
  };
  const dead = makeState({
    players: [playerOf(0), playerOf(1, false), playerOf(2), playerOf(3)],
    eliminatedAtTick: [null, 0, null, null],
    units: [unit(1, 1, "worker", 3, 3, 2)],
    // 其余三席各持一基地:本用例只观察步 0 的跳过,不让淘汰步与捷径条款插手。
    sites: [site(10, "base", 0), site(11, "base", 2), site(12, "base", 3)],
  });
  const { lines, sink } = capturingSink();
  const result = processTick(
    dead,
    [idleRunner(), stubRunner(spy), idleRunner(), idleRunner()],
    RULESET_VIEW,
    sink,
  );
  // 座位 1 已出局 → 本 tick 不再调用它的策略。
  expect(calls).toBe(0);
  // 对照:把同一个座位放回存活态,策略会被调用一次——证明上面那条不是因为策略压根没接上。
  const alive = {
    ...dead,
    players: dead.players.map((p) => (p.index === 1 ? { ...p, alive: true } : p)),
  };
  processTick(
    alive,
    [idleRunner(), stubRunner(spy), idleRunner(), idleRunner()],
    RULESET_VIEW,
    SINK,
  );
  expect(calls).toBe(1);
  // 状态保留:写出的那一行里仍有座位 1 的单位与资源。
  const written = JSON.parse(lines[0] ?? "{}") as {
    readonly players: readonly { readonly index: number; readonly resources: number }[];
    readonly units: readonly { readonly id: number }[];
  };
  expect(written.players[1]?.resources).toBe(16);
  expect(written.units.map((item) => item.id)).toContain(1);
  expect(result.state.units.map((item) => item.id)).toEqual([1]);
});

it("eliminatedAtTick 不进 Snapshot(脚本类型面的逐字形状不被它撑大)", () => {
  const snapshot = buildSnapshot(makeState({}));
  expect(Object.keys(snapshot)).toEqual(["tick", "size", "terrain", "players", "units", "sites"]);
  expect("eliminatedAtTick" in snapshot).toBe(false);
});

// ── 步 7 · 超时 ───────────────────────────────────────────────────────────────

it("步 7:tick 达 tickLimit 写 timeout outcome;步 5 已判出胜负时不覆盖成 timeout", () => {
  const atLimit = run(
    makeState({
      tick: RULESET.tickLimit - 1,
      // 四席各持一个基地:无淘汰、无全点位胜,才能真的走到步 7 的超时那一段。
      sites: [site(10, "base", 0), site(11, "base", 1), site(12, "base", 2), site(13, "base", 3)],
    }),
  );
  // 步 6 加一后 tick 到顶,步 7 写第四种原因。
  expect(atLimit.state.tick).toBe(RULESET.tickLimit);
  expect(atLimit.state.outcome?.reason).toBe("timeout");
  expect(atLimit.state.outcome?.rankings).toEqual([1, 1, 1, 1]);

  // 恰在最后一 tick 分出胜负时,步 5 的结论不被超时覆盖。
  const winning = run(
    makeState({
      tick: RULESET.tickLimit - 1,
      units: [
        unit(1, 0, "worker", 0, 0, 2),
        unit(2, 1, "worker", 7, 0, 2),
        unit(3, 2, "worker", 0, 7, 2),
        unit(4, 3, "worker", 7, 7, 2),
      ],
      sites: [site(10, "base", 0)],
    }),
  );
  expect(winning.state.outcome?.reason).toBe("victory");
});
