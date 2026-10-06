/**
 * 真沙箱执行器(票 03):生命周期、删桥、三件套、排空到不动点与内存隔离。
 *
 * 它钉的是**缝上的外部行为**:脚本看不见桥、VM 之间互不可见、同一份脚本得到同一序列、
 * 意图在该交回的 tick 交回。`StubRunner` 的对应断言在 `stub.test.ts`,两边的「缝只有两个方法」
 * 是同一条纪律的两个适配器。
 *
 * 下面《内存判据(票 08)》那一组接着钉内存裁据:读数取在 tick 末强制回收之后的存活堆上、
 * 与 guest 异常可见性无关、软阈只观测、已接受的残余不判。
 *
 * 测试文件可以读盘与引 esbuild(依赖门禁只管运行时代码):wasm 与 runtime bundle 都在这里现造。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { expect, it, beforeAll, vi } from "vitest";
import { MEMORY_SOFT_THRESHOLD_RATIO, type Ruleset } from "@model-war/replay";
import type { QuickJS } from "quickjs-wasi";

import { processTick } from "../processor/index.js";
import { loadRuleset } from "../ruleset-loader/index.js";
import { stubRunner } from "./stub.js";
import type { GameState, PlayerIndex, Site, Snapshot, Terrain } from "../world/state.js";
import { HOST_BRIDGE_DRAIN_INTENTS, HOST_BRIDGE_SET_SNAPSHOT } from "./index.js";
import {
  API_CALL_TRACK,
  EVENT_TRACK,
  INTERRUPT_EVENT_GRANULARITY,
  MEMORY_TRACK,
  WALL_CLOCK_SAMPLE_INTERVAL,
  WALL_CLOCK_TRACK,
  WASI_CLOCK_MS,
  createQuickJsRunner,
  createSandboxVm,
  createTickCounter,
  openSandbox,
  tickCounterHandler,
} from "./quickjs.js";

/** 一份最小快照:预览桥/骨架即可,不含任何对象。 */
const snapshotOf = (tick: number): Snapshot => ({
  tick,
  size: 0,
  terrain: [],
  players: [],
  units: [],
  sites: [],
});

const wasmPath = fileURLToPath(import.meta.resolve("quickjs-wasi/quickjs.wasm"));
const runtimeEntry = fileURLToPath(new URL("../sandbox-runtime/index.ts", import.meta.url));

/** 把 `sandbox-runtime` 源码打成 IIFE;两个桥名经 `define` 注入(源码里不手写字面量)。 */
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
  wasmModule = await WebAssembly.compile(readFileSync(wasmPath));
  runtimeCode = await buildRuntimeCode();
});

/**
 * 探针脚本:把三件事编码进一条 `move` 意图交回来。
 * `unitId` = 按 `__` 前缀枚举到的全局数;`dx` = 引用已删桥是否抛 `ReferenceError`;
 * `dy` = `typeof __setSnapshot` 是否是 `"undefined"`。
 */
const PROBE_SCRIPT = `
function loop() {
  const names = Object.getOwnPropertyNames(globalThis).filter((name) => name.indexOf("__") === 0);
  let refError = 0;
  try {
    __drainIntents();
  } catch (error) {
    if (error instanceof ReferenceError) {
      refError = 1;
    }
  }
  const typeofGone = typeof __setSnapshot === "undefined" ? 1 : 0;
  move(names.length, refError, typeofGone);
}
`;

it("桥在脚本执行前被删:前缀枚举为空、typeof 未定义、引用已删桥是普通 ReferenceError", async () => {
  const { runner, dispose } = await createQuickJsRunner({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: PROBE_SCRIPT,
    seat: 0,
  });
  try {
    runner.setSnapshot(snapshotOf(0));
    // 三个数全为 0/1 的期望:0 个 `__` 全局、引用抛 ReferenceError、typeof 是 "undefined"。
    // 同时这一行本身就是「闭包内引用照常工作」:宿主经函数 handle 调了已被删除的桥。
    expect(runner.drainIntents().intents).toEqual([{ kind: "move", unitId: 0, dx: 1, dy: 1 }]);
  } finally {
    dispose();
  }
});

it("真沙箱执行器在缝上同样只有两个方法:建 VM / 释放归工厂", async () => {
  const { runner, dispose } = await createQuickJsRunner({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: "function loop() {}",
    seat: 0,
  });
  try {
    // 「顺手加一个 dispose/load 到执行器上」的反例:这一条红。生命周期归工厂的交回,不归缝。
    expect(Object.keys(runner).sort()).toEqual(["drainIntents", "setSnapshot"]);
  } finally {
    dispose();
  }
});

/** 把一个意图推迟到一个 job 里:只有在 `__drainIntents()` 之前排空,它才属于本 tick。 */
const DEFERRED_INTENT_SCRIPT = `
function loop() {
  if (getTick() === 0) {
    Promise.resolve().then(() => {
      move(1, 1, 0);
    });
  }
}
`;

it("每 tick 排空到不动点:job 里产生的意图在本 tick 就交回", async () => {
  const { runner, dispose } = await createQuickJsRunner({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: DEFERRED_INTENT_SCRIPT,
    seat: 0,
  });
  try {
    runner.setSnapshot(snapshotOf(0));
    // 不排空就有这一条红:意图留到下一 tick,本 tick 交回的是空数组。
    expect(runner.drainIntents().intents).toEqual([{ kind: "move", unitId: 1, dx: 1, dy: 0 }]);
  } finally {
    dispose();
  }
});

it("反例:不排空则意图跨 tick 残留(tick 0 的意图在 tick 1 才出现)", async () => {
  const session = await openSandbox({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: DEFERRED_INTENT_SCRIPT,
    seat: 0,
  });
  try {
    session.setSnapshot(snapshotOf(0));
    session.runLoop();
    // 本 tick 不排空:那一笔意图还留在 job 队列里。
    expect(session.drainIntents().intents).toEqual([]);

    session.setSnapshot(snapshotOf(1));
    session.runLoop();
    // 上一 tick 的 job 在这里才跑——它把 tick 0 的意图带进了 tick 1 的交回里。
    expect(session.pumpJobs()).toBeGreaterThan(0);
    expect(session.drainIntents().intents).toEqual([{ kind: "move", unitId: 1, dx: 1, dy: 0 }]);
  } finally {
    session.dispose();
  }
});

it("四个 VM 同进程、线性内存互不可见", async () => {
  // 四个 VM 复用同一个 WebAssembly.Module(hld §5.1 的实际形态),但各是独立的 WASM 实例。
  const vms: QuickJS[] = await Promise.all(
    ([0, 1, 2, 3] as const).map(() => createSandboxVm({ wasm: wasmModule })),
  );
  try {
    vms.forEach((vm, index) => {
      vm.evalCode(`globalThis.probe = ${String(index)};`).dispose();
    });
    // 共享线性内存的反例:那样四个 VM 会读到同一个(最后写入的)值,这一条红。
    const readings = vms.map((vm) => vm.evalCode("probe").consume((handle) => vm.dump(handle)));
    expect(readings).toEqual([0, 1, 2, 3]);
  } finally {
    for (const vm of vms) {
      vm.dispose();
    }
  }
});

/** 在同一个 VM 上连采四个样本:每条 `[Date.now(), Math.random(), 时区偏移]`。 */
const sampleSequence = (vm: QuickJS): unknown[] =>
  Array.from({ length: 4 }, () =>
    vm
      .evalCode("[Date.now(), Math.random(), new Date().getTimezoneOffset()]")
      .consume((handle) => vm.dump(handle)),
  );

it("三件套:对局内、跨 VM、跨重跑三个维度得到同一序列", async () => {
  const first = await createSandboxVm({ wasm: wasmModule });
  const second = await createSandboxVm({ wasm: wasmModule });
  const third = await createSandboxVm({ wasm: wasmModule });
  const sequenceOfFirst = sampleSequence(first);
  const sequenceOfSecond = sampleSequence(second);
  const sequenceOfThird = sampleSequence(third);
  first.dispose();
  second.dispose();
  third.dispose();

  // 对局内:冻钟在每个样本里都是同一个常量,时区恒为 0。
  for (const sample of sequenceOfFirst as [number, number, number][]) {
    expect(sample[0]).toBe(WASI_CLOCK_MS);
    expect(sample[2]).toBe(0);
  }
  // 跨 VM 与跨重跑:整条序列逐项相同(随机源也被冻钟钉住了)。
  expect(sequenceOfSecond).toEqual(sequenceOfFirst);
  expect(sequenceOfThird).toEqual(sequenceOfFirst);

  // 那条序列不是一片常量:随机数确实在变,所以上面的相等有内容。
  const randoms = (sequenceOfFirst as [number, number, number][]).map((sample) => sample[1]);
  expect(new Set(randoms).size).toBeGreaterThan(1);
});

// ── 内存判据(票 08) ──────────────────────────────────────────────────────────
//
// 判据读数 = 每 tick 末**强制 `runGC()` 之后**的存活堆(`mallocSize`)。夹具在
// `fixtures/guest/memory-*.js`,与 `march.js` 同列一行账:会被反复跑,读数才可比。

const readFixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/guest/${name}`, import.meta.url)), "utf8");

const HOARD_SCRIPT = readFixture("memory-hoard.js");
const SWALLOW_SCRIPT = readFixture("memory-swallow.js");
const TRANSIENT_SCRIPT = readFixture("memory-transient.js");

const MIB = 1 << 20;

/** 空脚本跑一 tick、强制回收之后的存活堆读数(bytes);用作判罚线的基线。 */
const baselineAliveHeap = (memoryLimit?: number): Promise<number> =>
  aliveHeapAfterTick("function loop() {}", memoryLimit);

/** 开一个会话跑完一 tick 的脚本执行、强制回收之后读存活堆读数(bytes)。 */
const aliveHeapAfterTick = async (scriptCode: string, memoryLimit?: number): Promise<number> => {
  const session = await openSandbox({
    wasm: wasmModule,
    runtimeCode,
    scriptCode,
    seat: 0,
    ...(memoryLimit === undefined ? {} : { memoryLimit }),
  });
  try {
    session.setSnapshot(snapshotOf(0));
    session.runLoop();
    session.pumpJobs();
    session.runGC();
    return session.memoryUsage().mallocSize;
  } finally {
    session.dispose();
  }
};

/** 造一个座位 0 的真执行器、跑一 tick、交回载荷(观测搭同一次返回回来)。 */
const drainOneTick = async (
  scriptCode: string,
  options: {
    readonly memoryLimit?: number;
    readonly memoryTickCeiling?: number;
    readonly softThresholdRatio?: number;
    readonly eventTickLimit?: number;
    readonly apiCallTickLimit?: number;
    readonly wallClockSoftLimit?: number;
    readonly wallClockHardTimeout?: number;
  } = {},
) => {
  const { runner, dispose } = await createQuickJsRunner({
    wasm: wasmModule,
    runtimeCode,
    scriptCode,
    seat: 0,
    ...options,
  });
  try {
    runner.setSnapshot(snapshotOf(0));
    return runner.drainIntents();
  } finally {
    dispose();
  }
};

/** 读数落盘目录。**只有设了才写**——check 链上不该有文件副作用(与 `fixtures.test.ts` 同一约定)。 */
const readingsRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const writeReading = (name: string, value: unknown): void => {
  const dir = process.env["MW_READINGS_DIR"];
  if (dir === undefined) {
    return;
  }
  mkdirSync(`${readingsRoot}${dir}`, { recursive: true });
  writeFileSync(
    `${readingsRoot}${dir}/${name}.json`,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
};

it("内存判据:撑内存夹具在 tick 末强制回收之后按存活堆读数被判定(tripped)", async () => {
  const ceiling = (await baselineAliveHeap()) + MIB;
  const output = await drainOneTick(HOARD_SCRIPT, { memoryTickCeiling: ceiling });
  const tripped = output.observations[0];
  if (tripped === undefined) {
    throw new Error("撑内存夹具没有被判定");
  }
  expect(tripped).toMatchObject({ kind: "tripped", track: MEMORY_TRACK, limit: ceiling });
  // 读数在判罚线之上,不是「恰好相等」的边界巧合。
  expect(tripped.value).toBeGreaterThan(ceiling);
});

it("判据读数用的是存活堆字段 mallocSize(不是 memoryUsedSize、不是 objCount)", async () => {
  const ceiling = (await baselineAliveHeap()) + MIB;
  const output = await drainOneTick(HOARD_SCRIPT, { memoryTickCeiling: ceiling });
  const tripped = output.observations[0];
  if (tripped === undefined) {
    throw new Error("撑内存夹具没有被判定");
  }
  // 另开一个同配置会话,停在同一处(loop → pumpJobs → runGC)读整张 `MemoryUsage`:
  // 观测值必须落在 `mallocSize` 那一格,另两个口径都不是判据读数。
  const session = await openSandbox({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: HOARD_SCRIPT,
    seat: 0,
  });
  try {
    session.setSnapshot(snapshotOf(0));
    session.runLoop();
    session.pumpJobs();
    session.runGC();
    const usage = session.memoryUsage();
    expect(tripped.value).toBe(usage.mallocSize);
    // 「存活堆」与「活对象占用」「活对象数」不是一个量:若读错字段,这两条会分开。
    expect(usage.mallocSize).not.toBe(usage.memoryUsedSize);
    expect(usage.mallocSize).not.toBe(usage.objCount);
  } finally {
    session.dispose();
  }
});

it("判据不依赖 guest 异常可见性:把分配上限的 OOM 吞掉的同款夹具照样被判", async () => {
  const memoryLimit = 16 * MIB;
  const ceiling = (await baselineAliveHeap(memoryLimit)) + MIB;
  // 夹具在 guest 内 `try/catch` 吞掉 OOM:runLoop 不抛,宿主拿到的是一次正常交回。
  // 判据照样从存活堆读数判出——宿主全程没有读、也没有捕获 guest 异常。
  const output = await drainOneTick(SWALLOW_SCRIPT, { memoryLimit, memoryTickCeiling: ceiling });
  const tripped = output.observations[0];
  if (tripped === undefined) {
    throw new Error("吞掉 OOM 的同款夹具没有被判定");
  }
  expect(tripped).toMatchObject({ kind: "tripped", track: MEMORY_TRACK, limit: ceiling });
  expect(tripped.value).toBeGreaterThan(ceiling);
});

it("分配上限超限转成 guest 可见的可捕获异常(与读数判据是两件事)", async () => {
  // 这一条**不**断言判据:它单独钉「分配上限(硬)」那一层——超限在 guest 里是可捕获的
  // `InternalError`,与「判据锚定读数、guest 吞不吞异常都判」互为两件事。
  const vm = await createSandboxVm({ wasm: wasmModule, memoryLimit: 8 * MIB });
  try {
    const caught = vm
      .evalCode(
        "(() => {" +
          "  try {" +
          "    const chunks = [];" +
          "    for (;;) chunks.push(new Array(65536).fill(1));" +
          "    return 'no-throw';" +
          "  } catch (error) {" +
          "    return error.name + ': ' + error.message;" +
          "  }" +
          "})()",
      )
      .consume((handle) => vm.dump(handle));
    expect(caught).toBe("InternalError: out of memory");
  } finally {
    vm.dispose();
  }
});

it("已接受的残余:tick 内瞬时借满后自行释放的分配不被判(不是漏判)", async () => {
  const ceiling = (await baselineAliveHeap()) + MIB;
  // `memory-transient.js` 与 `memory-hoard.js` 的分配量刻意一致:攥住会判(上面那条),
  // 借完即还在读数那一刻已不可达、已被回收,于是不判。两条合起来才说明 residual 不是空断言。
  const output = await drainOneTick(TRANSIENT_SCRIPT, { memoryTickCeiling: ceiling });
  expect(output.observations).toEqual([]);
});

it("未定值规则集(判罚线字段缺席)下本轨不启用:不产观测、不判负", async () => {
  // 组装层读键清单的两态字段,未定值就不传 `memoryTickCeiling`。同一个撑内存夹具此时什么都不报。
  const output = await drainOneTick(HOARD_SCRIPT);
  expect(output.observations).toEqual([]);
});

it("软阈值是判罚线的推导项:只发 memory-pressure、不判罚", async () => {
  const hoard = await aliveHeapAfterTick(HOARD_SCRIPT);
  // 判罚线略高于存活堆:读数落在 [软阈, 判罚线) 里,只披露。
  const ceiling = hoard + MIB;
  const output = await drainOneTick(HOARD_SCRIPT, { memoryTickCeiling: ceiling });
  const pressure = output.observations[0];
  if (pressure === undefined) {
    throw new Error("软阈值没有产生 memory-pressure");
  }
  expect(pressure).toMatchObject({ kind: "memory-pressure", track: MEMORY_TRACK });
  // 软阈 = `floor(MEMORY_SOFT_THRESHOLD_RATIO × 判罚线)`:它是推导量,不是独立参数键。
  expect(pressure.limit).toBe(Math.floor(MEMORY_SOFT_THRESHOLD_RATIO * ceiling));
  expect(pressure.value).toBeGreaterThanOrEqual(pressure.limit);
  expect(pressure.value).toBeLessThan(ceiling);
});

it("软阈系数可显式覆写(显式覆写点,不是第二个必须标定的数)", async () => {
  const hoard = await aliveHeapAfterTick(HOARD_SCRIPT);
  const ceiling = hoard + MIB;
  const output = await drainOneTick(HOARD_SCRIPT, {
    memoryTickCeiling: ceiling,
    softThresholdRatio: 0.5,
  });
  const pressure = output.observations[0];
  if (pressure === undefined) {
    throw new Error("软阈值没有产生 memory-pressure");
  }
  expect(pressure).toMatchObject({ kind: "memory-pressure", track: MEMORY_TRACK });
  expect(pressure.limit).toBe(Math.floor(0.5 * ceiling));
});

it("每 tick 末的强制回收有开销:读数记录在案(不是免费动作)", async () => {
  // 这条用例把「强制回收的每 tick 开销」量出来并落到 runs/ 的读数文件(只在设了
  // `MW_READINGS_DIR` 时写)。它不是性能门禁——门禁归性能标定;这里只保证这条开销在账上。
  const ceiling = (await baselineAliveHeap()) + MIB;
  const { runner, dispose } = await createQuickJsRunner({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: "function loop() {}",
    seat: 0,
    memoryTickCeiling: ceiling,
  });
  try {
    const warmup = 50;
    for (let i = 0; i < warmup; i++) {
      runner.setSnapshot(snapshotOf(i));
      runner.drainIntents();
    }
    const samples = 500;
    const started = performance.now();
    for (let i = 0; i < samples; i++) {
      runner.setSnapshot(snapshotOf(i));
      runner.drainIntents();
    }
    const microsPerTick = ((performance.now() - started) / samples) * 1000;
    writeReading("t08-gc-overhead", { samples, microsPerTick });
    // 读数存在即有账:每 tick 一次的强制回收不是零成本动作。
    expect(microsPerTick).toBeGreaterThan(0);
  } finally {
    dispose();
  }
});

// ── 双计数(票 07):控制流事件计数 + API 调用计数 ────────────────────────────
//
// 两个计数都是**宿主 authored 的纯整数计数**,互为盲区:纯计算死循环由事件计数抓,API 轰炸由
// API 调用计数抓。夹具在 `fixtures/guest/event-spin.js` 与 `api-flood.js`。

const EVENT_SPIN_SCRIPT = readFixture("event-spin.js");
const API_FLOOD_SCRIPT = readFixture("api-flood.js");

it("计数回调内每次只做整数自增与比较;时钟按抽样读(不是每次)", () => {
  // 静态:回调源码里没有分配类构造。它每 5000 次控制流事件就被调到一次,放重活会拖慢每一步。
  // 时钟读取是**允许**的(hld §5.3:「不得放每次都做的重活;时钟按抽样读」),所以不列入禁词。
  const source = tickCounterHandler.toString();
  for (const forbidden of ["Math", "new ", ".push(", "Object.", "Array", "["]) {
    expect(source).not.toContain(forbidden);
  }
  // 行为:每 `WALL_CLOCK_SAMPLE_INTERVAL` 次回调才读一次钟——前 N-1 次一次都不读。
  const spy = vi.spyOn(performance, "now");
  try {
    const counter = createTickCounter({
      eventLimit: undefined,
      softLimit: 0,
      hardLimit: undefined,
    });
    counter.armed = true;
    for (let call = 0; call < WALL_CLOCK_SAMPLE_INTERVAL - 1; call++) {
      expect(tickCounterHandler(counter)).toBe(false);
    }
    // 未到抽样点:一次钟都没读。若回调每次都读钟,这一条红。
    expect(spy).not.toHaveBeenCalled();
    expect(tickCounterHandler(counter)).toBe(false);
    // 恰好到抽样点:读一次钟,并把首越读数记下。
    expect(spy).toHaveBeenCalledTimes(1);
    expect(counter.softValue).toBeGreaterThanOrEqual(0);
  } finally {
    spy.mockRestore();
  }
  // 事件计数:恰好按粒度自增,达阈才置截停标志。
  const counter = createTickCounter({
    eventLimit: 2 * INTERRUPT_EVENT_GRANULARITY,
    softLimit: undefined,
    hardLimit: undefined,
  });
  counter.armed = true;
  expect(tickCounterHandler(counter)).toBe(false);
  expect(counter.eventCount).toBe(INTERRUPT_EVENT_GRANULARITY);
  expect(tickCounterHandler(counter)).toBe(true);
  expect(counter.eventTripped).toBe(true);
  // 未 arm、或本轨未启用(阈值缺席)时,回调恒不截停。
  expect(
    tickCounterHandler(
      createTickCounter({ eventLimit: undefined, softLimit: undefined, hardLimit: undefined }),
    ),
  ).toBe(false);
  const idle = createTickCounter({ eventLimit: 1, softLimit: undefined, hardLimit: undefined });
  expect(tickCounterHandler(idle)).toBe(false);
});

it("纯计算死循环夹具被控制流事件计数截停(意图作废、产 tripped)", async () => {
  const limit = 10 * INTERRUPT_EVENT_GRANULARITY;
  const { runner, dispose } = await createQuickJsRunner({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: EVENT_SPIN_SCRIPT,
    seat: 0,
    eventTickLimit: limit,
  });
  try {
    runner.setSnapshot(snapshotOf(0));
    const output = runner.drainIntents();
    // 死循环交不出任何意图(它本来也不产生);本 tick 被截停。
    expect(output.intents).toEqual([]);
    expect(output.observations).toHaveLength(1);
    const tripped = output.observations[0];
    expect(tripped).toMatchObject({ kind: "tripped", track: EVENT_TRACK, limit });
    // 夹具一个 API 都不调,所以截停它的不可能是 API 计数轨(对照下一组)。
    expect(tripped?.value).toBeGreaterThanOrEqual(limit);
  } finally {
    dispose();
  }
});

it("事件计数轨的边界:阈值高低决定截停与否(能弄红的反例)", async () => {
  // 同一条有界重计算脚本:阈值远高于它的事件数 → 不截停,意图照常交回。
  const bounded = "function loop() { for (let i = 0; i < 20000; i++) {} move(0, 1, 0); }";
  const noTrip = await drainOneTick(bounded, {
    eventTickLimit: 1000 * INTERRUPT_EVENT_GRANULARITY,
  });
  expect(noTrip.observations).toEqual([]);
  expect(noTrip.intents).toEqual([{ kind: "move", unitId: 0, dx: 1, dy: 0 }]);
  // 阈值降到一格 → 截停,意图作废。两条一起才说明「截停」是阈值造成的,不是脚本本身交不出。
  const tripped = await drainOneTick(bounded, { eventTickLimit: INTERRUPT_EVENT_GRANULARITY });
  expect(tripped.intents).toEqual([]);
  expect(tripped.observations[0]).toMatchObject({ kind: "tripped", track: EVENT_TRACK });
  // 未定值(字段缺席)下本轨不启用:同一脚本连观测都不产,意图照常交回。
  const disabled = await drainOneTick(bounded);
  expect(disabled.observations).toEqual([]);
  expect(disabled.intents).toEqual([{ kind: "move", unitId: 0, dx: 1, dy: 0 }]);
});

it("本 tick 的事件计数在下一 tick 进入时重置(读数逐 tick 稳定)", async () => {
  const limit = 10 * INTERRUPT_EVENT_GRANULARITY;
  const { runner, dispose } = await createQuickJsRunner({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: EVENT_SPIN_SCRIPT,
    seat: 0,
    eventTickLimit: limit,
  });
  try {
    runner.setSnapshot(snapshotOf(0));
    const first = runner.drainIntents().observations[0];
    runner.setSnapshot(snapshotOf(1));
    const second = runner.drainIntents().observations[0];
    // 每 tick 从 0 起算 → 两 tick 读数相同;若累计不重置,第二 tick 会翻倍到 2×limit。
    expect(first?.value).toBe(limit);
    expect(second?.value).toBe(limit);
  } finally {
    dispose();
  }
});

it("API 轰炸夹具被 API 调用计数截停(意图作废、产 tripped)", async () => {
  const output = await drainOneTick(API_FLOOD_SCRIPT, { apiCallTickLimit: 400 });
  // 夹具在打完之后下一笔 move:超限 → 该座位本 tick 的意图全部作废,那笔 move 不该出现。
  expect(output.intents).toEqual([]);
  expect(output.observations).toHaveLength(1);
  const tripped = output.observations[0];
  expect(tripped).toMatchObject({ kind: "tripped", track: API_CALL_TRACK, limit: 400 });
  expect(tripped?.value).toBeGreaterThanOrEqual(400);
});

it("API 计数轨只在启用时生效:同一轰炸脚本未启用时正常交回意图(能弄红的反例)", async () => {
  const output = await drainOneTick(API_FLOOD_SCRIPT);
  expect(output.observations).toEqual([]);
  expect(output.intents).toEqual([{ kind: "move", unitId: 0, dx: 1, dy: 0 }]);
});

it("本 tick 的 API 计数在下一 tick 进入时重置", async () => {
  // 每 tick 3 次调用、上限 4:两 tick 都不该超。若计数不重置,第二 tick 累到 6 就超了。
  const script = "function loop() { getTick(); getTick(); move(7, 1, 0); }";
  const { runner, dispose } = await createQuickJsRunner({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: script,
    seat: 0,
    apiCallTickLimit: 4,
  });
  try {
    runner.setSnapshot(snapshotOf(0));
    const first = runner.drainIntents();
    runner.setSnapshot(snapshotOf(1));
    const second = runner.drainIntents();
    expect(first.observations).toEqual([]);
    expect(second.observations).toEqual([]);
    expect(second.intents).toEqual([{ kind: "move", unitId: 7, dx: 1, dy: 0 }]);
  } finally {
    dispose();
  }
});

// ── 墙钟(票 09):软限只观测、硬超时作废而非判罚 ────────────────────────────

/**
 * 一段**有界但慢**的脚本:迭代 30 万次后才交回一笔 intent。它产生足够多的循环回边,
 * 使墙钟能被抽到样(每 `WALL_CLOCK_SAMPLE_INTERVAL` 次回调读一次钟),而自己会终上。
 */
const SLOW_SCRIPT = `function loop() {
  let acc = 0;
  for (let i = 0; i < 300000; i++) {
    acc = (acc + i) % 7;
  }
  move(acc, 1, 0);
}`;

it("墙钟软限:慢脚本产出一条 wall-clock-soft 观测(只观测、不判罚)", async () => {
  // 软限取 0:抽样到就必越。它与阈值高低无关,只验「越了软限就报一条」。
  const output = await drainOneTick(SLOW_SCRIPT, { wallClockSoftLimit: 0 });
  // 软限不判罚:意图照常交回(与 tripped 的「意图全部作废」相反)。
  expect(output.intents).toHaveLength(1);
  expect(output.observations).toHaveLength(1);
  const soft = output.observations[0];
  expect(soft).toMatchObject({ kind: "wall-clock-soft", track: WALL_CLOCK_TRACK, limit: 0 });
  expect(soft?.value).toBeGreaterThanOrEqual(0);
});

it("能弄红的反例:同一类脚本但回边不够,抽样不到就一条观测都不产", async () => {
  // 短脚本只产生远少于「每 5000 事件一格」的回边,回调一次不调,于是不抽样、不产观测。
  // 若把「读钟」做成每次 API 调用都做、或把软限当阈值无条件报,这一条红。
  const output = await drainOneTick("function loop() { move(0, 1, 0); }", {
    wallClockSoftLimit: 0,
  });
  expect(output.observations).toEqual([]);
  expect(output.intents).toHaveLength(1);
});

it("未定值(墙钟软限字段缺席)下本轨不启用:连回调都不装、不产观测", async () => {
  const output = await drainOneTick(SLOW_SCRIPT);
  expect(output.observations).toEqual([]);
});

it("墙钟硬超时:死循环被截停,交回 uncertain-timeout 故障位(作废而非判罚)", async () => {
  const output = await drainOneTick(EVENT_SPIN_SCRIPT, { wallClockHardTimeout: 1 });
  // 硬超时不产观测、不累加异常——它是一个故障位,不是一条读数。
  expect(output.fault).toBe("uncertain-timeout");
  expect(output.observations).toEqual([]);
  expect(output.intents).toEqual([]);
});

it("硬超时未触发时不置故障位,只有真的过了硬限才作废", async () => {
  const output = await drainOneTick("function loop() { move(0, 1, 0); }", {
    wallClockHardTimeout: 60000,
  });
  expect(output.fault).toBeUndefined();
  expect(output.intents).toHaveLength(1);
});

it("超限只作废该座位本 tick 的意图:其余三方照常结算、引擎不受影响", async () => {
  // 座位 0 是 API 轰炸的真执行器;座位 1 是普通桩,替一个存在的单位下一笔 move。
  const seeker = await createQuickJsRunner({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: API_FLOOD_SCRIPT,
    seat: 0,
    apiCallTickLimit: 400,
  });
  try {
    const state: GameState = {
      ...makeState(),
      units: [{ id: 50, owner: 1, type: "worker", x: 3, y: 3, hp: 2, carrying: 0 }],
    };
    const mover = stubRunner(() => [{ kind: "move", unitId: 50, dx: 1, dy: 0 }]);
    const result = processTick(
      state,
      [seeker.runner, mover, stubRunner(() => []), stubRunner(() => [])],
      loadRuleset(RULESET),
      { write: () => {} },
    );
    // 座位 0 累加一次异常;座位 1 的单位照常移动——超限不污染其他三方与引擎。
    expect(result.state.players.map((player) => player.exceptionTicks)).toEqual([1, 0, 0, 0]);
    expect(result.state.units.find((unit) => unit.id === 50)?.x).toBe(4);
  } finally {
    seeker.dispose();
  }
});

it("反复失控不能靠计数重置逃逸:exceptionTicks 跨 tick 单调不减,达上限即出局、点位回归中立", async () => {
  const { runner, dispose } = await createQuickJsRunner({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: EVENT_SPIN_SCRIPT,
    seat: 0,
    eventTickLimit: 10 * INTERRUPT_EVENT_GRANULARITY,
  });
  try {
    const idle = stubRunner(() => []);
    const budget = { exceptionTickLimit: 2 };
    const readings: number[][] = [];
    let state = makeState();
    for (let i = 0; i < 3; i++) {
      state = processTick(
        state,
        [runner, idle, idle, idle],
        loadRuleset(RULESET),
        { write: () => {} },
        undefined,
        budget,
      ).state;
      readings.push(state.players.map((player) => player.exceptionTicks));
    }
    // 单调不减:1 → 2 → 2(出局后不再累加)。
    expect(readings[0]).toEqual([1, 0, 0, 0]);
    expect(readings[1]).toEqual([2, 0, 0, 0]);
    expect(readings[2]).toEqual([2, 0, 0, 0]);
    // 达上限即出局,名下点位回归中立。
    expect(state.players[0]?.alive).toBe(false);
    expect(state.sites.find((site) => site.id === 900)?.owner).toBe(-1);
  } finally {
    dispose();
  }
});

// ── 判定 → 累加异常计数(经步 0 的唯一写入口) ───────────────────────────────
//
// 观测不自己写状态:`tripped` 搭同一次返回载荷回到步 0,由它落成一条 `count-exception-tick`
// 变更(票 02 已接通的路径)。这里用真执行器把那条路径端到端跑一遍。

const RULESET: Ruleset = {
  tickLimit: 600,
  captureTicks: 10,
  initialResources: 16,
  harvestRate: 1,
  carryLimit: 20,
  resourcePerSite: 200,
  worker: { cost: 4, hp: 2, damage: 0, range: 1, speed: 1, spawnTicks: 2 },
  melee: { cost: 8, hp: 12, damage: 3, range: 1, speed: 1, spawnTicks: 4 },
  ranged: { cost: 12, hp: 4, damage: 2, range: 2, speed: 1, spawnTicks: 6 },
  cavalry: { cost: 16, hp: 6, damage: 2, range: 1, speed: 2, spawnTicks: 8 },
  baseScore: 4,
  resourceScore: 1,
  unitCostDivisor: 6,
  exceptionTickLimit: 0,
  eventTickLimit: 0,
  apiCallTickLimit: 0,
  memoryLimit: 0,
  memoryTickCeiling: 0,
  wallClockSoftLimit: 0,
  wallClockHardTimeout: 0,
  scriptSizeLimit: 0,
};

/** 四席各一个哨兵基地:没有它,空状态会在步 5 把所有席位淘汰掉,凭空多出状态变化。 */
const SEAT_BASES: readonly Site[] = [0, 1, 2, 3].map((seat) => ({
  id: 900 + seat,
  kind: "base",
  x: 900 + seat,
  y: 900,
  owner: seat as PlayerIndex,
  progressOwner: -1,
  progress: 0,
  producing: null,
}));

const plain = (size: number): Terrain =>
  Array.from({ length: size }, () => Array.from({ length: size }, () => false));

const makeState = (): GameState => ({
  tick: 0,
  size: 8,
  terrain: plain(8),
  players: [0, 1, 2, 3].map((index) => ({
    index: index as PlayerIndex,
    resources: 16,
    alive: true,
    exceptionTicks: 0,
  })),
  units: [],
  sites: SEAT_BASES,
  nextId: 100,
  outcome: null,
  eliminatedAtTick: [null, null, null, null],
  firstContactTick: null,
  economyDeadAtTick: [null, null, null, null],
});

it("撑内存的座位经步 0 累加 exceptionTicks(观测 → 唯一写入口)", async () => {
  const ceiling = (await baselineAliveHeap()) + MIB;
  const { runner, dispose } = await createQuickJsRunner({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: HOARD_SCRIPT,
    seat: 0,
    memoryTickCeiling: ceiling,
  });
  try {
    const idle = stubRunner(() => []);
    const result = processTick(makeState(), [runner, idle, idle, idle], loadRuleset(RULESET), {
      write: () => {},
    });
    expect(result.state.players.map((player) => player.exceptionTicks)).toEqual([1, 0, 0, 0]);
  } finally {
    dispose();
  }
});
