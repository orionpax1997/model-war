# 预算标定探针读数(票 03:探针骨架 + 两个量测探针;票 04:三类预算探针 + 诚实侧基准)

> 本文件**只放数与测法,不放任何建议阈值**——取值是后续票的事。

复现命令:`pnpm run probes:budget`

## 口径与方法

- 沙箱运行时哈希:`46c93013071ebdc2ddd29e1d07604854a0a3e48fa2c6f1bf7f9e9cd811285f83`(真值,来自 `@model-war/replay` 的
  `SANDBOX_RUNTIME_HASH`;被测字节 = 入库产物 `packages/engine/sandbox-runtime/runtime.iife.js`)。
- quickjs-wasi `3.6.2`;中断粒度 `INTERRUPT_EVENT_GRANULARITY = 5000`。
- 探针骨架逐条镜像 `createQuickJsRunner` 的每 tick 次序
  (`beginTick → loop → pumpJobs → endTick → runGC → memoryUsage → drainIntents`),不改任何判定;
  判定式探针走 `runBudgetProbeTick`(真执行器),截停轨与截停读数由引擎自己给出。
- 内存读数取在 tick 末 `runGC()` 之后的存活堆 `mallocSize`(与内存判据同口径)。
- 事件读数一律按**格数**记(`eventCount / 5000`),不按事件数记:wasm 侧计数器跨调用不清零、有相位残留,按事件数记会把残影当读数。
- 事件读数只有在构造 VM 时显式给一个极大上限才拿得到(计数回调只能构造时装);量测探针给
  `eventTickLimit = MAX_SAFE_INTEGER`,基线探针不装回调(与内存判据的口径一致)。
- 作用域(量测探针):各一次会话、无地图与规则集参与(探针脚本不读状态、不判据);读数取在 tick 末强制回收之后的存活堆 mallocSize,与内存判据同口径。整数会随运行环境微动,量级稳定。
- 作用域(预算探针与诚实侧):三类预算探针:对抗两条走真执行器 `runBudgetProbeTick`(截停轨由引擎给出),三轨异常探针经 `processTick` 步 0 累加 `exceptionTicks`,诚实侧则用仪表化探针座位跑三份基准脚本。事件读数一律按**格数**记(eventCount / 中断粒度),不按事件数记:wasm 侧计数器跨调用不清零、有相位残留。

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

## 对抗探针:两类计数轨各抓住一条命(「每毫秒能烧多少」与截停轨)

| 探针 | 截停轨(引擎给) | 探针用上限(测试参数) | 次数 | 每毫秒烧多少(中位数与范围) | 各次截停读数 |
|---|---|---|---|---|---|
| 死循环探针(只烧控制流事件,零 API、零分配) | `eventTickLimit` | 50000 | 5 | 14782.7 (14625.7–14820.7) | 50000 / 50000 / 50000 / 50000 / 50000 |
| API 轰炸探针(只烧 API 调用) | `apiCallTickLimit` | 50000 | 5 | 5927.8 (5748.3–5967.6) | 200000 / 200000 / 200000 / 200000 / 200000 |

两条探针互为盲区,这正是两条计数轨都必须存在的理由:死循环探针一个 API 都不调(烧的是控制流事件),
API 轰炸探针不产生回边洪流(烧的是 API 调用)。**「被抓住」指定了轨名**:两者都截停于各自的计数轨,
不是墙钟硬超时(探针给的是有限计数上限,不是硬超时)。

「每毫秒烧多少」= 本 tick 截停读数 / 本 tick 墙钟(只含 `setSnapshot → drainIntents` 一次调用,不含建 VM)。
预热丢弃 3 次:首次实例化 / 首次大量控制流会让 wasm 侧先冷跑,把它算进速率会系统性偏低。

## 三轨异常探针:三条轨各被反复触发,`exceptionTicks` 逐 tick 累加

每条轨反复触发 8 个 tick,经步 0 把 `tripped` 观测落成
`count-exception-tick` 变更(唯一写入口)。每条轨每 tick 恰触发一次,故累计异常 = tick 数。

| 轨 | 探针用上限(测试参数) | tick 数 | 累计 exceptionTicks |
|---|---|---|---|
| 事件计数轨 | 50000 | 8 | 8 |
| 内存判罚线 | 1166960 | 8 | 8 |
| API 计数轨 | 500 | 8 | 8 |

**同 tick 最多叠加两次**(这条事实单独记):事件轨截停后立即早退,不再判内存 / API,故一条 tick 里
最多 +1;内存判罚线与 API 轨可以在同一 tick 各报一条 `tripped`,故可叠到 **+2**。本探针实测:

- 内存判罚线 + API 轨同时越限(叠加探针):同 tick 累计 **+2**。
- 三条轨都设、事件轨先截停(早退):同 tick 累计 **+1**。

> 同 tick 最多叠加两次:事件轨截停后立即早退(不排内存 / API 判定),故最多 +1;内存判罚线与 API 轨可以在同一 tick 各报一条 tripped,故 (+内存, +API) 可叠到 +2。

## 诚实侧:三份基准脚本在真引擎上的「每场每席峰值 → 全局最坏」

| 场次 | 状态 | tick | 单局墙钟 ms | 事件格数峰值 | API 峰值 | 存活堆峰值(bytes) | 单 tick 墙钟峰值 ms |
|---|---|---|---|---|---|---|---|
| cell-a-melee-pressure-open-clash | completed | 600 | 2318 | 1 | 33 | 198056 | 1.14 |
| cell-a-melee-pressure-corridor-split | completed | 363 | 1624 | 1 | 84 | 198144 | 0.22 |
| cell-a-melee-pressure-fortress-core | completed | 600 | 2276 | 1 | 33 | 198056 | 0.19 |
| cell-b-expansion-economy-open-clash | completed | 600 | 3661 | 1 | 92 | 201384 | 0.30 |
| cell-b-expansion-economy-corridor-split | completed | 600 | 3652 | 1 | 92 | 201384 | 0.25 |
| cell-b-expansion-economy-fortress-core | completed | 600 | 3590 | 1 | 92 | 201384 | 0.26 |
| cell-c-claim-no-harvest-open-clash | completed | 600 | 2594 | 1 | 131 | 196228 | 0.32 |
| cell-c-claim-no-harvest-corridor-split | completed | 600 | 2701 | 1 | 131 | 196308 | 0.28 |
| cell-c-claim-no-harvest-fortress-core | completed | 600 | 2703 | 1 | 131 | 196228 | 0.27 |
| mixed-a-b-c-a-open-clash | completed | 328 | 1433 | 1 | 133 | 201056 | 0.27 |

**全局最坏(所有场次、所有座位的峰值里再取最坏):**

- 存活堆峰值:**201384** 字节。
- API 调用峰值:**133**。
- 事件格数峰值:**1** 格(= 5000 次控制流事件)。
- 单 tick 墙钟峰值:**1.14** ms。
- 单局墙钟最坏:**3661** ms。

单局墙钟这一栏是**给节点 L 的输入指针**:NFR-3 的「对局平均墙钟 `X`」归 L 定(K 只交读数,不取值)。

**诚实局事件读数的分布(逐 tick 格数):p50 = 0、p95 = 1、max = 1。**
事件计数只能按**格数**记、不能按事件数记(相位残留):`eventCount / 中断粒度` 的有效分辨率是一整格,
所以小于一格的取值彼此等价。**诚实局事件读数的 p95 已经填满一整格**——这一点是后续给事件轨取值时的
直接约束,而不是一笔可以四舍五入的噪声。

### 样本与风险(如实记录)

样本薄:三份基准脚本只覆盖两个模型档(commandcode/deepseek/deepseek-v4.1-flash 与 minimax-cn/MiniMax-M3),其中 cell-c 的模型是**降级产物**(本机未配 Claude provider,按 J 的口径归 wizard)。三份脚本的策略标签只描述行为、不是能力评级,故诚实侧峰值只作量级参考, 不代表任何模型档的真实强度分布。

## 终值推导(票 05:计数与异常三键由读数按规则代入)

> 本节是票 05 追加的**算式与代入**,不是第二处取值真源——终值的家仍是 `rulesets/v1.json`。
> 上面的各表是读数,这一节把它们代入 spec《Implementation Decisions》第 1 条的取值规则;
> 重采读数后可据此直接重算。

| 键 | 取值规则 | 代入的读数 | 算式 | 终值 |
|---|---|---|---|---|
| `eventTickLimit` | 中断粒度的整数倍,取诚实全局峰值所在格的**下一格** | 诚实事件格数峰值 = **1 格**(p95 已满一格) | (1 + 1) × 5000 | **10000** |
| `apiCallTickLimit` | 诚实全局峰值 × 2,向上取整到整百 | 诚实 API 峰值 = **133** | ⌈133 × 2 ÷ 100⌉ × 100 = 3 × 100 | **300** |
| `exceptionTickLimit` | 容错 1 次 + 同 tick 最大叠加数 | 同 tick 最大叠加 = **2**(内存 + API 可叠;事件轨早退) | 1 + 2 | **3** |

三条语气要点:

- `eventTickLimit` 取 **5000 会误杀正常脚本**:它的有效分辨率是一整格,而诚实局事件读数的 p95 恰好
  填满一格(见上文「诚实局事件读数的分布」)。所以贴边安全的最小值是第二格,即 10000。
- `apiCallTickLimit` 的 300 与 spec 示范值 400 的差来自**重采读数**:诚实 API 峰值从旧读数的 179
  降到 133,133 × 2 = 266 → 整百 300。规则本身(× 2、取整百)未变。
- `exceptionTickLimit` **拒绝取 1**:1 会把「tick 内瞬时借满即还」这个已接受的残余当成出局条件。
  「容错 1 + 同 tick 最大叠加 2」= 3 正是「一次偶发不判负」的额度。

