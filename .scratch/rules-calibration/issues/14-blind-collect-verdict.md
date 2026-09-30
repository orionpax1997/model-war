# 盲写汇总 + wording-risks 盲写卡点节更新（FR-10 AC1 证据）(task)

Type: task
Status: resolved
Blocked by: 10, 11, 12, 13

## 前置依赖

票 10/11/12/13 全部 resolved 后方可执行。

## 任务

### 1. 模型可用性记录

对 cell-a / cell-b / cell-c / cell-d 各舱汇总：

对每个舱，读取 `blind/<cell>/*` 的三件套，填入下表：

| 舱 | 模型 | 策略 | 自认候选(A/B?) | 轮转方向假设 | 回喂轮次 | 通过? | API 误用清单 | 快照误用清单 | 越界/参数错误 |
|---|---|---|---|---|---|---|---|---|---|
| a | deepseek-v4.1-flash | A 爆兵 | | | | | | | |
| b | MiniMax-M3 | B 扩张 | | | | | | | |
| c | deepseek-v4.1-flash（首轮 mimo-v2.6-pro 失败；重试 thinking=low） | C 农民海 | | | | | | | |
| d | space-bunny-alpha | A 爆兵 | | | | | | | |

### 2. 追加进 wording-risks.md 盲写卡点节

将上表作为新节追加进 `.scratch/rules-calibration/draft/wording-risks.md` 的"盲写卡点"节。

每条 P0 待裁项（index 自认、轮转方向）注明"多模型是否分裂"：

- 候选 A/B 各有多少模型选；
- 轮转方向假设是否被模型提出质疑；
- 写入"措辞待裁清单"的实证结论。

### 3. 策略稳定性分析

cell-a vs cell-d（同策略 A，不同模型）：

- 脚本结构是否相似（策略稳定）？
- 校验错误类型是否不同（文档可读性差异）？

cell-a vs cell-b（不同策略，同档位模型）：

- 脚本是否体现预期策略差异？
- 校验错误是否有共同盲点（指向同一措辞问题）？

### 4. 产出

- 更新后的 `draft/wording-risks.md`（含盲写卡点节）
- 更新后的 `issues/07-baseline-strategy-scripts.md` Answer 节（含脚本引用 + 模型可用性记录 + 策略稳定性结论）
- 确认 ≥2 个脚本通过校验，策略不同（srs §4 第 2 条 + fsr R2 验收证据）

## Answer

14 收口完成：4 舱汇总 + `wording-risks.md` 盲写卡点节更新 + 策略稳定性裁决均已落盘；07 票 Answer 已写入并 resolve（收口规则：14 resolved ⇒ 07 resolved）。

### 产出

1. **`draft/wording-risks.md`「盲写卡点」节（新）**——含模型可用性记录表、P0 待裁项分歧结论、其余 P0 逐条实测、新增 P0（P0-N1..N4）、管线/环境侧卡点、对 07/09 的交付口径。P0 条目 1/2 已就地标注实测结论指针。
2. **`issues/07-baseline-strategy-scripts.md` Answer（新）**——脚本引用（含 SHA256）+ 模型可用性记录 + 策略稳定性结论 + FR-10 AC1 / srs §4 第 2 条验收对照。`Status: in-progress → resolved`。
3. 本票 Answer（本节）。

### 模型可用性记录（速览）

| 舱 | 模型 | 策略 | 自认候选 | 轮转方向假设 | 回喂轮次 | 通过? | API 误用 | 快照误用 | 越界/参数错误 |
|---|---|---|---|---|---|---|---|---|---|
| a | deepseek-v4.1-flash | A 爆兵 | **A** | 值大者胜 | 0/5 | ✅ | 0 | 0 | 0 |
| b | MiniMax-M3 | B 扩张 | **A** | 值大者胜 | 0/5 | ✅ | 0 | 0 | 0 |
| c | deepseek-v4.1-flash（首轮 mimo-v2.6-pro 失败；重试 thinking=low） | C 农民海 | **B** | 值大者胜 | 0/5 | ✅ | 0 | 0 | 0 |
| d | space-bunny-alpha | A 爆兵 | **A**（v1 写死 → 回喂后回读探测） | 值大者胜（自证方向无关） | **1/5** | ✅ | 0 | 0 | 0 |

失败存档：`xiaomi/mimo-v2.6-pro` 7 次尝试零产出（思考膨胀 × 网关单流时间上限），记失败、不进 `benchmarks/`。

### P0 待裁项裁决

- **index 自认（P0-1）**：分裂（候选 A×3 / B×1），且三舱的“候选 A”落到三个不同机制；cell-d 独立证明候选 A/B 在当前 schema 下**均无可行解**。→ 终稿必须补显式机制（快照标记位或独立查询函数）。
- **轮转方向（P0-2）**：不分裂，4 舱全按“值大者胜”记录、无舱质疑；且无脚本真正依赖该方向分支。→ 降级为记录口径项。

### 策略稳定性裁决

- **cell-a vs cell-d（同策略 A，异模型）**：脚本结构相似（策略稳定）；校验错误类型不同（a=0 项偏实现完备，d=2 项偏记法服从），但指向**同一组措辞问题**，无模型特有盲区。
- **cell-a vs cell-b（异策略，同档位模型）**：脚本忠实体现预期策略差异（worker 3 vs 6–8、4 phase 分段、军事比重）；共同盲点集中在 index 自认与快照字段无读取入口，指向同一措辞问题。

### 验收确认

- **≥2 个脚本通过校验、策略不同（srs §4 第 2 条 + fsr R2）**：✅ 4 份通过（A×2 / B / C；cell-d 以 v2 通过），覆盖 3 种策略取向、4 个模型。
  - 驾驶员独立重跑：4 舱 `script.v1.js` 均无禁项 / 无浮点 / API 全在白名单 / `stripTypeScriptTypes` 可编译；仅 cell-d v1 入口记法与 `MY_INDEX` 写死 2 项静态不符（v2 修正，不计入 API 越界/参数错误列）。
- **FR-10 AC1（盲写可过校验 + 回喂 ≤5 轮）**：✅ 4 舱全部 ≤1 轮。
- **证据索引**：`blind/cell-{a,b,c,d}/`（三件套）、`blind/cell-c-failed-attempts/`（失败档）、`draft/wording-risks.md`「盲写卡点」节、07 票 Answer。

### 待下游

- 08 消费 4 份脚本 + 元数据做桩模拟取证（不依赖本节措辞分析）。
- 09 消费 08 取证 + 本节模型可用性记录，做终局标定定案。
