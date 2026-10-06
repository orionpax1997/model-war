# 09: 评估——四种终局与名次

**What to build:** 第五步的胜负判定,顺序即规范:**淘汰 → 点位回归中立 → 全点位归属 → 捷径条款(兜底)**。并把终局结果那份形状定死:原因枚举、名次数组、领土分。

**本票要解掉一个真实的边缘。** 同 tick 全部伤害算完、统一扣血、归零者死亡,所以**两名玩家可以在同一个 tick 同归于尽**;若这两人各自都是最后一名单位且无基地,淘汰步会把**四方全部**淘汰,此时捷径条款（要求「仅剩玩家」）与主胜利条件都不成立。**没有胜者,而名次与原因必须给出答案**,否则「原因是一个穷尽判别联合」这句话是假的。所以原因枚举加第四态 `all-eliminated`,名次按规则侧那四条算(无存活层 → 按淘汰时间倒序 → 同 tick 淘汰者并列同名次),**首名就是最后出局的那一方,字段集不变**。

**复用 `timeout` 是错的**:那会让「打满 600 tick」和「第 37 tick 全灭」在数据上无法区分,而报告正是靠原因分类。**改机制保证有幸存者也是错的**:那要给战斗步加一条「预判本 tick 会不会灭干净」的反向依赖,是个新的漂移面,而且它要改的是规则侧的战斗裁决,本 feature 改不了。

**淘汰方 `loop()` 不再执行**,但状态保留以便重放取证——所以那一方的状态在后续 tick 仍在回放里,只是不再被调用。

决策依据：`.scratch/engine-core/spec.md`《终局:加第四个原因》一节,`docs/gdd.md` §3.1 胜利与淘汰（含名次四条）。

**Blocked by:** 05（占领——进度机）, 08（战斗——同 tick 同时结算）

**Status:** resolved

- [x] 判定顺序逐条落地:淘汰 → 被淘汰者点位回归中立 → 判全点位归属 → 判捷径条款(兜底)。**回归中立可能破坏「全点位」条件,由捷径条款接住**——这条要有一处构造把它逼出来 → `processor/steps/step5-evaluate.ts` 的 `EVALUATE_STAGES` 四段;构造见 `processor/outcome.test.ts` 的「b) 回归中立会破坏「全点位」…」,反例读数见 `## Answer` §反例 1
- [x] 淘汰条件:玩家**同时**无任何单位**且**无任何基地。部队尚存就仍有翻盘可能（被夺家后靠残兵反夺基地是刻意保留的戏剧空间）——用例钉住「两者缺一不算淘汰」 → `outcome.test.ts`「a) 淘汰条件是「与」…」;反例读数见 `## Answer` §反例 3
- [x] 被淘汰玩家名下残余点位**全部回归中立** → `returnNeutralStage` + `apply` 的 `return-site-to-neutral`;用例同上（座位 3 的 12 号点位回归 `-1`）
- [x] 主胜利:单一玩家控制**地图上全部点位**（含敌方主基地）的**瞬间**获胜,无需持续时间 → `allSitesStage`;`outcome.test.ts`「c) 全点位归属…」
- [x] 捷径条款:其余三方全部被淘汰时,仅剩玩家立即获胜 → `shortcutStage`;`outcome.test.ts`「d) 捷径条款…」
- [x] 原因枚举 = `victory | shortcut | timeout | all-eliminated`,**判别联合带穷尽性断言**（编译期一条兜住漏掉的那一档;加第五档而不加断言 → 用例红） → 取值域住在 `packages/schema/src/replay-line.ts` 的 `ReplayOutcomeReason`,穷尽性由 `outcome.ts` 的 `winnerSeatOf` 的 `never` 兜住;`validator.test.ts` 另有类型级 `ResultReasonEnumMatchesType` 钉住 schema 枚举 ↔ 类型。反例读数见 `## Answer` §反例 2
- [x] **`all-eliminated` 可达且有用例**:造出双方各自最后一名单位同 tick 互杀 → 四方全淘汰、无胜者、名次按淘汰时间倒序、同 tick 淘汰者并列同名次 → `outcome.test.ts`「all-eliminated 可达…」(互杀构造)+「名次:已淘汰者按淘汰时间倒序…」(倒序与并列)
- [x] 名次四条逐条落地:胜者第 1；存活者排在已淘汰者之前；层内存活者按领土分降序、已淘汰者按淘汰时间倒序；仍完全相同则**并列同名次** → `outcome.ts` 的 `rankKeyOf` / `competitionRanks`;`outcome.test.ts` 名次两条;反例读数见 `## Answer` §反例 4
- [x] **已淘汰玩家的领土分恒为 0**（点位已回归中立不贡献、存活单位造价为 0）,且这一点在接口面上说清——否则报告会出现「领土分 0 却排第 1」的读不懂 → 它是公式的推论,不写特例分支;`territoryScoreOf` 头注 + `ReplayResultLine` 的注释都写了;`outcome.test.ts`「已淘汰玩家的领土分恒为 0…」钉住
- [x] 地图点位数从地图数据读,**不硬编码数量**。用例:换一张点位数量不同的图 → 胜利判定跟着变 → `allSitesStage` 读 `state.sites`;`outcome.test.ts`「c) 全点位归属…」里多添一个中立点就从「胜」变「未胜」
- [x] 淘汰方 `loop()` 不再执行、**状态保留**,后续 tick 的回放里仍看得到它 → `steps/step0-dispatch.ts` 跳过 `alive === false` 的座位并交回空数组;`outcome.test.ts`「淘汰方的 loop() 不再被调用…」(计数策略 + 写出行仍含其单位与资源)
- [x] 事件 `player-eliminated` 与 `victory` 进**第五步**的槽位,按对象数值 id 升序定序 → `eliminateStage` / `allSitesStage` / `shortcutStage` 调收集器具名方法;`events.ts` 的 `STEP_OF` 已把两者挂在步 5;用例断言了 `player-eliminated` 与 `victory` 的主体序
- [x] 终局结果那份形状在真源包落库:类型、JSON Schema、读入端校验三层齐（待回填清单里那一条销掉） → 类型与 JSON Schema 在 `packages/schema/src/replay-line.ts`,读入端在 `apps/cli/src/validator.ts` 的 `validateReplayResultLine`(用例在 `validator.test.ts`);`packages/schema/src/pending.ts` 的 `match-result` 销账、`PENDING_SHAPES = []`
- [x] 每条判据各有一个能被弄红的反例:把判定顺序里「回归中立」与「全点位」调换 → 那处构造红;去掉判别联合的穷尽断言 → 加第五档即红;把淘汰条件改成「无单位或无基地」→ 缺一用例红 → 读数逐条记在 `## Answer` §反例

## Answer

### 本票由两次执行完成

本票由**两次执行**完成,源码注释里因此有两批笔迹,先说明各自的边界:

- **前半段**(被中断的那次):状态模型与 schema 三件。`GameState.eliminatedAtTick`、`ReplayOutcomeReason` 封闭联合与它的 JSON Schema `enum`、`pending.ts` 的 `match-result` 销账、`apply()` 登记三种新变更（`eliminate-player` / `return-site-to-neutral` / `set-outcome`）、以及 `processor/outcome.ts` 那 179 行原语（`territoryScoreOf` / `outcomeOf` / `winnerSeatOf` / `costOf`）。
- **后半段**(本票这次):接线与收口。填 `step5-evaluate.ts` 的四段判据、步 7 写 `timeout`、拆掉 `limitReached` 过渡信号、`step0` 跳过淘汰方、`run-match` 从 `state.outcome` 取末行、CLI 的 `validateReplayResultLine`、`outcome.test.ts` 与反例、生成物与门禁。同时把前半段遗留的编译面补齐（`GameState` 加了必填栏之后,`combat/movement/capture/step-order/tick-line/read-only-isolation/traversal-independence` 七个测试夹具与它们的 `makeState` 都要跟上）。

### 六处预先裁定的做法

**§4.1 `limitReached` 换成 `state.outcome`。** 删掉 `TickContext.limitReached` 与 `TickResult.limitReached`;`runMatch` 的循环条件改成 `while (state.outcome === null)`。**步 5 写 `victory` / `shortcut` / `all-eliminated`,步 7 写 `timeout`**,都经 `apply()` 的 `set-outcome`（唯一写入口）。步 7 先看 `state.outcome` 再判超时:恰在最后一 tick 分出胜负时,它不得把步 5 的结论覆盖成 `timeout`。`step-order.test.ts` 原先把「第七步在第六步之后」钉在 `limitReached` 上——那两条断言**改写**成断言 `state.outcome?.reason === "timeout"` 与 `state.outcome === null`,没有删掉。`run-match.ts` 的 `resultLineOf` 改成直接从 `state.outcome` 取,`outcome === null` 仍抛（引擎故障),原先那段「超时 + 全部并列 + 领土分 0」的兜底随之删除;`finalState` 的「此刻 `outcome` 仍是 `null`」那句改成「必已置」。

**§4.2 淘汰时刻住 `GameState.eliminatedAtTick`,不挂 `Player`。** 名次第三条要按淘汰时间倒序,所以它必须是一份可读状态;但 `Snapshot.players` 的类型是 `Player[]`,而 `Player` 是已冻结的契约面（`docs/rules-v1/api.md` 只有四栏,脚本类型面逐字对应）。给 `Player` 加栏会**静默**把它塞进脚本可见面。于是它是一栏独立的 `readonly (number | null)[]`（下标即座位,长度恒四,**不进 `Snapshot`**,与 `nextId` / `outcome` / `firstContactTick` 同列),理由逐字写在 `world/state.ts`。`outcome.test.ts` 另有一条断言 `Snapshot` 的键仍是那六个。

**§4.3 领土分与全整数。** 三项权重全从 `ruleset.raw` 读（代码里不出现 4 / 1 / 6);除法是 `Math.floor(总造价 / unitCostDivisor)`——两个操作数都是远小于 `2^53` 的整数,浮点中间值精确,`Math.floor` 在白名单内,结果仍是整数闭包。**已淘汰者的领土分为 0 是公式的推论,不写特例分支**:出局者无单位、无基地、点位已回归中立,三项自然全 0。

**§4.4 淘汰方 `loop()` 不再执行。** 落点在 `step0-dispatch.ts`:座位 `alive === false` 时不再 `setSnapshot` / `drainIntents`,直接交回空数组（`DrainedIntents[]` 的四项对齐不变量不破);它的单位与资源仍随快照写进后续 tick 的回放行（状态保留）。跳过发生在调用点,沙箱执行器不需要知道谁出局。

**§4.5 `all-eliminated` 的名次。** 无存活层 → 按淘汰时间降序 → 同 tick 者并列同名次,首名即最后出局者。**名次数字只由 `competitionRanks` 一处产生**,「胜者是第 1」与「并列」共用它（占用的名次位按并列人数跳过:并列第 2 的两方都记 2,下一位是第 4）。`all-eliminated` 由 `shortcutStage` 的兜底写:捷径要求「仅剩一方」,一方不剩（同 tick 全灭）时写它,不落进一个没有终局的空档。

**§4.6 契约面三层齐 + `match-result` 销账。** 取值的家是 `packages/schema/src/replay-line.ts` 的 `ReplayOutcomeReason`;engine 侧 `OutcomeReason` 是它的**别名**（不重列第二份取值表,先例是 `TickPayload = ReplayTickPayload`）。JSON Schema 的 `reason` 收成四值 `enum`。读入端是 `validateReplayResultLine`,它与 `validator.test.ts` 的用例一起交付（含合法 / 缺栏 / 多栏 / `reason` 不在枚举 / `rankings` 长度非 4 / 领土分负数 / 名次 <1 / 错型）。`pending.ts` 的 `match-result` 销账,`PendingShapeId = never`、`PENDING_SHAPES = []`,头注与销账说明写清。

### 给后续票的话

- **给票 06**:`apply()` 的 `return-site-to-neutral` 是「基地**回归中立**」那条路——**取消队列且不退款**,与「易主 → 全额退款」是两件事。两条路不要合并。
- **给票 10**:本票新增的不变量——① `eliminatedAtTick` 与 `player.alive === false` 由**同一条** `eliminate-player` 变更一起落,中间态在类型上不存在;② `state.outcome` 一旦置上就不再改（步 7 看它、不覆盖）;③ 淘汰方在步 0 交回空数组、状态保留。
- **给票 12**:`packages/schema/src/pending.ts` 已清空（`PENDING_SHAPES = []`）——文档对账时别再去找「还有哪条待回填」;本票之后五类形状全落库。
- **关于 `validateReplayResultLine` 的接线（未做,留给后续裁定）**:`modelwar replay` 的读盘渲染器住在 `@model-war/replay`（`packages/replay/src/render.ts`),而依赖方向是 `schema ← replay ← engine`,`packages/replay` **不能**反向依赖持有唯一 ajv 实例的 `apps/cli`（hld §3.2)。把校验器搬进 `replay` 会让它依赖 ajv、把「校验器只在 apps/cli 一处」这条纪律破掉;改 `commands.ts` 的 provider／handler 又会动到帮助文本与既有 e2e。故本票**只交付校验器与它的用例**（第三层在类型上、schema 上、纯函数断言上齐了),接线留给「回放读入端校验归哪一层」那次有意的裁定。校验器不是死代码:它是那层的公开入口,`validator.test.ts` 是它的调用点。

### 反例读数（每条:改一处 → 跑一次 → 记读数 → 还原）

1. **调换「回归中立」与「全点位」**（`EVALUATE_STAGES` 第 2、3 段互换）→ `pnpm exec vitest run --project unit outcome.test.ts`:`1 failed | 17 passed`,唯一红的是「b) 回归中立会破坏「全点位」…」,`AssertionError: expected 'victory' to be 'shortcut'`。即:顺序一反,那个**已出局**的座位 1 因仍持全部点位被判成 `victory`,捷径条款接不住。
2. **给封闭联合加第五档**（`ReplayOutcomeReason` 加 `"surrender"`）→ `pnpm exec tsc -b --pretty false`:`TSC EXIT=2`,红在两层——`packages/engine/src/processor/outcome.ts(173,13): error TS2322: Type '"surrender"' is not assignable to type 'never'`（`winnerSeatOf` 的穷尽性哨兵）,以及 `apps/cli/src/validator.test.ts(1253,50): error TS2344: Type 'false' does not satisfy the constraint 'true'`（schema 枚举 ↔ 类型的类型级断言）。这正是「判别联合带穷尽性断言」那句话的机器形态。
3. **淘汰条件改成「无单位**或**无基地」**（`if (hasUnit || hasBase)` → `if (hasUnit && hasBase)`）→ `pnpm exec vitest run --project unit outcome.test.ts`:`3 failed | 15 passed`;主红是「a) 淘汰条件是「与」…」:`expected [ true, false, false, false ] to deeply equal [ true, true, true, false ]`（有兵无基地、有基地无兵的两席被误淘汰),另两条是同一改动的连带（它们的构造也各少了座位）。
4. **（自选）把并列名次改成逐位不同名次**（`competitionRanks` 一律 `index + 1`）→ `pnpm exec vitest run --project unit outcome.test.ts`:`5 failed | 13 passed`;读数 `expected [ 2, 3, 1, 4 ] to deeply equal [ 2, 3, 1, 3 ]`、`[ 1, 2, 3, 4 ]` vs `[ 1, 1, 1, 1 ]` / `[ 1, 2, 2, 2 ]`。它钉住的是 gdd 第 4 条「仍完全相同 → 并列同名次（名次数字按并列人数跳过）」。

### 门禁与用例读数

- `pnpm exec tsc -b packages/schema` 后 `pnpm run generate`:六件生成物「已是最新」,无新增改动（本票的 schema 改动不投影进生成文档）。
- `pnpm run check` → `CHECK EXIT=0`:`oxfmt --check` 全过、`oxlint`(含 type-aware)无错、`check:no-float` 33 文件无违规、`vitest run --project unit --project property` **615 passed (615)**、`depcruise` 98 模块 189 依赖无违规、`check:declared-deps` 43 文件无未声明引用、`check:drift` 6 件无漂移、`check:bench` 绿。
- 本票新增/改写的用例:`processor/outcome.test.ts`（15 条,含 algorithm、四段判据、`all-eliminated`、步 0 跳过、步 7 超时）、`validator.test.ts` 的回放 `result` 一节（8 条 + 一条类型级断言）。
