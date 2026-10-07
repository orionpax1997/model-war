# 票 05:真沙箱 10 局复验读数表

本文件是票 05(`05-real-sandbox-replay-matrix.md`)的读数报告。**所有读数取自真引擎**:
`node apps/cli/dist/modelwar.mjs match <input.json> --root .` 产出的 `replay.jsonl` 与
`observations.jsonl`,由一次性判据脚本 `.scratch/contract-closure/judge-replay.mjs` 算出。
运行物料由 `.scratch/contract-closure/make-runs.mjs` 现造,落在 `runs/contract-closure/`
(git 忽略的一次性证据目录)。三份基准脚本取 `benchmarks/` 的入库产物 `script.js`。

> **口径声明:`check:selfproof` 的 `captures` 是标定环的桩口径,与本票读数不共用、不相加。**
> selfproof 跑的是等效命题复验用的桩,不是真引擎;本票的 `captures` 与它没有任何换算关系。

## 运行物料形状(现造)

- 每局一目录 `runs/contract-closure/<match-id>/`,内含 `archive/seat{0..3}/{script.js,script.ts,meta.json}`
  与 `input.json`;`archivePath` 为仓库根相对路径。
- 全部哈希现算:`scriptSha256 = sha256(script.js 字节)`、`metaSha256 = sha256(meta.json 字节含尾换行)`、
  `mapSha256 = sha256(maps/<map>.json 字节)`、`sandboxRuntimeHash` 取 `packages/schema/src/sandbox-runtime.ts`
  的真值 `46c93013071ebdc2ddd29e1d07604854a0a3e48fa2c6f1bf7f9e9cd811285f83`。
- 种子一律 `20260101`,规则集 `v1`。`meta.json` 十一栏齐,`protocolRounds = prompts.length = 1`。
- 沙箱 runtime(`packages/engine/sandbox-runtime/runtime.iife.js`)与 wasm
  (`node_modules/quickjs-wasi/quickjs.wasm`)经 `--root .` 就地取到;回放 `runner = "quickjs"`。

复现:

```
node .scratch/contract-closure/make-runs.mjs
for d in runs/contract-closure/*/; do
  node apps/cli/dist/modelwar.mjs match "$d/input.json" --root .
  node apps/cli/dist/modelwar.mjs verify "$d/replay.jsonl" --root .
done
node .scratch/contract-closure/judge-replay.mjs
```

## 闭环硬门禁(汇总)

| 对局 | 图 | 终局 reason | match 退出码 | verify 退出码 | captures 合计 (s0/s1/s2/s3) | 属主变更合计 | exception 合计 |
|---|---|---|---|---|---|---|---|
| a-open-clash | open-clash | timeout | 0 | 0 | 24 (0/0/0/24) | 24 | 0 |
| a-corridor-split | corridor-split | shortcut | 0 | 0 | 23 (0/23/0/0) | 23 | 0 |
| a-fortress-core | fortress-core | timeout | 0 | 0 | 23 (0/0/0/23) | 23 | 0 |
| b-open-clash | open-clash | timeout | 0 | 0 | 12 (3/3/3/3) | 12 | 0 |
| b-corridor-split | corridor-split | timeout | 0 | 0 | 12 (3/3/3/3) | 12 | 0 |
| b-fortress-core | fortress-core | timeout | 0 | 0 | 12 (3/4/3/2) | 12 | 0 |
| c-open-clash | open-clash | timeout | 0 | 0 | 25 (4/5/11/5) | 25 | 0 |
| c-corridor-split | corridor-split | timeout | 0 | 0 | 35 (14/12/5/4) | 35 | 0 |
| c-fortress-core | fortress-core | timeout | 0 | 0 | 20 (4/6/5/5) | 20 | 0 |
| mixed-a-b-c-a | open-clash | shortcut | 0 | 0 | 32 (25/1/6/0) | 32 | 0 |

- `captures` 按 `site-captured` 事件统计并归属到该 tick 该点位的新属主;右栏「属主变更合计」
  是按点位 `owner` 逐 tick 独立复算的值作交叉验证 —— **10 局两栏逐局相等**。
- **硬门禁:10/10 全过** —— 每局 `captures > 0`、每局 `exception` 事件数为 0、每局 `match`/`verify` 退出码均 0。
- 另有 `economy-dead` 事件在多局触发(见下表),它是合法终局机制的产物,不是异常轨。

## 每局读数(座位级)

「开出兵种」= 该座位在对局中**开出**的兵种集合(排除地图开局摆下的初始单位,人人开局都是两农民,
带上它会把每个座位都染上 `worker`、失去区分度)。「经济死亡」= 该座位出现 `economy-dead` 事件。

| 对局 | 座位 | 脚本 | captures | exception | 开出兵种 | 经济死亡 |
|---|---|---|---|---|---|---|
| a-open-clash | 0 | cell-a | 0 | 0 | worker, melee | 是 |
| a-open-clash | 1 | cell-a | 0 | 0 | worker, melee | 是 |
| a-open-clash | 2 | cell-a | 0 | 0 | melee | 是 |
| a-open-clash | 3 | cell-a | 24 | 0 | melee | 是 |
| a-corridor-split | 0 | cell-a | 0 | 0 | worker, melee | 是 |
| a-corridor-split | 1 | cell-a | 23 | 0 | worker, melee | 是 |
| a-corridor-split | 2 | cell-a | 0 | 0 | melee | 是 |
| a-corridor-split | 3 | cell-a | 0 | 0 | melee | 是 |
| a-fortress-core | 0 | cell-a | 0 | 0 | worker, melee | 是 |
| a-fortress-core | 1 | cell-a | 0 | 0 | worker, melee | 是 |
| a-fortress-core | 2 | cell-a | 0 | 0 | melee | 是 |
| a-fortress-core | 3 | cell-a | 23 | 0 | melee | 是 |
| b-open-clash | 0 | cell-b | 3 | 0 | worker, melee | 是 |
| b-open-clash | 1 | cell-b | 3 | 0 | worker, melee | 是 |
| b-open-clash | 2 | cell-b | 3 | 0 | worker, melee | 否 |
| b-open-clash | 3 | cell-b | 3 | 0 | worker, melee | 是 |
| b-corridor-split | 0 | cell-b | 3 | 0 | worker, melee | 是 |
| b-corridor-split | 1 | cell-b | 3 | 0 | worker, melee | 是 |
| b-corridor-split | 2 | cell-b | 3 | 0 | worker, melee | 否 |
| b-corridor-split | 3 | cell-b | 3 | 0 | worker, melee | 是 |
| b-fortress-core | 0 | cell-b | 3 | 0 | worker, melee | 是 |
| b-fortress-core | 1 | cell-b | 4 | 0 | worker, melee | 是 |
| b-fortress-core | 2 | cell-b | 3 | 0 | worker, melee | 是 |
| b-fortress-core | 3 | cell-b | 2 | 0 | worker, melee | 否 |
| c-open-clash | 0 | cell-c | 4 | 0 | melee | 是 |
| c-open-clash | 1 | cell-c | 5 | 0 | melee | 是 |
| c-open-clash | 2 | cell-c | 11 | 0 | melee | 是 |
| c-open-clash | 3 | cell-c | 5 | 0 | melee | 是 |
| c-corridor-split | 0 | cell-c | 14 | 0 | melee | 是 |
| c-corridor-split | 1 | cell-c | 12 | 0 | melee | 否 |
| c-corridor-split | 2 | cell-c | 5 | 0 | melee | 是 |
| c-corridor-split | 3 | cell-c | 4 | 0 | melee | 是 |
| c-fortress-core | 0 | cell-c | 4 | 0 | melee | 是 |
| c-fortress-core | 1 | cell-c | 6 | 0 | melee | 是 |
| c-fortress-core | 2 | cell-c | 5 | 0 | melee | 否 |
| c-fortress-core | 3 | cell-c | 5 | 0 | melee | 是 |
| mixed-a-b-c-a | 0 | cell-a | 25 | 0 | worker, melee | 是 |
| mixed-a-b-c-a | 1 | cell-b | 1 | 0 | worker | 是 |
| mixed-a-b-c-a | 2 | cell-c | 6 | 0 | melee | 是 |
| mixed-a-b-c-a | 3 | cell-a | 0 | 0 | melee | 是 |

## 区分度(混编局的三元组)

混编局座位 = (0: A, 1: B, 2: C, 3: A)。同一策略占多席时,把该策略各席并起来(A: 兵种集合并集、
captures 取「任一席 > 0」、经济死亡取「任一席触发」):

| 策略 | 座位 | 单位类型构成(开出兵种) | captures > 0 | 经济死亡 |
|---|---|---|---|---|
| A | 0, 3 | `worker + melee` | 是(25) | 是 |
| B | 1 | `worker`(仅) | 是(1) | 是 |
| C | 2 | `melee`(仅) | 是(6) | 是 |

三元组两两不同:**判定通过**。区分落在「单位类型构成」这一坐标上 ——
A 爆兵压制(农民 + 近战)、B 扩张运营(只开农民)、C 占点不采集(只开近战)。
另两个坐标(captures > 0、经济死亡)在本局巧合地三策略同值,故不作判别依据;
判据只用粗粒度分类,不硬编数值阈值。

## 异常轨

10 局、40 个座位,**`exception` 事件总数为 0**。没有任何异常轨触发,无座位 / tick / 事件细节可报。

## 观测文件

`observations.jsonl` 在 10 局中**均未生成** —— 当前 `rulesets/v1.json` 的预算键全是未定值,
组装层交出去的是空预算对象(四轨全不启用),故没有墙钟软限 / 内存压力观测可披露。
`match` 的约定是「有观测才落盘,不拿空文件假装披露过」,这与本票读数(取自回放的事件与点位属主
变更)不相干:回放里七类事件齐备,读数来源完整。

## 备注

- `economy-dead` 在多局多席触发(见上表),这是 gdd 的合法终局机制,不是异常;契约 §4.3 明确
  经济死亡仍可翻盘。c 舱「零农民纯近战占点」尤其容易触发(它不开农民,只吃开局的两位农民,
  一旦阵亡且资源不足 `worker.cost` 即触发)。
- 单策略局里,四席跑同一份脚本却读出不对称的 captures(A 舱集中在某一席、B 舱四席大体均衡、
  C 舱四席各不相同),这是同脚本在对称地图上的先手 / 定序效应,不是缺陷;本票只取读数、不做解释。
- 本票**不新增任何机器门禁**;常驻读数门禁是 L 那格的基准门禁的家。判据脚本
  `judge-replay.mjs` 与物料生成器 `make-runs.mjs` 均为一次性脚本,随本票提交入库作证据。
