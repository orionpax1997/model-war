# 07: 采集与交付——无被动收入

**What to build:** `harvest` 与 `transfer` 两条意图落地,把「经济」这件事变成一条**只能靠自己走**的链:没有被动收入,不开采就没有资源,没有资源就下不了单。资源点储量有限、采空后该点位仍计入胜利条件——这两条让经济死亡成为一条**不可逆**的分界线。

**经济死亡不设状态字段。** 它的形式定义是「玩家无任何农民单位且资源不足以购买农民」,那是两个谓词的与,任何人拿那一行的玩家资源与单位列表一眼能算;而 `alive` 之所以配得上字段,是因为它的判定链复杂(无单位且无基地 → 判定顺序 → 点位回归中立),重推要重跑整条评估步。加上经济死亡**不可逆**(无农民就没有采集产出,抢点不产生被动收入),**事件一次即全部信息**。

代价写在这里:**回放里经济死亡的时点只能从 `economy-dead` 事件读**,不能从某个字段反查。事件也**每局只发一次**,不发成每 tick 重发——叙事战报生成器只消费事件,几百条同义事件要靠它自己去判首次,那是本仓已经吃过亏的形态。

**交付目标唯一确定**:单位同时相邻多个己方基地时,交付给**数值 id 最小**的那个。规则侧那一节是这件事的家,与移动那条「数值升序是唯一被声明的定序语义」同源。

决策依据：`.scratch/engine-core/spec.md`《事件流:两个「不设字段」的裁法》,`docs/gdd.md` §5 经济与生产。

**Blocked by:** 06（生产——每基地一条队列）

**Status:** resolved

- [x] 采集要**满携带即停**;携带量随单位走,交付时才入池 → `processor/economy.ts` 的 `checkHarvest`(判据 6)+ `harvestChangeOf`(取量封顶);`economy.test.ts`「采集」「满携带即停…」三条用例
- [x] **中立资源点须先占领才有开采权**——这一条要有一处真的判红:未占领就采集 → 无效 → `nearestFriendlyResourceSite` 判 `owner === seat`;`economy.test.ts`「中立 / 敌方资源点无开采权」用例(反例去掉该判据 → carrying 变 1)
- [x] 资源点**有限储量**,采空后该点位**仍计入胜利条件**（地图的点位总数不因采空而减少）→ `apply.ts` 的 `harvest` 只减 `remaining`、不删点位;`economy.test.ts`「采空不删点位:全点位胜利条件…」用例
- [x] 交付把携带量**清零**入玩家资源池 → `apply.ts` 的 `transfer` 一次落「carrying 清零 + resources 加携带量」;`economy.test.ts`「交付:carrying 清零入玩家池」用例
- [x] 交付目标:相邻的己方基地,多个时取**数值 id 最小**的那个。用例钉住「不是取座位序号最小的那个」——两口径在只有一个基地时无法区分,必须造出两个基地的构造 → `nearestFriendlyBaseSite`(升序遍历取第一个己方基地);`economy.test.ts`「交付目标…两个相邻己方基地」+「交付目标**不是**『属主座位号最小』」两条用例
- [x] **无被动收入**:没有农民就没有任何自动入账。用例钉住「站着不动资源不会涨」→ 采集只在 `harvest` 意图落地时发生;`economy.test.ts`「无被动收入:农民贴着己方矿区站着不动…」用例(三 tick 资源恒 16)
- [x] 经济死亡的形式判定:无任何农民单位**且**资源不足以购买农民。两条各一个用例（只有一条不成立时不进死亡）→ `isEconomyDead` 纯函数;`economy.test.ts`「经济死亡判据的两个谓词缺一不可」用例(各一条)
- [x] `economy-dead` 事件**首次成立时发一次**,全事件流里恰好一条;重复成立不再发 → 闩 `GameState.economyDeadAtTick`;`economy.test.ts`「…闩让每局每席至多一条」用例(反例去掉闩 → 第二 tick 再发)
- [x] 事件进**第四步**的槽位,按对象数值 id 升序定序 → `events.ts` 的 `STEP_OF` 已挂步 4(未改);判定按座位 0..3 升序;`economy.test.ts`「同一 tick 多个玩家同时经济死亡:事件按座位号升序」用例
- [x] **状态模型里没有经济死亡字段**,且有一条反向用例钉住它不会被「顺手加上」（加了就红）→ `economy.test.ts` 三条反向用例:`Player` 键集恰好四栏、`Snapshot` 无 `economy*` 栏、判据不读闩栏
- [x] 无效意图按骨架那张票的纪律**丢弃、不计异常** → 无效 harvest/transfer 在 `check`/`run` 返回 `false`/`null`,没有变更被造出来、不发事件、不计异常;`economy.test.ts` 多条用例断言 `events` 为空
- [x] 每条判据各有一个能被弄红的反例：把交付目标改成取座位序号 → 双基地用例红;把经济死亡事件改成每 tick 发 → 恰好一条用例红;允许未占领开采 → 开采权用例红 → 三条实测读数记在 `## Answer`(另加一条自选反例:去掉 `carryLimit` 封顶 → 满携带用例红)

## Answer

### 落地的文件

源码:
- 新增 `packages/engine/src/processor/economy.ts`——经济机器的家。
- `packages/engine/src/driver/apply.ts`——登记 `harvest` / `transfer` / `mark-economy-dead` 三条写操作(唯一写入口)。
- `packages/engine/src/world/state.ts`——加 `GameState.economyDeadAtTick`(不进 `Snapshot`)。
- `packages/engine/src/world/initial-state.ts`——开局初始化四个 `null`。
- `packages/engine/src/processor/steps/step4-object-tick.ts`——接上 b) 采集 / c) 交付,段末做经济死亡判定,并改对「`economy-dead` 归票 09」那句假话(现为「判据归票 07」)。
- `packages/engine/src/processor/steps/step1-validate.ts`——`harvest` / `transfer` 加进放行名单。

测试:
- 新增 `packages/engine/src/processor/economy.test.ts`(25 条)。
- 给 `GameState` 夹具补 `economyDeadAtTick` 的现有测试:`production.test.ts`、`movement.test.ts`、`combat.test.ts`、`capture.test.ts`、`step-order.test.ts`、`outcome.test.ts`、`snapshot/traversal-independence.test.ts`、`snapshot/read-only-isolation.test.ts`、`replay-writer/tick-line.test.ts`。
- `production.test.ts`「资金不足」夹具由「资金 3 + 下 worker」改成「资金 4 + 下 melee」:前者会同时满足「无农民且钱不够」,步 4 会多一条 `economy-dead`,而那一条用例要断言的是「这条 `spawnUnit` 没发事件」。

### §4.1 采集

- **判据**(`checkHarvest`,六条):单位存在 / 属主正确 / 有采集能力 / 相邻处有己方资源点(`kind === "resource"`、`owner === seat`、在射程内)/ 该矿 `remaining > 0` / `carrying < carryLimit`。
- **采集能力判据 = 类型名是 `worker`**。规则集**没有**「能不能采集」这一栏(`harvestRate` 是**速率**不是**资格**),所以这是一处**契约面缺口**:兵种名→能力的映射当前只能由代码承载(先例:`ruleset-loader` 的 `statsOf`)。补这一栏归契约面那一轮(见「留给票 12」)。没有含糊:注释里写清了缺口本身。
- **「相邻」= 切比雪夫 ≤ `statsOf(worker).range`**(现取值 1),与 `step3-combat.ts` 的 `distance <= range` 同源。选择 **≤ 1(含站在矿格/基地格上那一格)而不是「恰好 1」**:一个兵种只有一个「射程」概念,移动/战斗/采集/交付四处共用一份实现,规则集把 `range` 调大时四处一起变。用例「站在矿格上也能采」钉住这一格。
- **落子一条变更**:`harvest` 同时加 `carrying`、减 `remaining`(与 `start-production` 的「占队列 + 扣款」同理,不留半截状态)。
- **取量封顶** `min(harvestRate, carryLimit - carrying, remaining)`。第三项是有限储量的硬上限;第二项把「满携带即停」实现成**封顶**(这一 tick 取到满为止,不是「满了就一点不取」)。注意 `harvestRate = 1` 时第二项恒不生效(判据 6 已保证 `carrying < carryLimit`),所以有一条用 `harvestRate = 5` 的规则集变体让这一项真的绑住。
- **多个相邻己方矿取数值 id 最小者**:规则侧没写多矿选择,本仓「数值升序是唯一被声明的定序语义」是其唯一依据(与交付目标同一口径)。`view.sites` 由不变量保证升序,取第一个合格者即 id 最小。
- **`intent.siteId` 不参与目标选择**(四处口径统一为引擎决定)。gdd §5 的采集是「站在矿相邻格即开采」,没有「指定矿点」这一步;若让 `siteId` 参与,「取 id 最小」就没有一处能钉住,且同一段脚本在不同相邻构型下会得到两种语义。用例把意图的 `siteId` 点名到 id 更大的矿,断言引擎仍采 id 最小的。字段本身保留(契约面冻结的意图形状)。

### §4.2 交付

- **判据**(`checkTransfer`,四条):单位存在 / 属主正确 / `carrying > 0` / 相邻处有己方基地。不单列「类型是农民」:`carrying` 恒 0 的非农民在判据 3 就被挡掉,多判一次类型会把「携带量属于哪个兵种」变成第二个家。
- **目标 = 相邻己方基地里数值 id 最小者**,`view.sites` 升序取第一个,口径同采集。
- **`carrying === 0` 直接判假**:不产生变更、不发事件、不计异常(静默丢弃)。交付空口袋不是规则事件。
- **落子一条变更**:`transfer` 同时把 `carrying` 清零、把携带量加进玩家池。资源进的是**全局共享池**(不按基地分池),所以 `apply()` **不读**变更带的 `siteId`——它只是记录下来的事实(先例:`advance-capture.previousOwner`),让「交付给哪个基地」可审计、让「取 id 最小」有一处可被断言。
- **为什么测试必须造出两个基地**:交付资源反正进同一个玩家池,「交付给哪个基地」对**最终状态不可观察**;能观察它的只有变更单上的 `siteId`。所以「两个相邻己方基地」的用例直接调 `transferChangeOf` 断言 `siteId`。又因为两个己方基地同一个属主,「数值 id 最小」与「属主座位号最小」在**同属主**下不可区分——所以另加一条:座位 1 的农民同时贴敌方座位 0 的基地与自己的基地,断言仍交给**自己**的那座(反例走「不判敌我、取属主座位号最小」时本条红)。两条合起来才把口径钉死。

### §4.3 段内与段间定序

- 步 4 顺序:a) 占领 → b) 采集 → c) 交付 → d) 生产 → 经济死亡判定。每段内 `context.intents` 已按 `(seat, 单位数值 id)` 升序。
- **b/c 可换序且等价**:两条都是**单位级**意图,步 1 的分组保证「每单位每 tick 至多一条」,一个单位不可能同 tick 既采又交;b 只作用于「提交采集的单位的 `carrying` + 对应矿的 `remaining`」,c 只作用于「提交交付的单位的 `carrying` + 该单位的玩家池」,两个载体集合不相交,且 c 不读任何矿的 `remaining`。所以不是「顺序无关」,是作用在不相交载体上。
- **c 必须在 d 之前(不可换)**:用例「交付(c)在生产(d)之前」——座位 0 资金 8、两基地各下 melee(单价 8)、农民带货 8。c 先落 → 资金 16 → d) 两单都成(资金 0);若 d 先 → 第一单扣到 0,第二单资金不足被丢弃。这条顺序有真实读数差异,不是排版。

### §4.4 经济死亡:与票面字面措辞的差别(显式记下)

**票面字面**:「状态模型里没有经济死亡字段。」

**本实现**:加了一栏 `GameState.economyDeadAtTick: readonly (number | null)[]`(下标座位,`null` = 没发过),**不进 `Snapshot`**。

**为什么这不是违反票面**:票面真正要防的是「玩家的经济状态被存成第二个家」——即 `Player.economicallyDead` 这类布尔:它会是「无农民且钱不够」这个**可算事实**的第二份表示,而且会**撒谎**(玩家可能靠基地易主的全额退款重新有钱,布尔却停在 `true`)。而「`economy-dead` 这条**事件**发过没有」是**另一件事**——它不可从状态重算(收集团每 tick 新建),回放也必须能复现「这是第一次」,这与票 04 的 `firstContactTick`(「整局一条」首触的 tick 闩)同性质。

**反向用例钉住三件事**(加了就红):① `Player` 的键集**恰好**是契约面四栏 `index` / `resources` / `alive` / `exceptionTicks`;② `Snapshot` 的键集里没有任何名字与 `economy` 相关的栏;③ `isEconomyDead` 是**纯函数**——参数类型 `EconomyView` 根本没有那一栏,两份额外状态只差闩栏时判据同值。

**差别的代价**:回放里经济死亡的时点只能从 `economy-dead` 事件读,不能从某个字段反查——票面把这条代价写明了,本实现照旧承担。

另:判定**不看 `alive`**(形式定义只与「无农民且钱不够」有关)。一个恰好在本 tick 步 5 被淘汰的玩家,若同时满足经济死亡,会在步 4 先发一条 `economy-dead`——票面没排除它,事件是叙事事实而不是资格。**判定排在本步最后(四段之后)**:d) 会出兵(可能补回一个农民)与退款,若提到 d) 之前,一个刚把工人产出来的玩家会被错报成「无农民」(有专门用例钉住)。

### §4.5 槽位与定序

- `STEP_OF` 已把 `economy-dead` 挂在步 4,本轮**不改**那张表。判定按座位 `0..3` 升序;同一 tick 多席同时进死亡时,收集器按主体(座位号)数值升序定序。
- 事件主体是**玩家号**(`collector.economyDead(seat)`)。
- 闩栏的注释写全了「为什么它不是经济死亡状态字段」(见 `world/state.ts`)。

### §4.6 采空之后

- 采空(`remaining === 0`)**不删点位、不改 `kind`**:`harvest` 只减 `remaining`。全点位胜利条件数的是 `state.sites` 的**全部**点位,与 `remaining` 无关。用例:座位 0 控制一张图全部点位(一个基地 + 一个余量 1 的矿),农民一 tick 采空,断言点位仍在(`id`/`kind` 不变)且座位 0 照样凭「控制全部点位」获胜。

### §5 实测反例读数(每条真跑一次再还原)

1. **交付目标改成「取属主座位号最小的相邻基地」**(不判敌我,同座位取数组末位):两条交付目标用例红——用例期望 `siteId: 4` 实收 `8`;期望 `siteId: 8` 实收 `4`。
2. **经济死亡改成每 tick 发**(去掉步 4 里闩的 `continue`):「闩让每局每席至多一条」用例红——第二 tick `economyDeadAtTick[0]` 由 `0` 变 `1`(多发一条事件)。
3. **允许未占领开采**(去掉 `nearestFriendlyResourceSite` 的 `owner === seat`):「中立 / 敌方资源点无开采权」用例红——`carrying` 由 `0` 变 `1`。
4. **自选反例:取量去掉 `carryLimit - carrying` 封顶**(用 `harvestRate = 5`):「满携带即停…」用例红——`carrying` 由 `20` 变 `24`(超上限)。

### 门禁与用例读数

- `pnpm run check` **EXIT=0**:`check:quick`(格式 / oxlint / 耦合 / 禁浮点 35 文件无违规)→ `lint:types` → unit+property 57 文件 / **658 用例全绿** → 依赖门禁(102 模块 203 依赖无违规)→ 声明即依赖 → 生成物漂移(6 件无漂移)→ 基准产物(3 份逐字节一致)。
- `pnpm vitest run --project unit --project property` **EXIT=0**,57 文件 / 658 用例;其中新增 `economy.test.ts` 25 条。

### 留给后续票的话

**给票 10(经济与生产的上层接线/预算)**:本票新增或收紧的不变量——
- `GameState.economyDeadAtTick` 是**事件闩**,不进 `Snapshot`、不进 tick 行、不进 `stateHash`;任何序列化面都别把它带上。
- `Change` 新增三条:`harvest` / `transfer` / `mark-economy-dead`;`harvest` 与 `transfer` 各自是**一条**原子变更(加携带↔减矿、清携带↔入池不可拆)。
- 步 4 的四段序 **a→b→c→d→经济死亡**是规则;c 在 d 前有真实读数差异。
- 采集/交付**都不发事件**(八种事件里没有对应者);经济死亡每席每局至多一条。

**给票 11(确定性与读数)**:`harvest`/`transfer` 全整数运算;`economyDeadAtTick` 不在 `stateHash`/`Snapshot`/tick 行里,所以它**不会**改变同局的 `stateHash`;经济死亡判定在 d) 之后按座位升序做,确定性由「座位序 + 纯函数」保证。

**给票 12(契约面缺口)**:
- 规则集缺「这个兵种能不能采集」这一栏——`harvestRate` 是速率不是资格,`canHarvest` 只能把资格判在类型名 `worker` 上。
- `docs/rules-v1/rules.md` **§5「占领」仍是占位**(与票 05/06 同一处缺口);经济那一节(§4.1–§4.3)本轮已有散文,与本实现逐条对齐。
- `Intent.harvest` 的 `siteId` 目前**无语义**(引擎按「相邻己方矿取 id 最小」定目标):契约面需要表态——要么删字段,要么写明它只是提示。
- 「相邻」的射程取 `statsOf(unit.type).range`、含距离 0 那一格:契约面把 `worker.range = 1` 读成「相邻格(含自身格)」需要一句明文。
