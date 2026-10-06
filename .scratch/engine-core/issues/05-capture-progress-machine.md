# 05: 占领——进度机

**What to build:** 占领进度机在真引擎上跑起来:单位站到可占领点位格上即驱动占领,累积到阈值后所有权易主、进度清零。四条并列的规则一并落地——**全兵种占领速度一致**（农民不加速）、**转轨重计无侵蚀**、**无人站立进度保留不动不衰减**、**同阵营驻守保留不动**。

**堵点战术是这一机制的战术面**:己方单位站在自家点位上可直接物理阻止敌方踩点,对方需要先消灭那个单位（单位可被攻击,基地不可）。这条让「经济死亡 ≠ 出局」在引擎里成为事实——占领不需要资源,所以没有农民的玩家仍可用残兵抢点、阻断、拿下胜利。

**两点写在这里是因为实现时最容易搞反**:一是**全兵种一致**这条与「农民是最便宜的兵种」相抵,农民因此也是最便宜的占领/堵点单位,那是 gdd 明写的设计张力,必须靠基准脚本验,不是靠本票的判据;二是「**无人站立不衰减**」是一条**保留**规则而不是**清零**规则,两者的差别在长时间僵持下极大。

决策依据：`.scratch/engine-core/spec.md`《结算管线》事件落位表,`docs/gdd.md` §3.2 占领机制。

**Blocked by:** 04（移动——轮转优先与占位基准）

**Status:** resolved

- [x] 点位持有属主、进度属主与进度三样;属主与进度属主可为中立 → 三栏在 `world/state.ts:91-93`(`owner`/`progressOwner`/`progress`),新建形状在 `driver/apply.ts:153-162`;用例 `processor/capture.test.ts:116`
- [x] 点位是**单格**,同一时刻**最多一个驱动者**（站在点位格上的单位所属方）。单格单单位这条要有用例——两方同 tick 站进同一格时,占位基准（移动那张票）先判掉一个 → 驱动者派生 `processor/capture.ts:49`;用例 `processor/capture.test.ts:131`(04 占位裁决判掉一个)与 `:151`(退化情形取最低 id)
- [x] 驱动者与属主同阵营:占领进度**保留不动** → `processor/capture.ts:73` 的分支「driver === site.owner → null」;用例 `processor/capture.test.ts:162`
- [x] 驱动者与属主不同:进度属主不同则**转轨重计**（进度属主换成新驱动者、进度置一,无侵蚀）；进度属主相同则进度加一 → `processor/capture.ts:84`;用例 `processor/capture.test.ts:186`(转轨重计)与 `:195`(加一)
- [x] 无人站立:进度**保留不动,不衰减**。用例钉住「一整局无人站立的点位进度一动不动」 → `processor/capture.ts:79-81`;用例 `processor/capture.test.ts:173`(跑满 `tickLimit` = 600 tick)
- [x] 累积达阈值后所有权易主、**进度清零** → `processor/capture.ts:85-93`(整条轨道清零:`progress = 0`、`progressOwner = -1`)、`driver/apply.ts:134`(落子);用例 `processor/capture.test.ts:203`
- [x] **全兵种占领速度一致**:农民不加速。这条要有一条用例钉住（四个兵种同样的驻留 tick 数产出同样的进度） → 机器不读兵种,只读占位(结构上一致);用例 `processor/capture.test.ts:239`(四个兵种序列逐项相同)
- [x] 堵点成立:己方单位站自家点位上，敌方同 tick 站上去不推进度（它被占位基准判掉,或推进到零）；要弄清它必须先消灭那个单位 → 用例 `processor/capture.test.ts:261`,钉的是「敌方**没能站上**那一格」(04 占位裁决判掉)那条路
- [x] 事件 `site-captured` 进**第四步**的槽位,按对象数值 id 升序定序 → 步位表未改(`processor/events.ts:70`);发事件在 `processor/steps/step4-object-tick.ts:50-52`(易主那一刻、点位 id);用例 `processor/capture.test.ts:280`(多点位按 id 升序)
- [x] 阈值从规则集装载,**不在代码里** → `processor/capture.ts:85` 只读 `ruleset.raw.captureTicks`;用例 `processor/capture.test.ts:224`(阈值换成 3,驻留第 N tick 进度恰好 N)
- [x] 每条判据各有一个能被弄红的反例：把「无人站立」改成清零 → 衰减用例红;把「转轨重计」改成沿用进度 → 侵蚀用例红;给农民加一个加速系数 → 全兵种一致用例红 → 四条反例实测读数见 `## Answer`
- [x] 注释里写明**这一格是占领进度机的家**,而面向模型的契约面那一节尚未落库——下一轮补那节散文时以规则侧那一节为准,不在契约面另立一套 → `processor/capture.ts:1-23` 与 `processor/steps/step4-object-tick.ts:14-21`(带 gdd §8 记录 #14)

## Answer

### 改了哪些文件

- 新增 `packages/engine/src/processor/capture.ts` —— 占领进度机(家:gdd §3.2)。三个导出:
  `captureDriverAt(site, units)`(驱动者派生)、`captureChangeOf(site, units, ruleset)`(本 tick 的变更,`null` = 保留不动)、
  `isCapture(change)`(这条变更是否易主,给发事件用)。
- 新增 `packages/engine/src/processor/capture.test.ts` —— 13 条用例,逐条写明「改什么会让它红」。
- 改 `packages/engine/src/driver/apply.ts` —— `Change` 登记第一种新写操作 `advance-capture`(`:76-84`)与其落子分支(`:134-145`)。
- 改 `packages/engine/src/processor/steps/step4-object-tick.ts` —— 接上第一段(a)占领,头注写明 b/c/d 归 06/07、进度机的家与契约面缺口。

### 裁法清单(逐条理由)

1. **驱动者怎么取(§4.1)**:状态里没有「点位驻守者」栏,驻守者**就是**站在那一格上的单位,再存一栏是同一事实的第二份表示。驱动者从单位派生:遍历升序 `units` 取第一个 `(x,y)` 等于点位格的单位的 `owner`(`capture.ts:49`)。正常路径下单格单单位由**票 04 的占位裁决**保证;唯一例外是开局——`createInitialState` 按地图 `spawnUnits` 逐个摆,地图若声明两个同格初始单位就绕过裁决。取**数值 id 最小者**是给这个退化情形的确定答案(不是常规路径),这条写进了 `captureDriverAt` 的注释。
2. **堵点那条走的是哪条路**:用例 `capture.test.ts:261` 钉的是「敌方**没能站上**那一格」——`(2,0)` 在本轮基准里被己方单位占住,04 的 `candidateInto` 把敌方移动判掉(断言敌方 x 仍是 1)。于是格上的驱动者仍是己方,落到「同阵营 → 保留不动」。「站上去但 D 是己方」那条路**不可能**(单格单单位),没有钉它。
3. **进度清零清整条轨道(§4.2)**:易主后 `progress = 0` 且 `progressOwner = -1`。只清 `progress` 会余下「进度 0 但属主是某人」的半截状态,下一 tick 与「属主 = 新 owner、进度 0」不可区分,同一可观测状态两种内部表示、回放要靠猜。清成 `-1` 后「无轨道」与「有轨道但进度 0」分得开。易主时驱动者往往还站格上,但下一 tick 就 `D === owner`,落到保留不动,不会反复重累积。理由写在 `capture.ts:84-93`。
4. **阈值次序(§4.3)**:先按 §3.2 更新 `progress`,再判 `progress >= captureTicks` → 易主 + 清零。`captureTicks` **只**从 `RulesetView.raw.captureTicks` 读,代码里无那个数字。用例 `capture.test.ts:224` 把阈值换成 3,断言驻留第 1、2 tick 进度恰好 1、2 且属主未变,第 3 tick 易主清零并出事件——钉住「累积到几时算达」不漂。
5. **全兵种一致(§4.4)**:机器结构上不读兵种,只读占位,所以四个兵种天然一致。用例 `capture.test.ts:239` 对 `UNIT_TYPES` 逐个跑:阈值前逐 tick 记进度,断言四条序列都等于 `[1..captureTicks-1]`、达阈值那 tick 都易主清零,再断言四条序列逐项相同(判据是「同样驻留 tick 数产出同样进度」,不是各自跑通)。
6. **事件(§4.5)**:`collector.siteCaptured(site.id)` 在**易主那一刻**调,`siteId` 即点位号;遍历升序 `state.sites`(由状态不变量保证),同 tick 多点位易主时由收集器按 `subjectId` 定序。`events.ts` 的 `STEP_OF` **未改**。`economy-dead` **未发**(判据归 09)。

### §3 契约面缺口与记录 #14

占领进度机的**家是 gdd §3.2**;契约面 `docs/rules-v1/rules.md` §5「占领」是**占位**(原文「本节未排期」)。终稿契约下盲写三舱全部撞上它、各猜一套互斥机制。规则侧不缺机制,缺的是契约面那一节散文——它归下一轮机制契约散文,本轮不手改生成物;补 §5 时**以 §3.2 为准,不在契约面另立一套**。这段(带 gdd §8 记录 **#14**)写在 `capture.ts:1-23` 与 `step4-object-tick.ts:14-21`。

### 实测反例读数(改一行 → 跑一次 → 还原)

| 反例 | 改动 | 结果 |
|---|---|---|
| ① 无人站立改成清零/衰减 | `capture.ts` 里 `driver === null` 分支返回清零变更 | `capture.test.ts` 13 条中 **1 failed / 12 passed**;`无人站立:一整局进度保留不动、不衰减` 红:`AssertionError: expected +0 to be 4` |
| ② 转轨重计改成沿用进度 | `progress = site.progressOwner === driver ? site.progress + 1 : 1` → `site.progress + 1` | **1 failed / 12 passed**;`转轨重计(从 1 起算,无侵蚀)` 红:`expected 5 to be 1` |
| ③ 给农民加速 | 驱动单位是 `worker` 时步长 +1(`progress` 累加 2) | **7 failed / 6 passed**;`全兵种占领速度一致…` 红:`expected [2,4,6,8,0,0,0,0,0] to deeply equal [1,2,3,4,5,6,7,8,9]` |
| ④(自加)阈值判据 `>=` 改 `>` | `if (progress >= ruleset.raw.captureTicks)` → `>` | **4 failed / 9 passed**;`达阈值…site-captured 在易主那一刻发` 红(`expected +0 to be 1`)、`累积到几时算达…` 红、`全兵种一致` 与 `多点位事件升序` 连带红 |

每条改完都 `cp` 还原并复核与备份逐字节相同(见迭代日志 `/tmp/t05-rev1..4.log`、还原后 `/tmp/t05-iter2.log` 13 passed)。

### 门禁与用例读数

- `pnpm run check` → **CHECK EXIT=0**;内含 `test` 阶段 **52 test files / 570 tests passed**;禁浮点门禁「检查 31 个文件,无违规」;依赖面 93 modules 无违规;声明即依赖门禁 43 文件无未声明引用;生成物漂移 0;基准产物门禁绿。
- `pnpm vitest run --project unit --project property` → **EXIT=0**,**52 test files / 570 tests passed**(`/tmp/t05-check.log`、`/tmp/t05-unit.log`)。
- 未跑 `pnpm run test` / `test:slow`。

### 留给后续票的话

- `step4-object-tick.ts` 的 b) 采集 / c) 交付 / d) 生产三段归 **06/07**:顺序不可换(c 在 d 前,因为交付进玩家池、生产花钱也走玩家池)。头注已写明。
- `economy-dead` 是步 4 的事件但**判据归 09**,本票未发。
- 新增写操作一律先登记进 `Change`(`advance-capture` 是第五种),穷尽 `never` 会兜住漏接。
