# 变异分片基线

一个分片一份基线,`<分片名>.json`,分片名与 `stryker/<分片名>.mjs` 里的 `name:` 逐字相同。

## 为什么基线入库

变异分数是**棘轮**(`docs/adr/0026-mutation-score-is-a-ratchet.md`):不设绝对红线,只设「不许比上次低」。
棘轮的判据是「这一片不许比入库基线低」,所以基线是**判据的一部分**,不是产物——产物(`reports/mutation/`)
整目录被 `.gitignore` 忽略、可以过期;基线不能,不入库的棘轮不是棘轮。

放在分片配置旁边(`stryker/baseline/`),是因为「哪一个分片的基线」与「哪一个分片的配置」是同一个问题。

## 比较口径

- **比较单位是分片,不是一个文件、也不是全仓加权分**。分片的物理依据写在 `stryker/base.mjs` 头注:
  Stryker 一次进程只有一份 `mutate` scope 与一份 `testFiles`,跨包覆盖会被静默记成
  `Survived` / `NoCoverage`。因此**分片之间只能比趋势,不能比分数**,两份基线并排读是误用。
- **判决用整数交叉相乘**,不用文件里的百分比:

      current.detected * baseline.valid < baseline.detected * current.valid  →  低于基线(红)

  其中 `detected` = `Killed` + `Timeout`,`valid` = `detected` + `Survived` + `NoCoverage`
  (与 `mutation-testing-metrics` 的 `mutationScore` 同源)。`score` / `coverageBased` 两个
  **百分比只是给人读的副本**,四舍五入到两位小数,不参与判决(`packages/tools/src/mutation/ratchet.ts`)。
- 每次跑完分片入口(`pnpm run mutate:<分片>`)就地比较并打印判定;判定层不写任何文件。

## 当前**未播种**的分片:`engine` 与 `gen`

这两片**没有**基线文件,棘轮对它们报「首次」而不判红(`first-run` 不判红是刻意的:把「还没跑过」
当成「退化了」,那种红只有抬基线能消,而抬基线又会变成刷分的入口)。原因只有一条:

- **没有覆盖各自 `mutate` 范围的真实报告。** 分片改造初期,`engine.json` 与 `gen.json` 是拿一次性
  单文件标定跑(`processor/economy.ts` 73 个变异体 / `src/retry.ts` 59 个变异体)算出来的数字,
  它们不覆盖本分片的范围,拿来当基线就是把单文件的分数冒充成整片的分数——于是那份文件已删除,
  这两片按「首次运行」处理。
- `engine` 片由 `engine-core` + `engine-runtime` 已覆盖(两片各有基线),`gen` 片由
  `gen-core` + `gen-io` + `gen-pipeline` 已覆盖(三片各有基线);整片配置(`stryker/engine.mjs`、
  `stryker/gen.mjs`)保留下来,是为了「一次进程跑完整包」这条对照还在。

## 怎么播种(唯一入口,且 agent 不得运行)

跑完一次**真实的全范围**变异之后,用显式命令把这一片的数字记下来:

    pnpm run mutation:baseline:raise -- --shard=<分片名>

- 它必须带 `--shard=<name>`:不存在「无参数全量重写」(分片名拼错直接非零退出,一个字节都不写)。
- 它只写被点名的那一片,且不会碰别的分片的基线。
- 它**不在**任何流水线、任何默认链、任何常跑入口上(门禁自测断言这一条)。
- **agent 不得运行它**(`AGENTS.md`《门禁纪律》)。这与「`check:selfproof --probe` 只准用于反例」
  是同一个形状:**能改判据的开关,不能出现在判据自己的正常路径上**。

命令只写 `shard` / `detected` / `valid` / `score` / `coverageBased` / `source` 六个字段;
`note`(「这个数字打哪来、为什么不覆盖全范围」之类的说明)由人手写——它是随情形变的话,不是命令能猜的。

## 已知的口径漂移

- **`tools` 片的 mutate 范围刚收窄过**:`packages/tools/src/**/run-*-gate.ts`(一次性门禁入口,
  只被 spawn 子进程的门禁自测观察)已排除。入库的 `tools.json` 是在**收窄之前**跑的(含那批
  `NoCoverage`),所以同一个分数在收窄之后会**变高**——判绿不代表测试变强了,只代表分母里的
  死变异体少了。下一次真实全范围跑之后按上面的命令显式抬升,这条漂移才会消失。
- `!**/*.prop.ts`(属性测试不进变异范围)是 `stryker/base.mjs` 里的通用排除项。现有基线的来源
  报告里本来就没有 `.prop.ts` 文件,所以这条不影响已有基线的可比性。
- 单条命令的字段口径与退出码见 `packages/tools/src/mutation/run-mutation-ratchet-gate.ts` 头注。
