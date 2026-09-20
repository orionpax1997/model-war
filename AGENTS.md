# Agent Skills

This repository uses Matt Pocock's engineering skills (installed under `.pi/skills/`).

## Agent skills

### Issue tracker

Local markdown: issues live as `.scratch/<feature>/spec.md` and `.scratch/<feature>/issues/<NN>-<slug>.md`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` at the repo root and `docs/adr/` for ADRs. See `docs/agents/domain.md`.

## Design docs

阅读顺序:docs/fsr.md(why)→ docs/srs.md(what)→ docs/gdd.md(规则)→ docs/hld.md(how)。
Issue/triage/domain 的权威定义见 docs/agents/(issue-tracker/triage-labels/domain.md),本文件只做索引,不复制。