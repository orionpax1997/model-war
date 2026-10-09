# 12: quickjs-ng GC 断言崩溃(真实脚本组合,确定性复现)

> 本票原误编为 11 号(与 `11-end-to-end-closeout.md` 重号),回写时改号为 **12**——它是节点 G 收口后新增的一张收尾票,不是原 11 票的一部分。

**What to build:** 诊断并修掉一处**确定性**的引擎 / 沙箱崩溃:`I 真实赛季`(season 票 11)整轮 60 局里有 1 局
(`c3-corridor-split-s2`)在 quickjs-wasi 里触发 GC 断言、子进程 `exitCode 2`(`engine-crash`),重跑一次仍触发,
被调度器按 §8.4 排除出排名。它是真实冻结脚本组合触发,不是偶发网络 / 宿主抖动。

**Blocked by:** 无

**Status:** resolved

## 复现

1. 用 season 票 11 的 5 条真实存档(`archive/<slug>/2026-10-09T01-09-09-599Z/`,已入库)与
   `.scratch/season-scheduler/e2e-readings.md` §2 的 `season.yaml`(`masterSeed: "2026-m4"`、`seeds: 4`、
   `maps: [corridor-split, fortress-core, open-clash]`)跑 `modelwar run --config season.yaml`;
   赛季**确定性**(种子 = `H(masterSeed, combo, mapIndex, seedIndex)`),会稳定复现 `c3-corridor-split-s2`。
2. 或直接对那一局的 `input.json`(该局 map `corridor-split`、seed `2936867027`、
   `archives = [mimo-v2.6-flash, muse-spark-1.3-contributor, deepseek-v4-flash, gpt-6-luna]` 的该 runId 存档)跑
   `modelwar match <input.json> --root .`——实测连跑两次同一处断言、同一 `exitCode 2`。

崩溃输出:

```
Assertion failed: JS_REF_COUNT(p) > 0 (quickjs-ng/quickjs.c: gc_decref_child: 7365)
Assertion failed: JS_REF_COUNT(sh) == 0 (quickjs-ng/quickjs.c: js_free_shape0: 5816)
modelwar match: 引擎故障:RuntimeError: unreachable
```

## 方向(待诊断,不预设)

- 先判归属:是引擎侧(`packages/engine`)违反了 quickjs 的引用 / 形状不变量(如 guest 对象跨 tick 泄漏、proto /
  shape 误用),还是 quickjs-wasi 绑定 / harness 的问题。用最小化:逐步替换四席脚本,定位是哪一席 / 哪一席组合触发。
- 触发点可能在 GC 时机(断言在 `gc_decref_child` / `js_free_shape0`),注意是否与 `memoryTickCeiling` 的强制回收扫描相关。

## 验收

- [x] 有确定性复现脚本(存进本票或 `probes/`),不依赖真实凭证 / 网络。
- [x] 定位到根因(引擎 / 沙箱 / quickjs 绑定 三选一),给出最小化输入。
- [x] 修复后上述 `input.json` 跑满 600 tick、退出码 0;`pnpm run verify:fast` 全绿。
- [x] 若根因在 quickjs-ng 上游、短期修不掉:在本票写明、给出规避(引擎侧约束),不静默忽略。

## Comments

发现于 season 票 11 的真实赛季收口;证据与读数见 `.scratch/season-scheduler/e2e-readings.md` §4 / §7。
调度器侧的「重跑一次 → 仍触发 → 记入问题清单并排除出排名」按设计正常工作,本票只处理崩溃本身。

## Answer

### 根因(归属:quickjs-ng 上游缺陷)

**quickjs-ng 的 `js_array_find` 在中断点上二次释放元素**(上游
[quickjs-ng#1792](https://github.com/quickjs-ng/quickjs/issues/1792):0.16.2 起存在,`master` 仍在)。
`find` / `findIndex` / `findLast` / `findLastIndex` 共用这份 C 实现:每轮循环顶部先
`js_poll_interrupts(ctx)`,不匹配的那一轮末尾 `JS_FreeValue(val)` 却**不复位 `val`**;当宿主中断
处理器恰好在顶部那次检查处返回真时,异常出口把上一轮已释放过的 `val` **再释放一次**——而数组仍持有
该元素,引用计数因此悬空。此后任一 `JS_RunGC` 都会在 `gc_decref_child`(`JS_REF_COUNT(p) > 0`)
命中,随后 `js_free_shape0`(`JS_REF_COUNT(sh) == 0`)→ WASM trap → `exitCode 2`。

不是引擎违反 quickjs 不变量,也不是 quickjs-wasi 绑定的逻辑错:`qjs_run_gc` 只是透传 `JS_RunGC`;
本崩溃用**纯 quickjs-wasi**(不 import 引擎)即可复现。引擎侧 `.find` 调用来自 guest runtime 的
判据辅助(`intent-verdicts.ts` 的 `getById` 与 `sandbox-runtime` 的 `getObjectById`);gpt 脚本本身
一个 `.find` 都没写,它每 tick 大量调 `attack`/`harvest`/`moveTo`/`transfer`/`spawnUnit`,判据内部
在快照数组上 `.find`,中断落在其中一次扫描里即触发。

### 最小化输入与对照

- **哪一席**:四席全真实脚本时稳定崩;逐席替换为空脚本、或只留任意 1/2/3 席真实脚本,均不崩——
  因为崩溃需要「真实脚本把世界推到某一形态 + 中断恰好落在判据的 `.find` 里」。
- **哪一席的 VM**:把该局 seat3(`gpt-6-luna`)收到的 61 份快照原样灌给一个新 VM,只有 gpt 脚本崩
  (tick 58),另外三席脚本在这批快照上不崩。崩在 `gpt` 座位 VM 的 `session.runGC()`。
- **和显式 GC 强相关**:关掉 `memoryTickCeiling`(该轨不启用、不调 `runGC`)→ 同一局 600 tick
  跑完、exit 0。所以崩点是显式 GC,但**不是** `runGC` 破坏不变量,而是中断先破坏、`runGC` 只是
  第一个扫到它的动作。
- **必要条件**:`eventTickLimit` 轨启用(计数回调 arm)。不 arm 中断(不装回调)同一批快照不崩;
  首次 `eventTripped` 的那一 tick(`eventCount = 10000`)之后的下一次 `runGC` 即崩。
- **上游最小复现**:`probes/quickjs-find-interrupt-gc/repro-minimal.mjs`——谓词恒假 + 中断恒真,
  对 20000 个对象反复调 `find`,随后 `runGC()`:原生 `find` 断言崩(exit 2),等价 JS 实现 exit 0。

### 修复(引擎侧规避)

新增 `packages/engine/src/runner/array-search-shim.ts`,并在
`packages/engine/src/runner/quickjs.ts` 的 `openSandbox` 里、载入脚本前用宿主 `evalCode` 注入:
把 `find` / `findIndex` / `findLast` / `findLastIndex` 换成**按 ECMA-262 语义**写的等价 JS 实现。
JS 实现自身被中断只是普通异常、引用计数由解释器正常回退,没有那段 C 实现的二次释放口子。

- 为什么在宿主侧注入、而不是进 guest runtime bundle:bundle 的 sha256 是 `SANDBOX_RUNTIME_HASH`,
  **每份存档 meta 都钉住并逐字节比对**;改 bundle 会让包括干预局在内的所有历史存档拒跑。
- 规避只换实现、不新增全局名、不改 `this` 语义、不动 bundle 字节,故脚本可见 API 面与存档校验都不变。
- **已知副作用(如实记录)**:原生 `js_array_find` 每元素只烧约 1 格控制流事件,JS 实现约 2.5 格
  (20 万元素 find:原生 ≈ 20 万事件,JS 实现 ≈ 50 万)。`eventTickLimit` 是控制流事件计数轨,故
  find 用得多、又贴近上限的座位可能比修复前更早触限(实测 p6 这一序因此多出 1 次超限)。这是
  「C 内建换 JS 实现」的固有代价,**不改内存判据语义**(强制回收后读 `mallocSize` 的口径未动)。
- 正确修法在上游:`js_array_find` 循环内 `JS_FreeValue(ctx, val)` 之后补 `val = JS_UNDEFINED;`。
  这要重编 quickjs-ng 的 wasm;本仓 `quickjs-wasi@3.6.2` 已是其 npm 最新版、内置 quickjs-ng 0.17.0,
  `packages/runner` 之外无从升级,故先用宿主侧规避,并在代码与本票留下上游线索。

### 复现脚本(入库,不依赖网络 / 凭证)

- `probes/quickjs-find-interrupt-gc/repro-minimal.mjs`:上游缺陷最小复现(纯 quickjs-wasi)。
- `probes/quickjs-find-interrupt-gc/repro-match.mjs`:引擎级确定性复现——重建该局 `input.json`
  (map `corridor-split`、seed `2936867027`、四席 archival 序 = 崩溃序;sha256 现算)并跑
  `modelwar match`。
- `probes/quickjs-find-interrupt-gc/README.md`:说明与用法。

### 验收与回归(均已实测)

- 落地 commit **`773a900`**(在 `main` 上,无独立票分支 / merge commit)。
- `node probes/quickjs-find-interrupt-gc/repro-match.mjs` → `modelwar match: 600 tick 已结算`、
  退出码 **0**(修复前:同一份 input 稳定 `exitCode 2`)。
- `pnpm exec vitest run --project unit packages/engine` → **268 passed / 0 failed**(含新增两条
  `quickjs.test.ts` 用例:find 家族等价性;中断落在 find 里之后 `runGC` 不再崩)。
- `pnpm run check:quick` → 全绿。
- `pnpm run verify:fast` → **92 files / 987 tests passed**。
- 未改 runtime bundle 与 `rulesets/`,故 `runtime:build` / `check:runtime` / `check:budget` 无漂移
  (`check:quick` 内的 `check:budget` 已跑绿)。
