# 票 06 第一段试点：带墙真图 × 农民海经济剖面

口径见 `pilot.mjs` 头注。要点：`resourcePerSite=200`（同 479 基线）、4 种子、变体填充 50%、
「采空」= 全图储量 100% 采空的 tick（`depletion.ticks.p100`）、「首触」= 敌对单位 Chebyshev ≤ 2 的首个 tick。
括号里是 min–max。P0 = 无墙夹具对照（本进程同批重跑），P1 = 三张带墙真图。

| 组 | 场 | 采空(p100) 中位 | 75% | 50% | 结束剩余% | 首触 中位 | 全场交付均值 | 结局 |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| P0/fixture/farmer6-mines1 | 4 | 479（479–479） | 346（346–346） | 230（230–230） | 0（0–0） | — | 3080 | timeout@600 |
| P0/fixture/farmer8-mines1 | 4 | 479（479–479） | 346（346–346） | 230（230–230） | 0（0–0） | — | 3080 | timeout@600 |
| P1/corridor-split/farmer6-mines1 | 4 | — | — | — | 75（75–75） | — | 720 | timeout@600 |
| P1/corridor-split/farmer8-mines1 | 4 | — | — | — | 75（75–75） | — | 720 | timeout@600 |
| P1/fortress-core/farmer6-mines1 | 4 | — | — | — | 75（75–75） | 31（31–31） | 720 | timeout@600 |
| P1/fortress-core/farmer8-mines1 | 4 | — | — | — | 75（75–75） | 31（31–31） | 720 | timeout@600 |
| P1/open-clash/farmer6-mines1 | 4 | — | — | 421（421–421） | 42.5（42.5–42.5） | 31（31–31） | 1760 | timeout@600 |
| P1/open-clash/farmer8-mines1 | 4 | — | — | 421（421–421） | 42.5（42.5–42.5） | 31（31–31） | 1760 | timeout@600 |

## 地图体检

| 图 | 墙格(声明/seed 填充后) | 变体候选轨道 | 点位 | 可达格 | 四重对称 |
|---|---:|---:|---:|---:|---|
| open-clash | 132 / 140 | 8 | 28 | 3956 | ok |
| corridor-split | 200 / 208 | 8 | 28 | 3888 | ok |
| fortress-core | 72 / 80 | 8 | 28 | 4016 | ok |

产物：`pilot-matches.json`（逐场）、`pilot-summary.json`（本表的机读版）、`pilot-manifest.json`（口径与地图 sha256）。