/**
 * 计划与网格汇总的合同（**单份 JSON 的形状**）：TypeScript 是形状真源，JSON Schema 手工对齐
 * （ADR-0003），跨字段关系不住在这里（归 runner 的 `checkTrialPlan` 与消费端的装载期断言）。
 *
 * 断言对象是外部可观察的形状：必填键集合与类型键集合一致、`additionalProperties: false`、
 * 版本/场数/座位域的常量与类型对齐。正例与缺字段/额外字段反例在 runner 侧的读入测试里跑
 * （那里才有 ajv/zod 的运行时校验器）；这里不引校验器——本包不得依赖任何包。
 */

import { expect, it } from "vitest";

import {
  TRIAL_GRID_MAP_NAMES,
  TRIAL_GRID_SUMMARY_JSON_SCHEMA,
  TRIAL_GRID_SUMMARY_VERSION,
  TRIAL_MATCHES_PER_CANDIDATE,
  TRIAL_PLAN_JSON_SCHEMA,
  TRIAL_PLAN_VERSION,
  TRIAL_SPARRING_ROLE_ORDER,
  TRIAL_SPARRING_ROLES,
  type TrialGridMatch,
  type TrialGridScore,
  type TrialGridSummary,
  type TrialPlan,
  type TrialPlanMatch,
  type TrialPlanScript,
} from "./index.js";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

type PlanSchema = typeof TRIAL_PLAN_JSON_SCHEMA.properties;
type PlanKeys = keyof TrialPlan;
type SummaryKeys = keyof TrialGridSummary;

// 必填键集合 === 类型键集合：多一个少一个都会在这里红（与 `archive-meta` 同一手法）。
export type PlanRequiredKeysMatchType = Assert<Equals<PlanKeys, keyof PlanSchema>>;
export type PlanMatchKeysMatchType = Assert<
  Equals<keyof TrialPlanMatch, keyof PlanSchema["matches"]["items"]["properties"]>
>;
export type PlanScriptKeysMatchType = Assert<
  Equals<keyof TrialPlanScript, keyof PlanSchema["scripts"]["items"]["properties"]>
>;
export type SummaryRequiredKeysMatchType = Assert<
  Equals<SummaryKeys, keyof typeof TRIAL_GRID_SUMMARY_JSON_SCHEMA.properties>
>;
export type SummaryMatchKeysMatchType = Assert<
  Equals<
    keyof TrialGridMatch,
    keyof typeof TRIAL_GRID_SUMMARY_JSON_SCHEMA.properties.matches.items.properties
  >
>;
export type SummaryScoreKeysMatchType = Assert<
  Equals<
    keyof TrialGridScore,
    keyof typeof TRIAL_GRID_SUMMARY_JSON_SCHEMA.properties.score.properties
  >
>;

it("计划的单份 JSON 形状：闭合、必填齐全、版本与场数是常量", () => {
  expect(TRIAL_PLAN_JSON_SCHEMA.required).toEqual(Object.keys(TRIAL_PLAN_JSON_SCHEMA.properties));
  expect(TRIAL_PLAN_JSON_SCHEMA.additionalProperties).toBe(false);
  expect(TRIAL_PLAN_JSON_SCHEMA.properties.version).toEqual({ const: TRIAL_PLAN_VERSION });
  expect(TRIAL_PLAN_JSON_SCHEMA.properties.matchesPerCandidate).toEqual({
    const: TRIAL_MATCHES_PER_CANDIDATE,
  });
  expect(TRIAL_PLAN_JSON_SCHEMA.properties.matches).toMatchObject({
    type: "array",
    minItems: TRIAL_MATCHES_PER_CANDIDATE,
    maxItems: TRIAL_MATCHES_PER_CANDIDATE,
  });
  expect(TRIAL_PLAN_JSON_SCHEMA.properties.maps).toMatchObject({
    minItems: TRIAL_GRID_MAP_NAMES.length,
    maxItems: TRIAL_GRID_MAP_NAMES.length,
  });
  expect(TRIAL_PLAN_JSON_SCHEMA.properties.scripts).toMatchObject({
    minItems: TRIAL_SPARRING_ROLE_ORDER.length,
    maxItems: TRIAL_SPARRING_ROLE_ORDER.length,
  });
  // 网格的维度：32 = 4 组合 × 4 座位 × 2 图。
  expect(TRIAL_MATCHES_PER_CANDIDATE).toBe(32);
  expect(TRIAL_GRID_MAP_NAMES).toHaveLength(2);
});

it("计划的嵌套形状同样闭合：脚本、地图、场次都不接受额外字段", () => {
  const items = TRIAL_PLAN_JSON_SCHEMA.properties;
  for (const nested of [items.scripts.items, items.maps.items, items.matches.items]) {
    expect(nested.additionalProperties).toBe(false);
    expect(nested.required).toEqual(Object.keys(nested.properties));
  }
  // 座位是定长四元组，候选座位域是 0..3。
  expect(items.matches.items.properties.seats).toMatchObject({ minItems: 4, maxItems: 4 });
  expect(items.matches.items.properties.candidateSeat).toEqual({
    type: "integer",
    minimum: 0,
    maximum: 3,
  });
  // 角色枚举与 TS 联合一致（含历史取值 `benchmark`）。
  expect(items.scripts.items.properties.role).toEqual({ enum: TRIAL_SPARRING_ROLES });
});

it("网格汇总的形状：版本与计划同步、计划内联、逐场身份闭合、分数分母恒等于场数", () => {
  expect(TRIAL_GRID_SUMMARY_VERSION).toBe(TRIAL_PLAN_VERSION);
  expect(TRIAL_GRID_SUMMARY_JSON_SCHEMA.required).toEqual(
    Object.keys(TRIAL_GRID_SUMMARY_JSON_SCHEMA.properties),
  );
  expect(TRIAL_GRID_SUMMARY_JSON_SCHEMA.additionalProperties).toBe(false);
  expect(TRIAL_GRID_SUMMARY_JSON_SCHEMA.properties.version).toEqual({
    const: TRIAL_GRID_SUMMARY_VERSION,
  });
  // 计划原样内联：它的形状就是计划那一份（不另立一份会漂移的拷贝）。
  expect(TRIAL_GRID_SUMMARY_JSON_SCHEMA.properties.plan).toBe(TRIAL_PLAN_JSON_SCHEMA);
  // 分数：总分上界 = 场数 × 每场最高 3 分，均分上界仍是 3，分母恒等于场数。
  const score = TRIAL_GRID_SUMMARY_JSON_SCHEMA.properties.score;
  expect(score.additionalProperties).toBe(false);
  expect(score.required).toEqual(Object.keys(score.properties));
  expect(score.properties.totalPoints).toMatchObject({ maximum: 96 });
  expect(score.properties.averagePoints).toMatchObject({ minimum: 0, maximum: 3 });
  expect(score.properties.countedMatches).toEqual({ const: TRIAL_MATCHES_PER_CANDIDATE });
  expect(TRIAL_GRID_SUMMARY_JSON_SCHEMA.properties.matches).toMatchObject({
    minItems: TRIAL_MATCHES_PER_CANDIDATE,
    maxItems: TRIAL_MATCHES_PER_CANDIDATE,
  });
  const matchItems = TRIAL_GRID_SUMMARY_JSON_SCHEMA.properties.matches.items;
  expect(matchItems.additionalProperties).toBe(false);
  expect(matchItems.required).toEqual(Object.keys(matchItems.properties));
});
