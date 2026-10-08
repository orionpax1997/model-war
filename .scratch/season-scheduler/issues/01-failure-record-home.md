# 01: prefactor——`FailureRecord` 下沉 `packages/schema`

**What to build:** 把失败记录的形状搬进真源包,让 gen 与报告侧(runner)都从同一个家读到它:gen 反向依赖 `schema`,而不是自持一份类型。**行为零变化**——失败记录照旧精确写在 `archive/<模型slug>/failed-<runId>.json`,内容与键序逐字不变。这是后续「报告侧读失败名单」那一票的先决条件:没有这一步,runner 要么新增一条到 gen 的依赖边,要么按宽松 JSON 猜字段。

**Blocked by:** None(can start immediately)

**Status:** ready-for-agent

- [ ] `FailureRecord` 与其文件前缀常量的类型真源落在 `@model-war/schema`;`gen` 从 schema 导入,不再自持第二份定义。
- [ ] 磁盘路径、JSON 键序与字段内容与搬迁前逐字节一致——搬迁前写出的既有失败记录能被新代码原样读回。
- [ ] `gen` 的全部既有测试仍绿,依赖方向为 `gen → schema`(depcruise 不新增越界边)。
- [ ] 全仓不再有第二处 `FailureRecord` 定义;`CONTEXT.md`《校验失败记录》与 `docs/hld.md` §7.4 的措辞指针指向 schema 这个家。

