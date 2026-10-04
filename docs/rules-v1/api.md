# rules-v1 API

> 脚本 API 的签名与语义;机制、结算顺序与确定性约束在 [`rules.md`](./rules.md),两份合起来是一份
> 自包含契约(hld §6.1)。本版只有数值常量表一节已定稿,其余章节随 API 面回填补齐。

## 数值常量表

下面这张表与 [`rules.md`](./rules.md) §10 **逐字节相同**:两份由同一个生成函数产出,改取值时两处一起
变,不存在「一份新一份旧」的中间态。

<!-- generated:api-v1-value-table:begin -->
> 本表是**生成物**,勿手改:由 `packages/tools/src/generate/rules-value-table.ts` 从
> `rulesets/v1.json` 与 `packages/schema/src/ruleset-keys.ts`(键清单)产出。
> 改真源后跑 `pnpm run generate`;手改会在下一次生成时被原样覆盖,并被生成物漂移检查
> (`check:drift`)判红。

**参数取值**

| 键 | 值 | 量纲 | 说明 |
| --- | --- | --- | --- |
| `tickLimit` | 600 | tick | 对局上限(总 tick 数)。超时走终局名次结算,不由超时判负。 |
| `captureTicks` | 10 | tick | 占领一个点位所需的累积 tick。基地与资源点**统一单值**,不分类型(gdd《地图与点位》)。 |
| `initialResources` | 16 | resources | 开局资金。保证 tick 0 就能在「补经济」与「补兵」之间作选择;下界取 0(开局一无所有是自洽的)。 |
| `harvestRate` | 1 | resources/tick | 单个农民在一个有效采集 tick 里获得的资源量。 |
| `carryLimit` | 20 | resources | 单个农民可携带的资源上限;满载一次需 `⌈carryLimit ÷ harvestRate⌉` 个有效采集 tick。 |
| `resourcePerSite` | 200 | resources/site | 单个资源点的总储量。与 `tickLimit` 共同决定枯竭压力是否真实存在。 |
| `baseScore` | 4 | score | 每控制一个主基地的终局分。 |
| `resourceScore` | 1 | score | 每控制一个资源点的终局分。 |
| `unitCostDivisor` | 6 | divisor | 存活单位总造价分的除数:该项加分为 `⌊Σ 存活单位造价 ÷ unitCostDivisor⌋`(分)。 |
| `exceptionTickLimit` | 未定 | exceptions | 累计异常判负阈值(次/整局)。达它则该方判负出局,点位回归中立。 |
| `eventTickLimit` | 未定 | events/tick | 单 tick 的控制流事件计数上限(次/tick):以循环回边 / 函数调用 / 函数返回为一格累计。达顶则本 tick 该方 intents 全部丢弃并计一次异常。 |
| `apiCallTickLimit` | 未定 | calls/tick | 单 tick 的 API 调用计数上限(次/tick)。与控制流事件计数互为盲区:前者抓纯计算死循环,后者抓 API 轰炸。 |
| `memoryLimit` | 未定 | bytes | VM 线性内存的分配上限(bytes)。上限本身不可突破,超限转成可捕获的 JS 异常。 |
| `memoryTickCeiling` | 未定 | bytes | 内存判据的判罚线(bytes):每 tick 末 `runGC()` 后的存活堆读数达它即视同一次异常。软阈是它的 `MEMORY_SOFT_THRESHOLD_RATIO` 倍,是**纯展示项**、不入键清单。 |
| `wallClockSoftLimit` | 未定 | milliseconds | 单 tick `loop()` 的墙钟软限(ms)。**只观测**:写进回放与报告披露,不参与判罚。 |
| `wallClockHardTimeout` | 未定 | milliseconds | 墙钟硬超时(ms),**只作废该场**:标记 `nondeterministic-timeout` 后按重跑 / 剔除处理,不判负(墙钟受机器负载影响,参与判罚会破坏可复算性)。 |
| `scriptSizeLimit` | 未定 | bytes | 顶层脚本体积上限(bytes),封「直线代码不计量、大循环体放大每格工作量」的计数盲区。它是**规则集里的数值键**,与沙箱注入的 API 名表是两件事(hld §6.2 的「不进名单」说的是后者)。 |

**兵种属性**

| 兵种 | 造价 | 生命 | 伤害 | 射程 | 速度 | 生产耗时 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `worker` | 4 | 2 | 0 | 1 | 1 | 2 | 农民:无攻击能力,全图最脆弱的高价值目标。 |
| `melee` | 8 | 12 | 3 | 1 | 1 | 4 | 近战:性价比标杆。 |
| `ranged` | 12 | 4 | 2 | 2 | 1 | 6 | 远程:阵地输出,贴身即溃。 |
| `cavalry` | 16 | 6 | 2 | 1 | 2 | 8 | 骑兵:价值全部来自速度。 |

生产耗时一列按 `⌈造价 × SPAWN_TICKS_COEFFICIENT⌉` **现算**,不是抄进表的第二份取值。

**派生量(入表,不入键清单)**

| 派生量 | 公式 | 值 |
| --- | --- | --- |
| 内存软阈 | `MEMORY_SOFT_THRESHOLD_RATIO × memoryTickCeiling` | 未定 |
| 单基地满产烧钱率 | `FULL_PRODUCTION_COST_RATE` | 2 |
<!-- generated:api-v1-value-table:end -->

「未定」的含义、「内存软阈为什么进表不进键清单」与「生产耗时为什么是算出来的」三处分工写在
[`rules.md`](./rules.md) §10 的表后说明里,不在此复述。

## 尚未落定的章节

| 节 | 内容 | 去处 |
| --- | --- | --- |
| 脚本形态与座位自认 | 单一入口函数、脚本源码形态、座位自认入口 | 随 API 面回填 |
| 快照 | 快照字段与「对象身份不跨 tick」 | 随 API 面回填 |
| 「丢弃 vs 异常」与错误码表 | 每个错误码的名字与一句触发条件,以及它落在哪一类 | 随 API 面回填 |
| API 表与常量表 | 签名 + 一句语义;类型名不进生成表 | 随 API 面回填 |