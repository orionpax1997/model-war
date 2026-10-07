/**
 * 票 03:预算标定探针的骨架(缝 A:引擎侧「读数测试 + `MW_READINGS_DIR` 落盘」约定)与**两个量测探针**。
 *
 * ── 它交付什么 ──
 *
 * 两个读数,只做数与测法、**不放任何建议阈值**(取值是后续票的事):
 * ①**分配上限的封顶**:`memoryLimit − 读出封顶`,以及它如何随分配形态变化;②**装 runtime bundle
 * 之后的存活堆基线**,与空 VM 基线(`EMPTY_VM_MALLOC_SIZE = 75128`,冻结常量的家是
 * `packages/tools/src/sandbox-probes/constants.ts`)分列。
 *
 * ── 骨架来自哪 ──
 *
 * `packages/engine/src/runner/probe-harness.ts` 的 `createProbeSeat` 逐条镜像
 * `createQuickJsRunner` 的每 tick 次序、不改任何判定(它的头注记着两个必须继承的坑)。
 * 它长自一次性 prototype `.scratch/budget-calibration/prototype/readings-probe.mjs`,不是新起一份。
 *
 * ── 规模:默认小,读数时按 env 放大 ──
 *
 * check 链上每跑一次都要便宜:默认样本很小(一个分配形态、1 MiB 上限),只在 `MW_READINGS_DIR`
 * 设上时才展开(四个形态、8 MiB 上限、基线取多次)。复现命令见 `readings.md` 与根 `package.json`
 * 的 `probes:budget`。**不设读数目录时零文件副作用**——落盘全在这一个闸门后面。
 *
 * ── 为什么不另写「读数等于某个数」的断言 ──
 *
 * 读数是交付物,断言由既有的执行器行为用例负责(见 `quickjs.test.ts`)。把读数的具体值写进
 * `expect` 只会把一次快照钉死成一条永远会漂的断言;本条只钉「探针真的跑完了、读数形状良好」。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, it } from "vitest";
import {
  QUICKJS_WASI_VERSION,
  SANDBOX_RUNTIME_ARTIFACT_PATH,
  SANDBOX_RUNTIME_HASH,
} from "@model-war/replay";

import { NEVER_EVENT_LIMIT, createProbeSeat } from "./probe-harness.js";
import { INTERRUPT_EVENT_GRANULARITY, createSandboxVm } from "./quickjs.js";
import type { Snapshot } from "../world/state.js";

/** 一份最小快照:探针脚本不读状态,骨架能把它交进 guest 即可。 */
const snapshotOf = (tick: number): Snapshot => ({
  tick,
  size: 0,
  terrain: [],
  players: [],
  units: [],
  sites: [],
});

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const wasmPath = fileURLToPath(import.meta.resolve("quickjs-wasi/quickjs.wasm"));
/** 被测运行时字节 = **入库产物**(不是现打的 bundle),这样读数才对得上 `SANDBOX_RUNTIME_HASH`。 */
const artifactPath = `${root}${SANDBOX_RUNTIME_ARTIFACT_PATH}`;

/** 空 VM 基线的冻结常量真源(引擎不能 import 工具包,只在读数里带指针)。 */
const FROZEN_EMPTY_VM_MALLOC_SIZE = 75_128;
const FROZEN_EMPTY_VM_SOURCE = "packages/tools/src/sandbox-probes/constants.ts:54";

/** 样本规模:默认小,读数时按 env 放大。非法值退回默认,不静默取 0(与 `fixtures.test.ts` 同形)。 */
const envN = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** 读数落盘目录。**只有设了才写**——check 链上不该有文件副作用。 */
const readingsDir = process.env["MW_READINGS_DIR"];
const fullSample = readingsDir !== undefined;

/** 分配上限探针用的 `memoryLimit`(字节)。 */
const capMemoryLimitBytes = envN("MW_CAP_LIMIT_BYTES", fullSample ? 8 << 20 : 1 << 20);
/** 分配形态轴:每次请求一块多少字节的 `Uint8Array`。默认只跑一档。 */
const capRequestBytes = fullSample ? [64 << 10, 256 << 10, 1 << 20, 4 << 20] : [64 << 10];
/** 装 bundle 之后的基线取几次读数(只报 min/max,不取均值)。 */
const baselineSamples = envN("MW_BASELINE_SAMPLES", fullSample ? 3 : 1);

let wasmModule: WebAssembly.Module;
let runtimeCode: string;

beforeAll(async () => {
  wasmModule = await WebAssembly.compile(readFileSync(wasmPath));
  runtimeCode = readFileSync(artifactPath, "utf8");
});

type CapShape = {
  readonly requestBytes: number;
  readonly chunksRetained: number;
  readonly observedCapBytes: number;
  readonly headroomBytes: number;
  readonly capRatioPpm: number;
  readonly eventGrid: number;
};

type Baseline = {
  readonly emptyVmMallocSize: number;
  readonly frozenEmptyVmMallocSize: number;
  readonly frozenEmptyVmSource: string;
  readonly loadedRuntimeMallocSamples: readonly number[];
  readonly samples: number;
};

const collected: {
  allocationCeiling?: { memoryLimitBytes: number; shapes: CapShape[] };
  aliveHeapBaseline?: Baseline;
} = {};

/**
 * 一次请求 `requestBytes` 字节并攥住,直到 guest 内捕获 `InternalError: out of memory` 后停手;
 * 把攥住的块数经一笔 `move` 交回(只为一个可读的「形态」说明,不参与任何判定)。
 */
const hoardScript = (requestBytes: number): string =>
  [
    "var hoard = [];",
    "function loop() {",
    "  if (hoard.length > 0) { return; }",
    "  for (;;) {",
    `    try { hoard.push(new Uint8Array(${String(requestBytes)})); } catch (_error) { break; }`,
    "  }",
    "  move(hoard.length, 0, 0);",
    "}",
  ].join("\n");

it("量测探针①:分配上限的封顶随分配形态变化(memoryLimit − 读出封顶)", async () => {
  const shapes: CapShape[] = [];
  for (const requestBytes of capRequestBytes) {
    const seat = await createProbeSeat({
      wasm: wasmModule,
      runtimeCode,
      scriptCode: hoardScript(requestBytes),
      seat: 0,
      memoryLimit: capMemoryLimitBytes,
      eventTickLimit: NEVER_EVENT_LIMIT,
    });
    try {
      seat.runner.setSnapshot(snapshotOf(0));
      const output = seat.runner.drainIntents();
      const reading = seat.readings[0];
      if (reading === undefined) {
        throw new Error("探针没有记下这一 tick 的读数");
      }
      const first = output.intents[0];
      const chunksRetained = first !== undefined && first.kind === "move" ? first.unitId : 0;
      shapes.push({
        requestBytes,
        chunksRetained,
        observedCapBytes: reading.mallocSize,
        headroomBytes: capMemoryLimitBytes - reading.mallocSize,
        capRatioPpm: Math.round((reading.mallocSize * 1_000_000) / capMemoryLimitBytes),
        eventGrid: reading.eventGrid,
      });
    } finally {
      seat.dispose();
    }
  }
  collected.allocationCeiling = { memoryLimitBytes: capMemoryLimitBytes, shapes };
  // 读数形状良好:每个形态都真的把堆顶到了 OOM 边界,封顶必然小于分配上限。
  expect(shapes).toHaveLength(capRequestBytes.length);
  for (const shape of shapes) {
    expect(shape.headroomBytes).toBeGreaterThan(0);
  }
});

it("量测探针②:装 runtime bundle 之后的存活堆基线(与空 VM 基线分列)", async () => {
  // 空 VM 基线:裸 VM(无 runtime、无脚本),与冻结常量同口径。
  const emptyVm = await createSandboxVm({ wasm: wasmModule });
  let emptyVmMallocSize: number;
  try {
    emptyVmMallocSize = emptyVm.getMemoryUsage().mallocSize;
  } finally {
    emptyVm.dispose();
  }

  // 装 runtime bundle 之后:入库产物 + 空脚本,每 tick 末强制回收之后的存活堆。
  // 这里显式传 `eventTickLimit: null`(不装计数回调),与内存判据的口径一致——内存轨启用时
  // 不装回调;分配封顶探针则装回调以同时记下事件格数。
  const loadedRuntimeMallocSamples: number[] = [];
  for (let sample = 0; sample < baselineSamples; sample++) {
    const seat = await createProbeSeat({
      wasm: wasmModule,
      runtimeCode,
      scriptCode: "function loop() {}",
      seat: 0,
      eventTickLimit: null,
    });
    try {
      seat.runner.setSnapshot(snapshotOf(sample));
      seat.runner.drainIntents();
      const reading = seat.readings[0];
      if (reading === undefined) {
        throw new Error("探针没有记下这一 tick 的读数");
      }
      loadedRuntimeMallocSamples.push(reading.mallocSize);
    } finally {
      seat.dispose();
    }
  }

  collected.aliveHeapBaseline = {
    emptyVmMallocSize,
    frozenEmptyVmMallocSize: FROZEN_EMPTY_VM_MALLOC_SIZE,
    frozenEmptyVmSource: FROZEN_EMPTY_VM_SOURCE,
    loadedRuntimeMallocSamples,
    samples: baselineSamples,
  };
  // 装 bundle 之后必然比空 VM 高;两个口径分列正是本条的目的。
  expect(emptyVmMallocSize).toBeGreaterThan(0);
  expect(Math.min(...loadedRuntimeMallocSamples)).toBeGreaterThan(0);
});

const SCOPE =
  "各一次会话、无地图与规则集参与(探针脚本不读状态、不判据);读数取在 tick 末强制回收之后的存活堆 " +
  "mallocSize,与内存判据同口径。整数会随运行环境微动,量级稳定。";

type Report = {
  readonly meta: {
    readonly sandboxRuntimeHash: string;
    readonly sandboxRuntimeArtifact: string;
    readonly quickjsWasiVersion: string;
    readonly interruptEventGranularity: number;
    readonly rerunCommand: string;
    readonly scope: string;
  };
  readonly allocationCeiling: { readonly memoryLimitBytes: number; readonly shapes: CapShape[] };
  readonly aliveHeapBaseline: Baseline;
};

const buildReport = (): Report => {
  const allocationCeiling = collected.allocationCeiling;
  const aliveHeapBaseline = collected.aliveHeapBaseline;
  if (allocationCeiling === undefined || aliveHeapBaseline === undefined) {
    throw new Error("探针没有跑完,读数不完整");
  }
  return {
    meta: {
      sandboxRuntimeHash: SANDBOX_RUNTIME_HASH,
      sandboxRuntimeArtifact: SANDBOX_RUNTIME_ARTIFACT_PATH,
      quickjsWasiVersion: QUICKJS_WASI_VERSION,
      interruptEventGranularity: INTERRUPT_EVENT_GRANULARITY,
      rerunCommand: "pnpm run probes:budget",
      scope: SCOPE,
    },
    allocationCeiling,
    aliveHeapBaseline,
  };
};

const renderReadingsMarkdown = (report: Report): string => {
  const capRows = report.allocationCeiling.shapes.map(
    (shape) =>
      `| ${String(shape.requestBytes)} | ${String(shape.chunksRetained)} | ${String(
        shape.observedCapBytes,
      )} | ${String(shape.headroomBytes)} | ${(shape.capRatioPpm / 10_000).toFixed(2)}% | ${String(
        shape.eventGrid,
      )} |`,
  );
  const loaded = report.aliveHeapBaseline.loadedRuntimeMallocSamples;
  const loadedMin = Math.min(...loaded);
  const loadedMax = Math.max(...loaded);
  return [
    "# 预算标定探针读数(票 03:探针骨架 + 两个量测探针)",
    "",
    "> 本文件**只放数与测法,不放任何建议阈值**——取值是后续票的事。",
    "",
    `复现命令:\`${report.meta.rerunCommand}\``,
    "",
    "## 口径与方法",
    "",
    `- 沙箱运行时哈希:\`${report.meta.sandboxRuntimeHash}\`(真值,来自 \`@model-war/replay\` 的`,
    `  \`SANDBOX_RUNTIME_HASH\`;被测字节 = 入库产物 \`${report.meta.sandboxRuntimeArtifact}\`)。`,
    `- quickjs-wasi \`${report.meta.quickjsWasiVersion}\`;中断粒度 \`INTERRUPT_EVENT_GRANULARITY = ${String(
      report.meta.interruptEventGranularity,
    )}\`。`,
    "- 探针骨架逐条镜像 `createQuickJsRunner` 的每 tick 次序",
    "  (`beginTick → loop → pumpJobs → endTick → runGC → memoryUsage → drainIntents`),不改任何判定。",
    "- 内存读数取在 tick 末 `runGC()` 之后的存活堆 `mallocSize`(与内存判据同口径)。",
    `- 事件读数按**格数**记(\`eventCount / ${String(
      report.meta.interruptEventGranularity,
    )}\`):wasm 侧计数器跨调用不清零、有相位残留,按事件数记会把残影当读数。`,
    "- 事件读数只有在构造 VM 时显式给一个极大上限才拿得到(计数回调只能构造时装);探针①给",
    "  `eventTickLimit = MAX_SAFE_INTEGER`,探针②不装回调(与内存判据的口径一致)。",
    `- 作用域:${report.meta.scope}`,
    "",
    "## 探针①:分配上限的封顶",
    "",
    `\`memoryLimit = ${String(
      report.allocationCeiling.memoryLimitBytes,
    )}\` 字节。脚本每次请求一块 \`new Uint8Array(requestBytes)\` 并攥住,直到 guest 内捕获`,
    "`InternalError: out of memory` 后停手;「读出封顶」= 停手后 tick 末强制回收的存活堆读数。",
    "",
    "| 单次请求字节 | 攥住的块数 | 读出封顶(bytes) | memoryLimit − 封顶 | 封顶 / memoryLimit | 事件格数 |",
    "|---|---|---|---|---|---|",
    ...capRows,
    "",
    "**封顶随分配形态变化**:单次请求越小,能塞进的块越多、封顶越贴近 `memoryLimit`;单次请求越大,",
    "封顶越接近 `memoryLimit − 请求量`——最后一块塞不下时整块都记不上账,`memoryLimit − 封顶` 里",
    "就留下了那一整块的量级。这就是「分配上限 − 最大单次分配」那条夹逼上界没有可代入定值的原因。",
    "",
    "## 探针②:装 runtime bundle 之后的存活堆基线",
    "",
    "| 口径 | mallocSize 字节 |",
    "|---|---|",
    `| 空 VM(冻结常量 \`EMPTY_VM_MALLOC_SIZE\`,来源 \`${report.aliveHeapBaseline.frozenEmptyVmSource}\`) | ${String(
      report.aliveHeapBaseline.frozenEmptyVmMallocSize,
    )} |`,
    `| 空 VM(本探针同口径实测,\`createSandboxVm\`) | ${String(
      report.aliveHeapBaseline.emptyVmMallocSize,
    )} |`,
    `| 装 runtime bundle + 空脚本,每 tick 末 runGC 后(min/max,${String(
      report.aliveHeapBaseline.samples,
    )} 次) | ${String(loadedMin)} / ${String(loadedMax)} |`,
    "",
    "两个基线**分列**是这一条的目的:75,128 是「**空 VM**、没有 runtime bundle、没有脚本」的基线,",
    "而它的下一行才是「装 bundle 之后」的基线——两者的差就是运行时本身占的存活堆。",
    "",
  ].join("\n");
};

afterAll(() => {
  if (readingsDir === undefined) {
    return;
  }
  const report = buildReport();
  const dir = `${root}${readingsDir}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/readings.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(`${dir}/readings.md`, renderReadingsMarkdown(report), "utf8");
});
