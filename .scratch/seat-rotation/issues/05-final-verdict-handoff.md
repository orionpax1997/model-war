# 终verdict与handoff(grilling)

Type: grilling
Status: open
Blocked by: 03, 04

## Question

收口整图：偏置量级结论 + 是否需要规则侧动作（二选一：绿则「轮换摊平，无需动作」；红/灰补测后仍超线则只写触发条件交回 gdd，不动机制）；判据文本回流关闭 `hld §12 #3`；B 节点/frontier/波次在 DAG 关闭；`handoff` 交出去（含登记表活表 + readings 指针 + 触发条件行号）。

## Context

- 走 `grilling` + `domain-modeling`：最后一次术语与归属检查（判据文本的家是 hld §12 #3；gdd §3.3 旧注不顺手改，只在 handoff 指针过去）。
- 边界重申：B 只出决策；可执行门禁出本图；真模型观察不进判据（看了也只在 handoff 备注）。
- 收口动作：`pnpm run verify:fast` 全图一次 + `code-review` 双轴，然后按 DAG 把 B 标关闭（改 DAG 是本票执行的一部分，属收口不是扩散）。

## Done when

- [ ] verdict 二选一有结论，触发条件（如有）写清交回 gdd 的哪一行
- [ ] `hld §12 #3` 判据文本回流 + DAG 的 B 节点/frontier/波次关闭
- [ ] `handoff` 交出（含登记表 + readings 指针）
- [ ] `Status: resolved` + `## Answer` 回写，map 的 Decisions so far 补一行
