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

## Answer

**选定候选:2 的变体 1**——名单只收录 `record.model`(slug)**不属于本季任何 participants slug** 的 `FailureRecord`。

**理由:**
- 候选 1(在 `season.yaml` 记 gen runId)最干净,但要改 `season.yaml` 契约,须同步 hld §9 / `season-config.ts` / 范例,面更大,与本票「不动契约收窄口径」的意图不符。
- 候选 2 变体 2(看该 slug 是否有更新的成功存档)要逐 slug 比较时间戳,语义更绕,且「更新」的比较基准(文件 mtime?目录名 runId?)不稳。
- 变体 1 直击报告自相矛盾的根因:一个 slug 只要**本季参赛**(出现在 `season.yaml` participants),它遗留的历史 `failed-*.json` 就不再进「没有参赛资格」名单;只有本季完全未参赛 slug 的失败记录才收录。判据单一只看 participants,天然消除「名单说没资格、排名里却参赛」。
- 候选 3(改名 + 声明全仓历史)仍可能误导,不采纳。

**根因:** `readFailureRecords` 原先扫 `archive/<slug>/failed-*.json` 的**全部**文件并按原样当作「没拿到参赛资格」。赛季 runId 与 gen runId 不同源,函数无法凭 runId 关联本季,于是把上一轮阻塞尝试遗留的陈旧 `transport` 失败记录一并端进报告,与同一批模型在本季主排名里参赛冲突。

**改动文件:行号**
- `packages/runner/src/reporter.ts:524-559`:`readFailureRecords(root, participatingSlugs: ReadonlySet<string>)` 增第二参数,函数内 `participatingSlugs.has(slug)` 为真则跳过该 slug 目录(在解析 JSON 之前)。口径说明(为何按参赛 slug 收窄、为何不猜 runId)只写在该函数 JSDoc 各一次。
- `packages/runner/src/reporter.ts:471-476`:报告 `> 来源:...` 引用块改为声明「**只列本季未参赛的模型**」,与 JSDoc 不互相复述(文案只说范围,注释只说理由)。
- `packages/runner/src/enumerate.ts:117`:把内部 `slugOf` 导出(`archive/<slug>/<runId>` → `<slug>` 的唯一规则家),供 scheduler 复用,避免第二份实现。
- `packages/runner/src/scheduler.ts:76`:import 增加 `slugOf`。
- `packages/runner/src/scheduler.ts:589-593`:调用点改为 `readFailureRecords(root, new Set(season.participants.map((archiveRef) => slugOf(archiveRef))))`,集合取自已装载的 `season.participants`。
- `packages/runner/src/reporter.test.ts`:端到端落盘用例(约 412-451)改为 fixture 里 `archive/alpha/failed-gen-run-1.json`(alpha 是 participant)断言被**排除**(`validationFailures` 为空、report.md 不含该指针),并新增 `archive/epsilon/failed-gen-run-2.json`(非参赛 slug)断言被**收录**、report.md 含其指针;新增 `readFailureRecords` 直测(457-476);`failureRecordFixture` 参数化为可覆写 `model`/`runId`(不影响 368 行纯函数用例语义,该用例直接传对象)。

**测试证据:**
- `pnpm exec vitest run --project unit packages/runner/src/reporter.test.ts` → 15/15 通过(改前该文件因 `readFailureRecords` 少参编译失败,为红)。
- `pnpm exec vitest run --project unit packages/runner` → 6 suites / 81 tests 全绿。
- `pnpm run check:quick` → 格式、lint、toolchain/quickjs 耦合、禁浮点、预算门禁全绿。
