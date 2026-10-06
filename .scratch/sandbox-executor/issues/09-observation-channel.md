# 09: 观测通道

**What to build:** 墙钟软限与内存压力这两类观测被记进**回放之外**的观测文件;每玩家每类只记首条;墙钟**永不进回放、更不进状态哈希**。

**为什么墙钟不能进事件流**:事件流是状态哈希的一部分(它是叙事战报的唯一来源,所以事件与状态共同构成这一 tick 的事实)。墙钟受机器负载影响、不可复算——它一旦进事件流,换台机器重放必然不一致,直接违反确定性的自动否决级要求。本票要顺手把这条纪律写成一句话:**事件流一律进哈希,故墙钟类观测不得进事件流。**

**为什么墙钟要按抽样读**:单 tick 是同步的,进程内没有第三个地方能插手,所以能截停单 tick 内失控的只有计数回调。而 hld 明写「回调内绝不能放墙钟」——改成「不得放**每次**都做的重活;时钟按抽样读」,两条就都成立。软限只记观测;硬超时中断本 tick 并标记为不确定超时(它使对局作废,不参与判罚)。

**为什么观测单独一个文件**:回放线要保持「就是回放」的纯度——`verify` 会逐 tick 比它,不能混进观测。而报告要机器可读地消费这些读数,所以形状该有家。

**为什么只记首条**:文件有界。承诺的是「触发情况披露」,首触 tick 足够回答「有没有触发」;将来要计数是**加栏**,不是改形。

决策依据:`.scratch/sandbox-executor/spec.md`《观测通道》《双重计数与墙钟》。

**Blocked by:** 07(四类裁决之一:双计数与异常计数)、08(四类裁决之二:内存判据)

**Status:** resolved

- [x] 墙钟按抽样读(在计数回调里每若干次读一次),抽样间隔是一个写明的常量;**回调里没有每次都做的重活**
- [x] 软限只记观测、不参与判罚;硬超时中断本 tick 并标记为**不确定超时**,走「作废而非判罚」那条轨
- [x] 观测行含:tick、座位、种类、观测值、上限;每玩家每类**只记首条**
- [x] 观测形状进真源包(类型 + required 键 + JSON Schema 三处),经回放包再导出一条,校验器加一条行校验
- [x] 引擎侧观测出口是**可选**的:缺席时静默丢弃,引擎单测不必关心它
- [x] 慢脚本产生一条软限观测、撑内存脚本产生一条内存压力观测——各有一条反例
- [x] 同一输入两次跑得到**逐字节相同**的回放,即使观测行不同(一条用例直接钉住「观测不影响回放」)
- [x] 一条能弄红的反例:把墙钟观测塞进事件流,状态哈希立刻跨跑不一致
- [x] 保留位清理:处理器里那个从未被调用过的软警告事件名删除,不留诱人跳坑的空位

## Answer

### 墙钟按抽样读(hld §5.3 的落点)

- `packages/engine/src/runner/quickjs.ts`:计数回调从「宿主 authored 的纯整数计数」升为
  `TickCounter` + `tickCounterHandler`,三条轨(事件计数 / 墙钟软限 / 墙钟硬超时)共用同一个
  `interruptHandler`(任一条启用就装它)。回调**每次调用只做整数自增与整数比较**;时钟按
  `WALL_CLOCK_SAMPLE_INTERVAL = 20`(**写明的具名常量**,即每 20 次回调读一次 `performance.now()`)
  抽样读,不是每次。`quickjs.test.ts` 用 `vi.spyOn(performance, "now")` 钉住「前 N−1 次一次都不读、
  第 N 次才读一次」,并静态断言回调源码里没有分配类构造。
- 软限只产一条 `wall-clock-soft`(轨名 `wallClockSoftLimit`,读数由 `Math.floor` 落成整数毫秒),
  **不判罚、不进回放**;意图照常交回(与 `tripped` 的「意图全部作废」相反)。

### 硬超时:作废而非判罚

- **缝不变(ADR-0005)**:`RunnerOutput` 加一栏可选故障位 `fault?: "uncertain-timeout"`,不新增
  第三个缝方法、不新增桥调用(与 ADR-0005 的「载荷加栏不改变缝」一致)。选故障位而不是第三条观测,
  因为硬超时是「这一局作废」而不是「一条读数」——用观测承载会让读者以为它也可以被「只记录」。
- 硬超时经 `eventCounterHandler` 的同一个 `true` 中断本 tick;与事件计数截停靠 `hardTimedOut`
  标志区分。`drainIntents` 见它即交回 `{ intents: [], observations: [], fault: "uncertain-timeout" }`。
- `TickContext` 加 `fault` 栏;步 0 一见故障就**短路**(后面尚未执行的座位不再跑),
  `processTick` 的 reduce 在故障后不再往下走——**本 tick 不写回放行、不产生事件、不产生终局**。
- `RunMatchResult` 改成判别联合:`{ status: "completed", result, finalState, tickCount }` 或
  `{ status: "uncertain-timeout", tick }`。把 `result` 写成可选会让每个调用点都得记得判一下。
- **多座位同时故障的合并语义**:座位串行执行(hld §2.3)且故障即短路,同 tick 至多一个座位交回
  故障;退一步说,将来多值也定死为**取座位序最靠前者**。今天只有一个常量值,合并无歧义。
- CLI:`apps/cli/src/match/index.ts` 见 `uncertain-timeout` 即报失败并退 `EXIT_NONDETERMINISTIC_TIMEOUT = 3`
  (D1),不写回放、不写观测;`verify` 重算遇它按引擎故障退 2(存档回放本不应硬超时)。
  **端到端触发待在标定**:v1 的八个预算键全是未定值,`budgetOf` 因此交空对象,真沙箱两轨都不启用——
  退出码 3 的分支已接好,但无法用现成规则集从 CLI 触发;引擎侧的故障路径由
  `observation-channel.test.ts` / `observations.test.ts` 覆盖。

### 观测行与观测文件

- **形状进真源包**:新模块 `packages/schema/src/observation-line.ts`(类型 `ObservationLine` /
  `ObservationLineKind` + `OBSERVATION_LINE_JSON_SCHEMA`)。行 = `type:"observation"`、`tick`、
  `seat`、`kind`、`value`、`limit`。**`track` 刻意不进这一行**:两个 `kind` 各自唯一对应一条轨,
  再写一栏就是同一个事实的第二个家(引擎载荷仍带 `track`,写出侧投影掉)。
- 引擎的 `ObservationKind` 由真源包的 `ObservationLineKind` + `"tripped"` 拼出,两侧不可能各写一份。
- `ObservationSink.record` 收到的是 `ObservationRecord`(观测 + `tick` + `seat`,由**步 0**
  这个知道座位与状态的调用点补齐);`ObservationSink` 仍是**可选**入参,缺席静默丢弃。
- 经 `packages/replay` 再导出类型与 JSON Schema;`apps/cli/src/validator.ts` 新增
  `validateObservationLine`(第七份形状,同一 Ajv 实例)。
- **落地**:`apps/cli/src/match/index.ts` 把观测写成 `dirname(replay)/observations.jsonl`(D3),
  有观测才写盘(没有则静默跳过,不拿空文件假装披露过)。「每玩家每类首条」的去重落在
  `apps/cli/src/match/observations.ts` 的纯函数 `observationLinesOf`(键 = 座位 + 种类),
  单测钉住「同类第二条丢弃、另一类与另一座位各记各的」。

### 删除保留位

- `budget-soft-warning` 从 `processor/events.ts`(枚举 / 步位表 / `EventCollector` 的
  `budgetSoftWarning` 记录器)与 `packages/schema/src/replay-line.ts`(事件枚举 + JSON Schema enum)
  一并删除,不留空位;事件种类因此从八种收敛为七种(注释同步)。
- `packages/schema/src/ruleset-keys.ts` 的 `wallClockSoftLimit` 描述「写进回放与报告披露」→
  「写进观测文件披露,不进回放」,已重跑 `pnpm run generate` 并提交 `docs/rules-v1/` 生成物。

### 测试与命令

- 新增/改动:`packages/engine/src/observation-channel.test.ts`(逐字节相同回放、弄红反例、
  故障作废)、`runner/quickjs.test.ts`(抽样读、软限观测、硬超时故障位)、
  `processor/observations.test.ts`(出口补齐 tick/座位、故障短路)、
  `apps/cli/src/match/observations.test.ts`(首条去重)、`apps/cli/src/validator.test.ts`(观测行两层)。
- 跑过:`pnpm run typecheck`、`pnpm run check:quick`(fmt / lint / coupling / no-float)、
  `pnpm run check:runtime`、`pnpm run check:drift`(提交后)、
  `pnpm exec vitest run --project unit apps/cli packages/engine packages/replay packages/schema`。

### 遗留(留给主线程 / 后续文档写回)

- **`docs/hld.md` 有两处仍写着 `budget-soft-warning`**(`:608` 的墙钟软限行、`:735` 的 events
  事件流清单)。按本票纪律「`docs/` 除 `docs/rules-v1/` 生成物外不要动」未改;待文档写回时
  把软限的落点改成 `wall-clock-soft`(观测文件)、从事件流清单里删掉该名。
