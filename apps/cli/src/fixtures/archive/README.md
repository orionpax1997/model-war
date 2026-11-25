# 陪练档 fixture（从真实 `archive/` 抽出来的四份 `script.js`）

`archive/` 不入库（`.gitignore` 的 `/archive/`），而评测网格的四份陪练是**钉死的内容摘要**：
`TRIAL_SPARRING_LADDER` / `TRIAL_SPARRING_SUBSTITUTE` 里各带一个 `scriptSha256`，
`loadSparringPool` 拿它与 `archive/<slug>/<runId>/script.js` 的**盘上字节**逐字比。
所以只要安装面里没有这四份字节，`--plan` 就装不起来——没有它的机器上，`apps/cli` 的三条
端到端用例（`gen-cli.test.ts`、`selection/grid-selection.test.ts`、`trial/run-trial-script.test.ts`）
此前靠 `it.skipIf(!archivePresent)` 静默跳过：本机绿、干净克隆与 CI 上什么都不跑。

这里放的就是那四份字节，路径形状与安装面一致：`sparring-pool/archive/<slug>/<runId>/script.js`。

## 有什么

| 目录 | 来源 | 钉死的摘要 |
|---|---|---|
| `sparring-pool/archive/claude-opus-5-5/2026-10-16T08-40-12-578Z/` | 榜首（`top`） | `899b957f…deface7` |
| `sparring-pool/archive/minimax-m3.1-flash/2026-10-13T13-48-45-729Z/` | 中位（`mid`） | `c80854d3…e907a7` |
| `sparring-pool/archive/glm-5.3-flash/2026-10-13T22-30-50-602Z/` | 末位（`last`） | `8dab2849…e37e63` |
| `sparring-pool/archive/muse-spark-1.3-contributor/2026-10-13T12-34-16-218Z/` | 在位代位（`incumbent` + `#substitute`） | `9558cb9a…0a1c1` |

## 为什么是逐字节副本，为什么只留 `script.js`

`scriptSha256` 钉的是**字节**，不是形状：改一个空格、删一段注释都会让装载拒绝（那正是摘要的
意义）。所以这四份是 `cp` 出来的副本，不做任何裁剪——它们的「最小化」就是只带 `script.js`：
被测的三条用例只经 `loadSparringPool` 读这一份文件，`meta.json`、候选侧车、观测行都不在它们的
读取面上（报告侧的读盘由 `packages/runner/src/fixtures/archive/` 那一批保活，两批 fixture 覆盖的
是两套读侧分支，不互相顶替）。

## 为什么 fixture 里没有候选模型自己的档

`planForGridSelection(root, "gpt-6.1-sol")` 的在位脚本是「该模型自己最近一次冻结存档」，一份都没有
时用代位档顶替并在来源上标 `#substitute`。这里**故意**只放榜单侧那三份 + 代位档，于是计划在任何
机器上都走代位那条分支、逐字相同；两条用例把它显式断言出来（`script.source` 的 `#substitute` 后缀），
而不是让「本机恰好有哪几份档」决定断言的结果。「在位 = 自己的最近一档」那条分支由
`packages/runner/src/sparring-pool.test.ts` 用临时根覆盖。

## 谁在读

- `apps/cli/src/sparring-fixture.ts`：把这份 fixture 拼进一个**只差档案**的安装根
  （`rulesets/` `maps/` `packages/` `node_modules/` 指回仓库，`archive/` 只放这四份）；
- `apps/cli/src/trial/run-trial-script.test.ts`、`apps/cli/src/selection/grid-selection.test.ts`：
  `--plan` 与 `--expected-plan` 两条真子进程用例；
- `apps/cli/src/gen-cli.test.ts`：`mkRoot` 里把四份 `script.js` 符号链接进临时根。

## 为什么不参与格式与类型检查

与 `packages/runner/src/fixtures/**` 同一条理由：这些是**入库的档案字节**，不是源码，字节本身
就是被测对象，格式化器碰它会让用例红在一个与被检对象无关的原因上。`.oxfmtrc.json` 与
`.oxlintrc.json` 各留了一条只指向本目录的排除（`apps/cli/src/fixtures/**`）。
