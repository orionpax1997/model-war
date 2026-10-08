/**
 * 沙箱行为五条结论的**冻结常量**:核对时的版本组合 + 本轮实测的数值。
 *
 * 这个模块是「机器可判的核对点」:`check:quick` 里的版本耦合断言
 * (`gate/run-quickjs-coupling-gate.ts`)拿根 `package.json` 钉的 `quickjs-wasi` 版本与这里的
 * `PROBED_QUICKJS_WASI_VERSION` 比,**一升版即红**,报错信息直接指向复验脚本与 `docs/hld.md §5.0`。
 *
 * ── 为什么版本号在这里再写一份,而不 import 真源包 ──
 * 冻结常量模块保持**零 import**:探针由 Node 的类型擦除直接执行(`pnpm run probes:sandbox`),
 * 那一刻工作区依赖未必构建过(`@model-war/schema` 的 exports 指向 `dist`)。它与真源包的
 * `QUICKJS_WASI_VERSION`(`packages/schema/src/sandbox-runtime.ts`)必须同步,这条由
 * `gate/quickjs-coupling.test.ts` 里一条断言钉住——两处版本真源漂移会让「探针核对的是哪个版本」
 * 与「回放 meta 记的是哪个版本」各说各话,而那条断言就是防这件事。
 *
 * ── 数值从哪来、怎么改 ──
 * 全部来自 `docs/hld.md §5.0` 表里那五条结论的可执行版本,由 `run-probes.ts` 实测复核。
 * 换版本组合后重跑 `pnpm run probes:sandbox`,把新数字写回这里与 `docs/hld.md §5.0`;
 * **数值类的判据一律是这里的常量,计时类的判据才是区间**——两者的信任来源不同,不要混。
 */

/** 核对时根 `package.json` 钉住的 `quickjs-wasi` 版本。升版后必须重跑复验并改写此值。 */
export const PROBED_QUICKJS_WASI_VERSION = "3.6.2";

/** 核对时的 Node 大版本。下限由本仓自己的代码定(hld §2.2.1),不是本库的要求。 */
export const PROBED_NODE_MAJOR = 24;

/** 核对时的完整环境串,只进报告与冻结常量的出处声明。 */
export const PROBED_ENVIRONMENT = "Node v24.15.0 / linux-x64";

/** 本轮复验的测量日期(UTC)。 */
export const PROBED_ON = "2026-10-06";

/** 探针输出落盘目录(相对仓库根)。`.scratch/**` 不过 `.gitignore`,产出可入库复核。 */
export const PROBE_OUTPUT_DIR = ".scratch/sandbox-executor/probe-output";

/**
 * `interruptHandler` 每多少次控制流事件触发一次(循环回边 / 调用 / 返回)。
 *
 * 对应 `docs/hld.md:565`。这是**实测值**,不是文档字面承诺的「approximately once per bytecode
 * instruction」;探针用「多跑 50000 次回边恰好多 10 次回调」的差分把它测出来,与相位无关。
 */
export const INTERRUPT_EVERY_EVENTS = 5000;

/** 测粒度时两次测量的回边数差。它 / `INTERRUPT_EVERY_EVENTS` = 期望的回调数差。 */
export const INTERRUPT_GRANULARITY_SAMPLE_EVENTS = 50_000;

/** 测粒度时两次测量各自的循环回边数(取一个 5000 的整数倍,差分干净)。 */
export const INTERRUPT_GRANULARITY_LOOP_ITERATIONS = 1_000_000;

/** 计时类判据的区间:纯计数回调相对无回调的总拖慢绝对值上限(百分比)。 */
export const INTERRUPT_SLOWDOWN_BAND_PERCENT = 10;

/** 空 VM 的基线堆读数:判据口径 `mallocSize`(与 `memoryLimit` 同记账口径)。对应 `docs/hld.md:566`。 */
export const EMPTY_VM_MALLOC_SIZE = 75_128;

/** 空 VM 的基线 `memoryUsedSize`(更低且不含空闲池,不作判据,只作对照)。 */
export const EMPTY_VM_MEMORY_USED_SIZE = 64_098;

/** 复验内存封顶时用的分配上限。 */
export const MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * 诚实侧基准脚本在真引擎上的**存活堆峰值**(字节,所有场次所有席位的峰值里再取最坏)。
 *
 * 来源 `.scratch/budget-calibration/readings.md`(票 04,复现命令 `pnpm run probes:budget`);
 * 口径 = 每场每席的 tick 末 `runGC()` 后存活堆 `mallocSize` 峰值,再取全局最坏。
 * 它是内存两个键取值的下界依据(判罚线与软阈都必须严格高于它),所以冻在这里供 `check:budget`
 * 与票 06 的结构断言读;整数,不随运行微动到需要区间的程度。
 */
export const HONEST_ALIVE_HEAP_PEAK_BYTES = 201_384;

/**
 * 诚实侧基准脚本在真引擎上的**全局 API 调用峰值**(次/tick,同上口径的全局最坏)。
 *
 * 来源 `.scratch/budget-calibration/readings.md`(票 04)。`apiCallTickLimit` 的取值规则是它 × 2;
 * 冻在这里供票 06/07 的读数复算与结构断言引用。
 */
export const HONEST_API_CALL_PEAK = 133;
