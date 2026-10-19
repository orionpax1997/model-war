import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { MapDefinition, Ruleset } from "@model-war/replay";
import { QUICKJS_WASI_VERSION, SANDBOX_RUNTIME_ARTIFACT_PATH } from "@model-war/replay";
import {
  createQuickJsRunner,
  WASI_CLOCK_MS,
  WASI_RANDOM_FILL,
  WASI_TIMEZONE_OFFSET_MINUTES,
} from "./runner/quickjs.js";

import { runMatch, type RunMatchParams } from "./index.js";
import { stubRunner, type StubStrategy } from "./runner/stub.js";

const ruleset = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../rulesets/v2.json", import.meta.url)), "utf8"),
) as Ruleset;
const map: MapDefinition = {
  name: "action-effects",
  size: 16,
  rulesetMin: "v1",
  terrain: Array.from({ length: 16 }, () => ".".repeat(16)),
  sites: [
    { id: 0, kind: "base", x: 1, y: 1, initialOwner: 0 },
    { id: 1, kind: "base", x: 14, y: 1, initialOwner: 1 },
    { id: 2, kind: "base", x: 14, y: 14, initialOwner: 2 },
    { id: 3, kind: "base", x: 1, y: 14, initialOwner: 3 },
  ],
  spawnUnits: [{ owner: 0, type: "cavalry", offset: [1, 0] }],
  variantSlots: [],
};
const players = [0, 1, 2, 3].map((seat) => ({
  model: `fixture-${String(seat)}`,
  archiveRef: `trial/${String(seat)}`,
  seat: seat as 0 | 1 | 2 | 3,
}));
type Effect = Parameters<NonNullable<RunMatchParams["actionEffects"]>["record"]>[0];
const play = (options: {
  readonly rules?: Ruleset;
  readonly world?: MapDefinition;
  readonly strategies: readonly StubStrategy[];
  readonly runners?: RunMatchParams["runners"];
  readonly budget?: RunMatchParams["budget"];
  readonly head?: RunMatchParams["head"];
  readonly record?: (effect: Effect) => void;
}) => {
  const lines: string[] = [];
  const params = {
    ruleset: options.rules ?? { ...ruleset, tickLimit: 1 },
    map: options.world ?? map,
    seed: 101,
    players,
    head: options.head ?? {
      runner: "stub" as const,
      timezoneOffset: "+00:00" as const,
      mapHash: "a".repeat(64),
    },
    budget: options.budget ?? {},
    runners: options.runners ?? options.strategies.map((strategy) => stubRunner(strategy)),
    sink: { write: (line: string) => void lines.push(line) },
    ...(options.record === undefined ? {} : { actionEffects: { record: options.record } }),
  };
  return { outcome: runMatch(params), lines };
};
const idle: StubStrategy = () => [];

it("宿主计实际移动格数，含末 tick 骑兵两步，观察开关不改回放/hash/终局", () => {
  const move: StubStrategy = (snapshot) => {
    const unit = snapshot.units.find((item) => item.owner === 0);
    return unit === undefined ? [] : [{ kind: "move", unitId: unit.id, dx: 1, dy: 0 }];
  };
  const effects: Effect[] = [];
  const strategies = [move, idle, idle, idle];
  const observed = play({ strategies, record: (effect) => void effects.push(effect) });
  const quiet = play({ strategies });
  expect(effects).toEqual([
    { seat: 0, kind: "movedSteps", amount: 1 },
    { seat: 0, kind: "movedSteps", amount: 1 },
  ]);
  expect(observed.lines).toEqual(quiet.lines);
  expect(observed.outcome).toEqual(quiet.outcome);
});

it("宿主计成功采集/末 tick 交付、占点与订单开始，不把订单开始当完成", () => {
  const world: MapDefinition = {
    ...map,
    sites: [
      ...map.sites,
      { id: 4, kind: "resource", x: 3, y: 1, initialOwner: 0 },
      { id: 5, kind: "resource", x: 4, y: 1, initialOwner: null },
    ],
    spawnUnits: [
      { owner: 0, type: "worker", offset: [1, 0] },
      { owner: 0, type: "worker", offset: [3, 0] },
    ],
  };
  const economy: StubStrategy = (snapshot) => {
    const worker = snapshot.units.find((unit) => unit.owner === 0);
    if (worker === undefined) return [];
    return snapshot.tick === 0
      ? [{ kind: "harvest", unitId: worker.id, siteId: 4 }]
      : [
          { kind: "transfer", unitId: worker.id },
          { kind: "spawnUnit", baseId: 0, unitType: "worker" },
        ];
  };
  const effects: Effect[] = [];
  const options = {
    world,
    rules: { ...ruleset, tickLimit: 2, captureTicks: 2, harvestRate: 3 },
    strategies: [economy, idle, idle, idle],
  };
  const observed = play({
    ...options,
    record: (effect) => {
      expect(Object.isFrozen(effect)).toBe(true);
      effects.push(effect);
    },
  });
  expect(effects).toEqual([
    { seat: 0, kind: "harvestedAmount", amount: 3 },
    { seat: 0, kind: "captureEvents", amount: 1 },
    { seat: 0, kind: "deliveredAmount", amount: 3 },
    { seat: 0, kind: "productionOrdersStarted", amount: 1 },
  ]);
  expect(observed).toEqual(play(options));
  if (observed.outcome.status !== "completed") throw new Error("fixture should complete");
  expect(observed.outcome.finalState.sites.find((site) => site.id === 0)?.producing).toEqual({
    type: "worker",
    remainingTicks: 1,
  });
});

it("移动后同 tick 死亡仍保留移动格数，堵住的移动不计", () => {
  const world: MapDefinition = {
    ...map,
    spawnUnits: [
      { owner: 0, type: "worker", offset: [1, 0] },
      { owner: 0, type: "worker", offset: [0, 1] },
      { owner: 0, type: "worker", offset: [1, 1] },
      { owner: 1, type: "ranged", offset: [-10, 0] },
    ],
  };
  const move: StubStrategy = (snapshot) =>
    snapshot.units
      .filter((unit) => unit.owner === 0 && (unit.y === 1 || unit.x === 1))
      .map((unit) => ({ kind: "move", unitId: unit.id, dx: 1, dy: 0 }));
  const attack: StubStrategy = (snapshot) => {
    const attacker = snapshot.units.find((unit) => unit.owner === 1);
    const target = snapshot.units.find((unit) => unit.owner === 0 && unit.y === 1);
    return attacker === undefined || target === undefined
      ? []
      : [{ kind: "attack", unitId: attacker.id, targetId: target.id }];
  };
  const effects: Effect[] = [];
  const result = play({
    world,
    strategies: [move, attack, idle, idle],
    record: (effect) => void effects.push(effect),
  });
  expect(effects).toEqual([{ seat: 0, kind: "movedSteps", amount: 1 }]);
  if (result.outcome.status !== "completed") throw new Error("fixture should complete");
  expect(result.outcome.finalState.units.filter((unit) => unit.owner === 0)).toHaveLength(2);
});

it("runner 停止后仍计实际易主，即使同 tick 淘汰结算又把点位归中立", () => {
  const world: MapDefinition = {
    ...map,
    sites: [...map.sites, { id: 4, kind: "resource", x: 3, y: 1, initialOwner: null }],
    spawnUnits: [{ owner: 0, type: "worker", offset: [2, 0] }],
  };
  const candidate = {
    setSnapshot: () => {},
    drainIntents: () => ({
      intents: [],
      observations: [{ kind: "tripped" as const, track: "uncaughtException", value: 1, limit: 0 }],
    }),
  };
  const effects: Effect[] = [];
  const options = {
    world,
    rules: { ...ruleset, tickLimit: 2, captureTicks: 2 },
    strategies: [idle, idle, idle, idle],
    runners: [candidate, stubRunner(idle), stubRunner(idle), stubRunner(idle)],
    budget: { exceptionTickLimit: 1 },
  };
  const observed = play({ ...options, record: (effect) => void effects.push(effect) });
  expect(effects).toEqual([{ seat: 0, kind: "captureEvents", amount: 1 }]);
  expect(observed).toEqual(play(options));
  if (observed.outcome.status !== "completed") throw new Error("fixture should complete");
  expect(observed.outcome.finalState.players[0]?.alive).toBe(false);
  expect(observed.outcome.finalState.sites.find((site) => site.id === 4)?.owner).toBe(-1);
});

it("真实 QuickJS：宿主 effects 观察开关得到相同回放、hash、状态与判定，完整预算照常启用", async () => {
  const wasm = await WebAssembly.compile(
    readFileSync(fileURLToPath(import.meta.resolve("quickjs-wasi/quickjs.wasm"))),
  );
  const runtimeCode = readFileSync(
    fileURLToPath(new URL(`../../../${SANDBOX_RUNTIME_ARTIFACT_PATH}`, import.meta.url)),
    "utf8",
  );
  const head: RunMatchParams["head"] = {
    runner: "quickjs",
    timezoneOffset: "+00:00",
    mapHash: "a".repeat(64),
    quickjsWasiVersion: QUICKJS_WASI_VERSION,
    sandboxRuntimeHash: createHash("sha256").update(runtimeCode).digest("hex"),
    wasiClock: String(WASI_CLOCK_MS),
    wasiRandomFill: WASI_RANDOM_FILL,
    wasiTimezoneOffset: String(WASI_TIMEZONE_OFFSET_MINUTES),
  };
  const budget = {
    eventTickLimit: ruleset.eventTickLimit,
    apiCallTickLimit: ruleset.apiCallTickLimit,
    memoryLimit: ruleset.memoryLimit,
    memoryTickCeiling: ruleset.memoryTickCeiling,
    wallClockSoftLimit: ruleset.wallClockSoftLimit,
    wallClockHardTimeout: ruleset.wallClockHardTimeout,
    exceptionTickLimit: ruleset.exceptionTickLimit,
  };
  const run = async (record?: (effect: Effect) => void) => {
    const handles = await Promise.all(
      ([0, 1, 2, 3] as const).map((seat) =>
        createQuickJsRunner({
          wasm,
          runtimeCode,
          ruleset,
          seat,
          scriptCode: seat === 0 ? "function loop() { move(4, 1, 0); }" : "function loop() {}",
          ...budget,
        }),
      ),
    );
    try {
      return play({
        head,
        budget,
        rules: { ...ruleset, tickLimit: 2 },
        strategies: [],
        runners: handles.map((handle) => handle.runner),
        ...(record === undefined ? {} : { record }),
      });
    } finally {
      for (const handle of handles) handle.dispose();
    }
  };
  const effects: Effect[] = [];
  const observed = await run((effect) => void effects.push(effect));
  expect(effects).toEqual(
    Array.from({ length: 4 }, () => ({ seat: 0, kind: "movedSteps", amount: 1 })),
  );
  expect(observed).toEqual(await run());
});
