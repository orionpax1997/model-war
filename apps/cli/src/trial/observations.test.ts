/**
 * 试跑观测文件那一格：**渲染那几行**与**把它们落盘**（不起 VM、不碰引擎）。
 *
 * 落盘的那一侧在 `apps/cli/src/trial/run-trial-script.ts`，它把 `--observations` 给的路径
 * 与每一场的读数交给本文件；这里断言的是「写出来的字节长什么样」与「写盘失败不抛」。
 * 试跑真跑三场那一侧由 `gen-cli` e2e 覆盖（真 VM + 真引擎）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, it } from "vitest";

import { trialObservationLines, writeTrialObservations } from "./observations.js";
import type { ScoreSourceReading } from "./score-source.js";

const scratch = mkdtempSync(`${tmpdir()}/modelwar-trial-observations-`);
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

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

it("落盘：整份重写，后一次的内容取代前一次（协议轮里每次试跑都写同一个路径）", () => {
  const path = join(scratch, "observed-r1.jsonl");
  expect(writeTrialObservations(path, trialObservationLines([hit(0)])).ok).toBe(true);
  expect(writeTrialObservations(path, trialObservationLines([hit(0), hit(1)])).ok).toBe(true);
  // 留盘上的是最后一次调用那一场读数（1 场），不是两次叠起来的 3 场。
  expect(readFileSync(path, "utf8")).toBe(
    `${trialObservationLines([hit(0), hit(1)]).join("\n")}\n`,
  );
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
