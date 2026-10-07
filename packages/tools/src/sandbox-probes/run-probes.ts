/**
 * 沙箱行为五条复验探针(根脚本 `pnpm run probes:sandbox`)。
 *
 * 用法:`node packages/tools/src/sandbox-probes/run-probes.ts`(或 `pnpm run probes:sandbox`)。
 * **不进** `check:quick`,也**不进**默认 `test`:它真装 VM、真跑行为,不是每次编辑都该付的成本。
 * 只在按当时版本组合复验 hld §5.0 那五条结论时跑;输出落盘到 `PROBE_OUTPUT_DIR`(可入库复核),
 * 退出码 0/1(与本仓库其余命名脚本同形)。
 *
 * ── 为什么探针不 import 引擎 ──
 * 它断言的是 hld §5.0 那五条**关于运行时本身**的行为,不是引擎的内部结构。直接驱动
 * `quickjs-wasi` 的 VM,引擎内部重构不会让它红;它红了就说明运行时行为真的变了(见 `lib.ts`)。
 *
 * ── 五条与 hld 的对应 ──
 * ① 脚本入口契约(`docs/hld.md:563`);② 深递归失败形态(`:564`);
 * ③ `interruptHandler` 粒度与不可捕获性(`:565`);④ 内存读数口径与封顶(`:566`);
 * ⑤ 删桥后的不可见性(`:567`)。**每条判不过的报错信息都带上它对应的 hld 行号**。
 *
 * ── 判据的两种信任来源 ──
 * **数值类是 `constants.ts` 里已冻结的常量**(粒度 5000、空 VM 基线 75128/64098、分配上限);
 * **计时类才是区间**(纯计数回调的拖慢上限 `INTERRUPT_SLOWDOWN_BAND_PERCENT`)。
 * 把计时写成点值、把数值写成区间,都会让「红了到底算不算出问题」失去意义。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { QuickJS } from "quickjs-wasi";

import {
  EMPTY_VM_MALLOC_SIZE,
  EMPTY_VM_MEMORY_USED_SIZE,
  INTERRUPT_EVERY_EVENTS,
  INTERRUPT_GRANULARITY_LOOP_ITERATIONS,
  INTERRUPT_GRANULARITY_SAMPLE_EVENTS,
  INTERRUPT_SLOWDOWN_BAND_PERCENT,
  MEMORY_LIMIT_BYTES,
  PROBE_OUTPUT_DIR,
  PROBED_ENVIRONMENT,
  PROBED_NODE_MAJOR,
  PROBED_ON,
  PROBED_QUICKJS_WASI_VERSION,
} from "./constants.ts";
import { evalValue, loadWasmModule, tryEval } from "./lib.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

type Outcome = { readonly name: string; readonly passed: boolean; readonly detail: string };

type Recorder = {
  readonly section: (title: string) => void;
  readonly check: (name: string, passed: boolean, detail: string) => void;
  readonly note: (line: string) => void;
};

type ProbeResult = {
  readonly id: string;
  readonly slug: string;
  readonly hldLine: string;
  readonly lines: readonly string[];
  readonly outcomes: readonly Outcome[];
};

type Probe = {
  readonly id: string;
  readonly slug: string;
  readonly hldLine: string;
  readonly run: (wasm: WebAssembly.Module, record: Recorder) => Promise<void>;
};

const makeRecorder = (
  hldLine: string,
  lines: string[],
): { readonly record: Recorder; readonly outcomes: Outcome[] } => {
  const outcomes: Outcome[] = [];
  const record: Recorder = {
    section: (title) => {
      lines.push(`── ${title} ──`);
    },
    note: (line) => {
      lines.push(`   ${line}`);
    },
    check: (name, passed, detail) => {
      outcomes.push({ name, passed, detail });
      const mark = passed ? "✓" : "✗";
      const suffix = passed ? "" : `（${hldLine}）`;
      lines.push(`${mark} ${name}${suffix}${detail === "" ? "" : `：${detail}`}`);
    },
  };
  return { record, outcomes };
};

// ── ① 脚本入口契约(docs/hld.md:563) ────────────────────────────────────────

const probeEntryContract: Probe = {
  id: "01",
  slug: "script-entry-contract",
  hldLine: "docs/hld.md:563",
  run: async (wasm, record) => {
    const vm = await QuickJS.create({ wasm });
    try {
      record.section("单文件 script-mode 产物可载入，loop 是 function 且可调用");
      const product = ["function loop() {", "  return 1;", "}", ""].join("\n");
      vm.evalCode(product, "script.js").dispose();
      const entry = vm.global.getProp("loop");
      record.check(
        "loop 是 function",
        vm.typeof(entry) === "function",
        `typeof loop = ${vm.typeof(entry)}`,
      );
      const called = vm.callFunction(entry, vm.undefined).consume((handle) => vm.dump(handle));
      record.check("callFunction(loop) 调得动", called === 1, `返回 ${JSON.stringify(called)}`);
      entry.dispose();

      for (const [label, source] of [
        ["带 export 的产物", "export function loop() { return 1; }"],
        ["带 import 的产物", 'import x from "./y.js";\nfunction loop() { return 1; }'],
      ] as const) {
        const outcome = tryEval(vm, source, "script.js");
        record.check(
          `${label}载入期即 SyntaxError`,
          !outcome.ok && outcome.error.name === "SyntaxError" && outcome.error.isJSException,
          outcome.ok ? "载入成功（未报错）" : `${outcome.error.name}: ${outcome.error.message}`,
        );
      }
    } finally {
      vm.dispose();
    }
  },
};

// ── ② 深递归的失败形态(docs/hld.md:564) ────────────────────────────────────

const probeDeepRecursion: Probe = {
  id: "02",
  slug: "deep-recursion",
  hldLine: "docs/hld.md:564",
  run: async (wasm, record) => {
    record.section("深递归溢出是 host 侧 RangeError，不是 JSException，且 VM 可续用");
    const vm = await QuickJS.create({ wasm });
    try {
      const outcome = tryEval(
        vm,
        "function f(n) { return n <= 0 ? 0 : 1 + f(n - 1); } f(1e9);",
        "deep.js",
      );
      record.check(
        "溢出抛 host RangeError",
        !outcome.ok && outcome.error.name === "RangeError",
        outcome.ok ? "未抛异常" : `${outcome.error.ctor}: ${outcome.error.name}`,
      );
      record.check(
        "isJSException === false（host 异常，guest 吞不掉）",
        !outcome.ok && outcome.error.isJSException === false,
        outcome.ok
          ? "未抛异常"
          : `isJSException = ${String(!outcome.ok && outcome.error.isJSException)}`,
      );
      record.check(
        "message 为 Maximum call stack size exceeded",
        !outcome.ok && /maximum call stack/i.test(outcome.error.message),
        outcome.ok ? "未抛异常" : outcome.error.message,
      );
      record.check("VM 溢出后仍可续用", evalValue(vm, "1 + 1") === 2, "eval 1+1");
      record.check(
        "executePendingJobs 返回 0（无残留 job）",
        vm.executePendingJobs() === 0,
        "drain 到不动点",
      );
    } finally {
      vm.dispose();
    }
  },
};

// ── ③ interruptHandler 的粒度与不可捕获性(docs/hld.md:565) ──────────────────

const probeInterrupt: Probe = {
  id: "03",
  slug: "interrupt-granularity",
  hldLine: "docs/hld.md:565",
  run: async (wasm, record) => {
    record.section("粒度：每 5000 次控制流事件一次回调（差分测量，与相位无关）");
    const counter = { callbacks: 0 };
    const counting = await QuickJS.create({
      wasm,
      interruptHandler: () => {
        counter.callbacks += 1;
        return false;
      },
    });
    const loopCode = (iterations: number): string =>
      `(function () { let s = 0; for (let i = 0; i < ${String(iterations)}; i += 1) { s += i; } return s; })()`;
    try {
      // 差分测量:第一次求值把内部计数器推到某个相位(入口处那一次回调只发生一次);
      // 之后比较「多跑 50000 次回边」与「基准」各自新增的回调数,差就是那 50000 次事件。
      evalValue(counting, loopCode(INTERRUPT_GRANULARITY_LOOP_ITERATIONS));
      const beforeBase = counter.callbacks;
      evalValue(counting, loopCode(INTERRUPT_GRANULARITY_LOOP_ITERATIONS));
      const afterBase = counter.callbacks;
      evalValue(
        counting,
        loopCode(INTERRUPT_GRANULARITY_LOOP_ITERATIONS + INTERRUPT_GRANULARITY_SAMPLE_EVENTS),
      );
      const afterSample = counter.callbacks;
      const baseIncrement = afterBase - beforeBase;
      const delta = afterSample - afterBase - baseIncrement;
      const expected = INTERRUPT_GRANULARITY_SAMPLE_EVENTS / INTERRUPT_EVERY_EVENTS;
      record.check(
        `多 ${String(INTERRUPT_GRANULARITY_SAMPLE_EVENTS)} 次回边恰好多 ${String(expected)} 次回调`,
        delta === expected,
        `实测差分 ${String(delta)} 次回调（每 ${String(INTERRUPT_GRANULARITY_SAMPLE_EVENTS / (delta === 0 ? 1 : delta))} 次事件一格）`,
      );

      record.section("中断语义：host InternalError，guest try/catch 体不执行，VM 续用");
      const fired = { count: 0 };
      const interrupting = await QuickJS.create({
        wasm,
        // 第一次回调发生在程序入口（所以锁存到第 3 次，保证 try 体已被进入、catch 体未被执行）。
        interruptHandler: () => {
          fired.count += 1;
          return fired.count >= 3;
        },
      });
      try {
        const outcome = tryEval(
          interrupting,
          [
            'globalThis.__ran = "start";',
            "try {",
            "  for (let i = 0; i < 1e9; i += 1) {}",
            '  globalThis.__ran = "completed";',
            "} catch (e) {",
            '  globalThis.__ran = "caught";',
            "}",
          ].join("\n"),
          "spin.js",
        );
        record.check(
          "中断以 host InternalError: interrupted 呈现",
          !outcome.ok &&
            outcome.error.name === "InternalError" &&
            /interrupt/i.test(outcome.error.message) &&
            outcome.error.isJSException,
          outcome.ok ? "未抛异常" : `${outcome.error.name}: ${outcome.error.message}`,
        );
        record.check(
          "guest try/catch 体不执行",
          evalValue(interrupting, "globalThis.__ran") === "start",
          `__ran = ${JSON.stringify(evalValue(interrupting, "globalThis.__ran"))}`,
        );
        record.check(
          "VM 中断后仍可续用",
          evalValue(interrupting, "40 + 2") === 42,
          `回调触发 ${String(fired.count)} 次`,
        );
      } finally {
        interrupting.dispose();
      }
    } finally {
      counting.dispose();
    }

    record.section(`计时：纯计数回调的拖慢落在区间 ±${String(INTERRUPT_SLOWDOWN_BAND_PERCENT)}%`);
    const iterations = 2_000_000;
    const benchCode = loopCode(iterations);
    const timeOnce = (vm: QuickJS): number => {
      const start = process.hrtime.bigint();
      vm.evalCode(benchCode, "bench.js").dispose();
      return Number(process.hrtime.bigint() - start) / 1e6;
    };
    const median = (samples: readonly number[]): number => {
      const sorted = [...samples].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };
    const plain = await QuickJS.create({ wasm });
    const countedCallbacks = { count: 0 };
    const counted = await QuickJS.create({
      wasm,
      // 纯计数回调：只自增一次就返回 false。这是 hld §5.0 结论 ③ 测的那个开销。
      interruptHandler: () => {
        countedCallbacks.count += 1;
        return false;
      },
    });
    try {
      // 两个 VM 各预热两轮，再**交错**采样：分两次跑（先跑完 plain 再跑 counted）会被
      // 进程冷热漂移主导（实测过 −22% 的假读数），交错采样把漂移摊到两条序列上。
      for (let warmup = 0; warmup < 2; warmup += 1) {
        timeOnce(plain);
        timeOnce(counted);
      }
      const plainSamples: number[] = [];
      const countedSamples: number[] = [];
      for (let rep = 0; rep < 9; rep += 1) {
        plainSamples.push(timeOnce(plain));
        countedSamples.push(timeOnce(counted));
      }
      const base = median(plainSamples);
      const withHandler = median(countedSamples);
      const slowdown = base === 0 ? 0 : (100 * (withHandler - base)) / base;
      record.check(
        `拖慢绝对值 ≤ ${String(INTERRUPT_SLOWDOWN_BAND_PERCENT)}%（计时类判据用区间）`,
        Math.abs(slowdown) <= INTERRUPT_SLOWDOWN_BAND_PERCENT,
        `交错采样中位拖慢 ${slowdown.toFixed(2)}%（无回调 ${base.toFixed(1)}ms / 计数回调 ${withHandler.toFixed(1)}ms；本轮触发 ${String(countedCallbacks.count)} 次）`,
      );
    } finally {
      plain.dispose();
      counted.dispose();
    }
  },
};

// ── ④ 内存读数口径与封顶(docs/hld.md:566) ──────────────────────────────────

const probeMemory: Probe = {
  id: "04",
  slug: "memory-reading",
  hldLine: "docs/hld.md:566",
  run: async (wasm, record) => {
    record.section("读数口径：getMemoryUsage() 的字段与空 VM 基线");
    const vm = await QuickJS.create({ wasm });
    try {
      const usage = vm.getMemoryUsage();
      const raw = usage as unknown as Record<string, unknown>;
      record.check(
        "有 mallocSize 字段（判据读数）",
        typeof usage.mallocSize === "number",
        `mallocSize = ${String(usage.mallocSize)}`,
      );
      record.check(
        "有 objCount 字段，没有 objectCount（对象数是 objCount）",
        typeof raw["objCount"] === "number" && !("objectCount" in raw),
        `objCount = ${String(raw["objCount"])}，objectCount ${"objectCount" in raw ? "存在" : "不存在"}`,
      );
      record.check(
        `空 VM 基线 mallocSize === ${String(EMPTY_VM_MALLOC_SIZE)}`,
        usage.mallocSize === EMPTY_VM_MALLOC_SIZE,
        `实测 ${String(usage.mallocSize)}`,
      );
      record.check(
        `空 VM 基线 memoryUsedSize === ${String(EMPTY_VM_MEMORY_USED_SIZE)}`,
        usage.memoryUsedSize === EMPTY_VM_MEMORY_USED_SIZE,
        `实测 ${String(usage.memoryUsedSize)}`,
      );
      record.check(
        "mallocSize > memoryUsedSize（后者不含空闲池，不作判据）",
        usage.mallocSize > usage.memoryUsedSize,
        `${String(usage.mallocSize)} > ${String(usage.memoryUsedSize)}`,
      );
    } finally {
      vm.dispose();
    }

    record.section(`封顶：memoryLimit = ${String(MEMORY_LIMIT_BYTES)} 字节时的表现`);
    const limited = await QuickJS.create({ wasm, memoryLimit: MEMORY_LIMIT_BYTES });
    try {
      record.check(
        "小额分配成功",
        tryEval(limited, "globalThis.__a = new Array(100000).fill(1); 'ok';").ok,
        "new Array(100000)",
      );
      const outcome = tryEval(limited, "globalThis.__b = new Array(100000000).fill(1); 'ok';");
      record.check(
        "超限为可捕获的 InternalError: out of memory",
        !outcome.ok &&
          outcome.error.name === "InternalError" &&
          /out of memory/i.test(outcome.error.message),
        outcome.ok ? "未抛异常" : `${outcome.error.name}: ${outcome.error.message}`,
      );
      const after = limited.getMemoryUsage().mallocSize;
      record.check(
        `超限后读数不越过 memoryLimit（封顶 = limit − 最大单次分配）`,
        after < MEMORY_LIMIT_BYTES,
        `实测 ${String(after)} < ${String(MEMORY_LIMIT_BYTES)}`,
      );
      record.check("VM 超限后仍可续用", evalValue(limited, "7 * 6") === 42, "eval 7*6");
    } finally {
      limited.dispose();
    }
  },
};

// ── ⑤ 宿主桥函数删除后的不可见性(docs/hld.md:567) ──────────────────────────

const probeBridgeDeletion: Probe = {
  id: "05",
  slug: "bridge-deletion",
  hldLine: "docs/hld.md:567",
  run: async (wasm, record) => {
    record.section("删桥后：枚举不到、捞不回来，闭包通道仍可用");
    const vm = await QuickJS.create({ wasm });
    try {
      evalValue(vm, "globalThis.__bridge = function () { return 123; };");
      evalValue(
        vm,
        "const captured = __bridge; globalThis.callCaptured = function () { return captured(); };",
      );
      const handle = vm.global.getProp("__bridge");
      evalValue(vm, 'delete globalThis["__bridge"];');

      const enumerated = evalValue(
        vm,
        'Object.getOwnPropertyNames(globalThis).filter(function (k) { return k.indexOf("__") === 0; });',
      );
      record.check(
        "按 __ 前缀枚举为空",
        Array.isArray(enumerated) && enumerated.length === 0,
        `枚举到 ${JSON.stringify(enumerated)}`,
      );
      record.check(
        "typeof __bridge === 'undefined'",
        evalValue(vm, "typeof globalThis.__bridge") === "undefined",
        `typeof = ${String(evalValue(vm, "typeof globalThis.__bridge"))}`,
      );
      record.check(
        "'__bridge' in globalThis === false（捞不回来）",
        evalValue(vm, '("__bridge" in globalThis)') === false,
        "in 运算",
      );
      record.check(
        "闭包通道仍可用",
        evalValue(vm, "globalThis.callCaptured()") === 123,
        "捕获的引用照常返回",
      );
      const viaHandle = vm.callFunction(handle, vm.undefined).consume((h) => vm.dump(h));
      record.check(
        "宿主仍可经 handle 调桥",
        viaHandle === 123,
        `返回 ${JSON.stringify(viaHandle)}`,
      );

      const ref = tryEval(vm, "__bridge();", "abuse.js");
      record.check(
        "越权是普通 ReferenceError",
        !ref.ok && ref.error.name === "ReferenceError",
        ref.ok ? "未抛异常" : `${ref.error.name}: ${ref.error.message}`,
      );
      evalValue(
        vm,
        [
          "globalThis.swallowed = false;",
          "try { __bridge(); } catch (e) { globalThis.swallowed = true; }",
        ].join("\n"),
      );
      record.check(
        "guest 吞掉时宿主零痕迹（无异常逃逸）",
        evalValue(vm, "globalThis.swallowed") === true,
        "try/catch 吞掉后照常继续",
      );
      handle.dispose();
    } finally {
      vm.dispose();
    }
  },
};

const PROBES: readonly Probe[] = [
  probeEntryContract,
  probeDeepRecursion,
  probeInterrupt,
  probeMemory,
  probeBridgeDeletion,
];

const render = (result: ProbeResult): string =>
  [`=== 探针 ${result.id} ${result.slug}（${result.hldLine}） ===`, ...result.lines, ""].join("\n");

const main = async (): Promise<number> => {
  const wasm = await loadWasmModule();
  const header = [
    `沙箱行为复验探针 · ${PROBED_ON}`,
    `冻结版本组合：quickjs-wasi@${PROBED_QUICKJS_WASI_VERSION} / Node 大版本 ${String(PROBED_NODE_MAJOR)} / ${PROBED_ENVIRONMENT}`,
    `探针输出落盘：${PROBE_OUTPUT_DIR}/`,
    `本次运行环境：Node ${process.versions.node} / ${process.platform}-${process.arch}`,
    "",
  ].join("\n");

  const results: ProbeResult[] = [];
  const sections: string[] = [header];

  for (const probe of PROBES) {
    const lines: string[] = [];
    const { record, outcomes } = makeRecorder(probe.hldLine, lines);
    await probe.run(wasm, record);
    const result: ProbeResult = {
      id: probe.id,
      slug: probe.slug,
      hldLine: probe.hldLine,
      lines,
      outcomes,
    };
    results.push(result);
    sections.push(render(result));
  }

  const outcomes = results.flatMap((result) => result.outcomes);
  const passed = outcomes.filter((outcome) => outcome.passed).length;
  const failed = outcomes.filter((outcome) => !outcome.passed);
  const summary = [
    `=== 汇总：${String(passed)}/${String(outcomes.length)} 项通过 ===`,
    ...failed.map((outcome) => `✗ [${outcome.name}] ${outcome.detail}`),
    "",
  ].join("\n");
  sections.push(summary);

  const text = sections.join("\n");
  process.stdout.write(text);

  const outputDir = join(repoRoot, PROBE_OUTPUT_DIR);
  mkdirSync(outputDir, { recursive: true });
  for (const result of results) {
    writeFileSync(join(outputDir, `probe-${result.id}-${result.slug}.txt`), render(result), "utf8");
  }
  writeFileSync(join(outputDir, "probes.txt"), text, "utf8");

  return failed.length === 0 ? 0 : 1;
};

process.exitCode = await main();
