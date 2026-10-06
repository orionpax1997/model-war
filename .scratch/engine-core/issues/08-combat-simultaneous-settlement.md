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
- [x] 每条判据各有一个能被弄红的反例：把结算顺序化 → 同时性用例红;去掉「攻击者死亡不影响生效」分支 → 同归于尽用例红;允许攻击基地 → 基地用例红 → 四条反例实测读数见 `## Answer`
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

未改 `rulesets/*.json`、未碰 `docs/**`、未碰别的票的文件。

### 关键接口

- `checkAttack(view: AttackView, seat: PlayerIndex, ruleset: RulesetView, intent: AttackIntent): boolean`
- `runAttack(view, seat, ruleset, intent): AttackDamage | null`,其中 `AttackDamage = { targetId, damage }`（**不是** `Change`)
- `isAttackIntent(intent): intent is AttackIntent`
- `AttackView = { units, sites }`（每栏 readonly;战斗不需要地形/`size`)

### §4.1–§4.5 裁法

**§4.1 `check()` 五条判据**:照任务书逐条落地(`combat.ts:71`)。第 3 条**只判 `damage > 0`,不判 `range`**——农民 `range = 1` 而 `damage = 0`,用例先断言这两个取值再断言意图被丢,把「两条一起判」钉成判据。第 5 条射程用切比雪夫距离,取自 `ruleset.statsOf(...).range`。

**id 空间是否撞号:撞。** 实测读数（`nextId` 从 1 起、地图 `site.id` 是 0..27):
```
open-clash:  site ids 0..27   unit ids 1..8   nextId 9
撞号的单位 id: 1,2,3,4,5,6,7,8
```
`create-site` 用地图 id、不推进 `nextId`,所以开局 8 个单位(1..8)与点位(1..8)全部同号,往后每出一个 `id ≤ 27` 的单位都撞。
判据 4 因此**先判 `sites`**:`targetId` 命中 `sites` 即丢弃(挡住基地)。两个后果写在这里,回报设计/规则侧,**本票不修**:
1. 与任务书一致——「命中 sites → 丢弃」是无条件的,两条判据各有一条用例(`combat.test.ts:205` 撞号场景、`217` 纯基地场景)。
2. **风险**:在真地图上,凡 `id ≤ 27` 的单位都会被同号的点位遮住而**无法被攻击**(开局 8 个农民首当其冲)。这是 id 空间未互斥的后果,不是本票规则的错。修法二选一——让点位与单位用互斥号段,或让 `attack` 的 `targetId` 带上目标种类——两者都是跨票变更。任务书要求先按「命中 sites 即丢弃」交付,故照办并在此明报。

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
| 允许攻击基地 | 删掉 `combat.ts` 的「命中 `sites` 即丢弃」守卫 | 1 红：`基地不可被攻击(撞号时点位优先)` |
| 自选:攻击能力判据换成射程 | `damage <= 0` → `range <= 0` | 1 红：`攻击者无攻击能力(农民)` |

四条都真跑过、拿到读数后还原;还原后 11/11 绿。

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

### 门禁与用例读数

- `pnpm run check` → `CHECK EXIT=0`;其中 `Test Files 52 passed / Tests 568 passed`,依赖门禁 93 modules 无违规,声明即依赖 43 文件无未声明引用,生成物漂移 0,基准产物门禁绿。
- `pnpm vitest run --project unit --project property` → `EXIT=0`;`Test Files 52 passed (52)`、`Tests 568 passed (568)`(其中本票新增 `combat.test.ts` 11 条)。
- `pnpm exec oxfmt` 对 5 个改动/新增文件 → 0 改动。

### 留给后续票的话

- **id 空间撞号是本票最该被接住的一条**(见 §4.1):在修好之前,真对局里 `id ≤ 27` 的单位打不着。建议要么让单位号段与点位号段互斥,要么把目标种类带进 `attack`,二选一都归设计侧。
- 归零者「不参与采集/交付/生产」在本票只能断到 `state.units` 里没有它——那三步(06/07)落地后应补一条「死者本 tick 不被它们看到」的用例。
- `unit-destroyed` 只有一个主体字段,「聚合」只能是「每个被消灭单位一条」;若将来要标伤害来源,那是 `packages/schema` 的形状变更,不在引擎侧。
- `apply.ts` 新增了写操作 `set-unit-hp`;后续票若也要改血量,走同一登记,不要旁路展开单位对象。
