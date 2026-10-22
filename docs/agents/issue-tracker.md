# Issue tracker: 本仓库的记录位置

本仓库**不设本地 Markdown issue 追踪器**。需求、决策与进度不再由临时任务记录承担。

| 一类东西 | 落在哪 |
|---|---|
| 长期事实(约束、口径、裁决) | 代码、配置、[docs/adr/](../adr/)、[docs/gdd.md](../gdd.md)、[docs/hld.md](../hld.md) |
| 参数取值 | [`rulesets/*.json`](../../rulesets/) |
| 面向模型的契约 | [docs/rules-v2/](../rules-v2/) |
| 过程与临时任务 | git 分支与提交;不落库 |

## 约定

- 一次变更流一个分支:`feature/<slug>`(从 `main` 切),合回即删;长期对照实验走 `exp/<slug>`。
- 过程记录不写成文件:需要留下依据时,写进对应事实的家(代码注释、ADR、设计文档)。
- 标签词汇见 [triage-labels.md](./triage-labels.md);外部 PR 是否进入 triage 由维护者定。

## 与 skill 的对接

- 技能提到「发布到 issue tracker」时:若本仓库没有对应追踪器,不要凭空造一个 `.scratch/` 目录——把结论写进该事实的家。
- 技能提到「取回某个 ticket」时:本仓库的 ticket 已不再以文件形式存在,按 git 历史(`git log --grep`)找。
