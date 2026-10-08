/**
 * 回放读入端:`readLinesOf` / `parseReplay`。
 *
 * 断言打的是**外部可观察行为**——读一份文件拿到的行(含键序与行号)与拒跑时的错误。
 * 往返那条是本票的硬验收:解析后重新序列化必须与原文**逐字节**相同,所以解析**不得**重排键序
 * (写出侧的字面序即文件里的键序;走 `canonicalJsonOf` 那套排序会当场红)。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it } from "vitest";

import { parseReplay, readLinesOf, ReplayReadError } from "./parse.js";

const META = {
  type: "meta",
  schemaVersion: 1,
  ruleset: "v1",
  quickjsWasiVersion: null,
  sandboxRuntimeHash: null,
  wasiClock: null,
  wasiRandomFill: null,
  timezoneOffset: "+08:00",
  mapHash: "a".repeat(64),
  seed: 20260101,
  players: [{ model: "alpha", archiveRef: "archive/alpha/r1", seat: 0 }],
  runner: "stub",
};

const TICK = {
  type: "tick",
  tick: 0,
  players: [],
  units: [{ id: 1, owner: 0, type: "worker", x: 0, y: 0, hp: 100, carrying: 0 }],
  sites: [],
  events: [],
  stateHash: "c".repeat(64),
};

const RESULT = {
  type: "result",
  rankings: [1, 2, 3, 4],
  reason: "timeout",
  territoryScores: [8, 4, 0, 0],
};

/** 写出侧的拼法:`join("\n")` + 尾部换行(与 `apps/cli/src/match` 写盘同款)。 */
const serialize = (lines: readonly unknown[]): string =>
  `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "replay-parse-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, raw: string): string => {
  const path = join(dir, name);
  writeFileSync(path, raw, "utf8");
  return path;
};

/** 拿 `parseReplay` 的拒跑错误;读通了就直接失败。 */
const refusalOf = (path: string): ReplayReadError => {
  try {
    parseReplay(path);
  } catch (cause) {
    if (cause instanceof ReplayReadError) {
      return cause;
    }
    throw cause;
  }
  throw new Error("应当抛 ReplayReadError,却读通了");
};

it("往返:解析后重新序列化与原文逐字节一致(解析不重排键序)", () => {
  const raw = serialize([META, TICK, RESULT]);
  const path = write("round-trip.jsonl", raw);
  const lines = parseReplay(path);
  expect(lines.map((line) => line.type)).toEqual(["meta", "tick", "result"]);
  expect(serialize(lines)).toBe(raw);
});

it("readLinesOf 逐行解析并跳过空行,让尾随换行不产生半截行", () => {
  const path = write("blank-lines.jsonl", `\n${JSON.stringify(META)}\n\n${JSON.stringify(TICK)}\n`);
  expect(readLinesOf(path)).toEqual([META, TICK]);
});

it("缺 meta / 缺 result 不算错:带类型的解析保留渲染侧的容错,不擅自升级成硬校验", () => {
  // 反例:这里若改成硬报错,`modelwar replay` 对缺 meta 的回放会从「画 (缺失)」变成拒跑,
  // 与「输出逐字节一致」的验收冲突。行的形状真判据是 JSON Schema + ajv,不在本包。
  const path = write("tick-only.jsonl", `${JSON.stringify(TICK)}\n`);
  expect(parseReplay(path).map((line) => line.type)).toEqual(["tick"]);
});

it("空回放(空文件 / 全是空行)拒跑,不静默返回空行集", () => {
  for (const [name, raw] of [
    ["empty.jsonl", ""],
    ["all-blank.jsonl", "\n\n\n"],
  ] as const) {
    const path = write(name, raw);
    const error = refusalOf(path);
    expect(error.message).toContain(path);
    expect(error.message).toContain("空");
  }
});

it("非回放行(非对象 / 缺 type / type 不认识)拒跑,错误带路径与行号", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["number", "42"],
    ["missing-type", JSON.stringify({ tick: 0 })],
    ["unknown-type", JSON.stringify({ type: "bogus" })],
  ];
  for (const [name, bad] of cases) {
    const path = write(`${name}.jsonl`, `${JSON.stringify(META)}\n${bad}\n`);
    const error = refusalOf(path);
    expect(error.message).toContain(path);
    expect(error.message).toContain("第 2 行");
  }
});

it("截断的末行(不是合法 JSON)拒跑,错误带行号并点出「可能没写完」", () => {
  const path = write(
    "truncated.jsonl",
    `${JSON.stringify(META)}\n${JSON.stringify(TICK)}\n{"type":"tick"`,
  );
  const error = refusalOf(path);
  expect(error.message).toContain(path);
  expect(error.message).toContain("第 3 行");
  expect(error.message).toContain("截断");
});

it("读不到文件时拒跑,错误带路径", () => {
  const path = join(dir, "no-such.jsonl");
  const error = refusalOf(path);
  expect(error.message).toContain(path);
});
