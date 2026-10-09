# 01: prefactor——`FailureRecord` 下沉 `packages/schema`

**What to build:** 把失败记录的形状搬进真源包,让 gen 与报告侧(runner)都从同一个家读到它:gen 反向依赖 `schema`,而不是自持一份类型。**行为零变化**——失败记录照旧精确写在 `archive/<模型slug>/failed-<runId>.json`,内容与键序逐字不变。这是后续「报告侧读失败名单」那一票的先决条件:没有这一步,runner 要么新增一条到 gen 的依赖边,要么按宽松 JSON 猜字段。

**Blocked by:** None(can start immediately)

**Status:** resolved

- [x] `FailureRecord` 与其文件前缀常量的类型真源落在 `@model-war/schema`;`gen` 从 schema 导入,不再自持第二份定义。
- [x] 磁盘路径、JSON 键序与字段内容与搬迁前逐字节一致——搬迁前写出的既有失败记录能被新代码原样读回。
- [x] `gen` 的全部既有测试仍绿,依赖方向为 `gen → schema`(depcruise 不新增越界边)。
- [x] 全仓不再有第二处 `FailureRecord` 定义;`CONTEXT.md`《校验失败记录》与 `docs/hld.md` §7.4 的措辞指针指向 schema 这个家。

## Answer

**Commit:** `14b8c27330aa228edf3d451116d8debdeffd8a85`(`refactor(schema): FailureRecord 形状下沉真源包`),branch `ticket/01-failure-record`。

**改了什么**

- 新增 `packages/schema/src/failure-record.ts`:真源 `FailureIdentity`(4 键,`FailureRecord` 的前缀)、`FailureClassification = "tsc" | "contract" | "transport"`、`FailureRecord = FailureIdentity & { ruleset … message }`(11 键,逐字保留原 JSDoc 与键序),以及 `export const FAILURE_RECORD_PREFIX = "failed-"`。头注按 `archive-meta.ts` 模板写,并**明写不带 JSON Schema 的理由**(失败记录不走 ajv 装载校验,不写半截 schema)。
- `packages/schema/src/index.ts`:在 `parse/map` 那组之后新增 `export * from "./failure-record.js";`(带注释),不塞进兜底块。
- `packages/gen/src/pipeline.ts`:`FailureClassification` 改为从 schema 导入并 `export type { FailureClassification };` 再导出(取值域的家在 schema,此处只是别名);`ModelFailure` 仍留 gen。
- `packages/gen/src/failure.ts`:删去本地的 `FAILURE_RECORD_PREFIX` / `FailureRecord` / `FailureIdentity` 三块定义,改为从 `@model-war/schema` 导入;**重写**了原「刻意不进 schema」的头注为「形状家归真源包,本文件只组装与落盘」。`buildFailureRecord` / `failureRecordPath` / `writeFailureRecord` 与写盘参数一字未动(`JSON.stringify(record, null, 2)}` + `\n` + `flag:"wx"`)。
- `packages/gen/src/index.ts`:对外 9 个名字一个不少——`FAILURE_RECORD_PREFIX` / `type FailureIdentity` / `type FailureRecord` 改从 `@model-war/schema` 再导出,其余 6 个仍从 `./failure.js`。
- `packages/gen/src/failure.test.ts`:新增机器防线(此前无):`Object.keys(record)` 等于固定 11 键数组(锁「键序即书写序」),并断言原文 `=== JSON.stringify(record, null, 2) + "\n"`(锁 2 空格缩进 + 末尾换行)。
- 文档指针:`CONTEXT.md`《校验失败记录》补「形状真源:`packages/schema/src/failure-record.ts`」;`docs/hld.md` §7.4 末句补「形状家归真源包(§2.2.5),`packages/schema/src/failure-record.ts`」;`docs/hld.md` §2.2.5 首行「五类数据形状」→「六类(… / 失败记录)」,并注明失败记录只交 TS 类型、不配 schema(§150 的「读入端强制校验六类」是另一份清单,不动)。

**验证命令与结果**

| 命令 | 结果 |
|---|---|
| `pnpm run check:quick` | 通过(fmt / lint / coupling / no-float / budget 全绿) |
| `pnpm vitest run --project unit packages/gen packages/schema` | 通过:137 tests,137 passed,0 failed |
| `pnpm run typecheck`(`tsc -b`) | 通过(EXIT=0) |
| `pnpm run check:deps`(depcruise) | 通过:`no dependency violations found (167 modules, 452 dependencies)`——`gen → schema` 是既有边,未新增任何越界边 |

行为零变化:磁盘路径、JSON 键序与字段内容未改;`failed-*.json` 的字节序列仍由 `writeFailureRecord` 唯一决定(2 空格 + 末尾换行 + `wx`),新增用例把它钉住。
