# 06: 脚本 API 面铺全

**What to build:** 照真源包的注入符号表,把查询与 action **全部**铺进 guest(含 VM 内的寻路),这样模型写的真实策略能在沙箱里跑完采集、出兵、移动、占点,而不只是夹具脚本。

**为什么寻路在 VM 内**:查询与 action 全部在 VM 内跑,每 tick 只跨宿主边界两次(快照进、意图出)。逐函数注入会让稠密/滥用区的跨边界成本无上界——那是注入形态这条决定的对立面。

**为什么本票独立**:夹具脚本只用得到极少几个符号,所以前面几张票不需要它;而真实基准脚本需要全部符号,所以它是收口的硬前置。把它单独切出来,前面的票就不必等 API 面铺完才敢绿。

**名字只有一个家**:类型面与注入面同源于真源包的那份符号表。本票只搬名字、不定义任何一个;两边名字集合不一致就是本票的缺陷。

决策依据:`.scratch/sandbox-executor/spec.md`《Solution》。

**Blocked by:** 04(runtime bundle 成形并入库)

**Status:** resolved

- [x] 符号表里每一个符号在 guest 里都存在且可调用,签名与类型面一致——一条**遍历符号表**的用例(不是抽几个)
- [x] 反向列举:符号表之外的 API 名字在 guest 里不存在;脚本调用它得到普通 `ReferenceError`
- [x] 一份真实基准脚本能在沙箱里完成完整对局:不报未定义名、不被静态校验拒、产出可复算的回放
- [x] 类型面与注入面的名字集合一致性有一条断言(两边同源于一份形状,只有一份形状)
- [x] 状态查询走只读封存/复制副本,脚本读不到宿主可变对象(一条能弄红的反例:尝试改快照里的对象不生效)
- [x] 铺全之后产物仍是被漂移门禁守着的入库产物(重新入库并过门禁)

## Answer

**注入面铺全,判据与引擎同源,产物重新入库。**

- **guest 运行时**(`packages/engine/src/sandbox-runtime/index.ts`)铺全 `SANDBOX_INJECTED_API_SYMBOLS` 的 22 个名字:六个查询、六个 action、`getMyIndex`、`isError`/`errCode`、六个 `ERR_*`。查询与 action 全在 VM 内,每 tick 仍只跨宿主边界两次;`findPath` 直接 `import` 引擎的 A*(`../pathfinding/find-path.js`),同一实现。
- **dual validation:查了,能复用,就抽出来复用。** 先做了一次 esbuild 探针:把 `processor/{movement,combat,economy,production}.ts` 的 `check*` 打进 guest 是安全的(产物零 `node:*`)。但它**不能直接复用**:它交回布尔,而 guest 要交回**七个具体 `ERR_*` 之一**、外加一种没有码的静默丢弃(产线已有订单)。所以把六条判据抽到 guest 安全的 `packages/engine/src/processor/intent-verdicts.ts`(只 import 类型,模板化视图与规则面),交回 `Verdict`;处理器的 `check*` 改成 `verdict(...).ok`、六个校验函数**逐字**委托过去——**判据只剩一份实现**,guest 与引擎不可能分叉。四条既有处理器测试(122 条)零回归。
- **规则面怎么进 guest:** 判据要读射程/造价/`carryLimit`,而 runtime 是同一串字节(所有对局共用),规则集只能按对局灌。做法是建 VM 时把一次性 setup `{ seat, ruleset }` 先放在 `__setSnapshot` 这个名字下:runtime 载入时读进闭包,并立刻把同一位置换成每 tick 的桥函数。它**不新增第三个注入名**——名字仍由 `HOST_BRIDGE_*` 常量拼出,不必去动 `packages/tools/src/sandbox-runtime/`(票 05/10 在并行改);它也**不是缝上的第三次桥调用**:ADR-0005 的两方法缝不动(每 tick 仍只 `setSnapshot`/`drainIntents`)。宿主没灌规则集时那两条判据**降级为跳过**,交回引擎终裁,而不是拿臆造属性误判。
- **`getMyIndex` 选后者**(runtime 读宿主注入的座位常量):座位随 `__setup` 灌入并被闭包捕获,API 面的形状(某名字存不存在)由 runtime 自己拥有,不再依赖「宿主记得注入」。
- **反向 AC 的措辞:** `FORBIDDEN_GLOBAL_NAMES` 是**静态禁名单**,不是「运行时不存在」。`Date`/`performance` 在 QuickJS 里本来就在场(三件套钉住、`intrinsics` 本票不动,见 spec《Further Notes》)。用例钉的是:注入面的名字集合里一个禁列名都没有、桥与 `__setup` 无残留、`getResources`/`fly`/`spawn`/`probe` 这类符号表外的名字裸调用得到普通 `ReferenceError`。
- **只读反例:** 脚本在 guest 里改 `getObjectsByType` 回来的单位字段,宿主的 `Snapshot`/`GameState` 逐字段不变(依据:`hostToHandle` 递归深拷贝,已读实现确认)。
- **基准脚本:** `benchmarks/cell-a-melee-pressure/script.js` 在真沙箱里跑完整场(1 + tickLimit + 1 行),两次跑逐 tick `stateHash` 全等。它没被拒——不报未定义名、不抛未捕获异常;静态期由既有 `check:bench` / 类型面用例把守(本票不改类型面,故仍过)。
- **名字只有一个家:** `INTENT_ERR_CODES` 由 `intent-verdicts.test.ts` 与真源包符号表的 `error-code` 项逐字对齐;`api-surface.test.ts` 把 guest 实际铺出来的名字集合与 `SANDBOX_INJECTED_API_SYMBOLS` 逐字对齐(经 `@model-war/replay` 再导出读真源);类型面 ↔ 符号表那一半在 tools 的 `api-doc.test.ts` 里已有。
- **产物重新入库:** `runtime:build` → `46c93013…` 手写回 `packages/schema/src/sandbox-runtime.ts` 的 `SANDBOX_RUNTIME_HASH`,`check:runtime` 绿(产物 12982 字节、零模块语法、零 `node:`)。

**验证:** `check:quick` 绿;`vitest --project unit packages/engine` 237 绿(含新增 12 条);`lint:types` 绿;`check:runtime` 绿;`vitest --project unit packages/{tools,replay,schema}` 327 绿。

**遗留:** 组装层(`apps/cli`,票 05 在并行改)构造真执行器时把规则集传进 `ruleset`,否则那两条判据处于降级态(仍能跑完对局,只是少了射程/资金的即时反馈)——本票不动 `apps/cli`。
