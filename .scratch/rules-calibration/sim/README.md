# 票 08 的一次性最小结算模拟器（throwaway）

`.scratch/rules-calibration/sim/` 是**为了让票 08 拿到可复现的数字**而临时搭的结算桩。它按
`../draft/rules.md` 的语义实现 GDD §2 核心循环（移动裁决 / 采集与生产 / 占领 / 战斗 / 胜负），
把 4 份盲写脚本（票 07）和 2 个自写探针放进去对跑，然后**丢掉桩、留下数据**。

- 数字：`data/tables.md`（自动生成，只放数字）
- 判读（成立/失衡、回流票）：[`results.md`](./results.md)（人工维护，拥有结论）
- 可重放的取证实例：`data/replays.json`（10 场，逐 tick 事件流）

## 怎么跑

```bash
cd .scratch/rules-calibration/sim
node --disable-warning=ExperimentalWarning selftest.mjs      # 33 条结算语义自测，必须先过
node --disable-warning=ExperimentalWarning run-all.mjs       # 全量 1168 场 + 对拼实验，约 8.5 分钟（6 并行）
node --disable-warning=ExperimentalWarning run-all.mjs --tables-only   # 只按已有 matches.json 重算表格
node --disable-warning=ExperimentalWarning replay.mjs --curated        # 重新生成 data/replays.json
node --disable-warning=ExperimentalWarning replay.mjs 'M1/center-fortress@40/dabc/s11' --events
```

其它开关：`--quick`（每种矩阵形态 1 场冒烟）、`--serial`（不 fork，调试用）、`--jobs=N`、
`--matrix=M1`、`--variant=open-four@64`。Node 版本：`v24.15.0`（`--disable-warning=ExperimentalWarning`
是 QuickJS 加载用的 flag，正式版不一定需要）。

**先跑 `selftest.mjs`**：桩的结算语义本身就是解释性决策（见下），自测是这些决策的最小回归网。
改 `engine.mjs` 的裁决顺序后必须重跑，否则数据不可信。

## 文件分工

| 文件 | 职责 |
|---|---|
| `ruleset.mjs` | 票 06 敲定的参数原样誊抄（tickLimit / harvestRate / carryLimit / resourcePerSite / captureTicks / 终局分 / 4 个兵种） |
| `map.mjs` | 两张夹具地图（`center-fortress` / `open-four`）× 两种尺寸（64 / 40）+ 四重对称不变量自检 |
| `engine.mjs` | 结算：轮转调度 → 意图校验 → 移动裁决 → 采集/交付 → 生产 → 占领 → 战斗 → 胜负/淘汰 → 快照 |
| `runtime.mjs` | 脚本沙箱：QuickJS 上下文、白名单 API、返回码、异常与丢弃 intent 的计数 |
| `harness.mjs` | 单场对局 + 取证指标 + 矩阵编排（M0~M5） |
| `mirror.mjs` | “注入真实座位”的派生改写（只用于隔离 P0-1，见 results.md） |
| `duels.mjs` | C1~C7 站桩对拼 + 速度消融（R 系列）+ 占领遇战（E 系列） |
| `probes/*.js` | 自写探针（农民海 / 骑兵突袭）。**不是**盲写脚本，不进 FR-10 AC1 证据 |
| `run-all.mjs` / `run-worker.mjs` | 跑批编排（fork 6 个 worker 分片） |
| `tables.mjs` | 自动证据表 |
| `replay.mjs` | 单场重放 / 取证实例导出 |
| `selftest.mjs` | 33 条结算语义自测 |

## 参赛脚本（sha256 前 12 位，录自 `data/manifest.json`）

| 键 | 舱 | 模型 | 策略 | 源文件 | sha256 |
|---|---|---|---|---|---|
| `a` | cell-a | deepseek-v4.1-flash | A 爆兵压制 | `../blind/cell-a/work/script.v1.js` | `1222a2db952e` |
| `b` | cell-b | MiniMax-M3 | B 扩张运营 | `../blind/cell-b/work/script.v1.js` | `067d84408280` |
| `c` | cell-c | deepseek-v4.1-flash(thinking=low) | C 农民海 | `../blind/cell-c/work/script.v1.js` | `29bb5efbbce4` |
| `d` | cell-d | space-bunny-alpha | A 爆兵压制（交叉验证） | `../blind/cell-d/work/script.v2.js` | `db450c2e671a` |
| `raider` | 探针 | — | R 骑兵突袭 | `probes/raider.js` | `8fe00145b6e3` |
| `farmer2/4/6/8/12` | 探针 | — | 农民海各规模档 | `probes/farmer.js` | `0c4a73ee94e3`（靠注入 `WORKER_TARGET` / `HARVEST_PCT` 分档） |

## 矩阵规模

| 矩阵 | 形态 | 目的 | 每变体场次 |
|---|---|---|---:|
| M0 | 逐字四方混战 `[a,b,c,d]` | 契约忠实度（座位自认的实际代价） | 32 |
| M1 | 注入座位四方混战 | 策略平衡（近似“API 正确给 index”） | 32 |
| M2 | 注入座位 2v2（6 组对 × 4 轮换 × 种子） | 头对头胜率 | 192 |
| M3 | `mixed`（a/b/c/raider）+ `selfplay`（四席 raider） | 骑兵在混战里的价值、经济死亡后的行为 | 32 |
| M4 | 农民海探针 vs 爆兵混编（含 a×d 交叉验证） | 票 05：农民海是否可行/最优 | 144 |
| M5 | 农民海四方自战 × {2,4,6,8} 农 × {1,2,3} 圈开局矿 | 票 03：经济吞吐与枯竭时点 | 24 |

三个变体：`center-fortress@64`（456 场）、`open-four@64`（456 场）、`center-fortress@40`（256 场），
合计 **1168 场**。种子 8 个（探针局 4 个），`open-four` 与 `center-fortress@40` 不跑 M5（省一半机时，
它们只作对照地形）。

**种子只驱动装饰性墙体微扰**：`map.mjs` 的 `VARIANT_SLOT_REPS` 按 30% 概率整轨填墙，点位布局与出生点固定。
所以 8 个种子是同一布局的 8 种墙体花纹，**不等于 8 张独立地图**——拓扑鲁棒性本轮没有覆盖。

## 夹具解读（必须和正式引擎区分开）

- **开局各有一圈自家矿**（`ownedMineOrbits`，默认 1）。规则要求“先占领才有开采权”，若开局无矿，
  gdd §5 的“起始资金 + 起始农民保证开局可补经济”就不成立。M5 用 1/2/3 圈扫描这个假设。
- **`resourcePerSite = 125` 沿用票 06 的取值**，16 个资源点 = 全图 2000 存量。
- **`captureTicks = 10` 是唯一被改动过的观感参数**（票 06 里也是 10），占领按“站上去累积、易主归零、
  敌方站上去冻结”结算；**没有**给“驻防强度”加额外规则，E 系列测的就是这条裸规则的平衡。
- **兵种出场格 = 基地格本身**：被任意单位（包括自己人）占住时 `spawnUnit` 挂起。
- **`ERR_BASE_BUSY` 语义**：同一产线已有订单时，重复下单被丢弃、不扣款、计入 `discardedIntents`。
  这是 4 份盲写脚本的实测大头（73360 次丢弃 / 33356 次有效下单），也逼出了“脚本必须自记生产队列”。
- **轮转冲突**按 `(tick + playerIndex) mod 4` 值大者胜。
- **采空的资源点**再 `harvest` 无效（`ERR_INVALID_TARGET`）。

以上都是 throwaway 桩的假设，**不能**当正式引擎规范；它们的作用是让 4 份脚本有同一套可比的结算。

## 局限

1. **不模拟运行时约束**：只捕获 `loop()` 异常并计 `exceptionTicks`；控制流/内存/预算/QuickJS-WASI
   限制一律不判（票 09 的 NFR 不在本轮范围）。
2. **地图只有两种拓扑**，且种子只改装饰墙（见上）。
3. **`matches.json` 约 26 MB**（每 10 tick 一帧的序列占绝大部分）。要精简就调 `playMatch({sampleEvery})`。
   事件流默认不落盘，需要时用 `replay.mjs --events` / `--curated`。
4. **探针不是好玩家**：`probes/farmer.js` 只会采集与占点（不造兵），`probes/raider.js` 只会冲农民
   （不抢点、不运营）。它们的存在意义是把机制从混战里单独拎出来，不是当基线对手。
5. **经济死亡后抢点续命的样本极少**（24/1408 席位），且全部来自 40 尺寸夹具的同一类残局。
6. 丢弃的桩代码若要复跑，只能靠本目录 + `../draft/rules.md`（草稿仍在 `.scratch`，未进 `docs/`）。
