# 02: 脊柱——空转一整场到超时,回放端到端可渲染

**What to build:** 全仓库最想按一下的那条命令。`modelwar match <input.json>` 在进程内用桩执行器跑完一个对局,按 `hld` §4.3 的结算管线把每一步空转过去,在第六百个 tick 触发超时判定,产出一份逐 tick 的 JSONL 与末行 `result`;`modelwar replay` 把那份回放渲染成 ASCII 画面。本票不实现任何一条游戏机制——它实现的是**那条路本身**,以及路上每一层的形状与纪律。

这一票是**全 feature 唯一的对外缝**。`processor`、六个 intent、快照、规则集装载全部藏在它后面;`processTick` 是处理器自己的**私有内部缝**,不进包的导出面,调用方与测试不学它。依据是「一个模块一个接口」:让 `processTick` 变成第二道对外缝,赛季调度与 CLI 就会开始依赖它,引擎的接口面积翻倍、深度减半。

**六个 intent 各自有且只有一个实现,所以它们不构成缝。** 把六个 intent 做成六个带公开接口的模块是六条浅缝——接口面积大、实现小,调用方要学的东西多于它拿到的能力。真正变的东西只有执行器一处,所以缝只有一道。

**执行器缝照 `hld` §4.5 原样交付**:`__setSnapshot` 进、`__drainIntents` 出,中间不设任何表示(见 `docs/adr/0005-runner-seam-is-the-two-bridge-calls.md`)。

**这张票是本 feature 最大的一张。** 若一个上下文窗口装不下,按「先半后半」切开:前半交输入装载、状态模型、快照边界与规则集装载接线;后半交七步骨架、事件、发出与两条子命令接线。切点写进本票的 `## Answer`,不要静默缩小验收。

决策依据：`.scratch/engine-core/spec.md`《交付面》《进程退出码》《状态模型》《执行器》《模块的深度》《结算管线》《快照边界》《`stateHash`》《meta 行》《规则集装载期校验接线》各节。

**Blocked by:** 01（冻结脚本存档与对局输入的形状定死）

**Status:** resolved

- [x] 规则集装载期校验接线:**生产路径**读入规则集并调那一侧唯一的校验器,版本三处对不上即拒(hld §7.1 自陈的那笔账:「被校验过不等于被装载时校验过」在本票销掉) → `apps/cli/src/match/index.ts:225` 调 `validateRuleset(取值, { rulesetFileName, rulesDocDirName })`;版本三处一致(版本常量 / 取值文件名 / 规则文档目录名)由 01 票那条 `rulesetProvenanceDiagnostic` 判,对不上即拒(退出码 2),**引擎不重复判也不静默降级**(理由:那两个名字要读盘才知道,engine 拿不到)。实测:把 input.json 里声明的版本改成 v2 → 退 2(`cli.test.ts`「`match` 装载期拒跑」一组的 `ruleset` 那一态)
- [x] 状态模型:`Site` 上有 `producing` 与 `remaining`,**没有** `Production` 类型,状态里**没有** `productions[]` → `packages/engine/src/world/state.ts:86,88`:`remaining?: number` 与 `producing: SiteProduction | null` 挂在 `Site` 上;全仓 grep 无 `Productions` 类型/字段。理由写在 `state.ts:6` 起:契约面 `api.md` 已宣告「字段名在这段声明期间不改」,而 hld §4.1 当年写的是 `productions: Production[]`——选「状态直接长成契约承诺的形状」,因为快照已裁定为深拷贝,一引入投影就多一层要同步的表示(新的漂移面)
- [x] `id` 全局单调递增(**含被销毁对象**),一切「按对象处理」的阶段按**数值 id 升序**迭代。数值升序是唯一被声明的定序语义 → `packages/engine/src/driver/id-gen.ts`(`allocateId` / `peekNextId`,号不回收,头注逐字写了这一点);状态模型在 `world/state.ts` 的 `GameState` 头注里把「`units`/`sites` 按数值 id 升序**维护**(不是只在写出前排一次)」写成不变量,并由 `processor/step-order.test.ts`「对象数组每 tick 结束时按数值 id 升序维护——断言的对象是状态本身」钉住(断言的是 `state.sites`/`state.units`,不是写出的行)
- [x] `apply()` 是**唯一**写入口;一切数值不出现结构中,统一从规则集装载 → `packages/engine/src/driver/apply.ts:2`「`apply()`:状态的唯一写入口」,并把「唯一写入口」这句从约定改成**类型可查**(状态一切字段 `readonly`);一切数值(HP/造价/速度/阈值/上限)在 `world/state.ts` 头注明写「一个都不出现在本文件里,由 `rulesets/*.json` 装载」
- [x] 快照 = 状态的**深拷贝**:每 tick 一次深拷贝 + 一次**深** freeze(同一次递归遍历),四个座位共用这一份只读快照。**引擎真状态永不 freeze** → `packages/engine/src/snapshot/snapshot.ts`:`buildSnapshot` 一次 `structuredClone` 再同次递归深 freeze;四个座位共用一份的机制在 `processor/steps/step0-dispatch.ts` 头注(隔离由深拷贝提供,不靠四份拷贝);「引擎真状态永不 freeze」由 `snapshot/read-only-isolation.test.ts` 钉住
- [x] 快照里**没有** `productions`/**没有** `you` / `isSelf` / 自己那一号——座位只从 `getMyIndex()` 读 → `Snapshot` 在 `world/state.ts` 里**逐字列出**(刻意不是 `Pick<GameState,…>`,理由:靠 `Pick` 隐式跟随会给状态加一栏时**静默**把那一栏塞进脚本可见面);少掉的是 `nextId` 与 `outcome`;座位不在快照形状里这条另由票 03 的类型面 `script-api-type-surface.test.ts:255` 钉住
- [x] **只读隔离有用例**:一个策略在 `loop()` 里试着改快照,断言引擎状态在下一 tick 不受影响(FR-3 AC1)。深 freeze 之后写入在 strict 模式下当场抛 → `snapshot/read-only-isolation.test.ts`:前三条钉「深 freeze 后写入在 strict 下当场抛 TypeError」+「引擎真状态永不 freeze」,末条钉「策略改快照,引擎下一 tick 不受影响」
- [x] 深 freeze 与 `stateHash` 的规范化序列化是**两次遍历,不合并** → `snapshot/traversal-independence.test.ts`:断言 freeze 计数 12 而 `stateHashOf` 冻 0 次 + 两处源码不共用一次遍历。理由:合并会让「这一 tick 冻没冻」依赖「这一 tick 算没算 hash」
- [x] 拷贝原语是 `structuredClone`,**不用 JSON 往返**;一条用例钉住「不共享引用」 → `snapshot/snapshot.ts:5` 头注逐字写了「一次 `structuredClone`,不做逐字段手抄:手抄漏一个字段就是一处静默不同步」与「不用 JSON 往返(它顺手规范化键顺序,而状态哈希另有一套规范化排序)」;不共享引用由 `read-only-isolation.test.ts` 第 4 条钉住(改拷贝里的嵌套字段不影响原状态)
- [x] 结算管线按 hld §4.3 的编号 0–7 实现,`0 dispatch` 建四方只读快照并按 `playerIndex 0..3` 串行执行、收集意图;1–7 是那七步。**顺序即规范**,顺序断言要有用例 → `packages/engine/src/processor/steps/step{0..7}-*.ts` 八个文件 + `processor/index.ts:43` 的 `STEPS` **一张表**(不是八个写死的调用,`step-order.test.ts` 断言的正是这张表的序);顺序断言在 `processor/step-order.test.ts`,含**反例**(把第七步提到第六步前面 → 红)
- [x] 事件流**现在就是空的但定序规则已经立住**:按「产出它的那一步 → 步内按对象数值 id 升序」定全序,不允许事后按插入序。规则先立,事件由后面各机制票填 → `processor/events.ts` 头注**就是那条定序规则本身**(步号小者先出 → 步内按对象数值 id 升序 → 登记序兜底),收集器每种事件一个**具名方法**(不允许 push 旁路,`step-order.test.ts` 有源码扫描一条);用例钉住「七步各只调收集器具名方法」与「同一构造两次得到逐项相同的事件序列」
- [x] `stateHash` 载荷 = **整个 tick 行去掉 `stateHash` 自身** → `processor/replay-writer/tick-line.ts`:`tickLinePayload` 返回值类型即那一份载荷(加一栏会**编译不过**直到补进来,「逐栏重列」在这里不是纪律而是由类型兜住);用例钉住「加一栏自动进哈希」+「含 tick」+「喂乱序状态给不同 hash(反向钉)」+「排好后与直接计算逐字相同(正向钉)」
- [x] meta 行加 `runner: "stub" | "quickjs"` 一栏,四个沙箱栏填 `null` → `replay-writer/meta-line.ts`:十二栏键序逐字钉住(`meta-line.test.ts` 逐字比对 `Object.keys`),桩那四个沙箱栏由**本函数按 `runner` 决定**填 `null`(不写 `""`/不写 `0`);判别在 `runner` 上写成**判别联合**,桩那一支**类型上就无栏可填**;跨进程形状 `ReplayMetaLine` 落真源包 `replay-line.ts`(用 JSON Schema 的 if/then 表达「stub ⇒ 四栏 null」)
- [x] 退出码语义落地:`0` 合法 `result`(胜/负/超时/异常出局**全都是 0**);`2` 装载期拒跑;`1` 引擎自身故障。**顶层 bin 之外不另开第二个入口** → `apps/cli/src/match/index.ts`:`EXIT_LOAD_REJECTED=2` / `EXIT_ENGINE_FAULT=1` / `EXIT_OK=0`;「规则内结果一律 0」是本条的关键——`runMatchCommand` 的 try 边界**只包住引擎那一段**,装载期的每一条都显式 `return 2`,而 try 剩下的都归 1;「顶层 bin 之外不另开第二个入口」由 `packages/engine/src/index.test.ts` 钉住:导出面**恰好只有 runMatch**(`processTick` 与六个 intent 不进)
- [x] `modelwar match` 与 `modelwar replay` 两条子命令接完;`modelwar verify` **不归本 feature** → `apps/cli/src/commands.ts`:`match` 的 provider 改为 `@model-war/cli`、handler `runMatchCommand`(同 `map-lint` 的先例:磁盘 I/O hld §2.2.8 与 ajv 都在 CLI 侧,engine 的 `runMatch` 是它调用的纯函数);`replay` 的 `renderReplay` 由 02a 落在 `packages/replay` 并已接完;`verify` 仍挂在登记表上但**不实现**(它要重新执行真脚本,归沙箱执行器那一格),`cli.test.ts` 的 `UNIMPLEMENTED = ["gen","run","verify"]` 盯着它「显式失败不静默 0」
- [x] **演示态成立**:一条命令跑完一场 600 tick 的对局,另一条命令看得到画面 → `apps/cli/src/cli.test.ts`「`match` 跑完一整场到超时,退出 0,回放落盘且能被 `replay` 渲染(演示态)」跑**打好的 bundle**:造一份合法输入 → `modelwar match` 退 0 且写 602 行(meta + 600 tick + result)→ `modelwar replay` 退 0 且 stdout 含 `runner stub`。手工跑同一条命令的读数见下面的 `## Answer`
- [x] 每条验收都有一个能被弄红的反例:规则集版本改一位 → 退 2;把第七步提到第六步前面 → 顺序用例红;快照改成浅 freeze → 只读隔离用例红 → 三个反例各有用例:版本改一位在 `cli.test.ts`「装载期拒跑」一组(`ruleset` 态);第七步提前在 `step-order.test.ts` 前两条;浅 freeze 在 `read-only-isolation.test.ts`。**变异实测**:把 8 个 step 文件的顺序在 `STEPS` 表里倒一下 → 顺序用例红;`Object.freeze` 换成只冻顶层 → 只读隔离用例红(见 `## Answer`)

## Answer

### 切点(票自己要求的:不静默缩小验收)

本票按 hld 的允许切成 **02a(引擎内核)/ 02b(缝与接线)** 两半,两半都在本 feature 内、都已落地:

- **02a**:状态模型、`id` 分配器、LCG 随机、`apply()`、快照边界(深拷贝 + 深 freeze)、`Runner` 缝 + `StubRunner`、七步管线骨架(0–7)、事件收集器与定序规则、`stateHash` 载荷、规则集装载、meta 行 + ASCII 渲染器(02b 未重写它)。落地为 `feature/engine-core` 上的 `2a4427d` + wip 基线。
- **02b(本票的接线)**:回放三行形状落真源包 `replay-line.ts`、`runMatch` 这道**唯一对外缝**、`apps/cli` 侧 `match` 处理器(装载 → 校验 → 跑 → 写回放 → 映射退出码)、规则集装载期校验接线、沙箱 runtime 哈希的桩测量。

02a/02b 的接口(02a 自己写的交接,02b 按它接):`processTick(state, runners, ruleset, sink)`(步 0 dispatch 是管线第 0 步,intents 是**产物**不是入参——拆出去会给「跑一 tick」开第二个入口,正是 ADR-0005 裁掉的平行表示);`buildMetaLine(head, seed, players)` 十二栏;`renderReplay` 落 `packages/replay`。

### 本票在实现中改掉/定死的东西(与票面/文档的差异,记录在此)

1. **`MetaHead` 不再收 `seed`**:种子有**一个家**(对局输入 `input.json`),meta 行是它的投影。故 `buildMetaLine` 单独收 `seed` 参数,`runMatch` 注入。原先让它出现在 `MetaHead` 上会多一处可任填的地方。
2. **`TickLine`/`MetaLine` 的「组装面」类型删除,改为真源包形状的别名**:02a 在 `replay-writer/` 里逐栏重列过 `TickPayload`/`MetaLine` 作为「组装面」类型;02b 把回放三行形状落进 `packages/schema` 后,这两处重列就是同一份栏位清单的**第二次书写**——两次书写里总有一次不更新。故 `TickPayload = ReplayTickPayload`、`TickLine = ReplayTickLine`(一条别名把两处读法绑成同一事实),`MetaLine` 直接用 `ReplayMetaLine`。跨引擎状态与回放形状的**双向可赋值**由 `packages/engine/src/replay-line.test.ts`(类型级,红在 `tsc -b`)盯着。
3. **沙箱 runtime 哈希的桩测量**(`apps/cli/src/match/sandbox-runtime.ts`):`sandboxRuntimeHash` 的本义是真沙箱产物的 sha256,沙箱执行器在本仓尚未落地、仓库里**没有**那份产物可哈希。选「给一个双方共用的确定桩值」而不是「跳过这条判据」——跳过会让 01 票那条判据在 match 这条路上形同虚设。桩值取「模块标识 + 规则集版本」的 sha256,随规则集版本而变(版本错配立刻红)。**沙箱执行器落地后本函数改为对真产物求 sha256,装载期与 01 票那条判据一行不改。**
4. **本票一条游戏机制都不实现**:`stateHash` 载荷、回放行形状、meta 行形状在本票定死;`outcome` 的名次算法、步 5 的判据(淘汰/回归中立/全点位/捷径)、八种事件**全部留给 04–09**。`runMatch` 的终局行在 `state.outcome` 未置时退到「超时 + 全部并列 + 领土分 0」——**对空转对局这是诚实答案**(四方领土分相同,按 gdd 就是全部并列),而不是 `rankings: []` 的占位(后者会被渲染器与战报当成「这局打完了」读)。票 09 落地后 `runMatch` 优先用 `state.outcome`,这一行不用改。
5. **`match` 的 provider 改为 `@model-war/cli`**:磁盘 I/O(hld §2.2.8)与 ajv(唯一实例)都在 CLI 侧,engine 的 `runMatch` 是纯函数。原先登记的 `provider: @model-war/engine` / `handler: runMatch` 会把读盘与校验塞进 engine,故改挂 CLI 本地模块(同 `map-lint` 先例)。
6. **`replay-line.ts` 里 `if/then` 关掉 oxlint `no-thenable`**:`then` 是 JSON Schema 的关键字,不是 thenable;本仓用 if/then 表达「按判别字段分栏」,故整块 disable 并把理由写在代码里。

### 手工跑的演示态读数(打好的 bundle,非测试夹具)

```
$ node apps/cli/dist/index.js match runs/.../input.json --root <root>
modelwar match: 600 tick 已结算,回放写入 runs/.../replay.jsonl(runner=stub,timeout)
EXIT=0

$ wc -l replay.jsonl            # 602 = meta 1 + tick 600 + result 1
$ node apps/cli/dist/index.js replay runs/.../replay.jsonl
== 回放 ==
  schema 1 · ruleset v1 · seed 20260101 · map b72bf179af6c · runner stub
  ⚠ runner 不是 quickjs:本局由桩执行器产出,沙箱行为类结论(座位轮换、跨版本一致性)不可由它得出。
  座位 A · alpha · archive/alpha/r1
  ...
  t0 · 单位 8 · 点位 28 · 事件 0 · hash 248d585e59a1
  ...
EXIT=0
```

`replay` 显出 `runner stub` 与那句警告,正是 02a 让 `runner` 栏可读的目的:有人拿桩跑的读数当座位轮换的结论时,这里当场拦住。

### 门禁读数

`pnpm run check` 全绿(unit+property **48 文件 524 用例全过**;禁浮点 27 文件 0 违规;依赖 85 模块 146 依赖零违规;声明即依赖 43 文件 0 未声明;漂移 6 件无;基准 3 份绿)。跨进程形状的可赋值性由 `replay-line.test.ts` 在 `tsc -b` 层盯着(红在类型上,不是运行时)。

### 收口时的三处修正(合入前复查发现)

1. **`match` 的参数解析有个真 bug**:原先写的是 `args.filter((arg) => !arg.startsWith("-"))`,而 `--root` 的**值**不以 `-` 开头——`modelwar match --root <根> <input.json>` 这一序下位置参数成了 `["<根>", "<input.json>"]`,`positional[0]` 就是根目录,一个目录被拿去 `JSON.parse`。改成 `splitArgs` 先摘 `--root` 与它的值再取位置参数。用法串把 `<input.json>` 写在前面只是**惯例**,不是解析器的免责理由。新增用例「`match` 的 `--root` 写在 <input.json> 前面也能跑,退出 0」;实测反例:改回旧写法 → 该用例红
2. **`RunMatchResult.finalState` 的注释是句假话**:原写「`outcome` 此刻已置」,而非 `resultLineOf` 只产终局行、**不写** `state.outcome`(那归票 09),所以 `finalState.outcome` 就是 `null`。读它的人会拿到 `null` 去解引用。注释改成事实陈述
3. **基准产物门禁的输出文本过期**:它打印的尾巴写着「(类型面尚未回填,第一项回填那天必须归零)」,而票 03 已把类型面回填、第一项也已归零。改成「(类型面已回填:第一项必须恒为 0,非 0 就是声明面与脚本对不上了)」——门禁的输出也是给人读的,说错话同样算“一个事实两个家”

### 留给后续票的话

- 04–09:步 5 判据、`state.outcome`、八种事件随各机制票填进各自的槽;`EVALUATE_STAGES` 的段序已立,票 09 只须填判据不必重定顺序。
- 票 09:终局行名次算法落地后,`runMatch` 优先读 `state.outcome`,本票那条「退到全部并列」的兜底只在 `outcome` 未置时生效。
- 沙箱执行器那一格:`sandbox-runtime.ts` 的桩测量换成真产物哈希;`runMatch` 的 `strategies` 参数届时由「普通 TS 函数」换成「脚本文本→策略」的编译结果,`runMatch` 这一行不用动。
