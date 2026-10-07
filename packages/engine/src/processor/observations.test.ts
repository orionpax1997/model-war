/**
 * 观测 → 变更这条路径(票 02 的预置件):执行器的返回载荷带观测,步 0 在它上面**不做裁决**——
 * 种类为 `tripped` 的观测落成一条 `count-exception-tick` 变更(累加 `exceptionTicks`),
 * 另外两类(`wall-clock-soft` / `memory-pressure`)转发给观测出口(缺席即静默丢弃)。
 *
 * 本文件用一个**假执行器**(只实现缝的 `setSnapshot` / `drainIntents` 两条方法)证明这条路径通了。
 * 阈值判定与淘汰不在本票;桩路径的零回归(桩不产出观测 → `exceptionTicks` 恒 0)由
 * `movement.test.ts` / `combat.test.ts` 两条既有断言钉住,这里再补一条。
 */

import { expect, it } from "vitest";
import type { Ruleset } from "@model-war/replay";

import { processTick } from "./index.js";
import { loadRuleset } from "../ruleset-loader/index.js";
import { stubRunner } from "../runner/stub.js";
import { buildTickLine, serializeTickLine } from "../replay-writer/tick-line.js";
import type { ObservationRecord, RunnerOutput, SeatRunner } from "../runner/index.js";
import type { GameState, PlayerIndex, Site, Terrain } from "../world/state.js";

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

/** 四席各一个哨兵基地:没有它,空状态会在步 5 把所有席位淘汰掉,凭空多出状态变化。 */
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

const plain = (size: number): Terrain =>
  Array.from({ length: size }, () => Array.from({ length: size }, () => false));

const makeState = (): GameState => ({
  tick: 0,
  size: 8,
  terrain: plain(8),
  players: [0, 1, 2, 3].map((index) => ({
    index: index as PlayerIndex,
    resources: 16,
    alive: true,
    exceptionTicks: 0,
  })),
  units: [],
  sites: SEAT_BASES,
  nextId: 100,
  outcome: null,
  eliminatedAtTick: [null, null, null, null],
  firstContactTick: null,
  economyDeadAtTick: [null, null, null, null],
});

const SINK = { write: () => {} };

/** 一个假执行器:普通对象,只有缝的两条方法,交回给定的载荷。 */
const fakeRunner = (output: RunnerOutput): SeatRunner => ({
  setSnapshot: () => {},
  drainIntents: () => output,
});

const EMPTY: RunnerOutput = { intents: [], observations: [] };

it("tripped 观测经步 0 落成 exceptionTicks,另外两类走观测出口", () => {
  const recorded: ObservationRecord[] = [];
  const seat0 = fakeRunner({
    intents: [],
    observations: [
      { kind: "tripped", track: "eventTickLimit", value: 9001, limit: 9000 },
      { kind: "wall-clock-soft", track: "wallClockSoftLimit", value: 12, limit: 10 },
    ],
  });
  const result = processTick(
    makeState(),
    [seat0, fakeRunner(EMPTY), fakeRunner(EMPTY), fakeRunner(EMPTY)],
    loadRuleset(RULESET),
    SINK,
    { record: (record) => void recorded.push(record) },
  );
  // 「观测 → 唯一写入口」:tripped 只累加该座位的计数,别的座位不受影响。
  expect(result.state.players.map((player) => player.exceptionTicks)).toEqual([1, 0, 0, 0]);
  // 另外两类原样转发,并在调用点补齐 tick 与座位;tripped 不进观测出口(它已经落成状态变更)。
  expect(recorded).toEqual([
    {
      tick: 0,
      seat: 0,
      kind: "wall-clock-soft",
      track: "wallClockSoftLimit",
      value: 12,
      limit: 10,
    },
  ]);
});

it("同 tick 两条不同轨的 tripped 各计一次", () => {
  const seat2 = fakeRunner({
    intents: [],
    observations: [
      { kind: "tripped", track: "eventTickLimit", value: 9001, limit: 9000 },
      { kind: "tripped", track: "apiCallTickLimit", value: 401, limit: 400 },
    ],
  });
  const result = processTick(
    makeState(),
    [fakeRunner(EMPTY), fakeRunner(EMPTY), seat2, fakeRunner(EMPTY)],
    loadRuleset(RULESET),
    SINK,
  );
  expect(result.state.players.map((player) => player.exceptionTicks)).toEqual([0, 0, 2, 0]);
});

it("观测出口缺席时另外两类静默丢弃,tripped 仍落成状态变更", () => {
  const seat1 = fakeRunner({
    intents: [],
    observations: [
      { kind: "memory-pressure", track: "memoryTickCeiling", value: 100, limit: 90 },
      { kind: "tripped", track: "memoryTickCeiling", value: 100, limit: 90 },
    ],
  });
  // 不传观测出口也不该抛:缺席即静默丢弃。
  const result = processTick(
    makeState(),
    [fakeRunner(EMPTY), seat1, fakeRunner(EMPTY), fakeRunner(EMPTY)],
    loadRuleset(RULESET),
    SINK,
  );
  expect(result.state.players.map((player) => player.exceptionTicks)).toEqual([0, 1, 0, 0]);
});

it("桩执行器不产出观测:exceptionTicks 恒 0(桩路径零回归)", () => {
  const result = processTick(
    makeState(),
    [0, 1, 2, 3].map(() => stubRunner(() => [])),
    loadRuleset(RULESET),
    SINK,
  );
  expect(result.state.players.map((player) => player.exceptionTicks)).toEqual([0, 0, 0, 0]);
});

it("exceptionTicks 随每 tick 写进回放行(该栏位在真源包已存在)", () => {
  const seat0 = fakeRunner({
    intents: [],
    observations: [{ kind: "tripped", track: "eventTickLimit", value: 9001, limit: 9000 }],
  });
  const result = processTick(
    makeState(),
    [seat0, fakeRunner(EMPTY), fakeRunner(EMPTY), fakeRunner(EMPTY)],
    loadRuleset(RULESET),
    SINK,
  );
  // 行组装 → 序列化 → 重新解析:tick 行里的 players 一栏就是异常计数的家。
  const parsed = JSON.parse(serializeTickLine(buildTickLine(result.state, result.events))) as {
    readonly players: readonly { readonly exceptionTicks: number }[];
  };
  expect(parsed.players.map((player) => player.exceptionTicks)).toEqual([1, 0, 0, 0]);
});

it("故障位经步 0 短路:本 tick 不写回放行,返回 uncertain-timeout(作废而非判罚)", () => {
  // 一个直接交回故障位的假执行器:硬超时不在缝上新增方法,它就是返回载荷上的一栏。
  const faulted = fakeRunner({ intents: [], observations: [], fault: "uncertain-timeout" });
  const lines: string[] = [];
  const result = processTick(
    makeState(),
    [faulted, fakeRunner(EMPTY), fakeRunner(EMPTY), fakeRunner(EMPTY)],
    loadRuleset(RULESET),
    { write: (line) => void lines.push(line) },
  );
  // 硬超时不是判罚:exceptionTicks 不动、状态不被推进(tick 仍是 0,不是步 6 自增过的 1)。
  expect(result.state.players.map((player) => player.exceptionTicks)).toEqual([0, 0, 0, 0]);
  expect(result.state.tick).toBe(0);
  // 本 tick 作废:步 6 被短路,没有写回放行。
  expect(lines).toEqual([]);
  expect(result.fault).toBe("uncertain-timeout");
});
