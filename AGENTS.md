# Agent Skills

This repository uses Matt Pocock's engineering skills (installed under `.pi/skills/`).

## Agent skills

### Issue tracker

Local markdown: issues live as `.scratch/<feature>/spec.md` and `.scratch/<feature>/issues/<NN>-<slug>.md`. See `docs/agents/issue-tracker.md`.

### Subagents

- code-review skill:Standards 与 Spec 两个子代理都用 `review`(`.pi/agents/review.md`)派发。
- research 任务:调研与探索派给 `explore` 子代理,主线程只聚合结论。

### Triage labels

Five canonical triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` at the repo root and `docs/adr/` for ADRs. See `docs/agents/domain.md`.

## Design docs

阅读顺序:docs/fsr.md(why)→ docs/srs.md(what)→ docs/gdd.md(规则)→ docs/hld.md(how)。

每个事实只有一个家。写或改文档时,先看它归谁:

| 文档 | 唯一拥有 | 不写(留指针) |
|---|---|---|
| fsr | 定位、竞品、可行性结论、成本与时间估算、项目级风险 | 需求条目、规则机制与数值、工程方案 |
| srs | 范围与交付时点、FR/NFR 与验收条款、验收口径 | 规则机制与数值、工程方案、可行性论证 |
| gdd | 规则机制、设计约束、参数的含义与意图、规则侧开放项 | 参数取值、需求条目、工程实现、交付时点 |
| hld | 架构与包拓扑、进程模型、确定性手段、沙箱与预算机制、数据格式、CLI、CI、工程侧开放项 | 规则机制与取值、需求定义、可行性论证 |

- 参数取值真源是 `rulesets/*.json`;`docs/rules-vN` 与 hld 的生成物表由它生成,文档里不复制取值。
- 两份文档冲突时采信顺序:`hld > gdd > srs > fsr`。发现冲突就修矛盾的一方(删除或改指针),不要两边各留一份。
- 变更历史由 git 承载,文档头部不写逐版本变更记录。

Issue/triage/domain 的权威定义见 docs/agents/(issue-tracker/triage-labels/domain.md),本文件只做索引,不复制。