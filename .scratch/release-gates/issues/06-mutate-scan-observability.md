# 06: 变异测试与代码扫描观测接线

**What to build:** 变异测试配置落库且范围只限引擎结算管线,挂夜间只落盘不设红线;代码扫描只做行数与复杂度观测落盘。交付的是"配置存在且可调通",不是分数达标。

**Blocked by:** 01 (夜间层定义).

**Status:** resolved

## 验收

- [x] 变异配置落库且范围限定引擎结算管线,夜间可调通且产物落盘
- [x] 代码扫描观测落盘,无任何分数或行数红线

## Answer

**改动文件**

- `package.json:39-40` 加两个命名脚本:`"mutate": "stryker run"`、`"scan": "node packages/tools/src/gate/run-scan-gate.ts"`;`:48-49` 加 devDep `@stryker-mutator/core@10.0.0` + `@stryker-mutator/vitest-runner@10.0.0`(精确锁版,二者同版本——vitest-runner 对 core 是 exact peer)。
- `stryker.config.mjs`(新):`mutate` = `packages/engine/src/processor/**/*.ts` + `!...*.test.ts`(不含 `world/`、`snapshot/`);`packageManager: 'pnpm'` + `plugins`;reporter 双路径显式写死(避开 html 默认 `reports/mutation.html` 与 json 默认 `reports/mutation/mutation.json` 不一致的坑);`thresholds: { high: 0, low: 0, break: null }`(只落盘不设红线);`testFiles` 收到 processor 测试(否则 dry-run 会拉进会 spawn `check` 的 `gates.test.ts`);`tsconfigFile` 见下「风险」。
- `packages/tools/src/gate/scan-gate.ts`(新,纯函数层:meta 形状 + 观测 argv)+ `packages/tools/src/gate/run-scan-gate.ts`(新,薄壳,与现有 `run-*-gate.ts` 同形)。
- `.gitignore:13,16,17`:补 `reports/`、`.stryker-tmp/`、`stryker.log`。
- `packages/tools/src/gate/scan-gate.test.ts`(新,`unit` project)+ `packages/tools/src/gates.test.ts:1442-1524`(新增一节,`gates` project)。
- `docs/hld.md:180`「按需 → 夜间」行改写为「`mutate`/`scan` 只观测、不设红线,范围/落点/缺二进制降级,均不进 `check:quick`/`check`」;`docs/hld.md:114` 变异测试行「**尚未安装**」按实改为「已装 10.0.0 + 配置落库 + 只落盘」。
- `packages/runner/src/season-config.ts`:oxfmt 机械格式化(3+/1-),见下「风险」。

**命令证据**

- 安装:`pnpm add -D -w @stryker-mutator/core@10.0.0 @stryker-mutator/vitest-runner@10.0.0` → `+ @stryker-mutator/core 10.0.0` / `+ @stryker-mutator/vitest-runner 10.0.0`。**装上了**:10.0.0 发布于 2026-08-14,远超 `minimumReleaseAge` 的 24h 窗口,不需要 `minimumReleaseAgeExclude` 后门。
- `pnpm run mutate --dryRunOnly` → **exit 0**;日志:`Found 19 of 1209 file(s) to be mutated` / `Found 11 test file(s) matching --testFiles patterns` / `Instrumented 19 source file(s) with 1155 mutant(s)` / `Initial test run succeeded. Ran 124 tests in 4 seconds` / `The dry-run has been completed successfully. No mutations have been executed`.墙钟约 10s。**未跑全量变异**(票面只要求 dry-run)。
- `pnpm run scan` → **exit 0**;stdout:`scan 观测:scc 未安装,跳过扫描,已写 reports/scan/meta.json(skipped=scc-not-installed)。`;`reports/scan/meta.json` 内容含 `tool:"scc"`、`config:"none(--no-config)"`、`args:[--no-config,--by-file,--cognitive,--sort,complexity,--format-multi,json:reports/scan/scc.json,tabular:reports/scan/scc.txt]`、`gitSha`、`scannedAt`、`skipped:"scc-not-installed"`。**scc 未装**(无 npm 分发),走的就是跳过分支。
- 测试:`pnpm test` = 93 文件 / **991 passed**;`pnpm run test:gates` = **44 passed**;`pnpm run check:declared-deps` 检查 54 文件无违规;`pnpm run check:quick` **绿**。

**测试位置与断言**(只测配置/形状,不测分数)

- `scan-gate.test.ts`:`buildScanMeta(null)` → 只有 `skipped` 无 `version`;`buildScanMeta(version)` → 记版本与 outcome;`scanArgumentList()` 含 `--no-config` 与两个落盘路径。
- `gates.test.ts`:① Stryker 配置存在、`mutate` 正向 glob 全部以 `packages/engine/src/processor/` 开头、无 `world`/`snapshot`、测试文件被排除、`break: null` 在场;② `mutate`/`scan` 只进夜间——不在 `check`/`check:quick`/`check:types`/`test`/`verify:fast` 与 `tailSteps()` 里,但两个命名脚本在场;③ `pnpm run scan` 退 0 且 `reports/scan/meta.json` 的 `version`/`skipped` 恰有一个。**无任何分数/行数阈值断言。**

**风险 / 离线处置**

- Stryker 10.0.0 与 TypeScript 7.0.2 有一处接口错位:其 `TSConfigPreprocessor` 调 `ts.parseConfigFileTextToJson` / `ts.resolveProjectReferencePath`,两者在 TS7 已删除。沙箱起手会 `TypeError: ts.parseConfigFileTextToJson is not a function`。绕法:本仓库沙箱根 = 仓库根、根 tsconfig 的 `references` 全在仓内,无需该预处理器的路径重写,于是把 `tsconfigFile` 指到一个不进沙箱的文件名让其整段跳过(沙箱里那份真 `tsconfig.json` 照常供 `tsc -b`)。上游修好后删掉这一行即可(配置里有注释)。
- dry-run 的测试面由 `testFiles` 收到 processor 测试:不限定会把 `gates.test.ts` 拉进来(它 spawn `check`,而 `check` 又含 `vitest`,会套娃)。真跑变异时 `related: true` 仍按被变异文件过滤,不改 `mutate` 范围。
- **未跑全量变异**,首夜实测墙钟待落 `.scratch/release-gates/readings.md`(research tooling-forms §2.8 风险 3 的交办)。
- `packages/runner/src/season-config.ts` 的格式化修复与本票无关:它在基线提交(`d92654d`)上就不是 oxfmt 通过态,导致 `check:quick` 在动手前即红。为满足「`check:quick` 必须绿」做了机械 `oxfmt`(纯格式,无语义改动);该处的 `no-base-to-string`(`lint:types`)仍按 `.scratch/release-gates/readings.md` §4 的说明由 PR 分支另一版本承载,不在本票。
