# 05: 标定复算门禁与失效触发表

**What to build:** 一条标定复算门禁:重跑预算探针与基准脚本,判终值仍自洽(探针仍被截停、基准仍不被截停);三类终值失效事件各配一行触发说明,指明哪类变更跑哪条命令、红了开重标节点。不做自动嗅探。

**Blocked by:** 01 (归属层口径).

**Status:** resolved

## 验收

- [x] 标定复算脚本落地并挂夜间层,失配语义两侧各有弄红反例
- [x] 三类失效事件触发表已文档化

## Answer

**门禁脚本与命令**:`packages/tools/src/budget-recheck/run-budget-recheck-gate.ts`(新),根命令
`package.json:39` 的 `check:budget-recheck` = `node --disable-warning=ExperimentalWarning
packages/tools/src/budget-recheck/run-budget-recheck-gate.ts`。它只**编排**现成的探针测试
(`packages/engine/src/runner/probe-harness.test.ts`,设 `MW_BUDGET_RECHECK=1`),不新开探针格式;
按需→夜间层,不进 `check:quick` / `check` / `test` / `verify:fast`(位置纪律见下)。夜间流水线由票 07
统一接线,本票只把脚本与入口落进该层。

**缺口怎么补(终值键真正装上)**:`probe-harness.test.ts` 的诚实侧原先传 `budget: {}`(空预算,一条轨
都没启用),「不被截停」证明不了「终值下不被截停」。复算模式新增 `finalBudgetOf`
(`probe-harness.test.ts:227`):按键清单里 `calibration.state === "final"` 的轨从 `rulesets/v1.json`
组装预算(与 `apps/cli/src/match/assemble.ts` 的 `budgetOf` 同一判据),再同时装到**探针座位**
(`:788` `seatBudgetOptions`)与 `runMatch`(`:806`)。诚实侧复算只跑三份基准脚本各一场(同图同种子,
`:196` 的 `RECHECK_HONEST_SCENARIOS`),足以覆盖三份脚本并让终值推导的四个峰值不再退化。

**失配语义怎么落成断言**(三条 `复算:*` 用例,只在 `MW_BUDGET_RECHECK` 设上时跑):
- `probe-harness.test.ts:1367`「复算:终值下三类探针必被截停」——死循环探针在 `RULESET.eventTickLimit`
  上被 `eventTickLimit` 轨截停、API 轰炸探针在 `RULESET.apiCallTickLimit` 上被 `apiCallTickLimit` 轨
  截停;三轨异常探针各在终值上限上被反复触发,`totalExceptions === exceptionProbeTicks`。
- `:1413`「复算:终值预算下三份基准脚本必不被截停」——每场 `status === "completed"`,且《HonestMatch》
  新增的 `exceptionTicks`(`:506`)恒为 0(没有一条轨触限);前置断言「终值键数 > 0」防假绿。
- `:1435`「复算:终值推导与规则集逐键自洽」——把 `readings.md` 里那节散文推导变成 `expect(derived).toBe(RULESET[key])`;
  逐字相等豁免墙钟两键(`:1433`),理由是它们的推导依赖一次负载敏感的墙钟读数(终值取的是观测机制
  下界,机器一竞争读数就把它顶掉),其结构约束由 `check:budget` 看着、行为侧由另两条看着。这条豁免在
  实测里被逼出来:早期版本断言全部八键,5 次复跑里 1 次因墙钟读数漂到 14ms 而假红;收窄后 5/5 稳定绿。

**反例位置与结果**:
- `packages/tools/src/gates-slow.test.ts:148/158/166` 三条(真沙箱,合计约 49s):正例绿一次;
  `--tamper-probe`(把一条对抗探针上限抬到燃烧量之上)→ `预算复算门禁:红(探针未被截停)` → 还原绿;
  `--tamper-baseline`(事件轨压到 1)→ `预算复算门禁:红(基准被截停)` → 还原绿。tamper 只改本进程传给
  被测测试的 env,不动仓库。
- `packages/tools/src/gates.test.ts:1400`「标定复算门禁按需跑:不在快链里,但有独立入口」——五个常跑入口
  都 `not.toContain`,末尾复核组也不含,入口仍指向 `run-budget-recheck-gate.ts`。

**触发表**:`.scratch/release-gates/budget-recheck-triggers.md`(新)。三类失效事件(契约散文修订、
快照结构变更、runtime 版本或中断粒度变更)各一行:**哪类变更 → 跑 `pnpm run check:budget-recheck` →
红了开重标节点**,并写明「不做 git-diff 嗅探」「不做定时自动重标」。指针落在 `docs/hld.md:641`
(§5.3 标定判据末),只指门禁与触发表的存在,真源在脚本与 `package.json`。

**改动文件**:
- `packages/tools/src/budget-recheck/run-budget-recheck-gate.ts:1-131`(新):门禁编排 + 红/绿与缘由。
- `package.json:39`:`check:budget-recheck`。
- `packages/engine/src/runner/probe-harness.test.ts:144/227/240/242/788/806/1367/1413/1433/1435`:
  复算模式、终值预算组装、`HonestMatch.exceptionTicks`、三条 `复算:*` 断言(默认 run 与
  `probes:budget` 的开关语义不变:不设 `MW_BUDGET_RECHECK` 时诚实侧仍是 `budget: {}`)。
- `packages/tools/src/gates.test.ts:1400`、`packages/tools/src/gates-slow.test.ts:141-176`:位置纪律 + 反例。
- `docs/hld.md:641`:§5.3 指针。
- `.scratch/release-gates/budget-recheck-triggers.md`(新):三类失效事件触发表。
- `packages/runner/src/season-config.ts:167`:顺带修复**基线本就红**的 `oxfmt`(ad3181f 遗留的长行),
  否则 `check:quick` 第一步即红(与本票无关,但不修则「`check:quick` 必须绿」不成立)。

**命令证据**:
- `pnpm run check:quick` → 绿(fmt / lint / coupling / coupling:quickjs / check:no-float / check:budget)。
- `pnpm run check:budget-recheck` → `预算复算门禁:绿`(约 12s,连跑 5 次 5/5 稳定)。
- `pnpm run check:budget-recheck -- --tamper-probe` → 退 1,`红(探针未被截停)`;
  `-- --tamper-baseline` → 退 1,`红(基准被截停)`。
- `pnpm exec vitest run --project gates -t 标定复算` → 1 passed;`--project slow -t 标定复算` → 3 passed。
- `pnpm run test` → 92 files / 988 passed / 3 skipped(跳过的正是三条复算用例,复算模式下全跑)。
- `pnpm run test:gates` → 42 passed;`pnpm run check:drift` → 无漂移。
