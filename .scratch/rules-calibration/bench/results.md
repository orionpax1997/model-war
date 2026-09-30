# Calibration workbench output

### 1) 站桩对拼可行域

- 搜索网格：worker 16 × melee 27 × ranged 108 × cavalry 45；共评估 2099520 个完整 roster（战斗配对用缓存复用）。
- 同时成立解：**1084491 个完整 roster**（候选离散网格内）；因此 C1–C6 在本工作台的操作化定义下**有同时成立解**。单项通过数是该约束在全网格中的通过数量，不能相加。
- 等成本方式：双方预算取造价最小公倍数，按整数单位组成；每方每 tick 全体存活单位集火当前最低 HP 目标，同时结算。假定无遮挡接敌起点为 Chebyshev 距离 6，按射程/速度算远程先手 volley（忽略同时进入近战射程的那一轮）。

| 约束 | 满足候选数 | 判定 |
|---|---:|---|
| C1 | 1920240 | 有解 |
| C2 | 1898208 | 有解 |
| C3 | 2099520 | 有解 |
| C4 | 1991520 | 有解 |
| C5 | 1679616 | 有解 |
| C6 | 1574640 | 有解 |

| 同时解中的参数 | 可行区间（候选搜索网格内） |
|---|---:|
| `worker.cost` | 4, 5, 6, 8 |
| `worker.hp` | 2, 3, 4, 6 |
| `melee.cost` | 8, 10, 12 |
| `melee.hp` | 12, 16, 20 |
| `melee.damage` | 3–5 |
| `ranged.cost` | 12, 16, 20 |
| `ranged.hp` | 4, 6, 8, 10 |
| `ranged.damage` | 2–4 |
| `ranged.range` | 2–4 |
| `cavalry.cost` | 16, 20, 24, 30, 40 |
| `cavalry.hp` | 6, 8, 10 |
| `cavalry.damage` | 2–4 |
| 速度 | worker/melee/ranged = 1；cavalry = 2（约束固定） |
| `spawnTicks` | C1–C6 对它无约束；可行关系只有外部给定的 `spawnTicks = ceil(cost × α)`（α>0）。不能从这六条约束推出 α 的有限上下界。 |

一个具体见证（非推荐终值）：

| 兵种 | cost | hp | damage | range | speed | spawnTicks（α=0.5） |
|---|---:|---:|---:|---:|---:|---:|
| worker | 4 | 2 | 0 | 1 | 1 | 2 |
| melee | 8 | 12 | 3 | 1 | 1 | 4 |
| ranged | 12 | 4 | 2 | 2 | 1 | 6 |
| cavalry | 16 | 6 | 2 | 1 | 2 | 8 |

对该见证取 `harvestRate=1, carryLimit=20, D=4`，单农完整周期 25 tick、净收入 0.8/tick；所有兵种按 `spawnTicks=ceil(cost×0.5)` 生产时，单基地满产烧钱率均为 2/tick。因此这组数在上述经济假设下也给出 **C1–C7 同时成立解**。
C3 清晰优势阈值：近战胜后至少保留初始总 HP 的 25%；该见证附近的约束仍需后续桩模拟实证。

> 区间是有限候选格点投影，不是连续数学可行域或推荐平衡值。焦点集火、接敌距离 6 和 25% 的 C3 阈值均是工作台假设；改任一假设须重跑。

### 2) 经济回路与 C7 可行域

假设矿/基地中心 Chebyshev 距离为 D；农民在二者各自相邻一格作业，故每程走 `max(0,D−2)` 格、速度 1；满载后往返并花 1 tick 交付，不计争夺/堵路/采矿停工。令携带量 = `harvestRate × 有效采集 tick`（20–50 tick），则：

```text
cycleTicks = carryTicks + 2×max(0,D−2) + 1
workerIncome = carryLimit / cycleTicks
baseBurn(unit) = unit.cost / unit.spawnTicks
C7 ⇔ baseBurn > workerIncome；舒适筛选带（启发式）= 2–4 × workerIncome
```

| harvestRate | D | 携带量范围（20–50 tick） | 单农净收入/ tick 区间 | 单基地舒适满产消耗/ tick（2–4×） |
|---:|---:|---:|---:|---:|
| 1 | 4 | 20–50 | 0.80–0.91 | 1.60–3.64 |
| 1 | 8 | 20–50 | 0.61–0.79 | 1.21–3.17 |
| 1 | 12 | 20–50 | 0.49–0.70 | 0.98–2.82 |
| 2 | 4 | 40–100 | 1.60–1.82 | 3.20–7.27 |
| 2 | 8 | 40–100 | 1.21–1.59 | 2.42–6.35 |
| 2 | 12 | 40–100 | 0.98–1.41 | 1.95–5.63 |
| 5 | 4 | 100–250 | 4.00–4.55 | 8.00–18.18 |
| 5 | 8 | 100–250 | 3.03–3.97 | 6.06–15.87 |
| 5 | 12 | 100–250 | 2.44–3.52 | 4.88–14.08 |
| 10 | 4 | 200–500 | 8.00–9.09 | 16.00–36.36 |
| 10 | 8 | 200–500 | 6.06–7.94 | 12.12–31.75 |
| 10 | 12 | 200–500 | 4.88–7.04 | 9.76–28.17 |

- 对给定回路，C7 的硬边界是 `min_unit(cost/spawnTicks) > workerIncome`（要声称任何满产兵种组合都满足，需比较其实际生产组合，而不是只挑高消耗兵种）。在连续比例 `spawnTicks≈cost×α` 下，`baseBurn≈1/α`，故 C7 可行当 `α < 1/workerIncome`；2–4× 收入的启发式舒适带为 `1/(4×workerIncome) ≤ α ≤ 1/(2×workerIncome)`。它不是 GDD 规范。
- `initialResources` 不改变稳态 C7；仅决定开局现金跑道。若要求起始存款至少能购买一名补充农民或一名近战兵，必要且充分条件是 `initialResources ≥ max(worker.cost, melee.cost)`；在 combat 搜索网格中的可行下界为 8–12（按具体 roster），此算术没有上界，过高风险须由实战 pacing 定案。
- 存在与 combat witness 兼容的 C7 取值：`harvestRate=1,D=4,carryTicks=20` 时收入 `20/25=0.8/tick`，可设 `carryLimit=20`；近战 `cost=8,spawnTicks=4` 的满产消耗为 `2/tick`，满足 C7。此例 `α=0.5`，连续 2–4× 舒适带为 `[0.3125,0.625]`。

### 3) 枯竭与 `tickLimit` 自洽域

`N` 个资源点、`W` 个等效持续采集农民、采集利用率 η 时，理想化可采总量 `Q = harvestRate × W × η × tickLimit`；全图储量 `S=N×resourcePerSite`。在 2/3–1.0 个 `tickLimit` 才被采空的筛选带为：

```text
ceil( (2/3) × harvestRate × W × η × tickLimit / N )
    ≤ resourcePerSite ≤
floor( harvestRate × W × η × tickLimit / N )
```

敏感性表固定 `harvestRate=2`, `tickLimit=600`, `η=0.5`；变化 N 与持续等效农民数 W。表内上下界分别对应理想采空时间约 2/3 与 1.0 个上限：

| 资源点 N | 等效农民 W | 2/3–1.0 时间轴可行 `resourcePerSite` |
|---:|---:|---:|
| 8 | 4 | 200–300 |
| 8 | 8 | 400–600 |
| 8 | 16 | 800–1200 |
| 16 | 4 | 100–150 |
| 16 | 8 | 200–300 |
| 16 | 16 | 400–600 |
| 32 | 4 | 50–75 |
| 32 | 8 | 100–150 |
| 32 | 16 | 200–300 |

- 此式只给出参数自洽必要的量级，不证明真实对局会采空。`W` 与 η 必须来自地图可用采矿邻格、农民投入时间、搬运路程、基地交付可达性和争夺损失；将 `W` 当作地图上全部单位会高估采集能力。若只要求‘上限内理论可采空’，去掉 2/3 下界即可。
- `resourcePerSite` 的自洽域对 `harvestRate×tickLimit×W×η/N` 线性缩放；当前 GDD 未定 N、W、η，故不存在单独的绝对取值区间。

### 4) 超时领土分与 2/3 终局压力

给定 2/3 tick 时仍可翻动的差额 `ΔB` 个基地、`ΔR` 个资源点，以及 `ΔU` 存活单位造价差，终局可能分差的量级比较为：

```text
territorySwing = ΔB×baseScore + ΔR×resourceScore
unitSwing = floor(U_leader/unitCostDivisor) − floor(U_runnerup/unitCostDivisor)
仍有反超可能 ⇔ 当前领先分差 ≤ 对手可达的剩余 swing（须由地图/策略估计）
```

演示归一化情景（不是地图事实）：ΔB=1, ΔR=2；假定 2/3 tick 时两方存活单位总造价分别为 64 与 32，令 `resourceScore=1`，按探索性的 `baseScore/resourceScore` 比 1、2、4 计算。把单位分差筛在领土分差的 0.5–2 倍，得到：

| `baseScore/resourceScore` | territorySwing | 允许 unitSwing | 可行整数 `unitCostDivisor`（按 floor 精算） |
|---:|---:|---:|---:|
| 1 | 3 | 2–6 | 5–21 |
| 2 | 4 | 2–8 | 4–21 |
| 4 | 6 | 3–12 | 3–12 |

- 这些权重只有相对比例有意义：把 `baseScore`、`resourceScore` 同乘常数会同比放大领土分；`unitCostDivisor` 也需按同一量纲配套调整。演示的单位分差按 `floor(64/divisor)−floor(32/divisor)` 精算。若无地图点位数、2/3 tick 的剩余可争夺点位、两名次典型存活造价及当时领先分差，‘终局压力’不能从 GDD 单独解出唯一数值区间。
- 可移植的验收口径应是：在基准脚本/地图的 2/3 tick，列出可能 swing 上界，并与当时领先分差比较；若大多数对局领先分差已经超过剩余 swing，终局压力来得过早；若上限附近仍普遍有大 swing 且长期无法拉开名次，再调权重/资源/生产。
- 这里的 `baseScore/resourceScore ∈ {1,2,4}`、0.5–2 倍单位分筛选带均为方便暴露比例的扫描点，不是规范或平衡结论。

