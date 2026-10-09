# 07: 主与夜间流水线建成

**What to build:** 两条流水线建成:合入触发快链、定时触发慢链与观测项。流水线内只调命名脚本,不引入新断言;CI 无凭证离线可跑。自带一条改错即红的冒烟验证。

**Blocked by:** 03, 04, 05, 06 (各链成员先就位).

**Status:** resolved

- [x] 两条链配置入库,快链与慢链各全绿一次
- [x] 流水线内无直调入口,失败等价于命名脚本失败
- [x] 改错即红的冒烟验证存在

## Answer

**改动文件**

- `.github/workflows/fast.yml`(新,主流水线)。
- `.github/workflows/nightly.yml`(新,夜间流水线)。
- `packages/tools/src/ci-workflows.ts`(新,纯函数层:解析 `run:` 步、判「只调命名脚本」、读 matrix 成员)。
- `packages/tools/src/ci.test.ts`(新,冒烟验证,`unit` project,默认 `test` 就会跑它)。
- 本票文件回写。

**链成员清单**

- 主链 `fast.yml`:触发 `pull_request` + `push(branches:[main])` + `workflow_dispatch`;成员 = `check:quick` + `test`(两条 `pnpm run <script>` step,失败信号与本地命名脚本一致)。
- 夜间 `nightly.yml`:触发 `schedule`(UTC `37 3 * * *`)+ `workflow_dispatch`;单 job matrix、`fail-fast: false`。硬门禁(`advisory: false`)= `check` / `test:gates` / `test:slow` / `check:selfproof` / `check:cross-process` / `check:limits` / `check:budget-recheck`;观测项(`advisory: true`,step 级 `continue-on-error`,把 `steps.run.outcome` 写进 `reports/legs/<script>.txt` 并 `if: always()` 上传)= `mutate` / `scan`。
- 两条链都 `permissions: contents: read`、无任何凭证引用;`run:` 只有 `pnpm install --frozen-lockfile`、`pnpm run ${{ matrix.script }}`、以及记录 outcome 的 `mkdir/printf/cat` 管道。

**本地全绿证据**(每个成员各跑一次,同机墙钟)

| 成员 | 结果 | 墙钟 |
|---|---|---|
| `test`(快链) | exit 0,94 文件 / 1003 passed | 85.7s |
| `check:quick`(快链) | exit 0 | 1.7s |
| `check` | exit 0 | 92.6s |
| `test:gates` | exit 0,46 passed | 62.4s |
| `test:slow` | exit 0,13 passed | 503.1s |
| `check:selfproof` | exit 0(四问全过) | 53.9s |
| `check:cross-process` | exit 0(600/600 逐 tick hash 一致) | 6.1s |
| `check:limits` | exit 0(#6 4.81%<10%、#7 171MiB<1024MiB) | 8.8s |
| `check:budget-recheck` | exit 0(终值仍自洽) | 11.3s |
| `scan`(观测) | exit 0(scc 未装 → `skipped` 落盘) | 0.3s |
| `mutate`(观测) | exit 0(1155 mutant,4 worker,产物落 `reports/mutation/`) | 236.0s |

`test:slow` 单跑;其余分若干条命令跑,单条均 ≤ 10 min。

**冒烟验证位置与反例**

- 位置:`packages/tools/src/ci.test.ts`(12 用例,`unit` project——因此主链 `pnpm run test` 自己就会把它跑红/跑绿)。校验纯函数在 `ci-workflows.ts`(`extractRunCommands` / `runStepViolations` / `matrixLegs` / `hardGateScripts` / `observationalScripts` / `namedScripts`),不新增运行时依赖(仓库无 yaml 库,用极简结构读取)。
- 反例(喂坏文本给同一纯函数,断言红):① `run: node packages/tools/src/...` → 命中「直调入口」;② `run: pnpm run does-not-exist` → 命中「引用了不存在的脚本」;③ `run: pnpm exec vitest run` → 命中「非命名脚本命令」;④ 从夜间 YAML 抽掉一道硬门禁 → `hardGateScripts` 立即与规格不符。正例:一份只含 `pnpm install` + `pnpm run <已知脚本>` 的最小 workflow 判绿。
- 成员断言:主链 = `check:quick` + `test`;夜间硬门禁齐全且观测项恰为 `mutate`/`scan`;夜间矩阵点名的脚本都必须在 `package.json.scripts` 里。触发/权限断言:主链挂 PR+push(main)且不挂定时,夜间挂 schedule+dispatch 且不挂 PR;两条链都无凭证引用。

**风险 / 离线处置**

- **真实 GitHub Actions 未跑**:本票只做配置入库与本地等价性;推送与真实 Actions 验证由主线程做。
- **`schedule` 延迟/丢弃是常态**:值班口径以 `workflow_dispatch` 手动重跑一次为准,别把「没跑」当「全绿」。
- **CI 不装 scc**(离线约束,不引第三方服务):`scan` 走脚本内探测,缺二进制写 `skipped` 标记并退 0;三夜基线之前不谈红线,artifact 里的 `meta.json` 会区分「今晚没装」与「今晚没代码」。
- **`mutate` 实测 236s**(1155 mutant),夜间 `timeout-minutes: 300` 宽裕;若后续范围扩大需重估。
- 未加 `pnpm run build` 前置步:`vitest.global-setup.ts` 的 `tsc -b` 已在每个 vitest 进程起手补一次,当前实测无「No tests were executed」问题。
