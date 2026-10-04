# prop2-seeds8 —— 命题② 消耗占比的补充扫（种子从 4 颗扩到 8 颗）

**这是什么**：票 06 命题②的主表（`../prop2-tables.md`，64 场，种子 `SEEDS_PROBE` = 11/23/41/71）
的**补充扫**：只把种子换成标定环的 `SEEDS` 全集 8 颗，其余口径逐字不动，
用来把「最坏单场 ≤ 1/4」这条比中位更严的判据的样本量从 64 扩到 128。

**怎么跑出来的**（确定性，逐字可复现）：

```bash
cd .scratch/rules-calibration/sim && node --disable-warning=ExperimentalWarning selftest.mjs
# → PASS: 33 passed, 0 failed（硬前置）
cd .scratch/map-pool/runs && \
  PROP2_SEEDS=11,23,37,41,59,71,83,97 PILOT_OUT=$PWD/prop2-seeds8 \
  node --disable-warning=ExperimentalWarning pilot-prop2.mjs
```

**结果：这一版没有产出任何新信息**，每一格的 min / 中位 / max 与主表逐字相同，
超配额场次仍是 `0/128`。原因是种子维度对这条指标零方差——逐场拆开：

```
P0/fixture        s11=[242,341,460,360]  s23 = s37 = s41 = s59 = s71 = s83 = s97
P1/open-clash     s11=[367,340,381,447]  s23 = s37 = s41 = s59 = s71 = s83 = s97
P1/corridor-split s11=[263,362,406,406]  s23 = s37 = s41 = s59 = s71 = s83 = s97
P1/fortress-core  s11=[259,412,322,342]  s23 = s37 = s41 = s59 = s71 = s83 = s97
```

机制不是「变体填充对消耗不敏感」——变体填充**确实随种子变**（8 颗种子填了 2/6/4/4/4/3/3/5 条轨道，
`open-clash` 的墙格数 140/156/148/148/148/144/144/152），而是
`sim/engine.mjs` 里 **没有任何随机源**（`grep -n "seed"` 零命中）、4 份基准脚本也**不用随机**
（`Math.random` 只出现在 cell-d 头注「无 Date / Math.random / …」那一行里），
所以一颗种子唯一能进对局的通道就是装饰性变体填充，而它一次都没改掉任何消耗值。

**因此引用这一版时必须写「4 座位轮转 × 8 种子 = 128 场，但有效独立样本仍是 4 个座位轮转」**，
不能当 128 个独立样本用。结论与机制见 `../../docs/diagnostics/06-prop2-consumption.md` §5.2。

**这一版保留下来而不是删掉**，是因为它是「种子零方差」这个说法的原始证据：
`prop2-matches.json` 里有 128 场逐场记录可供复核。

产物：`prop2-tables.md`、`prop2-summary.json`、`prop2-matches.json`（含 manifest）。