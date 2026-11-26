# 档案 fixture（从真实 `archive/` 脱敏裁出来的最小样本）

`archive/` 不在版本控制里（`.gitignore`），而这里的决定是「删生成侧、留读侧」：既有的
v1 / v2 成功档与失败档仍要能被报告、复跑与回放读出。那些只由存量档案覆盖的读侧分支靠这里
的副本保活——**测试不依赖 `archive/` 目录**。

## 为什么需要它们（一句话：不留沉默的 skip）

读侧对档案的依赖一写成 `it.skipIf(!existsSync(...))`，在干净克隆上就变成「这条用例不存在」：
退出码照样 0，报告里只有一个小小的 `↓`。那比删掉用例更糟——删掉是看得见的缺口，skip 是看不见的。
所以凡是「读侧要能读得动真档」这类判据，凭据一律入库成下面的副本，用例**不带任何守卫**直接跑，
仓库在不在本机、有没有跑过真生成，读数都一样。本机 `archive/` 与这里的关系就此只有一条：
**副本是从它裁出来的**（血缘写在下表的「来源」列），跑测试时两边互不引用。

## 有什么

| 目录 | 来源 | 覆盖的读侧分支 |
|---|---|---|
| `legacy-v1-selection/` | `archive/claude-haiku-5-5/2026-10-13T13-48-45-710Z/` | 优化 v1（三场单图试跑）+ 选拔 v1（12 场 / 三基准 / 种子 401–403） |
| `legacy-v2-grid-selection/` | `archive/deepseek-v4.1-flash/2026-11-09T03-12-35-241Z/` | 优化 v2（评测网格 + 四陪练身份）+ 选拔 v2（逐场观测摘要） |
| `legacy-plain/` | `archive/claude-haiku-5-5/2026-10-10T16-31-38-484Z/` | 最早的 11 键形状：无 `optimization`、无 `selection`、无 `channelId` |
| `legacy-failure-transport/` | `archive/deepseek-v4.1-flash/failed-2026-10-08T14-49-44-003Z.json` | 零 prompt 的传输失败记录（无候选、无日志行） |
| `legacy-failure-candidates/` | `archive/mimo-v2.6-pro/failed-2026-11-09T04-05-15-241Z.json` | 带一个 `stage: 0` 候选的传输失败记录（候选描述 + 传输末行） |
| `v3-glyph-cluster/` | `archive/glyph-cluster/2026-11-19T11-29-52-739Z/` | **v3 真档的唯一副本**（12 步 `bash` + 3 步 `evaluate`、`wall-clock`、3 候选）。升到 v4 之后它证明「v3 照旧可读、不迁移」 |
| `v1-observed-minimax/` | `archive/minimax-m3.1-flash/observed-2026-10-13T13-48-45-729Z.jsonl` | **观测旁挂件与 `<runId>/` 同级**这个位置，以及 v1 三场观测读出来的三层反馈（座位0 / 同格 / 末位 3 局 / 分差 58） |
| `sparring-ladder/` | `archive/` 里四份钉死身份（`TRIAL_SPARRING_LADDER` + `TRIAL_SPARRING_SUBSTITUTE`）的 `script.js`，外加 `gpt-6.1-sol` / `deepseek-v4.1-flash` 的目录结构 | **钉死摘要 == 盘上字节**（身份能核实）、在位取该模型最近一档、与存档同级的 `feedback-<runId>-<hash>` 旁挂目录不入选 |
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

## `v1-observed-minimax/` 与 `sparring-ladder/`：这两个为什么裁成这样

这两份供的是**另一类判据**——不是「报告读得出来」，而是「读侧认的凭据在盘上对得上」。裁剪纪律与
上面几节相同（形状、字节、哈希关系逐字保留），只有取舍点不同：

1. **`sparring-ladder/` 只有 `script.js`，没有 `meta.json` / `script.ts`。** 陪练池装载只读两样东西：
   `<slug>/<runId>/script.js` 的字节，与那一层的**目录名**。`meta.json` 是落档那一刻的自述，
   装载故意不信它（摘要现算），所以留一份 `meta.json` 只会让人以为它在参与判定。
2. **四份钉死身份的 `script.js` 逐字节复制，不裁剪。** 它们的内容摘要钉在
   `@model-war/schema` 的 `TRIAL_SPARRING_LADDER` / `TRIAL_SPARRING_SUBSTITUTE` 里——裁一刀就不再
   对得上，「钉死的摘要 == 盘上字节」这条判据也就跟着消失。这四份是这批 fixture 的体积主体
   （约 90 KB），和 `v3-glyph-cluster/` 逐字节留候选 `.candidate.js` 是同一个理由。
3. **`sparring-ladder/` 保住了「同一个 `<slug>/` 下还住着别的东西」这个结构。** 在位那两档各有
   两份真存档目录（一旧一新），`deepseek-v4.1-flash/` 下再放一条 `feedback-2026-10-12T06-44-23-721Z-8477e747/`
   ——它也带 `script.js`，而 `'f' > '2'`，所以「按名字排序取最大」会挑中它。**这个结构本身就是被测对象**，
   删掉它这条判据就没有反例了。
4. **`v1-observed-minimax/` 整行不裁。** `readTrialObservations` 对每一行做闭合字段与计数自洽校验，
   把观测裁成「只留断言用到的字段」就等于把被测的「读得动真档」换成「读得动我造的形状」。这一份
   8.5 KB、三行、没有自由文本（全是计数与终局事实），所以既没有可脱敏的，也没有可省的。
5. 两份都**没有**改写 `model` / `runId`：取用它们的判据只认字节与目录名，不认具体是谁；而改写名字
   会让「这份副本来自哪一档」这条血缘断掉。真档里那些带模型自由文本的字段（prompt、步内 `stdout`、
   失败记录的过程记录）两份都不需要，所以压根没进来。

## 为什么不参与格式与类型检查

这些文件是**入库的档案字节**，不是源码：`meta.json` 里的身份摘要拿它们核对，格式化或改写会
让测试失去唯一的凭据。所以 `.oxfmtrc.json`、`.oxlintrc.json` 与
`packages/runner/tsconfig.json` 各留了一条**只指向本目录**的排除，理由写在对应位置。
