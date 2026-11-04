/**
 * 试跑观测的路径与严格读取：验证当前候选身份、闭合字段和计数自洽，
 * 并确保缺失的行动事实不会被反馈解释为零。生成历史与固定两次机会归 pipeline seam。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  ACTION_API_NAMES,
  ACTION_ERROR_CODES,
  FAILURE_RECORD_PREFIX,
  TRIAL_BENCHMARK_IDS,
  TRIAL_PLAYER_IDS,
  type TrialActionFacts,
  type TrialObservationLine,
  type TrialPlan,
  type TrialPlanMatch,
  type TrialPlanScript,
  type TrialTerminalSummary,
} from "@model-war/schema";
import { afterAll, expect, it } from "vitest";

import {
  observationsPathOf,
  readTrialObservations,
  renderScoreSourceFeedback,
} from "./observations.js";
import { terminalSummaryFixture } from "./terminal-summary.fixture.js";
import { fixtureScripts, gridPlanFixture } from "./trial-plan.fixture.js";

/** 网格计划的第一场：观测行里的种子/候选座位与终局四方身份都按它给期望。 */
const plan = gridPlanFixture();
const match = plan.matches[0]!;
const summaryFixture = (seed: number = match.seed) =>
  terminalSummaryFixture(seed, "timeout", match.seats);

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
    seed: match.seed,
    seat: match.candidateSeat,
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
  expect(() => readTrialObservations(path, candidateHash, plan)).toThrow("行动事实协议");
});

it.each<[string, Record<string, unknown>]>([
  ["其他候选hash", { scriptSha256: "b".repeat(64) }],
  ["错误seed", { seed: match.seed + 1 }],
  ["错误座位", { seat: (match.candidateSeat + 1) % 4 }],
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
  expect(() => readTrialObservations(path, candidateHash, plan)).toThrow("行动事实协议");
});

it("不完整事实仍可读，但反馈不把未观测行动写成零或发送部分计数", () => {
  const reading = completeActionReading();
  reading.actionFacts.complete = false;
  reading.actionFacts.missingTicks = 1;
  reading.actionFacts.calls.harvest = 17;
  const path = join(actionScratch, "partial.jsonl");
  writeFileSync(path, JSON.stringify(reading) + "\n");
  const readings = readTrialObservations(path, candidateHash, plan);
  expect(readings).toHaveLength(1);
  const feedback = renderScoreSourceFeedback(readings ?? [], plan);
  expect(feedback).toContain("行动事实不完整");
  expect(feedback).toContain("缺失 tick=1");
  expect(feedback).not.toContain("harvest：调用");
  expect(feedback).not.toContain("harvestedAmount=");
});

it("读取完整保留真实终局与行动身份，行动不完整不抹去已完成成绩", () => {
  const reading = completeActionReading();
  reading.actionFacts.complete = false;
  reading.actionFacts.missingTicks = 1;
  const terminalSummary = summaryFixture();
  const path = join(actionScratch, "terminal-completed.jsonl");
  writeFileSync(path, JSON.stringify({ ...reading, terminalSummary }) + "\n");
  const readings = readTrialObservations(path, candidateHash, plan);
  expect(readings).toEqual([{ ...reading, terminalSummary }]);
  const feedback = renderScoreSourceFeedback(readings ?? [], plan);
  expect(feedback).toContain("行动事实不完整");
  expect(feedback).toContain(
    `终局事实：seed=${String(match.seed)}，已执行 tick=1，结束原因=timeout`,
  );
  expect(feedback.match(/领土分=6，名次=1，名次积分=1.5/g)).toHaveLength(4);
});

it.each<[string, unknown]>([
  ["null", null],
  ["部分摘要", { seed: 101 }],
  ["与计划给的seed错配", summaryFixture(match.seed + 1)],
  [
    "伪造计分",
    {
      ...summaryFixture(),
      players: [
        { ...summaryFixture().players[0], territoryScore: 99 },
        ...summaryFixture().players.slice(1),
      ],
    },
  ],
  [
    "伪造并列积分",
    {
      ...summaryFixture(),
      players: [
        { ...summaryFixture().players[0], rankPoints: 3 },
        ...summaryFixture().players.slice(1),
      ],
    },
  ],
  ["上游原文", { ...summaryFixture(), providerRaw: "HOST_SECRET" }],
  [
    "嵌套额外字段",
    {
      ...summaryFixture(),
      weights: { ...summaryFixture().weights, sourceText: "HOST_SECRET" },
    },
  ],
])("观测读取严格拒绝终局违约且不输出原文：%s", (_name, terminalSummary) => {
  const path = join(actionScratch, "terminal-invalid.jsonl");
  writeFileSync(path, JSON.stringify({ ...completeActionReading(), terminalSummary }) + "\n");
  expect(() => readTrialObservations(path, candidateHash, plan)).toThrow(/试跑观测协议/);
  try {
    readTrialObservations(path, candidateHash, plan);
  } catch (error) {
    expect(String(error)).not.toContain("HOST_SECRET");
  }
});

it("反馈展示四方完整计分依据与真实淘汰残留，不推断策略或泄漏额外原文", () => {
  const terminalSummary = summaryFixture();
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
  const feedback = renderScoreSourceFeedback(
    [{ matchIndex: 0, delivered: 0, captures: 0, noScoreSource: true, terminalSummary }],
    plan,
  );
  expect(feedback).toContain("计分权重：基地=4，资源点=1，单位造价除数=6");
  expect(feedback).toContain(
    "单位造价：worker=4，melee=8，ranged=12，cavalry=16；名次积分表=3 / 2 / 1 / 0",
  );
  expect(feedback).toContain(
    "座位=0，身份=candidate，控制基地=0，控制资源点=0，存活单位：worker=0，melee=0，ranged=0，cavalry=2；存活单位总造价=32，基地分=0，资源点分=0，单位分=5，领土分=5，名次=4，名次积分=0，存活=false，淘汰 tick=0",
  );
  for (const [seat, player] of match.seats.slice(1).entries()) {
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
  expect(readTrialObservations(path, candidateHash, plan)).toEqual([reading]);
  const invalid = summaryFixture();
  invalid.players[1].player = "HOST_SECRET";
  for (const value of [reading, { ...reading, terminalSummary: invalid }]) {
    const feedback = renderScoreSourceFeedback([value], plan);
    expect(feedback).toContain("终局成绩未知");
    expect(feedback).not.toMatch(/领土分=|名次=|HOST_SECRET/);
  }
});

// ── 三层反馈（对差表 / 逐场一行 / 最差三场）─────────────────────────────────

/**
 * 四方领土分由调用方给的终局：名次与名次积分按领土分降序推出（timeout、四方都活着）。
 *
 * 构造时保证 `领土分 = 基地×4 + 资源点×1 + 单位分`（两个 worker = 8 造价 → 单位分 1），
 * 于是它经得起终局读入端的同一套跨字段校验——反馈里的数字不会因夹具宽松而失真。
 */
const rankedSummary = (
  seed: number,
  seats: readonly [string, string, string, string],
  territories: readonly [number, number, number, number],
): TrialTerminalSummary => {
  const units = 1;
  const order = [...territories].sort((left, right) => right - left);
  return {
    version: 1,
    seed,
    tick: 1,
    reason: "timeout",
    weights: { baseScore: 4, resourceScore: 1, unitCostDivisor: 6 },
    unitCosts: { worker: 4, melee: 8, ranged: 12, cavalry: 16 },
    rankPoints: [3, 2, 1, 0],
    players: territories.map((territory, seat) => {
      const rest = territory - units;
      const bases = rest >= 4 ? 1 : 0;
      const resources = rest - bases * 4;
      const rank = order.indexOf(territory) + 1;
      return {
        seat: seat as 0 | 1 | 2 | 3,
        player: seats[seat]!,
        controlledBases: bases,
        controlledResources: resources,
        survivingUnits: { worker: 2, melee: 0, ranged: 0, cavalry: 0 },
        survivingUnitCost: 8,
        score: { bases: bases * 4, resources, units },
        territoryScore: territory,
        rank,
        rankPoints: [3, 2, 1, 0][rank - 1]!,
        alive: true,
        eliminatedAtTick: null,
      };
    }) as unknown as TrialTerminalSummary["players"],
  };
};

/** 每格一条读数的整张网格：四方领土分按座位给（候选的名次随它在哪个座位而变）。 */
const gridReadingsOf = (
  gridPlan: TrialPlan,
  pick: (index: number) => readonly [number, number, number, number],
): TrialObservationLine[] =>
  gridPlan.matches.map((each, index) => ({
    matchIndex: each.matchIndex,
    delivered: 0,
    captures: 0,
    noScoreSource: true,
    terminalSummary: rankedSummary(each.seed, each.seats, pick(index)),
  }));

/** 去掉终局（`exactOptionalPropertyTypes` 下不能用 `undefined` 覆写可选键）。 */
const withoutTerminal = (reading: TrialObservationLine): TrialObservationLine => ({
  matchIndex: reading.matchIndex,
  delivered: reading.delivered,
  captures: reading.captures,
  noScoreSource: reading.noScoreSource,
  ...(reading.actionFacts === undefined ? {} : { actionFacts: reading.actionFacts }),
});

/** 去掉行动事实，保留终局。 */
const withoutActions = (reading: TrialObservationLine): TrialObservationLine => ({
  matchIndex: reading.matchIndex,
  delivered: reading.delivered,
  captures: reading.captures,
  noScoreSource: reading.noScoreSource,
  ...(reading.terminalSummary === undefined ? {} : { terminalSummary: reading.terminalSummary }),
});

const SECTION_DIFF = "一、对差表";
const SECTION_MATCHES = "二、逐场一行";
const SECTION_WORST = "三、最差三场";
const cellLines = (feedback: string): string[] =>
  feedback.split("\n").filter((line) => /^ {2}座位\d \/ /.test(line));
const matchLines = (feedback: string): string[] =>
  feedback.split("\n").filter((line) => /^ {2}#\d{2} \| /.test(line));
const detailLines = (feedback: string): string[] =>
  feedback.split("\n").filter((line) => line.startsWith("- 第 "));
/** 最差三场展开的场次（1 起，与「第 N 个对局」一致）。 */
const detailIndexes = (feedback: string): number[] =>
  detailLines(feedback).map((line) => Number(/^- 第 (\d+) 个对局/.exec(line)?.[1]));

it("三层结构：对差表 8 格（座位 × 地图）+ 逐场一行 = 计划场数 + 只展开最差三场", () => {
  const gridPlan = gridPlanFixture();
  const feedback = renderScoreSourceFeedback(
    gridReadingsOf(gridPlan, () => [93, 58, 14, 10]),
    gridPlan,
  );

  expect(feedback).toContain("试跑观测：本候选实际完成的 32 个对局。");
  expect(feedback).toContain(SECTION_DIFF);
  expect(feedback).toContain(SECTION_MATCHES);
  expect(feedback).toContain(SECTION_WORST);

  // 对差表：4 座位 × 2 图 = 8 行，行序先座位后地图（与计划的地图序一致）。
  const cells = cellLines(feedback);
  expect(cells).toHaveLength(8);
  expect(cells.map((line) => line.slice(2, line.indexOf("：")))).toEqual([
    "座位0 / corridor-split",
    "座位0 / open-clash",
    "座位1 / corridor-split",
    "座位1 / open-clash",
    "座位2 / corridor-split",
    "座位2 / open-clash",
    "座位3 / corridor-split",
    "座位3 / open-clash",
  ]);
  // 每格都带与上一阶段的对照列；首轮没有上一阶段就明写，而不是留空或按 0 算。
  for (const cell of cells) expect(cell).toContain("与上一阶段同一格：无上一阶段。");
  // 每格的聚合事实：4 局一格的均值与末位局数（候选在 0 号位时领土分 93 居首）。
  expect(cells[0]).toContain(
    "座位0 / corridor-split：4 局，平均名次 1.00，平均名次积分 3.00，平均领土分 93.00（第一名 93.00，分差 0.00），末位 0 局",
  );

  // 逐场一行：一行一场，行数 = 计划场数；每行都是「图、座位、组合、名次、四方领土分、结束原因」。
  const rows = matchLines(feedback);
  expect(rows).toHaveLength(gridPlan.matches.length);
  expect(rows[0]).toBe(
    "  #00 | corridor-split | 座位0 | 组合0（轮空 top:alpha） | 1 | 93/58/14/10 | timeout",
  );
  expect(rows[31]).toBe(
    "  #31 | open-clash | 座位1 | 组合3（轮空 incumbent:delta） | 2 | 93/58/14/10 | timeout",
  );

  // 最差三场：候选在 3 号位（领土分 10）的场次最差，八场并列 → 按场次定序取前三。
  expect(detailLines(feedback)).toHaveLength(3);
  expect(detailIndexes(feedback)).toEqual([3, 4, 11]);

  // 缩小网格：对差表只铺计划里实际出现的格，不凭空补齐 4 × 2。
  const reduced: TrialPlan = {
    ...gridPlan,
    matchesPerCandidate: 2,
    matches: gridPlan.matches.slice(0, 2),
  };
  const reducedText = renderScoreSourceFeedback(
    gridReadingsOf(reduced, () => [93, 58, 14, 10]),
    reduced,
  );
  expect(cellLines(reducedText).map((line) => line.slice(2, line.indexOf("：")))).toEqual([
    "座位0 / corridor-split",
    "座位0 / open-clash",
  ]);
  expect(matchLines(reducedText)).toHaveLength(2);
});

it("对差表的同格变化按阶段给：Δ = 本阶段 − 上一阶段（含方向与符号）", () => {
  const gridPlan = gridPlanFixture();
  const current = gridReadingsOf(gridPlan, () => [93, 58, 14, 10]);
  const previous = gridReadingsOf(gridPlan, () => [58, 93, 12, 9]);
  const feedback = renderScoreSourceFeedback(current, gridPlan, previous);
  const cellOf = (seat: number, map: string): string =>
    feedback.split("\n").find((line) => line.startsWith(`  座位${String(seat)} / ${map}：`)) ?? "";

  // 座位0：上一阶段 58 分排第 2（与第一名差 35），本阶段 93 分排第 1（差 0）→ 积分 +1、分差 −35。
  expect(cellOf(0, "corridor-split")).toContain("平均名次积分 3.00");
  expect(cellOf(0, "corridor-split")).toContain("Δ平均名次积分 +1.00，Δ分差 -35.00");
  // 座位1 反过来：积分 −1、分差 +35（差距扩大）。
  expect(cellOf(1, "open-clash")).toContain("Δ平均名次积分 -1.00，Δ分差 +35.00");
  // 每个格都带变化，不只是其中一格。
  expect(feedback.match(/与上一阶段同一格：Δ平均名次积分 [+-]/g)).toHaveLength(8);

  // 没有上一阶段（第一次回喂）：八格都写「无上一阶段」，全文不出现 Δ。
  const first = renderScoreSourceFeedback(current, gridPlan);
  expect(first.match(/与上一阶段同一格：无上一阶段。/g)).toHaveLength(8);
  expect(first).not.toContain("Δ平均名次积分");
});

it("最差三场顺序确定：先名次积分升序、再领土分升序、最后场次升序（改输入顺序结果不变）", () => {
  const gridPlan = gridPlanFixture();
  // 前两组让候选在 3 号位的领土分分别为 10 与 14（都排在末位），于是最差三场先按领土分、
  // 再按场次定序：领土分 10 的有 #2/#3/#18/#19，取前三个场次。
  const variants: readonly (readonly [number, number, number, number])[] = [
    [93, 58, 14, 10],
    [93, 58, 20, 14],
    [93, 58, 14, 10],
    [93, 58, 20, 14],
  ];
  const readings = gridReadingsOf(gridPlan, (index) => variants[Math.floor(index / 8) % 4]!);
  const forward = renderScoreSourceFeedback(readings, gridPlan);
  expect(detailIndexes(forward)).toEqual([3, 4, 19]);
  // 输入顺序（读数数组的顺序）不影响任何一层：对差表、逐场行、最差三场都逐字相同。
  expect(renderScoreSourceFeedback([...readings].reverse(), gridPlan)).toBe(forward);
  expect(
    renderScoreSourceFeedback(
      [...readings].sort(() => 1),
      gridPlan,
    ),
  ).toBe(forward);
});

it("覆盖缺失单独说明、不补零：缺终局的格不给平均，逐场行与明细都写未知", () => {
  const gridPlan = gridPlanFixture();
  const full = gridReadingsOf(gridPlan, () => [93, 58, 14, 10]);
  // 第 0 场（座位0 / corridor-split 的一格）缺终局：其余三局仍进平均，覆盖缺口单独说。
  const partial = full.map((reading) =>
    reading.matchIndex === 0 ? withoutTerminal(reading) : reading,
  );
  const feedback = renderScoreSourceFeedback(partial, gridPlan);
  expect(cellLines(feedback)[0]).toContain(
    "平均领土分 93.00（第一名 93.00，分差 0.00），末位 0 局（终局已知 3/4 局）",
  );
  expect(matchLines(feedback)[0]).toBe(
    "  #00 | corridor-split | 座位0 | 组合0（轮空 top:alpha） | 未知 | 未知 | 未知",
  );
  // 终局未知的场次不进最差三场排序，也不当作零分。
  expect(detailIndexes(feedback)).toEqual([3, 4, 11]);

  // 全部缺终局：每格都写明「终局未知、未将缺失解释为零」，没有任何平均数字。
  const stripped = full.map(withoutTerminal);
  const unknown = renderScoreSourceFeedback(stripped, gridPlan);
  expect(unknown).toContain(
    "覆盖：计划 32 场，读数 32 场，终局可用 0 场；行动事实完整 0 场，缺失 32 场（#00 / #01 / #02 / #03 / #04 … 共 32 场），不完整 0 场；缺失一律不补零。",
  );
  for (const cell of cellLines(unknown))
    expect(cell).toContain("终局未知，未将缺失解释为零，不报告平均名次与平均领土分");
  expect(unknown).not.toMatch(/平均名次 \d|平均领土分 \d|分差 \d/);
  expect(unknown.match(/终局成绩未知（缺少有效终局事实），未将缺失解释为零。/g)).toHaveLength(3);

  // 缺行动事实与行动事实不完整照旧如实说明（沿用既有文案的语义）。
  const noActions = renderScoreSourceFeedback(full.map(withoutActions), gridPlan);
  expect(noActions.match(/行动事实缺失，未将缺失解释为零。/g)).toHaveLength(3);
  // 全文不给因果结论与策略建议。
  for (const text of [feedback, unknown, noActions])
    expect(text).not.toMatch(/请检查|建议|应该|坐标|策略诊断|因为|导致/);
});

// ── 陪练池身份、代位与镜像标注（spec：反馈必须写明跟谁打、代位、字节相同）─────────

it("反馈写明陪练池身份与代位：角色、role:slug、装载来源，代位时明写「本阶段以 X 代位」", () => {
  // 生产口径的四份身份 + 在位代位（`source` 的 `#substitute` 后缀就是代位的唯一标记）。
  const scripts = productionScripts.map((script, index) =>
    index === 3 ? { ...script, source: `${script.source}#substitute` } : script,
  );
  const gridPlan = gridPlanFixture(scripts);
  const feedback = renderScoreSourceFeedback(
    gridReadingsOf(gridPlan, () => [93, 58, 14, 10]),
    gridPlan,
  );
  expect(feedback).toContain("陪练池（本阶段的对手；每个组合轮空其中一份）：");
  // 四份身份都要能被读出来（角色、id、来源），不是只写「四个对手」。
  expect(feedback).toContain("  榜首 top:claude-opus-5-5 ← archive:claude-opus-5-5/r1");
  expect(feedback).toContain("  中位 mid:minimax-m3.1-flash ← archive:minimax-m3.1-flash/r2");
  expect(feedback).toContain("  末位 last:glm-5.3-flash ← archive:glm-5.3-flash/r3");
  // 代位是来源而不是另一个角色：反馈据此明写代位，而且只说一次。
  expect(feedback).toContain(
    "  在位 incumbent:muse-spark-1.3-contributor ← archive:muse-spark-1.3-contributor/r4#substitute；本阶段以 muse-spark-1.3-contributor 代位",
  );
  expect(feedback.match(/本阶段以 .* 代位/g)).toHaveLength(1);

  // 没代位的计划（来源不带后缀）不写代位，其余身份照列。
  const ownIncumbent = fixtureScripts.map((script) => ({
    ...script,
    source: script.source.replace("#substitute", ""),
  }));
  const ownPlan = gridPlanFixture(ownIncumbent);
  const own = renderScoreSourceFeedback(
    gridReadingsOf(ownPlan, () => [93, 58, 14, 10]),
    ownPlan,
  );
  expect(own).toContain("  在位 incumbent:delta ← archive:delta/r4");
  expect(own).not.toContain("代位");
});

it("候选与某位陪练字节相同时逐场标注「本场对手与你字节相同」，轮空该份的场次不标", () => {
  const gridPlan = gridPlanFixture();
  const readings = gridReadingsOf(gridPlan, () => [93, 58, 14, 10]);
  // 候选字节 = 夹具里 `last:gamma` 的摘要（`scripts[2]` 的摘要就是 "3" × 64）。
  const mirrored = fixtureScripts[2]!.scriptSha256;
  const feedback = renderScoreSourceFeedback(readings, gridPlan, undefined, mirrored);
  const marked = matchLines(feedback).filter((line) => line.includes("本场对手与你字节相同"));
  // 每次轮空一份（comboIndex = 2 的那一组共 8 场），其余 24 场都有 gamma 在场。
  expect(marked).toHaveLength(24);
  expect(marked.every((line) => !line.includes("组合2（"))).toBe(true);
  // 逐场可辨：轮空 gamma 的那八场逐字不带这一句，别的场都带。
  for (const line of matchLines(feedback)) {
    expect(line.includes("本场对手与你字节相同")).toBe(!line.includes("组合2（"));
  }
  // 表头解释这句话怎么读（镜像局是确定性重演，照跑）。
  expect(feedback).toContain(
    "「本场对手与你字节相同」= 候选编译产物与该场某位对手的脚本摘要相同，镜像局照跑",
  );
  // 字节无从得知（未给候选摘要）就不标注：不拿名字或分数猜（表头那句解释不算逐场标注）。
  expect(
    matchLines(renderScoreSourceFeedback(readings, gridPlan)).some((line) =>
      line.includes("本场对手与你字节相同"),
    ),
  ).toBe(false);
});

/** 一场的行动事实（与执行器写出的形状同构：seed / 座位按计划给）。 */
const actionFactsAt = (each: TrialPlanMatch, complete = true): TrialActionFacts =>
  ({
    ...completeActionReading().actionFacts,
    version: 1,
    scriptSha256: candidateHash,
    seed: each.seed,
    seat: each.candidateSeat,
    complete,
    observedTicks: complete ? 5 : 3,
    missingTicks: complete ? 0 : 2,
  }) as TrialActionFacts;

it("行动事实覆盖按全网格声明：完整/缺失/不完整的场数与被点名的场次，不只最差三场", () => {
  const gridPlan = gridPlanFixture();
  const base = gridReadingsOf(gridPlan, () => [93, 58, 14, 10]);
  // #02 没有行动事实、#05 行动事实不完整，其余 30 场完整。
  const readings = base.map((reading) => {
    const each = gridPlan.matches[reading.matchIndex]!;
    if (reading.matchIndex === 2) return reading;
    return { ...reading, actionFacts: actionFactsAt(each, reading.matchIndex !== 5) };
  });
  const feedback = renderScoreSourceFeedback(readings, gridPlan);
  expect(feedback).toContain(
    "行动事实完整 30 场，缺失 1 场（#02），不完整 1 场（#05）；缺失一律不补零。",
  );
  // 被点名的缺口不在最差三场里（#03/#04/#11），所以这不是「只说了最差三场」。
  expect(detailIndexes(feedback)).toEqual([3, 4, 11]);
  // 缺失与不完整仍然照旧单独说明，不补零、不写成 0。
  expect(feedback).toContain("行动事实缺失，未将缺失解释为零。");

  // 缺口多时写数量 + 前几个：列表再长也不把反馈撑爆（体积上限另有用例）。
  const manyMissing = base.map((reading) =>
    reading.matchIndex < 8
      ? reading
      : { ...reading, actionFacts: actionFactsAt(gridPlan.matches[reading.matchIndex]!) },
  );
  expect(renderScoreSourceFeedback(manyMissing, gridPlan)).toContain(
    "行动事实完整 24 场，缺失 8 场（#00 / #01 / #02 / #03 / #04 … 共 8 场），不完整 0 场；缺失一律不补零。",
  );
});

/** 生产口径的四份陪练身份：role 限定的 slug 比夹具长，量体积要用接近真实的字串。 */
const productionScripts: readonly TrialPlanScript[] = [
  {
    role: "top",
    id: "top:claude-opus-5-5",
    source: "archive:claude-opus-5-5/r1",
    scriptSha256: "1".repeat(64),
  },
  {
    role: "mid",
    id: "mid:minimax-m3.1-flash",
    source: "archive:minimax-m3.1-flash/r2",
    scriptSha256: "2".repeat(64),
  },
  {
    role: "last",
    id: "last:glm-5.3-flash",
    source: "archive:glm-5.3-flash/r3",
    scriptSha256: "3".repeat(64),
  },
  {
    role: "incumbent",
    id: "incumbent:muse-spark-1.3-contributor",
    source: "archive:muse-spark-1.3-contributor/r4",
    scriptSha256: "4".repeat(64),
  },
];

/** 32 场反馈的体积上限：现有三场反馈实测 3 547 字符 × 2.5，向上取整到 9 000。 */
const FEEDBACK_CHAR_LIMIT = 9_000;

it("体积守上限：32 场的反馈不超过现有 3 场（3 547 字符）的约 2.5 倍", () => {
  const gridPlan = gridPlanFixture(productionScripts);
  const readings = gridReadingsOf(gridPlan, () => [93, 58, 14, 10]);
  const first = renderScoreSourceFeedback(readings, gridPlan);
  // 带上一阶段的第二次回喂是对差表最长的一版（八格都要写 Δ），所以上限按它守。
  const second = renderScoreSourceFeedback(readings, gridPlan, readings);
  // 最坏一版：候选字节恰好等于其中一份陪练（24 场逐行多一句镜像标注）。
  const mirrored = renderScoreSourceFeedback(
    readings,
    gridPlan,
    readings,
    productionScripts[0]!.scriptSha256,
  );
  expect(first.length).toBeLessThanOrEqual(FEEDBACK_CHAR_LIMIT);
  expect(second.length).toBeLessThanOrEqual(FEEDBACK_CHAR_LIMIT);
  expect(mirrored.length).toBeLessThanOrEqual(FEEDBACK_CHAR_LIMIT);
  // 下界只防夹具退化成空文本：真跑出来的长度记在提交正文（7 103 / 7 247 / 7 511 字符）。
  expect(second.length).toBeGreaterThan(first.length);
  expect(mirrored.length).toBeGreaterThan(second.length);
  expect(first.length).toBeGreaterThan(3_000);
});

// ── 用真实历史归档的观测重建一份反馈（人工核对用；CI 没有 archive/ 时整条跳过）──

/** v1 计划（三场单图、候选 0 号位、三份基准）：历史归档的观测按它读。 */
const v1ArchivePlan = (): TrialPlan => ({
  version: 1,
  ruleset: "v2",
  rulesetSha256: "9".repeat(64),
  sandboxRuntimeHash: "8".repeat(64),
  scripts: TRIAL_BENCHMARK_IDS.map((id) => ({
    id,
    role: "benchmark" as const,
    source: `benchmark:${id}`,
    scriptSha256: "f".repeat(64),
  })),
  maps: [{ name: "corridor-split", sha256: "a".repeat(64) }],
  matchesPerCandidate: 3,
  matches: [101, 202, 303].map((seed, matchIndex) => ({
    matchIndex,
    comboIndex: 0,
    seed,
    seats: [...TRIAL_PLAYER_IDS] as unknown as [string, string, string, string],
    candidateSeat: 0 as const,
    map: "corridor-split",
    mapSha256: "a".repeat(64),
  })),
  planSha256: "0".repeat(64),
});

/** 归档里候选末位的那一份真实观测（2026-10-13 三场、四方终局齐、行动事实完整）。 */
const archiveObservations = join(
  import.meta.dirname,
  "../../..",
  "archive/minimax-m3.1-flash/observed-2026-10-13T13-48-45-729Z.jsonl",
);

it.skipIf(!existsSync(archiveObservations))(
  "真实历史归档的观测重建三层反馈：事实可读、无多出来的解读",
  () => {
    const planOfArchive = v1ArchivePlan();
    const first = JSON.parse(readFileSync(archiveObservations, "utf8").split("\n")[0] ?? "{}") as {
      actionFacts?: { scriptSha256?: string };
    };
    const readings = readTrialObservations(
      archiveObservations,
      first.actionFacts?.scriptSha256 ?? "",
      planOfArchive,
    );
    expect(readings).toHaveLength(3);
    const feedback = renderScoreSourceFeedback(readings ?? [], planOfArchive);

    expect(feedback).toContain(SECTION_DIFF);
    expect(feedback).toContain(SECTION_MATCHES);
    expect(feedback).toContain(SECTION_WORST);
    // v1 三场是同一格（座位0 / corridor-split）：候选末位、与第一名差 58。
    expect(cellLines(feedback)).toEqual([
      expect.stringContaining(
        "座位0 / corridor-split：3 局，平均名次 4.00，平均名次积分 0.00，平均领土分 0.00（第一名 58.00，分差 58.00），末位 3 局",
      ),
    ]);
    // v1 没有轮空，组合列如实写「无轮空」而不是硬套网格的读法。
    expect(matchLines(feedback)[0]).toBe(
      "  #00 | corridor-split | 座位0 | 组合0（无轮空） | 4 | 0/58/0/4 | timeout",
    );
    expect(detailLines(feedback)).toHaveLength(3);
    expect(feedback).toContain("终局事实：seed=101，已执行 tick=600，结束原因=timeout");
    expect(feedback).not.toMatch(/请检查|建议|应该|坐标|策略诊断/);
  },
);
