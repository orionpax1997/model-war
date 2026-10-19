/**
 * 试跑观测文件那一格：**渲染那几行**与**把它们落盘**（不起 VM、不碰引擎）。
 *
 * 落盘的那一侧在 `apps/cli/src/trial/run-trial-script.ts`，它把 `--observations` 给的路径
 * 与每一场的读数交给本文件；这里断言的是「写出来的字节长什么样」与「写盘失败不抛」。
 * 试跑真跑三场那一侧由 `gen-cli` e2e 覆盖（真 VM + 真引擎）。
 */

import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, expect, it, vi } from "vitest";

import { trialObservationLines, writeTrialObservations } from "./observations.js";
import type { ScoreSourceReading } from "./score-source.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: vi.fn(fs.writeFileSync),
    renameSync: vi.fn(fs.renameSync),
  };
});

const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const scratch = mkdtempSync(`${tmpdir()}/modelwar-trial-observations-`);
afterAll(() => rmSync(scratch, { force: true, recursive: true }));
afterEach(() => vi.clearAllMocks());

const hit = (matchIndex: number): { readonly matchIndex: number } & ScoreSourceReading => ({
  matchIndex,
  delivered: 0,
  captures: 0,
  noScoreSource: true,
});

const miss = (
  matchIndex: number,
  delivered: number,
  captures: number,
): { readonly matchIndex: number } & ScoreSourceReading => ({
  matchIndex,
  delivered,
  captures,
  noScoreSource: false,
});

it("每场一行：未命中的场也进文件（命中时读数必为 0/0，只记命中等于没有读数）", () => {
  const lines = trialObservationLines([hit(0), miss(1, 40, 0), miss(2, 0, 5)]);
  expect(lines).toHaveLength(3);
  expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
    { matchIndex: 0, delivered: 0, captures: 0, noScoreSource: true },
    { matchIndex: 1, delivered: 40, captures: 0, noScoreSource: false },
    { matchIndex: 2, delivered: 0, captures: 5, noScoreSource: false },
  ]);
});

it("一行一个 JSON 对象：不含额外键（场次下标 0 起，与试跑的 matchIndex 同口径）", () => {
  const [line] = trialObservationLines([hit(2)]);
  expect(Object.keys(JSON.parse(line ?? "{}") as Record<string, unknown>)).toEqual([
    "matchIndex",
    "delivered",
    "captures",
    "noScoreSource",
  ]);
});

it("没有读数时渲染给空数组（落盘那一侧据此不建文件，见下一条）", () => {
  // 一场都没跑成时（加载即 infra）不留空壳：空文件会被读档的人当成「跑了但没读数」。
  expect(trialObservationLines([])).toEqual([]);
});

it("落盘：整份替换，后一次的内容取代前一次且不遗留临时文件", () => {
  const directory = mkdtempSync(join(scratch, "replacement-"));
  const path = join(directory, "observed-r1.jsonl");
  expect(writeTrialObservations(path, trialObservationLines([hit(0)])).ok).toBe(true);
  expect(writeTrialObservations(path, trialObservationLines([hit(0), hit(1)])).ok).toBe(true);
  // 留盘上的是最后一次调用的两场读数，不是两次叠起来的三场。
  expect(readFileSync(path, "utf8")).toBe(
    `${trialObservationLines([hit(0), hit(1)]).join("\n")}\n`,
  );
  expect(readdirSync(directory)).toEqual(["observed-r1.jsonl"]);
});

it("落盘：每行一个 JSON，末尾换行（与回放 JSONL 同种行式）", () => {
  const path = join(scratch, "observed-lines.jsonl");
  writeTrialObservations(path, trialObservationLines([hit(0), hit(1)]));
  const text = readFileSync(path, "utf8");
  expect(text.endsWith("\n")).toBe(true);
  expect(text.split("\n")).toHaveLength(3); // 两行 + 末尾那个空串
});

it("没有读数 → 不落盘，也不创建文件（路径都不碰）", () => {
  const path = join(scratch, "never-written.jsonl");
  expect(writeTrialObservations(path, []).ok).toBe(true);
  expect(() => readFileSync(path, "utf8")).toThrow();
});

it("写到一半失败：旧完整观测保留，半截文件清理，返回写盘原因", () => {
  const directory = mkdtempSync(join(scratch, "partial-write-"));
  const path = join(directory, "observed-r1.jsonl");
  const previous = '{"matchIndex":0,"delivered":40,"captures":0,"noScoreSource":false}\n';
  writeFileSync(path, previous, "utf8");
  vi.mocked(writeFileSync).mockImplementationOnce((file) => {
    realFs.writeFileSync(file, '{"matchIndex":', "utf8");
    throw new Error("injected partial write failure");
  });

  expect(writeTrialObservations(path, trialObservationLines([hit(0)]))).toEqual({
    ok: false,
    reason: "injected partial write failure",
  });
  expect(readFileSync(path, "utf8")).toBe(previous);
  expect(readdirSync(directory)).toEqual(["observed-r1.jsonl"]);
});

it("首次写到一半失败：目标不存在，半截临时文件清理", () => {
  const directory = mkdtempSync(join(scratch, "first-partial-write-"));
  const path = join(directory, "observed-r1.jsonl");
  vi.mocked(writeFileSync).mockImplementationOnce((file) => {
    realFs.writeFileSync(file, '{"matchIndex":', "utf8");
    throw new Error("injected first write failure");
  });

  expect(writeTrialObservations(path, trialObservationLines([hit(0)]))).toEqual({
    ok: false,
    reason: "injected first write failure",
  });
  expect(() => readFileSync(path, "utf8")).toThrow();
  expect(readdirSync(directory)).toEqual([]);
});

it.each([true, false])("rename 失败（旧目标存在：%s）：目标状态保留，临时文件清理", (existing) => {
  const directory = mkdtempSync(join(scratch, "rename-failure-"));
  const path = join(directory, "observed-r1.jsonl");
  const previous = '{"matchIndex":0,"delivered":40,"captures":0,"noScoreSource":false}\n';
  if (existing) {
    writeFileSync(path, previous, "utf8");
  }
  vi.mocked(renameSync).mockImplementationOnce(() => {
    throw new Error("injected rename failure");
  });

  expect(writeTrialObservations(path, trialObservationLines([hit(0)]))).toEqual({
    ok: false,
    reason: "injected rename failure",
  });
  if (existing) {
    expect(readFileSync(path, "utf8")).toBe(previous);
    expect(readdirSync(directory)).toEqual(["observed-r1.jsonl"]);
  } else {
    expect(() => readFileSync(path, "utf8")).toThrow();
    expect(readdirSync(directory)).toEqual([]);
  }
});

it("写盘失败不抛：收成 ok:false + 人话原因（改不改退出码是调用点的事）", () => {
  const path = join(scratch, "not-a-dir", "observed-r1.jsonl");
  writeFileSync(join(scratch, "not-a-dir"), "占位", "utf8");
  const written = writeTrialObservations(path, trialObservationLines([hit(0)]));
  expect(written.ok).toBe(false);
  if (written.ok) {
    return;
  }
  expect(written.reason.length).toBeGreaterThan(0);
});

it("行动事实经既有 JSONL 的可选嵌套字段落盘，旧四栏行保持原样，不完整也如实保留", () => {
  const errorCounts = {
    ERR_NOT_ENOUGH_RESOURCES: 0,
    ERR_INVALID_UNIT: 0,
    ERR_NOT_OWNER: 0,
    ERR_OUT_OF_RANGE: 0,
    ERR_INVALID_TARGET: 0,
    ERR_INVALID_SITE: 0,
    ERR_BAD_ARGS: 0,
  };
  const actionFacts = {
    version: 1 as const,
    scriptSha256: "a".repeat(64),
    seed: 101,
    seat: 0 as const,
    complete: false,
    observedTicks: 2,
    missingTicks: 1,
    calls: { move: 2, moveTo: 0, attack: 0, harvest: 0, transfer: 0, spawnUnit: 0 },
    errors: {
      move: errorCounts,
      moveTo: errorCounts,
      attack: errorCounts,
      harvest: errorCounts,
      transfer: errorCounts,
      spawnUnit: errorCounts,
    },
    effects: {
      movedSteps: 1,
      harvestedAmount: 0,
      deliveredAmount: 0,
      captureEvents: 0,
      productionOrdersStarted: 0,
    },
  };
  const rows = [hit(0), { ...hit(1), actionFacts }];
  const path = join(scratch, "nested-action-facts.jsonl");
  expect(writeTrialObservations(path, trialObservationLines(rows))).toEqual({ ok: true });
  expect(
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual(rows);
});

it("终局摘要 JSONL 只写合同白名单，旧行未知且不泄漏嵌套额外字段", () => {
  const player = (seat: 0 | 1 | 2 | 3) => ({
    seat,
    player: seat === 0 ? "candidate" : `bench-${String(seat)}`,
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
  });
  const terminalSummary = {
    version: 1 as const,
    seed: 101,
    tick: 3,
    reason: "timeout" as const,
    weights: { baseScore: 10, resourceScore: 3, unitCostDivisor: 4 },
    unitCosts: { worker: 8, melee: 12, ranged: 16, cavalry: 20 },
    rankPoints: [3, 2, 1, 0] as const,
    players: [player(0), player(1), player(2), player(3)] as const,
  };
  const contaminatePlayer = (entry: ReturnType<typeof player>) => ({
    ...entry,
    secret: "HOST_SECRET",
    score: { ...entry.score, secret: "HOST_SECRET" },
    survivingUnits: { ...entry.survivingUnits, secret: "HOST_SECRET" },
  });
  const contaminated = {
    ...terminalSummary,
    secret: "HOST_SECRET",
    weights: { ...terminalSummary.weights, secret: "HOST_SECRET" },
    unitCosts: { ...terminalSummary.unitCosts, secret: "HOST_SECRET" },
    players: [
      contaminatePlayer(player(0)),
      contaminatePlayer(player(1)),
      contaminatePlayer(player(2)),
      contaminatePlayer(player(3)),
    ] as const,
  };
  const rows = trialObservationLines([hit(0), { ...hit(1), terminalSummary: contaminated }]);
  expect(rows.join("\n")).not.toContain("HOST_SECRET");
  expect(rows.map((line) => JSON.parse(line))).toEqual([hit(0), { ...hit(1), terminalSummary }]);
});
