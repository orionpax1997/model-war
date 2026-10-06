# 12: 文档对账与欠账销账

**What to build:** 本 feature 的实现与 spec 里那份「要一并修正的设计文档」清单逐行对账。每一行要么被改掉、要么被记下原因——**没有「实现改了但文档没改」这种收尾**,因为那份清单里的每一格都是一个会误导后来者的第二家。

**对账清单**(来自 `.scratch/engine-core/spec.md` 末节):

| 文档 | 改什么 |
|---|---|
| 架构文档的状态模型字面量 | 删 `productions: Production[]`,点位上加 `producing` |
| 架构文档的 tick 行栏位 | 删 `productions` 栏 |
| 架构文档的 meta 行 | 加 `runner` 栏,并写明四个沙箱栏在桩执行器下为 `null` |
| 架构文档的事件流那一段 | 补首触判据的指针与规则侧那笔欠账 |
| 架构文档的读入端覆盖面那一段 | 规则集装载接线完成后,「按尚未兑现记」改掉 |
| 架构文档的冻结脚本存档那一段 | 明确「runner」指第一个执行脚本的进程 |
| 架构文档的 API 误用那一行 | 承载方落实为类型面,指向那份 ADR |
| 架构文档的两个工程侧开放项 | 补上本票出的读数作为它们的输入,并标注观测项不是承诺 |
| 契约面的快照声明那一段 | 「这一段是契约侧的声明,目前还没有对应的投影」改掉——投影已经回来了 |
| 真源包的待回填清单 | 三条全部销掉,各自改写成「形状已定」 |
| 真源包的符号表头注 | 15 条签名由声明面取代;「刻意为空,回填触发条件是沙箱执行器」那段按 ADR 要求改掉 |
| 里程碑 DAG 的 F 行 | 状态从「待拆票」改成已收口,并把两处与原记载不同的裁(唯一外部缝、复算那一格归沙箱执行器)留在图上 |
| 「读入端强制校验覆盖面只有两类」那段 | 覆盖面从两类扩到四类(存档元数据 / 对局输入 / 回放行 / 终局结果),逐类写清有没有接线 |

**最后一行是本票最容易被跳过的一条**,而它恰是最会骗人的那一行:那一段的原话是「刻意的不完整,不是半成品」,它今天还成立(只有规则集与地图两类真正被校验);本票之后它**仍然不完整**,但理由变了(剩下三类要等生成管线与赛季那两格)。**理由变了而文字不变,就是一处假账。**

**Blocked by:** 11（确定性验收、首触复核与读数）

**Status:** resolved

- [x] 清单每一行都被处理,并在 spec 末尾那张表上逐行标注「已改 / 有意不改 + 原因」。**有意不改的行要写原因**,不能留空 → 证据:`.scratch/engine-core/spec.md` 末节表加了「处置」列,逐行标注;另附「有意不改的行 + 原因」(5 条),并把票 01–11 的偏差一并收进同节
- [x] 里程碑 DAG 的 F 行改成已收口,并把两处与原记载不同的裁留在图上:唯一外部缝是那一道主缝、处理器的 tick 缝是私有内部缝不进导出面;复算那一格归沙箱执行器 → 证据:`docs/diagrams/v0-milestone-dag.md`(mermaid 节点、节点表、当前 frontier、当前位置、classDef 五处改 ✅;F 行明写「外部缝唯一是 `runMatch`,`processTick` 是私有内部缝不进导出面」「复算那一格(`modelwar verify`)归沙箱执行器 G」)
- [x] 里程碑 DAG 的图重画(那一格有配套 PNG,PNG 与 mermaid 源要一起更新,不能让其中一份单独过期) → 证据:`mmdc -s 2 -i docs/diagrams/v0-milestone-dag.md -o docs/diagrams/v0-milestone-dag.png` 成功输出 `v0-milestone-dag-1.png`(1568×2598,与入库图同尺寸,与改后源同批提交)
- [x] 「读入端强制校验覆盖面」那一段:覆盖面变了就改覆盖面,**并把「为什么不完整」的理由一起改**。理由不变而覆盖面变了,是本仓明确点名要拒的那类假账 → 证据:`docs/hld.md:151` 重写:逐类(规则集 / 地图 / 存档元数据 / 对局输入 / 回放行 / 终局结果)写清接线;理由改成「⑤⑥ 等赛季 I、③ 等生成管线 H」
- [x] 真源包待回填清单里三条全部销掉,改写成「形状已定 + 值的时机」;**不新加条目**(对局输入那份形状本就不属于待回填那一类,理由逐字写进注释) → 证据:票 01/09 已销,`PENDING_SHAPES = []`、`PendingShapeId = never`;本票核对头注自洽,未加条目
- [x] 契约面那段「还没有对应的投影」改掉,并且**核一遍契约面与类型面逐字段一致**——投影回来了,它就不再是承诺 → 证据:`docs/rules-v1/api.md:148-156` 重写;新增 `packages/tools/src/api-doc.test.ts` 的断言,核 §2.1 的 `Player`/`Unit`/`Site` 字段名与序与类型面逐字段一致(机器核对)
- [x] 规则侧首触那一段的复核读数已在本票 11 写入;本票只核它**没被顺手改成「墙是杠杆」**那类与墙无关的结论 → 证据:`docs/gdd.md:123` 段首仍是「**墙不是首触的杠杆**」、复核结论仍是「墙不改变首触」,未动一字
- [x] 两份 ADR 的链接从里程碑 DAG 与本 feature 的 spec 都可达;ADR 本身**一字不改** → 证据:DAG F 行链 `adr/0005`、`adr/0006`;spec 里三处裸路径改成 markdown 链接(0004/0005/0006);`docs/adr/*.md` 未改
- [x] 一条反向核对:清单里任何一行若在实现里走了另一条路,要么改实现要么改这一行并写明理由——**不许两边各留一份** → 证据:spec 末节「反向核对」段;逐条核过,**无一行是「走了另一条路而文档不改」**
- [x] 全部机器门禁绿:格式、lint、类型、耦合、禁浮点、声明依赖、生成物漂移、基准产物逐字节可复现。最后一条尤其要跑:基准产物读的是入库的编译脚本,本 feature 改了状态模型形状,若那些产物走的是受影响的路径,这条会先红 → 证据:`pnpm run check` **EXIT=0**(见 Answer 的读数;`check:bench` 3 份逐字节一致)

## Answer

### 改动文件清单

| 文件 | 改了什么 |
|---|---|
| `docs/hld.md` | 状态模型(`productions[]` → `Site.producing`,删 `Production`,补 `Outcome.reason` 第四档)、tick 行删栏、meta 行加 `runner` 并说明桩下四栏为 `null`、事件流补 `first-contact` 判据指针与 gdd 欠账、`:151` 覆盖面重写、`§7.4` 两行(形状已定+读入端已接线;runner 消歧)与 `:721` 哈希口径、`:632` API 误用承载方、开放项 #6/#7 补读数 |
| `docs/rules-v1/api.md` | `:148-156` 那段「还没有对应的投影」改写成「类型面的一份投影」 |
| `docs/diagrams/v0-milestone-dag.md` | F 行五处改 ✅、L 行与 `F ⇢ L` 边按票 11 修正、frontier 换 G、wave 4 改 ✅ |
| `docs/diagrams/v0-milestone-dag-1.png` | 与改后 mermaid 源同批重渲染(1568×2598) |
| `.scratch/engine-core/spec.md` | 末节表加「处置」列逐行标注 + 「清单外偏差与反向核对」段;三处 ADR 裸路径改 markdown 链接 |
| `packages/tools/src/api-doc.test.ts` | 新增一条断言:契约面 §2.1 快照形状与类型面逐字段一致 |
| `packages/tools/src/script-api-type-surface.test.ts` | 快照字段探针补读 `producing.type`(契约面承诺的嵌套字段) |

真源包两份(`pending.ts` / `script-surface.ts`)**只核未改**(票 01/03/09 已落)。未跑 `pnpm run generate` 有漂移:六件生成物「已是最新」。`fix:runMatch` 引擎实现、`rulesets/*`、`maps/*`、`docs/adr/*.md` 一字未动。

### 11+13 行清单的逐行处置

| 清单行 | 处置 |
|---|---|
| 状态模型字面量(hld:414) | **已改**:`Site` 加 `producing: { type; remainingTicks } \| null`、删 `productions[]` 与 `Production`;顺带把同块的 `Outcome.reason` 补上第四档 `'all-eliminated'`(票 09 取值,原注释停在三档) |
| tick 行栏位(hld:728) | **已改**:删 `productions` 栏 |
| meta 行(hld:726-727) | **已改**:列上 `runner`;补「`runner` 是判别式,`stub` 四栏全 `null`」 |
| 事件流那段(hld:734) | **已改**:补 `first-contact` 判据(Chebyshev ≤ 2、整局一条)是观测量、精确定义欠账在 gdd |
| 读入端覆盖面(hld:151) | **已改**:六类逐类写接线,「为什么不完整」理由一并改 |
| 冻结脚本存档段(hld:714-715) | **已改**:`:719-720` 重写,「runner」消歧为第一个执行脚本的进程;`:721` 哈希口径写清 |
| API 误用(hld:632) | **已改**:承载方落实为类型面本身 + 链 ADR-0006 |
| 开放项 #6/#7(hld:820-821) | **已改**:补读数(0.307/0.245 ms;2 388 636 B、3 981.1 B/tick)+「观测项不是承诺」 |
| 契约面快照声明(api.md:148-156) | **已改**:「还没有对应的投影」改掉;并加机器断言核逐字段一致 |
| 真源包待回填清单(pending.ts) | **已改(票 01/09)**:三条全销、`PENDING_SHAPES = []`;本票核对自洽 |
| 真源包符号表头注(script-surface.ts) | **已改(票 03)**:15 条 `signature` 删除、头注改单向投影;本票核对自洽 |
| 里程碑 DAG F 行(+ PNG) | **已改**:五处改 ✅、两处裁留下、L 行/`F ⇢ L` 边按票 11 修正、PNG 重渲染 |
| 「覆盖面只有两类」那段 | **已改**:与 hld:151 同一处 |

**有意不改的行 + 原因**(逐条写原因,不留空):

1. **`archive-meta.validation` 取 `{passed, errors}`、`generatedAt` 只 `minLength: 1`**(票 01 记的取值级差):hld §7.4 对这两项只写「校验结果」四个字,没写字段形状;形状的家在 `packages/schema/src/archive-meta.ts`。写进 hld 会让它变成真源的第二个家。**不改**。
2. **规则集缺「能不能采集」这一栏**(票 07 的契约面缺口,`harvestRate` 是速率不是资格):这是真缺口不是措辞差,归契约面那一轮(与 `rules.md` §5 一起);本 feature 改不了规则面(`rulesets/*` 不动)。**不改**,指针留在 `processor/economy.ts` 与票 07 的 Answer。
3. **hld §4.2 vs §7.5(无效 intent vs 八种事件)**:§4.2 说无效 intent 写入事件流,§7.5 八种事件无此类;实现按后者(票 04 静默丢弃,不加第九种事件)。改它要动机制表述或跨进程形状,不在本 feature 范围。**不改**,指针在票 04 的 Answer。
4. **`docs/rules-v1/rules.md` §5 占位**:规则侧下一轮的事(这笔在 gdd §8 记为 #14);`rules.md` 的生成区块本票不碰。**不改**。
5. **`packages/replay` 再导出真源包类型**:更干净是给 engine 补一条 `@model-war/schema` 声明依赖;这处工程结构小欠账不改任何可观察行为,动它会牵动包图与门禁,归后续。**不改**。

### PNG 重渲染的实际结果

**成功。** 票面建议的命令 `mmdc -i … -o docs/diagrams/v0-milestone-dag.png` 默认 scale=1,产出的图是 **784×1299**,与入库的 **1568×2598** 不是同一尺寸。加上 `-s 2` 后复现同尺寸:

```
mmdc -s 2 -i docs/diagrams/v0-milestone-dag.md -o docs/diagrams/v0-milestone-dag.png
```

输出 `v0-milestone-dag-1.png`(mmdc 对 markdown 输入自动追加 `-1`,这正是入库文件名带 `-1` 的来源),1568×2598,与改后源同批提交。**PNG 与 mermaid 源一起更新,没有一份单独过期。** 因此「PNG 未能重渲染」这条有意不改**不成立**。

### 四类覆盖面的逐类接线实况(与「为什么不完整」的新理由)

去实况读的四处:`apps/cli/src/validator.ts`、`apps/cli/src/match/index.ts`、`apps/cli/src/commands.ts`、`packages/replay/src/render.ts`。

| 类 | 形状(真源包) | 读入端校验器 | 接线实况 |
|---|---|---|---|
| 规则集 | `ruleset.ts` | `validateRuleset` | **已接线**:`match/index.ts` 装载段调用,版本三处不一致即拒跑 |
| 地图 | `map.ts` | `validateMap` | **已接线**:`map-lint` + `match` 两处 |
| 存档元数据 | `archive-meta.ts` | `validateArchiveMeta` | **已接线**:`match/index.ts` 逐座位调(缺档/哈希/轮数) |
| 对局输入 | `match-input.ts` | `validateMatchInput` | **已接线**:`match/index.ts` 装载段调(版本/四座位存档/各文件哈希) |
| 回放行(meta/tick) | `replay-line.ts`(含两份 JSON Schema) | **无** | **未接线**:读盘渲染器住 `@model-war/replay`,只 `JSON.parse` 后防御式读栏,不跑 schema |
| 终局结果(result) | `replay-line.ts` | `validateReplayResultLine` | **未接线**:纯函数已交付 + 用例,无生产调用点 |

**新理由**:上一版缺的是「字段未回填」,本 feature 之后六类形状全落库,缺的只剩接线与一处值——**⑤ 回放行 与 ⑥ 终局结果**的形状/JSON Schema 都已生成,缺的是**读入端调用点**:读盘渲染器住 `@model-war/replay`(依赖方向 `schema ← replay`),不能反向依赖持有唯一 ajv 实例的 `apps/cli`,接线归「回放读入端校验归哪一层」的裁定,等**赛季调度 I**(回放的正式消费者与报告路径);**③ 存档元数据**的形状与读入端都已到位,但它记的**字段值**由**生成管线 H** 写出,H 落地后才第一次校验到真实存档产物。合起来:**剩下三类等生成管线 H 与赛季 I**。理由与覆盖面写在同一段(`hld.md:151`),没有「理由不变而文字变」。

### 两份 ADR 是哪两份、链接补在哪

本 feature 新开的是 **ADR-0005**(`docs/adr/0005-runner-seam-is-the-two-bridge-calls.md`)与 **ADR-0006**(`docs/adr/0006-script-api-type-surface-lands-in-engine.md`)。两份链接从**里程碑 DAG 的 F 行**(`adr/0005`、`adr/0006` 两处相对链接)与**本 feature 的 spec**(本票把 `docs/adr/0004`、`0005`、`0006` 三处裸路径改成 markdown 链接)都可达。`hld.md:632` 提到的编号是 **ADR-0006**,核对无误——票 03 一度撞号新开的 `0004-script-tsconfig-and-injection-surface.md` 已删,未重现。**`docs/adr/*.md` 一字未改。**

### 契约面与类型面的逐字段对照(做法与结果)

- **契约面** = `docs/rules-v1/api.md` §2.1 那段手写的 `type Player / type Unit / type Site`; **类型面** = `packages/schema/script-api/index.d.ts`。
- **做法**:新增一条机器断言(`packages/tools/src/api-doc.test.ts`,该文件本就是「文档 ↔ 机器」对照的宿主):把两边的 `type X = { … }` 块抽出成员名与序,逐个 `toEqual`。比**字段名与序**而不比逐字文本——两边本就有意的写法差(契约面 `owner: 0|1|2|3` / 类型面 `owner: PlayerIndex`;契约面把产线订单内联、类型面拆成具名 `SiteProduction`),逐字比会把它们全判红。
- **结果**:`Player` / `Unit` / `Site` 三个块的字段名与序**两边逐字段相同**(Site 九栏含 `remaining` 与 `producing`)。另外 `script-api-type-surface.test.ts` 的探针原来已逐个读快照字段,本票补上 `producing.type`,让嵌套的那一栏也被编译期读一次。

### 反向核对(逐条处置)

- **没有一行「实现走了另一条路而文档不改」。** 唯一措辞级差异是上面「有意不改 #1」(`validation` 取 `{passed, errors}`、`generatedAt` 只 `minLength: 1`),它落在 hld 没写死的地方,不构成「两边各留一份」。
- **`runMatch` 终局行(票 02 vs 09)**:票 02 说「票 09 落地后这一行不用改」;核过票 09 确实只把兜底支换成直接用 `state.outcome`(票 09 Answer §4.1),一致,无第二家。
- **`input.json` 哈希口径(票 01)**:hld:721 原文「各文件 hash」含糊,实现取三处(两存档 + 地图,不含 `script.ts`),座位由 `archives` 下标承载。本票把 `hld.md:721` 写清,消掉这处「第二个家」。
- **hld:719 那句「读入端不校验它」已过时**:本票改掉(形状已定 + 读入端已接线)。

### 门禁读数

`pnpm run check` → **EXIT=0**(`/tmp/t12-check.log`):

- `fmt`:`All matched files use the correct format`;`oxlint` 无错;`coupling` ok;`check:no-float`「检查 41 个文件,无违规」
- `tsc -b` + `oxlint --type-aware` 过
- `vitest run --project unit --project property`:**60 files / 676 tests 全过**
- `check:deps`:**111 modules, 233 dependencies, no violations**
- `check:declared-deps`:43 文件,已声明 2 个依赖,无未声明引用
- `check:drift`:注册 6 件,**无漂移**
- `check:bench`:**3 份逐字节一致**(8831 / 7209 / 5850 B)
- 格式:改动文件已 `pnpm exec oxfmt`

**`check:bench` 的那条点名项**:在新建的 worktree 上**先空跑 `pnpm run check:bench` 会红**,但原因不是状态模型形状,而是 `packages/*/dist` 尚未构建(`ERR_MODULE_NOT_FOUND: packages/tools/node_modules/@model-war/schema/dist/index.js`)。`pnpm run check` 内含 `check:types`(先 `tsc -b`),构建后再跑 `check:bench` 即绿——**基准产物走的是入库的编译脚本,没有被状态模型形状改动踩到**。没有为让门禁变绿而改任何判定逻辑。

### 给后续票的话

**给 L(门禁 / 流水线 / 性能与存储)**:
- 读数文件在 `.scratch/engine-core/readings.md`(每 tick 体量 3 981.1 B/tick、`buildSnapshot` 0.307 ms、只 `structuredClone` 0.245 ms);两项在 hld §12 #6/#7 已标「观测项不是承诺」,**停止条件归 L**。
- 三条桩结论的夹具宿主在 `packages/engine/src/fixtures/`(`harness.ts` + `depletion.ts`/`endgame.ts`/`cavalry.ts` + `fixtures.test.ts`);放大规模用 `MW_FC_N=64 MW_DEP_N=8 MW_EG_N=4 MW_CAV_N=4`。
- 十次重跑 hash 的接线位置是 `packages/engine/src/determinism.test.ts`(已在 check 链上);L 的集成门禁要在**跨进程 / 真脚本**这一层再跑同一判据(L 的定义含 `verify`)。
- 量不到的缺口:#10 的「骑兵伤害份额」需要给回放加战斗统计栏;#7 的「拉满经济剖面」当前代理够不到 50% 枯竭。

**给 G(沙箱执行器与预算裁决)**:
- **唯一外部缝是 `runMatch`**;**`processTick` 是私有内部缝,不进包导出面**;不要从 CLI 或赛季调度直接依赖它。
- **复算那一格(`modelwar verify`)不实现,归 G**(它要重新执行真脚本);`match-result` 与回放行形状已定,可直接接。
- **类型面(形状)归 F、注入面(名字铺放时机、桥删除时机)归 G**,同源于一份形状;G 若发现某名字在类型面里而铺不出来,那是 G 的缺陷,不是「类型面漏了」。
- `sandbox-runtime.ts` 的桩哈希换成真产物;`validateReplayResultLine` 的读入端接线也归「回放读入端校验归哪一层」的裁定。

### 潜伏红修复:门禁自测里那条被 engine 的 `Math.abs` 用法弄红的期望

**这不是实现有 bug**——白名单(`ALLOWED_MATH_MEMBERS`,判据「整数入整数出」)没错,engine 代码也没错(过门禁 0 违规,用例第 1 条断言就是证据)。**错的只有那条自测的期望**。修的是 `packages/tools/src/gates.test.ts` 一处;名单内容、engine 业务代码、门禁脚本(`run-no-float-gate.ts`)判据一字未动。

**那条红是什么**:用例「生成器:改真源重跑后,禁浮点门禁的白名单判决随之改变」把真源 `packages/schema/src/builtin-globals.ts` 里的 `"abs",` 摘掉 → 重跑生成器 → 放一个用 `Math.sign` 的探针 → 跑 `check:no-float`,第 3 条断言 `stillAllowed.status === 0` 失败(原 `:320`)。

**为什么红**:第 3 条隐含前提是「engine 源码里一处都不用 `Math.abs`」。而 engine 源码现有 **6 文件 12 处**用 `Math.abs`(`pathfinding/find-path.ts:86`、`processor/combat.ts:105`、`processor/economy.ts:85`、`processor/movement.ts:96`、`processor/steps/step2-movement.ts:106`、`fixtures/strategies.ts:37`),摘掉 `abs` 后它们本来就该被判违规,整道门禁因此无论如何都退非零。原报错文案「名单内的其他成员被连坐」是**误诊**:被报的恰恰就是被摘掉的那个成员。

**谁引入的**:`Math.abs` 首次进 engine 源码是**票 04**(`996de72`),所以这条自测**从票 04 起就是红的**。**为什么一直没被发现**:本 feature 迭代期按约定只跑 `check` 与 unit+property、不跑 `gates`,直到收尾全量 `pnpm run test` 才暴露。

**选了 A,并配上 B 的那条断言当自证(即 A+B)**:把「被摘掉的成员」从 `abs` 换成 engine 源码**一处都不用**的 `clz32`(动笔前实测:`packages/engine/src` 下 `clz32` 零命中)。这样第 1–3 条断言(放行 / 拒绝 / 仍在名单里照旧放行)原样保留,原意图「变红的是『白名单』,不是整道门禁」1:1 成立,不必把 `status === 0` 降级成文本断言。

A 的隐含前提(所选成员零使用)用一条**前置自证**盯住:在 `removed` 那次门禁输出里,断言被判违规的文件**恰好只有探针文件**(`violatingFiles(...)` 去重后 `toEqual([NO_FLOAT_PROBE])`)。若哪天 engine 源码开始用 `clz32`,这条会以清楚的处方红掉——「engine 源码里已经用上了 `Math.clz32`,这条反例该换成员了」——而不是以「名单内的其他成员被连坐」误导后来者。顺带把原第 3 条的误导文案改掉,写清「摘掉的是 `clz32`,`sign` 没动」。

**三条反例读数**

1. **修前(基线)**:`pnpm exec vitest run --project gates -t "生成器:改真源重跑后"` → `Test Files 1 failed | Tests 1 failed | 29 skipped`,报错原文 `AssertionError: 名单内的其他成员被连坐:` + 12 处 `Math.abs` 违规(6 文件)+ `expected 1 to be +0`(`/tmp/gate-baseline-red.log`)。
2. **把第 3 条要证明的东西弄红一次(A 版)**:临时在 `packages/engine/src/pathfinding/find-path.ts` 尾部加 `export const __clz32PreconditionProbe = Math.clz32(1);`(破坏「所选成员零使用」的前提)→ 同一条用例红,报错 `AssertionError: engine 源码里已经用上了 \`Math.clz32\`,这条反例该换成员了:…`,并列的两个违规文件 `["packages/engine/src/__nofloat-probe.ts", "packages/engine/src/pathfinding/find-path.ts"]`——**报错清楚指向「换成员」,证明自证不是空断言**。完后 `git checkout` 还原,工作树干净(`/tmp/gate-counter2.log`)。
3. **修后正向(绿)**:同一单测入口 → `Tests 1 passed | 29 skipped`,第 3 条对仍在名单里的 `sign` 确实放行(整道门禁退 0);全量 `pnpm run test` 里该用例也过(见下)。

**修后读数**

- `pnpm run check` → **EXIT=0**;**`pnpm run test` → EXIT=0**,`Test Files 61 passed (61) | Tests 706 passed (706)`(修前是 `Test Files 1 failed | 60 passed` / `Tests 1 failed | 705 passed`)。落盘 `/tmp/gate-check.log`、`/tmp/gate-test.log`。未跑 `test:slow`。
- 改的文件:`packages/tools/src/gates.test.ts`(抽出 `NO_FLOAT_PROBE` 常量单点化探针路径、`REMOVED_MEMBER = "clz32"`、`violatingFiles` 助手、用例四条断言)。

每次探针跑完 `git status` 均为干净(只余本提交的 `gates.test.ts` 改动)。

### 收口:双轴 code review 的发现与处置

固定点:本地 `main` = `15d8e65`(本 feature 的分支点)。两轴 review 跑完后按下述收口。**本节只做两件事**——把散文/注释用词改回 `CONTEXT.md` 的词汇表纪律,以及记下这笔账;不改业务逻辑、不改任何断言、不动门禁。

#### 1. Spec 轴唯一发现「范围蔓延」——主线程已处置

- review 报 `AGENTS.md` 与 `.pi/subagents-lite.json` 两份**不属本 feature** 的文件混进了改动面。根因:合并提交 `caeb67a` 用了 `git add -A`,把工作树里这两份**用户本地改动**一并卷了进来。
- **处置(主线程完成)**:一个 revert 提交把这两份**在版本库里还原成 `main` 的版本**,于是本 feature 相对 `main` 对这两个文件的**净差异为零**(`git diff main...HEAD --name-only` 已不再含它们);用户本地的工作树(主 checkout)里的那两份改动**原样保留(未提交)**,既没丢也没被提交。
- 本票如实记这笔账,**不动这两份文件**。

#### 2. Standards 轴:4 处散文叫法漂移(引 `CONTEXT.md` 词汇表)逐条改

纪律来源:`CONTEXT.md` 定 `对局`(一场完整的四人对战,**在本项目只有这一个叫法**,`_Avoid_`: 场次、单场、比赛)与 `叙事战报`(一场对局的散文叙述,`_Avoid_`: 战报裸用、报告);`docs/agents/domain.md` 要求「用词汇表用语」。改动只落在注释散文,**未碰任何标识符/断言/字符串字面量**。

| # | 位置 | 改前 | 改后 |
|---|---|---|---|
| 1 | `packages/engine/src/fixtures/harness.ts:2,3,14` | 「`runMatch` **单场**是引擎唯一的粒度」「一批**场次**的分布」「把**单场**包起来」「不是**单场**的一次读数」 | 「`runMatch` **一个对局**是引擎唯一的粒度」「一批**对局**的分布」「把**一个对局**包起来」「不是**一个对局**的一次读数」 |
| 2 | `packages/engine/src/fixtures/cavalry.ts:8` | `` 席位(场次) `` | `` 席位(对局) `` |
| 3 | `packages/engine/src/replay-writer/tick-line.ts:15` | 「渲染器与**战报**都得先判它」 | 「渲染器与**叙事战报**都得先判它」 |
| 4 | `packages/engine/src/run-match.test.ts:86` | 「空数组会被**战报**读成『打完了』」 | 「空数组会被**叙事战报**读成『打完了』」 |

#### 3. 同一改动面里搜出的同类命中与逐条处置

范围与手法:按 `git diff main...HEAD --name-only | grep -E '\.(ts|md)$'` 圈定本 feature 的改动面(108 个现存文件),全文搜 `单场 / 场次 / 比赛 / 裸战报 / 词汇表其它 _Avoid_ 词`。reviewer 只抽查了 4 处,以下是把同类一次搜净。

**改了**(真在说「一个对局」却写「单场/场次」,或裸用「战报」):

- `packages/engine/src/replay-writer/tick-line.ts:19`「**战报**只消费 `events`」→「**叙事战报**只消费 `events`」。
- `packages/engine/src/replay-writer/tick-line.test.ts:89`「而**战报**只消费 events」→「而**叙事战报**只消费 events」。
- `packages/engine/src/processor/events.ts:13`「历史回放里的一段**战报**」→「一段**叙事战报**」;`:35`「回放与**战报**共同读的」→「回放与**叙事战报**共同读的」。
- `packages/schema/src/replay-line.ts:134,354`「回放与**战报**共同读的」→「回放与**叙事战报**共同读的」(两处)。
- `.scratch/engine-core/issues/02-spine-empty-match-to-timeout.md:53`「渲染器与**战报**当成…」→「渲染器与**叙事战报**当成…」。
- `.scratch/engine-core/issues/10-state-invariants-and-counterexamples.md:9`「就是**战报**稳定性的全部」→「就是**叙事战报**稳定性的全部」。
- `.scratch/engine-core/spec.md:48`「**战报**与报告给出的时刻」→「**叙事战报**与报告给出的时刻」;`:161`「**战报**生成器只消费事件」→「**叙事战报**生成器只消费事件」。
- **度量名里的「单场」漂移**(与 `docs/srs.md` 的「每个**对局**的平均墙钟耗时」对齐):`.scratch/engine-core/issues/11-determinacy-first-touch-rerun-and-readings.md:30,128`「单场平均墙钟」、`:93`「`runMatch` 单场粒度」;`.scratch/engine-core/readings.md:54`「单场平均墙钟」;`.scratch/engine-core/spec.md:305`「单场墙钟」;`docs/diagrams/v0-milestone-dag.md:173`「NFR-3 单场墙钟 X」——全部改成「对局……」。

**判为正当提及 / 有意不改**(逐条理由):

- `packages/engine/src/fixtures/endgame.ts:6`「桩 `tables.mjs` §1.4 … 印成一行:**场次**、`结局 tick 中位`…」——逐字转写 legacy 桩 `tables.mjs` 的**列名**(桩源码写死 `| 矩阵 | 场次 | …`),属「名字」而非本项目的散文叫法;改了会与桩输出不符,按 `CONTEXT.md` 的「区分叫法与名字」保留。
- `docs/gdd.md:240`「最坏**单场**」——任务限定 `docs/gdd.md` 不碰。
- 子命令名 / 目录名 / 英文残留(`modelwar match`、`matches/`、`match`、`Match*` 标识符)——词汇表明写「名字,改不动也不该改」,一律不动。
- 已经写全「叙事战报」的全部命中(`docs/hld.md` 多处、`packages/engine/src/processor/state-invariants.test.ts:335`、`issues/07-…md:7` 等)——不改。
- 词汇表其它 `_Avoid_` 词:`docs/hld.md:570`「控制流事件计数**而非指令计数**」、`:520`「不回退**逐函数注入**」——两处都是**拿被弃术语当对立面**的正当提及,不改;「经济失败」「OOM 事件判据」以及「比赛」在本改动面零命中。
- 含「场」的**量词 / 复合**用法(`一场对局`、`全场`、`每场`、`几场`、`同场`、`多场跑批循环`、`n 场`)——不在 `_Avoid_` 词表(词汇表自己定义 `对局` 就写「**一场**完整的四人对战」);按「判据是词汇表不是口味」不改。
- 跨称复核:`回放` 与 `报告` 之间**没有互称误用**(逐处读过,均为层级上的正当用法)。

#### 4. 两处结构性欠账:复核后维持原判

两轴都判为「有意偏离、不计新发现」的两处,票面已各记「有意不改 + 原因」:

- **`packages/replay` 把真源包类型原样再导出**(让 `engine` 绕开 manifest 里的 `@model-war/schema` 声明):票 12 的「有意不改 #5」已记「更干净是给 engine 补声明依赖;这处不改任何可观察行为,动它会牵动包图与门禁,归后续」。
- **`packages/engine/src/fixtures/` 是一层只有测试用的跑批 harness,却住在 engine 包的非测试源码里**:票 11 的 Answer 已记落点与理由(能 import 引擎的只有 engine 自己与 `apps/cli`;`packages/tools` 进去放夹具会被 `check:declared-deps` 拦,落点只能是 engine)。

**本次 review 复核后维持原判**:两处都不是要就地改的东西,保持票面已记的落点。

#### 5. 修完的门禁读数

- `pnpm run check` → **EXIT=0**(`/tmp/fix-check.log`):`fmt`「All matched files use the correct format」;`check:no-float`「检查 41 个文件,无违规」;`vitest run --project unit --project property` → **60 files / 676 tests 全过**(与基线一致——本收口未动逻辑);`check:deps`「111 modules, 233 dependencies, no violations」;`check:declared-deps`「43 文件,已声明 2 个依赖,无未声明引用」;`check:drift`「注册 6 件,无漂移」;`check:bench`「3 份逐字节一致」。
- 未跑 `pnpm run test` / `test:slow`;改动文件已 `pnpm exec oxfmt`。
