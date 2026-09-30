# quickjs-wasi 语义核查(文档与源码)

Type: research
Status: resolved

## Question

hld §5.0 / §5.1 对 quickjs-wasi(QuickJS-NG 编译为 WASM)逐条断言了六件事,它们是 §5.3 双计数预算与 §5.2 裁决表成立的前提。凭**一手来源**(quickjs-wasi 官方文档与源码、QuickJS-NG 源码、WASI 规格)逐条核实,标出:成立 / 不成立 / 文档未承诺(须实测,交票「沙箱行为实测 harness」)。

1. `interruptHandler`(或等价中断机制)是否存在、是否按字节码指令触发、调用方可否计数并返回中断;
2. `memoryLimit` 超限是否表现为**可捕获的 JS 异常**(而非 WASM trap / 宿主失败);
3. 深递归栈溢出的表现:是否 WASM trap、不可捕获、VM 是否因此报废;
4. `executePendingJobs` 的语义与"每 tick 排空"的可行性;Promise 回调能否跨 tick 残留;
5. WASI 覆盖面:`clock_time_get` / `random_get` / `timezoneOffset` 能否覆盖为固定值;QuickJS 内部 `Math.random()` 的 PRNG 是否以冻钟值播种(同值 ⇒ 同序列,§5.1 的断言);
6. `moduleLoader` 不配置时 `evalCode` script-mode 的行为;默认不启用 `.so` 扩展(url/encoding/headers/crypto/structured-clone)的全局面实际有多大。

产出:逐条结论 + 出处引用 + "必须实测"清单。细节写进 findings 文件(见 ## Answer 的指针),票里只留结论与链接。

## Answer

逐条论据与一手出处见 [findings/01-quickjs-wasi-semantics.md](../findings/01-quickjs-wasi-semantics.md)(来源:quickjs-wasi@3.3.0 tarball + vercel-labs/quickjs-wasi 仓库、quickjs-ng/quickjs 源码、WASI preview1 规格)。六断言:**五成立、一修正、一项默认全局面文档未承诺须实测**。

| # | 断言 | 结论 |
|---|---|---|
| 1 | 中断计数 | **部分成立(粒度修正)**:存在、可计数、返回 true 抛 uncatchable 异常但宿主可捕、VM 续用;触发粒度是**每 10000 条 opcode 一次**(`JS_INTERRUPT_COUNTER_INIT=10000`),不是每指令,计数须自乘 10000。README 的 "once per bytecode instruction" 与上游源码不符([§1](../findings/01-quickjs-wasi-semantics.md#1)) |
| 2 | `memoryLimit` 可捕获 JS 异常 | **语义成立,约束力视版本**:超限抛 `InternalError: out of memory`,try/catch 可捕、VM 续用;但 **v3.3.0 的上限不约束留存内存**(ArrayBuffer 可无界增长),3.3.1 修好计账却回归"抛 null",**3.5.0 才两全**——锁版建议 ≥3.5.0([§2](../findings/01-quickjs-wasi-semantics.md#2)) |
| 3 | 深递归 = WASM trap | **成立(锁版 v3.3.0)**:WASM 物理栈 trap、不可捕获、VM 须重建;HEAD v3.6.0+ 新增 `maxStackSize`(0..512KB)可把 JS 级递归溢出转为可捕获 RangeError,但物理栈 trap 仍在([§3](../findings/01-quickjs-wasi-semantics.md#3)) |
| 4 | 每 tick 排空 | **成立**:`executePendingJobs()` while 循环一次排空;微任务路径同受 interrupt 控制;`callFunction` 不代排,跨 tick 残留须 host 显式排空([§4](../findings/01-quickjs-wasi-semantics.md#4)) |
| 5 | WASI 冻结 + PRNG 同值同序 | **成立**:`clock_time_get`/`random_get`/`timezoneOffset` 均可覆盖;`Math.random` 为 xorshift64*,seed 取 `gettimeofday`→`clock_time_get`,冻钟即同序列;`random_get` 默认走宿主 WebCrypto,**必须主动覆盖**([§5](../findings/01-quickjs-wasi-semantics.md#5)) |
| 6 | moduleLoader / 默认全局面 | **部分成立**:script-mode 不需 loader(`import` 是 SyntaxError);module-mode 不配 loader 时 `import` 抛 ReferenceError。`.so` 默认不加载成立;**默认全局面文档未承诺,须实测**(v3.3.0 无 Intrinsics 选项,全开)([§6](../findings/01-quickjs-wasi-semantics.md#6)) |

**必须实测清单(12 项)**:[§8](../findings/01-quickjs-wasi-semantics.md#8),交票「沙箱行为实测 harness」承接。要点:回调摊销开销、memoryLimit 计账误差、默认全局面穷举 dump、启动期 `random_get` 次数、async 路径 interrupt 归零、Promise 跨 tick 残留形态。

**hld 措辞待修**([§9](../findings/01-quickjs-wasi-semantics.md#9)):§5.0/§5.3 "按字节码指令触发" → "每 10000 opcode 一次,host 自乘计数";"深递归无 `JS_SetMaxStackSize`" 须注明按锁版行为。**锁版基线定为 ≥3.5.0**(map 已裁决,2025-09;hld §5.0 措辞已同步)。
