# 05: 失败路径——校验失败记录、分类、退出码与多模型串行隔离

**What to build:** 一个模型跑不满协议时,产出可被报告侧读成失败名单的**校验失败记录**,且不污染 `archive/`;多个模型串行生成时,单模型失败不拖垮整批。

**Blocked by:** 04(协议回喂环)

**Status:** resolved

- [x] 跑满轮数仍不过 → 写 `archive/<modelSlug>/failed-<runId>.json`(逐轮 prompt 链 + 生成日志 + 最终诊断 + 失败分类),**不建** `<runId>/` 存档目录。
- [x] 失败分类至少覆盖 `tsc` / `contract` / `transport`。
- [x] 多模型**串行**(模型内并发固定 1);单模型失败不中断整批,成功者照常冻结。
- [x] `--model <slug>` 可只跑一个模型。
- [x] 退出码:全部成功 0,任一模型失败非零;成功存档与失败记录都照写。
- [x] 测试:桩每轮都回违规脚本 → 断言失败记录内容、无存档目录、退出码非零;一批中一败一成 → 断言两者产物并存。

## Answer

已实现并合并(合并提交 `8d51022`)。

- `failure.ts` 落地失败记录:跑满轮数仍不过 → 写 `archive/<modelSlug>/failed-<runId>.json`(逐轮 prompt 链 + generationLog + 最终诊断 + 失败分类),不建 `<runId>/` 存档目录(`archive/` 只收通过校验的)。
- 失败分类覆盖 `tsc` / `contract` / `transport`(`FAILURE_RECORD_PREFIX` / `buildFailureRecord`)。
- `run.ts` 多模型串行(模型内并发固定 1):单模型失败不中断整批、成功者照常冻结;`--model <slug>` 只跑一个(未登记的 slug 报错);退出码「全部成功 0,任一失败非零」,成功存档与失败记录都照写。
