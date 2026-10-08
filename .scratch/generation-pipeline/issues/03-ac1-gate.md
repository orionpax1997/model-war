# 03: AC1 门禁——「无对局反馈路径」变成可执行断言

**What to build:** 把「生成管线全程只回喂静态校验错误、不存在把对局结果传回生成环节的路径」从散文条款固化成会红的门禁。

**Blocked by:** None(可立即开始)

**Status:** ready-for-agent

- [ ] 依赖方向门禁:`gen` 不得依赖 `engine` / `runner` / `replay`(`engine` 一条已有,补另两条);带防假绿的模块数交叉核验。
- [ ] gen 包内源码级测试:gen 运行时代码不得出现 `runs/`、`.result.json`、`MatchResult` 等对局结果符号;违规即红。
- [ ] 门禁挂在既定的质量链上,与既有依赖方向断言同处,`check:quick` 或 `check` 里可见。
