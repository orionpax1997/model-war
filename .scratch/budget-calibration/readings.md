# 预算标定探针读数(票 03:探针骨架 + 两个量测探针)

> 本文件**只放数与测法,不放任何建议阈值**——取值是后续票的事。

复现命令:`pnpm run probes:budget`

## 口径与方法

- 沙箱运行时哈希:`46c93013071ebdc2ddd29e1d07604854a0a3e48fa2c6f1bf7f9e9cd811285f83`(真值,来自 `@model-war/replay` 的
  `SANDBOX_RUNTIME_HASH`;被测字节 = 入库产物 `packages/engine/sandbox-runtime/runtime.iife.js`)。
- quickjs-wasi `3.6.2`;中断粒度 `INTERRUPT_EVENT_GRANULARITY = 5000`。
- 探针骨架逐条镜像 `createQuickJsRunner` 的每 tick 次序
  (`beginTick → loop → pumpJobs → endTick → runGC → memoryUsage → drainIntents`),不改任何判定。
- 内存读数取在 tick 末 `runGC()` 之后的存活堆 `mallocSize`(与内存判据同口径)。
- 事件读数按**格数**记(`eventCount / 5000`):wasm 侧计数器跨调用不清零、有相位残留,按事件数记会把残影当读数。
- 事件读数只有在构造 VM 时显式给一个极大上限才拿得到(计数回调只能构造时装);探针①给
  `eventTickLimit = MAX_SAFE_INTEGER`,探针②不装回调(与内存判据的口径一致)。
- 作用域:各一次会话、无地图与规则集参与(探针脚本不读状态、不判据);读数取在 tick 末强制回收之后的存活堆 mallocSize,与内存判据同口径。整数会随运行环境微动,量级稳定。

## 探针①:分配上限的封顶

`memoryLimit = 8388608` 字节。脚本每次请求一块 `new Uint8Array(requestBytes)` 并攥住,直到 guest 内捕获
`InternalError: out of memory` 后停手;「读出封顶」= 停手后 tick 末强制回收的存活堆读数。

| 单次请求字节 | 攥住的块数 | 读出封顶(bytes) | memoryLimit − 封顶 | 封顶 / memoryLimit | 事件格数 |
|---|---|---|---|---|---|
| 65536 | 123 | 8210408 | 178200 | 97.88% | 0 |
| 262144 | 30 | 7991056 | 397552 | 95.26% | 0 |
| 1048576 | 7 | 7461068 | 927540 | 88.94% | 0 |
| 4194304 | 1 | 4313860 | 4074748 | 51.43% | 0 |

**封顶随分配形态变化**:单次请求越小,能塞进的块越多、封顶越贴近 `memoryLimit`;单次请求越大,
封顶越接近 `memoryLimit − 请求量`——最后一块塞不下时整块都记不上账,`memoryLimit − 封顶` 里
就留下了那一整块的量级。这就是「分配上限 − 最大单次分配」那条夹逼上界没有可代入定值的原因。

## 探针②:装 runtime bundle 之后的存活堆基线

| 口径 | mallocSize 字节 |
|---|---|
| 空 VM(冻结常量 `EMPTY_VM_MALLOC_SIZE`,来源 `packages/tools/src/sandbox-probes/constants.ts:54`) | 75128 |
| 空 VM(本探针同口径实测,`createSandboxVm`) | 75128 |
| 装 runtime bundle + 空脚本,每 tick 末 runGC 后(min/max,3 次) | 118384 / 118384 |

两个基线**分列**是这一条的目的:75,128 是「**空 VM**、没有 runtime bundle、没有脚本」的基线,
而它的下一行才是「装 bundle 之后」的基线——两者的差就是运行时本身占的存活堆。
