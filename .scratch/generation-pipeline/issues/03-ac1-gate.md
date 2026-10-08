# 03: AC1 门禁——「无对局反馈路径」变成可执行断言

**What to build:** 把「生成管线全程只回喂静态校验错误、不存在把对局结果传回生成环节的路径」从散文条款固化成会红的门禁。

**Blocked by:** None(可立即开始)

**Status:** resolved

- [x] 依赖方向门禁:`gen` 不得依赖 `engine` / `runner` / `replay`(`engine` 一条已有,补另两条);带防假绿的模块数交叉核验。
- [x] gen 包内源码级测试:gen 运行时代码不得出现 `runs/`、`.result.json`、`MatchResult` 等对局结果符号;违规即红。
- [x] 门禁挂在既定的质量链上,与既有依赖方向断言同处,`check:quick` 或 `check` 里可见。

## Answer

已实现并合并(合并提交 `db53dd1`)。

- depcruise 规则 `gen-must-not-depend-on-engine-runner-replay`(`.dependency-cruiser.js`)补齐 `engine` / `runner` / `replay` 三条禁边;它随全量 `check` 的 `check:deps` 跑,并被 `packages/gen/src/dependency-boundary.test.ts`(unit project)直接 spawn 复核,故默认 `verify:fast` 覆盖内也会红。
- gen 源码级测试 `no-match-result-symbols.test.ts`:运行时代码不得出现 `runs/`、`.result.json`、`MatchResult` 等对局结果符号(补 depcruise 看不见的字符串字面量)。
- 防假绿:巡航入口必须含 `packages/gen/dist`、巡航模块数不为零;「规则真能红」的真注入反例在 `packages/tools/src/gates.test.ts`(`pnpm run test:gates`,非默认链)。
