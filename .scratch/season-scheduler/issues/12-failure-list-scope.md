# 12: 校验失败名单口径——别把陈旧 `failed-*.json` 全盘端进赛季报告

**What to build:** 收窄 `report.md` / `report.json` 的「校验失败名单」口径。当前 `readFailureRecords`
(`packages/runner/src/reporter.ts:527`)扫 `archive/<slug>/failed-*.json` 的**全部**文件,报告据此把这些模型
标为「没有参赛资格」;真实赛季里因此把上一轮阻塞尝试遗留的 8 条 `transport` 失败记录端了出来,而同一批
模型在**本季主排名里 5 条全部参赛**——报告自相矛盾。

**Blocked by:** 无(I 的交付缺陷,票 09 的实现口径问题)

**Status:** ready-for-agent

## 证据(season 票 11)

- `.scratch/season-scheduler/e2e-readings.md` §5:本季冻结 **0 失败**,但 `report.json.validationFailures.length = 8`,
  全部是 `archive/<slug>/failed-2026-10-08T*.json`(slug ∈ 本季 5 条中的 4 条)。
- 同一份 `report.md` 的「排名」表里这 5 条都在,「校验失败名单」说它们「没有参赛资格」。
- 直达根因:`packages/runner/src/reporter.ts:522-542` 的注释自述「只按文件名前缀 `failed-` 与目录结构找记录,
  不猜 runId:赛季的 runId 与 gen 的 runId 不同源」——这是已知取舍,但在真跑里暴露为可读性 / 正确性缺陷。

## 方向(定夺后落地,别两处各留一份口径)

候选(择一并把理由写进代码注释与票的 Answer):

1. `season.yaml` 增加可选的 gen 批次引用(如 `genRunId` 或每条 participant 旁记 gen runId),报告只读本季相关的
   `failed-<genRunId>.json`。——最干净但动 `season.yaml` 契约(须同步 hld §9 / `season-config.ts` / 范例)。
2. 只列**不属于任何参赛 slug 的失败**,或只列「该 slug 在 `archive/` 下没有比失败记录更新的成功存档」的失败。
   ——不动契约,但语义要在报告里讲清。
3. 报告侧显式声明「名单为全仓历史失败记录,不限于本季」并**改名**(如「历史冻结合并失败记录」),
   与「参赛资格」解耦。——最小改动,但可能仍误导。

## 验收

- [ ] 真实赛季(或 fixture)里:报告不再把本季已参赛的模型列进「没有参赛资格」名单。
- [ ] 新的口径在 `reporter.ts` 注释与报告文案里各写一次、不互相复述;若动 `season.yaml`,同步 hld §9 与范例。
- [ ] `reporter.test.ts` 补齐:陈旧失败记录 + 本季成功存档并存时的断言。
- [ ] `pnpm run verify:fast` 全绿。

## Comments

发现于 season 票 11 的真实赛季收口(2026-10-09),读数见 `.scratch/season-scheduler/e2e-readings.md` §5 / §7。
本票不在票 11 内改:票 11 是收口验证票,口径变更须单独评审。
