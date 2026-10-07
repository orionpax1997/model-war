# 07: 四类裁决之一:双计数与异常计数

**What to build:** 控制流事件计数与 API 调用计数各自截停超限脚本;超限**作废该座位本 tick 的意图**(单位原地待命),不中断其他三方与引擎;`exceptionTicks` 随 tick 落进回放,累计到上限时该席位被淘汰、点位回归中立。

**两个计数为什么必须成对**:它们互为盲区。纯计算死循环有回边与调用,由控制流事件计数抓;API 轰炸(每 tick 数万次寻路)由 API 调用计数抓。任何一个单独存在都会留下一个抓不住的口子——这正是两个对抗夹具要证明的东西。

**为什么计数在宿主闭包**:计数回调只能作为 VM 构造时的选项装上,事后没有 setter。所以本 tick 的计数与跨 tick 的累计都在宿主侧持有,快照进、意图出那两次桥不承载计数状态。

**为什么异常计数要持久化且不清零**:它是对局状态的一部分。若在 tick 之间重置,反复失控的脚本就能靠「每 tick 犯一次小错」无限拖下去,淘汰机制失效。

决策依据:`.scratch/sandbox-executor/spec.md`《四类裁决》《双重计数与墙钟》。

**Blocked by:** 03(真 VM 的执行器:生命周期、桥与三件套)

**Status:** resolved

- [x] 两个计数都是宿主侧纯整数计数,回调内自乘、不做重活(一条断言:计数回调里没有时钟与分配)
- [x] **纯计算死循环**夹具被控制流事件计数截停;**API 轰炸**夹具被 API 调用计数截停——各有一条能弄红的反例
- [x] 超限只作废该座位本 tick 的意图,其余三方与引擎不受影响;本 tick 的计数在进入下一 tick 时重置
- [x] `exceptionTicks` 经 `apply()` 唯一写入口落成状态变更,并随每 tick 写进回放行(该栏位在真源包里已存在,本票不新增形状)
- [x] 按异常**事件**累加,变更里带轨名以便读数(一条用例断言同 tick 两条不同轨各计一次)
- [x] 累计到上限时该席位按既有淘汰变更出局、点位回归中立;终局原因的四值取值域**不动**(淘汰是席位级事实,不是终局原因)
- [x] 反复失控不能靠计数重置逃逸:一条跨多 tick 的用例,断言累计值单调不减直至出局
- [x] 未定值规则集(预算键取未定值)下本票的两轨**不启用、不判负**
- [x] 夹具脚本本身是入库的测试夹具,不是一次性探针

**非目标:** 墙钟软限与硬超时(观测通道那张票)、内存判据(另一张票)。

## Answer

实现落在「执行器侧判定 + 引擎侧落状态」这条既有缝上,两个计数各由一条轨负责、互不干扰。

**控制流事件计数(宿主闭包)**
- `packages/engine/src/runner/quickjs.ts`:`createSandboxVm` 拆出 `createSandboxVmWithCounter`;`QuickJS.create({ interruptHandler })` 装 `eventCounterHandler`,`EventCounter` 是纯整数/布尔闭包状态。回调**只做 `count += INTERRUPT_EVENT_GRANULARITY(5000)` 与阈值比较**,达阈 `tripped = true` 并返回 `true` 中断本 tick;不分配、不读时钟。本轨未启用(`eventTickLimit` 缺席)时连回调都不装。会话层 `beginEventTick`/`endEventTick` 在 `loop()`+`pumpJobs()` 之外开合闸门。
- `eventCounterHandler.toString()` 在 `quickjs.test.ts` 里被一条断言钉住「无时钟、无分配,只做整数自增与阈值比较」。

**API 调用计数(guest 自增、宿主裁决)**
- `packages/engine/src/sandbox-runtime/index.ts`:`getTick`/`getObjectsByType`/`move` 各 `apiCalls += 1`;`__drainIntents()` 返回结构由 `intents[]` 改为 `{ intents, apiCalls }`,`__setSnapshot` 每 tick 归零。宿主 `createQuickJsRunner` 拿 `apiCallTickLimit` 比较,超限作废本 tick 意图。
- 两轨超限都**只作废该座位本 tick 的意图**(`intents: []`),产一条 `tripped` 观测(轨名 = 预算键名),VM 续用、其它三方与引擎不受影响。

**异常计数与淘汰(引擎侧)**
- `driver/apply.ts`:`count-exception-tick` 增加 `track: string`(按事件累加、带轨名);`apply()` 只落不判。
- `processor/steps/step0-dispatch.ts`:每条 `tripped` 落成一条带轨名的 `count-exception-tick`(同 tick 两条不同轨各计一次)。
- `processor/steps/step5-evaluate.ts`:淘汰判定新增「累计异常达 `exceptionTickLimit`」这一支(与「无单位且无基地」是或,且只在预算字段在场时生效);点位回归中立复用既有 `returnNeutralStage`。
- `budget.ts`(新):`BudgetConfig` 形状的家,避免 `run-match → processor → run-match` 循环依赖;`processor/context.ts` 的 `TickContext` 加 `budget`,`processTick`/`runMatch` 透传。

**夹具(入库)**:`packages/engine/src/fixtures/guest/event-spin.js`(纯计算死循环、零 API)、`api-flood.js`(每 tick 十万次查询调用、打完下一笔 move 以断言「超限作废」)。

**验证**:`pnpm run check:quick` 绿;`pnpm exec vitest run --project unit packages/engine` 228 passed;全量 unit 700 passed。未动 `docs/`、`packages/tools/`、`ruleset-keys.ts`;guest runtime 源码已改,入库 bundle 与 `sandboxRuntimeHash` 的重新入库归票 04/06(本票测试用 esbuild 现打 runtime,不依赖入库 hash)。
