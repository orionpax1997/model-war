# 07: 并发子进程池 + 异常重跑与剔除

**What to build:** 把串行赛季变成**并发赛季**:对局子进程池,并发度默认 `min(cpus, 8)`、可在 `season.yaml` 覆写;每局一个 `modelwar match` 进程,对局之间互不干扰。**调度器只认退出码**:引擎崩溃(码 2)或不确定超时(码 3)→ **重跑一次**;再触发则记入**对局问题清单**并**排除出排名**,不静默丢弃。硬超时复用既有 `wallClockHardTimeout` 口径,不另造阈值。码 1 / 4 视为赛季级失败 → 中止并报错(装载期错误本应在物化前拦住)。规则内结果(含内存超限判负、带异常出局的席位)一律是码 0,**绝不被崩溃条款误判**。

**Blocked by:** 06

**Status:** resolved

- [x] 并发度可覆写;多局并行时互不干扰(同一 fixture 赛季,并发与串行产出一致)。
- [x] 退出码 2 → 重跑一次;连续两次 2 → 该局进问题清单、排除出排名、报告里含它。
- [x] 退出码 3 同 2;未另造超时阈值。
- [x] 退出码 1 / 4 → 赛季中止并报错退出,不静默剔除。
- [x] 用可控退出码的假 `modelwar match` 覆盖 0 / 1 / 2 / 3 / 4 与「重跑一次」序列。
- [x] 码 0 的规则内结果(含内存判负)不被误判为崩溃。

## Answer

**改了什么** —— `packages/runner/src/scheduler.ts`(票 06 的串行 `for … await` 换成信号量池):

- **并发池**:`concurrency = season.concurrency ?? min(cpus().length, 8)`(hld §8.1);worker 数 = `min(concurrency, 队列长度)`(`max(1, …)` 兜住 `cpus()=0` 的极端)。每局一个独立目录 `<outputDir>/matches/<comboId>-<map>-s<seedIndex>/`,物化 `input.json` 后 spawn,子进程只写自己目录的 `replay.jsonl`,局与局无共享文件。
- **只认退出码分流**(真源 `apps/cli/src/exit-codes.ts`):
  - `0` → 读回放末行 `result`,入 `matches`;规则内结果(胜/负/超时/淘汰、内存判负、带异常出局的席位)一律是 0,**从不进问题清单**。
  - `2` / `3` → **重跑一次**;再触发同码 → 入 `problems[]`(`reason` = `engine-crash` / `nondeterministic-timeout`,`exitCode` 记第二次的码),**排除出 `matches`**,报告仍含它(不静默丢弃)。
  - `1` / `4` → **赛季级中止**,原码返回(不重跑、不静默剔除)。
  - `null`(被信号杀)/ **其它未在码表里的非零码** → 同样赛季级中止,折成退 1。判据:这些既不带「引擎故障/超时」的可重跑语义,也不能安全折成「这局无效、赛季照跑」——那会把坏环境伪装成「成功赛季 + 全进问题清单」。
  - **子进程无法启动**(`spawnMatch` 抛错,如 ENOENT) → 赛季级中止:一个启不来的可执行文件对每一局都必然失败,不是某局的偶发异常。
- **不另造超时阈值**:调度器不设父级墙钟看门狗、不硬编码毫秒数;不确定超时完全由子进程退出码 3 表达(复用规则集 `wallClockHardTimeout` 既有口径)。
- **确定性排序**:池完成顺序不定 ⇒ 写盘前按 `(comboIndex, mapIndex, seedIndex)` 升序重组(`comboId` = `c<comboIndex>`;用数值下标而非词法比较,因 `c10` 词法上排在 `c2` 前)。并发度 1 与 N 产出的 `report.json` **逐字节相同**。
- `SeasonReport` 增 `problems: MatchProblem[]`(含 `comboId` / `map` / `seed` / `inputPath` / `reason` / `exitCode`),供票 08/09 渲染;`index.ts` 头注与 `scheduler.ts` 头注同步改为并发口径。

**测试** —— `packages/runner/src/scheduler.test.ts`:可控 `deps.spawnMatch` 桩(按「局目录名 × 第几次尝试」分流)。覆盖 0 / 1 / 2 / 3 / 4 / null / 未知码;「首发 2 → 重跑成功(恰好 2 次 spawn)」;「连续两次 2 → 问题清单 + 排除出 `matches` + 报告含它」;码 3 同;码 1 / 4 → 中止非零且不重跑;码 0 的 `victory` / `all-eliminated` 不进问题清单;并发 4 与串行 1 的 `report.json` 逐字节相同。既有 06 用例保留并适配 2 / 3 新行为。

**验证**:`pnpm run check:quick` 通过;`pnpm vitest run --project unit packages/runner apps/cli` 225 通过 0 失败。

**未做 / 留后**:排名记账与「有效局分母」从 `problems` 剔除归票 08;问题清单的叙事渲染归票 09。runner 依赖面仍只有 `@model-war/schema` + node 内建。
