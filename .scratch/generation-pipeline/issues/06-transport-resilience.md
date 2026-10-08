# 06: 传输韧性——指数退避与截断重试,不消耗协议轮数

**What to build:** 网络抖动与模型输出截断由退避重试兜住,而「上限 N 轮」始终只指校验驱动的迭代,跨模型可比。

**Blocked by:** 04(协议回喂环)

**Status:** resolved

- [x] 429 / 5xx / 超时走**指数退避重试同一轮**,`protocolRounds` 不涨;退避参数(初始间隔 / 倍数 / 上限 / 最大重试)是 gen 内部常量,**不进 `rulesets/*.json`**。
- [x] `finishReason = length`(截断)同样重试同一轮,**不把半截代码当产物回喂**。
- [x] 重试耗尽 → 记为 `transport` 失败,交给 05 的记录形状。
- [x] 测试:桩按脚本抛 429 / 5xx / 超时 / 返回截断 → 断言轮数不变、重试次数符合退避、最终分类为 `transport`。

## Answer

已实现并合并(合并提交 `48d3424`)。

- `retry.ts`:`retryable` 的 `TransportError`(429 / 5xx / 网络失败 / 超时)与 `finishReason === "length"`(截断)走指数退避重发**同一轮**(同一份 messages),`protocolRounds` 不涨、不写生成日志、不把半截代码当产物回喂;不可重试错误(400 / 缺凭证)立即收口。
- 退避参数(初始间隔 / 倍数 / 上限 / 最大重试)是 gen 内部常量(`retryDelayMs = initial × multiplier^(retry-1)` 封顶),不进 `rulesets/*.json`;重试耗尽记为 `transport` 失败,交给 05 的记录形状。
- 测试:`retry.test.ts` + `pipeline.test.ts` 按脚本抛 429 / 5xx / 超时 / 返回截断 → 断言轮数不变、退避序列符合公式(注入只记录不真等的 sleep)、最终分类为 `transport`。
