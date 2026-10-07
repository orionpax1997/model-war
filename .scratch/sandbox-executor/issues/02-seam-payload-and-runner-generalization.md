# 02: 缝的载荷加栏与执行器泛化

**What to build:** 引擎的执行器缝在**仍然是两个方法**的前提下,能带回预算裁决的观测;`runMatch` 从「收四个桩策略」变成「收四个已构造好的执行器」。

这是一张**预置件**:它本身不产生任何新能力,唯一的产出是让后面每一张票都能落在同一条路径上——桩与真沙箱共用一条缝。它的验收标准是**桩路径零回归**。

**为什么不是「加一个查询方法」**:预算裁决的计量全在执行器侧(计数器住宿主闭包、内存读数要强制回收后取),而状态写入必须走引擎的 `apply()` 唯一写入口。所以观测只能搭**那一次返回载荷**回来。ADR 0005 把缝定成「就是那两次宿主桥调用」,这不新增中间表示、也不新增桥调用,只是回来的那一次载荷多了几栏——所以是**修订 0005 的正文**,不是新开一条。

**为什么桩执行器要跟着改**:桩返回空观测数组,则 F 已收口的十余处桩路径测试一行都不用改。这是本票最重要的成本控制。

决策依据:`.scratch/sandbox-executor/spec.md`《缝的形状》。

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] 缝仍然只有两个方法:进快照、出意图;没有新增接口方法、没有基类、没有工厂、没有生命周期协议(建 VM 与释放归组装层)——一条断言钉住方法集恰为两个
- [x] 返回载荷含「意图」与「观测」两类;观测条目形如:种类 + 轨名 + 观测值 + 上限值
- [x] 引擎在这条载荷上**不做裁决**:种类为「已触限」的观测由步 0 落成状态变更,另外两类转发给观测出口
- [x] `runMatch` 收四个**已构造好**的执行器,并额外收预算配置与可选观测出口;引擎不知道 VM 存在
- [x] 桩执行器返回空观测;既有桩路径测试(十次重跑、夹具、导出面断言)**全部绿**
- [x] 引擎对外运行时导出面仍然恰好一个符号
- [x] `docs/adr/0005` 增加一节:组装层的泛化与载荷加栏都不改变缝,缝仍是那两次桥调用

## Answer

改了什么:

- **缝的载荷加栏**(`runner/index.ts`):`drainIntents()` 由 `readonly Intent[]` 改成 `RunnerOutput = { intents, observations }`;新增 `Observation`(`kind` / `track` / `value` / `limit`)、`ObservationKind`(`tripped` / `wall-clock-soft` / `memory-pressure`)与可选 `ObservationSink`。`SeatRunner` 仍是 `setSnapshot` / `drainIntents` 两个方法(未新增)。
- **桩适配器**(`runner/stub.ts`):把策略结果包成 `{ intents, observations: [] }`;`stub.test.ts` 的返回形状断言跟着改,并补一条「桩观测恒空」。
- **观测 → 变更这条路径**:`step0-dispatch.ts` 在载荷上不做裁决——`tripped` 落成新 `Change` 种类 `count-exception-tick`(只带座位与值,`apply()` 只落不判,照 `mark-first-contact` / `mark-economy-dead` 先例);另外两类转发给可选观测出口(缺席静默丢弃)。观测出口经 `TickContext.observations` / `initialContext` / `processTick` 的可选参数接到步 0。
- **`runMatch` 泛化**(`run-match.ts`):`strategies: readonly StubStrategy[]` → `runners: readonly SeatRunner[]`,新增 `budget: BudgetConfig`(7 个已启用轨的可选阈值,`scriptSizeLimit` 不入)与 `observations?: ObservationSink`;删掉 `strategiesOf`,引擎不再包策略。全部调用方(`apps/cli/src/match/index.ts`、`determinism.test.ts`、`run-match.test.ts`、`fixtures/harness.ts`)跟着改。
- **ADR**:`docs/adr/0005-*.md` 增加「修订(票 02):载荷加栏与执行器泛化都不改变缝」一节。
- **新增单测**:`processor/observations.test.ts`,用一个只实现两条方法的假执行器证明 `tripped → exceptionTicks` 与两类转发都通,并复钉桩路径 `exceptionTicks` 恒 0。

关键文件:`packages/engine/src/runner/index.ts`、`processor/steps/step0-dispatch.ts`、`driver/apply.ts`、`run-match.ts`、`processor/context.ts`、`processor/index.ts`、`docs/adr/0005-runner-seam-is-the-two-bridge-calls.md`。

命令与结果:`pnpm run typecheck` 绿;`pnpm exec vitest run --project unit packages/engine` 197 用例全绿;`apps/cli/src/cli.test.ts` 17 用例全绿;`pnpm run check:quick` 绿。
