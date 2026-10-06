/**
 * 移动裁决(票 04,hld §4.4 / rules.md §3):轮转优先、占位基准、交换/穿行/链式、骑兵二次移动、
 * 寻路调用量记账、first-contact。
 *
 * 每条用例在注释里写明「改什么会让它红」;三条关键反例(轮转优先改成常量、基准改成结算后的占位、
 * 启发式倍率放大)分别落在下表与 `pathfinding/find-path.test.ts`。
 */

import { expect, it } from "vitest";
import type { Ruleset } from "@model-war/replay";

import { processTick } from "./index.js";
import { loadRuleset } from "../ruleset-loader/index.js";
import { stubRunner } from "../runner/stub.js";
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

const unit = (id: number, owner: PlayerIndex, type: UnitType, x: number, y: number): Unit => ({
  id,
  owner,
  type,
  x,
  y,
  hp: 4,
  carrying: 0,
});

/**
 * 四个座位各一个哨兵基地(id 900+seat、坐标远离用例单位)。
 *
 * 本文件测的是步 2,而 `processTick` 会跑完整条管线:没有它,那些「只有座位 0 有单位」的
 * 用例会在步 5 把其余三席当作无兵无基地而淘汰掉,凭空多出 `player-eliminated` 事件与状态变化。
 * 一个不会被摧毁、也不会被踏上的基地让步 5 在这些用例里恒为 no-op。
 */
const SEAT_BASES: readonly Site[] = [0, 1, 2, 3].map((seat) => ({
  id: 900 + seat,
  kind: "base",
  x: 900 + seat,
  y: 900,
  owner: seat as PlayerIndex,
  progressOwner: -1,
  progress: 0,
  producing: null,
}));

const makeState = (
  units: readonly Unit[],
  options: {
    readonly tick?: number;
    readonly size?: number;
    readonly terrain?: Terrain;
    readonly firstContactTick?: number | null;
  } = {},
): GameState => {
  const size = options.size ?? 8;
  return {
    tick: options.tick ?? 0,
    size,
    terrain: options.terrain ?? plain(size),
    players: [0, 1, 2, 3].map((index) => ({
      index: index as PlayerIndex,
      resources: 16,
      alive: true,
      exceptionTicks: 0,
    })),
    units,
    sites: SEAT_BASES,
    nextId: 100,
    outcome: null,
    // 本用例四席都在,无人被淘汰。
    eliminatedAtTick: [null, null, null, null],
    firstContactTick: options.firstContactTick ?? null,
  };
};

const SINK = { write: () => {} };

/** 按座位给四份策略;`undefined` 的座位交回空数组(stub 策略就是普通函数,不经 VM)。 */
const run = (state: GameState, bySeat: readonly (readonly Intent[])[]) =>
  processTick(
    state,
    [0, 1, 2, 3].map((seat) => stubRunner(() => bySeat[seat] ?? [])),
    loadRuleset(RULESET),
    SINK,
  );

const at = (state: GameState, id: number): Unit => {
  const found = state.units.find((item) => item.id === id);
  if (found === undefined) {
    throw new Error(`状态里没有单位 ${String(id)}`);
  }
  return found;
};

it("同格竞争:轮转优先值大者胜,换一个 tick 胜者轮转", () => {
  const a = unit(1, 0, "worker", 0, 0);
  const b = unit(2, 3, "worker", 2, 0);
  const intents: readonly (readonly Intent[])[] = [
    [{ kind: "move", unitId: 1, dx: 1, dy: 0 }],
    [],
    [],
    [{ kind: "move", unitId: 2, dx: -1, dy: 0 }],
  ];
  // tick 0:优先值 seat0=0、seat3=3 → seat3 胜。
  const at0 = run(makeState([a, b], { tick: 0 }), intents);
  expect(at(at0.state, 1).x).toBe(0);
  expect(at(at0.state, 2).x).toBe(1);
  // tick 3:seat0=(3+0)%4=3、seat3=(3+3)%4=2 → seat0 胜。
  // 「轮转优先改成常量」的反例:这一条会红(两 tick 胜者相同)。
  const at3 = run(makeState([a, b], { tick: 3 }), intents);
  expect(at(at3.state, 1).x).toBe(1);
  expect(at(at3.state, 2).x).toBe(2);
});

it("交换(A→B 同时 B→A):两格都被基准占住,两者都失败", () => {
  const a = unit(1, 0, "worker", 0, 0);
  const b = unit(2, 1, "worker", 1, 0);
  // 「基准改成结算后的占位」的反例:若以结算后的占位判,A、B 会互换成功,两条断言都红。
  const result = run(makeState([a, b]), [
    [{ kind: "move", unitId: 1, dx: 1, dy: 0 }],
    [{ kind: "move", unitId: 2, dx: -1, dy: 0 }],
    [],
    [],
  ]);
  expect(at(result.state, 1).x).toBe(0);
  expect(at(result.state, 2).x).toBe(1);
});

it("链式(A→B 同时 B→C):A 因 B 占住而失败,B 只看 C,互不牵连", () => {
  const a = unit(1, 0, "worker", 0, 0);
  const b = unit(2, 1, "worker", 1, 0);
  const result = run(makeState([a, b]), [
    [{ kind: "move", unitId: 1, dx: 1, dy: 0 }],
    [{ kind: "move", unitId: 2, dx: 1, dy: 0 }],
    [],
    [],
  ]);
  // A 的目标 (1,0) 在基准里被 B 占 → A 原地;B 的目标 (2,0) 空 → B 前进。
  expect(at(result.state, 1).x).toBe(0);
  expect(at(result.state, 2).x).toBe(2);
});

it("链式移不动:C 也被占时 B 同样失败——两条移动互不牵连,没有链式裁决", () => {
  const a = unit(1, 0, "worker", 0, 0);
  const b = unit(2, 1, "worker", 1, 0);
  const c = unit(3, 2, "worker", 2, 0);
  const result = run(makeState([a, b, c]), [
    [{ kind: "move", unitId: 1, dx: 1, dy: 0 }],
    [{ kind: "move", unitId: 2, dx: 1, dy: 0 }],
    [],
    [],
  ]);
  expect(at(result.state, 1).x).toBe(0);
  expect(at(result.state, 2).x).toBe(1);
  expect(at(result.state, 3).x).toBe(2);
});

it("己方单位同样互相挡路(无友军穿越)", () => {
  const mover = unit(1, 0, "worker", 0, 0);
  const ally = unit(2, 0, "worker", 1, 0);
  const result = run(makeState([mover, ally]), [
    [{ kind: "move", unitId: 1, dx: 1, dy: 0 }],
    [],
    [],
    [],
  ]);
  expect(at(result.state, 1).x).toBe(0);
});

it("骑兵一 tick 走两格,其余兵种一 tick 一格", () => {
  const cavalry = unit(1, 0, "cavalry", 0, 0);
  const worker = unit(2, 1, "worker", 5, 0);
  const result = run(makeState([cavalry, worker]), [
    [{ kind: "moveTo", unitId: 1, x: 0, y: 3 }],
    [{ kind: "moveTo", unitId: 2, x: 5, y: 3 }],
    [],
    [],
  ]);
  // speed = 2 → 两轮各一步;worker speed = 1 → 只走一步。
  expect(at(result.state, 1).y).toBe(2);
  expect(at(result.state, 2).y).toBe(1);
});

it("moveTo 每 tick 只走一步,且每 tick 重算路径(不跨 tick 缓存)", () => {
  const worker = unit(2, 1, "worker", 5, 0);
  let state = makeState([worker]);
  for (const expected of [1, 2, 3]) {
    state = run(state, [[], [{ kind: "moveTo", unitId: 2, x: 5, y: 3 }], [], []]).state;
    expect(at(state, 2).y).toBe(expected);
  }
});

it("寻路调用量按座位记账:moveTo +1,move +0", () => {
  const a = unit(1, 0, "worker", 0, 0);
  const b = unit(2, 1, "worker", 5, 5);
  const result = run(makeState([a, b]), [
    [{ kind: "moveTo", unitId: 1, x: 0, y: 3 }],
    [{ kind: "move", unitId: 2, dx: 0, dy: -1 }],
    [],
    [],
  ]);
  // 反向钉:顺手把 move 也记一笔会让座位 1 变成 1。
  expect(result.pathfindingCalls).toEqual([1, 0, 0, 0]);
});

it("骑兵的 moveTo 两轮都算,一个 tick 记两次", () => {
  const cavalry = unit(1, 0, "cavalry", 0, 0);
  const result = run(makeState([cavalry]), [
    [{ kind: "moveTo", unitId: 1, x: 0, y: 3 }],
    [],
    [],
    [],
  ]);
  expect(result.pathfindingCalls).toEqual([2, 0, 0, 0]);
});

it("moveTo 不可达:不移动,但 A* 那次调用照记", () => {
  // (2,2) 被墙围死(见 pathfinding 的不可达用例)。
  const terrain: Terrain = [
    [false, false, false, false, false],
    [false, true, true, true, false],
    [false, true, false, true, false],
    [false, true, true, true, false],
    [false, false, false, false, false],
  ];
  const worker = unit(1, 0, "worker", 0, 0);
  const result = run(makeState([worker], { size: 5, terrain }), [
    [{ kind: "moveTo", unitId: 1, x: 2, y: 2 }],
    [],
    [],
    [],
  ]);
  expect(at(result.state, 1).x).toBe(0);
  expect(at(result.state, 1).y).toBe(0);
  expect(result.pathfindingCalls).toEqual([1, 0, 0, 0]);
});

it("first-contact:整局一条,记忆进状态,第二 tick 不再发", () => {
  const a = unit(1, 0, "worker", 0, 0);
  const b = unit(2, 1, "worker", 2, 2); // Chebyshev 2 → 触发
  const first = run(makeState([a, b]), [[], [], [], []]);
  expect(first.events).toEqual([{ kind: "first-contact", subjectId: 1 }]);
  expect(first.state.firstContactTick).toBe(0);
  const second = run(first.state, [[], [], [], []]);
  // 「全局一条」的反例:每 tick 或每对玩家各发一条会让这里红。
  expect(second.events).toEqual([]);
  expect(second.state.firstContactTick).toBe(0);
});

it("first-contact 判在移动结算之后:移到位才记", () => {
  const a = unit(1, 0, "worker", 0, 0);
  const b = unit(2, 1, "worker", 0, 3); // 距离 3,静止时不够近
  const result = run(makeState([a, b]), [
    [{ kind: "moveTo", unitId: 1, x: 0, y: 1 }], // 移动后 a=(0,1),与 b 距离 2
    [],
    [],
    [],
  ]);
  expect(result.events).toEqual([{ kind: "first-contact", subjectId: 1 }]);
});

it("first-contact 主体按对象数值 id 升序取第一个够近的单位", () => {
  // id 1 与任何敌对单位都 > 2;id 4 与 id 5 相邻(id 4 更小,故主体是 4)。
  const far = unit(1, 0, "worker", 0, 0);
  const enemy = unit(4, 1, "worker", 0, 4);
  const ally = unit(5, 0, "worker", 0, 5);
  const result = run(makeState([far, enemy, ally]), [[], [], [], []]);
  expect(result.events).toEqual([{ kind: "first-contact", subjectId: 4 }]);
});

it("未实现的四条意图静默丢弃:不发事件、不计异常、不改状态", () => {
  const a = unit(1, 0, "worker", 0, 0);
  const b = unit(2, 1, "worker", 3, 0);
  const result = run(makeState([a, b]), [
    [{ kind: "attack", unitId: 1, targetId: 2 }],
    [{ kind: "spawnUnit", baseId: 1, unitType: "melee" }],
    [],
    [{ kind: "transfer", unitId: 2 }],
  ]);
  expect(result.events).toEqual([]);
  expect(at(result.state, 1).x).toBe(0);
  expect(at(result.state, 2).x).toBe(3);
  // 异常判罚只针对脚本抛异常与超预算,丢弃不占配额。
  expect(result.state.players.map((player) => player.exceptionTicks)).toEqual([0, 0, 0, 0]);
});

it("参数不在界 / 属主不对的移动意图同样静默丢弃", () => {
  const a = unit(1, 0, "worker", 0, 0);
  const b = unit(2, 1, "worker", 3, 0);
  const result = run(makeState([a, b], { size: 4 }), [
    [{ kind: "move", unitId: 1, dx: -1, dy: 0 }], // 越界 (0,0)→(-1,0)
    [{ kind: "move", unitId: 1, dx: 1, dy: 0 }], // 属主不对:seat1 挪 seat0 的单位
    [],
    [],
  ]);
  expect(result.events).toEqual([]);
  expect(at(result.state, 1).x).toBe(0);
});

it("目标格是墙的移动意图丢弃", () => {
  const terrain: Terrain = [
    [false, true, false, false],
    [false, false, false, false],
    [false, false, false, false],
    [false, false, false, false],
  ];
  const a = unit(1, 0, "worker", 0, 0);
  const result = run(makeState([a], { size: 4, terrain }), [
    [{ kind: "move", unitId: 1, dx: 1, dy: 0 }],
    [],
    [],
    [],
  ]);
  expect(at(result.state, 1).x).toBe(0);
  expect(result.pathfindingCalls).toEqual([0, 0, 0, 0]);
});
