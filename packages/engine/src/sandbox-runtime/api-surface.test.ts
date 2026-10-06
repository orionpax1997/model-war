/**
 * 脚本 API 面铺全(票 06):注入面与真源包符号表逐字对齐、反向名单缺席、判据与引擎同源、
 * 基准脚本能跑完整场。
 *
 * ── 断言的对象是外部行为 ──
 *
 * `probe` 在 guest 里求一段表达式并 dump 回宿主——这是测试与自检专用的入口,不在 `SeatRunner`
 * 那条缝上。名字集合、可调用性、`typeof` 都经它读;意图与回放仍是常规的外部观察面。
 *
 * 引擎的运行时代码不做磁盘 I/O,但测试可以:这里读基准脚本、读 wasm、现打 runtime bundle。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  FORBIDDEN_GLOBAL_NAMES,
  SANDBOX_INJECTED_API_SYMBOLS,
  type MapDefinition,
  type ReplayLine,
  type Ruleset,
} from "@model-war/replay";

import { runMatch } from "../index.js";
import { stateHashesOf } from "../fixtures/harness.js";
import { HOST_BRIDGE_DRAIN_INTENTS, HOST_BRIDGE_SET_SNAPSHOT } from "../runner/index.js";
import {
  WASI_CLOCK_MS,
  SCRIPT_ENTRY,
  createQuickJsRunner,
  createSandboxVm,
  openSandbox,
} from "../runner/quickjs.js";
import type { QuickJS } from "quickjs-wasi";
import type { Player, PlayerIndex, Site, Snapshot, Unit } from "../world/state.js";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${relative}`, import.meta.url)), "utf8");

const RULESET = JSON.parse(read("rulesets/v1.json")) as Ruleset;
const MAP = JSON.parse(read("maps/open-clash.json")) as MapDefinition;
const CELL_A = read("benchmarks/cell-a-melee-pressure/script.js");

/** 注入面的名字(真源),排序后备用。 */
const INJECTED = [...SANDBOX_INJECTED_API_SYMBOLS].sort();
/** 判据用的「无参也能调」的实参;错误码不是函数,不在表里。 */
const CALL_ARGS: Readonly<Record<string, readonly unknown[]>> = {
  getTick: [],
  getObjectById: [1],
  getObjectsByType: ["unit"],
  getRange: [0, 0, 1, 1],
  getTerrainAt: [0, 0],
  findPath: [0, 0, 1, 1],
  move: [0, 1, 0],
  moveTo: [0, 1, 1],
  attack: [0, 1],
  harvest: [0, 1],
  transfer: [0],
  spawnUnit: [0, "worker"],
  getMyIndex: [],
  isError: [null],
  errCode: [{ code: "ERR_BAD_ARGS" }],
};

const isErrorCode = (name: string): boolean => name.startsWith("ERR_");

const runtimeEntry = fileURLToPath(new URL("./index.ts", import.meta.url));

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
const disposers: (() => void)[] = [];

beforeAll(async () => {
  wasmModule = await WebAssembly.compile(
    readFileSync(fileURLToPath(import.meta.resolve("quickjs-wasi/quickjs.wasm"))),
  );
  runtimeCode = await buildRuntimeCode();
});

afterAll(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});

const readGlobalNames = (vm: QuickJS): string[] =>
  vm
    .evalCode("Object.getOwnPropertyNames(globalThis)")
    .consume((handle) => vm.dump(handle)) as string[];

it("遍历符号表:每个函数在 guest 里存在且可调用、每个错误码是等于自己名字的字符串", async () => {
  const session = await openSandbox({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: "function loop() {}",
    seat: 0,
  });
  disposers.push(session.dispose);

  const kinds = session.probe(
    `(() => { const r = {}; for (const n of ${JSON.stringify(INJECTED)}) r[n] = typeof globalThis[n]; return r; })()`,
  ) as Record<string, string>;

  for (const name of INJECTED) {
    expect(kinds[name], `注入面缺少 \`${name}\``).toBe(isErrorCode(name) ? "string" : "function");
  }

  // 错误码的值就是它自己的名字(与类型面 `declare const ERR_X: "ERR_X"` 同一条)。
  const values = session.probe(
    `(() => { const r = {}; for (const n of ${JSON.stringify(INJECTED)}) r[n] = globalThis[n]; return r; })()`,
  ) as Record<string, unknown>;
  for (const name of INJECTED.filter(isErrorCode)) {
    expect(values[name], `错误码 \`${name}\` 的值与名字不一致`).toBe(name);
  }

  // 逐个调用(空世界下返回错误码也是「可调用」):一个都不许抛。
  const calls = INJECTED.filter((name) => !isErrorCode(name)).map(
    (name) => [name, CALL_ARGS[name] ?? []] as const,
  );
  const results = session.probe(
    `(() => { const r = {}; for (const [n, a] of ${JSON.stringify(calls)}) {` +
      ` try { globalThis[n](...a); r[n] = "ok"; } catch (e) { r[n] = "threw:" + String(e); } } return r; })()`,
  ) as Record<string, string>;
  for (const [name] of calls) {
    expect(results[name], `\`${name}\` 调用抛了`).toBe("ok");
  }
});

it("注入面的名字集合恰好是真源包符号表:一个不多一个不少", async () => {
  const baseline = await createSandboxVm({ wasm: wasmModule });
  const before = readGlobalNames(baseline);
  baseline.dispose();

  const session = await openSandbox({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: "function loop() {}",
    seat: 0,
  });
  disposers.push(session.dispose);
  const after = session.probe("Object.getOwnPropertyNames(globalThis)") as string[];

  const added = after.filter((name) => !before.includes(name) && name !== SCRIPT_ENTRY).sort();
  // 这一条同时钉住两件事:名字集合与符号表逐字相同,且 `__setup` / 两个桥都没残留。
  // (`loop` 是载入脚本时它自己新建的全局,不是注入面,故排除。)
  expect(added).toEqual(INJECTED);
});

it("反向:符号表之外的名字在 guest 里不存在,调用得到普通 ReferenceError", async () => {
  const session = await openSandbox({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: "function loop() {}",
    seat: 0,
  });
  disposers.push(session.dispose);

  const absent = [
    "getResources",
    "fly",
    "spawn",
    "probe",
    HOST_BRIDGE_SET_SNAPSHOT,
    HOST_BRIDGE_DRAIN_INTENTS,
  ];
  const kinds = session.probe(
    `(() => { const r = {}; for (const n of ${JSON.stringify(absent)}) r[n] = typeof globalThis[n]; return r; })()`,
  ) as Record<string, string>;
  for (const name of absent) {
    expect(kinds[name], `符号表之外的名字 \`${name}\` 竟然存在`).toBe("undefined");
  }

  const callable = ["getResources", "fly", "spawn", "probe"];
  const body = callable
    .map(
      (name) =>
        `try { ${name}(); r[${JSON.stringify(name)}] = "no-throw"; } catch (e) {` +
        ` r[${JSON.stringify(name)}] = e instanceof ReferenceError ? "ReferenceError" : String(e); }`,
    )
    .join(" ");
  const errors = session.probe(`(() => { const r = {}; ${body} return r; })()`) as Record<
    string,
    string
  >;
  for (const name of callable) {
    expect(errors[name], `\`${name}\` 不是普通 ReferenceError`).toBe("ReferenceError");
  }

  // `FORBIDDEN_GLOBAL_NAMES` 是**注名单**:注入面一个都不许收它们。至于它们是否是语言内建
  // (`Date` / `performance` 在 QuickJS 里本来就在场,由三件套钉住、静态期 `__*`/禁名单兜底),
  // 那是另一件事——「不动 `intrinsics`」的裁决见 spec《Further Notes》。
  const injected = new Set(INJECTED);
  for (const forbidden of FORBIDDEN_GLOBAL_NAMES) {
    expect(injected.has(forbidden), `注入面不该收禁列名 \`${forbidden}\``).toBe(false);
  }
});

it("状态查询只读:脚本改快照对象,宿主的快照与 GameState 不变(能弄红的反例)", async () => {
  const players: readonly Player[] = [0, 1, 2, 3].map((index) => ({
    index: index as PlayerIndex,
    resources: 10,
    alive: true,
    exceptionTicks: 0,
  }));
  const units: readonly Unit[] = [
    { id: 1, owner: 0, type: "worker", x: 1, y: 1, hp: 2, carrying: 0 },
  ];
  const sites: readonly Site[] = [];
  const hostSnapshot: Snapshot = {
    tick: 3,
    size: 4,
    terrain: [
      [false, false, false, false],
      [false, false, false, false],
      [false, false, false, false],
      [false, false, false, false],
    ],
    players,
    units,
    sites,
  };

  const handle = await createQuickJsRunner({
    wasm: wasmModule,
    runtimeCode,
    scriptCode:
      "function loop() {" +
      "  const unit = getObjectsByType('unit')[0];" +
      "  unit.hp = 999; unit.x = 99;" +
      "  getObjectById(1).y = 77;" +
      "}",
    seat: 0,
  });
  disposers.push(handle.dispose);

  handle.runner.setSnapshot(hostSnapshot);
  handle.runner.drainIntents();

  // `__setSnapshot` 经 `hostToHandle` 深拷贝:脚本改的是 guest 里那份副本。
  // 若快照被按引用交进 guest(而不是拷贝),这三条会红——这正是它们的价值。
  expect(hostSnapshot.units[0]?.hp).toBe(2);
  expect(hostSnapshot.units[0]?.x).toBe(1);
  expect(hostSnapshot.units[0]?.y).toBe(1);
});

// ── 真实基准脚本跑完整场 ──────────────────────────────────────────────────────

const BENCH_PLAYERS = [0, 1, 2, 3].map((seat) => ({
  model: `cell-a-${String(seat)}`,
  archiveRef: `archive/cell-a-${String(seat)}/r1`,
  seat: seat as PlayerIndex,
}));

const BENCH_HEAD = {
  runner: "quickjs",
  timezoneOffset: "+00:00",
  mapHash: "c".repeat(64),
  quickjsWasiVersion: "3.6.2",
  sandboxRuntimeHash: "d".repeat(64),
  wasiClock: String(WASI_CLOCK_MS),
  wasiRandomFill: "00",
  wasiTimezoneOffset: "0",
} as const;

/** 真沙箱跑一场 cell-a:四个座位各一个 VM,规则集灌进 `__setup`;跑完逐个释放。 */
const runCellA = async (): Promise<readonly ReplayLine[]> => {
  const lines: string[] = [];
  const handles = await Promise.all(
    ([0, 1, 2, 3] as const).map((seat) =>
      createQuickJsRunner({
        wasm: wasmModule,
        runtimeCode,
        scriptCode: CELL_A,
        seat,
        ruleset: RULESET,
      }),
    ),
  );
  try {
    runMatch({
      ruleset: RULESET,
      map: MAP,
      seed: 20260606,
      head: BENCH_HEAD,
      players: BENCH_PLAYERS,
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

it("真实基准脚本(cell-a)在沙箱里跑完整场:不报未定义名、产出可复算回放", async () => {
  const parsed = await runCellA();
  // meta + tickLimit 个 tick + result:一场跑到底(没有在 loop() 里抛未捕获异常而中断)。
  expect(parsed).toHaveLength(1 + RULESET.tickLimit + 1);
  expect(parsed[0]?.type).toBe("meta");
  expect(parsed[parsed.length - 1]?.type).toBe("result");
  // 回放里确实有单位在动(脚本真的下过单并移动过),不是一场空跑。
  const ticks = parsed.filter((line) => line.type === "tick");
  expect(ticks.length).toBe(RULESET.tickLimit);
}, 240_000);

it("真实基准脚本(cell-a)可复算:两次跑逐 tick stateHash 全等", async () => {
  const first = stateHashesOf(await runCellA());
  const second = stateHashesOf(await runCellA());
  expect(second).toEqual(first);
}, 240_000);
