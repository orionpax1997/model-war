# Agent Skills

This repository uses Matt Pocock's engineering skills (installed under `.pi/skills/`).

## Git

- **提交信息里禁止出现 `Co-Authored-By`（以及任何 `co-authored-by`）。** 本仓库只有一个作者；带上它会让 GitHub 把那个邮箱算成 contributor。历史上 agent 手写过 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`（那几次跑的模型并不是 Claude,是照抄的串）,已在 2026-10 用 filter-repo 剥掉。`.githooks/commit-msg` 负责拦住，新 clone 需要 `pnpm run setup:hooks` 装上（装包时 `prepare` 也会自动装）。

## Agent skills

### Issue tracker

Local markdown: issues live as `.scratch/<feature>/spec.md` and `.scratch/<feature>/issues/<NN>-<slug>.md`. See `docs/agents/issue-tracker.md`.

### Subagents

- code-review skill:Standards 与 Spec 两个子代理都用 `Review`(`.pi/agents/review.md`)派发。
- research 任务：调研与探索一律派给 `Explore` 子代理，主线程只下指令和聚合结论，不自己读文件爬代码。派发时必须在 prompt 里写明「用 codegraph 查」,探索子代理优先调用 codegraph MCP 工具（见下节）,grep/find/read 只作补充。
- 探索子代理的产出是结论 + 关键文件：行号引用，不是文件转储；不要让它整段贴源码回来。
- implement-spec 采用快反馈：各 ticket 实现与修复期间运行 `pnpm run check:quick` 和该 ticket 的相关测试；所有 ticket 合并并完成最终 review 修复后，由主线程对整份 spec 运行一次 `pnpm run verify:fast`，再标记 PR ready。`verify:fast` 是 `check:quick`（格式、lint、轻量门禁）加默认快速 `test`（unit + property）的唯一收口命令；Vitest 会为工作区依赖做增量构建。`check` 全量门禁、`test:gates`、`test:slow`、`check:selfproof`、变异测试等专项质量检查不属于默认流程，仅当 spec 验收明确要求或改动直接影响其覆盖范围时才运行，并说明原因。

### implement-spec 工作流覆盖

`.pi/skills/implement-spec/SKILL.md` 保持原样；本节覆盖其中分支、提交、合并、清理四步。验证循环沿用上文 Subagents 的快反馈，本节不增加检查步骤。

**分支**

| 分支 | 切自 | 生命期 |
|---|---|---|
| `main` | — | 恒绿；只接 hotfix 与收尾提交 |
| `spec/<slug>` | `main` | 一个 spec 一条；可 push 作 draft PR 基点；合回即删 |
| `wt/<slug>-<NN>` | `spec/<slug>` 当前 HEAD | 一个 ticket 一条；只存在于本地；合回即删 |
| `exp/<slug>` | `main` | 长期对照实验（换规则版本、换运行时），不混进 `spec/` |

hotfix 落到 `main` 后，立刻把各活跃 `spec/` 分支 rebase 一遍。

**提交：格式**

首行 `type(scope): 中文描述`；`type` 取 `feat fix docs refactor test perf build ci chore`；`scope` 取包目录名（`engine`、`runner`、`gen`、`cli`、`schema`、`replay`、`tools`）或子系统名（`dag`、`season`、`budget`、`sandbox`、`rules`、`git`），跨包用逗号并列。首行与正文之间空一行，正文用自然段或 `- ` 分点；需要指针时用 `Refs:` footer，指向长期存在的 `docs/adr/` 与 `docs/*`。

**提交：正文**

正文要让人读完就知道这次做了什么、波及到哪里、为什么这么做；这些在 diff 里读不全，得由写的人补上。测试是验证的家，正文只放判断。

怎么组织自己定，不设固定栏目。

**提交：粒度**

粒度按概念计，不按 ticket 计：条数等于概念数，与票数无关。小 spec 且单一概念，留一个提交；同一机制被拆成两半的票，合成一个，避免「绿但半成品」的中间提交；机械改动（生成物重跑、格式化、批量改名）单独成提交，不混进逻辑改动。检验「一个概念」的办法是单独 revert 它：动作有意义，且 revert 后仍绿。想拆提交而拆不动，是 spec 混了多个概念——先拆 spec。

**合并与清理**

- 合回 `main` 用 rebase 或 `--no-ff`；GitHub 的 squash 按钮会绕开上面的 message 判据。
- merger 合入每个 ticket 后就跑该 ticket 范围的测试，随即删除其 worktree 与 `wt/` 分支，不等全部完成统一清理。
- 冲突超过三个文件或属非机械冲突，退回 implementer 重做；merger 只搬运，不改代码。
- `.scratch/` 的清理方式与文档策略另行决定，工作流不依赖它。

以上是提示词层约束，不配脚本、不加 gate：反馈循环的速度优先于机器强制。

### Triage labels

Five canonical triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` at the repo root and `docs/adr/` for ADRs. See `docs/agents/domain.md`.

## Design docs

阅读顺序：docs/fsr.md(why)→ docs/srs.md(what)→ docs/gdd.md（规则）→ docs/hld.md(how)。

每个事实只有一个家。写或改文档时，先看它归谁：

| 文档 | 唯一拥有 | 不写（留指针） |
|---|---|---|
| fsr | 定位、竞品、可行性结论、成本与时间估算、项目级风险 | 需求条目、规则机制与数值、工程方案 |
| srs | 范围与交付时点、FR/NFR 与验收条款、验收口径 | 规则机制与数值、工程方案、可行性论证 |
| gdd | 规则机制、设计约束、参数的含义与意图、规则侧开放项 | 参数取值、需求条目、工程实现、交付时点 |
| hld | 架构与包拓扑、进程模型、确定性手段、沙箱与预算机制、数据格式、CLI、CI、工程侧开放项 | 规则机制与取值、需求定义、可行性论证 |

- 参数取值真源是 `rulesets/*.json`;`docs/rules-vN` 与 hld 的生成物表由它生成，文档里不复制取值。
- 两份文档冲突时采信顺序：`hld > gdd > srs > fsr`。发现冲突就修矛盾的一方（删除或改指针）,不要两边各留一份。
- 变更历史由 git 承载，文档头部不写逐版本变更记录。

Issue/triage/domain 的权威定义见 docs/agents/(issue-tracker/triage-labels/domain.md),本文件只做索引，不复制。

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
