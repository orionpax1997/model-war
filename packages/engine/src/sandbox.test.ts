/**
 * 真沙箱路径的集成验收(票 03)。
 *
 * 它与 `determinism.test.ts` 的四条用例**同口径**(那里跑桩策略,这里跑真 QuickJS VM):
 * 十次重跑逐 tick `stateHash` 全等、十列不是常量、回放可复算、反向自证。
 *
 * ── 为什么夹具是入库的脚本、而不是一次性探针 ──
 *
 * 夹具脚本在 `fixtures/guest/` 下,与 `fixtures/strategies.ts` 的桩策略同列一行账:
 * 它们会被反复跑,读数才可比。引擎的运行时代码不做磁盘 I/O,但**测试**可以直接读盘
 * (`determinism.test.ts` 已在读规则集与地图,这里再读 wasm、runtime bundle 与脚本)。
 *
 * ── 端到端那条为什么单独一条 ──
 *
 * 十次重跑证明「引擎稳定」,端到端那条证明「脚本真的跑进了结算」:座位认错时 `move` 的属主校验
 * 会否掉每一单、单位一步都不动,所以「单位动了」是「意图经步 0 → 校验 → 结算」的直接证据。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { beforeAll, expect, it } from "vitest";
import type { MapDefinition, ReplayLine, ReplayTickLine, Ruleset } from "@model-war/replay";

import { runMatch } from "./index.js";
import { stateHashesOf } from "./fixtures/harness.js";
import { HOST_BRIDGE_DRAIN_INTENTS, HOST_BRIDGE_SET_SNAPSHOT } from "./runner/index.js";
import { WASI_CLOCK_MS, createQuickJsRunner } from "./runner/quickjs.js";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), "utf8");

const readFixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/guest/${name}`, import.meta.url)), "utf8");

const RULESET = JSON.parse(read("rulesets/v1.json")) as Ruleset;
const MAP = JSON.parse(read("maps/open-clash.json")) as MapDefinition;

const MARCH_SCRIPT = readFixture("march.js");
const RANDOM_MARCH_SCRIPT = readFixture("random-march.js");

const players = [
  { model: "proxy-0", archiveRef: "archive/proxy-0/r1", seat: 0 },
  { model: "proxy-1", archiveRef: "archive/proxy-1/r1", seat: 1 },
  { model: "proxy-2", archiveRef: "archive/proxy-2/r1", seat: 2 },
  { model: "proxy-3", archiveRef: "archive/proxy-3/r1", seat: 3 },
] as const;

const head = {
  runner: "quickjs",
  timezoneOffset: "+00:00",
  mapHash: "e".repeat(64),
  // 真值(quickjs-wasi 版本、bundle 字节 hash、冻随机填充)由票 04 从入库产物与包 manifest 读；
  // 本票只跑通真沙箱这条路，meta 读数列的值不参与 stateHash 比对。
  quickjsWasiVersion: "3.6.2",
  sandboxRuntimeHash: "f".repeat(64),
  wasiClock: String(WASI_CLOCK_MS),
  wasiRandomFill: "00",
  wasiTimezoneOffset: "0",
} as const;

const runtimeEntry = fileURLToPath(new URL("./sandbox-runtime/index.ts", import.meta.url));

const buildRuntimeCode = async (): Promise<string> => {
  const built = await build({
    entryPoints: [runtimeEntry],
    bundle: true,
    format: "iife",
    platform: "neutral",
    write: false,
    define: {
      HOST_BRIDGE_SET_SNAPSHOT: JSON.stringify(HOST_BRIDGE_SET_SNAPSHOT),
      HOST_BRIDGE_DRAIN_INTENTS: JSON.stringify(HOST_BRIDGE_DRAIN_INTENTS),
    },
  });
  const [output] = built.outputFiles ?? [];
  if (output === undefined) {
    throw new Error("esbuild 没有产出 runtime bundle");
  }
  return output.text;
};

let wasmModule: WebAssembly.Module;
let runtimeCode: string;

beforeAll(async () => {
  wasmModule = await WebAssembly.compile(
    readFileSync(fileURLToPath(import.meta.resolve("quickjs-wasi/quickjs.wasm"))),
  );
  runtimeCode = await buildRuntimeCode();
});

/** 跑一局真沙箱:四个座位各一个 VM,按座位串行执行;跑完逐个释放。 */
const runOnce = async (scriptCode: string, clockMs: number): Promise<readonly ReplayLine[]> => {
  const lines: string[] = [];
  const handles = await Promise.all(
    ([0, 1, 2, 3] as const).map((seat) =>
      createQuickJsRunner({ wasm: wasmModule, runtimeCode, scriptCode, seat, clockMs }),
    ),
  );
  try {
    runMatch({
      ruleset: RULESET,
      map: MAP,
      seed: 20260101,
      head,
      players,
      runners: handles.map((handle) => handle.runner),
      budget: {},
      sink: { write: (line) => void lines.push(line) },
    });
  } finally {
    for (const handle of handles) {
      handle.dispose();
    }
  }
  return lines.map((line) => JSON.parse(line) as ReplayLine);
};

it("真沙箱:同配置重跑 10 次,每 tick 的 stateHash 十列全等(与桩路径同口径)", async () => {
  const columns: (readonly string[])[] = [];
  for (let run = 0; run < 10; run++) {
    const parsed = await runOnce(MARCH_SCRIPT, WASI_CLOCK_MS);
    // 1 + tickLimit + 1:meta + 每个 tick 一行 + result。
    expect(parsed).toHaveLength(1 + RULESET.tickLimit + 1);
    columns.push(stateHashesOf(parsed));
  }
  const first = columns[0];
  expect(first).toHaveLength(RULESET.tickLimit);
  for (const [run, column] of columns.entries()) {
    expect(column, `第 ${String(run + 1)} 次重跑的 stateHash 列与第一次不一致`).toEqual(first);
  }
}, 240_000);

it("真沙箱:那十列不是一片常量", async () => {
  const column = stateHashesOf(await runOnce(MARCH_SCRIPT, WASI_CLOCK_MS));
  expect(new Set(column).size).toBeGreaterThan(1);
}, 240_000);

it("真沙箱:回放可复算(读回来的哈希列与重新执行逐字相同)", async () => {
  const landed = await runOnce(MARCH_SCRIPT, WASI_CLOCK_MS);
  const landedBytes = landed.map((line) => JSON.stringify(line)).join("\n");
  const reparsed = landedBytes.split("\n").map((line) => JSON.parse(line) as ReplayLine);
  const rerun = await runOnce(MARCH_SCRIPT, WASI_CLOCK_MS);
  expect(stateHashesOf(reparsed)).toEqual(stateHashesOf(rerun));
}, 240_000);

it("真沙箱反向自证:换一个冻钟读数,同一条十列断言会红", async () => {
  // 反向自证夹具用 `Math.random()` 选方向,而随机源被冻钟钉住:换冻钟 = 换序列。
  // 若三件套没生效,同一份脚本本来就不会得到同一序列,那条十列断言也不是空断言。
  const first = stateHashesOf(await runOnce(RANDOM_MARCH_SCRIPT, WASI_CLOCK_MS));
  const second = stateHashesOf(await runOnce(RANDOM_MARCH_SCRIPT, WASI_CLOCK_MS + 1));
  expect(first).not.toEqual(second);
}, 240_000);

it("真沙箱端到端:脚本产出的意图经步 0 → 校验 → 结算进入状态(单位真的动了)", async () => {
  const parsed = await runOnce(MARCH_SCRIPT, WASI_CLOCK_MS);
  const ticks = parsed.filter((line): line is ReplayTickLine => line.type === "tick");
  const firstTick = ticks[0];
  const lastTick = ticks[ticks.length - 1];
  if (firstTick === undefined || lastTick === undefined) {
    throw new Error("回放里没有 tick 行");
  }
  const positionAt = (line: ReplayTickLine): Map<number, string> =>
    new Map(line.units.map((unit) => [unit.id, `${String(unit.x)},${String(unit.y)}`]));
  const start = positionAt(firstTick);
  const end = positionAt(lastTick);
  const moved = [...start.entries()].some(([id, position]) => end.get(id) !== position);
  // 属主校验未经通过时单位一步不动,这一条就红。
  expect(moved).toBe(true);
}, 240_000);
