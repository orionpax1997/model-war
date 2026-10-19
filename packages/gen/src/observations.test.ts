/**
 * 试跑观测的路径与严格读取：验证当前候选身份、闭合字段和计数自洽，
 * 并确保缺失的行动事实不会被反馈解释为零。生成历史与固定两次机会归 pipeline seam。
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { ACTION_API_NAMES, ACTION_ERROR_CODES, FAILURE_RECORD_PREFIX } from "@model-war/schema";
import { afterAll, expect, it } from "vitest";

import {
  observationsPathOf,
  readTrialObservations,
  renderScoreSourceFeedback,
} from "./observations.js";
import { terminalSummaryFixture } from "./terminal-summary.fixture.js";

it("落在 archive/<slug>/ 下,与三件套目录、失败记录同一层(不在 <runId>/ 里)", () => {
  expect(observationsPathOf("/install", "alpha", "2026-01-01T00-00-00-000Z")).toBe(
    join("/install", "archive", "alpha", "observed-2026-01-01T00-00-00-000Z.jsonl"),
  );
});

it("前缀与后缀都让报告侧「只扫 failed-*.json」那条过滤器扫不到它", () => {
  // 报告侧按 `failed-` 前缀 + `.json` 后缀挑失败记录(`packages/runner/src/reporter.ts`);
  // 两个特征各错开一个,新增旁挂文件就不会被那条过滤器误当成失败记录。
  const name = basename(observationsPathOf("/install", "alpha", "r1"));
  expect(name.startsWith(FAILURE_RECORD_PREFIX)).toBe(false);
  expect(name.endsWith(".json")).toBe(false);
});

it("纯路径计算:调用它不建目录也不落文件(写盘是入口那一侧的事)", () => {
  const root = mkdtempSync(`${tmpdir()}/modelwar-gen-observations-`);
  const path = observationsPathOf(root, "alpha", "r1");
  expect(existsSync(path)).toBe(false);
  expect(existsSync(join(root, "archive", "alpha"))).toBe(false);
});

const actionScratch = mkdtempSync(`${tmpdir()}/modelwar-action-reading-`);
afterAll(() => rmSync(actionScratch, { recursive: true, force: true }));
const candidateHash = "a".repeat(64);
const completeActionReading = () => ({
  matchIndex: 0,
  delivered: 0,
  captures: 0,
  noScoreSource: true,
  actionFacts: {
    version: 1,
    scriptSha256: candidateHash,
    seed: 101,
    seat: 0,
    complete: true,
    observedTicks: 2,
    missingTicks: 0,
    calls: { move: 0, moveTo: 0, attack: 0, harvest: 0, transfer: 0, spawnUnit: 0 },
    errors: Object.fromEntries(
      ACTION_API_NAMES.map((name) => [
        name,
        Object.fromEntries(ACTION_ERROR_CODES.map((code) => [code, 0])),
      ]),
    ),
    effects: {
      movedSteps: 0,
      harvestedAmount: 0,
      deliveredAmount: 0,
      captureEvents: 0,
      productionOrdersStarted: 0,
    },
  },
});

it("行动事实不能声称零个已观测执行tick却有已观测调用", () => {
  const reading = completeActionReading();
  reading.actionFacts.observedTicks = 0;
  reading.actionFacts.calls.harvest = 1;
  const path = join(actionScratch, "impossible-coverage.jsonl");
  writeFileSync(path, JSON.stringify(reading) + "\n");
  expect(() => readTrialObservations(path, candidateHash)).toThrow("行动事实协议");
});

it.each<[string, Record<string, unknown>]>([
  ["其他候选hash", { scriptSha256: "b".repeat(64) }],
  ["错误seed", { seed: 202 }],
  ["错误座位", { seat: 1 }],
  ["未知版本", { version: 2 }],
  ["额外诊断字段", { coordinates: [12, 34] }],
  ["负计数", { observedTicks: -1 }],
  ["非整数计数", { observedTicks: 1.5 }],
  ["不安全整数", { observedTicks: Number.MAX_SAFE_INTEGER + 1 }],
  ["不完整却标记完整", { missingTicks: 1 }],
  ["完整却标记不完整", { complete: false }],
  ["动作字段缺失", { calls: { harvest: 0 } }],
  [
    "错误数大于调用数",
    {
      errors: {
        ...completeActionReading().actionFacts.errors,
        harvest: { ...completeActionReading().actionFacts.errors.harvest, ERR_INVALID_SITE: 1 },
      },
    },
  ],
  [
    "未知错误码",
    {
      errors: {
        ...completeActionReading().actionFacts.errors,
        harvest: { ...completeActionReading().actionFacts.errors.harvest, ERR_UNKNOWN: 0 },
      },
    },
  ],
  [
    "结算效果额外字段",
    {
      effects: {
        ...completeActionReading().actionFacts.effects,
        cause: "blocked",
      },
    },
  ],
])("正式读取拒绝行动事实违约：%s", (name, overrides) => {
  const reading = completeActionReading();
  const path = join(actionScratch, `${name}.jsonl`);
  writeFileSync(
    path,
    JSON.stringify({
      ...reading,
      actionFacts: { ...reading.actionFacts, ...overrides },
    }) + "\n",
  );
  expect(() => readTrialObservations(path, candidateHash)).toThrow("行动事实协议");
});

it("不完整事实仍可读，但反馈不把未观测行动写成零或发送部分计数", () => {
  const reading = completeActionReading();
  reading.actionFacts.complete = false;
  reading.actionFacts.missingTicks = 1;
  reading.actionFacts.calls.harvest = 17;
  const path = join(actionScratch, "partial.jsonl");
  writeFileSync(path, JSON.stringify(reading) + "\n");
  const readings = readTrialObservations(path, candidateHash);
  expect(readings).toHaveLength(1);
  const feedback = renderScoreSourceFeedback(readings ?? []);
  expect(feedback).toContain("行动事实不完整");
  expect(feedback).toContain("缺失 tick=1");
  expect(feedback).not.toContain("harvest：调用");
  expect(feedback).not.toContain("harvestedAmount=");
});

it("读取完整保留真实终局与行动身份，行动不完整不抹去已完成成绩", () => {
  const reading = completeActionReading();
  reading.actionFacts.complete = false;
  reading.actionFacts.missingTicks = 1;
  const terminalSummary = terminalSummaryFixture();
  const path = join(actionScratch, "terminal-completed.jsonl");
  writeFileSync(path, JSON.stringify({ ...reading, terminalSummary }) + "\n");
  const readings = readTrialObservations(path, candidateHash);
  expect(readings).toEqual([{ ...reading, terminalSummary }]);
  const feedback = renderScoreSourceFeedback(readings ?? []);
  expect(feedback).toContain("行动事实不完整");
  expect(feedback).toContain("终局事实：seed=101，已执行 tick=1，结束原因=timeout");
  expect(feedback.match(/领土分=6，名次=1，名次积分=1.5/g)).toHaveLength(4);
});

it.each<[string, unknown]>([
  ["null", null],
  ["部分摘要", { seed: 101 }],
  ["与matchIndex/行动事实seed错配", terminalSummaryFixture(202)],
  [
    "伪造计分",
    {
      ...terminalSummaryFixture(),
      players: [
        { ...terminalSummaryFixture().players[0], territoryScore: 99 },
        ...terminalSummaryFixture().players.slice(1),
      ],
    },
  ],
  [
    "伪造并列积分",
    {
      ...terminalSummaryFixture(),
      players: [
        { ...terminalSummaryFixture().players[0], rankPoints: 3 },
        ...terminalSummaryFixture().players.slice(1),
      ],
    },
  ],
  ["上游原文", { ...terminalSummaryFixture(), providerRaw: "HOST_SECRET" }],
  [
    "嵌套额外字段",
    {
      ...terminalSummaryFixture(),
      weights: { ...terminalSummaryFixture().weights, sourceText: "HOST_SECRET" },
    },
  ],
])("观测读取严格拒绝终局违约且不输出原文：%s", (_name, terminalSummary) => {
  const path = join(actionScratch, "terminal-invalid.jsonl");
  writeFileSync(path, JSON.stringify({ ...completeActionReading(), terminalSummary }) + "\n");
  expect(() => readTrialObservations(path, candidateHash)).toThrow(/试跑观测协议/);
  try {
    readTrialObservations(path, candidateHash);
  } catch (error) {
    expect(String(error)).not.toContain("HOST_SECRET");
  }
});

it("反馈展示四方完整计分依据与真实淘汰残留，不推断策略或泄漏额外原文", () => {
  const terminalSummary = terminalSummaryFixture();
  terminalSummary.tick = 10;
  Object.assign(terminalSummary.players[0], {
    alive: false,
    eliminatedAtTick: 0,
    controlledBases: 0,
    controlledResources: 0,
    survivingUnits: { worker: 0, melee: 0, ranged: 0, cavalry: 2 },
    survivingUnitCost: 32,
    score: { bases: 0, resources: 0, units: 5 },
    territoryScore: 5,
    rank: 4,
    rankPoints: 0,
  });
  for (const player of terminalSummary.players.slice(1)) {
    player.rank = 1;
    player.rankPoints = 2;
  }
  const feedback = renderScoreSourceFeedback([
    { matchIndex: 0, delivered: 0, captures: 0, noScoreSource: true, terminalSummary },
  ]);
  expect(feedback).toContain("计分权重：基地=4，资源点=1，单位造价除数=6");
  expect(feedback).toContain(
    "单位造价：worker=4，melee=8，ranged=12，cavalry=16；名次积分表=3 / 2 / 1 / 0",
  );
  expect(feedback).toContain(
    "座位=0，身份=candidate，控制基地=0，控制资源点=0，存活单位：worker=0，melee=0，ranged=0，cavalry=2；存活单位总造价=32，基地分=0，资源点分=0，单位分=5，领土分=5，名次=4，名次积分=0，存活=false，淘汰 tick=0",
  );
  for (const [seat, player] of [
    "cell-a-melee-pressure",
    "cell-b-expansion-economy",
    "cell-c-claim-no-harvest",
  ].entries()) {
    expect(feedback).toContain(
      `座位=${seat + 1}，身份=${player}，控制基地=1，控制资源点=1，存活单位：worker=2，melee=0，ranged=0，cavalry=0；存活单位总造价=8，基地分=4，资源点分=1，单位分=1，领土分=6，名次=1，名次积分=2，存活=true，淘汰 tick=无`,
    );
  }
  expect(feedback).not.toMatch(/请检查|建议|应该|坐标|策略诊断/);
});

it("旧观测终局缺失明确未知，反馈直接接收不可信摘要也不补零或泄漏", () => {
  const reading = { matchIndex: 0, delivered: 0, captures: 0, noScoreSource: true };
  const path = join(actionScratch, "terminal-legacy.jsonl");
  writeFileSync(path, JSON.stringify(reading) + "\n");
  expect(readTrialObservations(path, candidateHash)).toEqual([reading]);
  const invalid = terminalSummaryFixture();
  invalid.players[1].player = "HOST_SECRET";
  for (const value of [reading, { ...reading, terminalSummary: invalid }]) {
    const feedback = renderScoreSourceFeedback([value]);
    expect(feedback).toContain("终局成绩未知");
    expect(feedback).not.toMatch(/领土分=|名次=|HOST_SECRET/);
  }
});
