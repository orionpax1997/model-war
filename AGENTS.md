# Agent Skills

This repository uses Matt Pocock's engineering skills (installed under `.pi/skills/`).

## Git

- **提交信息里禁止出现 `Co-Authored-By`（以及任何 `co-authored-by`）。** 本仓库只有一个作者；带上它会让 GitHub 把那个邮箱算成 contributor。历史上 agent 手写过 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`（那几次跑的模型并不是 Claude,是照抄的串）,已在 2026-10 用 filter-repo 剥掉。`.githooks/commit-msg` 负责拦住，新 clone 需要 `pnpm run setup:hooks` 装上（装包时 `prepare` 也会自动装）。

## Agent skills

### Subagents

- code-review skill:Standards 与 Spec 两个子代理都用 `Review`(`.pi/agents/review.md`)派发。
- research 任务：调研与探索一律派给 `Explore` 子代理，主线程只下指令和聚合结论，不自己读文件爬代码。派发时必须在 prompt 里写明「用 codegraph 查」,探索子代理优先调用 codegraph MCP 工具（见下节）,grep/find/read 只作补充。
- 探索子代理的产出是结论 + 关键文件：行号引用，不是文件转储；不要让它整段贴源码回来。
- 实现与修复期间运行 `pnpm run check:quick` 和相关测试；完成 review 修复后，由主线程运行 `pnpm run verify:fast`。`verify:fast` 是 `check:quick`（格式、lint、轻量门禁）加默认快速 `test`（unit + property）的唯一收口命令；Vitest 会为工作区依赖做增量构建。`check` 全量门禁、`test:gates`、`test:slow`、`check:selfproof`、变异测试等专项质量检查仅在验收明确要求或改动直接影响其覆盖范围时运行，并说明原因。

### 门禁纪律

- **agent 不得运行 `pnpm run mutation:baseline:raise`。** 变异基线的抬升只由这条命令完成，它不在任何流水线、默认链或常跑入口上。agent 的职责是修测试把分数拉回去，不是抬基线让门禁变绿。
- 这条与「`check:selfproof --probe` 只准用于反例」是同一个形状：**能改判据的开关，不能出现在判据自己的正常路径上**。门禁自测里它也只能指向临时路径，不许碰 `stryker/baseline/`。

### 工作记录与长期信息

长期项目事实进入代码、配置、方向性设计文档或 ADR，并由对应位置作为唯一真源。分支、worktree 与临时任务记录服务于当前工作，完成后清理，不承担长期文档职责。

### 工作分支

`.pi/skills/implement-spec/SKILL.md` 保持原样；以下三节覆盖该技能中分支、提交、合并、清理四步。

| 分支 | 切自 | 生命期 |
|---|---|---|
| `main` | — | 恒绿；只接 hotfix 与收尾提交 |
| `feature/<slug>` | `main` | 一个变更流；可作为 draft PR 基点；合回即删 |
| `wt/<slug>-<NN>` | 当前变更流分支 | 一个本地工作区；合回即删 |
| `exp/<slug>` | `main` | 长期对照实验（换规则版本、换运行时），不混进交付分支 |

hotfix 落到 `main` 后，立刻把各活跃变更流分支 rebase 一遍。

### 提交：格式与正文

首行 `type(scope): 中文描述`；`type` 取 `feat fix docs refactor test perf build ci chore`；`scope` 取包目录名（`engine`、`runner`、`gen`、`cli`、`schema`、`replay`、`tools`）或子系统名（`dag`、`season`、`budget`、`sandbox`、`rules`、`git`），跨包用逗号并列。首行与正文之间空一行，正文用自然段或 `- ` 分点；需要指针时用 `Refs:` footer，指向长期存在的 `docs/adr/` 与 `docs/*`。

正文要让人读完就知道这次做了什么、波及到哪里、为什么这么做；这些在 diff 里读不全，得由写的人补上。怎么组织自己定，不设固定栏目。

### 提交：粒度

粒度按概念计，不按 ticket 计：条数等于概念数，与票数无关。小 spec 且单一概念，留一个提交；同一机制被拆成两半的票，合成一个，避免「绿但半成品」的中间提交；机械改动（生成物重跑、格式化、批量改名）单独成提交，不混进逻辑改动。检验「一个概念」的办法是单独 revert 它：动作有意义，且 revert 后仍绿。想拆提交而拆不动，是 spec 混了多个概念——先拆 spec。

### 合并与清理

- 合回 `main` 用 rebase 或 `--no-ff`。**不许把整条变更流压成一个提交**:本地用 `reset --soft` 压成一条、或手工 `commit` 一条收口,与 GitHub 的 squash 按钮同性质,一样绕开上面的 message 与粒度判据。压提交只允许压到「概念数」为止,且压完必须重新按上一节验过。
- 合并点是验收点：`verify:fast` 在待合入的树上绿；值得独立验收的票，其断言已随提交留在代码里。
- 合入一个工作分支后跑其范围的测试，随即删除其 worktree 与分支，不等全部完成统一清理。
- 冲突超过三个文件或属非机械冲突，退回实现者重做；merger 只搬运，不改代码。

以上是提示词层约束，不配脚本、不加 gate：反馈循环的速度优先于机器强制。

## Design docs

阅读顺序：docs/vision.md(why)→ docs/gdd.md(玩法意图与约束)→ docs/hld.md(how)。精确规则与参数不在设计文档里，读 `docs/rules-v2/`(面向模型的契约)与 `rulesets/*.json`。

每个事实只有一个家。写或改文档时，先看它归谁：

| 文档 | 唯一拥有 | 不写（留指针） |
|---|---|---|
| CONTEXT.md | 领域词汇与容易误用的概念 | 规则、架构、决策 |
| docs/vision.md | 定位、服务对象、核心差异、非目标与产品取舍、长期风险 | 规则机制、工程方案、验收条款 |
| docs/gdd.md | 玩法设计意图、不可从代码推导的约束、规则侧决策记录 | 精确规则与结算顺序、参数取值、工程实现 |
| docs/hld.md | 架构与包拓扑、进程模型、确定性手段、沙箱威胁模型、不可破坏的工程约束 | 玩法规则、参数取值、需求条目 |
| docs/adr/ | 决策记录：问题 / 方案 / 被否方案 / 长期约束 / 重评条件 | 当前实现、当前取值（会过期） |
| docs/rules-v2/ | 面向模型的契约（生成物） | 私有实现细节 |

- 参数取值真源是 `rulesets/*.json`;`docs/rules-vN` 的数值表由它生成，文档里不复制取值。
- **代码是真源，但契约不可删**：`docs/rules-vN/` 是模型唯一能读到的规则输入（相当于公开 API 文档），由代码、schema 与 `rulesets/` 生成，由漂移门禁保证不漂移。
- **验收不由需求编号承担**：验收条款写在能被跑出来的东西上（命令、测试、门禁）；`docs/hld.md` §11 是那张落点表。
- 文档之间冲突时：先看真源（代码 / `rulesets/` / 生成物），再看 ADR 的裁决；发现冲突就修矛盾的一方（删除或改指针），不要两边各留一份。
- 变更历史由 git 承载，文档头部不写逐版本变更记录。

## Domain docs

When exploring a domain area, read the relevant `CONTEXT.md` and ADRs first. See [docs/agents/domain.md](docs/agents/domain.md) for the lookup rules.

<!-- CODEGRAPH_START -->

## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool (when available):** `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell (always works):** `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
