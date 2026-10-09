# 预算终值失效触发表

**这张表是什么。** ADR-0009 裁:八个预算键的终值一旦落库就**不可就地修改**,只有三类事件使它失效
(契约散文修订、快照结构变更、沙箱 runtime 版本或中断粒度变更),失效时开一个**新的收尾节点重标**,
而不是把数改掉。三类事件**都不会让任何默认门禁变红**——契约散文修订按 ADR-0008 连版本号都不升;
快照结构变更只动引擎内部形状;runtime 升级有版本耦合门禁但不会让预算阈值失配。所以这条纪律只能靠
一条**可执行**的复算门禁把它变成红的:**每类事件发生时,跑 `pnpm run check:budget-recheck`;红了就开
重标节点。**

**不做 git-diff 嗅探。** 这张表是**纪律清单**(人读到某类改动时知道跑哪条命令),不是自动触发规则:
三类事件的触发点散在 gdd 散文、快照结构、runtime 构建三处,靠一个按路径 / 文件名的 diff 嗅探去猜
「这次改动算不算失效事件」只会误报——改一句无关措辞也会命中。所以触发判断留在人这一侧,机器只负责
**判红**。

**命令与判定真源在脚本,不在这张表。** 门禁脚本 `packages/tools/src/budget-recheck/run-budget-recheck-gate.ts`
与根 `package.json` 的 `check:budget-recheck`;复算的实际断言在
`packages/engine/src/runner/probe-harness.test.ts` 的三条 `复算:*` 用例里。本表只登记「哪类事件 → 跑哪条
命令 → 红了怎么办」。

## 三类失效事件

| 失效事件 | 它改了什么(含「为什么默认门禁发现不了」) | 跑哪条命令 | 判定 | 红了怎么办 |
|---|---|---|---|---|
| **契约散文修订** | `docs/rules-v1/` 两份契约文档的机制 / 顺序 / 语义散文(ADR-0008:修订不升版本号,ruleset 哈希不变,`check:drift` 只盯生成物形状,拦不住它) | `pnpm run check:budget-recheck` | 门禁的六键推导仍与 `rulesets/v1.json` 逐键一致、探针仍被截停、三份基准脚本在终值预算下仍不被截停(墙钟两键不做逐字相等,见文末口径提醒) | 开重标节点:按 `docs/hld.md` §5.3 的取值规则在他处重采读数、重算八键,再落 `rulesets/v1.json` |
| **快照结构变更** | `packages/engine/src/snapshot/snapshot.ts` 的 `snapshotShapeOf` 六栏形状 / `buildSnapshot` 的拷贝与冻结粒度;快照体量与每 tick 墙钟随之变(落进诚实侧峰值 → 内存与墙钟两键的推导) | `pnpm run check:budget-recheck` | 同上;尤其内存两键的推导(`memoryTickCeiling` / `memoryLimit`)对诚实存活堆峰值敏感 | 开重标节点:重采诚实侧读数、重算内存 / 墙钟两键,再落库 |
| **runtime 版本或中断粒度变更** | `packages/engine/sandbox-runtime/runtime.iife.js`(版本耦合门禁只判 `quickjs-wasi` 版本对齐,不判阈值)、`INTERRUPT_EVENT_GRANULARITY`(宿主对 wasm 侧回调周期的镜像,改 TS 常量不会让回调变密、旧回放因此不可复算);事件计数轨的有效分辨率随之变 | `pnpm run check:budget-recheck` | 同上;尤其 `eventTickLimit` 的「中断粒度整数倍」与诚实事件格数读数 | 开重标节点:先按新 runtime 重采全部读数,再重算八键(含 `eventTickLimit` 的格边界),最后重跑 `check:budget` 的文档副本断言 |

**口径提醒(与 `.scratch/budget-calibration/readings.md` 同源)。** 复算读数带一次**负载敏感的墙钟**:
终值推导里墙钟两键(`wallClockSoftLimit` / `wallClockHardTimeout`)因此**不做逐字相等断言**——它们取的是
观测机制下界,机器一竞争读数就会把它顶掉。这两键的结构约束(2 的幂、硬超时 ≥ 20 × 软限)由快门禁
`check:budget` 看着,行为侧(基准不被截停)由复算门禁的另两条用例看着;其余六键的读数在固定脚本 /
地图 / 种子下是确定值,故逐键逐字相等。

## 为什么不是别的形态

- **不做每赛季定时自动重标**:终值失效是**事件驱动**的(改了哪一类东西才失效),不是**时间驱动**的;
  定时重标会在没有失效事件时制造「终值又变了」的假信号,与 ADR-0009「终值不可就地修改」相冲。
  「每赛季自动重标流水线」在本节点落成的是**这条命令 + 这张表**(spec 决策 6 与用户故事 10/11),夜间
  流水线按定时跑 `check:budget-recheck` 当**常驻守卫**,红了由人按本表处置。
- **不做 git-diff 嗅探**:见文首一节。
