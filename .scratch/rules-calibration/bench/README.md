# 标定工作台（throwaway）

这是 `.scratch/rules-calibration/issues/02-calibration-workbench.md` 的可执行算术筛查工具；仅 Python 3 标准库，不属于 `packages/`，不模拟完整 engine，也不产出正式规则数值。

## 运行

```bash
python3 .scratch/rules-calibration/bench/calibrate.py
python3 .scratch/rules-calibration/bench/calibrate.py --section combat
python3 .scratch/rules-calibration/bench/calibrate.py --section economy
python3 .scratch/rules-calibration/bench/calibrate.py --section exhaustion
python3 .scratch/rules-calibration/bench/calibrate.py --section score
```

完整输出快照在 [results.md](./results.md)；重新生成：

```bash
python3 .scratch/rules-calibration/bench/calibrate.py > .scratch/rules-calibration/bench/results.md
```

## 操作化假设与限制

### C1–C6 对拼

- 候选参数是代码中显式列出的有限整数格点；输出区间是所有同时过约束候选 roster 的投影，不代表连续域或推荐值。
- 等成本两军以造价最小公倍数为预算，按整数单位组成。单位总血量按每单位 HP 计算；每 tick 所有存活单位同时攻击，各侧集火当前 HP 最低目标。无地形、无撤退、无目标切换策略。
- 对 C1/C2 从无遮挡直线上的 Chebyshev 距离 6 接敌。远程获得“进入其射程后、近战可还击前”的免费 volley；进入近战射程的那轮按同时伤害处理。这是面板层简化，不是移动碰撞/路径模拟。
- `C3` 的“优势明显”暂操作化为近战胜后至少保留自身初始总 HP 的 25%。GDD 没有定义“明显”的阈值，需后续定案票裁决。
- `C6` 操作化为满 HP 远程被单个近战攻击时，`ceil(ranged.hp/melee.damage) ≤ 2`；射程必须大于 1。
- C4 按效率最高、允许并列处理（`melee ratio ≥ others`）。
- `spawnTicks` 不影响这些纯战斗命题；其比例只通过经济 C7 另行约束。

### 经济 C7

- 矿/基地中心距离 D，矿边/基地边作业，单程移动 `max(0,D−2)`，满载之后一次 transfer tick；没有堵路、争夺或返程中断。
- `carryLimit=harvestRate×carryTicks`，扫描每趟 20–50 个有效采集 tick。净收入按一次完整采集—往返—交付周期计算。
- 单基地持续生产一种单位时资金消耗率 `cost/spawnTicks`。实际混合队列须按单位构成重算；开局 `initialResources` 只影响起步现金，不改变稳态净流量。
- “舒适带”以满产消耗为单农回路收入 2–4 倍作启发式筛查，不是 GDD 规定。若 `spawnTicks≈cost×α`，连续近似为 `1/α`；取整后的实际率仍应逐单位计算。

### 枯竭

- `N` 点、储量 `resourcePerSite`，对照 `W` 个持续等效采集农民、采集利用率 η 与 `tickLimit`。理想供给容量是 `harvestRate×W×η×tickLimit`。
- 2/3–1.0 tickLimit 采空带只是“量级相容”条件。W、η 必须从地图、路线、载量往返、交付可达性和争夺损耗获得；目前 GDD 没有这些地图/策略数据，因此没有唯一的绝对 `resourcePerSite` 解。

### 终局分

- 公式以 2/3 tick 可争夺基地/资源差额以及存活兵力造价差，比较 territory swing 和 `floor(存活单位造价/unitCostDivisor)` 的分差。
- 表中的 `ΔB=1, ΔR=2`、单位造价 64 对 32、权重比 1/2/4、单位分差 0.5–2 倍领土 swing 都只是透明的演示扫描点。未给地图与策略状态前不能把它解释成终局平衡结论。

最终验收需把这些 arithmetic screens 与后续基准脚本/桩模拟的地图、策略证据合看。