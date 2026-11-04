# Issue tracker: 本仓库的记录位置

追踪器是仓库根的 **`.scratch/`**：spec 与 ticket 写在这里，实现完成后随 `.scratch/` 定期清理。它是任务过程产物的落脚点，不承担长期文档职责——长期事实仍然落进下面那张表里。

| 一类东西 | 落在哪 |
|---|---|
| 长期事实(约束、口径、裁决) | 代码、配置、[docs/adr/](../adr/)、[docs/gdd.md](../gdd.md)、[docs/hld.md](../hld.md) |
| 参数取值 | [`rulesets/*.json`](../../rulesets/) |
| 面向模型的契约 | [docs/rules-v2/](../rules-v2/) |
| 任务过程: spec、ticket、待办 | `.scratch/`(不被 git 跟踪,实现后清理) |
| 变更过程本身 | git 分支与提交 |

## 约定

- 一次变更流一个分支:`feature/<slug>`(从 `main` 切),合回即删;长期对照实验走 `exp/<slug>`。
- `.scratch/` 里的东西不是事实的家:实现完成时把结论迁进 ADR / 设计文档 / 代码注释,然后随目录一起清掉。
- 标签词汇见 [triage-labels.md](./triage-labels.md);外部 PR 是否进入 triage 由维护者定。

## 与 skill 的对接

- 技能提到「发布到 issue tracker」时:把 spec / ticket 写成 `.scratch/<日期>-<slug>.md`;需要「打 `ready-for-agent` 标签」时,在文件头部写 `状态: ready-for-agent`,不调用外部系统。
- 技能提到「取回某个 ticket」时:在 `.scratch/` 下按 slug 找;已被清理的,按其迁入的 ADR / 设计文档找,或按 git 历史(`git log --grep`)找。
