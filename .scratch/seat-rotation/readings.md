# 座位偏置读数（I 首轮赛季 seat-reduce + 登记表活表）

本文件是**读数**，设计真源仍是 `docs/gdd.md` §3.3 / `docs/hld.md` §8.1 / §12 #3
与 `.scratch/seat-rotation/map.md`。决策只写进各票的 `## Answer`，本文件不下 verdict。

> 状态：首行已落（2026-10-09，I 首轮重跑 60 局，真模型脚本 = 补充观察口径）。

## 0. 本次读数来源

| 项 | 值 |
| --- | --- |
| 赛季配置 | `season.yaml`（与 10-09 首轮同：`masterSeed 2026-m4` / v1 / 5 模型 / 3 图 / K=4 / 并发 8） |
| 存档 | `archive/<slug>/2026-10-09T01-09-09-599Z`（5 条，与首轮同一批冻结，无 API 调用） |
| 命令 | `node apps/cli/dist/modelwar.mjs run --config season.yaml` |
| 退出码 | 0；计入 60 局，剔除 0 局 |
| 赛季 `runId` | `2026-10-09T12-40-11-464Z`（`runs/<runId>/report.json` 43.1 KB；`runs/**` 按 gitignore 不入库） |
| 原始 log | `.scratch/seat-rotation/run-20261009T204011.log`（整轮 stdout+stderr） |
| reduce 命令 | `node .scratch/seat-rotation/prototype/seat-reduce.mjs runs/2026-10-09T12-40-11-464Z/report.json` |
| reduce log | `.scratch/seat-rotation/reduce-20261009T204011.log` |
| 探针脚本 | `.scratch/seat-rotation/prototype/`（throwaway，见该目录 README） |

为什么重跑：首轮（10-09，`runId 2026-10-09T01-53-05-717Z`）的 `report.json` 随 `runs/**`
被 gitignore 排除、未保留；存档与配置都在，故按同一配置重跑一轮取数。对局阶段零 API，
只花约 75 s 本机沙箱时间，计入 map 成本预算（≤100 局）。

## 1. 主表：四座位胜率 / 均分 / Wilson 95% 区间

胜 = `rankings[seat] === 1`（并列 1 时并列各席各计 1 胜；本轮并列只出现在
`c3-corridor-split-s2` 的第 2 名，不影响胜列）。均分 = `perMatchScores` 均值。

| 座位 | n | 胜 | 胜率 | Wilson 95% | 对局均分 |
| --- | --- | --- | --- | --- | --- |
| 0 | 60 | 35 | 58.3% | [45.7%, 69.9%] | 2.22 |
| 1 | 60 | 27 | 45.0% | [33.1%, 57.5%] | 1.75 |
| 2 | 60 | 15 | 25.0% | [15.8%, 37.2%] | 1.05 |
| 3 | 60 | 4 | 6.7% | [2.6%, 15.9%] | 0.98 |

- 最大落差 = 58.3% − 6.7% = **51.7% → 红（>15%）**。
- Wilson 下限 <20% 的座位：2（15.8%）、3（2.6%）→ 按“样本不够”口径亦命中。
- **建议：触发补矩阵**（红档 + 两个座位 Wilson 下限 <20%，两条触发线都中）。
- 第二独立路径对数：抽查 4 局（含 `c3-corridor-split-s2`）的 `replay.jsonl`
  （meta 行 `players[].seat/archiveRef` + 末行 `result.rankings`）与 `report.json`
  条目逐席一致，4/4 通过（见 reduce log 末行）。

## 2. 登记表（座位 / 样本量 / 偏置读数 / 判据）

首行 = I 首轮重跑（真模型补充观察）。“偏置读数”取该座位胜率（附 Wilson 下限）；
“判据”列只记录本行按预锁线落在哪一档，**不是 verdict**。

| 座位 | 样本量 | 偏置读数 | 判据 |
| --- | --- | --- | --- |
| 0 | 60（真模型 5 选 4 × 轮换，补充观察） | 胜率 58.3%，Wilson 下限 45.7%，均分 2.22 | 红（最大落差 51.7% >15%） |
| 1 | 60（同上） | 胜率 45.0%，Wilson 下限 33.1%，均分 1.75 | 红（同上） |
| 2 | 60（同上） | 胜率 25.0%，Wilson 下限 15.8%（<20% 样本不够线），均分 1.05 | 红 + 样本不够 |
| 3 | 60（同上） | 胜率 6.7%，Wilson 下限 2.6%（<20% 样本不够线），均分 0.98 | 红 + 样本不够 |

## 3. 口径声明（必读的三行）

1. **本行是补充观察，不进判据**：map 口径铁律——判据只吃基准脚本
   （cell-a / cell-b / cell-c 两两对打，cell-a vs cell-b 优先；同脚本对称局只作校准基线）；
   真模型脚本只作补充观察。红档在此只构成“触发补测（基准小矩阵）”的理由，
   不构成“摊不平走回流”的直接证据；回流判定等票 04 的基准矩阵 + 票 03 的判据文本。
2. **落差不能用“强模型总坐某座位”解释**：轮换已验证均衡——每（座位 × 模型）格恰 12 局
   （5 模型 × 4 座位 × 12 = 240 席 = 60 局 × 4 席）；且席内模式一致：
   除 `deepseek-v4.1-flash` 较平外，其余四条都是 seat0/1 高、seat3 垫底
   （如 muse 8/10/7/1、mimo 9/3/0/0、gpt 6/8/0/0）。座位效应真实存在，唯其归因
   （先手 / 轮转优先 / 地图不对称）须由基准矩阵分解，本探针不拆。
3. **基准脚本引用带硬规则行**：契约内容一变更（含不升版的散文修订），三份基准脚本一律重跑、
   不保留旧读数（`benchmarks/README.md` §3）。票 04 的补矩阵若引用 cell-a / cell-b，
   须确认其产物仍是当前终稿契约下的那份（`pnpm run check:bench` 逐字节门禁作证）。

## 4. 附带观测（不进主表，留指针）

1. **`c3-corridor-split-s2` 本次未崩**：同一种子（2936867027）、同一四席，
   首轮 `engine-crash`（退出码 2，重跑仍触发、剔除出排名），本次正常完赛
   （`reason timeout`，rankings [2,2,1,4]）。同一种子同脚本两次跑出不同结局，
   与 e2e-readings §4 的“确定性复现”陈述矛盾（疑与并发/内存布局相关）；
   根因归沙箱侧票 `.scratch/sandbox-executor/issues/12-quickjs-gc-assertion-crash.md`，
   本探针不展开。
2. **校验失败名单 0 条**：票 12 的口径修复（只列未参赛 slug）生效，首轮读数 §7 的
   “8 条陈旧记录进名单”问题在本轮无触发项。
3. **排名与首轮同序、数值略差**：muse 106 / deepseek-v4.1 68.5 / deepseek-v4-flash 67 /
   mimo 65 / gpt 6-luna 53.5（首轮 muse 99.50 等；差额主因是本轮 c3 局计入而非剔除）。
   排名仅供展示，不作统计推断（report.md v0 口径）。

## 5. 补矩阵读数（票 04，2026-10-09，基准脚本，真沙箱 16 局）

本节是票「灰区补矩阵」的读数，设计真源与口径声明仍是 `§3`（判据只吃基准脚本；
本节即基准读数，可进判据；verdict 归票 05，本节不下）。

### 5.0 本次读数来源

| 项 | 值 |
| --- | --- |
| 矩阵 | H 异质 12 局：基序列 [A,A,B,B]（A=`cell-a-melee-pressure`，B=`cell-b-expansion-economy`）× 3 图 × 4 轮换（shift 0..3 左旋，与 `enumerate.ts` 的 `rotateSeats` 同构）；S 对称校准 4 局：AAAA / BBBB × open-clash / corridor-split（fortress-core 为省预算只由 H 覆盖，如实记一笔） |
| 图序 / 种子 | 图序与 `season.yaml` 同（corridor-split, fortress-core, open-clash，下标即 mapIndex）；种子与调度器同一派生 `H(masterSeed, comboId, mapIndex, seedIndex)`，`masterSeed seat-rotation-topup-v1`（与赛季 `2026-m4` 不同源，独立样本），combo `t1`（H）/ `t1-calib`（S） |
| 存档执行体 | `benchmarks/` 入库产物；跑前 `check:bench` 全绿（A/B/C 逐字节一致，名字未声明 0/0/0），契约 v1 未变，本批是当前终稿契约下的读数（§3 第 3 条） |
| 命令 | `node apps/cli/dist/modelwar.mjs match runs/seat-rotation-topup/<id>/input.json --root .` × 16 |
| 退出码 | 16/16 为 0；计入 16 局，剔除 0 局；累计真沙箱 60 + 16 = **76 ≤ 100**（map 成本预算） |
| 原始 log | `.scratch/seat-rotation/run-topup-20261009T125958.log`（16 局 stdout+stderr）；判据 `.scratch/seat-rotation/judge-topup-20261009T125958.log` |
| 物料脚本 | `.scratch/seat-rotation/topup/`（throwaway，见该目录 README；`manifest.json` 随物料落在 `runs/seat-rotation-topup/`，git 忽略未入库） |
| 第二独立路径 | `replay.jsonl` 首行 meta（`players[].seat/archiveRef`）与手写 `input.json`（`archives[]` 顺序）逐席核对，**16/16 通过**（judge 内自动核对，不一致即红；比票 01 的 4 局抽查更严，因本批是手写物料） |
| 异常轨 | 16 局 `exception` 事件 0、`exceptionTicks` 非零 0；终局原因 shortcut / timeout / victory；corridor-split 本批 5 局（H 4 + S 1）全部正常完赛 |

正交性：H 每座位恰坐 A 6 局、B 6 局（3 图 × 2 shift），脚本–座位正交，落差可直接读座位效应。

### 5.1 H 异质主表：四座位胜率 / Wilson 95% 区间 / 均领土分

胜 = `rankings[seat] === 1`（并列 1 各计 1 胜；本批并列只出现在 `h-fortress-core-s2` / `h-open-clash-s2` 的四方并列 1 与 `h-corridor-split-s3` 的两席并列 3，不影响胜列）。均领土分 = 末行 `territoryScores` 均值——**与 §1 的 `perMatchScores` 均值不是同一口径，不可互比**。

| 座位 | n | 胜 | 胜率 | Wilson 95% | 均领土分 |
| --- | --- | --- | --- | --- | --- |
| 0 | 12 | 9 | 75.0% | [46.8%, 91.1%] | 32.50 |
| 1 | 12 | 4 | 33.3% | [13.8%, 60.9%] | 12.33 |
| 2 | 12 | 3 | 25.0% | [8.9%, 53.2%] | 6.25 |
| 3 | 12 | 2 | 16.7% | [4.7%, 44.8%] | 2.17 |

- 最大落差 = 75.0% − 16.7% = **58.3% → 红（>15%）**。
- 逐局明细见 judge log 首节（12 行 `rankings` / `reason` / `territory`）。

### 5.2 H 分解：座位 × 脚本（每格 n=6）与脚本总战绩

| 座位 | × A（n=6） | × B（n=6） |
| --- | --- | --- |
| 0 | 6 胜 | 3 胜 |
| 1 | 2 胜 | 2 胜 |
| 2 | 3 胜 | 0 胜 |
| 3 | 2 胜 | 0 胜 |

- 脚本总战绩（12 局，坐席获胜席次，并列可超）：A **13** vs B **5**——A 强于 B。
- 席内座序一致：A 格 6/2/3/2，B 格 3/2/0/0——seat0 最好、seat3 最差在两脚本内各自成立；B 在 seat2/3 零胜。
- seat0×A 6/6 全胜，但 AAAA 对称局 seat0 0/2（§5.3）——hetero 的 seat0 优势是**脚本 × 座位交互**，不是 harness 把 seat0 写死（n 小，此为观察非 verdict，交票 05）。

### 5.3 S 对称校准：按座位（pooled n=4）与按脚本

| 座位 | 胜 / 4 | Wilson 95% |
| --- | --- | --- |
| 0 | 0 | [0.0%, 49.0%] |
| 1 | 1 | [4.6%, 69.9%] |
| 2 | 2 | [15.0%, 85.0%] |
| 3 | 1 | [4.6%, 69.9%] |

- AAAA 2 局：open-clash seat3 胜（timeout），corridor-split seat1 胜（shortcut）——胜席不同，无单席锁定。
- BBBB 2 局：同为 `[2,2,1,2]` timeout、seat2 胜、`territory` 同为 `[8,8,12,8]`。两份回放中段 tick 已验证不同（行 113–145 相异，图 hash 与种子亦不同），是收敛到同一终局均衡，非文件混淆；记附带观测。
- 前置闸状态（票 03 判据的前置条件）：胜席分散于 1/2/3，未见 harness 单席锁定的硬证据；但 n=4 下 Wilson 半宽 ±30pp 量级，**拉平与否判不动**——交票 05 裁决，本节不替它下。

### 5.4 登记表回填（基准行，与 §2 真模型行不混）

§2 四行是真模型补充观察（不进判据），本节八行是基准读数（可进判据）；两批估量不同，不可相加，
故分表存放。判据列只记录本行按票 03 判据文本落在哪一档，**不是 verdict**。

| 座位 | 样本量 | 偏置读数 | 判据 |
| --- | --- | --- | --- |
| 0 | 12（基准 AABB 异质，A 6 + B 6） | 胜率 75.0%，Wilson 下限 46.8%，均领土分 32.50 | 红（最大落差 58.3% >15%） |
| 1 | 12（同上） | 胜率 33.3%，Wilson 下限 13.8%，均领土分 12.33 | 红（同上） |
| 2 | 12（同上） | 胜率 25.0%，Wilson 下限 8.9%，均领土分 6.25 | 红（同上） |
| 3 | 12（同上） | 胜率 16.7%，Wilson 下限 4.7%，均领土分 2.17 | 红（同上） |
| 0 | 4（对称校准 AAAA 2 + BBBB 2） | 胜 0/4，Wilson [0.0%, 49.0%] | 校准基线，不定档 |
| 1 | 4（同上） | 胜 1/4，Wilson [4.6%, 69.9%] | 校准基线，不定档 |
| 2 | 4（同上） | 胜 2/4，Wilson [15.0%, 85.0%] | 校准基线，不定档 |
| 3 | 4（同上） | 胜 1/4，Wilson [4.6%, 69.9%] | 校准基线，不定档 |
