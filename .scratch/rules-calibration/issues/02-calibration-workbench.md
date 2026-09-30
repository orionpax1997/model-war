# 验证工作台:C1~C7 与经济算术(task)

Type: task
Status: resolved

## Question

把 gdd 的验收命题写成**可执行的 throwaway 计算工作台**(放 `.scratch/rules-calibration/bench/`,不进 `packages/`),输出各参数的**可行区间**,给后面的定案票当输入:

1. **站桩对拼计算器**:等成本、无地形的对拼模拟,断言 C1(近战>远程)、C2(远程>骑兵)、C3(近战>骑兵且优势明显)、C4(近战 HP/造价与伤害/造价全兵种最高)、C5(骑兵速度 2× 且造价 ≥2× 近战)、C6(远程贴身 2 tick 内被击杀)——输出使约束同时成立的 cost/hp/damage/range/speed/spawnTicks 可行域;
2. **经济算术表**:单农收入(采集-交付回路含路程)vs 单基地满产消耗,断言 C7 并输出"差距舒适区"(过小=爆兵无穷,过大=对局停滞,gdd §8 #5);
3. **枯竭核算表**:全图总储量 vs tickLimit 内的总采集能力,输出 `resourcePerSite`/`harvestRate`/`tickLimit` 的自洽域(gdd §8 #3);
4. **时间轴压力核算**:超时名次所需领土分权重(`baseScore`/`resourceScore`/`unitCostDivisor`)与"2/3 处终局压力"的量级关系(gdd §2 时间轴末段)。

产出:四个可行域表 + 每个 C 命题"是否存在同时成立解"的判定;若无解,指出卡在哪对参数上(这是定案票的关键输入)。

## Answer

可执行 throwaway 工作台与运行快照见 [bench/README.md](../bench/README.md)、[bench/calibrate.py](../bench/calibrate.py)、[bench/results.md](../bench/results.md)。仅依赖 Python 3 标准库；运行 `python3 .scratch/rules-calibration/bench/calibrate.py` 可重算四张表。它是算术筛查，不是真实 engine 或平衡定案。

### 四个可行域与命题判定

1. **C1–C6 站桩等成本对拼**：有限候选整数网格共评估 2,099,520 个完整 roster，同时满足解 1,084,491 个，故工作台操作化假设下**存在同时成立解**。各 C1–C6 单项均有解。候选网格投影、具体见证及各参数区间见 `results.md` §1。
   - 规则化假设：以双方兵种造价最小公倍数配平预算；存活单位集火最低 HP 目标并同 tick 结算；无遮挡、Chebyshev 距离 6 接敌；C3“优势明显”暂定为近战胜后保留 ≥25% 初始总 HP；C6 按单个近战打满血远程 `ceil(ranged.hp/melee.damage) ≤ 2` 判定。
   - `speed` 固定 worker/melee/ranged=1、cavalry=2。C4 按性价比最高允许并列处理。`spawnTicks` 不受 C1–C6 约束，战斗域本身不能确定其比例；其经济边界见 C7。
2. **经济回路与 C7**：以矿/基地距离、往返移动、满载采集 tick 和交付 tick 算单农净收入；`results.md` §2 给出 `harvestRate=1/2/5/10`、D=4/8/12、每趟 20–50 个采集 tick 的敏感性表。连续 `spawnTicks≈cost×α` 时，`baseBurn≈1/α`，C7 硬条件为 `α < 1/workerIncome`；以满产消耗 2–4 倍单农收入作筛选舒适带时，`1/(4×workerIncome) ≤ α ≤ 1/(2×workerIncome)`（启发式，不是 GDD 规范）。存在与战斗见证兼容的例子：`harvestRate=1, carryLimit=20, D=4`，周期 25 tick、单农收入 0.8/tick；近战 `cost=8, spawnTicks=4`，基地满产消耗 2/tick，C7 成立。`initialResources` 对稳态 C7 无影响；开局同时可补 worker/melee 的必要下界为 `max(worker.cost,melee.cost)`，搜索网格对应 8–12，过高风险需策略实测。
3. **枯竭核算**：总储量 `N×resourcePerSite`，理想采集能力 `harvestRate×W×η×tickLimit`。若要求约 2/3–1.0 个 `tickLimit` 采空，则 `ceil((2/3)×harvestRate×W×η×tickLimit/N) ≤ resourcePerSite ≤ floor(harvestRate×W×η×tickLimit/N)`。敏感性表见 `results.md` §3（示例固定 rate=2、limit=600、η=0.5）。由于 GDD 尚未确定地图资源点数 N、持续有效农民 W 与路线利用率 η，不能推出绝对储量终值；必须由地图与策略证据补齐这些量。
4. **终局分与 2/3 压力**：按可翻动点位差额计算 `ΔB×baseScore+ΔR×resourceScore`，并与单位分差 `floor(U_leader/divisor)−floor(U_runnerup/divisor)` 对比。`results.md` §4 给出明确标为演示而非地图事实的归一化扫描：ΔB=1、ΔR=2、单位造价 64 对 32、base/resource 权重比 1/2/4，单位 swing 筛选为领土 swing 的 0.5–2 倍。没有地图点位数、2/3 tick 的可翻点位、实测存活造价差与领先分差，无法唯一确定权重；定案需用后续基准对局检验剩余 swing 是否仍允许反超。

### 判定边界

- C1–C6 在当前明示的简化模型中同时成立；不构成对地图移动、混战策略、经济滚雪球或实际胜率的保证。
- C7 的确有算术解，但工作台的 2–4×“舒适区”是为了给 issue 所述过小/过大留缓冲的探索启发式，需在基准策略里确认；起始资源和终局权重也没有可从当前 GDD 独立推出的完整区间。
- `resourcePerSite` 的绝对可行区间、`baseScore/resourceScore/unitCostDivisor` 的终局压力终值仍依赖未定地图/对局量。这里把缺失输入显式参数化，而不伪造唯一答案。
- 本结论只交付工作台与可复算证据；combat witness、敏感性数值均非规则定案，后续定案票须结合桩模拟/基准策略再裁决。
