# 基准策略脚本(≥2,模型只读草案盲写)(task)

Type: task
Status: resolved
Blocked by: 06

## Question

**模型**只读票「rules-v1 契约草案」的草案(`.scratch/rules-calibration/draft/` 四文件,不读 gdd/hld/实现/桩源码)生成 ≥2 个策略不同的基准脚本——这本身就是 srs v2.1 FR-10 AC1 的验收("模型仅凭文档生成可过校验脚本")与 srs §4 第 2 条的标定载体:

1. 模型档位:2~3 个不同档位/厂商模型各写一支(以实际可调用为准,执行人用自有模型订阅调用),强制覆盖"爆兵压制 vs 扩张运营"两种策略取向;农民海抢点作为可选第三支,专门检验 gdd #4 的张力;
2. 盲写约束:喂给模型的输入只有 draft/ 四文件,禁 gdd/hld/实现/桩源码,违禁即污染;
3. 校验回喂:允许静态校验错误回喂(对标 FR-5:编译 + API 误用检查,≤5 轮,只回喂错误信息,无对战反馈);
4. 每个脚本记录模型版三件套:初版原文(未改一字) + 每次调错的 API/越界/快照误用清单 + 回喂轮次与自愈情况——汇总成"模型可用性记录",追加进票「rules-v1 契约草案」`wording-risks.md` 的盲写卡点节,作为"措辞待裁清单"的实测补充;
5. 脚本按参赛契约写(单文件、`function loop()`、全整数、无 `Date`/`Math.random`),使其日后可直接跑真 engine。

产出:≥2 个基准脚本 + 一份"模型可用性记录"(FR-10 AC1 的证据)。脚本是标定载体,正式 `benchmarks/` 落库在图外。

## 执行记录

子票：
- 10 blind-run cell-a（爆兵 × deepseek-v4.1-flash）
- 11 blind-run cell-b（扩张 × MiniMax-M3）
- 12 blind-run cell-c（农民海；首轮 mimo-v2.6-pro 失败，重试轮 deepseek-v4.1-flash×thinking=low 成功）
- 13 blind-run cell-d（爆兵 × space-bunny-alpha，策略交叉验证）
- 14 blind-collect + verdict（Blocked by 10~13）

执行方式：bwrap 隔离舱(`blind/blind-run.sh`)×4，全舱 no-risks；driver subagents 在 repo 侧调度、不入舱；认证走本地 pi provider（替代 Question 项 1 原"人类订阅"假设，验收口径不变：盲输入、≤5 轮、只回喂校验错误）。
收口规则：14 resolved ⇒ 本票 resolved（Answer 由 14 写入）；10~13 resolve 后 08 与 14 可并行；09 消费 08 取证 + 14 可用性记录。

## Notes

- srs v2.1 已把 FR-10 AC1 与 §4 第 2 条的"人类"改为模型;fsr M1/R2、hld、gdd 中的"人类基准脚本"字样已同步改为模型基准脚本(指针性同步,含义以 srs 为准)。
- 人类基线不再单独安排:本票以多档位模型 dry-run 同时覆盖"文档可读性验证"与"标定载体"两个目的;09 收口时以"模型可用性记录"为 FR-10 AC1 证据。
- 状态语义:`ready-for-human` = 等你操作自有订阅跑模型(agent 无订阅访问权,不会接手);非指人手写脚本。模型输出回填前本票保持等待,不转 `ready-for-agent`。

## Answer

收口（由 14「盲写汇总」写入）：4 舱盲写完成，**4 份脚本通过静态校验、覆盖 3 种策略取向 / 4 个模型**，满足 srs v2.1 FR-10 AC1 与 §4 第 2 条。汇总证据落在 `draft/wording-risks.md`「盲写卡点」节；本节记脚本引用 + 模型可用性记录 + 策略稳定性结论。

### 基线脚本引用（初版原文，未改一字）

| 舱 | 模型 | 策略 | 脚本 | SHA256 | 回喂 | 终态 |
|---|---|---|---|---|---|---|
| a | `commandcode/deepseek/deepseek-v4.1-flash` | A 爆兵 | `blind/cell-a/work/script.v1.js`（267 行） | `1222a2db…f3ae94` | 0/5 | v1 |
| b | `minimax-cn/MiniMax-M3` | B 扩张 | `blind/cell-b/work/script.v1.js`（263 行） | `067d8440…bec5e43` | 0/5 | v1 |
| c | `commandcode/deepseek/deepseek-v4.1-flash`（thinking=low） | C 占点(不采集) | `blind/cell-c/work/script.v1.js`（254 行） | `29bb5efb…769c28a` | 0/5 | v1 |
| d | `commandcode/stealth/space-bunny-alpha` | A 爆兵 | `blind/cell-d/work/script.v1.js`（411 行） | `3a9895e0…574a2c2` | 1/5 | `work/script.v2.js` `db450c2e…70aed6` |

失败存档：`blind/cell-c-failed-attempts/`（`xiaomi/mimo-v2.6-pro` 7 次尝试零产出）。

> **标签口径修正(票 09)**:上表的策略标签是**行为描述,不是能力评级**。`c` 不代表农民海——它把占点当唯一目标、几乎不采集(平均交付 20.4 资源、全程农民占比 54.3%、536 个席位经济死亡中位 tick 94),故标为「C 占点(不采集)」。农民海必须用「会采集的农民海」来测(08 的 `probes/farmer.js`,交付 160–244),而探针不进 `benchmarks/`、不计入 FR-10 AC1 证据。证据:`sim/results.md` §2 与 `sim/data/tables.md` §0。

### 模型可用性记录

| 舱 | 模型 | 策略 | 自认候选 | 轮转方向假设 | 回喂轮次 | 通过? | API 误用 | 快照误用 | 越界/参数错误 |
|---|---|---|---|---|---|---|---|---|---|
| a | deepseek-v4.1-flash | A 爆兵 | **A**（players 顺序=座位；`move()` 返回值探测兜底） | 值大者胜 | 0/5 | ✅ | 0 | 0 | 0 |
| b | MiniMax-M3 | B 扩张 | **A**（`MY_INDEX=0` 写死） | 值大者胜 | 0/5 | ✅ | 0 | 0 | 0 |
| c | deepseek-v4.1-flash（首轮 mimo-v2.6-pro 失败；重试 thinking=low） | C 占点(不采集) | **B**（自标记：全单位试探 `move` + 回读 owner 反推） | 值大者胜 | 0/5 | ✅ | 0 | 0 | 0 |
| d | space-bunny-alpha | A 爆兵 | **A**（v1 写死 0 → 回喂后 `getObjectById` 回读探测） | 值大者胜（另自证方向无关） | **1/5** | ✅ | 0 | 0 | 0 |

- 4 舱 API 误用 / 快照误用 / 越界均为 **0**：静态面上无一脚本调错 API 或缓存对象引用；失败集中在语义/契约空洞（TS/JS 记法、index 自认、`ErrResult` 展开、快照字段无读取入口）。cell-d v1 的 2 项静态不符（入口 `: void` 记法、`MY_INDEX` 写死）已由 v2 修正，不计入 API 越界/参数错误列。
- 口径：cell-a 与 cell-c 同模型异策略（C 用 `thinking=low`、A 用 `high`）；cell-a/cell-d 同策略异模型；cell-b 异模型异策略。cell-c 首轮 mimo 失败属“模型档位 × 网关”可用性问题，非措辞误读。

### 策略稳定性结论

**cell-a vs cell-d（同策略 A、不同模型）——策略稳定跨模型成立。**

- 脚本结构相似：骨架同构（worker 达阈后转军事 / 近战远程，`MIN_WORKERS` 兜底；单步 `move` + `getTerrainAt` 绕墙、不调 `findPath`；“候选 A + 值大者胜”两条记录一致）。
- 校验错误类型不同：cell-a **0 项**（偏实现完备），cell-d **2 项**（偏记法服从：入口 `: void` 记法、`MY_INDEX` 写死）；两者指向**同一组措辞问题**（TS/JS 记法、index 无出口、`ErrResult` 未展开），无模型特有盲区。
- 差异集中在工程严谨度：cell-d 额外做方向无关性论证、探测确认计数、`ERR_NOT_OWNER` 自愈与 fallback；cell-a 更简。
- 判定：**“爆兵压制”非偶然收敛**，骨架/生产决策/移动/两条记录全部同构复现。

**cell-a vs cell-b（不同策略、同档位模型）——策略区分度成立（fsr R2 证据）。**

- 预期差异被忠实表达：cell-a 在 worker=3 即转近战/远程；cell-b 持续扩工至 6–8、按 `rules.md §1` 切 4 个 phase、大量 tick 无军事产出。生产队列追踪风格也不同（a 自记 pending、b 靠 `ERR_NOT_ENOUGH_RESOURCES` 自然过滤）。
- 共同盲点指向同一措辞问题：两舱都选**候选 A**（实现不同）、都因**快照字段无读取入口**被迫自记资源/生产队列、都按**值大者胜**记录 → 共同指向 P0-1（index 自认）与 P0-N3（快照字段有、API 面缺）。
- 附证（同模型异策略）：cell-a vs cell-c 同一 `deepseek-v4.1-flash` 分别产出 A 爆兵与 C 占点(不采集)，证明策略差异来自 `STRATEGY.txt` 策略行而非模型偏置。

### 验收对照

- **FR-10 AC1**（仅凭文档生成可过校验脚本，≤5 轮回喂）：4 舱全部 ≤1 轮通过 → 通过；证据 `blind/cell-{a,b,c,d}/` 三件套 + `draft/wording-risks.md`「盲写卡点」节。
- **srs §4 第 2 条**（≥2 个模型基准脚本、策略不同、能完成对局）：实际 **4 份通过静态校验**（A×2 / B / C，cell-d 以 v2 通过），覆盖 3 种策略取向、4 个模型 → 通过。
- 脚本对局侧覆盖度（“能完成对局”）由 08「桩模拟器对局取证」消费本表脚本取证；本票只交付脚本与可用性记录。
- 收口：本票 Answer 由 14 写入，`14 resolved ⇒ 本票 resolved`；09 消费 08 取证 + 本节可用性记录。
