# 竞品分析:LLM Skirmish (llmskirmish/skirmish)

- 仓库:<https://github.com/llmskirmish/skirmish>
- 官方网站:<https://llmskirmish.com>
- 最新版本:`@llmskirmish/skirmish` v0.1.2(2026-01 前后)
- 仓库星数:~45,主仓库单一主分支,2 名核心贡献者
- 文档版本:v1.0(对齐 model-war docs/fsr.md v1.3)
- 状态:活跃维护;本仓库对应 [fsr.md §3.1](../fsr.md) 中提到的"直接先例"

> 本文档不复制 model-war 的决策结论,只描述 LLM Skirmish 自身的实现。对比分析放在最后一节。

## 1. 一句话定位

**LLM Skirmish 是一个 LLM 写 JS 代码、Screeps-Arena-API 规则下 1v1 RTS 自动对战的 in-context learning benchmark**。

- 评测对象:前沿闭源/开源 LLM(Claude、GPT、Gemini、DeepSeek 等)
- 评测形态:模型在 Docker 隔离的 OpenCode 容器里写 JS 策略 → 同一对局引擎跑出胜负
- 评测对象数:每场 2 个模型、每轮 5 局、每局对所有对手各打一场(全循环),"epoch" 是多个全循环的叠加
- 出题方式:模型被允许**看上一轮的失败/成功日志**来迭代脚本(round 2-5 才有 NEXT_ROUND.md),第 1 轮只看 OBJECTIVE.md
- 校验:脚本有最多 3 次编译/校验失败重试

它**不是**:
- 真人游戏(人类不参与对战,人类只读回放或网站结果)
- Web 多人在线游戏(虽然源自 Screeps 的多人 MMO,但被砍成 1v1 离线模式)
- 一个 web 应用(本地是 CLI;网站是另一套托管基础设施)

## 2. 顶层结构

### 2.1 仓库形态

pnpm + Turborepo 单仓多包(类似 model-war 自身的 TS 单仓)。Node ≥20。

```
skirmish/
├── apps/
│   └── cli/             # @llmskirmish/skirmish,可全局安装的 CLI
├── packages/
│   ├── engine/          # @skirmish/engine,服务端确定性引擎
│   ├── types/           # @skirmish/types,跨包共享常量与类型
│   ├── maps/            # @skirmish/maps,地图工具与默认地图数据
│   └── replay/          # @skirmish/replay,回放序列化与解析
├── tooling/
│   └── typescript-config/
├── maps/                # 仓库根目录,地图 .json 数据文件(由 init 命令拷贝)
├── example_strategies/  # 仓库根目录,示例 bot(由 init 命令拷贝)
├── prompts/             # OBJECTIVE.md、NEXT_ROUND.md 等发给 LLM 的提示
├── package.json         # 顶层,turbo 编排
└── pnpm-workspace.yaml  # packages/* + apps/* + tooling/*
```

### 2.2 依赖流向

```
                ┌─────────────────────┐
                │   apps/cli          │   (esbuild bundle 成单一二进制)
                │  @llmskirmish/skirmish│
                └──────────┬──────────┘
                           │ imports
                ┌──────────▼──────────┐
                │   packages/engine   │
                │    @skirmish/engine │
                └────┬─────┬──────┬───┘
                     │     │      │
                ┌────▼─┐ ┌─▼──┐ ┌─▼────────┐
                │types │ │maps│ │  replay  │
                └──────┘ └────┘ └──────────┘
```

- `types` 是叶子包,无业务依赖
- `engine` 是核心,可单独被 CLI、本地 npm 用户、托管后端复用
- `replay`、`maps` 也只依赖 `types`,可独立消费
- `cli` 只依赖 `engine` + `maps`(以及同包内的 example_strategies、maps 静态资源)

## 3. 技术栈

| 维度 | 选型 | 备注 |
|---|---|---|
| 语言 | TypeScript(全栈同构) | ESM(`"type": "module"`),TS 5.3+ |
| 运行时 | Node.js ≥20 | 用了 `node:util` `parseArgs`、原生 `vm`、原生 `performance` |
| 包管理 | pnpm 9.15 + workspaces | 配合 turbo |
| 任务编排 | Turborepo 2.3 | `build`/`typecheck`/`clean` 都走 turbo |
| 构建(库) | `tsc` | `engine`/`types`/`maps`/`replay` 直接 tsc 出 `dist/` |
| 构建(CLI) | esbuild | 把 CLI 多 entry 打成单一 IIFE,内置 `__VERSION__` 注入 |
| 沙箱 | **node `vm`** + 可选 **isolated-vm** | `MatchRunner`(vm,默认)、`IsolatedRunner`(isolated-vm,生产/网站托管) |
| 路径规划 | 自实现 A* | 内置 `searchPath()`、`CostMatrix`,与 Screeps Arena 行为一致 |
| 随机数 | 自实现 `SeededRandom` | 关键:同种子必出同序列,保证确定性重放 |
| ID 生成 | 自实现 `IdGenerator` | 取代 Screeps 的 Mongo ObjectId,纯本地可复现 |
| WebSocket(可选) | `ws` 8.16 | 仅当启用 `/server` 子路径(比赛实时转发)时使用,标为 `optionalDependencies` |
| 测试 | vitest 2.x | `engine` 暴露 `vitest run` |
| Lint/Format | (未在仓库根发现显式配置) | 不像本仓,Skirmish 没上 ESLint/Prettier |

### 3.1 关键工程取舍

- **不上框架**:CLI 不引 Express、CLI 不引 commander/yargs,直接用 `node:util` 的 `parseArgs`,手写子命令派发。原因:CLI 表面稳定、体积小,bundle 简单。
- **沙箱选 vm 而非 worker_threads**:vm 在同一进程内开多个 Context,CPU 开销远小于 worker 启动;LLM 脚本每 tick 跑得快。代价:**vm 不是安全边界**,所以本地开发用 vm、生产(云端托管公开对战)换 isolated-vm。
- **类型与运行时分层**:`types` 包只导出 `enum-like` 常量与接口,引擎把这些常量塞进沙箱的 globalThis,LLM 脚本里就能直接 `MOVE`、`ATTACK` 当常量用——这是 LLM 友好的关键设计。
- **不引 ORM / DB**:整套对战状态是纯内存的 `Map<string, RuntimeObject>`,通过 driver 层抽象出 `BulkOperation` 接口,内存实现是 `InMemoryBulkWriter`(把 Screeps 用的 Mongo/Redis 适配砍掉)。

## 4. 模块架构设计

### 4.1 分层

引擎严格分层,自下而上:

```
┌──────────────────────────────────────────────────────────┐
│  apps/cli                ← 用户面:init/run/validate/view│
│  apps/cli/submit,profile,auth  ← 社区 ladder 子命令     │
├──────────────────────────────────────────────────────────┤
│  match/MatchManager      ← 对局编排:driver+processor 协作│
├──────────────────────────────────────────────────────────┤
│  processor/ArenaProcessor ← 状态推进:消费 intents,产事件│
│  processor/intents/*     ← intent 解算器(细分按对象类型) │
├──────────────────────────────────────────────────────────┤
│  driver/ArenaDriver      ← 真值源:状态/意图/事件        │
│  driver/SeededRandom     ← 确定性 RNG                    │
│  driver/IdGenerator      ← 确定性 ID                     │
├──────────────────────────────────────────────────────────┤
│  runner/BaseRunner       ← 抽象脚本执行器               │
│  runner/MatchRunner      ← vm 实现(本地 CLI 默认)       │
│  runner/IsolatedRunner   ← isolated-vm 实现(生产托管)  │
│  runner/sandbox-runtime  ← 沙箱内 API 完整实现(bundle)   │
├──────────────────────────────────────────────────────────┤
│  logger/RawMatchLogger   ← JSONL 结构化回放             │
│  logger/MatchLogger      ← LLM 友好文本日志(run-length 压缩)│
│  replay/                 ← 类型与解析                   │
├──────────────────────────────────────────────────────────┤
│  types/                  ← 跨层常量与接口               │
│  maps/                   ← 地图数据 + DEFAULT_MAP_SIZE  │
└──────────────────────────────────────────────────────────┘
```

### 4.2 单 tick 数据流(关键路径)

每场对局 = `MatchManager` 持有一个 `ArenaDriver` + 一个 `ArenaProcessor` + 2 个 `BaseRunner` 子类(p1、p2 各一)。每个 tick:

```
  ┌─────────────────────────┐
  │ 1. driver.getRoomObjects│  ← 把内存对象序列化(Spawn/Creep/Tower/Source/Resource)
  └────────────┬────────────┘
               │ Map<id, RuntimeObject>
               ▼
  ┌─────────────────────────┐
  │ 2. runner.refreshTick   │  ← 每个玩家的 vm Context 收到"刷新"调用,
  │    (vm.Script 预编译)    │     把当前对象 JSON 序列化注入沙箱 global
  └────────────┬────────────┘
               │ 沙箱内重建:Creep/StructureSpawn/Source 等原型 + wrapper
               ▼
  ┌─────────────────────────┐
  │ 3. 沙箱内 loop() 执行   │  ← LLM 脚本每 tick 跑一遍,
  │    调用 _addIntent(...) │     把 move/attack/spawnCreep 写成 intent
  └────────────┬────────────┘
               │ UserIntents (per-player map of objectId → intent[])
               ▼
  ┌─────────────────────────┐
  │ 4. processor.processTick│  ← 按对象类型分派给 intents/ 子目录:
  │    4a intents/creeps/*  │     attack/rangedAttack/heal/harvest/move/...
  │    4b intents/spawns/*  │     spawnCreep/setDirections/tick
  │    4c intents/towers/*  │     attack/heal/tick
  │    4d movement 注册表    │     createMovementRegistry + applyMovements
  │    4e 伤害结算         │     同步攻击/治疗/死亡
  └────────────┬────────────┘
               │ TickResult: { events, objects(含 actionLog) }
               ▼
  ┌─────────────────────────┐
  │ 5. tickHistory.push     │  ← 推入 MatchManager.tickHistory,
  │    logger 写入回放流     │     RawMatchLogger 出 JSONL 给机器读,
  │                         │     MatchLogger 出文本日志给 LLM 读
  └─────────────────────────┘
```

### 4.3 关键模块详解

#### 4.3.1 `driver/ArenaDriver`(真值源)

- 单一 `MatchState`:`tick: number`、`objects: Map<string, RuntimeObject>`、`terrain: Uint8Array`、`players: Map`、`events: GameEvent[]`
- 持有 `SeededRandom`、`IdGenerator`,构造时即固化种子;`getSeed()` 返回实际种子(无论外部传没传),用于回放
- 提供 `getRoomObjects()`、`getRoomTerrain()`、`getRoomIntents()`、`bulkObjectsWrite()`(返回 `BulkOperation` 句柄)
- `InMemoryBulkWriter`:`update` 走 `deepMerge` 原地改对象,`execute` 集中提交 insert/remove。设计模仿 Screeps "立刻可见"语义

#### 4.3.2 `processor/ArenaProcessor`(状态推进器)

- 每个 tick 一次 `processTick()`,**不**保存任何历史
- 显式按对象类型引入 `intents/<type>/<action>.ts`,分文件降低耦合
- 输出 `TickResult`:events 数组 + objects 数组(每个 object 携带 `actionLog`,供前端回放打特效)
- 移动系统单独抽出 `createMovementRegistry` + `applyMovements`,处理同方向冲突、fatigue、地形减速

#### 4.3.3 `runner/`(沙箱)

- `BaseRunner`:抽象基类,处理**对象序列化**、intent 累积、state 注入、错误捕获。两个子类共享同一份 host 逻辑,差异只在"沙箱类型"
- `MatchRunner`(vm):构造时 `vm.createContext(sandbox)` + `vm.Script(...).runInContext` 一次性跑完沙箱 runtime 与玩家脚本,后续每 tick 只刷新预编译的 `_refreshTick(...)` 调用。优点是**玩家函数引用不会丢**(loop 函数存为 `context.loop` 反复调用)
- `IsolatedRunner`(isolated-vm):把 `sandboxRuntimeCode` 注入独立 isolate,跨 Context 用 `applySync` 同步桥接。生产环境用
- `sandbox-runtime.ts`:把 Screeps Arena 全部 API(`Creep`、`StructureSpawn`、`Source`、`getObjectsByPrototype`、`getRange`、`findClosestByRange`、`findInRange`、`findClosestByPath`、`findPathTo`、`searchPath`、`CostMatrix`、`getTicks`、`getTerrainAt`、`getDirection`、`getObjectById`)实现一遍。**对象身份在 tick 间保持**(同一个 wrapper 实例指向同一个底层 game object)
- 关键边界:`getCpuTime()` 由 host 注入,沙箱内可自检超时

#### 4.3.4 `match/MatchManager`(对局编排)

- 拼接 `driver` + `processor` + 两个 runner
- 维护 `tickHistory: TickSnapshot[]`、`victory?: VictoryResult`、`playerReadyState: Map<string, boolean>`
- `VICTORY_CONDITION` 常量 = `'spawns_only'`,即"推掉对面 Spawn 即赢";另一种 `'spawns_and_creeps'` 已存在但未启用
- 可选 `StorageUploader` 抽象,实现它即可把 JSONL/文本日志推到 S3/R2(LLM Skirmish 网站用 Cloudflare R2)
- `getReplay()` 把 `tickHistory` 包装为 `Replay` 结构,供 logger 消费

#### 4.3.5 `logger/`

- `RawMatchLogger`:输出 **JSONL**,每行一个 tick snapshot(`{tick, objects, events}`),机器可读,replay 包直接消费
- `MatchLogger`:输出 **LLM 友好文本**,有:
  - 显著的 `=== Tick N ===` 分隔
  - 与上 tick 对比,标记**移动**(坐标变化)、**消失**(死亡)、**新对象**(孵化)
  - **run-length 压缩**:连续 ≥3 个 pattern 完全相同的 tick 合并为一段,显著降低日志 token 数
  - `verbose` 选项控制是否打印 body part、store 等细节
  - `DIRECTION_NAMES` 把方向常量翻成字符串

#### 4.3.6 `rating/`

- 标准 **ELO** 实现:初始 1500、K 因子 32
- `expectedScore(rA, rB)` 与 `updateEloRatings(ratings, A, B, winner)` 给定两脚本 ID 与胜者即可更新
- `calculateRatings(matches)`:接收 `MatchResult[]`,按 `createdAt` 排序(确定性!),输出 `Map<scriptId, { elo, wins, losses, draws, matchCount }>`
- 用于社区 ladder 与赛事排名

#### 4.3.7 `cli/`(用户面)

```
skirmish init        # 注册 + 在当前目录生成 strategies/ 与 maps/
skirmish auth        # 登录登出到云端 ladder
skirmish profile     # 查看/修改用户资料(含 harness 字段)
skirmish submit      # 提交脚本到社区 ladder
skirmish run         # 跑一场本地对战(--p1/--p2/--map/--seed/--view/--json)
skirmish validate    # 用一场空对局校验脚本是否可初始化
skirmish view [id]   # 在浏览器打开本地或云端回放(启动静态 server)
```

设计要点:
- **子命令即 ESM 动态 import**:`await import('./init.js')`,让 esbuild 可以把每个子命令单独打包,主入口 `index.ts` 只做路由
- **`run` 支持 JSONL 直出**:`--json` 把 RawMatchLogger 输出打到 stdout(机器消费),进度行打 stderr(人眼消费)
- **`view` 内置本地静态服务**:用 CLI 自带的小 HTTP server 起可视化,避免用户另装工具

## 5. 题目与提示设计

### 5.1 `prompts/OBJECTIVE.md`(每轮都给 LLM)

包含:
- **胜利条件**:摧毁对面 Spawn
- **场地**:100×100,三种地形(plain/swamp/wall)
- **Spawn 设定**:5000 HP、起始 500 energy、孵化每 body part 3 tick
- **body part 表格**:MOVE/ATTACK/RANGED_ATTACK/HEAL/WORK/CARRY/TOUGH 的成本与效果
- **fatigue 系统**:非 MOVE/CARRY 部分按地形加疲劳(plains 2/swamp 10),MOVE 每 tick 减 2
- **能量与经济**:有 source 的地图允许 WORK 收割;CARRY 搬运;无 source 地图鼓励前期压制
- **战斗**:攻击同时结算,body part 按 100 HP/单位承受,part 耗尽即死亡
- **API 全表**:`getObjectsByPrototype`、`getRange`、`findClosestByRange`、`findInRange`、`getTerrainAt`、`getDirection`、`getTicks`、`getObjectById`、`searchPath`、`CostMatrix`
- **每个 GameObject 的方法**:`getRangeTo`、`findInRange`、`findClosestByRange`、`findClosestByPath`、`findPathTo`
- **creep 动作**:`move/moveTo/attack/rangedAttack/rangedMassAttack/heal/rangedHeal/harvest/transfer/pull/drop/pickup`
- **全局常量**:`MOVE, WORK, CARRY, ATTACK, RANGED_ATTACK, HEAL, TOUGH`, `TERRAIN_PLAIN/WALL/SWAMP`, `TOP/TOP_RIGHT/...`, `RESOURCE_ENERGY`, `Creep/StructureSpawn/Source`

### 5.2 `prompts/NEXT_ROUND.md`(仅 round 2-5)

指令是"读上一轮的 match log,改你的脚本"——LLM 因此能利用 in-context learning。

### 5.3 校验

每轮每脚本有 **3 次** 编译/校验重试,失败则该脚本视为该轮弃权。`scripts/bundle-sandbox.ts` 把 `sandbox-runtime.ts` 打成单一 IIFE,被 `runner/sandbox-runtime.bundle.ts` 导出。

## 6. 赛事与基础设施

### 6.1 比赛形态

- 1v1,两脚本对局
- 每轮:每个参赛模型对所有其他模型各打一场(全循环)
- 每个 epoch:多个全循环叠加
- 单场最多 2000 tick;超过未分胜负按 score 决胜
- 起手配置:每玩家一个 Spawn + 1 个军事单位 + 3 个经济单位(部分地图无 source)

### 6.2 主办方跑法(HN 主帖自述)

- **本地 CLI**:`@llmskirmish/skirmish` 全局安装,开发者本地跑对战
- **托管比赛**:Google Cloud Run 上跑 match runner,使用 **isolated-vm**(因为暴露给公网);回放 + 可视化静态站放 Cloudflare
- **模型编排**:每个 LLM 在 Docker 容器里跑 OpenCode(开源通用编码 Agent),orchestrator 给每个容器发 OBJECTIVE.md/NEXT_ROUND.md + 两份参考策略,容器用文件编辑/Shell 工具写脚本
- **诚实工程**:坦承"未观察到 JS 层作弊,主要攻击是 LLM 试图从 harness 里读对方本轮的策略文件"

### 6.3 社区 ladder

- `submit` 把脚本提交到云端
- 每条新提交对所有玩家"最新提交"各打一场
- 走 `rating/` 的 ELO,标准 K=32

## 7. 与 model-war 的差异(对本项目最相关)

| 维度 | LLM Skirmish | model-war(本项目) |
|---|---|---|
| 玩家数 | 1v1 | **1v1v1v1 四方** |
| 测什么 | **in-context learning**(round 2-5 可看 log 改) | **一次写出好策略**(只给编译/校验错误) |
| 题目公开性 | **公开网站**,规则可被抓取训练 | **私有 + 版本化**,防专项训练 |
| 胜负条件 | 推掉对方 Spawn 或 2000 tick 取分 | 四方领土争夺(对称旋转四方) |
| 沙箱 | vm(本地)+ isolated-vm(托管) | 计划 quickjs-wasi(见 hld §5) |
| 模型接入 | OpenCode + Docker + 编排器,完整 pipeline | v0 仅离线"读规则 → 调模型 → 冻结",**引擎不接模型** |
| 交付 | 网站 + 排名 + 静态回放可视化 | CLI + JSONL 回放(v0);视频内容生产在 v0 外 |
| 确定性 | SeededRandom + IdGenerator + 同输入必同 tick 流 | 全整数运算 + 同上要求(见 fsr §2.3) |
| 评分 | 标准 ELO(K=32,init 1500) | 赛制与积分规则**待定**(srs §6) |
| 取分机制 | spawn-only 与 spawn-and-creeps 可切换 | 领土/资源/经济复合,四方对称 |
| 脚本语言 | JavaScript(LLM 写的 `loop()`) | **TypeScript 子集**(引擎同构,沙箱成熟) |
| 提示可见性 | OBJECTIVE.md 全文公开 | 私有 + 版本号 + diff;规则改动要回写 fsr/srs/gdd/hld |

> 关键启示:LLM Skirmish 已验证"LLM 写陌生 RTS API 代码 + 自动跑出有差异胜率"在工程上是**可落地**的(见 fsr §3.1)。但它的评测协议偏向"模型迭代能力",与 model-war 要测的"一次写出好策略"不是同一能力——两者并存,各自证明不同的模型擅长面。

## 8. 我们能学 / 不能学的东西

### 8.1 可以借鉴

- **runner 三层抽象**(BaseRunner → MatchRunner/IsolatedRunner):把"沙箱机制"与"host 逻辑"解耦,日后上更强的隔离运行时不用改 driver/processor。**hld 应明确类似分层**
- **沙箱 API 与 host 通信只暴露 intent 注入**:LLM 脚本看不到 Mongo、Redis、文件系统,任何状态改变必须经 `_addIntent`,引擎独占 `BulkOperation`——本项目也建议如此,杜绝脚本绕过引擎直接改真值
- **JSONL 回放 + LLM 友好文本日志双格式**:机器用 JSONL,人/下一轮 LLM 用带 run-length 压缩的文本。我们 srs §3.2 提到"v0 只保证可渲染可叙事",可以参考这种文本日志风格
- **`prompts/` 与 `engine/` 解耦**:提示词不进引擎包,改动提示词不需重发引擎二进制。我们应把 OBJECTIVE 拆到独立目录
- **ELO 与赛事编排解耦**:`rating/` 是纯函数,可被 CLI、网站、CI 共用。我们即使积分规则待定,也建议先把这个口子留出来
- **bundled sandbox runtime**:`scripts/bundle-sandbox.ts` 把沙箱代码打成单一 IIFE,主进程拿字符串直接 `vm.Script()`——避免 spawn 子进程加载 ESM 的复杂依赖关系,适合 quickjs-wasi 的字符串执行模型

### 8.2 不应照搬

- **支持多轮迭代会改变评测语义**:Round 2-5 看 log 改策略是在测"调试 + 提示工程",**不是** model-war 想测的"按文档一次写出好策略"。如果未来想做"难度阶梯",建议作为独立产品线,**不混入主赛季**
- **OpenCode + Docker 编排**:这是把 LLM 当对手时的工程基建,与本项目 v0 的"离线脚本生成"形态冲突。本项目**故意**让引擎不接模型,只要"脚本 + 模型名"即可重放
- **公开题目**:LLM Skirmish 的最大缺陷就是题目可被抓走做专项训练。我们一定要坚持**题目私有 + 版本化 + 可演化**(fsr §1 差异化卖点)
- **网站 + 排名驱动**:model-war v0 是内容生产工具,不是排名平台——网站/视频生产是远期规划,不在 v0 范围

## 9. 风险与未决项(对 LLM Skirmish 自身的客观记录)

- **沙箱安全性**:vm 不是安全边界,任何公网开放的对战(社区 ladder submit)都需要 isolated-vm 或更强的隔离;否则脚本可读宿主进程内存、发起网络请求
- **诚实性问题**:HN 主帖自述"LLM 试图读对方脚本"——需要严格的文件/网络隔离。本项目若未来开放云端,同样要面对
- **题目公开**:任何放在公开仓库 + 公开文档站的规则都是可被训练集收录的;他们的数据集已经公开(见 GitHub repo 现状)。这是他们模式的固有限制
- **回放体积**:1 场 2000 tick × 几十个对象,JSONL 仍可达 MB 级;未来若要批量出内容,需要 tick 抽样或状态差分压缩(参考 [gdd.md §8.3](../gdd.md) 提到的"回放数据可渲染可叙事")

## 10. 参考链接

- 仓库:<https://github.com/llmskirmish/skirmish>
- 官方网站:<https://llmskirmish.com>
- 文档站:<https://llmskirmish.com/docs>
- 提示词: <https://github.com/llmskirmish/skirmish/blob/main/prompts/OBJECTIVE.md>
- HN 主帖:<https://news.ycombinator.com/item?id=47149586>(作者 Kai 自述架构与运行经验)
- npm 包:<https://www.npmjs.com/package/@llmskirmish/skirmish>
- 相关:Screeps(原 MMO RTS for programmers)、Screeps Arena(本仓库引擎直接 fork 的目标)

---

> 本文件由 model-war docs 维护。如 LLM Skirmish 仓库结构发生重大变化(尤其 runner/ rating/ cli 命令面),请同步更新本文,并在本仓库发一条 `needs-triage` issue。
