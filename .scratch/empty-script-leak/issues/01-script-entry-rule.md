# 01:静态校验器新增「脚本入口」规则,拦住无口的空产物

Type: task
Status: resolved
Blocked by:

**What to build:** 在静态校验器的判定链里补一级 `script-entry`:编译产物顶层必须有一个引擎取得到的
`loop` 函数,否则 blocking 违规、走既有 contract 失败 + 回喂。它封的是「空代码围栏 → 空串 →
`"use strict";` → 四级静态检查全过 → 冻结入库」这条漏检。

**Why this seam:** 见 `spec.md` 与 [`docs/adr/0014`](../../docs/adr/0014-script-entry-checked-by-validator.md)。
一句话:判据是产物上的一条静态性质,而校验器是全仓唯一在产物上跑的解析器、也是回喂通道的第一来源;
gen 只依赖真源包、且不能在进程里执行模型产物。

## 验收

- [x] 新规则 `packages/tools/src/rules/script-entry.ts`:`function loop` / `var loop = 函数值` 放行,
      无 `loop` / `let`·`const loop` / `var loop = 非函数` / 块内 `function loop` 违规,一律 blocking、无位置。
      (判据对齐引擎的 `vm.global.getProp("loop")`,实测 `quickjs-wasi` 3.6.2 / 2026-10-11。)
- [x] 判定链扩到六级(脚本入口排在模块系统之后、体积之前)、`ScriptLintRule` 与 `RULE_LABELS` 同步、
      `index.ts` 导出面同步。
- [x] 规则用例 `script-entry.test.ts` + 判定链槽位白盒断言 + 入口(退出码 + stdout)用例。
- [x] gen 回归:`packages/gen/src/pipeline.test.ts` 空围栏 → `contract` 失败、不建存档;
      回喂后第 2 轮补上入口 → 冻结、轮数 = 2。
- [x] 既有各规则/判定链/入口用例的样本补上顶层入口(它们原本是片段,不是合法产物)。
- [x] 文档: `docs/hld.md` §6.2 新增「脚本入口」一行并改计数、`tsconfig.scripts.json` 把指针指到新规则、
      新增 ADR-0014。

## Answer

- 规则:`packages/tools/src/rules/script-entry.ts`(`scriptEntryStage` / `scriptEntryViolations`,
  共用一份 `scanParsed`)。判据是顶层 `FunctionDeclaration`(`id.name === "loop"`)或顶层
  `var` 绑定 `loop` 且初值是 `FunctionExpression` / `ArrowFunctionExpression`。
- 接链:`validate/pipeline.ts` 的 `SCRIPT_LINT_STAGES` 插入第四格;`rules/script-lint.ts` 加
  `"script-entry"` 类别;`validate/render-violations.ts` 的 `RULE_LABELS` 加「脚本入口」。
- 回归证据见上,全部 `unit` 绿。
