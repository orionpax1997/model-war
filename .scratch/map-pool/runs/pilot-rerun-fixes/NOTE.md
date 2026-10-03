# pilot-rerun-fixes —— 修完 F1/F2/F3 之后的受控重跑

**这是什么**：票 06 第一段试点（`.scratch/map-pool/runs/pilot-tables.md`）在修掉诊断文档
`docs/diagnostics/06-confound.md` 列的三条混淆之后，**用同一套跑法**重跑一遍的产物。

**怎么跑出来的**（确定性，`pilot-matches.json` 逐字可复现）：

```bash
cd .scratch/rules-calibration/sim && node --disable-warning=ExperimentalWarning selftest.mjs
# → PASS: 33 passed, 0 failed（硬前置）
cd .scratch/map-pool/runs && PILOT_OUT=$PWD/pilot-rerun-fixes node --disable-warning=ExperimentalWarning pilot.mjs
```

`PILOT_OUT` 是这一版新加的开关：诊断文档逐行引用的是第一段那张表，重跑不能覆盖它，
所以两次跑批的产物并存（`pilot-tables.md` = 修前，`pilot-rerun-fixes/pilot-tables.md` = 修后）。

**口径与第一段完全一致**：`resourcePerSite=200`、4 种子（11/23/41/71）、变体填充 50%、
「采空」= `depletion.ticks.p100`、「首触」= `timeline.firstContact`、每方同脚本自战 + mirror。
地图一个字节都没动（`pilot-manifest.json` 里有三张图的 sha256）。

## 受控判据：先看夹具臂

修的三条是探针缺陷，所以**夹具臂（无墙对照）必须原地不动**。实测：

| 臂 | 采空(p100) | 全场交付均值 | workerPeak | 相对第一段基线 |
|---|---:|---:|---:|---|
| `P0/fixture/farmer6` | 479 | 3080 | 6 | **0% / 0%**（逐字相同） |
| `P0/fixture/farmer8` | 316 | 3080 | 8 | p100 从 479 降到 316 |

farmer6 那一行是受控判据的锚：它在修之前就是「6 农、采空中位 479、交付 3080」，
修之后逐字不变 → 三条改动在无墙平原上是零影响（象限车道与原 `(id-1)%4` 逐点位一致，
距离场在无墙平原上恒等于 Chebyshev，farmer6 的 6 农本来就不是靠交付记账撑起来的
——16 起始资源刚好够再下 4 个，恰好停在 6）。

farmer8 那一行不是漂移，是 **F3 修好之后 8 农档第一次真跑**：workerPeak 从 6 到 8，
经济剖面变快，采空中位自然从 479 前移到 316。

## 三张真图

见 `pilot-tables.md`。**注意 命题① 的 400–600 窗口与这份表对不上，但结论不是「不过」——
是「还判不了」**，理由见 `../pilot-exp-idlefix/NOTE.md` 记录的第四条混淆。