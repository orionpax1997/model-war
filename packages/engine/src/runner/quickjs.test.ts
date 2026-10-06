/**
 * 真沙箱执行器(票 03):生命周期、删桥、三件套、排空到不动点与内存隔离。
 *
 * 它钉的是**缝上的外部行为**:脚本看不见桥、VM 之间互不可见、同一份脚本得到同一序列、
 * 意图在该交回的 tick 交回。`StubRunner` 的对应断言在 `stub.test.ts`,两边的「缝只有两个方法」
 * 是同一条纪律的两个适配器。
 *
 * 测试文件可以读盘与引 esbuild(依赖门禁只管运行时代码):wasm 与 runtime bundle 都在这里现造。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { expect, it, beforeAll } from "vitest";
import type { QuickJS } from "quickjs-wasi";

import type { Snapshot } from "../world/state.js";
import { HOST_BRIDGE_DRAIN_INTENTS, HOST_BRIDGE_SET_SNAPSHOT } from "./index.js";
import { WASI_CLOCK_MS, createQuickJsRunner, createSandboxVm, openSandbox } from "./quickjs.js";

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
    expect(session.drainIntents()).toEqual([]);

    session.setSnapshot(snapshotOf(1));
    session.runLoop();
    // 上一 tick 的 job 在这里才跑——它把 tick 0 的意图带进了 tick 1 的交回里。
    expect(session.pumpJobs()).toBeGreaterThan(0);
    expect(session.drainIntents()).toEqual([{ kind: "move", unitId: 1, dx: 1, dy: 0 }]);
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
