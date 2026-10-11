/**
 * 异常淘汰必须落 `exception` 事件。
 *
 * 背景:sol 赛季 480 场全败全第 4,死因是连续三 tick 超 `eventTickLimit` 被异常淘汰,
 * 但回放事件流里一条 `exception` 都没有——`collector.exception()` 全仓零调用,
 * 超预算死得无声无息(STEP_OF 早给它留了 0 号位,reporter 的「异常出局」文案也在等它)。
 * 本文件把「异常淘汰落事件、正常淘汰不落」钉成常驻断言。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { processTick } from "../index.js";
import { loadRuleset } from "../../ruleset-loader/index.js";
import type { Observation, SeatRunner } from "../../runner/index.js";
import { stubRunner } from "../../runner/stub.js";
import type { GameState, PlayerIndex, Site } from "../../world/state.js";

const root = `${fileURLToPath(new URL(".", import.meta.url))}../../../../../`;
const RULESET = JSON.parse(readFileSync(`${root}rulesets/v1.json`, "utf8"));

/** 四席各一个哨兵基地:没有它,空状态会在步 5 把所有席位按经济原因淘汰掉。 */
const seatBases = (): readonly Site[] =>
  [0, 1, 2, 3].map((seat) => ({
    id: 900 + seat,
    kind: "base" as const,
    x: 900 + seat,
    y: 900,
    owner: seat as PlayerIndex,
    progressOwner: -1,
    progress: 0,
    producing: null,
  }));

const makeState = (withBases: boolean): GameState => ({
  tick: 0,
  size: 8,
  terrain: Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => false)),
  players: [0, 1, 2, 3].map((index) => ({
    index: index as PlayerIndex,
    resources: 16,
    alive: true,
    exceptionTicks: 0,
  })),
  units: [],
  sites: withBases ? seatBases() : [],
  nextId: 100,
  outcome: null,
  eliminatedAtTick: [null, null, null, null],
  firstContactTick: null,
  economyDeadAtTick: [null, null, null, null],
});

/** 每 tick 交回一条 `tripped` 观测的座位(模拟超预算脚本,不跑真 VM)。 */
const trippingRunner = (): SeatRunner => ({
  setSnapshot: () => {},
  drainIntents: () => ({
    intents: [],
    observations: [
      { kind: "tripped", track: "events", value: 55_000, limit: 10_000 } satisfies Observation,
    ],
  }),
});

const runTick = (state: GameState, runners: readonly SeatRunner[]) => {
  const lines: string[] = [];
  const tick = processTick(
    state,
    runners,
    loadRuleset(RULESET),
    { write: (line) => lines.push(line) },
    { record: () => {} },
    { exceptionTickLimit: 3 },
  );
  const first = lines[0];
  if (first === undefined) {
    throw new Error("processTick 没有写出 tick 行");
  }
  const events = (JSON.parse(first).events ?? []) as readonly {
    readonly kind: string;
    readonly subjectId: number;
  }[];
  return { tick, events };
};

it("异常淘汰落 exception 事件:连续三 tick 超预算的座位,淘汰那一 tick 同时有两条事件", () => {
  const idle = stubRunner(() => []);
  const runners = [trippingRunner(), idle, idle, idle];
  let state = makeState(true);
  // 前两 tick:异常计数累加,人还活着,不落事件。
  for (const expected of [1, 2]) {
    const { tick, events } = runTick(state, runners);
    state = tick.state;
    expect(tick.fault).toBeNull();
    expect(state.players[0]?.alive).toBe(true);
    expect(state.players[0]?.exceptionTicks).toBe(expected);
    expect(events.filter((event) => event.subjectId === 0)).toEqual([]);
  }
  // 第三 tick:触顶淘汰,exception 与 player-eliminated 双事件。
  const { tick, events } = runTick(state, runners);
  expect(tick.fault).toBeNull();
  expect(tick.state.players[0]?.alive).toBe(false);
  expect(
    events.filter((event) => event.subjectId === 0).map((event) => event.kind),
    "异常淘汰必须同时落 exception 事件,否则回放看不出死因",
  ).toEqual(["exception", "player-eliminated"]);
  // 其余三席全程正常:活着且名下无事件。
  expect(tick.state.players.slice(1).every((player) => player.alive)).toBe(true);
});

it("正常淘汰不落 exception 事件:无单位无基地的席位只有 player-eliminated", () => {
  const idle = stubRunner(() => []);
  const { tick, events } = runTick(makeState(false), [idle, idle, idle, idle]);
  expect(tick.fault).toBeNull();
  expect(tick.state.players.every((player) => !player.alive)).toBe(true);
  expect(events.map((event) => event.kind).sort(), "经济原因淘汰只落 player-eliminated").toEqual([
    "player-eliminated",
    "player-eliminated",
    "player-eliminated",
    "player-eliminated",
  ]);
});
