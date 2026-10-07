# 11: 端到端收口

**What to build:** 至少一份**真实基准脚本**在真沙箱上跑完一个对局并被 `verify` 复算一致;DoD 逐条有证据;本 feature 的全部文档与 ADR 落地。

**为什么真脚本不能提前**:夹具脚本只用得到极少几个符号,真实基准脚本要用完整的 API 面——所以它能跑通,就是「注入面铺全」那张票的独立证据,而不是它的自证。

**为什么只卡「至少一份」**:三份基准脚本里有一份是按「站相邻」的猜测写的(当时占点机制那一节还没落库),它在真规则下不累积进度。那笔账归**占领契约补齐**那个节点,不是本 feature 的缺口。本票把它作为**已知非目标**写清,不假装它不存在,也不被它拖住。

**收口即验收**:五条复验与 hld 写回是第一条验收,前面已经交了;本票核的是端到端那条链是否真的通,以及桩路径有没有被搅动。

决策依据:`.scratch/sandbox-executor/spec.md`《Solution》《Out of Scope》。

**Blocked by:** 05(`match` 走真沙箱、`verify` 打通)、06(脚本 API 面铺全)、07(四类裁决之一)、08(四类裁决之二)、09(观测通道)、10(五条复验探针与 hld 写回)

**Status:** resolved

- [x] 一份真实基准脚本:真沙箱 `match` → `verify` 全绿(不是夹具脚本,不是桩)
- [x] 桩路径零回归有证据:引擎导出面仍恰好一个符号、十余处桩测试与十次重跑全绿、三张夹具全绿
- [x] 未定值规则集下四轨全不启用、不判负;夹具真值下判罚与淘汰正确
- [x] 观测形状与校验器落地;观测出口缺席时引擎照常产出回放
- [x] 退出码表在真沙箱的几种失败上各验一次(崩溃 / 不确定超时 / 输入或校验错)
- [x] 全量检查链绿
- [x] 一处已知非目标记明:那一份占位脚本在真引擎上的行为差异归占领契约补齐节点,附指针
- [x] 文档交叉引用一致:术语修订、ADR 0005 修订、新 ADR(入库产物 + 漂移门禁)、hld §5 写回三处互不矛盾
- [x] 补文档漂移:`docs/hld.md` 两处 `budget-soft-warning` 改成软限观测行/移出事件流

## Answer

### 端到端那条链(第一项,本票的主证)

新增三条用例在 `apps/cli/src/cli.test.ts`(它们**走 CLI 公开面**:spawn 打好的单文件 bundle,
`match` 写回放、`verify` 复算,**不是**引擎内部 API):

- `:581` **真实基准脚本 cell-a:match 写回放 → verify 复算一致,退出 0**。真沙箱一整场
  (meta `runner=quickjs`、600 个 tick、末行 result),`verify` 逐 tick + 末行一致。这是「注入面
  铺全」的独立证据:夹具脚本只碰到极少几个符号,cell-a 用完整注入面。
- `:620` `it.each` **三份基准脚本各跑完整场**(cell-a / cell-b / cell-c)退出 0、产出合法 result。
  含 cell-c(见下「已知非目标」)。
- `writeMatchInput` 新增 `cell` / `script` 两个选项(`:287`):前者读 `benchmarks/<舱>/script.js`
  这份**入库产物**,后者给一段自定义执行体。
- **它是测试用,不是对外入口**:落在 `unit` project,由默认 `test` / `verify:fast` 收口;没有新增
  任何 CLI 子命令或对外脚本。

### 桩路径零回归(第二项)

- **导出面**:`packages/engine/src/index.test.ts` 仍钉 `Object.keys(engine) === ["runMatch"]`(正反双向)。
- **十余处桩测试 + 十次重跑**:`run-match.test.ts`、`runner/stub.test.ts`、`determinism.test.ts`
  (`:75` 十次重跑 stateHash 十列全等)、`fixtures/` 五条场景等全部绿;本票一条桩测试未改。
- **三张夹具全绿**:新 `it.each` 三份基准脚本全跑完(含 cell-c);`check:bench` 三份产物逐字节一致;
  `check:selfproof` 的 64 场矩阵(按需)仍绿。

### 未定值 → 四轨不启用 / 判罚与淘汰(第三项)

- `apps/cli/src/match/assemble.ts` 的 `budgetOf` 读键清单两态字段:v1 的八个预算键全是 `undetermined`
  → 交空对象 → **四轨全不启用**(引擎不认识「未定值」)。e2e 那三场真脚本跑满 600 tick、无任何判罚。
- 引擎侧直测:`runner/quickjs.test.ts:407`(内存判罚线字段缺席 → 不产观测、不判负)、`:607`
  (API 轨只在启用时生效)、`:671`(墙钟软限字段缺席 → 连回调都不装)。
- 夹具真值下的判罚与淘汰:`quickjs.test.ts:557`(事件阈值高低决定截停与否的能弄红反例)、`:721`
  (反复失控达上限即出局、点位回归中立)。

### 观测形状与校验器 / 出口缺席(第四项)

- 形状:`packages/schema/src/observation-line.ts`(类型 + `OBSERVATION_LINE_JSON_SCHEMA`),经
  `packages/replay` 再导出;校验器 `apps/cli/src/validator.ts` 的 `validateObservationLine`
  (`validator.test.ts:1389+` 六栏逐项 + 必填键集合)。
- 出口**缺席**照常出回放:`run-match.test.ts` 四条用例不传 `observations` 仍产出 meta+600 tick+result;
  `observation-channel.test.ts:107` 的故障位用例同样不传出口。
- 写出侧投影与「每玩家每类首条」去重:`apps/cli/src/match/observations.ts` + 其单测。

### 退出码表(第五项)

- **输入或校验错(1)**:既有 `cli.test.ts` 的六类装载期拒跑 + 缺参 + 读不到文件,均退 1。
- **引擎崩溃(2)**:新增 `cli.test.ts:641` —— 真沙箱里深递归栈溢出实测为 host `RangeError`(hld §5.0
  第 2 行),`match` 捕获后退 **2**,stderr 一行 JSON 写「引擎故障」。
- **不确定超时(3)**:**v1 八个预算键全未定值 → `wallClockHardTimeout` 不启用,无法从 CLI 端到端触发**。
  按票面指示,走**引擎侧注入故障的既有单测**:`packages/engine/src/observation-channel.test.ts:107`
  (`fault: "uncertain-timeout"` → `runMatch` 交回 uncertain-timeout、不写末行 result)。CLI 侧 `match`
  的 `uncertain-timeout → EXIT_NONDETERMINISTIC_TIMEOUT(3)` 映射已接好(`apps/cli/src/match/index.ts`),
  但今天没有现成规则集能从 CLI 触发它——这是**标定节点**的账(终值一落,这条就端到端可验)。

### 文档交叉引用一致 + 漂移(第八项 + 补文档漂移)

- `docs/hld.md:608` 墙钟软限落点:`budget-soft-warning` → **「写成一条软限观测行(观测文件
  `observations.jsonl`)+ 报告披露,不进回放 events 流」**(票 09 已把该事件名从代码删除)。
- `docs/hld.md:735` events 清单:删掉 `budget-soft-warning`,点明**七种**并补一句软限/内存压力是观测行、
  不进事件流、更不进 `stateHash`。
- 交叉引用一致(三处):`CONTEXT.md` 的 `SeatRunner` 词条 / hld §5 的 `SeatRunner` 两方法形状 /
  §5.0 表引用的探针输出;`docs/adr/0005` 的「载荷加栏与执行器泛化」修订节;`docs/adr/0007`(入库产物 +
  `check:runtime` 漂移门禁);hld §5.0/§5.2/§5.3 写回与 §12 #8 关闭。它们**互不矛盾**:缝仍是那两个方法,
  runtime hash 唯一真源是入库产物字节。hld §5.3/§12 与实现逐条对齐(软限只观测、硬超时作废不判罚)。

### 已知非目标(第七项)

`cell-c-claim-no-harvest`(占点不采集)在真规则下**不累积占领进度**:它的占领机制是「走到点位相邻格后
原地驻守」——那是当时**猜**出来的(契约「占领」整节未排期)。**指针**:`.scratch/sandbox-executor/spec.md`
《Out of Scope》「C 舱(占点不采集)在真引擎上的行为复验……归占领契约补齐那个节点」。本票只证它在真沙箱里
**仍能跑完**(`cli.test.ts:620` 的三份夹具之一),它的行为差异不在本 feature 判。

### 全量检查链(第六项)+ 一处顺带修复

- `pnpm run check` 绿:`check:quick` + `lint:types` + **755 tests(69 files)** + `check:deps`(no violations)+
  `check:declared-deps` + `check:drift` + `check:bench`(三份产物逐字节一致)+ `check:runtime`。
- `pnpm run verify:fast` 绿(`check:quick` + 755 tests,74s)。
- **顺带修复**:`packages/tools/src/sandbox-probes/lib.ts:66` 的 `no-base-to-string`(票 10 遗留)让
  `pnpm run check` 的 `lint:types` 这一步红——本票作为收口必须让它绿,故按最小改动把对 `unknown` 的
  `String(...)` 换成一个类型安全的 `textOf`(字符串/原始值原样,其余走 `JSON.stringify`)。这是工具探针侧
  的只读改写,不动引擎导出面、不动桩路径。
