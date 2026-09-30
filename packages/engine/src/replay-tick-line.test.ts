import { expect, it } from "vitest";
import { stateHashOf } from "@model-war/replay";
import { replayTickLine, type GameState } from "./index.js";

const emptyState: GameState = {
  tick: 0,
  players: [],
  units: [],
  sites: [],
  productions: [],
  nextId: 1,
  outcome: null,
};

it("产出一行可解析的 JSONL tick 行", () => {
  const parsed: unknown = JSON.parse(replayTickLine(emptyState));
  expect(parsed).toMatchObject({ type: "tick", tick: 0, events: [] });
});

it("行里的 stateHash 等于该 tick 规范化状态的哈希", () => {
  const line: string = replayTickLine(emptyState);
  const parsed = JSON.parse(line) as { stateHash: string };
  const { players, units, sites, productions } = emptyState;
  expect(parsed.stateHash).toBe(stateHashOf({ players, units, sites, productions }));
});

it("nextId 与 outcome 不进 tick 行(它们是状态机与末行 result 的事)", () => {
  const line: string = replayTickLine({ ...emptyState, nextId: 42, outcome: { rankings: [1, 2, 3, 4], reason: "timeout", territoryScores: [0, 0, 0, 0] } });
  expect(line).not.toContain("nextId");
  expect(line).not.toContain("rankings");
});

it("换一 tick 就换一条不同的行", () => {
  expect(replayTickLine(emptyState)).not.toBe(replayTickLine({ ...emptyState, tick: 1 }));
});
