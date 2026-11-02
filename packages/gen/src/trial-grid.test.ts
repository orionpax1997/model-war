/**
 * 网格汇总（`<观测文件>.grid.json`）的读入：形状、候选身份、与 expected plan 逐字相同。
 *
 * 断言对象是**外部可观察行为**：同一份计划写出去再读回来通过；换候选摘要、换计划里的任一处
 * （图/座位/种子/陪练）、换逐场身份、缺文件、坏 JSON、多一个字段，都被拒。不跑对局。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, it } from "vitest";
import {
  TRIAL_GRID_SUMMARY_SUFFIX,
  type TrialGridSummary,
  type TrialPlan,
} from "@model-war/schema";

import { gridSummaryPathOf, readTrialGridSummary } from "./trial-grid.js";
import { gridPlanFixture } from "./trial-plan.fixture.js";

const scratch = mkdtempSync(`${tmpdir()}/modelwar-gen-grid-`);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const plan = gridPlanFixture();
const scriptSha256 = "a".repeat(64);

/** 执行器会写出来的那一份汇总（计划的投影；分数不在这里）。 */
const summaryOf = (overrides: Partial<TrialGridSummary> = {}): TrialGridSummary => ({
  version: 2,
  plan,
  scriptSha256,
  matches: plan.matches.map((match) => ({
    matchIndex: match.matchIndex,
    seed: match.seed,
    candidateSeat: match.candidateSeat,
    map: match.map,
    mapSha256: match.mapSha256,
  })),
  ...overrides,
});

const written = (value: unknown): string => {
  const path = join(
    mkdtempSync(join(scratch, "obs-")),
    `observed-r1.jsonl${TRIAL_GRID_SUMMARY_SUFFIX}`,
  );
  writeFileSync(path, JSON.stringify(value));
  return path;
};

const read = (path: string, expectedPlan: TrialPlan = plan): TrialGridSummary =>
  readTrialGridSummary({ path, expectedPlan, scriptSha256 });

it("路径约定：汇总就在观测文件旁边（同目录、同前缀 + .grid.json）", () => {
  expect(gridSummaryPathOf("/install/archive/alpha/observed-r1.jsonl")).toBe(
    "/install/archive/alpha/observed-r1.jsonl.grid.json",
  );
});

it("正例：执行器写的汇总原样读回（计划、候选摘要、32 场身份）", () => {
  expect(read(written(summaryOf()))).toEqual(summaryOf());
});

it("换一份候选（摘要不符）即拒：这 32 场说的不是这份脚本", () => {
  expect(() => read(written(summaryOf({ scriptSha256: "b".repeat(64) })))).toThrow(
    /另一份候选脚本/,
  );
});

it.each<[string, (value: TrialGridSummary) => TrialGridSummary]>([
  [
    "换图（计划与逐场身份一起改）",
    (value) => ({
      ...value,
      plan: { ...plan, maps: [{ ...plan.maps[0]!, name: "open-clash" }, plan.maps[1]!] },
    }),
  ],
  [
    "换座位",
    (value) => ({
      ...value,
      plan: {
        ...plan,
        matches: plan.matches.map((match, index) =>
          index === 0 ? { ...match, candidateSeat: 1 } : match,
        ),
      },
    }),
  ],
  [
    "换种子",
    (value) => ({
      ...value,
      plan: {
        ...plan,
        matches: plan.matches.map((match, index) =>
          index === 1 ? { ...match, seed: 999 } : match,
        ),
      },
    }),
  ],
  [
    "换一份陪练摘要",
    (value) => ({
      ...value,
      plan: {
        ...plan,
        scripts: plan.scripts.map((script, index) =>
          index === 2 ? { ...script, scriptSha256: "c".repeat(64) } : script,
        ),
      },
    }),
  ],
])("计划与 expected plan 不同源即拒：%s", (_name, corrupt) => {
  expect(() => read(written(corrupt(summaryOf())))).toThrow(/expected plan 不同源/);
});

it("逐场身份与计划不一致即拒（plan 对得上但 matches 被改）", () => {
  const corrupted = summaryOf({
    matches: summaryOf().matches.map((match, index) =>
      index === 3 ? { ...match, seed: 7777 } : match,
    ),
  });
  expect(() => read(written(corrupted))).toThrow(/逐场身份与计划不一致/);
});

it("缺文件、坏 JSON、缺字段、额外字段都拒（缺失不当成零场）", () => {
  expect(() => read(join(scratch, "missing.jsonl.grid.json"))).toThrow(/读不到/);
  const broken = join(mkdtempSync(join(scratch, "broken-")), "observed-r1.jsonl.grid.json");
  writeFileSync(broken, "{not json");
  expect(() => read(broken)).toThrow(/不是合法 JSON/);
  const { matches, ...withoutMatches } = summaryOf();
  void matches;
  expect(() => read(written(withoutMatches))).toThrow(/形状不合法/);
  expect(() => read(written({ ...summaryOf(), score: { totalPoints: 0 } }))).toThrow(/形状不合法/);
  expect(() =>
    read(written({ ...summaryOf(), matches: summaryOf().matches.slice(0, 31) })),
  ).toThrow(/形状不合法/);
});
