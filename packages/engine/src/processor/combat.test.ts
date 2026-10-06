/**
 * 战斗裁决(票 08,hld §4.3 步 3 / gdd §6.2):同 tick 同时结算、单一血池、死亡移除、五条判据。
 *
 * 每条用例在注释里写明「改什么会让它红」;三条关键反例(结算顺序化、去掉「攻击者死亡不影响生效」、
 * 允许攻击基地)与一条自选反例(把攻击能力判据从 `damage > 0` 换成 `range > 0`)分别落在下表。
 *
 * **同归于尽**是本票唯一能把同时性钉死的形状:双方各自只剩一个单位、互相攻击致死、双方伤害都生效。
 */

import { expect, it } from "vitest";
import type { Ruleset } from "@model-war/replay";

import { processTick } from "./index.js";
import { loadRuleset } from "../ruleset-loader/index.js";
import { stubRunner } from "../runner/stub.js";
import type { TickSink } from "../replay-writer/index.js";
import type { Intent } from "./intents.js";
import type { GameState, PlayerIndex, Site, Terrain, Unit, UnitType } from "../world/state.js";

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

const plain = (size: number): Terrain =>
  Array.from({ length: size }, () => Array.from({ length: size }, () => false));

const unit = (
  id: number,
  owner: PlayerIndex,
  type: UnitType,
  x: number,
  y: number,
  hp: number,
): Unit => ({ id, owner, type, x, y, hp, carrying: 0 });

const site = (
  id: number,
  kind: Site["kind"],
  x: number,
  y: number,
  owner: Site["owner"],
): Site => ({
  id,
  kind,
  x,
  y,
  owner,
  progressOwner: -1,
  progress: 0,
  producing: null,
});

const makeState = (
  units: readonly Unit[],
  options: {
    readonly tick?: number;
    readonly sites?: readonly Site[];
    /** 默认非 null:战斗用例不该被首触事件干扰。要观察首触请传 `null`。 */
    readonly firstContactTick?: number | null;
  } = {},
): GameState => {
  const size = 8;
  return {
    tick: options.tick ?? 0,
    size,
    terrain: plain(size),
    players: [0, 1, 2, 3].map((index) => ({
      index: index as PlayerIndex,
      resources: 16,
      alive: true,
      exceptionTicks: 0,
    })),
    units,
    sites: [...(options.sites ?? []), ...SEAT_BASES],
    nextId: 100,
    outcome: null,
    // 本用例四席都在,无人被淘汰。
    eliminatedAtTick: [null, null, null, null],
    firstContactTick: options.firstContactTick ?? 0,
    economyDeadAtTick: [null, null, null, null],
  };
};

/**
 * 四个座位各一个哨兵基地(id 900+seat、坐标远离用例单位)。
 *
 * 本文件测的是步 3,而 `processTick` 会跑完整条管线:没有它,「双方各自最后一名单位互杀」这类
 * 用例会在步 5 把四方全部淘汰掉,凭空多出 `player-eliminated` 事件。基地不会被摧毁也不会被踏
 * (坐标远离单位),故它让步 5 在这些用例里恒为 no-op。
 */
const SEAT_BASES: readonly Site[] = [0, 1, 2, 3].map((seat) =>
  site(900 + seat, "base", 900 + seat, 900, seat as Site["owner"]),
);

/** 什么都不记的 sink。 */
const SINK: TickSink = { write: () => {} };

/** 记下每一行的 sink。用来解析写出的 tick 行、断言负 hp 不落盘。 */
const capturingSink = (): { readonly lines: string[]; readonly sink: TickSink } => {
  const lines: string[] = [];
  return { lines, sink: { write: (line) => lines.push(line) } };
};

/** 按座位给四份策略;`undefined` 的座位交回空数组。 */
const runWith = (state: GameState, bySeat: readonly (readonly Intent[])[], sink: TickSink = SINK) =>
  processTick(
    state,
    [0, 1, 2, 3].map((seat) => stubRunner(() => bySeat[seat] ?? [])),
    loadRuleset(RULESET),
    sink,
  );

const run = (state: GameState, bySeat: readonly (readonly Intent[])[]) => runWith(state, bySeat);

const at = (state: GameState, id: number): Unit => {
  const found = state.units.find((item) => item.id === id);
  if (found === undefined) {
    throw new Error(`状态里没有单位 ${String(id)}`);
  }
  return found;
};

const attack = (unitId: number, targetId: number): Intent => ({ kind: "attack", unitId, targetId });

it("同归于尽:双方互相攻击致死,双方伤害都生效(同时性)", () => {
  // 双方各 hp 3、melee damage 3:任一方单独先打都会秒掉对方。
  const a = unit(1, 0, "melee", 0, 0, 3);
  const b = unit(2, 1, "melee", 1, 0, 3);
  const result = run(makeState([a, b]), [[attack(1, 2)], [attack(2, 1)], [], []]);
  // 同时结算 → 两条血条都归零,双方都死,没有幸存者。
  // 「结算顺序化」的反例:逐个算伤害并就地扣血会让先手方(座位 0 的 1 号)幸存 → 这里红。
  expect(result.state.units).toEqual([]);
  expect(result.events).toEqual([
    { kind: "unit-destroyed", subjectId: 1 },
    { kind: "unit-destroyed", subjectId: 2 },
  ]);
});

it("攻击者本 tick 死亡不影响其攻击生效:死亡的那一击照样算", () => {
  // b 先被打死仍要打出自己那一击。判据同上,但用「a 高血、b 低血」把方向钉死:
  // a hp 3、b hp 3 是互为死亡;这里改 a hp 12、b hp 3,则只有 b 会死,但 a 必须掉 3 血。
  const a = unit(1, 0, "melee", 0, 0, 12);
  const b = unit(2, 1, "melee", 1, 0, 3);
  const result = run(makeState([a, b]), [[attack(1, 2)], [attack(2, 1)], [], []]);
  // 「去掉『攻击者死亡不影响生效』分支」的反例:先移除死者再算伤害会让 a 保留 12 血 → 这里红。
  expect(at(result.state, 1).hp).toBe(9);
  expect(result.state.units.map((item) => item.id)).toEqual([1]);
});

it("单一血池:两个攻击者打死同一单位,伤害求和一次扣,事件恰好一条", () => {
  const left = unit(1, 0, "melee", 0, 0, 12);
  const right = unit(2, 0, "melee", 2, 0, 12);
  const target = unit(3, 1, "melee", 1, 0, 4);
  const result = run(makeState([left, right, target]), [[attack(1, 3), attack(2, 3)], [], [], []]);
  // 3 + 3 = 6 > hp 4:若每个攻击者各对**基线**扣一次(4−3、4−3),目标会以 1 血幸存 → 这里红。
  expect(result.state.units.map((item) => item.id)).toEqual([1, 2]);
  // 「聚合」口径:按被消灭的单位聚合,不按「攻击者-目标对」聚合。若按对发事件会是两条 → 这里红。
  expect(result.events).toEqual([{ kind: "unit-destroyed", subjectId: 3 }]);
});

it("基础命中:扣血但不致死", () => {
  const a = unit(1, 0, "melee", 0, 0, 12);
  const b = unit(2, 1, "melee", 1, 0, 12);
  const result = run(makeState([a, b]), [[attack(1, 2)], [], [], []]);
  expect(at(result.state, 2).hp).toBe(9);
  // 有效攻击出现在步 1 的意图清单里(步 1 的放行名单加进了 attack)。
  expect(result.intents.map(({ intent }) => intent.kind)).toEqual(["attack"]);
  expect(result.events).toEqual([]);
});

it("目标须在切比雪夫射程内,射程从规则集读", () => {
  // melee range = 1:距离 2 打不到。
  const melee = unit(1, 0, "melee", 0, 0, 12);
  const enemy = unit(2, 1, "melee", 2, 0, 12);
  const miss = run(makeState([melee, enemy]), [[attack(1, 2)], [], [], []]);
  expect(miss.intents).toEqual([]);
  expect(at(miss.state, 2).hp).toBe(12);

  // ranged range = 2:同样的距离 2 打得到(射程从规则集读,不是常量)。
  const ranged = unit(3, 0, "ranged", 0, 0, 4);
  const enemy2 = unit(4, 1, "melee", 2, 1, 12);
  const hit = run(makeState([ranged, enemy2]), [[attack(3, 4)], [], [], []]);
  expect(at(hit.state, 4).hp).toBe(10);
});

it("攻击者无攻击能力(农民)的意图无效丢弃:判据看 damage 不看 range", () => {
  // 农民 range = 1(非零)而 damage = 0——只判射程会放行,它打出的伤害是 0。
  expect(RULESET.worker.range).toBe(1);
  expect(RULESET.worker.damage).toBe(0);
  const worker = unit(1, 0, "worker", 0, 0, 2);
  const enemy = unit(2, 1, "worker", 1, 0, 2);
  const result = run(makeState([worker, enemy]), [[attack(1, 2)], [], [], []]);
  // 「把 damage > 0 换成 range > 0」的反例:农民会变成有效攻击者(即使伤害 0)→ 这里红。
  expect(result.intents).toEqual([]);
  expect(result.events).toEqual([]);
  expect(at(result.state, 2).hp).toBe(2);
});

it("基地不可被攻击:目标命中点位即丢弃(号段互斥后不靠撞号)", () => {
  // 判据 4 前半的正当用例:拿一个**真实点位号**当 `targetId`——点位不是可攻击目标。
  // 号段互斥(见 world/initial-state.test.ts)之后不存在「点位遮住同号单位」这回事,
  // 所以这里不再靠撞号构造。
  const a = unit(1, 0, "melee", 0, 0, 12);
  const enemy = unit(2, 1, "melee", 1, 0, 12);
  const base = site(9, "base", 9, 9, 1);
  const result = run(makeState([a, enemy], { sites: [base] }), [[attack(1, 9)], [], [], []]);
  // 同一 tick、射程内有一个可打的敌方单位,但目标号指向点位 → 丢弃,且不误伤那个单位。
  expect(result.intents).toEqual([]);
  expect(result.events).toEqual([]);
  expect(at(result.state, 2).hp).toBe(12);
});

it("基地不可被攻击:点位号不被任何单位占用时也丢弃", () => {
  const a = unit(1, 0, "melee", 0, 0, 12);
  const base = site(9, "base", 9, 9, -1);
  const result = run(makeState([a], { sites: [base] }), [[attack(1, 9)], [], [], []]);
  // 「允许攻击基地」的反例试法见 `## Answer` §5:号段互斥后,删掉守卫不再改变结果(点位 id 永不
  // 命中单位),守卫值价在于把这条语义写死;这一条钉「点位一律丢弃」。
  expect(result.intents).toEqual([]);
  expect(result.events).toEqual([]);
});

it("目标不存在 / 攻击己方单位 / 属主不对:三种无效意图都静默丢弃,不计异常", () => {
  const a = unit(1, 0, "melee", 0, 0, 12);
  const ally = unit(2, 0, "melee", 1, 0, 12);
  const enemy = unit(3, 1, "melee", 2, 0, 12);
  const result = run(makeState([a, ally, enemy]), [
    // 目标不存在(id 99);己方单位(id 2);属主不对(座位 1 拿座位 0 的 1 号去打 2 号)。
    [attack(1, 99), attack(1, 2)],
    [attack(1, 3)],
    [],
    [],
  ]);
  expect(result.intents).toEqual([]);
  expect(result.events).toEqual([]);
  expect(at(result.state, 2).hp).toBe(12);
  expect(at(result.state, 3).hp).toBe(12);
  // 丢弃不占异常配额(异常判罚只针对脚本抛异常与超预算)。
  expect(result.state.players.map((player) => player.exceptionTicks)).toEqual([0, 0, 0, 0]);
});

it("归零者同 tick 移除:hp 取 hp−求和伤害(可负),但负值不出现在任何写出的一行里", () => {
  const left = unit(1, 0, "melee", 0, 0, 12);
  const right = unit(2, 0, "melee", 2, 0, 12);
  const target = unit(3, 1, "melee", 1, 0, 2); // 过杀:2 − 6 = −4
  const { lines, sink } = capturingSink();
  const result = runWith(
    makeState([left, right, target]),
    [[attack(1, 3), attack(2, 3)], [], [], []],
    sink,
  );
  // 归零者已移除,不参与后续阶段(采集 / 交付 / 生产看到的 units 里没有它)。
  expect(result.state.units.map((item) => item.id)).toEqual([1, 2]);
  // 写出的那一行里没有负 hp:若忘了在同 tick 移除,−4 会留在行里 → 这里红。
  expect(lines).toHaveLength(1);
  const written = JSON.parse(lines[0]!) as { units: readonly { id: number; hp: number }[] };
  expect(written.units.map((item) => item.id)).toEqual([1, 2]);
  for (const item of written.units) {
    expect(item.hp).toBeGreaterThanOrEqual(0);
  }
});

it("同 tick 多个被消灭单位:事件按对象数值 id 升序(与移除序同源)", () => {
  // attacker 10 打 20,attacker 5 打 7;两个目标各 hp 3、melee damage 3 → 各一击致死。
  const attackerHigh = unit(10, 0, "melee", 0, 0, 12);
  const attackerLow = unit(5, 0, "melee", 2, 0, 12);
  const targetHigh = unit(20, 1, "melee", 1, 0, 3);
  const targetLow = unit(7, 1, "melee", 3, 0, 3);
  const result = run(makeState([attackerLow, attackerHigh, targetLow, targetHigh]), [
    [attack(10, 20), attack(5, 7)],
    [],
    [],
    [],
  ]);
  // 移除按数值 id 升序:7 先于 20。若按意图序 / 插入序移除,这里会反 → 红。
  expect(result.events).toEqual([
    { kind: "unit-destroyed", subjectId: 7 },
    { kind: "unit-destroyed", subjectId: 20 },
  ]);
  expect(result.state.units.map((item) => item.id)).toEqual([5, 10]);
});
