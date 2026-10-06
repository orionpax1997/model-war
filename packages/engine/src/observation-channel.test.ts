/**
 * 观测不影响回放(票 09):墙钟软限与内存压力走**回放之外**那条通道,永远不进事件流、更不进
 * `stateHash`(hld §5.3 / spec《观测通道》)。
 *
 * 三条用例的关系:
 *
 * 1. 同一输入两次跑,即使观测行不同,回放也**逐字节相同**——正面钉住「观测不影响回放」。
 * 2. 一条能弄红的反例:把墙钟读数裹进事件流,状态哈希立刻跨跑不一致——反面说明它为什么
 *    不能进事件流(事件流是 `stateHash` 的一部分,而墙钟不可复算)。
 * 3. 故障位(墙钟硬超时)使整场作废:`runMatch` 交回 `uncertain-timeout`、不写末行 `result`。
 *
 * 用**假执行器**(只实现缝的 `setSnapshot` / `drainIntents`)而不是真 VM:本文件验的是通道的
 * 分工,不是沙箱行为——沙箱侧的墙钟判据在 `runner/quickjs.test.ts`。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import type { MapDefinition, Ruleset } from "@model-war/replay";

import { runMatch } from "./index.js";
import { buildTickLine } from "./replay-writer/index.js";
import type { Observation, RunnerOutput, SeatRunner } from "./runner/index.js";
import type { GameState, PlayerIndex } from "./world/state.js";

/** 本文件在 `packages/engine/src/`,到仓库根是三层。 */
const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), "utf8");

const RULESET = JSON.parse(read("rulesets/v1.json")) as Ruleset;
const MAP = JSON.parse(read("maps/open-clash.json")) as MapDefinition;

const players = [
  { model: "alpha", archiveRef: "archive/alpha/r1", seat: 0 },
  { model: "beta", archiveRef: "archive/beta/r1", seat: 1 },
  { model: "gamma", archiveRef: "archive/gamma/r1", seat: 2 },
  { model: "delta", archiveRef: "archive/delta/r1", seat: 3 },
] as const;

/** 一个交回给定载荷、意图恒空的执行器(缝恰好两个方法)。 */
const fakeRunner = (output: RunnerOutput): SeatRunner => ({
  setSnapshot: () => {},
  drainIntents: () => output,
});

const empty = (): RunnerOutput => ({ intents: [], observations: [] });

const SOFT: Observation = {
  kind: "wall-clock-soft",
  track: "wallClockSoftLimit",
  value: 42,
  limit: 10,
};

/** 跑一局空转对局,座位 0 每 tick 交回给定的观测(其余三方不报)。 */
const runWithSeatZeroObservation = (
  observation: Observation | undefined,
): { readonly lines: readonly string[]; readonly recorded: readonly unknown[] } => {
  const lines: string[] = [];
  const recorded: unknown[] = [];
  runMatch({
    ruleset: RULESET,
    map: MAP,
    seed: 7,
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "a".repeat(64) },
    players,
    runners: [
      fakeRunner(
        observation === undefined ? empty() : { intents: [], observations: [observation] },
      ),
      fakeRunner(empty()),
      fakeRunner(empty()),
      fakeRunner(empty()),
    ],
    budget: {},
    sink: { write: (line) => void lines.push(line) },
    observations: { record: (record) => void recorded.push(record) },
  });
  return { lines, recorded };
};

it("同一输入两次跑得到逐字节相同回放,即使观测行不同(观测不影响回放)", () => {
  const without = runWithSeatZeroObservation(undefined);
  const withSoft = runWithSeatZeroObservation(SOFT);
  // 两条对照都有内容:一次真的一条观测都不产,另一次真的产出了观测(不是两次都空)。
  expect(without.recorded).toEqual([]);
  expect(withSoft.recorded.length).toBeGreaterThan(0);
  expect(withSoft.recorded[0]).toMatchObject({ kind: "wall-clock-soft", value: 42, limit: 10 });
  // 逐字节相同:观测永远不进回放行、更不进 `stateHash`。
  expect(withSoft.lines.join("\n")).toBe(without.lines.join("\n"));
});

it("能弄红的反例:把墙钟读数塞进事件流,状态哈希立刻跨跑不一致", () => {
  const state = gameState();
  // 同一份状态、同一 tick,只有「墙钟读数」不同。事件流进哈希,所以读数一旦裹进事件,
  // 同一局在两次跑(机器负载不同、读数不同)会算出不同的 stateHash——直接违反 FR-2。
  const first = buildTickLine(state, [{ kind: "exception", subjectId: 1201 }]);
  const second = buildTickLine(state, [{ kind: "exception", subjectId: 1207 }]);
  expect(first.stateHash).not.toBe(second.stateHash);
  // 对照:读数留在观测出口里时,回放本身逐字节相同(上一条用例)。两条通道互不串线。
  const quietA = buildTickLine(state, []);
  const quietB = buildTickLine(state, []);
  expect(quietA.stateHash).toBe(quietB.stateHash);
});

it("故障位使整场作废:runMatch 交回 uncertain-timeout、不写末行 result", () => {
  const lines: string[] = [];
  const outcome = runMatch({
    ruleset: RULESET,
    map: MAP,
    seed: 7,
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "a".repeat(64) },
    players,
    runners: [
      fakeRunner({ intents: [], observations: [], fault: "uncertain-timeout" }),
      fakeRunner(empty()),
      fakeRunner(empty()),
      fakeRunner(empty()),
    ],
    budget: {},
    sink: { write: (line) => void lines.push(line) },
  });
  expect(outcome.status).toBe("uncertain-timeout");
  // 作废而非判罚:没有合法的末行 `result`,也没有 tick 行(本 tick 被短路)。
  expect(lines.map((line) => (JSON.parse(line) as { type: string }).type)).toEqual(["meta"]);
});

/** 一份最小状态,只为把 tick 行构出来(与 `tick-line.test.ts` 同源)。 */
function gameState(tick = 7): GameState {
  return {
    tick,
    size: 8,
    terrain: Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => false)),
    players: [0, 1, 2, 3].map((index) => ({
      index: index as PlayerIndex,
      resources: 16,
      alive: true,
      exceptionTicks: 0,
    })),
    units: [],
    sites: [],
    nextId: 1,
    outcome: null,
    eliminatedAtTick: [null, null, null, null],
    firstContactTick: null,
    economyDeadAtTick: [null, null, null, null],
  };
}
