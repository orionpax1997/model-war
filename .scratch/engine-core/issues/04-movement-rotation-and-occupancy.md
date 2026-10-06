# 04: 移动——轮转优先与占位基准

**What to build:** 两条移动意图(`move` 与 `moveTo`)在真引擎上按规则裁决,不再只是设计文档里的一段规范。裁决的核心是两条:一轮移动结算**只以该轮开始时的占位为准**,多方争同一格时按轮转优先级取胜者、其余原地不动。

**这一票同时接住一件欠 gdd 的账。** `first-contact` 事件的精确定义(任意敌对单位 Chebyshev 距离 ≤ 2、全局第一次一条)现在只存在于一次性标定环的桩数据里,`gdd.md:123` 只有定性的半句「首触判据吃的是接近度」。本票按该口径实现,**在代码注释里注明读数出处**,欠账记在 gdd 那一侧(补正文是 gdd 那一格的事,本 feature 只实现并留指针)。

**首触阈值是观测量,不是规则参数,所以规则集保持 21 键是对的。** 它不判胜负、不判合法、不影响移动,只被用来给事件流标一个时刻;判据是「凡观测量不进参数表」,与真源包那个「键数是 21 不是 22」的裁决同源,不是它的反例。这条理由要写进注释,否则后来者会按「一切数值都该进规则集」把它加成第 22 键。

决策依据：`.scratch/engine-core/spec.md`《结算管线》《事件流》两节,`docs/gdd.md` §3.3 公平性、`hld` §4.4。

**Blocked by:** 02（脊柱）, 03（脚本 API 的类型面回填）

**Status:** resolved

- [x] `move` 与 `moveTo` 两条意图各有 `check()` 与 `run()`。`check()` 的入参**只读**（只读视图 + 意图）,类型里没有写入口;`run()` 拿唯一写入口 → `packages/engine/src/processor/movement.ts:88`(`checkMove`)/`:129`(`runMove`),视图 `:40`。落子唯一出口仍是 `apply()`(`driver/apply.ts`)
- [x] **占位基准**:一轮结算只以该轮开始时的占位为准。单位离开本轮所在的格子,不会使该格在本轮对后来者变为可进入;同一格至多一个单位成功进入 → `movement.ts:78`(`isOccupied` 以 `view.units` 为准),步 2 先算全轮候选再落子(`steps/step2-movement.ts:130-154`)。用例「交换」「链式」「链式移不动」「友军」「同格竞争」
- [x] **同格竞争**按轮转优先级 `(tick + playerIndex) mod 4` 取胜者,其余**原地不动** → `steps/step2-movement.ts:63`(`priorityOf`)/`:71`(`winnersOf`,值大者胜)。用例「同格竞争:…换一个 tick 胜者轮转」
- [x] **交换/穿行**与**链式移动**按占位基准判定,不需要链式裁决 → `movement.ts:120`(`candidateInto`);用例「交换」「链式(A→B 同时 B→C)」「链式移不动:C 也被占时 B 同样失败」
- [x] 己方单位之间同样按此裁决(无友军穿越) → 同一条 `isOccupied`(不分属主);用例「己方单位同样互相挡路」
- [x] `moveTo` 等价于本 tick 的一步 `move`,参与同一套裁决;路径不跨 tick 缓存 → `movement.ts:150-157` 每轮现调 `findPath`;用例「moveTo 每 tick 只走一步,且每 tick 重算路径」
- [x] 寻路:八邻域固定方向表(`pathfinding/find-path.ts:56`),平手按线性下标破(`find-path.ts:96`),启发式整数 Chebyshev×2(`:39` `STEP=2`、`:47` `HEURISTIC_SCALE=2`)。禁浮点门禁 30 文件 0 违规 → 证据见 `## Answer`
- [x] 寻路调用量**计入脚本 API 调用预算** → 本票只交付「账」:`context.ts:48` / `index.ts:66` 的 `pathfindingCalls`,按座位计数;用例「寻路调用量按座位记账」「骑兵的 moveTo 两轮都算」「moveTo 不可达 A* 照记」
- [x] `first-contact` 事件:任意敌对单位切比雪夫距离 ≤ 2 时,**全局**记一条 → `steps/step2-movement.ts:54`(`FIRST_CONTACT_CHEBYSHEV`)、`:100-118`(选取主体)、`:158-165`(整局一条,记忆进状态);用例三条
- [x] 事件进**第二步**的槽位,并按「步内按对象数值 id 升序」定序 → 收集器 `events.ts` 的 `STEP_OF` 已把 `first-contact` 挂步 2;主体按单位数值 id 升序取(`step2-movement.ts:111`)
- [x] **参数在界、属主正确、目标格合法**的判据在 `check()` 里,无效意图丢弃;丢弃不触发异常判罚 → `movement.ts:88-118`;步 1 过滤(`steps/step1-validate.ts:22-31`)。用例「未实现的四条意图静默丢弃」「参数不在界/属主不对」「目标格是墙」
- [x] 每条判据各有一个能被弄红的反例 → 实测读数见 `## Answer`(轮转优先常量、占位基准改成空、启发式×4、引入 `Math.sqrt`/`1.5`);票面第三条反例「启发式改成普通切比雪夫→浮点门禁红」**不成立**,已在 Answer 记录

## Answer

### 交付物(改动文件)

新增:`packages/engine/src/pathfinding/find-path.ts`、`pathfinding/index.ts`、`processor/movement.ts`、`processor/movement.test.ts`、`pathfinding/find-path.test.ts`。
修改:`world/state.ts`(地形/尺寸/首触记忆进状态与快照)、`world/initial-state.ts`(地形转换落库)、`driver/apply.ts`(登记 `mark-first-contact`)、`snapshot/snapshot.ts`(快照显式加 `size`/`terrain`)、`run-match.ts`(接上 `fillVariantWalls`)、`processor/intents.ts`(带座位的 `IssuedIntent`/`groupIssuedIntents`)、`processor/context.ts`、`processor/index.ts`(`intents` 型改带座位、加 `pathfindingCalls`)、`processor/steps/step1-validate.ts`、`processor/steps/step2-movement.ts`。
夹具同步(机械):`processor/step-order.test.ts`、`snapshot/read-only-isolation.test.ts`、`snapshot/traversal-independence.test.ts`(节点数 12→18)、`replay-writer/tick-line.test.ts`、`runner/stub.test.ts` 各补 `size`/`terrain`/`firstContactTick`。

### 裁法一:地形住在 `GameState`(hld §4.4 的前置缺口)

- `GameState` 增 `size: number` 与 `terrain`。地形取 **`readonly (readonly boolean[])[]`,`, true=墙**（`world/state.ts:36`）：引擎唯一会问的问题是「(x,y) 是不是墙」,布尔格让读取退化成一次下标,不把地图的书写格式带进状态读取路径；转换只在 `createInitialState` 那一次(`world/initial-state.ts:41` `toTerrain`)。
- 快照也加 `size`/`terrain`(`snapshot/snapshot.ts:50-51`),**逐字写在 `Snapshot` 里而不是 `Pick`**(`world/state.ts:168-173`)——地形进快照是为了 `getTerrainAt`,不是因为「顺手多带一路板面」。
- **tick 行不写地形、`stateHash` 也不算它**:`replay-writer/tick-line.ts` 的 `tickPayload` 仍是逐字列出 `{type,tick,players,units,sites,events}`,与 `nextId`/`outcome` 同一理由(地形由 meta 行的 `mapHash`+`seed` 唯一确定,每 tick 重写 600 遍是纯浪费)。`terrain` 字段注释里写了这句,免得后来者以为漏了。
- 开局链路接上 `fillVariantWalls`(`run-match.ts:142`):这一步**此前缺失**(函数写好但无人调,地形与种子对不上、`getTerrainAt` 无源)。种子消费顺序不动(`fillVariantWalls` 自持)。
- `apply()` **不新增改地形的变更**:地形一局不变,`createInitialState` 造初始字面量时直接写。

### 裁法二:骑兵二次移动(票面清单之外的补入项)

**这是票面清单之外的补入项**,依据是 `rules.md` §3 与 gdd C5(骑兵速度 = 2 × 其他兵种、其余为 1),理由是**移动机制归本票而 12 张票无人认领**。实现:移动轮数 = 全场最大 `speed`(`movement.ts:169` `maxMoveRounds`),每轮跑同一套裁决;**第 N 轮的基准是第 N−1 轮结算之后的状态**,`tick` 值两轮相同(取 `state.tick`,步 6 才加一)。用例「骑兵一 tick 走两格,其余兵种一 tick 一格」钉住。

### 裁法三:`first-contact` 的跨 tick 记忆

- 收集器每 tick 新建,「全局一条」需要一个跨 tick 的家 → 进 `GameState`:`firstContactTick: number | null`(`world/state.ts:153`)。**选「时刻」而非布尔**:叙事时间线要标的是时刻,`null` 与数字的区分同时承担「有没有发生过」;它**不进快照**(与 `nextId`/`outcome` 同列)。写入走 `apply()` 新登记的 `Change`(`driver/apply.ts:69`/`:118`)。
- 事件主体 `subjectId` = 按单位数值 id 升序遍历,取**第一个**存在敌对单位与之 Chebyshev ≤ 2 的单位(`step2-movement.ts:111`),与「步内按对象数值 id 升序」同源。
- 判定时点:**移动结算之后**(`step2-movement.ts:158`),记的是「真的碰上了」的位置。
- 出处:`first-contact` 阈值的原文在 `.scratch/rules-landing/blind/fixture-check/tables-1336-rerun-2026-10-04.md:51`(注释 `step2-movement.ts:48-54` 逐字注明)。**欠账在 gdd 那一侧**(补正文是 gdd 那一格的事)。
- **阈值不进规则集**:它是观测量(只给事件流标一个时刻,不判胜负/合法/移动),判据是「凡观测量不进参数表」——所以 `rulesets/v1.json` 保持 21 键是对的,它不是「21 不是 22」那个裁决的反例。这句理由写进了注释。

### 裁法四:`check()`/`run()` 两相位(票面 §5 的收口)

- 「一轮只以该轮开始时的占位为准」使逐 intent 就地写状态不可能,故分两相位:`check()` 只读地判「参数在界/属主正确/目标格合法」;`run()` 在只读基准上算一个候选变更,落子唯一出口仍是 `apply()`。
- **偏差**:`check()` 不收规则集(任务书说收)。三条判据一条都不用到规则集取值,收进来是一个不读的栏;`run()` 才需要它(骑兵轮数由 `speed` 决定)。已在 `movement.ts:86-90` 注释说明。
- **偏差**:`runMove` 的签名是 `(view, seat, ruleset, round, intent)`——比任务书的 `run(baseline, ruleset, intent)` 多了 `seat`(属主与轮转优先都要它)与 `round`(骑兵第几轮)。返回值仍是「候选变更或 `null`」。
- **同座位多单位争同一格**:票面说「序列全序、无平局」只对跨座位成立;同一座位的两个单位优先值相同(同 tick 同座位)。补的裁决是「按意图确定序取先者」,而意图序是 `(seat, 单位 id)` 升序(`winnersOf` 的严格 `>` 保持先到者,`step2-movement.ts:71-84`),即**低 id 胜**。
- **四条未实现的 intent 静默丢弃**:`attack`/`harvest`/`transfer`/`spawnUnit` 的 `check()` 归 05–09,本票丢弃;`step1-validate.ts` 注释写明这是「尚未实现」而不是「非法」。**文档不一致**:hld §4.2 说无效 intent「写入当 tick 事件流(调试可观测)」,而 hld §7.5 的八种事件里没有「意图无效」这一类、收集器也无对应方法——本票按后者办(静默丢弃),**不自行加第九种事件**(那改跨进程形状)。已记进 `step1-validate.ts` 头注。
- 停滞:`TickContext.intents`/`TickResult.intents` 型由 `Intent[]` 改为带座位的 `IssuedIntent[]`(`processor/intents.ts:83`),否则步 2 拿不到 `playerIndex`。保留 `groupIntents`(丢座位的投影)以免改动 02 的 `intents.test.ts`。

### 裁法五:寻路细节(`pathfinding/`)

- 纯模块(吃地形+尺寸+起点+终点),**同一实现**将给沙箱 `findPath` 复用(hld §4.7),`find-path.ts` 头注写明。
- 八邻域固定方向表 `as const`,注释「表的顺序是确定性的一部分,改序即改结果」。
- 平手:`f` 相同按格子**线性下标** `y*size+x` 升序(`find-path.ts:96`)。票面说的「平手按 id 破」是宽泛说法——格子没有对象 id,本仓对应它的确定序就是线性下标。
- 全整数:直走斜走同为 `STEP=2`,启发式 `2*Chebyshev`。**斜走只看目标格**(`find-path.ts:76-82`):两墙夹角的对角格**可通行**(不防割角)——v1 CostMatrix 无此条,显式定死并配用例「斜走只看目标格」。

### 裁法六:寻路调用量只账不罚(hld §4.7 / §5.3)

engine 不实现预算判罚(判据锚定 host 侧可测量量)。本票交付**账**:步 2 每次 A* 调用自增按座位计数器(`step2-movement.ts:138-147`),挂到 `TickResult.pathfindingCalls`(`index.ts:66`)。将来 `QuickJsRunner` 落地时把它并进 `apiCallTickLimit` 的记账。反向钉:`move` +0(用例「寻路调用量按座位记账」)。调用量恰好等于 `findPath` 的调用:步 2 只在 `check` 放行且 `speed > round` 时计一笔,与 `runMove` 里 `findPath` 的调用点一致。

### 实测反例读数(改一行→跑一次→红;已全部还原)

| 改动 | 命令 | 读数 |
|---|---|---|
| 轮转优先改成常量 `0` | `vitest --project unit movement.test.ts` | `1 failed \| 15 passed`,同格竞争用例红:`expected 1 to be +0`(常量让座位 0 先到者胜) |
| 占位基准改成「空」(等价于单位离开即释放,即结算后占位) | 同上 | `4 failed \| 12 passed`,交换/链式/链式移不动/友军四条红:`expected 1 to be +0` |
| 启发式倍率 `HEURISTIC_SCALE` 2→4(可采纳性失效) | `vitest --project unit find-path.test.ts` | `1 failed \| 6 passed`,「绕墙走最短路」红:`expected [Array(8)] to have a length of 7 but got 8`,返回 `(2,6)(1,5)(0,4)(0,3)(1,2)(1,1)(2,0)(3,0)` |
| `HEURISTIC_SCALE` 2→1(普通切比雪夫;票面说这里门禁会红) | `check:no-float` + 同 pathfinding 用例 | 门禁 **exit 0「检查 30 个文件,无违规」**;用例 **7 passed**——**票面这条反例的表述不成立**,它没引入浮点、也未破坏可采纳性 |
| `HEURISTIC_SCALE = Math.sqrt(4)` | `check:no-float` | **exit 1**:`find-path.ts:47:25 math-member \`Math.sqrt\` 不是允许名单内的 \`Math\` 成员`,1 处违规 |
| `STEP = 1.5` | `check:no-float` | **exit 1**:`find-path.ts:39:14 float-literal \`1.5\` …`,1 处违规 |
| 还原后复核 | `check:no-float` | exit 0,30 文件 0 违规 |

### 门禁与用例数字

- `pnpm run check` → **exit 0**(check:types 含 fmt/lint/coupling/no-float/lint:types;unit+property;check:deps「90 modules, 157 dependencies,no violations」;check:declared-deps;check:drift「无漂移」;check:bench 三份绿)。
- `pnpm vitest run --project unit --project property` → **exit 0,Test Files 50 passed(50),Tests 548 passed(548)**。
- `check:no-float` → 30 文件 0 违规。
- 本票两条新用例文件单跑:movement 16 + find-path 7 = **23 passed**。

### 留给后续票的话

- 05–09 补 `attack`/`harvest`/`transfer`/`spawnUnit` 的 `check()`/`run()` 时,接手的是 `step1-validate.ts` 的过滤点(现已就位,只放行移动两条)与 `IssuedIntent` 的座位栏。
- 预算层落地时把 `TickResult.pathfindingCalls`(按座位)并进 `apiCallTickLimit` 的记账——本层只记账不判罚。
- 沙箱 `findPath` 脚本 API 应 import `pathfinding/index.ts` 的**同一实现**(hld §4.7),不要另写一份,否则脚本查询结果与引擎实际移动会分叉。
- gdd 那一侧欠的正文:首触判据(Chebyshev ≤ 2、整局一条)的精确定义,出处见本票 `## Answer`。
- `Snapshot` 已显式加 `size`/`terrain`;后来者给状态加栏若想让脚本可见,须在 `Snapshot` 里**显式**再写一次(不是 `Pick`)。


### 复查修复:变体抽签落在低位,全仓种子只产得出两张地图(主线程复查抓到)

**缺陷**:`driver/random.ts` 的 `nextBelow` 原来是 `drawn.value % bound`。`bound = 2` 时这取的是 LCG 状态的**最低位**,而模 `2^31` 的 LCG(`a = 1103515245`、`c = 12345`,两者都是奇数)最低位每步必然翻转:

```
bit0(state_{n+1}) = bit0(a·state_n + c) = bit0(state_n) XOR 1
```

于是每次抽签恒为 `01010101` 或它的补,**与种子的取值无关,只与种子的奇偶有关**。本模块头注里本来就写着「取模是位移:LCG 的高位周期最长,低位在低阶模数下会短得多」——代码与它自己写的理由相反。这个退化就是这样活过 02a 那一票的:抽签确实在动、地图确实在变,只是变化的维度只有一比特。

**实测:修之前(8 个种子 × `maps/open-clash.json` 的 8 条槽位)**

| 种子 | 地形 sha256 前 12 位 | 前 8 次槽位抽签 |
|---|---|---|
| 20260101 | `9f8be379eecc` | `01010101` |
| 20260102 | `2f3cae1386bb` | `10101010` |
| 1 | `9f8be379eecc` | `01010101` |
| 2 | `2f3cae1386bb` | `10101010` |
| 7 | `9f8be379eecc` | `01010101` |
| 8 | `2f3cae1386bb` | `10101010` |
| 99 | `9f8be379eecc` | `01010101` |
| 100 | `2f3cae1386bb` | `10101010` |

去重后 **2 张地形**。哈希算法:`sha256(terrain.join("\n")).slice(0, 12)`(主线程复查时用的是另一种拼接,哈希值互不可比;可比的是「抽签列」与「不同地形数」两项)。

**修法**:抽签改取高位——`(drawn.value >>> LCG_DRAW_SHIFT) % bound`,`LCG_DRAW_SHIFT = 16`(`nextInt` 的值域是 `[0, 2^31)`,右移 16 位留下最高的 15 位;位 k 的周期是 `2^(k+1)`,只有高位承载得住「种子取值 → 不同图」)。理由与反例写进了 `driver/random.ts` 的 `LCG_DRAW_SHIFT` 注释,头注里那句「取模是位移」也挪到了真正取模的地方(`nextBelow`),两者不再互相矛盾。

**影响面**:改了「种子 → 地形」的映射,所以**任何**依赖「某种子下地形长什么样」的读数都作废(包括上面那张表的右半列)。但 tick 行的 `stateHash` 不算地形(地形不进 tick 行,由 meta 行的 `mapHash` + `seed` 唯一确定),所以回放哈希与空转对局的读数**不受影响**——`run-match.test.ts` 那几条逐行相同的断言在修前修后都绿。

**第二个缺陷:本模块此前零测试**。`packages/engine/src` 里没有任何一个测试文件碰过 `driver/random.ts`(`createRandom` / `nextInt` / `nextBelow` / `fillVariantWalls` 四个符号一个都没被断言过),上述退化才得以存活。本次新增 `packages/engine/src/driver/random.test.ts`(9 条):

| 用例钉住的事 | 为什么 |
|---|---|
| 同种子两次填充逐字节相同,中间插入别的种子不影响 | 确定性是复算(NFR-1)的前提 |
| 填充不改写入参地图、填出来的是新对象 | 纯函数:复算不能有隐藏可变状态 |
| **同奇偶两种子地形与抽签序列都不同**(分别取 `1/3`、`2/4`、`20260101/20260103`) | 本次 bug 的**反例**载体 |
| **8 个种子至少 3 张不同地形** | 同上;反例可红 |
| 同一种子下重排 `map.variantSlots` 换一张图 | 消费顺序 = 槽位声明顺序(hld §4.6),不是实现自由度 |
| `nextBelow` 恒返回 `[0, bound)` 内整数、`bound = 1` 恒为 0、每次只消费一次 `nextInt` | 值域与「不多走状态」 |
| 一条槽位四条坐标全填或全不填;落在墙格 / 地图外的坐标不抛、不越界写、不造新格 | 写入面:四重对称与「只覆盖平原格」 |

**实测反例读数**(真跑:把实现改回 `drawn.value % bound`)

| 命令 | 读数 |
|---|---|
| `pnpm vitest run --project unit random.test.ts` | **exit 1,2 failed \| 7 passed**。①「同奇偶种子不同图」红:`expected [ +0, 1, +0, 1, +0, 1, +0, 1 ] to not deeply equal [ +0, 1, +0, 1, +0, 1, +0, 1 ]`;②「8 种子至少 3 张图」红:`expected 2 to be greater than or equal to 3` |
| 还原成取高位后复核 | exit 0,**9 passed** |

**实测:修之后(同一算法、同一批种子)**

| 种子 | 地形 sha256 前 12 位 | 前 8 次槽位抽签 |
|---|---|---|
| 20260101 | `5bbd30b258b2` | `01000001` |
| 20260102 | `604d35914822` | `01100101` |
| 1 | `fae7e7f5b9a8` | `00111101` |
| 2 | `2144f9b1d828` | `01101101` |
| 7 | `d85f988a8658` | `00001100` |
| 8 | `adfa105c2995` | `00010110` |
| 99 | `bcd3d607f63d` | `01001101` |
| 100 | `ec09f8c6f928` | `00100110` |

去重后 **8 张地形**(修之前 2 张)。同奇偶抽查:`1` ↔ `3` = `fae7e7f5b9a8` ↔ `506b93b878cf`、`2` ↔ `4` = `2144f9b1d828` ↔ `6be680613bfe`、`20260101` ↔ `20260103` = `5bbd30b258b2` ↔ `7c9248af7e89`,均不同。

**门禁数字(修后)**:`pnpm run check` → **exit 0**;`pnpm vitest run --project unit --project property` → **exit 0,Test Files 51 passed(51),Tests 557 passed(557)**(修前 50 / 548,本票新增 1 文件 9 用例);`check:no-float` → 30 文件 0 违规;`check:deps` → 92 modules, 164 dependencies,无违规。

**改动文件**:`packages/engine/src/driver/random.ts`(缺陷修复 + 注释对齐)、新增 `packages/engine/src/driver/random.test.ts`。`docs/**` 未动。
