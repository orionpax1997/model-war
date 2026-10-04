# rules-v1 API

> 脚本 API 的签名与语义;机制、结算顺序与确定性约束在 [`rules.md`](./rules.md),两份合起来是一份
> 自包含契约(hld §6.1)。
>
> 本文件里的四组表(API 表与错误码表、常量表、「丢弃 vs 异常」对照表、数值常量表)是**生成物**:
> 它们由真源包与 `rulesets/v1.json` 渲染,改表不改这份文档——手改表会被生成物漂移检查判红。
> 其余各节的正文分批落地,`TODO(→…)` 标着它的去处。

## 1. 脚本形态与座位自认

TODO(→ 脚本形态与座位自认)

## 2. 快照

TODO(→ 快照面与错误面)

## 3. API 表、错误码表与常量表

这一节三张表与第 5 节那一张表是生成物:名字、签名、触发条件逐字来自注入面符号表
(`packages/schema/src/script-surface.ts`),每个错误码落在「丢弃」还是「异常」来自后果行
(`packages/schema/src/script-outcome.ts`)。文档里没有第二份抄本。

<!-- generated:api-v1-api-surface:begin -->
> 本节三张表是**生成物**,勿手改:由 `packages/tools/src/generate/api-surface.ts` 从
> `packages/schema/src/script-surface.ts`(注入面符号表)与 `packages/schema/src/script-outcome.ts`(后果行)产出。
> 改真源后跑 `pnpm run generate`;手改会在下一次生成时被原样覆盖,并被生成物漂移检查
> (`check:drift`)判红。

**API 表**

**查询函数**——只读本 tick 的快照副本,不改引擎状态。

| 函数 | 签名 | 一句语义 |
| --- | --- | --- |
| `getTick` | `getTick(): number` | 当前 tick 号;脚本每 tick 都要读一次时间轴,读出来是个数值。 |
| `getObjectById` | `getObjectById(id: number): Unit \| Site \| Production \| null` | 按数值 id 取本 tick 快照里的那个对象;是取单个快照值的入口。 |
| `getObjectsByType` | `getObjectsByType(kind: 'unit' \| 'site', filter?: { owner?: -1\|0\|1\|2\|3; type?: UnitType; kind?: 'base' \| 'resource' }): (Unit \| Site)[]` | 按类型批量取快照对象(可带过滤);同一个快照值的批量入口。 |
| `getRange` | `getRange(ax: number, ay: number, bx: number, by: number): number` | 两点间 Chebyshev 距离;射程心算要读它算出来的那个数值。 |
| `getTerrainAt` | `getTerrainAt(x: number, y: number): 'plain' \| 'wall' \| 'out'` | 某格地形(`plain`/`wall`/`out`);绕墙寻路之前先读它。 |
| `findPath` | `findPath(sx: number, sy: number, tx: number, ty: number): { x: number; y: number }[] \| null` | 寻路路径是一串坐标点,读得到的就是值;它计入 API 调用预算,而预算值不归这张表。 |

**动作函数**——收集一条意图 + 参数界检查,不直写引擎。

| 函数 | 签名 | 一句语义 |
| --- | --- | --- |
| `move` | `move(unitId: number, dx: -1\|0\|1, dy: -1\|0\|1): void \| ErrResult` | 走一步(含对角),提交一条单位级意图。 |
| `moveTo` | `moveTo(unitId: number, x: number, y: number): void \| ErrResult` | 朝目标点走一步,提交一条单位级意图;路径由引擎沿 `findPath` 走。 |
| `attack` | `attack(unitId: number, targetId: number): void \| ErrResult` | 攻击敌方单位,提交一条单位级意图。 |
| `harvest` | `harvest(unitId: number, siteId: number): void \| ErrResult` | 在己方资源点采集,提交一条单位级意图。 |
| `transfer` | `transfer(unitId: number): void \| ErrResult` | 把携带量交给相邻己方基地,提交一条单位级意图。 |
| `spawnUnit` | `spawnUnit(baseId: number, unitType: UnitType): void \| ErrResult` | 在己方基地下单出兵,提交一条玩家级意图。 |

**座位自认**——脚本唯一的「我是几号」来源,不用于判断某个 id 是不是我的。

| 函数 | 签名 | 一句语义 |
| --- | --- | --- |
| `getMyIndex` | `getMyIndex(): 0\|1\|2\|3` | 座位自认的唯一正式入口;快照里没有 `you`/`isSelf` 标记,别靠单位位置反推座位。 |

**错误判别 helper**——把动作函数的返回值拆成可判的两步。

| 函数 | 签名 | 一句语义 |
| --- | --- | --- |
| `isError` | `isError(result: void \| ErrResult): boolean` | 「这次调用是不是错了」的布尔,显式判别的第一步;不要用 typeof 或真值去猜。 |
| `errCode` | `errCode(result: void \| ErrResult): ErrCode` | 取回那个错误码字符串,显式判别的第二步;读出来的正是一个 `ERR_*` 值。 |

**错误码表**——全表就下面这些,没有别的。每一行都标出它落在哪一类,而这两类的后果不同:
「丢弃」= 只丢这一条意图:本 tick 其余意图照常结算,不扣款、不计异常。「异常」= 本 tick 该方的**全部**意图置空(原地待命),这一 tick 白跑。
模型据此决定要不要兜。

| 错误码 | 一句触发条件 | 落在哪类 |
| --- | --- | --- |
| `ERR_NOT_ENOUGH_RESOURCES` | 下单资金不足;唯一在来源文档里被点名过的错误码。 | 丢弃 |
| `ERR_INVALID_UNIT` | 动作函数点名的单位 id 不存在。 | 丢弃 |
| `ERR_NOT_OWNER` | 点名的单位/基地不归本方;沙箱内即时返回,不用于自认座位。 | 丢弃 |
| `ERR_OUT_OF_RANGE` | 射程外。 | 丢弃 |
| `ERR_INVALID_TARGET` | 目标非法(如把基地当攻击目标)。 | 丢弃 |
| `ERR_INVALID_SITE` | 点位类型或归属不对(如把基地当资源点采集)。 | 丢弃 |
| `ERR_BAD_ARGS` | 参数越界(如 `move` 的 `dx`/`dy` 不是 -1/0/1)。 | 丢弃 |

**常量表**——本表只有错误码字符串这一半。类型名(`UnitType` / `IntentKind` / `ErrResult` /
`Snapshot` / `Intent`)归类型面,数值归「数值常量表」一节,两者都不进本表。

```ts
type ErrCode =
  | 'ERR_NOT_ENOUGH_RESOURCES'
  | 'ERR_INVALID_UNIT'
  | 'ERR_NOT_OWNER'
  | 'ERR_OUT_OF_RANGE'
  | 'ERR_INVALID_TARGET'
  | 'ERR_INVALID_SITE'
  | 'ERR_BAD_ARGS';
```

判一次调用错没错,只有上面那两个 helper 这一条路:`isError(result)` 判有没有出错,
`errCode(result)` 取回码字符串。**不要用 `typeof`、不要用真值去猜**——返回值是
`void | ErrResult` 的联合,猜它的形状等于替终稿写一份判定。

```ts
const result = move(unitId, 0, 1);
if (isError(result)) {
  // 这一条意图没生效:落在哪一类、丢的是什么,见「错误码表」与第 4 节那张对照表。
  const code = errCode(result); // 取回「错误码表」里的七个码之一
} else {
  // 这一条意图已提交;合法性终裁在结算时按同一套界检查做。
}
```

沙箱内即时返回的码只是**反馈**:合法性终裁在结算时按同一套界检查再做一遍,所以拿到一个码
也不等于这一步一定生效(同一 tick 里单位已经没了、目标已经死了,都可能让一条已提交的意图作废)。

<!-- generated:api-v1-api-surface:end -->

## 4. 丢弃 vs 异常

这一节那张表是生成物。**两类后果的机制与完整披露**(界检查为什么在沙箱内即时返回一次、越权调用的
完整清单、超预算三类分别怎么判)归 [`rules.md`](./rules.md) §8 的异常披露;这里只给模型判断
「要不要兜」所需的那一半:每一种没生效各丢什么。

<!-- generated:api-v1-outcome-table:begin -->
> 本表是**生成物**,勿手改:由 `packages/tools/src/generate/api-surface.ts` 从
> `packages/schema/src/script-outcome.ts`(后果行)与 `packages/schema/src/script-surface.ts`(错误码名)产出。
> 改真源后跑 `pnpm run generate`;手改会在下一次生成时被原样覆盖,并被生成物漂移检查
> (`check:drift`)判红。

**两类后果**

| 类 | 丢的是什么 | 累计 |
| --- | --- | --- |
| 丢弃 | 只丢这一条意图:本 tick 其余意图照常结算,不扣款、不计异常。 | 不计入 `exceptionTicks`。 |
| 异常 | 本 tick 该方的**全部**意图置空(原地待命),这一 tick 白跑。 | 给 `exceptionTicks` 加一;累计达 `exceptionTickLimit` 则判负出局(机制见 rules.md §8)。 |

**对照表**——每一种「没生效」各占一行。`相关错误码` 一栏是按名字从后果行投影的:
一个码恰好落在一行,所以上面错误码表里「落在哪类」那一栏与这里逐条一致,不会两处各写一份。

| 情形 | 落在哪类 | 这一行的后果 | 例子 | 相关错误码 |
| --- | --- | --- | --- | --- |
| 同一单位在一 tick 内提交了多条单位级意图:取最后一条,前面的静默作废。 | 丢弃 | 被覆盖的那些意图不留任何痕迹:不写事件流、不计异常、不扣款。 | 同一农民连调两次 `move`,只有最后一次生效——所以每单位每 tick 只写最终意图。 | — |
| 动作函数的界检查没过:点名的单位或基地不存在、不归本方、射程外、目标非法、点位类型不对、参数越界。 | 丢弃 | 沙箱内即时返回对应错误码,引擎在结算时按同一套界检查再裁一次;该条意图无效。 | `attack` 打基地、`harvest` 指基地、无攻击能力的单位调 `attack`。 | `ERR_INVALID_UNIT`、`ERR_NOT_OWNER`、`ERR_OUT_OF_RANGE`、`ERR_INVALID_TARGET`、`ERR_INVALID_SITE`、`ERR_BAD_ARGS` |
| `spawnUnit` 资金不足:这一单下单无效。 | 丢弃 | 不占产线队列、不扣款,资金一个不少地留着。 | 开局 16 资源买 12 的远程后剩 4,再买 8 的近战 → 第二单无效。 | `ERR_NOT_ENOUGH_RESOURCES` |
| `loop()` 抛异常:算力或 API 调用超预算、越权调用(调不存在的 API、调已删的宿主桥)、内存超限转成的异常、栈溢出。 | 异常 | 本 tick 该方全部意图置空;容器续用、跨 tick 记忆保留,下一 tick 从头再来。 | 死循环被截停;调了一个不存在的 `fly()`。 | — |
| tick 末存活堆占用 ≥ `memoryTickCeiling`。 | 异常 | 与 `loop()` 抛异常同后果:判据锚定读数,tick 内瞬时触顶后自行释放的分配不判。 | 本 tick 分配很大但当场释放,读数没超 → 不判罚。 | — |
| 引擎级故障(极罕见,脚本写不出也测不出)。 | 异常 | 除置空外还防御性重建该方容器:模块级记忆清零,异常计数由持久化值续算、不清零。 | 这一行的唯一用途是让脚本知道「记忆极 rare 会丢」,别的照常写。 | — |

一句话记法:写错参数最多丢一条,写崩 `loop()` 才丢整 tick;累计的判罚走 `exceptionTickLimit`
(取值见「数值常量表」),完整的异常披露在 [`rules.md`](./rules.md) §8。

<!-- generated:api-v1-outcome-table:end -->

## 5. 数值常量表

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

## 6. 最小 `loop()` 骨架

TODO(→ 脚本形态与座位自认)
