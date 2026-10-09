# 灰区补矩阵(task)

Type: task
Status: resolved
Blocked by: 03

## Question

仅当票「摊平阈值与判据文本拍板」锁定的触发线命中（灰区 10–15%，或样本不够）时执行：补 12–16 局小矩阵（单组合 × 3 图 × 4 轮换，异质两两对打 cell-a vs cell-b 优先 + 同脚本对称校准），读数回填登记表；若触发线未命中，本票直接 resolve 为「无需补测」并写一行结论，不花预算。

## Context

- 为解锁决策而做的活，不是交付：真沙箱多局走最便宜的 harness（`packages/tools/src/limits/run-limits-gate.ts`，`--matches=N` 可调；注意它默认四席同脚本无轮换，要改造或绕过 `enumerateMatchUps` 手写 `input.json` 的 `archives` 排序来控座位）。
- CLI 约束：`modelwar match <input.json> [--root <仓库根>]` 不能指定 seat；「A 恒坐 seat 0」类对照要自己排 `archives` 数组。
- 成本上限：含本票在内真沙箱累计 ≤100 局；`c3-corridor-split-s2` 若再崩按 hld §8.4 重跑后剔除，样本量预留。
- 读数落 `.scratch/seat-rotation/readings.md`（续写，附原始 log）。

## Done when

- [x] 触发则补测读数回填登记表；未触发则一行「无需补测」结论
- [x] `Status: resolved` + `## Answer` 回写（含 log 指针）

## Answer

### 触发确认：命中，执行补测（非「无需补测」）

两条触发线全中（[摊平阈值与判据文本拍板](03-flattening-criterion.md) 的判据文本 + [首轮探针](01-seat-reduce-probe.md) 读数 `../readings.md` §1–§2）：首轮重跑最大落差 51.7% 落红档（>15%）；seat2/3 Wilson 下限 15.8% / 2.6% 跌破 20% 样本不够线。故执行补矩阵，不走「无需补测」分支。

### 矩阵规格（16 局，累计真沙箱 76 ≤ 100）

- H 异质 12 局：基序列 [A,A,B,B]（A=`cell-a-melee-pressure`，B=`cell-b-expansion-economy`，cell-a vs cell-b 优先）× 3 图（与 `season.yaml` 同序）× 4 轮换（shift 0..3 左旋，与 `enumerate.ts` 同构）；种子 `H(seat-rotation-topup-v1, t1, …)`，与赛季不同源、独立样本。每座位恰坐 A 6 局、B 6 局，脚本–座位正交。
- S 对称校准 4 局：AAAA / BBBB × open-clash / corridor-split（fortress-core 为省预算只由 H 覆盖，已如实记录）。
- 跑前 `check:bench` 全绿（契约 v1 未变）；16/16 退出码 0，剔除 0 局；异常轨全零（`exception` 事件 0、`exceptionTicks` 非零 0）。
- 物料与判据脚本：`.scratch/seat-rotation/topup/`（throwaway，见该目录 README）。
- 原始 log：`.scratch/seat-rotation/run-topup-20261009T125958.log`；判据 log：`.scratch/seat-rotation/judge-topup-20261009T125958.log`；读数 `../readings.md` §5（§5.4 为登记表回填的基准八行，与 §2 真模型行分表、不混）。
- 第二独立路径：meta ↔ input 逐席核对 16/16 通过。

### 读数 gist（verdict 归票 05，本票只给读数）

- H 落差 **58.3%（75.0% − 16.7%）→ 红**：seat0 9/12 [46.8%,91.1%] / seat1 4/12 / seat2 3/12 / seat3 2/12（均领土分 32.50 / 12.33 / 6.25 / 2.17，口径与 §1 不可互比）。
- 分解：A 强于 B（坐席获胜 13 vs 5 席次）；席内座序一致（A 格 6/2/3/2，B 格 3/2/0/0，seat0 最好、seat3 最差各自成立；B 在 seat2/3 零胜）。seat0×A 6/6 全胜而 AAAA 对称局 seat0 0/2——hetero 的 seat0 优势是脚本 × 座位交互，非 harness 写死（n 小，观察非 verdict）。
- S 校准：胜席分散于 1/2/3，未见 harness 单席锁定；但 n=4 下 Wilson 半宽 ±30pp 量级，拉平与否判不动——前置闸无硬证据触发「harness 自身有偏」，亦未证拉平，交票 05 裁决。
- 附带：BBBB 两图收敛到同一终局（`[2,2,1,2]` timeout，territory 同 `[8,8,12,8]`；中段 tick 已验证不同，非文件混淆）。

### 复核（implement 技能 code-review 项，本票内自检；全图双轴收口归票 05）

- Standards：未碰 `apps/`/`packages/` 与四份设计文档，无单家规则冲突；`verify:fast` 全绿（94 文件 / 1003 通过）；`check:bench` 前置绿；`.scratch` throwaway 口径与票 01 一致；提交信息无 `Co-Authored-By`。
- Spec：Done-when 两项全落（§5 + §5.4 八行回填 + 本 Answer 含 log 指针）；矩阵 16 局落在「12–16」内，单组合 × 3 图 × 4 轮换、cell-a vs cell-b 优先、同脚本对称校准三要件齐；预算 76 ≤ 100。已知偏离一处已披露：S 校准只覆 2 图（fortress-core 为省预算略去）。
- 数字复核：judge 输出经独立 `python3` 重算（读 replay 末行 + manifest），座位胜 [9,4,3,2]、A/B 席次 13/5、合计 18（12 + 两个四方并列各添 3），与 judge 一致；Wilson 抽算 seat0-H（[46.8%,91.1%]）、seat3-H（[4.7%,44.8%]）、seat0-S（[0.0%,49.0%]）与上报一致。
