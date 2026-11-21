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
| `v3-glyph-cluster/` | `archive/glyph-cluster/2026-11-19T11-29-52-739Z/` | **v3 真档的唯一副本**（12 步 `bash` + 3 步 `evaluate`、`wall-clock`、3 候选）。升到 v4 之后它证明「v3 照旧可读、不迁移」 |
| `v4-tool-call/` | 由生成侧写入器造（非真档） | **v4 的形状**：一条 steps 里 `bash` / `check` / `probe` / `evaluate` / `done` 五档齐全、`steps[i].toolCall` 带逐字 `argumentsJson`（含 `\u003c` 与多余空格两种与 `action.command` **不同形**的写法） |

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

`v3-glyph-cluster.golden.md` 是那份副本在**升到 v4 之前**跑出来的报告（改造前的读数），
用例对它逐字比对而不只断言退出 0。它不是「跑完代码随手存下来的」：升版前后的 `report` 输出
在同一份副本上 `diff` 为空——读侧不该因为写侧换代而改口径，golden 就是这条承诺的凭据。
它在票 05（候选序那条注换文案）之后仍然逐字相同：这份档的三次提交全是 `evaluate` 步，那一注
一次都不渲染。改过文案的那条注由 `archive-report-steps.test.ts` 的
「与 check 写在同一块」那条用例单独钉住，两类判据不互相顶替。

## v3 与 v4 两份新夹具的改写清单

前五份是 one-shot 时代（v1 / v2）的档，改写纪律见上一节。这两份是 agent 形态（分步）的档，
纪律相同、只有两处新增：

1. **v3 那份是真档的瘦身副本**（不是合成）。它保住了 20 个顶层键、15 条步的动作与耗时、
   16 行生成日志的用量读数，以及三份候选的 `.candidate.js` / `.candidate.ts` **逐字节**——
   所以 `scriptSha256` 与文件实测值仍然对得上，「身份能核实」这条判据在副本上照旧成立。
   改写的有三处：`model` 换成中性 slug（目录名同步）、`runId` 换成中性值（文件名与候选的
   `scriptFile` / `observationsFile` 同步）、`prompts` 与每步的 `stdout` / `raw` 与日志里的
   **证据来源自由文本**截短（它们是体积大头，而读侧只认 `status` 与长度无关的结构）。
2. **v4 那份由写入器造**（`@model-war/gen` 的 `buildArchiveMeta` + `commitArchive`），因为
   v4 真档还不存在（第一次真会话是票 07）。它必须造而不是手写：`meta.json` 的键序、`prompts`
   公式与三件套的 `scriptSha256` 都得是**写入口径**，手写一份等于把判据钉在一个不存在的
   形状上。它带的那两种 `argumentsJson` 写法（`\u003c`、`{ "command" : … }`）刻意为「逐字字节」
   那条反例服务：它们与 `action.command` 解析后的值**不同形**，所以「按 `argumentsJson` 读」
   与「按 `action.command` 重编码」在这份夹具上给出不同答案。

## 为什么不参与格式与类型检查

这些文件是**入库的档案字节**，不是源码：`meta.json` 里的身份摘要拿它们核对，格式化或改写会
让测试失去唯一的凭据。所以 `.oxfmtrc.json`、`.oxlintrc.json` 与
`packages/runner/tsconfig.json` 各留了一条**只指向本目录**的排除，理由写在对应位置。
