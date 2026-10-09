# 01: 基线重测与门禁表改写

**What to build:** 用与旧基线同一方法(同机、5 次取样、报中位数)重测快慢六道门禁的耗时,旧数保留只追加新行;把门禁表改写为只登记归属层,命令细节永远以命名脚本为真源,并按现状改写过期边界声明。

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] 六道门禁耗时已重测并落盘,旧基线保留作历史
- [x] 门禁表只登记归属层,快门禁正名为 6 步,运行时 bundle 门禁补归属与用途
- [x] 过期边界声明已按 F/G/H/I 落地后的真实覆盖面改写

## Answer

### 跑了哪条命令、为什么

- **`pnpm run check:selfproof` × 5**:补上票面点名的 `check:selfproof` 5 次读数,逐次墙钟写进
  `.scratch/release-gates/readings-raw.log`。逐条 bash 调用分开跑(每次 2 条以内,每条 < 10 分钟),
  避免又一条超长调用被看门狗掐断。
- **`test:slow` 第 5 次不必重跑**:前一个续跑子代理被掐断前已把 `SAMPLE test:slow 5 396.16 s exit=0`
  追加进日志(它是在起 `check:selfproof` 第一次时被掐的),日志里 5 次样本已齐。
- **`pnpm run check:quick`**:收口验证文档改动的格式与轻量门禁(docs 的 fmt 由它覆盖),绿。

### 读数口径与树的分歧(必须记下)

`check:types` / `check` 的读数是在**前一个续跑子代理已修** `packages/runner/src/season-config.ts`
`no-base-to-string` **的树上**取的(两轮都 exit=0)。这份修复不属本票,现由 PR 分支上的另一版本承载;
本 worktree 已把它回退,因此在本 worktree 重跑 `check:types` / `lint:types` 会因基线上本就存在的
`no-base-to-string` 而红——上表的绿与工作树的红要在这一步口令下读。原始证据在
`.scratch/release-gates/readings.md` §4。

### 六道门禁中位数(2026-10-09,基线 `ea23863`)

`check:quick` **1.68s** / `check:types` **3.00s** / `check`(全量)**94.04s** /
`test:gates` **68.97s** / `test:slow` **396.16s** / `check:selfproof` **120s**。
逐次样本、环境(Node v24.15.0 / Linux x86_64 / cpus=8)、方法与同旧基线(77 文件时代)的并列对照见
`.scratch/release-gates/readings.md`。

### hld 改写的落点

- §2.2.7 门禁表:改为**只登记归属层**(编辑循环 / `verify:fast` / `check` / 按需→夜间),不再复制命令清单;
  `check:quick` 正名 **6 步**;`check` 行补上遗漏的 `check:runtime`;新增 `check:runtime` 归属(末尾复核组,
  `CONTENT_RECHECKS`)与用途(runtime bundle 三段判定);`:218` 的「末尾复核」段补 `check:runtime`。
- 耗时表:改为四列(2026-10-01 中位 / 2026-10-03 逐次取样 / 2026-10-03 中位 / 本轮中位),旧数不删,
  追加本轮六道门禁新行,逐次样本只在 `readings.md`,hld 只引用不复制。
- `:210` 边界声明按 F/G/H/I 落地后的真实覆盖面改写(92 测试文件 / 987 用例、284 文件、182 模块 / 506 依赖边)。
- 表内 `mutate` / `scan` 的「尚未落脚本」原样留在「按需→夜间(未落)」层,归票 06/07。
