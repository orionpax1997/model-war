/**
 * `stateHash` 载荷 = **整个 tick 行去掉 `stateHash` 自身**(hld §4.6)。
 *
 * 之所以是行内容的**自摘要**:给 tick 行加一栏就自动进哈希,不需要维护一份「哪些字段进哈希」的
 * 清单——那份清单会漂移,而且漂了不红(回放行里明明写着新栏,哈希却没算它)。
 *
 * ── 本票的核心不变量在这里(完整版归票 10) ──
 * `stateHashOf` **保序不重排**:数组的顺序本身就是状态的一部分。所以「状态维护违反 id 升序不变量」
 * 必须表现为**哈希变化**,而不是被悄悄纠正。反向钉(乱序 → 哈希不同)是这条不变量的最小版。
 */

import { expect, it } from "vitest";
import { stateHashOf, type JsonValue } from "@model-war/replay";

import { buildTickLine, serializeTickLine, tickLinePayload } from "./tick-line.js";
import type { Event } from "../processor/events.js";
import type { GameState, PlayerIndex, Site, Unit } from "../world/state.js";

const unit = (id: number): Unit => ({
  id,
  owner: 0,
  type: "worker",
  x: id,
  y: 0,
  hp: 2,
  carrying: 0,
});

const site = (id: number): Site => ({
  id,
  kind: "base",
  x: id,
  y: 0,
  owner: 0,
  progressOwner: -1,
  progress: 0,
  producing: { type: "melee", remainingTicks: 2 },
});

const makeState = (tick = 7): GameState => ({
  tick,
  size: 8,
  terrain: Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => false)),
  players: [0, 1, 2, 3].map((index) => ({
    index: index as PlayerIndex,
    resources: 16,
    alive: true,
    exceptionTicks: 0,
  })),
  units: [unit(1), unit(2)],
  sites: [site(3), site(4)],
  nextId: 5,
  outcome: null,
  firstContactTick: null,
});

const NO_EVENTS: readonly Event[] = [];

it("产出一行可解析的 JSONL tick 行", () => {
  const parsed: unknown = JSON.parse(serializeTickLine(buildTickLine(makeState(), NO_EVENTS)));
  expect(parsed).toMatchObject({ type: "tick", tick: 7, events: [] });
});

it("stateHash 就是「整行去掉 stateHash 自身」的摘要", () => {
  const line = buildTickLine(makeState(), NO_EVENTS);
  // 「手挑子集」的反例:把 buildTickLine 里的载荷改回 `{players, units, sites}`,
  // 这一条当场红——行里明明多了 tick 与 events,哈希却没算它们。
  expect(line.stateHash).toBe(stateHashOf(tickLinePayload(line)));
  // 加一栏就自动进哈希:行内容变了,摘要跟着变,不需要有人维护一张「进哈希的字段」表。
  const widened: JsonValue = { ...tickLinePayload(line), addedColumn: 1 };
  expect(stateHashOf(widened)).not.toBe(line.stateHash);
});

it("载荷含 tick:换一个 tick 就是另一条行、另一个哈希", () => {
  const before = buildTickLine(makeState(7), NO_EVENTS);
  const after = buildTickLine(makeState(8), NO_EVENTS);
  expect(before.stateHash).not.toBe(after.stateHash);
  // 「tick 不进载荷」的反例:把它从 tickPayload 里拿掉,这一条红。
  expect(tickLinePayload(after).tick).toBe(8);
});

it("载荷含 events:同一份状态、不同的事件流,哈希不同", () => {
  const state = makeState();
  const quiet = buildTickLine(state, NO_EVENTS);
  const noisy = buildTickLine(state, [{ kind: "unit-destroyed", subjectId: 1 }]);
  // 「events 不进载荷」的反例:去掉 events 栏,这一条红——而战报只消费 events,
  // 事件流不进哈希等于「同一状态的两份回放无法区分」。
  expect(quiet.stateHash).not.toBe(noisy.stateHash);
});

it("nextId 与 outcome 不进 tick 行(它们是状态机与末行 result 的事)", () => {
  const line = buildTickLine(
    {
      ...makeState(),
      nextId: 42,
      outcome: { rankings: [1, 2, 3, 4], reason: "timeout", territoryScores: [0, 0, 0, 0] },
    },
    NO_EVENTS,
  );
  const text = serializeTickLine(line);
  expect(text).not.toContain("nextId");
  expect(text).not.toContain("rankings");
  // 载荷跟着一起不含:它们不在行里,自然也不在「行减自身」里。
  expect(tickLinePayload(line)).not.toHaveProperty("nextId");
});

it("反向钉:units 乱序给出**不同**的哈希(保序是设计,状态维护违反不变量必须表现为哈希变化)", () => {
  const state = makeState();
  const ordered = buildTickLine(state, NO_EVENTS);
  const shuffled = buildTickLine(
    { ...state, units: [state.units[1]!, state.units[0]!] },
    NO_EVENTS,
  );
  // 「stateHashOf 顺手重排」的反例:一旦它重排,这一条红,而 id 升序这条不变量也就没人守了。
  expect(shuffled.stateHash).not.toBe(ordered.stateHash);
});

it("正向钉:同一份状态按 id 升序排好后,哈希与不重排的直接计算逐字相同", () => {
  const state = makeState();
  const line = buildTickLine(state, NO_EVENTS);
  // 直接按行里的数组算一遍(排不排序都不改变它,因为它本来就是升序的)。
  const byHand: JsonValue = {
    type: "tick",
    tick: state.tick,
    players: state.players,
    units: state.units,
    sites: state.sites,
    events: NO_EVENTS,
  };
  expect(line.stateHash).toBe(stateHashOf(byHand));
});
