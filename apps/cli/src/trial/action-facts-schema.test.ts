import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { openSandbox } from "@model-war/engine/runner";
import {
  ACTION_API_NAMES,
  ACTION_EFFECT_NAMES,
  ACTION_ERROR_CODES,
  ACTION_ZERO_CALLS,
  ACTION_ZERO_ERRORS,
  SANDBOX_RUNTIME_ARTIFACT_PATH,
  type JsonValue,
  type TrialActionFacts,
  type TrialObservationLine,
} from "@model-war/schema";
import { expect, it } from "vitest";

import { validateTrialObservation } from "../validator.js";

const OLD_LINE: TrialObservationLine = {
  matchIndex: 0,
  delivered: 0,
  captures: 0,
  noScoreSource: true,
};
const FACTS: TrialActionFacts = {
  version: 1,
  scriptSha256: "a".repeat(64),
  seed: 101,
  seat: 0,
  complete: true,
  observedTicks: 1,
  missingTicks: 0,
  calls: ACTION_ZERO_CALLS,
  errors: ACTION_ZERO_ERRORS,
  effects: {
    movedSteps: 0,
    harvestedAmount: 0,
    deliveredAmount: 0,
    captureEvents: 0,
    productionOrdersStarted: 0,
  },
};
const withFacts = (actionFacts: JsonValue): JsonValue => ({ ...OLD_LINE, actionFacts });

it(
  "行动事实公共投影与真实 WASM 的动作表及 ERR_* 注入顺序逐字一致",
  { timeout: 30_000 },
  async () => {
    const wasm = await WebAssembly.compile(
      readFileSync(fileURLToPath(import.meta.resolve("quickjs-wasi/quickjs.wasm"))),
    );
    const runtimeCode = readFileSync(
      fileURLToPath(new URL(`../../../../${SANDBOX_RUNTIME_ARTIFACT_PATH}`, import.meta.url)),
      "utf8",
    );
    const session = await openSandbox({
      wasm,
      runtimeCode,
      scriptCode: `function loop() {
      move(999, 1, 0);
      moveTo(999, 0, 0);
      attack(999, 998);
      harvest(999, 998);
      transfer(999);
      spawnUnit(999, "not-a-unit");
    }`,
      seat: 0,
    });
    try {
      // runtime 的错误名来自 INTENT_ERR_CODES；观察实际 guest 值，保持测试在公共缝上。
      expect(
        session.probe(
          'Object.getOwnPropertyNames(globalThis).filter(name => name.startsWith("ERR_"))',
        ),
      ).toEqual(ACTION_ERROR_CODES);
      expect(session.probe(`[${ACTION_ERROR_CODES.join(",")}]`)).toEqual(ACTION_ERROR_CODES);
      session.setSnapshot({ tick: 0, size: 0, terrain: [], players: [], units: [], sites: [] });
      expect(session.drainIntents().actionFacts).toEqual({
        calls: ACTION_ZERO_CALLS,
        errors: ACTION_ZERO_ERRORS,
      });
      session.runLoop();
      const { actionFacts } = session.drainIntents();
      expect(Object.keys(actionFacts.calls)).toEqual(ACTION_API_NAMES);
      expect(Object.keys(actionFacts.errors)).toEqual(ACTION_API_NAMES);
      expect(actionFacts.calls).toEqual({
        move: 1,
        moveTo: 1,
        attack: 1,
        harvest: 1,
        transfer: 1,
        spawnUnit: 1,
      });
      for (const name of ACTION_API_NAMES) {
        expect(Object.keys(actionFacts.errors[name])).toEqual(ACTION_ERROR_CODES);
        expect(actionFacts.errors[name]).toEqual({
          ERR_NOT_ENOUGH_RESOURCES: 0,
          ERR_INVALID_UNIT: name === "spawnUnit" ? 0 : 1,
          ERR_NOT_OWNER: 0,
          ERR_OUT_OF_RANGE: 0,
          ERR_INVALID_TARGET: 0,
          ERR_INVALID_SITE: 0,
          ERR_BAD_ARGS: name === "spawnUnit" ? 1 : 0,
        });
      }
      expect(validateTrialObservation(withFacts({ ...FACTS, ...actionFacts })).ok).toBe(true);
    } finally {
      session.dispose();
    }
  },
);

it("行动事实 JSON Schema 保留旧行，接受完整、缺失 tick 与安全整数上界", () => {
  const fixtures: readonly JsonValue[] = [
    OLD_LINE,
    withFacts(FACTS),
    withFacts({ ...FACTS, complete: false, missingTicks: 1 }),
    withFacts({
      ...FACTS,
      calls: { ...FACTS.calls, move: Number.MAX_SAFE_INTEGER },
      errors: {
        ...FACTS.errors,
        move: { ...FACTS.errors.move, ERR_BAD_ARGS: Number.MAX_SAFE_INTEGER },
      },
      effects: { ...FACTS.effects, movedSteps: Number.MAX_SAFE_INTEGER },
    }),
  ];
  for (const fixture of fixtures) {
    expect(validateTrialObservation(fixture).ok).toBe(true);
  }
});

it("行动事实 JSON Schema 拒绝所有固定计数表的缺键和额外键", () => {
  for (const key of Object.keys(FACTS)) {
    const omitted = Object.fromEntries(Object.entries(FACTS).filter(([name]) => name !== key));
    expect(validateTrialObservation(withFacts(omitted)).ok, `actionFacts 缺 ${key}`).toBe(false);
  }
  expect(validateTrialObservation(withFacts({ ...FACTS, mystery: 0 })).ok).toBe(false);
  for (const [field, table, names] of [
    ["calls", FACTS.calls, ACTION_API_NAMES],
    ["errors", FACTS.errors, ACTION_API_NAMES],
    ["effects", FACTS.effects, ACTION_EFFECT_NAMES],
  ] as const) {
    expect(
      validateTrialObservation(withFacts({ ...FACTS, [field]: { ...table, mystery: 0 } })).ok,
      `${field} 额外键`,
    ).toBe(false);
    for (const key of names) {
      const omitted = Object.fromEntries(Object.entries(table).filter(([name]) => name !== key));
      expect(
        validateTrialObservation(withFacts({ ...FACTS, [field]: omitted })).ok,
        `${field} 缺 ${key}`,
      ).toBe(false);
    }
  }
  for (const action of ACTION_API_NAMES) {
    for (const code of ACTION_ERROR_CODES) {
      const omitted = Object.fromEntries(
        Object.entries(FACTS.errors[action]).filter(([name]) => name !== code),
      );
      expect(
        validateTrialObservation(
          withFacts({ ...FACTS, errors: { ...FACTS.errors, [action]: omitted } }),
        ).ok,
        `${action} 缺 ${code}`,
      ).toBe(false);
    }
    expect(
      validateTrialObservation(
        withFacts({
          ...FACTS,
          errors: { ...FACTS.errors, [action]: { ...FACTS.errors[action], mystery: 0 } },
        }),
      ).ok,
    ).toBe(false);
  }
});

it("行动事实 JSON Schema 拒绝每个计数位置的负数、小数、不安全整数及错型", () => {
  for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0", null, true, [], {}]) {
    for (const name of ACTION_API_NAMES) {
      expect(
        validateTrialObservation(
          withFacts({ ...FACTS, calls: { ...FACTS.calls, [name]: invalid } }),
        ).ok,
      ).toBe(false);
      for (const code of ACTION_ERROR_CODES) {
        expect(
          validateTrialObservation(
            withFacts({
              ...FACTS,
              errors: {
                ...FACTS.errors,
                [name]: { ...FACTS.errors[name], [code]: invalid },
              },
            }),
          ).ok,
        ).toBe(false);
      }
    }
    for (const name of ACTION_EFFECT_NAMES) {
      expect(
        validateTrialObservation(
          withFacts({ ...FACTS, effects: { ...FACTS.effects, [name]: invalid } }),
        ).ok,
      ).toBe(false);
    }
    for (const name of ["observedTicks", "missingTicks", "seed"] as const) {
      expect(validateTrialObservation(withFacts({ ...FACTS, [name]: invalid })).ok).toBe(false);
    }
  }
});

it("行动事实 JSON Schema 继续限制版本、hash、座位与 complete iff missingTicks=0", () => {
  for (const patch of [
    { version: 2 },
    { scriptSha256: "a".repeat(63) },
    { scriptSha256: "A".repeat(64) },
    { seat: 1 },
    { complete: false },
    { missingTicks: 1 },
  ]) {
    expect(validateTrialObservation(withFacts({ ...FACTS, ...patch })).ok).toBe(false);
  }
});

const TERMINAL_SUMMARY = {
  version: 1,
  seed: 101,
  tick: 3,
  reason: "timeout",
  weights: { baseScore: 10, resourceScore: 3, unitCostDivisor: 4 },
  unitCosts: { worker: 8, melee: 12, ranged: 16, cavalry: 20 },
  rankPoints: [3, 2, 1, 0],
  players: [0, 1, 2, 3].map((seat) => ({
    seat,
    player: seat === 0 ? "candidate" : `bench-${seat}`,
    controlledBases: 1,
    controlledResources: 0,
    survivingUnits: { worker: 1, melee: 0, ranged: 0, cavalry: 0 },
    survivingUnitCost: 8,
    score: { bases: 10, resources: 0, units: 2 },
    territoryScore: 12,
    rank: 1,
    rankPoints: 1.5,
    alive: true,
    eliminatedAtTick: null,
  })),
};

it("终局摘要 JSON Schema 允许旧行和四方 timeout 合同", () => {
  expect(validateTrialObservation(OLD_LINE).ok).toBe(true);
  expect(validateTrialObservation({ ...OLD_LINE, terminalSummary: TERMINAL_SUMMARY }).ok).toBe(
    true,
  );
});

it("终局摘要形状严格闭合：版本、原因、四元组、身份和全部必填字段拒绝畸形值", () => {
  const check = (terminalSummary: JsonValue) =>
    validateTrialObservation({ ...OLD_LINE, terminalSummary }).ok;
  for (const patch of [
    { version: 2 },
    { reason: "uncertain-timeout" },
    { reason: "unknown" },
    { players: TERMINAL_SUMMARY.players.slice(1) },
    { players: TERMINAL_SUMMARY.players.concat(TERMINAL_SUMMARY.players.slice(0, 1)) },
    { rankPoints: [3, 2, 1] },
    { rankPoints: [3, 2, 1, 0, 0] },
    { weights: { ...TERMINAL_SUMMARY.weights, unitCostDivisor: 0 } },
    { mystery: "untrusted" },
  ])
    expect(check({ ...TERMINAL_SUMMARY, ...patch })).toBe(false);
  for (const field of Object.keys(TERMINAL_SUMMARY)) {
    expect(
      check(Object.fromEntries(Object.entries(TERMINAL_SUMMARY).filter(([key]) => key !== field))),
    ).toBe(false);
  }
  for (const field of ["weights", "unitCosts"] as const) {
    const table = TERMINAL_SUMMARY[field];
    expect(check({ ...TERMINAL_SUMMARY, [field]: { ...table, mystery: 0 } })).toBe(false);
    for (const key of Object.keys(table)) {
      expect(
        check({
          ...TERMINAL_SUMMARY,
          [field]: Object.fromEntries(Object.entries(table).filter(([name]) => name !== key)),
        }),
      ).toBe(false);
    }
  }
  const player = TERMINAL_SUMMARY.players[0];
  if (player === undefined) throw new Error("缺测试四方夹具");
  const checkPlayer = (entry: JsonValue) =>
    check({ ...TERMINAL_SUMMARY, players: [entry, ...TERMINAL_SUMMARY.players.slice(1)] });
  for (const field of Object.keys(player)) {
    expect(
      checkPlayer(Object.fromEntries(Object.entries(player).filter(([key]) => key !== field))),
    ).toBe(false);
  }
  for (const patch of [
    { seat: 4 },
    { seat: -1 },
    { rank: 0 },
    { rank: 5 },
    { player: "" },
    { player: "raw\nscript" },
    { player: "a".repeat(129) },
    { alive: 1 },
    { eliminatedAtTick: -1 },
    { mystery: "untrusted" },
  ])
    expect(checkPlayer({ ...player, ...patch })).toBe(false);
  for (const field of ["survivingUnits", "score"] as const) {
    const table = player[field];
    expect(checkPlayer({ ...player, [field]: { ...table, mystery: 0 } })).toBe(false);
    for (const key of Object.keys(table)) {
      expect(
        checkPlayer({
          ...player,
          [field]: Object.fromEntries(Object.entries(table).filter(([name]) => name !== key)),
        }),
      ).toBe(false);
    }
  }
});

it("终局摘要全部计数域限制非负安全整数，名次积分允许并列小数", () => {
  const player = TERMINAL_SUMMARY.players[0];
  if (player === undefined) throw new Error("缺测试四方夹具");
  const check = (terminalSummary: JsonValue) =>
    validateTrialObservation({ ...OLD_LINE, terminalSummary }).ok;
  const checkPlayer = (entry: JsonValue) =>
    check({ ...TERMINAL_SUMMARY, players: [entry, ...TERMINAL_SUMMARY.players.slice(1)] });
  expect(checkPlayer({ ...player, eliminatedAtTick: 2, alive: false })).toBe(true);
  for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0", null, true, [], {}]) {
    for (const field of ["seed", "tick"] as const)
      expect(check({ ...TERMINAL_SUMMARY, [field]: invalid })).toBe(false);
    for (const field of ["weights", "unitCosts"] as const) {
      for (const key of Object.keys(TERMINAL_SUMMARY[field])) {
        expect(
          check({ ...TERMINAL_SUMMARY, [field]: { ...TERMINAL_SUMMARY[field], [key]: invalid } }),
        ).toBe(false);
      }
    }
    for (const field of [
      "controlledBases",
      "controlledResources",
      "survivingUnitCost",
      "territoryScore",
    ] as const) {
      expect(checkPlayer({ ...player, [field]: invalid })).toBe(false);
    }
    for (const field of ["survivingUnits", "score"] as const) {
      for (const key of Object.keys(player[field])) {
        expect(checkPlayer({ ...player, [field]: { ...player[field], [key]: invalid } })).toBe(
          false,
        );
      }
    }
  }
  expect(checkPlayer({ ...player, rankPoints: -1 })).toBe(false);
  expect(checkPlayer({ ...player, rankPoints: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
});
