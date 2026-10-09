# 09: 报告与叙事——`report.md` + `narrative/`

**What to build:** 给人读的那一半产物。Markdown 报告含排名、对局均分、代表性对局叙事、规则版本标注,可直接用作自媒体素材;每局再生成一份 `narrative/<对局>.md`,从回放的 `events` 流(首触 / 易手 / 淘汰 / 经济死亡 / 终局)生成时间线,**只消费 events、不重新解析状态**。报告里两类「失败」**分节、不合并**:「校验失败名单」(gen 侧写下的失败记录——模型根本没通过校验、没参赛资格)与「对局问题清单」(崩溃 / 超时 / 内存判负等执行期披露——参赛了但被剔除或需披露)。各节都能回溯到其来源记录。

**Blocked by:** 01(失败记录形状落到真源包)、02(回放读入端)、08(排名数据)

**Status:** resolved

- [x] `report.md` 含排名、对局均分、代表性对局叙事、规则版本标注,可直接当素材读。
- [x] **每局**都生成 `narrative/<对局>.md`;时间线来自 events 的七种事件;叙事是 events 的纯函数(同回放同叙事),不重新解析状态。
- [x] 「校验失败名单」读 gen 侧失败记录文件并回溯到逐轮 prompt 链 / 诊断;「对局问题清单」来自异常处置。
- [x] 两节**分开**呈现,不合并成一个「失败」列表。
- [x] 报告不含任何「名次可信 / 统计显著」的宣称(v0 口径:名次仅供展示)。

## Answer

**交付**:人类面两半产物落地在 `packages/runner/src/reporter.ts`(纯函数 + 薄壳),`scheduleSeason` 在写完 `report.json` 后一并产出。

### 落点

- `reporter.ts` 新增纯函数:`renderNarrative` / `summarizeNarrative` / `selectRepresentativeMatches` / `renderReportMarkdown`。
- 新增薄壳:`writeNarrative` / `writeReportMarkdown` / `readFailureRecords` / `writeReportArtifacts`。
- `scheduler.ts`:`validationFailures` 由 `readFailureRecords(root)` 填充(此前恒 `[]`);`writeReportArtifacts(outputDir, report)` 在 `report.json` 之后落盘。
- `index.ts`:reporter 段头注补上 `report.md` / `narrative/`。
- 未改 `docs/*`;未新增包依赖(runner 仍只声明 `@model-war/schema`)。

### 叙事的信息上限(§4.4 裁决)

`ReplayEvent` 只有 `{kind, subjectId}`,且 tick 行携带的是**结算后状态**——不回溯状态就补不出「单位属于哪个模型 / 什么兵种」。故:

- 座位级事件(`exception` / `economy-dead` / `player-eliminated` / `victory`)用 meta 行 `players[seat]` 映到模型名;
- 单位级 / 点位级事件(`first-contact` / `unit-destroyed` / `site-captured`)只写数值 id;
- **每篇 `narrative/<对局>.md` 开头明说**「只读 `events` 流、不重解析 `units` / `sites`」这一信息上限。

`renderNarrative` 按 `(tick, STEP_OF(kind), subjectId, kind, 下标)` 重排事件,于是输出只由事件**集合**决定——反转 `events` 或打乱行序都得到同一篇叙事(「叙事是 events 的纯函数」的机器形态)。读回放**就地**用 `readFileSync + split + JSON.parse + 按 type 分派`,不引 `@model-war/replay`。

### 两份失败分两节

- 「校验失败名单」扫 `archive/<slug>/failed-*.json`(前缀常量从 `@model-war/schema` 取),逐条给 model / modelVersion / classification / protocolRounds / message + 指向 `archive/<slug>/failed-<runId>.json` 的指针。
- 「对局问题清单」来自 `report.matchIssues`(§8.4),逐条给对局 / 原因 / 退出码 / 重跑次数 / 是否排除出排名 + 指向 `input.json` 的指针。
- 两节各自成节,测试用「失败记录指针落在校验失败节内、且在对局问题节之前」钉住不合并。

### 验证

- `pnpm run check:quick` 通过(fmt / lint / coupling / no-float / budget)。
- `pnpm vitest run --project unit packages/runner apps/cli` 通过(14 文件 237 例)。
- `reporter.test.ts` 新增 6 例:叙事纯函数性(同集合同文本 / 反转不变)、七种事件与座位→模型映射、无 events / 无名册 meta 不崩、摘要、代表选择确定、`report.md` 反例清单(「统计显著 / 显著 / 置信区间 / 可信 / p 值 / Elo」一个都不出现)+ 两份失败分两节、落盘端到端(每局都有叙事 + `report.md` 引用 + 读失败记录)。

## Review fixes

**提交:`0795834f0a303eb601ed5e2b74ed42c9addbe32a`(fix(runner): 评审修复——内存披露/每局叙事/parseReplay/zod 与 hld 对齐)**

- **S2(每局都有叙事)**:`writeReportArtifacts` 不再只对 `report.matches` 生成叙事。**成功局**照旧经
  `parseReplay` 读回放渲染;**被剔除出排名的失败局也每局写一篇** `narrative/<对局>.md`
  (`renderExcludedNarrative`:说明被排除的原因与退出码,有部分回放则附时间线,没有则明说无回放)。
  测试新增一例:退 2 两次的剔除局也有 narrative 且含「已排除出排名 / 引擎崩溃」。
- **S3(读回放走 parseReplay)**:删掉 `reporter.ts` 里就地的 `readReplayLines`,统一走
  `@model-war/replay` 的 `parseReplay`;新增一例断言坏回放抛 `ReplayReadError`。
