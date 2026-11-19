# 旧档 fixture（从真实 `archive/` 抽出来）

`archive/` 不在版本控制里（`.gitignore`），而 ADR-0031 的决定是「删生成侧、留读侧」：既有的
v1 / v2 成功档与失败档仍要能被报告、复跑与回放读出。那些只由存量档案覆盖的读侧分支靠这里
的副本保活——**测试不依赖 `archive/` 目录**。

## 有什么

| 目录 | 来源 | 覆盖的读侧分支 |
|---|---|---|
| `legacy-v1-selection/` | `archive/claude-haiku-5-5/2026-10-13T13-48-45-710Z/` | 优化 v1（三场单图试跑）+ 选拔 v1（12 场 / 三基准 / 种子 401–403） |
| `legacy-v2-grid-selection/` | `archive/deepseek-v4.1-flash/2026-11-09T03-12-35-241Z/` | 优化 v2（评测网格 + 四陪练身份）+ 选拔 v2（逐场观测摘要） |
| `legacy-plain/` | `archive/claude-haiku-5-5/2026-10-10T16-31-38-484Z/` | 最早的 11 键形状：无 `optimization`、无 `selection`、无 `channelId` |
| `legacy-failure-transport/` | `archive/deepseek-v4.1-flash/failed-2026-10-08T14-49-44-003Z.json` | 零 prompt 的传输失败记录（无候选、无日志行） |
| `legacy-failure-candidates/` | `archive/mimo-v2.6-pro/failed-2026-11-09T04-05-15-241Z.json` | 带一个 `stage: 0` 候选的传输失败记录（候选描述 + 传输末行） |

每个目录都是一个**报告根的雏形**：`<dir>/archive/<slug>/…`，直接 `cp -r` 到临时目录就能喂
`readArchiveReports(root)`（测试里就是这么做的）。

## 改写了什么（形状与哈希关系逐字保留）

1. `model` 改成中性 slug（`fixture-v1-selection` 等），目录名同步改——装载与报告都要求
   `meta.model === 目录名`。
2. `runId`（以及文件名、候选的 `scriptFile` / `observationsFile`）改成 `2026-01-01T00-00-00-00N Z`
   这一族中性值。
3. `prompts` 每条截到前 240 字符并加一行截断标记。prompt 正文对读侧判据没有信息（没有任何
   代码解析它），而它是这四份样本里唯一的体积大头。
4. 其余一律原样：`script.ts` / `script.js` / 候选的 `.candidate.ts` / `.candidate.js` 是**逐字节
   复制**的，所以 `meta.json` 里的 `scriptSha256` / `sourceSha256` / `selection.selected.*` 与
   文件实测值仍然对得上——「身份能核实」这条判据在 fixture 上照旧成立。

观测文件（`observed-*.jsonl`）与网格汇总（`*.grid.json`）**没有**复制：读侧对缺席的观测写
`state: "missing"` 而不是伪造读数，那本身就是一条要覆盖的分支（`packages/runner/src/archive-report.test.ts`
另有「观测在位」的用例）。

## 为什么不参与格式与类型检查

这些文件是**入库的档案字节**，不是源码：`meta.json` 里的身份摘要拿它们核对，格式化或改写会
让测试失去唯一的凭据。所以 `.oxfmtrc.json`、`.oxlintrc.json` 与
`packages/runner/tsconfig.json` 各留了一条**只指向本目录**的排除，理由写在对应位置。
