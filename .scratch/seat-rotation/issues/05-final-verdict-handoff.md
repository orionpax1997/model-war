# 终verdict与handoff(grilling)

Type: grilling
Status: resolved
Blocked by: ~~03, 04~~（已解除，两票均 resolved）

## Question

收口整图：偏置量级结论 + 是否需要规则侧动作（二选一：绿则「轮换摊平，无需动作」；红/灰补测后仍超线则只写触发条件交回 gdd，不动机制）；判据文本回流关闭 `hld §12 #3`；B 节点/frontier/波次在 DAG 关闭；`handoff` 交出去（含登记表活表 + readings 指针 + 触发条件行号）。

## Context

- 走 `grilling` + `domain-modeling`：最后一次术语与归属检查（判据文本的家是 hld §12 #3；gdd §3.3 旧注不顺手改，只在 handoff 指针过去）。
- 边界重申：B 只出决策；可执行门禁出本图；真模型观察不进判据（看了也只在 handoff 备注）。
- 收口动作：`pnpm run verify:fast` 全图一次 + `code-review` 双轴，然后按 DAG 把 B 标关闭（改 DAG 是本票执行的一部分，属收口不是扩散）。

## Done when

- [x] verdict 二选一有结论，触发条件（如有）写清交回 gdd 的哪一行
- [x] `hld §12 #3` 判据文本回流 + DAG 的 B 节点/frontier/波次关闭
- [x] `handoff` 交出（含登记表 + readings 指针）
- [x] `Status: resolved` + `## Answer` 回写，map 的 Decisions so far 补一行

## Answer

### verdict（二选一）：红档触发交回，不动机制

绿（轮换摊平、无需动作）无路径：基准 H 异质 12 局最大落差 **58.3%**（75.0%−16.7%）>15% 判红，票 03 的两条补测触发线**全部命中**——①落差落红区（>15%，灰区更早已超）；②任一座位 Wilson 下限 <20%：seat1 13.8%、seat2 8.9%、seat3 4.7% 三席命中。S 对称校准 4 局胜席分散（1/2/3）但半宽 ±30pp 量级**判不动**，前置闸既未被硬证据触发、也未被证拉平。真模型 60 局落差 51.7% 只作补充观察，**不进判据**。

### 触发条件（交回 gdd，不动机制）

1. 基准 H 异质矩阵最大 seat 胜率落差 >15%（本次 58.3%，红）。
2. 任一座位 Wilson 95% 下限 <20%（本次 seat1/2/3：13.8%/8.9%/4.7%，三席命中）。
3. 前置闸：同脚本对称校准须先拉平再定档；本次 n=4 判不动，闸既未触发也未证拉平，如实记。
4. 真模型读数（本次 51.7%）永不进判据，只作触发补测的理由。
指针：**`docs/gdd.md:93` 该行**（§3.3 旧注末句，「低下标在 (4-d)/4」方向未定遗留措辞，定死「值大者胜」后即失效那一行），不是节头。gdd 旧注本身不顺手改，归规则侧。

### hld §12 #3 回流

票 03 判据草案**原样**贴进 `docs/hld.md` §12 #3（表格换行压单行，文字未动）+ 另起一段本次 verdict 落点 + 本项关闭。review 发现的措辞瑕疵（草案「每局恰产出一个获胜座位」与并列 1 计胜事实冲突，judge log 第 8/12 行四方并列 1）**本次不改**（守 03 共识），记此处交规则侧后续顺手修。

### DAG 关闭

`docs/diagrams/v0-milestone-dag.md`：mermaid B 翻 ✅、§4 B 行改已收口、frontier B 行改已收口、波次 7 B 改 ✅、波次 9 改门槛齐备；附带修 §5 :209 内部 drift（原称剩 B、L 两项，L 已收口）与结论 4（V0 门槛齐备，V0 收口由外层做）。改 DAG 属本票收口的一部分，不是扩散。

### handoff 包

- 登记表活表：`readings.md` §2（真模型 4 行，补充观察）+ §5.4（基准 8 行，可进判据）；两表估量不同、**不可相加**（`:149` 声明）。`map.md` Destination「空表」措辞已改「活表」。
- readings 指针：抬头 `:3-4`（决策只写进各票 `## Answer`，本文件不下 verdict）。
- 触发条件行号：见上（`docs/gdd.md:93`）。
- 真模型备注：60 局 51.7% 红只作补充观察（`readings.md` §1–§3），轮换均衡已验证（每座位×模型恰 12 局）。

### 验证与 review

- `pnpm run verify:fast` 全图一次：**全绿**（94 文件 / 1003 通过 / 3 跳过）。票 04 自称的绿（无 log 佐证）已被本次覆盖作废。
- `code-review` 双轴（diff `d881bac...HEAD`，17 文件 +990）：Standards 2 硬违规（map 补行——本次已修；票 01 log 名实不符——见下，不改 01 票本身）+ 6 judgement（Wilson 两份、MAPS 手写无断言、硬编码 n、`generatedAt` 溯源值——仅影响将来若进 `packages/tools` 的可移植形态）；Spec 2 缺失（补行、重跑占预算留痕——本次已在 map 留痕）+ 4 creep + 5 疑错。
- review 异议处置（**已决不重开**）：n=60 混合口径、前置闸无量纲、红档亦触发补矩阵三条均为 02/03 grilling 已裁决事项，05 维持原决定；<20% 线与②是 01/03 的裁决演进，非 creep 回滚；02 主线程直做、04 提前跑 verify 两条记为程序瑕疵，不追溯重做。
- 证据瑕疵如实记：`run-20261009T204011.log` 实际只保留 `WALL 79.24 s` 一行，完整 stdout 未落盘；不推翻读数（reduce log 完整 + 第二独立路径 4/4 通过）。
- 本图无 `spec.md` 定为**有意**（wayfinder 以 map 为图），堵后人误判漏件。

### grilling 记录

两轮 frontier 整轮问答：Round 1（Q1 verdict 取向 / Q2 handoff 边界 / Q3 票面与 map/DAG 债务打包 / Q4 落盘先于验证 / Q5 spec 缺失定性）与 Round 2（Q6 hld 回流文本 / Q7 触发条件措辞与行号 / Q8 handoff 包与 map 补行 / Q9 执行顺序）全部按推荐拍板，用户已确认共识。
