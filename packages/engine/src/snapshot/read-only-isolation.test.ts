/**
 * 只读隔离(hld §4.5,FR-3 AC1):快照是**深拷贝**且**深 freeze**,引擎真状态**永不 freeze**。
 *
 * 每条验收都配了一条**能被弄红的反例**,反例写在各用例的注释里:
 * - 「深 freeze 改成浅 freeze」→ 「深冻到底」与「当场抛 TypeError」一起红;
 * - 「快照直接传真状态」→ 「策略拿到的是拷贝」与「引擎状态不受影响」一起红;
 * - 「`structuredClone` 换成 JSON 往返 / 逐字段手抄」→ 「不共享引用」红(手抄漏一栏时)。
 */

import { expect, it } from "vitest";

import type { Ruleset } from "@model-war/replay";
import { processTick } from "../processor/index.js";
import { loadRuleset } from "../ruleset-loader/index.js";
import { stubRunner } from "../runner/stub.js";
import type { GameState, PlayerIndex, Site, Snapshot, Unit } from "../world/state.js";
import { buildSnapshot } from "./snapshot.js";

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

const unit = (id: number, hp: number, x: number): Unit => ({
  id,
  owner: 0,
  type: "worker",
  x,
  y: 0,
  hp,
  carrying: 0,
});

const site = (id: number, owner: -1 | PlayerIndex): Site => ({
  id,
  kind: "resource",
  x: id,
  y: 0,
  owner,
  progressOwner: -1,
  progress: 0,
  remaining: 200,
  producing: { type: "melee", remainingTicks: 2 },
});

/** 每个用例一份新状态:这些用例里有几条**故意**去写快照,共用一份会让脏写渗到别的用例。 */
const makeState = (): GameState => ({
  tick: 0,
  size: 8,
  terrain: Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => false)),
  players: [0, 1, 2, 3].map((index) => ({
    index: index as PlayerIndex,
    resources: 16,
    alive: true,
    exceptionTicks: 0,
  })),
  units: [unit(1, 2, 0), unit(2, 12, 1)],
  sites: [site(3, 0), site(4, -1)],
  nextId: 5,
  outcome: null,
  // 本用例四席都在,无人被淘汰。
  eliminatedAtTick: [null, null, null, null],
  firstContactTick: null,
  economyDeadAtTick: [null, null, null, null],
});

it("深 freeze 冻到底:嵌套的单位、点位、点位上的产线订单都不可写", () => {
  const snapshot = buildSnapshot(makeState());
  // 浅 freeze 的反例:顶层冻住、嵌套仍是普通对象,于是后两条当场红。
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.units)).toBe(true);
  expect(Object.isFrozen(snapshot.units[0])).toBe(true);
  expect(Object.isFrozen(snapshot.sites[0]?.producing)).toBe(true);
});

it("深 freeze 之后写入当场抛 TypeError(ESM 模块恒为严格模式)", () => {
  const snapshot = buildSnapshot(makeState());
  const first = snapshot.units[0] as { hp: number };
  expect(() => {
    first.hp = 99;
  }).toThrow(TypeError);
  // 顶层的 players 数组也冻:四席串行执行,座位 0 改嵌套、座位 1 读到脏的,
  // 在整场对局里表现为「某一方的策略莫名其妙更聪明」,几乎不可查。
  expect(() => {
    (snapshot.players as unknown as unknown[]).push({});
  }).toThrow(TypeError);
});

it("引擎真状态永不 freeze:它要被 apply() 写,冻住它等于冻住唯一的写入口", () => {
  const state = makeState();
  buildSnapshot(state);
  expect(Object.isFrozen(state)).toBe(false);
  expect(Object.isFrozen(state.units)).toBe(false);
  expect(Object.isFrozen(state.units[0])).toBe(false);
});

it("structuredClone 不共享引用:改拷贝里的嵌套字段不影响原状态", () => {
  const state = makeState();
  const snapshot = buildSnapshot(state);
  // 「传真状态」的反例:三行引用相等全红,而且它正是 FR-3 AC1 失效的那条路。
  expect(snapshot.units).not.toBe(state.units);
  expect(snapshot.units[0]).not.toBe(state.units[0]);
  expect(snapshot.sites[0]).not.toBe(state.sites[0]);
});

it("一个策略在 loop() 里试着改快照:引擎状态在下一 tick 不受影响(FR-3 AC1)", () => {
  const state = makeState();
  const seen: Snapshot[] = [];
  const vandal = stubRunner((snapshot) => {
    seen.push(snapshot);
    // 写不写得进去都不该影响引擎:冻住了就抛,没冻住就落在拷贝上。断言在调用点之后。
    try {
      (snapshot.units[0] as { hp: number }).hp = 99;
      (snapshot.sites[0] as { owner: PlayerIndex }).owner = 3;
    } catch {
      // 深 freeze 挡住了。这是预期的结果,不是被吞掉的故障。
    }
    return [];
  });
  const idle = stubRunner(() => []);
  const result = processTick(state, [vandal, idle, idle, idle], loadRuleset(RULESET), {
    write: () => {},
  });

  // 「快照传真状态」的反例:这三条全红,而且第三红说明 FR-3 AC1 已经不可证伪了。
  expect(result.state.units[0]?.hp).toBe(2);
  expect(result.state.sites[0]?.owner).toBe(0);
  expect(seen[0]?.units[0]).not.toBe(state.units[0]);
});
