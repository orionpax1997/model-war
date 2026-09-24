# 沙箱行为实测:quickjs-wasi spike 数据与判定输入

票「沙箱行为实测 harness」的产出。throwaway spike,不进 `packages/`。

- 环境:Node v24.15.0(Linux x64);`quickjs-wasi@3.6.2`(QuickJS-NG 编译 WASM,包内置 `qjs_set_max_stack_size` / `qjs_set_interrupt_handler` 等出口)。
- 复现:`./run-all.sh`,原始输出在 `results/`;M5 由脚本跑两个独立进程 diff `FROZEN_*` 行判重放一致性。
- 各模块:`m1-interrupt`(中断计数)`m2-memory`(内存上限)`m3-runaway`(失控/重建,子进程隔离)`m4-async`(异步排空)`m5-determinism`(确定性冻结)`m6-boundary`(跨边界开销)`m7-doc-gaps`(文档未承诺项补测)。
- 噪声口径:µs 级微基准两轮独立测量互有 ±3–4% 漂移;凡下结论处给出区间而非点值。

## 1. 中断计数(`interruptHandler`)

**触发粒度:每 5000 次"控制流事件"一次回调(计数器初值 5000),不是按字节码指令。** 事件 = 循环回边 / 函数调用 / 函数返回。包文档"approximately once per JS bytecode instruction"**不成立**(M1.1 判别实验):

| workload | 事件量 | 回调数 | 每回调事件数 |
|---|---|---|---|
| 轻量循环 200k/1.2M 迭代(≈6 opcodes/迭代) | 差分 1M 回边 | 差分 200 | **5000.00** 迭代 |
| 重量循环体(≈3 倍运算/迭代) | 差分 1M 回边 | 差分 200 | **5000.00** 迭代(与指令数无关) |
| 双层嵌套 120 万内+12 万外回边 | 132 万回边 | 277 | 4765 回边 |
| 树形递归 2^18 / 2^22 调用(零回边) | 2×调用数 | 105 / 1678 | **2497–2500 调用(=每调用 2 事件:调用+返回;2^22×2/5000=1677.7≈实测 1678,精确命中)** |
| 直线代码 5 万语句(≈15 万 opcodes,零回边/调用环) | ~0 | 1(噪声) | 不计量 |

**回调开销**(M1.2,5000 万事件/1 万回调的重度 tick,交错测量):纯计数 handler 对比无 handler 总拖慢两轮实测 −2.5% ~ +2.4%(噪声带内)→ **≤~3%**;回调摊销 ≈ **1–4µs/次**(下界=M6 宿主蹦床 0.83µs,上界含每事件记账)。handler 内放 `Date.now()` 型工作方向性更慢(+3.6%,顺序跑 +6.8%)→ **回调内绝不能放墙钟/重活**。

**中断异常语义**(M1.3):

- host 侧:`JSException`,`name=InternalError`,`message=interrupted`;VM 中断后**可续用**(eval 正常)。
- **guest 不可捕获**:`try/catch` 体不执行,一次性触发与锁存触发(到限后永久 true)无差异——脚本吞不掉中断,"保留已提交 intent"的逃逸在中断路径上不存在。
- 判据换算:逐 tick 计数量化 5000 事件/格;预算 B 事件的 tick 中断 B/5000 次,回调耗时占比 ≈ (B/5000 × 1–4µs)/(B × ~70ns/事件) ≈ **0.3–1%**。
- **盲区**:计量单位是控制流事件而非指令——循环体展开大代码可放大每格真实工作量(实测 3 倍;上限=脚本体积),直线代码完全不计量。**"指令计数主判据"要成立,必须配脚本体积上限(validator),或改称"控制流事件计数"并与 API 计数互补。**

## 2. 内存上限(`memoryLimit`)

| 项 | 实测(M2,limit=8MB) |
|---|---|
| 超限表现 | 抛 `InternalError: out of memory`(host 侧 `JSException`) |
| guest 可捕获性 | **可捕获、可吞掉**——guest `try/catch` 捕获后继续执行,host 全程无感知(`hostErr: null`) |
| 未捕获时 | host 收 `JSException(InternalError: out of memory)` |
| VM 续用 | ✅ GC 后小分配、常规 eval 正常;反复触顶 2 次无累积损伤;内存统计恢复正常 |
| 触发情况披露(§5.2) | ⚠️ guest 吞掉时 host 看不到异常——需 host 侧检测机制(逐 tick `getMemoryUsage()` 阈值或异常钩子)才能披露 |

## 3. 失控行为(死循环/深递归/重建)

M3 逐用例独立子进程(进程级后果本身就是数据):

| 用例 | 表现 | VM 命运 |
|---|---|---|
| 死循环(有 interrupt) | M1 中断路径,`InternalError: interrupted` | 续用 ✅ |
| 死循环(无 interrupt) | 3s 超时由编排进程击杀——**硬超时是唯一防线** | 进程级处置 |
| 深递归(默认参数) | host 侧 **`RangeError: Maximum call stack size exceeded`**(`isJSException:false`)——**不是 WASM RuntimeError trap、不是 JSException**;guest 吞不掉 | **可续用**(eval/jobs/memory 全正常)——**无需重建** |
| 深递归(`maxStackSize: 0` 关守卫) | 同上(host RangeError) | 可续用 ✅ |
| 深递归(`maxStackSize: 512KB` 显式) | 溢出变成 **guest 可捕获的 `RangeError`**(catch 后继续执行)——与 OOM 一样可被吞 | 可续用 ✅ |

- **hld §5.0 "深递归无 `JS_SetMaxStackSize`、表现为 WASM trap"不成立**:quickjs-wasi 有 `maxStackSize` 选项(0=关守卫,≤512KB);默认/关守卫时溢出是 host `RangeError`(可被引擎看见),显式开守卫时是 guest 异常(可被脚本吞)。**要"host 必见"就用默认/0;要"软失败"就显式设值。**
- **§5.2 行 3"WASM trap 后必须重建"需重写**:栈溢出后 VM 实测可续用;"重建+记忆清零"从必需降级为可选的惩罚/防御手段(顺带对票「WASM trap 滥用」:清零模块级记忆的收益面因此变小)。
- **重建代价**(M3,15 样本中位,19KB runtime + 2KB script):源码型 `create+eval+首次调用` **7.3–10.2ms**;`compile` 缓存字节码后 **2.0–2.5ms**。量级 ms 级,便宜。

## 4. 异步排空(`executePendingJobs`)

- `executePendingJobs()` **全量排空到不动点**:job 里再排队的级联 job 在同一次 drain 内执行完(返回值=执行的 job 数,0=干净)。
- `evalCode`/`callFunction` **不隐式推进 job**;不排空则回调**无限跨 tick 残留**。实测时序危害:tick0 排的 `Promise.then(intents.push('late'))`,tick1–3 同步 intent 先落账,`late-from-tick0` 在 tick3 之后的 drain 才出现(M4.4)。
- → **§5.1 "每 tick `executePendingJobs()` 排空"是必要设计**;漏排一次即产生跨 tick 的 intent 时序错位。
- 附:`queueMicrotask` 也进同一 job 队列(被 drain 排空);未配置 `onUnhandledRejection` 时未处理拒绝不炸宿主,配置则收到回调。

## 5. 确定性冻结(WASI 覆盖)

`clock_time_get` 冻 1700000000000ms + `timezoneOffset: 0` + `random_get` 固定填充后(M5):

| 维度 | 判定 | 证据 |
|---|---|---|
| 逐 tick | ✅ `Date.now()`/`new Date().getTime()`/`toISOString`/`getHours`/`getTimezoneOffset` 恒定(每 tick 间真实等待 50ms,钟不动) | `frozenDateStablePerTick: true` |
| 逐 VM | ✅ 两个同参 VM 的完整 3-tick 转写逐字节一致(含 `Math.random()` 序列) | `secondVmTranscriptIdentical: true` |
| 逐次重跑 | ✅ 两个独立进程输出 `FROZEN_DIGEST: 648fc882a638db3a` 一致 | `run-all.sh` diff = IDENTICAL |
| `Math.random()` | 以冻钟值播种,VM 内序列前进、跨 VM/跨重跑复现——**hld §5.1 "同值即同序列"成立** | `prngSequenceSample` 两 VM 相同 |
| 对照(不覆盖) | `Date.now()` 前进、时区=host(−480)——覆盖确有实效 | `M5.5` |

**新发现**:`performance.now()` 冻结为常量 0 ✅(不破坏确定性)但 `performance` 对象在场;`eval`/`queueMicrotask`/`WeakRef`/`Proxy`/`SharedArrayBuffer` 也在场(M7)→ §6.2 validator 的黑名单/污染源名单应补 `performance`、`eval`、`queueMicrotask`。

## 6. 跨边界开销(M6;供票「跨边界调用形态对比」)

- 基线:空 tick 的 `callFunction` 蹦床 **0.66–0.88µs/次**。
- **A 载荷型**(`__setSnapshot`+`__drainIntents` 型,host 侧取字符串解码):**~5µs + ~2.6µs/KB**(快照+intents 字符串):

| 快照粒度 | drain 0 条 | 10 条 | 100 条 |
|---|---|---|---|
| 1KB | 15.7µs | 11.1µs | 24.7µs |
| 16KB | 54.0µs | 58.4µs | 67.2µs |
| 64KB | 173.4µs | 176.2µs | 185.7µs |

  intents 条数(0–100)只加 1–13µs;成本主导是快照字符串尺寸。host 不解码字符串时 16KB 参数往返仅 4.1µs → **贵在 host 侧 `toString()` 取数**。
- **B 逐函数注入型**(`api_q(i)` 返回数字):单次跨边界 **0.85–0.90µs**(密度 10–10000 稳定;1 次时 1.23µs);guest 纯函数对照 0.22µs/调用。每 tick 1 万次 API ≈ 10.7ms。
- **形态对比输入**:A 有每 tick 固定成本+按 KB 线性(≈2.6µs/KB);B 零固定成本、每调用 ~0.85µs。**~60 次调用/tick 时 B(≈51µs)≈ 16KB 快照的 A(≈54µs)**;调用更密选 A(带粗粒度快照)更省,调用稀但状态大选 B 反之不成立(快照是全量)。B 每调用 1 万次的 10.7ms 也正是 §5.3 API 调用计数要抓的成本面。

## 7. hld §5 断言判定表

| # | hld 断言 | 判定 | 判定输入 |
|---|---|---|---|
| 1 | §5.0 `interruptHandler` 按字节码指令触发,可做指令计数主判据 | ❌ 不成立(部分可用) | 按控制流事件(5000/次);改称事件计数+脚本体积上限,或保留"指令计数"措辞但知悉盲区 |
| 2 | §5.0/§5.3 memoryLimit 超限转**可捕获 JS 异常** | ✅ 成立 | `InternalError: out of memory`;VM 续用 ✅ |
| 3 | §5.2 内存超限"触发情况在报告中披露" | ⚠️ 缺机制 | guest 可吞异常,host 需 `getMemoryUsage()` 阈值检测兜底 |
| 4 | §5.0 深递归表现为 WASM trap | ❌ 不成立 | host `RangeError`;开 `maxStackSize` 则为 guest `RangeError` |
| 5 | §5.0 "深递归无 JS_SetMaxStackSize" | ❌ 不成立 | `maxStackSize` 选项存在(0=关,≤512KB) |
| 6 | §5.2 WASM trap 后必须重建(记忆清零) | ❌ 降级为可选 | 栈溢出后 VM 可续用;重建代价 2–10ms,可作惩罚/防御手段而非必需 |
| 7 | §5.1 每 tick `executePendingJobs` 排空 | ✅ 成立且必要 | 不排空→跨 tick 残留实证;drain 到不动点 |
| 8 | §5.1 WASI 覆盖三断言(冻钟/PRNG 同种子同序列/tz 0) | ✅ 全部成立 | tick/VM/重跑三维度全一致 |
| 9 | §5.2 中断后 VM 仍可用,无需重建 | ✅ 成立 | 另有强化:中断 guest 不可捕获,intent 逃逸不存在 |
| 10 | §5.3 双计数(指令+API)可作主判据、墙钟只观测 | ✅ 骨架成立,改口径 | 计数拖慢 ≤3%、回调 ~1–4µs;死循环无 handler 只能硬超时杀→硬超时设计必要;"指令"改"控制流事件" |
| 11 | §5.0 "`moduleLoader` 不配置,`import` 静态校验期拒绝" | ✅ 运行时也拒 | script 模式 `import`/`import.meta` 均 SyntaxError;动态 `import()` 返回会拒绝的 promise(建议静态校验一并禁 `import()`) |

## 8. 遗留/交棒

- 票「quickjs-wasi 语义核查」:本 spike 的 M7 已覆盖其第 6 项与部分第 2/3 项的实测面,findings 可直接引用;其余源码级核查(中断计数器实现、uncatchable 标记的 C 侧出处)仍归该票。
- 票「跨边界调用形态对比」:直接吃 §6 的数据。
- 票「WASM trap 滥用对策」:§3 的"trap 后 VM 可续用"改变了滥用收益面(清零记忆不再必然),分析入口变了。
- 票「预算裁决定案」:§7 判定表 + §1 的盲区(脚本体积上限)是核心输入。
