import { expect, it } from "vitest";

import {
  ACTION_API_NAMES,
  ACTION_EFFECT_NAMES,
  ACTION_ERROR_CODES,
  ACTION_ZERO_CALLS,
  ACTION_ZERO_ERRORS,
  SANDBOX_INJECTED_API_SYMBOL_CATALOG,
  TRIAL_OBSERVATION_JSON_SCHEMA,
  type ActionCallCounts,
  type ActionEffects,
  type ActionErrorCounts,
} from "./index.js";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type FactsSchema = typeof TRIAL_OBSERVATION_JSON_SCHEMA.properties.actionFacts.properties;

// 名字保持 readonly 定长字面量；JSON Schema 的静态属性与计数类型不能各自漂移。
export type ActionNamesAreReadonlyTuple = Assert<
  Equals<
    typeof ACTION_API_NAMES,
    readonly ["move", "moveTo", "attack", "harvest", "transfer", "spawnUnit"]
  >
>;
export type ActionErrorCodesAreReadonlyTuple = Assert<
  Equals<
    typeof ACTION_ERROR_CODES,
    readonly [
      "ERR_NOT_ENOUGH_RESOURCES",
      "ERR_INVALID_UNIT",
      "ERR_NOT_OWNER",
      "ERR_OUT_OF_RANGE",
      "ERR_INVALID_TARGET",
      "ERR_INVALID_SITE",
      "ERR_BAD_ARGS",
    ]
  >
>;
export type ActionEffectNamesAreReadonlyTuple = Assert<
  Equals<
    typeof ACTION_EFFECT_NAMES,
    readonly [
      "movedSteps",
      "harvestedAmount",
      "deliveredAmount",
      "captureEvents",
      "productionOrdersStarted",
    ]
  >
>;
export type ActionCallSchemaKeysMatchType = Assert<
  Equals<keyof FactsSchema["calls"]["properties"], keyof ActionCallCounts>
>;
export type ActionErrorsSchemaKeysMatchType = Assert<
  Equals<keyof FactsSchema["errors"]["properties"], keyof ActionErrorCounts>
>;
export type ActionErrorCodeSchemaKeysMatchType = Assert<
  Equals<
    keyof FactsSchema["errors"]["properties"][keyof ActionErrorCounts]["properties"],
    keyof ActionErrorCounts[keyof ActionErrorCounts]
  >
>;
export type ActionEffectsSchemaKeysMatchType = Assert<
  Equals<keyof FactsSchema["effects"]["properties"], keyof ActionEffects>
>;

it("行动事实的行动名与错误码按公开注入面目录逐字投影", () => {
  expect(ACTION_API_NAMES).toEqual(
    SANDBOX_INJECTED_API_SYMBOL_CATALOG.filter((entry) => entry.kind === "action").map(
      (entry) => entry.symbol,
    ),
  );
  expect(ACTION_ERROR_CODES).toEqual(
    SANDBOX_INJECTED_API_SYMBOL_CATALOG.filter((entry) => entry.kind === "error-code").map(
      (entry) => entry.symbol,
    ),
  );
});

it("宿主行动聚合从 schema 公共入口取得完整零值模板", () => {
  expect(ACTION_ZERO_CALLS).toEqual({
    move: 0,
    moveTo: 0,
    attack: 0,
    harvest: 0,
    transfer: 0,
    spawnUnit: 0,
  });
  expect(Object.keys(ACTION_ZERO_ERRORS)).toEqual(ACTION_API_NAMES);
  for (const name of ACTION_API_NAMES) {
    expect(ACTION_ZERO_ERRORS[name]).toEqual({
      ERR_NOT_ENOUGH_RESOURCES: 0,
      ERR_INVALID_UNIT: 0,
      ERR_NOT_OWNER: 0,
      ERR_OUT_OF_RANGE: 0,
      ERR_INVALID_TARGET: 0,
      ERR_INVALID_SITE: 0,
      ERR_BAD_ARGS: 0,
    });
  }
});

it("行动事实从 schema 公共入口提供固定顺序的宿主效果名", () => {
  expect(ACTION_EFFECT_NAMES).toEqual([
    "movedSteps",
    "harvestedAmount",
    "deliveredAmount",
    "captureEvents",
    "productionOrdersStarted",
  ]);
});

it("行动事实 JSON Schema 的固定计数表闭合且只接受非负安全整数", () => {
  const facts = TRIAL_OBSERVATION_JSON_SCHEMA.properties.actionFacts.properties;
  const count = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
  for (const [table, names] of [
    [facts.calls, ACTION_API_NAMES],
    [facts.errors, ACTION_API_NAMES],
    [facts.effects, ACTION_EFFECT_NAMES],
  ] as const) {
    expect(table.type).toBe("object");
    expect(table.additionalProperties).toBe(false);
    expect(table.required).toEqual(names);
    expect(Object.keys(table.properties)).toEqual(names);
  }
  expect(Object.values(facts.calls.properties)).toEqual(ACTION_API_NAMES.map(() => count));
  expect(Object.values(facts.effects.properties)).toEqual(ACTION_EFFECT_NAMES.map(() => count));
  for (const name of ACTION_API_NAMES) {
    const errors = facts.errors.properties[name];
    expect(errors.type).toBe("object");
    expect(errors.additionalProperties).toBe(false);
    expect(errors.required).toEqual(ACTION_ERROR_CODES);
    expect(Object.keys(errors.properties)).toEqual(ACTION_ERROR_CODES);
    expect(Object.values(errors.properties)).toEqual(ACTION_ERROR_CODES.map(() => count));
  }
  expect(facts.observedTicks).toEqual(count);
  expect(facts.missingTicks).toEqual(count);
});

type TerminalSummary = import("./index.js").TrialTerminalSummary;
type TerminalPlayer = import("./index.js").TrialTerminalPlayer;
type TerminalSchema = typeof TRIAL_OBSERVATION_JSON_SCHEMA.properties.terminalSummary;
export type TerminalSummarySchemaKeysMatchType = Assert<
  Equals<keyof TerminalSchema["properties"], keyof TerminalSummary>
>;
export type TerminalPlayerSchemaKeysMatchType = Assert<
  Equals<keyof TerminalSchema["properties"]["players"]["items"]["properties"], keyof TerminalPlayer>
>;
export type TerminalUnitTableSchemaKeysMatchType = Assert<
  Equals<
    keyof TerminalSchema["properties"]["unitCosts"]["properties"],
    keyof TerminalSummary["unitCosts"]
  >
>;
export type TerminalWeightsSchemaKeysMatchType = Assert<
  Equals<
    keyof TerminalSchema["properties"]["weights"]["properties"],
    keyof TerminalSummary["weights"]
  >
>;
export type TerminalScoreSchemaKeysMatchType = Assert<
  Equals<
    keyof TerminalSchema["properties"]["players"]["items"]["properties"]["score"]["properties"],
    keyof TerminalPlayer["score"]
  >
>;

it("终局数据合同必填键与类型对齐，固定四方而旧记录的摘要可缺失", () => {
  const terminal = TRIAL_OBSERVATION_JSON_SCHEMA.properties.terminalSummary;
  expect(TRIAL_OBSERVATION_JSON_SCHEMA.required).not.toContain("terminalSummary");
  expect(terminal.required).toEqual(Object.keys(terminal.properties));
  expect(terminal.properties.players).toMatchObject({ type: "array", minItems: 4, maxItems: 4 });
  expect(terminal.properties.rankPoints).toMatchObject({ type: "array", minItems: 4, maxItems: 4 });
  const player = terminal.properties.players.items;
  expect(player.required).toEqual(Object.keys(player.properties));
  expect(player.additionalProperties).toBe(false);
  for (const table of [
    terminal.properties.unitCosts,
    terminal.properties.weights,
    player.properties.survivingUnits,
    player.properties.score,
  ]) {
    expect(table.required).toEqual(Object.keys(table.properties));
    expect(table.additionalProperties).toBe(false);
  }
});
