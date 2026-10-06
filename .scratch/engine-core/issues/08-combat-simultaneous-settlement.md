# 08: 战斗——同 tick 同时结算

**What to build:** `attack` 这条意图在真引擎上按「同 tick 全部攻击同时结算」裁决:**先计算全部伤害,统一扣血,归零者死亡移除**。因此**攻击者本 tick 死亡不影响其攻击生效**——它这一 tick 打出的伤害照样算,只是它自己回不来了。

**这条同时性是这一票的全部难点**,而它无法拆成「先结算攻击方再结算防守方」那类顺序写法:一旦顺序化,先手方在同归于尽的构造里就白赚一条命。用例必须造出**双方各自只剩一个单位、互相攻击**的构造,那是唯一能把这条钉死的形状。

**几条并列规则一并落地**:攻击目标须存在且为**敌方单位**;攻击者无攻击能力时该条意图**无效丢弃、不计异常**;**基地不可被攻击**（基地格可通行、单格单单位、无攻击能力、不可摧毁只能被占领）。

**这一票只挂在移动那张票上,是有意的**:战斗不依赖占领也不依赖生产,只要单位能移动就能互相打。这样占领→生产→采集那条链与本票可以并行,不必串成八张。

决策依据：`.scratch/engine-core/spec.md`《结算管线》事件落位表,`docs/gdd.md` §6.2 战斗。

**Blocked by:** 04（移动——轮转优先与占位基准）

**Status:** resolved

- [x] **同 tick 同时结算**:先算出本 tick 全部伤害,再统一扣血。顺序化这条 → 同归于尽用例红 → `processor/steps/step3-combat.ts:51,60`（两趟);用例 `processor/combat.test.ts:131`「同归于尽」;反例读数见 `## Answer`
- [x] **攻击者本 tick 死亡不影响其攻击生效**。用例：两个单位同 tick 互相攻击致死,双方伤害都生效 → `processor/steps/step3-combat.ts:51`（伤害条只读基线,改血之前算完);用例 `processor/combat.test.ts:145`
- [x] 归零者死亡移除,**不参与后续阶段**（采集、交付、生产都看不到它） → `processor/steps/step3-combat.ts:77`（`destroy-unit`)`;用例 `processor/combat.test.ts:245`（解析写出行断言已移除)
- [x] 死亡移除按对象数值 id 升序,不影响同 tick 其余伤害的计算（伤害已全部算完） → `processor/steps/step3-combat.ts:60`（目标 id 升序遍历);用例 `processor/combat.test.ts:266`
- [x] 攻击目标须存在且为**敌方单位**;攻击己方单位 → 无效丢弃 → `processor/combat.ts:71` 判据 4;用例 `processor/combat.test.ts:226`
- [x] **攻击者无攻击能力时该条意图无效丢弃、不计异常**。用例钉住「农民发不出有效的攻击」这件事是判据不是特例（农民的距离值不为零,伤害为零,两条要一起判） → `processor/combat.ts:87`（判 `damage` 不判 `range`);用例 `processor/combat.test.ts:192`（先断言 `worker.range===1` 且 `damage===0`)
- [x] **基地不可被攻击**:把基地当目标 → 无效丢弃 → `processor/combat.ts:92`;用例 `processor/combat.test.ts:205,217`
- [x] 目标须在攻击者射程内（切比雪夫距离 ≤ 射程）,射程从规则集装载 → `processor/combat.ts:106`;用例 `processor/combat.test.ts:177`
- [x] 事件 `unit-destroyed`（**聚合**）进**第三步**的槽位,按对象数值 id 升序定序。聚合的口径（一次结算合并成一条还是逐个单位一条）要写进注释,并有一条用例钉住 → 口径写进 `processor/steps/step3-combat.ts:21`;用例 `processor/combat.test.ts:156`（两个攻击者打死同一单位 → **恰好一条**)、`266`（多单位被消灭按 id 升序)
- [x] 伤害单一血池,全整数运算 → `processor/steps/step3-combat.ts:60`;用例 `processor/combat.test.ts:156`
- [x] 每条判据各有一个能被弄红的反例：把结算顺序化 → 同时性用例红;去掉「攻击者死亡不影响生效」分支 → 同归于尽用例红;允许攻击基地 → 号段互斥后该守卫与「目标不存在」等价,不再独立可变红（见 `## Answer` 的 id 空间修正与 §5）→ 反例实测读数见 `## Answer`
- [x] 若发现某个兵种的数值让 `gdd` §6.1 那七条约束之一在数值下不成立,**回报规则侧而不自行调数值**——约束不成立即触发那条已写下的风险 → 代数核对结论见 `## Answer`（C1–C6 成立,C7 待 06/07;未改 `rulesets/*.json`)

## Answer

### 改动文件清单

| 文件 | 改动 |
|---|---|
| `packages/engine/src/processor/combat.ts` | 新建。`checkAttack` / `runAttack` / `isAttackIntent`（只读视图 + 纯函数) |
| `packages/engine/src/processor/steps/step3-combat.ts` | 实现两趟结算(算伤害 / 扣血),死亡移除与 `unit-destroyed` |
| `packages/engine/src/driver/apply.ts` | `Change` 登记新写操作 `set-unit-hp` 并落实现 |
| `packages/engine/src/processor/steps/step1-validate.ts` | 放行名单加进 `attack`（保留三条「尚未实现」说明) |
| `packages/engine/src/processor/combat.test.ts` | 新建。11 条用例 |
| `packages/engine/src/world/initial-state.ts` | **复查修正**:初始字面量里把 `nextId` 抬到所有地图号之上(`firstUnitId`) |
| `packages/engine/src/driver/id-gen.ts` | **复查修正**:`ID_START` 注释里「0 留空」那句假话改成「分配器起点 / 无点位地图的地板」 |
| `packages/engine/src/driver/apply.ts` | **复查修正**:`create-site` 注释补一句「开局必须先把 `nextId` 抬到所有地图号之上」 |
| `packages/engine/src/processor/combat.ts` | **复查修正**:删掉「点位优先挡撞号」的说法,两条丢弃判据回到语义 |
| `packages/engine/src/world/initial-state.test.ts` | **复查修正新增**:一个全局 id 空间的 13 条用例 |

未改 `rulesets/*.json`、未碰 `docs/**`、未碰别的票的文件。

### 关键接口

- `checkAttack(view: AttackView, seat: PlayerIndex, ruleset: RulesetView, intent: AttackIntent): boolean`
- `runAttack(view, seat, ruleset, intent): AttackDamage | null`,其中 `AttackDamage = { targetId, damage }`（**不是** `Change`)
- `isAttackIntent(intent): intent is AttackIntent`
- `AttackView = { units, sites }`（每栏 readonly;战斗不需要地形/`size`)

### §4.1–§4.5 裁法

**§4.1 `check()` 五条判据**:照任务书逐条落地(`combat.ts:71`)。第 3 条**只判 `damage > 0`,不判 `range`**——农民 `range = 1` 而 `damage = 0`,用例先断言这两个取值再断言意图被丢,把「两条一起判」钉成判据。第 5 条射程用切比雪夫距离,取自 `ruleset.statsOf(...).range`。

**id 空间:一条全局空间。本票初版抓到了撞号,复查时已修掉。** 根因:点位号来自地图(三张真图实测 `site.id` 是 0..27),单位号来自 `nextId`,而 `createInitialState` 把 `nextId` 初始化成 `ID_START = 1`、`create-site` 又不推进它。于是开局 8 个单位拿到 **1..8**、与点位号 **1..8** 全部同号。后果:凡 `id ≤ 27` 的单位被同号点位遮住——`attack` 的 `targetId`、`harvest` 的 `siteId`(票 07)、`spawnUnit` 的 `baseId` 都按 id 查,**开局 8 个单位一个都打不到**。这不是「攻击基地」那条规则在起作用,是一次号段重叠事故。

**修法**:在 `createInitialState` 的**初始字面量**里把 `nextId` 抬到 `max(map.sites[].id) + 1`,不低于 `ID_START`(`world/initial-state.ts` 的 `firstUnitId`)。三张真图下开局单位号是 **28..35**(修前 1..8)、`nextId` 从 36 起。这一步是**两次状态出生的一部分**、不是对局中的写操作,所以不新开 `apply()` 变更(给 `Change` 加一条只有开局用得上的登记只会让「唯一写入口」那张表多一条噪声)。

**出处**:契约要求一个全局 id 空间——`getObjectById(id: number): Unit | Site | null`(`docs/rules-v1/api.md:278`、类型面真源 `packages/schema/script-api/index.d.ts:178`)。一个 id 查出来要么是单位要么是点位;两个空间会让这个返回类型失去意义。未改 `rulesets/*.json`、未改 `maps/*.json`、未改 `docs/**`。

判据 4 的「命中 `sites` 即丢弃」**保留**(基地不可被攻击),但理由回到**语义**,不再是「因为会撞号所以点位优先」——号段互斥后它不再承担避让职责;它与「两边都没命中 → 丢弃」各自独立。`combat.ts` 文件头与判据注释已同步改掉旧说法,单路的用例也改成靠真实点位号构造。

**§4.2 两趟**:`step3-combat.ts:51`（第一趟只读 `context.state` 算全部伤害条)、`:60`（第二趟按目标求和、统一扣血)。同一攻击者重复提交由步 1 分组挡掉。

**hp 取法**:`hp - 求和伤害`,**允许取 0 或负**(过杀)。负值只在本步内瞬时存在——归零者在同一次迭代里紧接着被 `destroy-unit` 移除,步 6 写出时已不在。取「允许负值再移除」而非「钳到 0」,是为了让「忘了移除」在断言下变红(钳到 0 会把一个零血活单位留进写出行)。用例 `combat.test.ts:245` 解析写出的 JSONL,断言每个单位的 `hp ≥ 0`。

**§4.3 死亡移除顺序**:目标 id 升序遍历,移除即 `apply(destroy-unit)`;伤害已全部算完,故移除不影响同 tick 其余伤害。用例 `combat.test.ts:266`。

**§4.4 `unit-destroyed` 聚合口径**:**按被消灭的单位聚合**——同 tick 每个被消灭的单位一条主体为该单位 id 的事件,不按「攻击者-目标对」聚合。`Event` 形状 `{kind, subjectId}` 归 `packages/schema`,未动。用例 `combat.test.ts:156`(两个攻击者打死同一单位 → 恰好一条)。

**§4.5 `step1-validate.ts`**:`isMoveIntent` / `isAttackIntent` 两条放行,`harvest`/`transfer`/`spawnUnit` 仍静默丢弃(保留「尚未实现、不是非法」的头注)。未重构该文件其它部分。

### §5 实测反例读数(每条改一处 → 跑 `combat.test.ts` → 还原)

| 反例 | 改动 | 读数 |
|---|---|---|
| 结算顺序化 | 把两趟换成「逐条算伤害并就地扣血」 | 2 红：`同归于尽`、`攻击者本 tick 死亡不影响` |
| 去掉「攻击者死亡不影响生效」 | 两趟保留,但扣血时跳过此刻已死的攻击者 | 1 红：`同归于尽` |
| 允许攻击基地 | 删掉 `combat.ts` 的「命中 `sites` 即丢弃」守卫 | 复查后 **0 红**:号段互斥后点位 id 永不命中单位,守卫与「目标不存在」等价(见下方 §6);守卫保留是为了把「基地不可被攻击」写死 |
| 自选:攻击能力判据换成射程 | `damage <= 0` → `range <= 0` | 1 红：`攻击者无攻击能力(农民)` |

前三条与第四条都真跑过、拿到读数后还原;其中「允许攻击基地」在号段互斥后已不再独立可变红,读数在那里明记。还原后 `combat.test.ts` 11/11 绿。

### §6 一个全局 id 空间的用例与反例(复查新增)

新增 `world/initial-state.test.ts`(13 条,三张真图逐个跑):

| 用例 | 钉住 |
|---|---|
| 开局 `units ∪ sites` 的 id 两两不同 | 号段重叠 |
| 开局单位真的打得着(拿**初始单位**的 id 当 `checkAttack` 的 `targetId`) | 上一版那个「开局 8 个单位一个都打不到」的事故 |
| 对局中新建单位的号不与任何点位号相撞 | 中局取号也不落回地图号区间 |
| 点位号自身两两不同 + 三张真图点位号占低端且含 0 | 地图数据自洽 + `ID_START` 那句「0 留空」的旧说法作废 |

**反例真跑**:把 `createInitialState` 的 `nextId` 改回 `ID_START` → 13 条里 **9 红 / 4 绿**（三张图的「两两不同」「打得着」「新建不撞」各红;「点位号自身不重复」×3 与占低端的哨兵 4 条绿);还原后 13/13 绿。

### §3 C1–C7 代数核对(未改规则集)

取值:`worker{cost4,hp2,dmg0,range1,speed1}` `melee{cost8,hp12,dmg3,range1,speed1}` `ranged{cost12,hp4,dmg2,range2,speed1}` `cavalry{cost16,hp6,dmg2,range1,speed2}`。模型:`等成本 + 站桩对拼 + 聚焦火力`。

- **C1 近战>远程**:等成本 LCM 24 → 3 近战(dps 9,总血 36) vs 2 远程(dps 4,总血 8)。近战 1 tick 清空远程。**成立**。
- **C2 远程>骑兵**:等成本 LCM 48 → 4 远程(dps 8,总血 16) vs 3 骑兵(dps 6,总血 18)。远程清空需 18/8=2.25 tick、骑兵需 16/6≈2.67 tick,聚焦火力逐 tick 推演也是 1 远程幸存。**成立,但余量最薄**(1v1 单挑远程反输:骑兵 6/2=3 tick 杀远程,远程 4/2=2 tick 杀不掉骑兵);实际对局结果对「是否聚焦火力 / 出手先后」敏感,建议基准脚本落地时重点复核。
- **C3 近战>骑兵且优势明显**:等成本 LCM 16 → 2 近战(dps 6,总血 24) vs 1 骑兵(dps 2,总血 6)。近战 1 tick 秒杀。**成立**。
- **C4 近战 HP/造价与伤害/造价全兵种最高**:近战 12/8=1.5、3/8=0.375;worker 0.5/0,远程 0.333/0.167,骑兵 0.375/0.125。两项均最高。**成立**。
- **C5 骑兵速度=2×其余且造价≥2×近战**:速度 2 vs 1/1/1;造价 16 = 2×8(取等,满足「≥」)。**成立**。
- **C6 远程在近战贴身 2 tick 内被击杀**:远程血 4、近战 3/tick → ceil(4/3)=2 tick。**成立**。
- **C7 单基地满产资金消耗>单农收入,且使两种极端打法都不能赢**:属经济,要采集(07)/生产(06)/基准脚本就位才能判。**本票无结论,待 06/07**。

**结论:代数核对 C1–C6 无冲突(均在上述模型下成立),C7 待 06/07。未发现需回报的不成立项。**

### 影响面

- **单位号段变了**:开局从 28 起(修前 1..8),`nextId` 从 36 起。任何「单位号从 1 起」的读数作废。
- **tick 行的 `stateHash` 会跟着变**(单位号在载荷里),这是**预期**的;仓里没有入库的回放 golden,没有 golden 需要重签。
- **`harvest`(票 07 的 `siteId`)与 `spawnUnit`(`baseId`)踩同一个坑**(按 id 在同两个数组里查),本修对它们一并生效。
- 演示态复跑(真 bundle):`match` 退 0、写出 602 行;`replay` 退 0。

### 门禁与用例读数

- `pnpm run check` → `CHECK EXIT=0`;其中 `Test Files 53 passed / Tests 581 passed`,依赖门禁 94 modules 无违规,声明即依赖 43 文件无未声明引用,生成物漂移 0,基准产物门禁绿。
- `pnpm vitest run --project unit --project property` → `EXIT=0`;`Test Files 53 passed (53)`、`Tests 581 passed (581)`(本票初版 11 条 `combat.test.ts` + 复查新增 `world/initial-state.test.ts` 13 条)。
- `pnpm exec oxfmt` 对改动/新增文件 → 0 改动。

### 留给后续票的话

- **id 空间已在本次复查里修掉**(见 §4.1):开局 `nextId` 抬到所有地图号之上,单位号从 28 起。**票 07** 的 `harvest` 用 `siteId` 查点位、`spawnUnit` 用 `baseId` 查基地,踩的是同一个坑——本修对它们一并生效,**票 07 不必再自行避让**,但请在其 `## Answer` 里提一句本修是它的前置。
- 归零者「不参与采集/交付/生产」在本票只能断到 `state.units` 里没有它——那三步(06/07)落地后应补一条「死者本 tick 不被它们看到」的用例。
- `unit-destroyed` 只有一个主体字段,「聚合」只能是「每个被消灭单位一条」;若将来要标伤害来源,那是 `packages/schema` 的形状变更,不在引擎侧。
- `apply.ts` 新增了写操作 `set-unit-hp`;后续票若也要改血量,走同一登记,不要旁路展开"单位对象。
