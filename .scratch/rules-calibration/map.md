# Map:规则契约与数值标定环

Label: wayfinder:map
Status: closed

## Destination

清零 gdd《开放项》的规则侧迷雾:gdd §7 全部参数进入**可验收区间**、§6.1 的 C1~C7 与 §2 设计时间轴成为**可执行的验收命题**、资源枯竭与 `tickLimit` 自洽(gdd #3)、农民占领/堵点性价比有结论(gdd #4/#5)。产出:`rulesets/v1.json` 定稿值 + `docs/rules-v1` 契约定稿的**决策清单与验证证据**。本图只定决策与取证(throwaway 桩),真实 engine 实现与正式落库是图外 hand-off。**已收口**(09 resolved):决策在 09 票,交接单在 [`handoff.md`](handoff.md),gdd 改动已落盘(v2.2)。

## Notes

- 域:gdd §2(时间轴)、§3.2(占领张力)、§5(经济)、§6.1(C1~C7)、§7(参数清单)、§8 开放项 #1/#3/#4/#5;验收口径 srs v2.1 FR-10 AC1(模型盲写 + 校验回喂 ≤5 轮)、srs §4 第 2 条(模型基准脚本);风险锚点 fsr R2(规则无区分度)。
- 每个 session 走 `grilling` + `domain-modeling`;按票型另走 `research` / `prototype`。
- 站位偏好:**戏剧性优先是调参目标,不是事后文案**(gdd 支柱 1——单调化的设计即缺陷);全整数数值;验证一律用 throwaway 桩(工作台/桩模拟器),**不提前造真 engine**;C 约束"不成立"必须是有意的决定并留记录(gdd §6.1)。
- **标定环是迭代的**:「桩模拟器对局取证」的证据会回流前面的定案票(重开或以评论追加),「终局标定定案」是收口闸,不达标的回炉方向在那里裁决。
- 每个事实只有一个家:决策只写进票的 `## Answer`,本图只留一行 gist + 链接;引用票一律用票名。
- tracker:本地 markdown(docs/agents/issue-tracker.md)。

## Decisions so far

- [先例数值区间参照](issues/01-numeric-baseline-references.md):一手来源给出了经济、战斗结构、对局上限与验证方法的局部参照，但无可直接迁移的兵种终值；候选搜索量级与出处见该票 findings。
- [验证工作台:C1~C7 与经济算术](issues/02-calibration-workbench.md):throwaway Python 算术台在有限网格中找到 C1–C6 同时成立解，并参数化暴露 C7、资源枯竭与 2/3 tick 领土分所需输入；未把敏感性扫描误作定案值。
- [经济与节奏数值定案](issues/03-economy-pacing-values.md):定案 600 tick、采集 `1×20`、单矿储量 125、终局分 `4/1/6` 与经济死亡边界；兵种成本、生产耗时和 `initialResources` 留给 04 票并要求证据回流。
- [战斗与兵种数值定案](issues/04-combat-unit-values.md):grilling 两轮 11 问零违反收口——roster `worker{4,2}/melee{8,12,3}/ranged{12,4,2,r2}/cavalry{16,6,2,s2}`、时间表 `2/4/6/8`、`initialResources=16`；C1~C7 全成立，C7 不回流 03；下游输入给 05/08，证伪时回流本票。
- [占领机制与农民性价比定案](issues/05-capture-worker-balance.md):grilling 三轮 6 问接受现状收口——`captureTicks=10`、机制与造价不动、不开“有意不成立”记录；新立两条判定标准(农民海争夺+实证、续命实例+形式底线)；08 必验农民海统计与续命实例，失衡时回流本票。
- [契约草案](issues/06-rules-v1-contract-draft.md):prototype(静态 markdown 草案,LOGIC/UI 分支不适用已声明)——交付物 4 文件在 throwaway 分支 `prototype/06-rules-v1-contract-draft`(main 不含草案);最高优先级待决 3 项(index 自认、轮转方向、`ERR_*` 候选码)待 07 盲写实证。
- [基准策略脚本(模型盲写)](issues/07-baseline-strategy-scripts.md):srs v2.1 取消人类义务，07 改为 2~3 档位模型只读 draft/ 盲写 + 校验回喂 ≤5 轮 + 模型版三件套记录；人类基线不单独安排；fsr/hld/gdd 人类字样同步为模型(含义以 srs 为准)。
- [盲写 cell-c](issues/12-blind-run-cell-c.md):C 农民海，两轮——首轮 mimo-v2.6-pro **失败**（思考膨胀 84K–120K chars/流 × commandcode 网关单流时间上限死锁，7 次尝试零产出，存档 `blind/cell-c-failed-attempts/`）；换 `deepseek-v4.1-flash` 重试轮（thinking=low）**成功**，初版即过静态校验、回喂 0/5 轮，三件套落 `blind/cell-c/`。实证 pi `-p` 遇 `length` 静默终止 + 网关单流时间上限（≈20min，时间型非字符型）+ `api.md` §5 候选 B 定义与 PROMPT 冲突。
- [盲写 cell-a](issues/10-blind-run-cell-a.md):A 爆兵 × deepseek-v4.1-flash 初版即过静态校验（回喂 0 轮），三件套落 `blind/cell-a/`；实证 4 条风险（脚本源 JS/TS 未定义、no-risks 舱泄露 wording-risks 哈希行、模型自记 FIXES 与回喂轮次混栏、验收与交付要求对 session 出舱口径矛盾），供 14 汇总。
- [盲写 cell-d](issues/13-blind-run-cell-d.md):A 爆兵 × space-bunny-alpha，回喂 1 轮（入口记法 `function loop()` 不符硬约束字面 + `MY_INDEX=0` 写死）即过，三件套落 `blind/cell-d/`；策略稳定性跨模型证据成立（与 cell-a 骨架同构，差异只在严谨度），实证 `: void` 记法 4 舱 3:1 分裂 + 候选 A/B 在当前 schema 下**无可行解**（无自标记字段/无 index 查询/读未暴露字段判越权）。
- [盲写 cell-b](issues/11-blind-run-cell-b.md):B 扩张 × MiniMax-M3，初版即过静态校验（回喂 0 轮），三件套落 `blind/cell-b/`；与 cell-a 策略区分度成立（worker 3 vs 6–8、4 phase 分段）；候选 A `MY_INDEX=0` 写死为 4 舱最脆弱同源单点；附协议差异注记（anthropic-messages vs openai-completions，非模型差异）。状态由 `ready-for-agent` 补正为 resolved（Answer 已先落盘，14 收口前置）。
- [盲写汇总 + wording-risks 卡点](issues/14-blind-collect-verdict.md):4 舱 4 份脚本通过（A×2/B/C；cell-d 以 v2），覆盖 3 策略取向 / 4 模型，FR-10 AC1 与 srs §4 第 2 条验收成立；P0-1 index 自认 3:1 分裂且 schema 下无可行解（升级为已证实 P0）、P0-2 轮转方向不分裂（降级为记录口径项）；新增 P0：TS/JS 记法未定义、`ErrResult` 未展开、快照字段有 API 面缺、候选 B 定义冲突；cell-c 首轮 mimo 失败存档；卡点节写入 `draft/wording-risks.md`；07 收口 resolve。
- [桩模拟器对局取证](issues/08-stub-sim-evidence.md):task 收口——1168 场（M0~M5×3 变体）+ C1~C7 + 速度消融 + 占领遇战受控实验；判读见 `sim/results.md`（成立：时间轴形态/农民海非无脑最优/C1~C7/续命实例；失衡：枯竭时点提前 160–185 tick → 回流 03；契约缺口 → 06）；附带改写 14 的 P0-1（`ERR_NOT_OWNER` 回读即可行自认，盲写无一发现）。
- [终局标定定案](issues/09-final-calibration-verdict.md):**resolved**——grilling 三轮 21 问收口。收口判据取“数值项必绿+意图类命题允许记录”（理由：典型与拉满经济吞吐差 4.4×，枯竭无解于“必须是典型阶段”）；唯一改值 `resourcePerSite` 125→200（复跑实测：拉满经济 470–550、全矩阵采空中位 511、典型局剩 80.1%，终值成立）；三条桩夹具解读升格为规则定案（开局 1 圈己方矿/出兵格=基地格且堵自家基地阻塞产线/重复下单静默丢弃+补 `producing`）；13 键定稿 + 3 组移交键（带验收命题）→ [`handoff.md`](handoff.md)；gdd §2/§4/§5/§8 已改（v2.2），§8 新增记录 #7~#10。复跑已完成（1336 场，`sim/data-rerun-200/` + `sim/results-rerun.md`）：补 M6 同策略对称局（a/a 中位 240、0 超时）与 M7 骑兵开关实验（造骑兵平均名次 2.97 vs 不造 1.91，支持 #10），并关掉 P1-10“终局屯兵等超时”的证据缺口；顺带修掉 `sim/map.mjs` 单矿储量写死 125 的桩缺陷。
- 依赖拓扑：10/11/12/13（Blocked by 06，相互并行，**均已 resolved**）→ {08（Blocked by 10,11,12，只等脚本）∥ 14（已 resolved）} → **07 已收口 resolved** → 09（**已 resolved**）。08 的桩模拟器需要 14 的 wording-risks 吗？不需要——08 用脚本 + 元数据，14 的措辞分析只进 09。物理隔离方案：bwrap 隔离舱（`blind/blind-run.sh`，舱内只见 input/ + work/，PI_CODING_AGENT_DIR 锁舱内家目录）；subagent 在 repo 侧当驾驶员，不入舱；方案经 smoke test 验证。盲写模型分配：cell-a(A爆兵×deepseek-v4.1-flash)、cell-b(B扩张×MiniMax-M3)、cell-d(A爆兵×space-bunny-alpha，策略交叉验证)、cell-c(C占点不采集)首轮 mimo-v2.6-pro 失败、换 deepseek-v4.1-flash(thinking=low) 重试成功；全舱 no-risks 输入一致。**本图无剩余前沿**：09 已收口，gdd《开放项》#1/#3/#4/#5 清零，#2/#6 与工程侧 #2/#3/#5/#6/#7 按 `handoff.md` §2 移交。

## Not yet specified

<!-- 朝向目的地、现在还提不出尖锐问题的迷雾;等前沿推进后毕业成票 -->

- **预算敏感性耦合**:桩不模拟运行时预算,而 69% 的拒单率说明脚本**每 tick 都在重复下单**——预算上限一旦生效,被砍掉的正是这些多余 intent;另外 API 调用计数上限会先打到寻路调用(`findPath` 是否单独设限未定)。归《预算与性能终值》图,现已带验收命题写进 `handoff.md` §2.1。

## Out of scope

<!-- 超出目的地的工作:不毕业,目的地重画才回来 -->

- **地图坐标、点位数量不变量与种子变体**(gdd #2/#6):归「地图池与种子变体定案」图。
- **座位轮换实效**(hld #3):归「座位轮换实效定案」图。
- **预算参数终值**(hld #2)、**快照拷贝粒度**(#6)、**回放存储**(#7)、**NFR-3 单场墙钟 X**:归「预算与性能终值」图。
- **工具链基线**(hld #5):独立小图,退化方案已备。
- **真实 engine 实现与 `docs/rules-v1`/`rulesets/`/`benchmarks/` 正式落库**(M1 交付物):本图只出定稿决策 + throwaway 验证证据,落库是图外 hand-off。
- **跨赛季规则演化与防污染策略**(fsr R1):v0 范围外(srs §1.2)。
