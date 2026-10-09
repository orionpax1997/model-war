# 首轮60局seat-reduce探针(prototype)

Type: prototype
Status: resolved

## Question

对 I 的首轮赛季 60 局做 seat reduce，回答三个问题：各座位胜率/均分是多少（附 Wilson 95% 区间）、落差落在预锁线的哪一档（绿 <10% / 灰 10–15% / 红 >15%）、要不要触发补矩阵（灰区，或任一座位 Wilson 下限仍 <20% 即样本不够）？

## Context

- 证据源零成本：`report.json` 的 `matches[]` 已有 `seats[4]` / `rankings[4]` / `perMatchScores[4]`（`packages/runner/src/reporter.ts`），一行 reduce 即可；读数位置与崩溃剔除见 `.scratch/season-scheduler/e2e-readings.md`（`c3-corridor-split-s2` 按 hld §8.4 重跑后剔除，`excludedFromRanking: true`）。
- 第二条独立路径（对数用）：`replay.jsonl` 的 meta 行 `players[].seat` + 末行 `result.rankings`。
- 探针是 throwaway：一次性脚本放 `.scratch/seat-rotation/prototype/`，README 声明 throwaway；读数落 `.scratch/seat-rotation/readings.md` 并附原始 log（照 K/L 先例）。
- 基准脚本三舱见 `benchmarks/README.md`（引用须带硬规则行：契约内容一变更三份一律重跑、不保留旧读数）。

## Done when

- [x] `readings.md` 有四座位胜率/均分 + Wilson 95% 区间 + 落差定档（绿/灰/红）+ 补不补矩阵的明确建议
- [x] 登记表（座位 / 样本量 / 偏置读数 / 判据四列）填出首行，空表变活表
- [x] `Status: resolved` + `## Answer` 回写（含原始 log 指针）

## Answer

- **读数**：I 首轮按同一配置重跑（`runId 2026-10-09T12-40-11-464Z`，60/60 计入、剔除 0；首轮 report.json 随 `runs/**` 未保留，重跑取数约 75 s，零 API）。四座位胜率 seat0 58.3% [45.7%,69.9%] / seat1 45.0% [33.1%,57.5%] / seat2 25.0% [15.8%,37.2%] / seat3 6.7% [2.6%,15.9%]；均分 2.22 / 1.75 / 1.05 / 0.98。最大落差 **51.7% → 红（>15%）**；seat2/3 Wilson 下限 <20%（样本不够线亦中）。详见 `.scratch/seat-rotation/readings.md` §1–§2。
- **建议：触发补矩阵**（红档 + 两席 Wilson 下限 <20%，两条触发线都中；交票 04 按基准脚本 cell-a vs cell-b 执行，契约变更重跑硬规则见 readings §3 第 3 条）。
- **口径**：本读数是真模型补充观察，不进判据（map 铁律：判据只吃基准脚本）；轮换已验证均衡（每座位 × 模型恰 12 局），落差非排席不均所致，但归因待基准矩阵分解。
- **附带**：`c3-corridor-split-s2` 同一种子本次未崩（timeout 完赛），与“确定性复现”陈述矛盾，指针已留 readings §4，归沙箱票 12。
- **原始 log**：整轮 `.scratch/seat-rotation/run-20261009T204011.log`；reduce `.scratch/seat-rotation/reduce-20261009T204011.log`；探针脚本 `.scratch/seat-rotation/prototype/`（throwaway）。第二独立路径（replay.jsonl 抽查 4 局）4/4 一致。
