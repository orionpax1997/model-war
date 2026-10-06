/**
 * meta 行:十栏 + 第 12 栏 `runner`(hld §7.5)。
 *
 * ── 为什么 `runner` 必须在行里,而且必须能被读出来 ──
 * 报告要分开「桩跑的」与「真沙箱跑的」。两者产出的回放在**结构上无法区分**,而座位轮换、
 * 跨版本行为一致性这类结论只在真沙箱上成立。所以 `runner` 不是注释,不是文件名约定,
 * 是一栏数据——`renderReplay` 还得把它显出来,否则有人拿桩的读数当结论。
 *
 * ── 为什么四个沙箱栏在桩下是 `null` 而不是 `""` / `0` ──
 * 「未发生」与「恰好是空串」必须能区分。写 `""` 会让两者不可区分,而这类不可区分在报告里
 * 表现为「这一栏看起来有值」,读的人据此以为 WASI 时钟被设过。`null` 是 JSON 里唯一的「没有」。
 */

import { expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, RULESET_VERSION } from "@model-war/replay";

import { buildMetaLine, serializeMetaLine } from "./meta-line.js";

const PLAYERS = [
  { model: "alpha", archiveRef: "archive/alpha/r1", seat: 0 },
  { model: "beta", archiveRef: "archive/beta/r1", seat: 1 },
  { model: "gamma", archiveRef: "archive/gamma/r1", seat: 2 },
  { model: "delta", archiveRef: "archive/delta/r1", seat: 3 },
] as const;

const BASE = {
  timezoneOffset: "+08:00",
  mapHash: "a".repeat(64),
} as const;

/** 种子是 `runMatch` 的入参,不是 meta 头的字段;`buildMetaLine` 单独收它。 */
const BASE_SEED = 20260101;

const SANDBOX = {
  quickjsWasiVersion: "0.8.0",
  sandboxRuntimeHash: "b".repeat(64),
  wasiClock: "2026-01-01T00:00:00Z",
  wasiRandomFill: "0",
} as const;

it("meta 行是十二栏,runner 是第 12 栏", () => {
  const line = buildMetaLine({ ...BASE, runner: "stub" }, BASE_SEED, PLAYERS);
  expect(Object.keys(line)).toHaveLength(12);
  expect(Object.keys(line).at(-1)).toBe("runner");
  // hld §7.5 的十栏都在,顺序不变。
  expect(Object.keys(line)).toEqual([
    "type",
    "schemaVersion",
    "ruleset",
    "quickjsWasiVersion",
    "sandboxRuntimeHash",
    "wasiClock",
    "wasiRandomFill",
    "timezoneOffset",
    "mapHash",
    "seed",
    "players",
    "runner",
  ]);
});

it("schemaVersion 与 ruleset 取自真源常量,不由本模块硬编码", () => {
  const line = buildMetaLine({ ...BASE, runner: "stub" }, BASE_SEED, PLAYERS);
  expect(line.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  expect(line.ruleset).toBe(RULESET_VERSION);
});

it("桩执行器:四个沙箱栏一律 null,不是空串也不是 0", () => {
  const line = buildMetaLine({ ...BASE, runner: "stub" }, BASE_SEED, PLAYERS);
  // 「填空串」的反例:这一条红,而报告里「看起来有值」就成了假信息。
  expect(line.quickjsWasiVersion).toBeNull();
  expect(line.sandboxRuntimeHash).toBeNull();
  expect(line.wasiClock).toBeNull();
  expect(line.wasiRandomFill).toBeNull();
  expect(line.runner).toBe("stub");
  // 类型上就没有可填的栏:入参在 `runner: "stub"` 那一支上不带沙箱读数。
  expect(serializeMetaLine(line)).toContain('"quickjsWasiVersion":null');
});

it("真沙箱:四个沙箱栏原样落行", () => {
  const line = buildMetaLine({ ...BASE, runner: "quickjs", ...SANDBOX }, BASE_SEED, PLAYERS);
  expect(line.quickjsWasiVersion).toBe(SANDBOX.quickjsWasiVersion);
  expect(line.sandboxRuntimeHash).toBe(SANDBOX.sandboxRuntimeHash);
  expect(line.wasiClock).toBe(SANDBOX.wasiClock);
  expect(line.wasiRandomFill).toBe(SANDBOX.wasiRandomFill);
  expect(line.runner).toBe("quickjs");
});

it("四个沙箱栏从行里读得回来:报告据此分开「桩跑的」与「真沙箱跑的」", () => {
  const stub = JSON.parse(
    serializeMetaLine(buildMetaLine({ ...BASE, runner: "stub" }, BASE_SEED, PLAYERS)),
  ) as Record<string, unknown>;
  const quickjs = JSON.parse(
    serializeMetaLine(buildMetaLine({ ...BASE, runner: "quickjs", ...SANDBOX }, BASE_SEED, PLAYERS)),
  ) as Record<string, unknown>;
  expect(stub["runner"]).toBe("stub");
  expect(quickjs["runner"]).toBe("quickjs");
  expect(stub["sandboxRuntimeHash"]).toBeNull();
  expect(quickjs["sandboxRuntimeHash"]).toBe(SANDBOX.sandboxRuntimeHash);
});
