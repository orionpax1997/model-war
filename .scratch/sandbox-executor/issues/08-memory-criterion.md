# 08: 四类裁决之二:内存判据

**What to build:** 每 tick 末按该方**存活堆读数**判定内存是否超线;超线视同异常轨(累加异常计数、作废该 tick 意图);软阈值只观测;脚本把 OOM 异常 `try/catch` 吞掉之后**照样被判**。

**判据为什么锚定读数而不是异常**:guest 可以吞掉超限异常,吞掉之后宿主全程无感知——靠异常披露那条路是死的。读数锚定在宿主可直接测量的量上,与 guest 的异常可见性无关,也不涉墙钟。

**为什么读数是「存活堆」口径而不是「活对象」口径**:前者与分配上限同一记账口径;后者不含空闲池、更低,会让判据与上限对不上。

**为什么软阈值不是独立参数**:它是判罚线的推导项(固定比例)。把它做成参数键会多一个必须标定的数,而它只产生观测、不产生判罚。

**已接受的残余**:tick 内瞬时借满分配上限后自行释放的分配不触发判据(分配上限本身不可突破)。这条要在契约面与文档里写明,并在用例里钉住——它是「不判罚」而不是「漏判」。

决策依据:`.scratch/sandbox-executor/spec.md`《内存判据》。

**Blocked by:** 03(真 VM 的执行器:生命周期、桥与三件套)

**Status:** resolved

- [x] 读数在每 tick 末**强制回收之后**取存活堆口径(断言用的是存活堆字段,不是活对象字段)
- [x] 撑内存夹具被判定并累加异常计数;把异常 `try/catch` 吞掉的同款夹具**同样被判**
- [x] 判据不依赖 guest 异常可见性:一条用例断言宿主全程不读 guest 异常也能判出
- [x] tick 内瞬时借满后自行释放的夹具**不被判**(已接受的残余),有对应用例
- [x] 软阈值是判罚线的推导项(不是独立参数键),只产生观测、不产生判罚
- [x] 分配上限超限时**转成 guest 可见的异常**(这一条与「判据不依赖异常」是两件事,用例里分开断言)
- [x] 未定值规则集(预算键取未定值)下本轨**不启用**
- [x] 每 tick 末的强制回收有开销读数记录在案(它要进性能标定的考量,不是免费动作)

## Answer

判据落在 `packages/engine/src/runner/quickjs.ts` 的 `createQuickJsRunner`:每 tick 的
`drainIntents` 次序为 `loop()` → `pumpJobs()` →(本轨启用时)强制 `runGC()` → 读
`getMemoryUsage().mallocSize` → 组装观测 → `__drainIntents()`。读数与 guest 异常可见性无关,
是在宿主可直接测量的量上锚定的。

- `SandboxSession` 新增 `runGC` / `memoryUsage` 两条宿主侧读数方法(不改沙箱运行时源码、
  不在 `SeatRunner` 上新增方法);`QuickJsRunnerOptions` 新增 `memoryTickCeiling?` 与
  `softThresholdRatio?`。软阈 = `floor`(`softThresholdRatio ?? MEMORY_SOFT_THRESHOLD_RATIO` ×
  判罚线),系数经 `@model-war/replay` 原样再导出,不手抄 0.8。
- 三层:分配上限(`memoryLimit`,VM 构造选项)超限转 guest 可见的 `InternalError: out of memory`;
  判罚线读数 **≥** 判罚线发一条 `tripped`(轨名 `memoryTickCeiling`),经票 02 的步 0 落成
  `count-exception-tick` 累加 `exceptionTicks`;软阈只发 `memory-pressure`、不判罚。
- **字段缺席即本轨不启用**:不强制回收、不产观测。组装层读 `calibration.state` 决定缺席,
  引擎不认识「未定值」。
- 已接受的残余(不判罚,不是漏判):读数取在强制回收**之后**,tick 内瞬时借满后已释放的分配
  不可达;契约面同一条陈述见 `packages/schema/src/script-outcome.ts`。
- 夹具入库于 `packages/engine/src/fixtures/guest/`:`memory-hoard.js`(攥住)、`memory-swallow.js`
  (guest 吞 OOM)、`memory-transient.js`(借完即还;与 hoard 同量级,两条合起来证明残余非空)。
- 用例在 `quickjs.test.ts`(存活堆字段 vs `memoryUsedSize`/`objCount`、吞异常仍判、上限异常、
  残余、未定值、软阈、每 tick 强制回收开销读数)与 `sandbox.test.ts` 同形;判定 → 累加那条路径
  用真执行器经 `processTick` 端到端跑一遍。强制回收开销由 `quickjs.test.ts` 量出,
  `MW_READINGS_DIR` 设时落 `t08-gc-overhead.json`(与 `fixtures.test.ts` 同一约定)。
- 桩路径零回归:`movement.test.ts` / `combat.test.ts` 的 `exceptionTicks` 恒 0 断言仍绿;
  engine 导出面仍恰好 `runMatch`;只 import `node:crypto` 一个内置模块。
