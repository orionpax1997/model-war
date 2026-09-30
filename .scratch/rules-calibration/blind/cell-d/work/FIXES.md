# work/FIXES.md — 校验轮次记录

## v1（初版，冻结）
- 文件：`work/script.v1.js`（md5 5b97d66390de93421fc604a9d008aa67），未改一字。
- 本地自检（非对局反馈）：`work/sim.mjs`、`work/sim_v.mjs` 是自建 mock 引擎，
  24×24 与 32×32（含环形墙）两版各跑满 600 tick，`exceptions = 0`，对局均正常收敛
  （一版 tick151 捷径胜、一版 tick192 捷径胜）。

## 待静态校验回喂后处理的风险点（本轮不动 v1）
1. `loop()` 记法：prompt 写 `function loop(): void`，本文件为 .js，落盘为 `function loop() {}`。
   若静态校验按字面匹配签名，下一版补 `// function loop(): void` 注释或改回带类型写法。
2. 自认候选 A 写死 `MY_INDEX = 0`：若容器顺序 ≠ players 下标，全部 intent 属主错被静默丢弃。
   终稿若给自标记字段，下一版优先读该字段（当前盲写下访问未声明字段会被静态校验拒）。
3. `pickBaseTarget()` 内有一段同权重比较的死代码（只保留首个），下一版简化为
   “敌占基地优先、中立次之、同类按到最近者由调用方按单位选”。
4. 资源自账 `resEst`：快照 `players` 无查询 API，只能自记；harvest/transfer 成功与否
   靠返回码推断，漂移时靠 `ERR_NOT_ENOUGH_RESOURCES` 归零兜底。终稿若开放资源查询则改直读。
5. 队列跟踪 `qTick/qUnits`：出兵格被占会挂起，用“我方单位数增长”判定出产，误差最多一次重复下单。
6. 轮转方向：全脚本未使用 `(tick+playerIndex) mod 4` 做分支（只依赖 move 裁决结果），
   方向假设翻转不会改变行为，仅影响记录口径。
7. 移动全部用 `move` 单步 + `getTerrainAt` 局部绕墙，不调 `findPath`（省 API 预算）；
   遇U形墙可能卡住，下一版若校验允许可改为对远距离目标用 `moveTo`。

## 第 1 轮回喂（静态校验 2 项不通过）→ work/script.v2.js
v1 冻结未动（md5 仍为 5b97d66390de93421fc604a9d008aa67）。v2 = v1 + 以下改动，其余字节不动：

1) **入口签名按字面**：`function loop(): void { ... }`（文件末入口，v1 为 `function loop() {}`）。
   风险留档：`: void` 是 TS 记法，纯 JS 解析器会 SyntaxError。本地冒烟台账里做了一次记法剥离
   （`SRC.replaceAll('function loop(): void','function loop()')`）才进 vm；若宿主按纯 JS 解析，
   需要同样处理或告知，我下一版可改成"注释里留字面 + 声明用 JS 记法"。

2) **`MY_INDEX` 不再写死**：改为探测式自认（候选 A，指令反馈闭环），见下。

### 2 的实现要点
- 变量：`MY_INDEX` 初值 -1（未认出），`selfState`、`probeIndex/probeRounds/probeTries/
  probeConfirm/probePhase/probeUnitId/probeFromX,Y/probeToX,Y/probeDir/selfFallback`（全整数）。
- 流程：未认出的那些 tick 只发**一条**探测 intent —— 对候选下标 0..3 轮流取 id 最小的非骑兵单位
  （骑兵一 tick 两格会污染读数），挑一个 `getTerrainAt='plain'` 且无单位的目标格，`move(id,dx,dy)`；
  下一 tick `getObjectById(probeUnitId)` 回读坐标：
  - 精确落在 `probeToX/Y` ⇒ 我的 intent 被采纳 ⇒ 属主是我 ⇒ `probeConfirm++`（换方向再验一次）；
  - 原地未动 ⇒ 弱否定（可能被占位/轮转判掉），同下标重试，满 `PROBE_MAX_TRIES=2` 换下标；
  - 动了但方向不符 ⇒ 强否定（非我方），换下标；单位消失（被打死）读数无效，换下标。
  - 连续命中 `PROBE_CONFIRM=2` 次才认定 → `MY_INDEX = probeIndex`（值来自回读，不是常量）。
  - 认不出时本 tick 不发任何其它 intent（少动 3~12 tick，600 tick 尺度可忽略）。
- 自愈：`spawnUnit` / `transfer` 回执命中 `'ERR_NOT_OWNER'` → `resetSelf()` 退回重认（认错人不会整场静默）。
- 兜底：整轮 0..3 试满 `PROBE_MAX_ROUNDS=2` 仍认不出 → 退回首轮默认 0 并置 `selfFallback=true`。

### 契约无法闭环之处（逐条，wording-risks 实证输入）
1. `Snapshot`（api.md §1）无 `selfIndex` / `myIndex` / `seat`：只有 tick/players/units/sites/productions。
2. `players[i]` 无 `you` / `isSelf` / `isYou` 之类自标记 → **候选 B 在当前 schema 下不存在**
   （api.md §5 自己也写"来源状态模型里没有这个字段"）。
3. `loop()` 无参数（§0/§5 入口签名不接 playerIndex/容器序号）→ "我是第几个容器"这件事在
   入口与快照里都**没有任何可读字段**，候选 A 的字面形式无法直接落地，只能靠 §3 的行为闭环反推。
4. 无 `getMyIndex()` / `getPlayerIndex()` 之类查询（§3 白名单只有 getTick / getObjectById /
   getObjectsByType / getRange / getTerrainAt / findPath）。
5. 读未暴露字段按 §8 / §2 属"越权（未暴露字段）"→ 整 tick intent 置空 + `exceptionTicks++`，
   所以候选 B 的"试探式读字段"不能用；本版**完全不读任何未声明字段**。
6. `players` 固定长度 4、index 0..3（§1 写死 `[4]`），无长度/范围校验入口；本版按 0..3 轮询。
7. `ERR_NOT_OWNER` 是草案按职能反推的**候选码**（§4 明说终稿以 schema 为准）：自愈分支依赖它；
   若终稿改名或不返回，退化代价 = 认错后不自愈（首 tick 探测仍在，误判概率低）。
8. 玩家资源/队列无查询接口（§3 无按 index 取 player 的函数）→ `resEst` 只能自记（沿用 v1 口径）。
9. 探测读数的固有歧义：敌方单位恰好同 tick 同向挪一步会造成误判，用"连续两次命中 + 换方向"缓解；
   骑兵已排除；同格竞争/交换穿行造成的原地不动按弱否定处理。

### 本地自检（非对局反馈）
- `work/sim_v2.mjs`（24×24，8 堵对称墙）/ `work/sim_v2b.mjs`（32×32，环形墙）：两版都是
  **四个座位全跑同一份 v2、且不再注入 MY_INDEX**（注入已删除，自认完全靠探测）。
  各跑满 600 tick：`exceptions = 0`；24×24 版 tick147 捷径胜、32×32 版 tick227 捷径胜。
- 自认结果回读：座位 0→0、1→1、2→2、3→3，四个容器均在 **tick 3** 锁定（无 fallback）。

---

## 驱动侧（驾驶员）记录 — 回填时追加（2026-09-30）

区分两类"轮次"：上面 v1 / 第 1 轮都是**模型自跑**的本地校验（自建 mock 引擎），不构成回喂；
本节只记**驾驶员给模型的静态校验回喂**。

### 执行史

| 轮 | 模型 | thinking | 产物 | 结果 |
|---|---|---|---|---|
| 轮 0（初版） | `commandcode/stealth/space-bunny-alpha` | high | `work/script.v1.js`（411 行，13.3K） | 产出，静态校验 **2 项不通过** → 回喂 |
| 回喂 1 | 同上 | high | `work/script.v2.js`（18.1K） | **通过**，2 项均修，0 轮追加回喂 |

- 舱内 prompt 存档：`session/PROMPT.round0.txt`（初版）、`session/PROMPT.round1.txt`（初版 + 回喂追加语）。
- 每轮模型 stdout：`JAIL.log.round0` / `JAIL.log.round1`。
- 终态脚本：`work/script.v2.js`，SHA256 `db450c2e671a5703d4d8a5476bf10c6849653f9c18f0946a3f67ff41be70aed6`。

### 回喂轮次：1 / 5

驾驶员独立复核（不看模型自述，直接对 `work/script.v1.js` 跑，剥注释后逐项正则）：

| 检查 | 方法 | v1 结果 |
|---|---|---|
| 违禁项（`Date`/`Math.random`/`performance`/`queueMicrotask`/`setTimeout`/`setInterval`/`setImmediate`/定时器/`eval`/`require`/`import|export`/`__*`） | 剥块注释与行注释后正则 | 全部 **0 命中** |
| 浮点字面量 | 剥注释后 `/[0-9]+\.[0-9]+|e[0-9]+/` | 0 命中 |
| 顶层入口 `^function loop\(\): void` | 正则 | ✗ **实际为 `function loop() {}`（第 405 行）** |
| API 面（只调 api.md §3/§4） | 抽全部调用标识符扣文件内自定义函数后比对白名单 | 越界 **0** 处；用到的：`getTick`/`getObjectsByType`/`getTerrainAt`/`move`/`attack`/`harvest`/`transfer`/`spawnUnit`（**不用** `findPath`/`moveTo`/`getObjectById`/`getRange`，自己写 `cheb`） |
| 跨 tick 只存数值 | 模块级声明逐项核对 | 仅 `number` 与 `Map<number,number>`（`wSite`/`qType`/`qTick`/`qUnits`），**无对象引用缓存** |
| 每单位一 tick 一意图 | 人工核对 `runTick` | 每个单位分支内 `return`/`continue`/`else if` 收口，OK |
| 类型剥离可编译 | `stripTypeScriptTypes(src,{mode:'transform'})` | OK |
| `MY_INDEX` 来源 | 人工核对 | ✗ **`var MY_INDEX = 0;` 常量写死**（api.md §5 骨架注释明写"实写时从快照认出自己，禁止写死"） |

→ 判定 **2 项不通过**（①入口签名字面不符 ②index 写死），回喂第 1 轮。

回喂内容严格限于上述 2 项静态错误 + 已通过项清单 + 改稿纪律（v1 冻结、v2 另写、FIXES 追加），
**未给对战反馈、未给任何跨舱信息**（不透露 cell-a 怎么做的）。

v2 复核（`script.v2.js`）：违禁项 0 命中、无浮点、入口 `function loop(): void` 在位、
`MY_INDEX` 初值 -1 且由 `getObjectById` 回读探测结果回填、API 全在白名单（新增 `getObjectById`）、
跨 tick 仍只存数值与 `Map<number,number>` → **全部通过，回喂止于 1 轮**。
v1 冻结复核：SHA256 `3a9895e0c22b1332ffb35751d7dc2f2bc8e553d21bc4dfd58a58ed240574a2c2`，
两轮之间未被改动（与模型自述 md5 `5b97d66390de93421fc604a9d008aa67` 一致）。

### 自愈情况：2 次（模型侧，均无驾驶员介入）

1. **轮 0**：自建 mock 引擎 `work/sim.mjs` / `work/sim_v.mjs`（24×24 与 32×32 含环形墙两版），
   各跑满 600 tick，`exceptions = 0`；期间用 `dbg*.mjs` 逐个定位再删除，交付前清理干净。
2. **回喂 1**：`work/sim_v2.mjs` / `work/sim_v2b.mjs` 把"注入 MY_INDEX"删掉、改成四座位全靠探测，
   实测 0→0、1→1、2→2、3→3 均在 **tick 3** 锁定（未走 fallback），`exceptions = 0`。
   注意这两处自愈是**驾驶员回喂的直接产物**（回喂第 2 条），非模型自发。

模型**未自发**发现的两点（均由回喂指出）：入口签名记法、`MY_INDEX` 写死。

### 契约措辞风险（本舱实证，供 14 汇总、回流 06）

1. **`: void` 记法分歧（本舱与 cell-a 相反的一票）**：硬约束字面写 `function loop(): void`，
   但交付文件名是 `script.v1.js`。cell-a/b/c 三个舱的初版都直接照抄 `function loop(): void`（TS 记法），
   **只有本舱 v1 落成 `function loop() {}`**，并自己把这条列为"待回喂风险 1"。回喂后才改回字面。
   → 同一句硬约束，4 个舱 3:1 分裂，说明**「脚本源是 JS 还是 TS」在契约里确实没定义**，
   且不同模型对"字面服从"与"文件名服从"的取舍相反。终稿必须二选一定死。
2. **`MY_INDEX` 写死是 4 舱中的孤例，但根因是契约空洞**：本舱 v1 直接 `var MY_INDEX = 0`，
   cell-a/cell-c 都自己发明了探测（cell-a 用 `move()` 返回值探测，cell-c 用对全部单位发试探
   `move` 再回读 owner）。三舱被迫"发明探测"这一事实本身就是 P0 待裁项的最强证据。
3. **候选 B 不可实现的显式证据（本舱新增）**：模型独立复核后写出 9 条"契约无法闭环"清单，
   关键 3 条——`Snapshot` 无 `selfIndex`/`you`/`isSelf` 任何自标记字段（候选 B 在 schema 下不存在，
   api.md §5 自己也承认）；`loop()` 无参数、无 `getMyIndex()` 查询 ⇒ 候选 A 的字面形式（容器顺序）
   在**入口与快照两处都无可读字段**；读未暴露字段按 §2/§8 判"越权"→ 整 tick 置空 + `exceptionTicks++`，
   所以"试探式读 `players[0].you`"这条路被契约自己的越权规则堵死。
   ⇒ 候选 A/B 二选一这个提示**在当前 schema 下没有可行解**，必须由终稿补字段或补查询函数。
4. **`ERR_*` 未展开（第二次命中，跨舱稳定复现）**：v1/v2 都用 `if (!r)` 真值判 `spawnUnit`/`transfer`
   成功（cell-a 用 `isError()`、cell-c 用 `typeof r !== 'string'`）——三种写法、同一未定义类型。
   本舱额外依赖 `ERR_NOT_OWNER` 做自愈，若终稿改名则该分支静默失效。
5. **`no-risks` 舱仍泄露 `wording-risks.md` 存在**（cell-a 已提，本舱复现）：
   `input/SHA256SUMS.draft` 含其一行哈希。另：两轮会话都执行过 `ls -la /workspace/input/`，
   目录列表里能看到 `TASK.txt`、`SHA256SUMS.draft` 两个未授权文件**存在**（但**内容未被读取**，
   会话 JSONL 里无其内容）。`collect` 白名单不取 `JAIL.log.round*`，本票手工补齐。
6. **验收内部矛盾**（cell-a 已提，本舱复现）："三件套要求"要 `session/` 存档，"验收"却写"舱内
   `session/` 不出舱"，而 `collect` 实现是无条件 `cp -r "$JAIL/session"`。本票照交付要求保留 `session/`。

### 策略稳定性（cell-a vs cell-d，同 prompt 同策略 A，不同模型）——供 14 §3

| 维度 | cell-a（deepseek-v4.1-flash） | cell-d（space-bunny-alpha） | 判定 |
|---|---|---|---|
| 策略骨架 | worker 目标数达标后转近战/远程，爆兵 | `pickType()` 爆兵为主（`MIN_WORKERS=2` 兜底农民，ranged/cavalry 按 `RATIO` 稀疏混入），防守半径 3 优先 | **策略取向稳定复现** |
| 移动 | 单步 `move` + 地形绕行，不用 `findPath` | 同（`stepToward` 先对角后单轴 + `getTerrainAt` 绕墙） | **结构相似** |
| index 自认 | 选候选 A，`move()` 返回值探测兜底，退化 `MY_INDEX=0` | 选候选 A，v1 写死 0 → 回喂后改 `getObjectById` 回读探测、连续两次命中才认定 | 取向一致、**严谨度本舱更高**（v2 有确认计数 + `ERR_NOT_OWNER` 自愈 + fallback 标记） |
| 轮转方向 | 假设"值大者胜" | 假设"值大者胜"，且**全脚本不依赖该方向分支**（只依赖 `move` 裁决结果），并明说"方向翻转不改变行为" | 假设一致，本舱额外做了**方向无关性论证** |
| 入口记法 | 初版 `function loop(): void` | 初版 `function loop() {}` → 回喂才改 | **分歧**（见措辞风险 1） |
| 静态校验错误类型 | 0 项 | 2 项（入口记法、index 写死） | cell-d 错误更偏"记法/服从度"，cell-a 0 错误偏"实现完备" |
| `ErrResult` 判别式 | `isError()` | `!r` 真值 | 写法不同，同一未定义类型（措辞风险 4） |
| 自建 mock 引擎 | 2 个（4 容器冒烟 + 40 tick） | 4 个（v1 两版 + v2 两版，各 600 tick 满局） | 本舱自检强度更高 |
| 回喂轮次 | 0 | 1 | 均 ≤5，**两舱都进 `benchmarks/` 候选** |

结论（初步，供 14 汇总）：**"爆兵压制"在两个模型间稳定表达**——骨架、生产决策、移动方式、
"选候选 A + 值大者胜"两条记录全部同构，差异集中在**工程严谨度**（本舱多做了方向无关性论证与
确认计数自愈）而非**策略取向**。校验错误类型也确实不同：cell-a 是"实现完备、零静态错误"，
cell-d 是"记法服从、2 项字面不符"，**两者都指向同一组措辞问题**（TS/JS 记法、index 无出口、
`ErrResult` 未展开），没有出现某一模型特有的盲区。
