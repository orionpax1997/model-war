/**
 * 真沙箱路径的集成验收。
 *
 * 它与 `determinism.test.ts` 的四条用例是**同一组不变量、两种执行器**(那里跑桩策略,这里跑真
 * QuickJS VM):逐 tick `stateHash` 全等、列不是常量、回放可复算、反向自证。
 *
 * 重跑次数两边**不同**(桩侧十次、这里三次),这不是口径分叉:「同口径」指的是被验的不变量,
 * 不是那个循环上限。每次重跑都新造四个 VM 与一份全新引擎状态(`handle.dispose()` 逐个释放,
 * 局与局之间没有可累积的东西),于是「第四次以后才分岔」这类缺陷没有生长的地方;而宿主真钟、
 * 宿主随机这类真正的非确定性源**第二次就会分岔**——下面那条反向自证正是靠这一点才成立。
 * 一局真 VM 约 6.7s,桩侧一局 0.8s 且是 hld §11 点名的验收落点,所以十次留在桩侧。
 *
 * 另外三条用例要的「第一场回放」「列不是常量」「单位真的动了」都在同一批标准场里,它们原本
 * 各自再跑一局——同一份入参跑第二遍买到的不是证据。现在这批场只跑一次,三条共用。
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
  // 真值(quickjs-wasi 版本、bundle 字节 hash、冻随机填充)由入库产物与包 manifest 读(meta 行的
  // 形状见 hld §7.5);这里只跑通真沙箱这条路，meta 读数列的值不参与 stateHash 比对。
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

/** 标准场的重跑次数(理由见文件头注:次数随执行器成本走,不变量不随次数变)。 */
const REPEAT_RUNS = 3;

let repeated: readonly (readonly ReplayLine[])[] | undefined;

/**
 * 标准场(同一份脚本、同一份冻钟)的 `REPEAT_RUNS` 次重跑,只跑一次。
 *
 * 后三条用例要的「第一场回放」与「第二次执行」都从这批里取,不再各自重跑。`-t` 单跑某一条时
 * 缓存为空,走的仍是真的 `runOnce`。
 */
const repeatedRuns = async (): Promise<readonly (readonly ReplayLine[])[]> => {
  if (repeated !== undefined) {
    return repeated;
  }
  const runs: (readonly ReplayLine[])[] = [];
  for (let run = 0; run < REPEAT_RUNS; run++) {
    const parsed = await runOnce(MARCH_SCRIPT, WASI_CLOCK_MS);
    // 1 + tickLimit + 1:meta + 每个 tick 一行 + result。少一格就说明某一 tick 没写出来。
    expect(parsed).toHaveLength(1 + RULESET.tickLimit + 1);
    runs.push(parsed);
  }
  repeated = runs;
  return runs;
};

it("真沙箱:同配置重跑 3 次,每 tick 的 stateHash 列全等(与桩路径同一不变量)", async () => {
  const [first, ...rest] = await repeatedRuns();
  if (first === undefined) {
    throw new Error("重跑没有产出任何一场");
  }
  const firstColumn = stateHashesOf(first);
  expect(firstColumn).toHaveLength(RULESET.tickLimit);
  // 逐列比:不是「第一列像」,是每一列都与第一列相等。任何一列与别的列岔开,这里就红。
  for (const [run, parsed] of rest.entries()) {
    expect(
      stateHashesOf(parsed),
      `第 ${String(run + 2)} 次重跑的 stateHash 列与第一次不一致`,
    ).toEqual(firstColumn);
  }
}, 240_000);

it("真沙箱:那些列不是一片常量", async () => {
  // 「全等」若发生在「每 tick 哈希都一样」的退化回放上,它证明不了什么。
  const [first] = await repeatedRuns();
  if (first === undefined) {
    throw new Error("重跑没有产出任何一场");
  }
  expect(new Set(stateHashesOf(first)).size).toBeGreaterThan(1);
}, 240_000);

it("真沙箱:回放可复算(读回来的哈希列与重新执行逐字相同)", async () => {
  // 第一次跑的行序列化成「已落盘回放」的那一份字节,再解析回来——读盘端手上有的就是它。
  const [landed, rerun] = await repeatedRuns();
  if (landed === undefined || rerun === undefined) {
    throw new Error("重跑场次不足两场");
  }
  const landedBytes = landed.map((line) => JSON.stringify(line)).join("\n");
  const reparsed = landedBytes.split("\n").map((line) => JSON.parse(line) as ReplayLine);
  // 两次是独立的执行(第 2 场),所以这条仍然在比「读回来的」与「重新跑的」,不是自己比自己。
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
  const [parsed] = await repeatedRuns();
  if (parsed === undefined) {
    throw new Error("重跑没有产出任何一场");
  }
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
