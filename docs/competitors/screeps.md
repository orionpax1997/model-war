# 竞品分析:Screeps(screeps/screeps)

- 仓库:<https://github.com/screeps/screeps>(umbrella 仓库)
- 官方网站:<https://screeps.com>(World / MMO);<https://docs.screeps.com>(官方文档)
- 最新版本:umbrella `screeps@4.3.0`(npm,2026-04);`@screeps/engine@4.3.2`、`@screeps/launcher@4.2.0`、`@screeps/backend@3.3.0`、`@screeps/common@2.15.5`
- 仓库星数:~3,330(umbrella);`screeps/engine` 独立仓库 ~140 星
- 文档版本:v1.0(对齐 model-war docs/fsr.md v1.3)
- 状态:主动维护但节奏缓慢;官方仓库最后活跃 2024-2026,主要在补 bug 与对 PTR 同步。
- 许可证:ISC
- 创立时间:2016-11

> 本文档不复制 model-war 的决策结论,只描述 Screeps 自身的实现。对比分析放在最后一节。

## 1. 一句话定位

**Screeps 是一个常驻 MMO RTS,核心机制是玩家用 JavaScript 编写 colony 单位的 AI,代码 24/7 不间断地在一个持久化、共享的大世界里运行。**

- 评测/游戏对象:**真人**(不是 LLM,但 community 已大量用 LLM 生成 AI)
- 世界形态:持久化、按 shard 分片的 MMO 大世界(World / MMO)
- 评测形态:玩家代码在官方服务器或自建 private server 上常驻运行,与所有其他玩家共存一个 tick 节拍
- 沙箱:**node `vm`**(默认 runtime)+ **isolated-vm**(付费订阅,2026 仍是可选)
- 持久化:**MongoDB**(官方)+ **LokiJS / MongoDB / Redis**(private server 可替换)
- 路径规划:C++ 原生模块 [`@screeps/pathfinder`](https://github.com/screeps/pathfinder),author Marcel Laverdet,后被独立强化为 npm 包 [`pathfinding`](https://www.npmjs.com/package/pathfinding)

它**不是**:
- 一个一次写完即比赛的 LLM 评测系统(尽管 community 把它当 LLM 评测场来用)
- 单房间对战(那是 **Screeps Arena** —— 同样官方出品,LLM Skirmish 的直系祖先)
- 教程类 / 关卡类游戏(虽然有 tutorial,但核心是 MMO)

> **姊妹仓库 [xxscreeps](https://github.com/screepts/xxscreeps)**(同作者 laverdet):Screeps 的 from-scratch 重写版,核心创新是把 room 序列化为 binary blob 并 `withOverlay()` 直接把 JS 对象挂到 ArrayBuffer 之上,大幅降低 GC 压力。本文聚焦官方 screeps/screeps;xxscreeps 在 §9.2 单独对比。

## 2. 顶层结构

### 2.1 仓库形态

**多仓 + npm 包形式**(不是 monorepo)。umbrella 仓库 `screeps/screeps` 只放 launcher GUI、postinstall、模块拼装脚本,**真正的代码分布在 6 个独立 GitHub 仓库**,每个仓库就是一个独立 npm 包:

```
screeps/screeps                 ← umbrella,本仓库,~3.3k stars
├── screeps/launcher            ← @screeps/launcher,~? stars
├── screeps/storage             ← @screeps/storage
├── screeps/backend-local       ← @screeps/backend(私有服务器后端)
│     (官方 MMO 还有一个 screeps/backend,不在公开仓库)
├── screeps/engine              ← @screeps/engine,~140 stars
├── screeps/driver              ← @screeps/driver
└── screeps/common              ← @screeps/common
```

每个模块通过 npm 安装到 umbrella 仓库的 `node_modules/`,代码**不进 umbrella 工作区**。这种"分布式单仓"在 2016 年是少见的(现在反而是 some-package-many-publishes 的先驱)。优点是 engine 包可以被官方 MMO、private server、in-browser simulation 三方共享;缺点是开发时跨包跳转/重构体验差。

每个独立仓库内部是普通 Node.js 工程:

```
screeps/engine/
├── src/
│   ├── game/                  # 沙箱内的对象原型(Room/Creep/Spawn/...)
│   ├── runtime.js             # vm 沙箱建立、缓存、fork 关闭
│   ├── intents/               # intent 处理器(按对象/动作拆分)
│   │   ├── creep/{move,attack,harvest,...}.js
│   │   ├── spawn/{spawnCreep,...}.js
│   │   └── ...
│   ├── pathfinding/           # pathfinder 桥(对接 native module)
│   └── ...
├── package.json
└── ...
```

### 2.2 依赖流向

```
                 ┌────────────────────────┐
                 │   screeps/screeps      │   umbrella:仅 GUI + launcher 脚本
                 │   (screeps 4.3.0)      │   + postinstall
                 └────────────┬───────────┘
                              │ npm install 6 个包
            ┌────────────┬────┴─────┬─────────────┬─────────────┬───────────┐
            ▼            ▼          ▼             ▼             ▼
     ┌────────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────┐ ┌──────────┐
     │ @screeps/  │ │  storage│ │ backend │ │   engine    │ │  driver  │
     │ launcher   │ │         │ │(local)  │ │  ★ 核心     │ │          │
     │ (启动编排) │ │ (DB+KV) │ │ (HTTP/  │ │             │ │ (DB 适配)│
     └─────┬──────┘ │ pub/sub)│ │  CLI)   │ └──────┬──────┘ └────┬─────┘
           │        └────┬────┘ └────┬────┘        │             │
           │             │           │             │             │
           │             └─────┬─────┘             │             │
           │                   │                   │             │
           │            ┌──────▼─────┐              │             │
           └───────────►│ @screeps/  │◄─────────────┴─────────────┘
                        │ common     │  共享常量、工具
                        └────────────┘
```

- `common` 是叶子包,被 storage / backend / engine / driver / launcher 都引
- `engine` **不**依赖 driver/storage;driver 反过来适配 engine
- `backend` / `storage` 通过 driver 与 engine 对接
- `launcher` 启动所有进程并附带 GUI

### 2.3 与 model-war 工程结构的差异(先标,§7 详比)

| 维度 | Screeps | model-war(本项目) |
|---|---|---|
| 仓库组织 | **多仓 + npm 包** | pnpm workspace **单仓多包** |
| engine 复用 | engine 包同时给官方 MMO、private server、in-browser sim 用 | engine 自用 + 可对外(待定) |
| 部署形态 | **多进程分布式**,官方 MMO 跨机器集群 | **单进程**,对局用子进程隔离(见 hld §2.1) |
| 持久化 | **强依赖 DB**(Mongo / LokiJS / Redis) | 纯内存 + JSONL 回放,hld 已禁 DB |

## 3. 技术栈

| 维度 | 选型 | 备注 |
|---|---|---|
| 语言 | **JavaScript**(Node.js 原生 ES2015+) | 引擎 + 玩家脚本 + GUI 全部 JS;engine 几乎没有 TypeScript 注释 |
| 运行时 | Node.js ≥ 10 LTS(umbrella 写 "Node.js 10 LTS or higher") | 实际生产已跑 Node 18+;player 沙箱 vm 也要求 Node |
| 包管理 | npm(非 pnpm/yarn) | 6 个独立 npm 包,umbrella 通过 `dependencies` 引入 |
| 多进程 | Node.js `child_process.fork()` | 每个 runtime server 是独立 fork,进程隔离 + 独立 v8 heap |
| 进程间通信 | **Redis List 队列**(官方 MMO)+ **Node IPC / 内置 storage**(private server) | tick 编排跨进程用 Redis List 做 task queue |
| 数据库(官方 MMO) | **MongoDB 3**(WiredTiger 引擎) | 每房间/每对象是一份 Mongo 文档,`id` 即 `_id` |
| 数据库(private) | **LokiJS**(默认,纯 JS,可嵌入 Steam 客户端)+ 可替换 MongoDB / Redis | 同一份 `driver` 抽象提供三种 backend |
| 沙箱 | **node `vm`**(默认 / private server 唯一)+ **isolated-vm**(官方 MMO 付费) | engine 内部用 `vm.runInContext`,执行在 fork 子进程 |
| 路径规划 | 原生 C++ 模块 [`@screeps/pathfinder`](https://github.com/screeps/pathfinder),绑定成 Node add-on | A* + Dijkstra;`CostMatrix` 由玩家 JS 提供 |
| 随机数 | **无 SeededRandom** | engine 内不使用 RNG;战斗/孵化等都是确定性公式 |
| ID 生成 | Mongo `ObjectId`(官方)/ LokiJS 自增 id(private) | driver 抽象的 `db()` 接口生成 |
| WebSocket(客户端) | 自实现(`backend/lib/game/socket/`) | 给客户端浏览器推 room diff |
| HTTP(客户端) | Express(legacy)/ 现自实现 router | `@screeps/backend-local` 内部分文件结构:`lib/game/api/*.js` |
| 客户端 GUI | 浏览器端 JS + PixiJS(2D 渲染,WebGL 优先,canvas fallback) | Steam 客户端内嵌 Chrome 浏览器 |
| CLI(管理) | Node `vm` + Express 风格路由 | 端口 21026(默认),执行任意 JS 改 game state |
| 测试 | **未在仓库根发现显式测试配置** | Screeps 早期没有 CI 文化;依赖 PTR(public test realm)做集成 |
| Lint/Format | 无 | repo 没配 ESLint/Prettier |

### 3.1 关键工程取舍

- **node `vm` 沙箱**:与 LLM Skirmish 同样的选择 —— vm 在同一进程内开多个 Context,CPU 开销远小于 worker_threads/fork 启动。代价:**vm 不是安全边界**,玩家脚本可读到宿主全局变量 → 官方 MMO 付费加 isolated-vm;private server 至今仍默认 vm,只能靠进程级 fork 隔离 + 严格超时 kill。Screeps 团队 2017 写过一篇博客 [Optimizations roadmap](https://blog.screeps.com/2017/06/optimizations/) 说明 isolated-vm 替换计划,但 9 年后仍部分兑现。
- **每个对象一个 Mongo 文档**:每个 RoomObject(Creep/Spawn/Source/Tower/...)都是一个独立的 Mongo document,`id` = `_id`。优点是局部更新便宜、跨 shard 自然;缺点是单房间读取要 join 多个文档,runner 端要做拼装。xxscreeps 用 binary blob + overlay 直接解决了这个 join 问题。
- **`vm.runInContext` + 缓存编译结果**:玩家脚本编译后,编译产物缓存在 fork 进程内,后续 tick 不再重编译。这与 model-war hld §5 提到的"预编译 + 字符串注入"思路一致,但 model-war 选 quickjs-wasi 而非 node vm。
- **intent-模式 API**:玩家调用 `creep.move(TOP)` 不会立刻改状态,而是"提交一个 intent";engine 在每个 tick 末把所有 intent 收集起来跑"结算管线"(参见 §4.2)。这是 LLM Skirmish 直接借鉴的设计 —— LLM Skirmish 的 `_addIntent` 与 Screeps 的 `intent` 在概念上完全同构。
- **driver 与 engine 解耦**:engine 是"环境无关"的纯逻辑(同一个 engine 既能跑在 Node 上,又能跑在浏览器内嵌);driver 负责把"DB / 内存 / 跨进程"这些 I/O 细节包装成 engine 要的接口。这一抽象让 Screeps 能在官方 MMO、私服、in-browser sim 三方复用同一份 engine。

## 4. 模块架构设计

### 4.1 分层

```
┌──────────────────────────────────────────────────────────────┐
│  @screeps/launcher                                          │
│   - 启动 GUI(Steam 客户端 / Electron / 控制台)              │
│   - fork 出多个 runtime / backend / storage 进程            │
│   - 暴露端口 21026 管理 CLI                                  │
├──────────────────────────────────────────────────────────────┤
│  @screeps/backend (backend-local)                           │
│   - HTTP API:auth / game / map / market / user / badge / leaderboard
│   - WebSocket:房间事件推送                                   │
│   - 管理 CLI:21026 端口,vm 执行任意 JS                      │
│   - cronjobs:invader / stronghold / powerBank 生成          │
├──────────────────────────────────────────────────────────────┤
│  @screeps/storage                                           │
│   - LokiJS / MongoDB / Redis 适配(默认 LokiJS)             │
│   - 键值存储 + Pub/Sub                                      │
│   - 所有进程通过它交换数据                                  │
├──────────────────────────────────────────────────────────────┤
│  @screeps/driver                                            │
│   - 把 DB / 内存 / 跨进程的 I/O 抽象成 engine 期待的接口    │
│   - bulkInsert / bulkUpdate / bulkRemove / saveIntents      │
│   - 提供 room 对象的 lazy 反序列化                          │
├──────────────────────────────────────────────────────────────┤
│  @screeps/engine  ★ 核心                                     │
│   - 玩家脚本沙箱建立(vm / isolated-vm)                      │
│   - intent 收集与结算管线                                   │
│   - Game / Room / Creep / Spawn / Source ... 原型           │
│   - pathfinder 桥                                           │
├──────────────────────────────────────────────────────────────┤
│  @screeps/common                                            │
│   - 共享常量、协议、协议代码、错误码、utils                 │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 单 tick 数据流(关键路径)

官方 MMO 一场 tick 由 Redis List 编排,**两个阶段**(详见 docs.screeps.com/architecture.html):

```
                        ┌───────────────────────────┐
                        │    Tick 时钟(tick 主控)   │
                        │   推进 Game.time += 1     │
                        └────────────┬──────────────┘
                                     │
              ┌──────────────────────┴──────────────────────┐
              │                                             │
              ▼                                             ▼
  ┌─────────────────────────┐               ┌─────────────────────────┐
  │ 阶段 1:玩家脚本计算      │               │ 阶段 2:房间结算         │
  │ (per-player 队列)        │               │ (per-room 队列)         │
  │                         │               │                         │
  │ 每个玩家 = 一个 task     │               │ 每个 active room = 一个 │
  │ runtime server fork 取出 │               │ task                    │
  │ 加载该玩家需要的         │               │                         │
  │ GameObject + Memory      │               │ 收集该 tick 所有 intents│
  │ vm.runInContext(玩家脚本)│               │ 按 room 内对象+动作分类│
  │ 超时 kill fork          │               │ 调 pathfinder 算 movement│
  │ 收集 intents → 写回 storage│             │ 同时攻击 / 治疗 / 死亡 │
  │                         │               │ 对象 tick(sources regen │
  │                         │               │ spawn 进度 等)         │
  │                         │               │ 生成 BulkOperation      │
  └────────────┬────────────┘               └────────────┬───────────┘
               │                                         │
               └────────────────┬────────────────────────┘
                                ▼
                  ┌───────────────────────────┐
                  │ 阶段 3:DB bulk write       │
                  │ Mongo WiredTiger 并发提交   │
                  │ (DB 唯一 I/O 点,1 分钟 flush)│
                  └────────────┬──────────────┘
                               ▼
                  ┌───────────────────────────┐
                  │ 推进下一个 tick           │
                  │ backend 推 diff 给客户端  │
                  └───────────────────────────┘
```

- **stage 1 和 stage 2 并行执行**(不同 runtime server 同时跑不同 player / 不同 room 的 task)
- **stage 3 是唯一的 DB 写入点**,DB 端用 WiredTiger 的 document-level concurrency 跨线程提交
- 房间数 / 玩家数 >> CPU 核数时,**按 CPU 核数 1 room / 1 player 同步处理**,消除 race condition
- 玩家脚本 CPU 预算:**`Game.cpu.limit` 配额**;超时强制 kill 整个 fork(不是 kill vm),下次 tick 重建 vm 上下文(代价大)

### 4.3 关键模块详解

#### 4.3.1 `@screeps/engine`(游戏核心)

- **沙箱建立**:`runtime.js` 启动时为每个玩家 fork 一个进程,创建 `vm.createContext(sandbox)` 并 `vm.runInContext(userCode, { timeout: cpuLimit })`
- **Game / Room / Object 原型**:`src/game/` 下按对象类型拆文件(Room / Creep / Spawn / Source / StructureTower / ...),通过 `register.wrapFn()` 注册到沙箱 globalThis
- **状态分发**:每 tick 重新从 driver 取该玩家可见的 room 对象,JSON 序列化注入沙箱
- **intent 收集**:`src/runtime.js` 维护 `intents` 字典,玩家调用 `creep.move(TOP)` 时 engine 把 `(objectId, action, args)` push 到 intents
- **错误码**:`OK / ERR_NOT_OWNER / ERR_BUSY / ERR_INVALID_ARGS / ERR_NO_PATH / ...`,所有 API 方法返回 `ERR_*` 常量
- **CPU 计量**:`Game.cpu.getUsed()` 报告当前 tick 已用 CPU(`process.cpuUsage()` 累加);`Game.cpu.limit` 是玩家上限;`Game.cpu.setShardLimits(...)` 用于 shard 配额

#### 4.3.2 `engine/intents/`(intent 处理器)

按对象类型 + 动作拆目录,典型结构:

```
src/intents/
├── creep/
│   ├── move.js
│   ├── attack.js
│   ├── rangedAttack.js
│   ├── heal.js
│   ├── harvest.js
│   ├── transfer.js
│   ├── build.js
│   ├── ...
├── spawn/
│   ├── spawnCreep.js
│   ├── renewCreep.js
│   ├── ...
├── structureTower/
│   ├── attack.js
│   ├── heal.js
├── structureController/
│   ├── upgrade.js
│   └── ...
```

每个 intent 文件导出两个东西:**`check()`**(纯函数,验证书面参数合法性)+ **`run()`**(实际修改状态)。这种"check / run 分离"允许 driver / processor 在 stage 2 重新校验(stage 1 在沙箱里的 check 不可信,因为玩家可以绕过 API 直接调 `intents.save()` —— 已被 Screeps 团队文档明确警告)。

#### 4.3.3 `@screeps/driver`(环境适配)

- **适配 DB / KV / pub-sub**:同一份 engine 既能跑在 LokiJS(纯 JS,Steam 客户端内嵌)、MongoDB(官方 MMO)、Redis(用户自建),driver 提供 `db.users / db.rooms / db.objects / ...` 这一层 facade
- **BulkOperation**:`engine.processTick()` 结束时,driver 收集所有 stage 2 产生的 BulkOperation,通过 Mongo bulk write / LokiJS batch insert / Redis pipeline 提交
- **Lazy 反序列化**:DB 端存的是 plain JSON,driver 在 stage 1 读取时只反序列化玩家"看得见"的对象(`visible: true` 才推给沙箱)
- **可替换**:README 明确说 "You can replace this module with your own one" —— driver 是 private server 二次开发的最常见改造点

#### 4.3.4 `@screeps/storage`(存储抽象)

- **LokiJS**(默认):单文件 `db.json`,可嵌入纯 JS 环境(Steam 客户端)
- **MongoDB**:生产环境;WiredTiger 引擎;`runTimeServer` 永远不直接访问磁盘(数据已预加载到内存)
- **Redis**:**进程间通信** + task queue(stage 1 / stage 2 task list)
- **Pub/Sub**:backend 监听 tick 事件向 WebSocket 客户端推送 room diff

#### 4.3.5 `@screeps/backend`(HTTP + CLI)

- HTTP API 路由:`lib/game/api/{auth,badge,game,leaderboard,market,user,...}.js`
- WebSocket 推送:`lib/game/socket/{rooms,map,user,server,...}.js`,基于自实现 ws 协议
- 管理 CLI:`lib/cli/{bots,map,server,system,...}.js`,监听 21026 端口,在自己的 vm 里执行管理员 JS
- **cronjobs**:`lib/cronjobs.js` —— 自动生成 invader / stronghold / powerBank / deposit
- **Steam auth**:`lib/authlib.js` 接入 Steam OpenID

#### 4.3.6 `@screeps/launcher`(进程编排 + GUI)

- 启动 storage / backend / engine / driver 进程(各若干个)
- Electron / Steam 内嵌 GUI 暴露控制台
- 暴露端口 21026 供管理员 CLI 接入
- 进程数 / 配置通过 `mods.json` / 命令行参数控制

#### 4.3.7 `@screeps/common`

- 共享常量、错误码、协议代码、房间坐标压缩(`RoomPosition._packedPos`)、utils
- **被 5 个模块都依赖**,几乎没有业务逻辑

### 4.4 mod 系统

Screeps 一大亮点是 **modding**:不直接改 engine 代码,而是在 `mods.json` 里挂 JS 文件,每个文件 `module.exports = function(config) { ... }`:

```js
// example-mods/my-mod.js
module.exports = function (config) {
  // config 可能是 engine / backend / runner / storage 中之一
  // 它是 EventEmitter,可以监听 tick / roomInit / ...
  config.on('tick', () => { /* ... */ });
  config.someProperty = 123; // 改默认行为
};
```

- 每个 mod 文件**每个进程各被 require 一次**,所以一个 mod 要根据 `process.type` 区分行为
- 例子:`example-mods/` 提供少量范例,但 README 直白说 "We have not prepared documentation for all available properties yet"
- **不要直接改 server 源码** —— 改源码会阻塞后续升级,且 Steam 客户端会断连

LLM Skirmish 直接复用了这套 modding 思路(Skirmish CLI 的子命令即 ESM 动态 import 风格相近);但 model-war v0 **不计划**做 modding,所有逻辑内置。

## 5. API 表面(玩家可见)

### 5.1 全局对象

- `Game.time`(全局 tick 号)
- `Game.creeps / Game.spawns / Game.structures / Game.rooms / Game.flags / Game.constructionSites` —— Map 形式索引
- `Game.cpu.getUsed() / Game.cpu.limit / Game.cpu.setShardLimits(...)`
- `Game.map`(世界地图描述)
- `Game.market`(玩家间交易市场)
- `Game.shard`(当前 shard 名)
- `Game.gcl`(Global Control Level)
- `Memory`(玩家私有 KV,自动 JSON 序列化)
- `RawMemory`(原始字符串 memory + 异步 segments)
- `InterShardMemory`(跨 shard 通信,稀疏 polling)

### 5.2 RoomObject 方法

- `creep.move(dir) / moveTo(target)` —— 提交 move intent
- `creep.attack(target) / rangedAttack(target) / rangedMassAttack() / heal(target)`
- `creep.harvest(source) / transfer(target, resourceType) / withdraw(target, resourceType) / pickup(resource)`
- `creep.build(constructionSite) / repair(structure) / upgradeController(controller)`
- `creep.claimController / reserveController / attackController`
- `room.createConstructionSite(x, y, structureType)`
- `spawn.spawnCreep(body, name, opts)` —— **返回的 Creep 对象不会立刻可用**,下个 tick 才能通过 `Game.creeps[name]` 拿到(经典坑)
- `tower.attack(target) / heal(target)`
- 所有 API 方法返回 `OK` 或 `ERR_*` 错误码

### 5.3 全局函数 / 模块

- `PathFinder.search(origin, goal, opts)` —— **C++ 原生模块**,支持多房间、自定义 CostMatrix
- `Room.find / Room.findPathTo / Room.getPositionAt(...)` —— JS 实现,deprecated 但还在
- `Room.lookAt(x, y) / Room.lookFor(type, x, y)` —— 查询地形/对象
- `Game.map.getRoomLinearDistance / describeExits / findRoute`
- `Game.notify(message, groupInterval)` —— 给玩家发系统消息

### 5.4 intent 模式(关键)

```
玩家 tick:                         engine stage 2:
─────────                          ─────────────────
creep.move(TOP)        ─────►     intents['move'][creep.id] = TOP
                                   (不立刻改 state)
                                   ...
spawn.spawnCreep(...)  ─────►     intents['spawnCreep'][spawn.id] = body
                                   ...
                                   ──tick 边界──
                                   结算管线按对象类型处理所有 intents
                                   失败的 intent 静默丢弃
                                   成功的 intent 改 room blob
```

文档警告:
- **同一对象同一 tick 只能有一个该类型的 intent**(`creep` 同一 tick 不能既 attack 又 rangedAttack;`spawn` 同 tick 不能 spawnCreep 两个 body)
- **同一对象同 tick move 多次,只最后一个生效**(不是队列)
- **不要缓存对象跨 tick** —— 每 tick 必须 `Game.creeps[name]` / `getObjectById(id)` 重新拿,因为旧引用可能已失效
- **intent 互斥表见** [simultaneous-actions.html](https://docs.screeps.com/simultaneous-actions.html)

### 5.5 CPU 计量与限制

- `Game.cpu.getUsed()` 当前 tick 已用 CPU(ms)
- `Game.cpu.limit` 本 tick 配额(玩家可设)
- `Game.cpu.bucket` 缓冲区(0-10000,满了之后多出 CPU 累积)
- `Game.cpu.setShardLimits({ shard0: 20, shard1: 80 })` 跨 shard 分配配额
- 超时强制 kill fork(下次 tick 重建 vm 上下文,代价大)

## 6. 部署与基础设施

### 6.1 官方 MMO(World)

- **服务端**:Node.js 8.9.3(2017 数据,现已升级;20k 行 JS)
- **并行**:40 台四核 OVH dedicated servers = **160 颗 Intel Xeon E3-1231 v3**,分阶段执行 task
- **DB**:MongoDB 3 + WiredTiger,24 核 + 128GB RAM,处理 30k update requests/sec
- **沙箱**:vm(免费) / isolated-vm(订阅)
- **sharding**:近年上线"多 shard"架构(2 秒 tick 的新 shard),跨 shard 用 portal / InterShardMemory
- **客户端**:Steam 内嵌 Chrome,JS + PixiJS(WebGL/canvas)

### 6.2 Private Server(自建)

- 6 个 npm 包全部开源(只有官方 MMO 的部分是闭源)
- 默认存储:LokiJS,单文件 `db.json`
- 可替换:MongoDB / Redis(改 driver 模块)
- 启动:`screeps launch`(启动 launcher GUI)或 `screeps start`(无 GUI)
- 端口:21025(后端 HTTP),21026(管理 CLI)
- Steam auth:可选;非 Steam auth 也可(自建 token)
- 玩家上限:无硬上限(取决于机器资源)

### 6.3 mod 与 NPC bot

- mod:挂 `mods.json`,JS 文件 `module.exports = function(config) { ... }`
- NPC bot:`mods.json` 的 `bots` 字段,自带 `simplebot` 模板
- 通过 CLI 命令 `system.bot({ op: 'spawn', user: 'bot1', body: [...] })` 控制

### 6.4 失败 / 重试语义

- 玩家脚本**没有重试机制**:intent 失败就失败,玩家代码下 tick 自适应
- compile 失败(语法错)直接不让 tick 运行,玩家在 IDE 看到错误
- vm timeout 强制 kill fork(下 tick 重建上下文,玩家感知为"代码没跑")
- 不存在 LLM Skirmish 的"3 次重试"机制 —— Screeps 玩家自己 debug

## 7. 与 model-war 的差异(对本项目最相关)

| 维度 | Screeps | model-war(本项目) |
|---|---|---|
| 评测对象 | **真人 + community LLM** | **前沿 LLM** |
| 评测形态 | **常驻 MMO**,24/7 跑 | **一次写出好策略**,离线脚本生成(见 hld §1) |
| 玩家数 | **N 个玩家**共享一世界 | **1v1v1v1 四方**对称 |
| 题目 | **开放世界**(claim room / 建 spawn / 挖矿 / 战斗 / 市场) | **封闭对称地图**(gdd.md) |
| 胜负条件 | 无;以 GCL / leaderboard 排名 | **领土争夺**,四方按 schema 取分 |
| 沙箱 | **node `vm`**(默认)+ isolated-vm(付费) | **quickjs-wasi**(hld §5) |
| 持久化 | **强依赖 DB**(Mongo / LokiJS / Redis) | **纯内存 + JSONL 回放**,hld 已禁 DB |
| 进程模型 | **多进程分布式**,跨机器集群 | **单进程**,对局子进程隔离 |
| tick 编排 | **Redis List 队列**,stage 1/2/3 串行 | **进程内串行**(hld §2.3),无跨进程 |
| intent 模式 | ✅ 经典实现,llm-skirmish 直接借鉴 | ✅ 借鉴(hld §4.2) |
| 路径规划 | C++ 原生 + 自带 `PathFinder` | TypeScript A*(引擎同构) |
| 随机数 | 无 | **SeededRandom**(hld,确定性必填) |
| ID | Mongo ObjectId / LokiJS 自增 | **IdGenerator**(hld) |
| API 风格 | **实例方法 + 返回错误码**(`creep.move() → OK/ERR_*`) | 借鉴,**stateless 函数 + intent 注入** |
| 类型系统 | JS only | TS 严格(本仓)+ TS 子集(沙箱脚本) |
| 规则面 | 大而全(几十种结构 + market + power) | **最小**(hld §1,4 兵种 + 规则数据文件) |
| modding | ✅(`mods.json` + config EventEmitter) | ❌ v0 不计划 |
| 客户端 | Steam 内嵌 Chrome + PixiJS | **CLI ASCII 回放**(v0);视频内容生产在 v0 外 |
| 确定性 | 不需要(MMO 持久化,接受 drift) | **必须可复算**(fsr §2.3) |
| 评分 | leaderboard / GCL | **待定**(srs §6) |
| 取分机制 | 玩家自治(没机制) | **领土/资源/经济复合**,四方对称 |

> 关键启示:Screeps 证明了 **"JavaScript + intent 模式 + sandbox + 持久化世界"** 在工程上能撑住一个 9 年仍在运营的商业产品。但 Screeps 的工程重心在"**规模化分布式**"(40 台 dedicated server、Mongo sharding、cross-shard portal),这与 model-war v0 的"**离线评测工具**"形态完全不同。

## 8. 我们能学 / 不能学的东西

### 8.1 可以借鉴

- **intent 模式**:玩家调用 `creep.move(TOP)` 不直接改状态,而是 push 到 intents[objectId][action]。结算管线在 tick 末批量处理。这是 model-war hld §4.2 已经明确借鉴的核心模式。
- **沙箱与 host 通信只暴露 intent 注入**:LLM Skirmish 学的就是这套。本项目也建议如此 —— LLM 脚本看不到 Mongo / 文件系统,任何状态改变必须经 `_addIntent`,引擎独占 `BulkOperation`。
- **`engine` / `driver` 解耦**:engine 是"环境无关的纯逻辑"(Screeps 同一份 engine 既能 Node 跑也能浏览器跑),driver 适配 I/O。我们可以把 driver 抽象当作未来"换 quickjs → 其他 VM"的缓冲层。
- **`check()` / `run()` 分离**:intent 文件导出纯函数 check 用于双重校验(runner 端 + processor 端),保证双端答案一致。model-war 如果未来要做"LLM 写一次,沙箱与结算两次跑",这种分离能省下大量重复代码。
- **`@screeps/common` 这种叶子包**:所有模块共享的常量、错误码、协议代码集中到一处。model-war 的 `packages/types` 就是这个位置(见 hld §3.2)。
- **`config` EventEmitter** modding 模式:模块启动时把 config 当 EventEmitter 传给 mod,mod 可以监听 `tick / roomInit / ...` 并改写默认行为。如果未来要支持"自定义规则 mod",这是好范式。
- **CPU 计量 + bucket + shardLimits**:`Game.cpu.bucket` 这种"溢出累积"设计比简单 tick 限额更平滑,可以作为 model-war 评分 NFR 的参考。

### 8.2 不应照搬

- **持久化 + Mongo 集群**:model-war hld §1 已禁 DB,理由:benchmark 不需要持久化,JSONL 回放就是归档;Mongo sharding 这套分布式基础设施对 v0 完全过设计。
- **多进程 + Redis List 队列**:hld §2.3 已简化为"进程内 4 VM 串行"。LLM 评测不是 MMO,不需要 stage 1 / stage 2 分开,也不需要按房间横扩 worker。
- **stage 1 / stage 2 / stage 3 三阶段**:model-war 单 tick 串行做完整结算,hld 不需要跨进程同步。
- **不强制 vm**:Screeps 2016 选 vm 是因为没 isolated-vm;model-war 2026 选 quickjs-wasi(见 hld §5),是更现代的隔离方案。
- **`creep` 实体 + tick 间对象失效**:Screeps 因 MMO 持久化,对象跨 tick 自然会失效;model-war 短局对战,对象跨 tick 持久缓存完全可行,hld 应当显式声明此差异。
- **modding 系统**:v0 不做。如果未来要做"社区规则 mod",再单独立项。
- **PixiJS 客户端 + Steam 集成**:v0 只做 CLI ASCII 回放;视频内容生产在 v0 外。

## 9. 姊妹项目

### 9.1 Screeps Arena(steam 1137320)

- **官方独立产品**,但属 Screeps 家族
- 形态:**1v1 / 2v2 / 3v3 短局**,ELO 排名
- 玩家代码**不能在 match 中改**,开局前交脚本
- API 与 World 有差异(更简洁、引入 `game/prototypes` / `game/utils` 模块化 import)
- **LLM Skirmish 的直接祖先**(见 [docs/competitors/llm-skirmish.md](./llm-skirmish.md))
- 类型定义: [`@screeps-arena-community/types`](https://github.com/screeps-arena-community/types)

### 9.2 xxscreeps(screepts/xxscreeps)

- **同作者 Marcel Laverdet**(`isolated-vm` + `@screeps/pathfinder` 的作者)的 from-scratch 重写版
- **核心创新**:把 room 序列化为 binary blob(250 字节 - 60KB),用 `withOverlay()` 把 JS 对象直接挂到 ArrayBuffer 之上 —— 访问 `creep.body` 才会 materialize,GC 压力骤降
- 架构:main loop(tick 时钟)+ runner / processor / backend **三个独立服务**,各持独立 JS heap,通过 binary blob 交换数据
- **dual validation**:runner 与 processor 都对同一 intent 调 `check*`,答案一致才算合法
- **private symbol + `#private` + babel transform**:`this['#field']` 在编译期转 private symbol(isolated-vm 限定),引擎内部状态对玩家完全不可见
- 几乎所有游戏逻辑都是 **mod**,核心引擎刻意做小
- **TypeScript + 详细类型注释**,`Creep.prototype.transfer` 等 API 直接复用同一份代码
- 项目**仍在早期**,README 自述 "the functionality in xxscreeps is incomplete"
- **对本项目的启示**:
  - binary blob + overlay 是降 GC 的高招,但 model-war v0 短局对局不需要这套(参见 hld §1"规则面最小")
  - dual validation + private symbol 是 LLM 脚本安全的硬保证,值得学习
  - "core 引擎刻意做小,几乎一切都是 mod"是值得长期借鉴的方向

## 10. 风险与未决项(对 Screeps 自身的客观记录)

- **沙箱安全性**:vm 不是安全边界;2017 公布的 isolated-vm 替换计划,9 年后仍是"付费可选"。private server 至今默认 vm,只能靠 fork 进程级隔离 + 超时 kill 兜底,玩家可读宿主内存、发起网络请求。
- **Mongo 单点**:官方 MMO 早期单 Mongo shard,2017 公开承认"数据库跑在最强机器 100% 负载"。后续多 shard 改造慢,玩家长期抱怨 tick rate。
- **API 文档一致性**:官方承认部分 intent 互斥表、return code 语义不一致;社区 wiki (wiki.screepspl.us) 比官方文档更详细。
- **"对象跨 tick 失效"是经典坑**:Screeps 玩家社区每年都有新人被 `creep = Game.creeps['harvester1']` 缓存后下 tick 拿到 stale reference 卡死。
- **多进程 fork 重建 vm 上下文代价大**:vm timeout 强制 kill fork,下次 tick 重建所有 context,玩家体验为"代码完全没跑"。
- **本项目若未来开放云端,同样要面对 LLM 试图读对方脚本的问题**(LLM Skirmish §9.2 已记录)。

## 11. 参考链接

- 伞仓库:<https://github.com/screeps/screeps>
- 官方文档:<https://docs.screeps.com>
- 官方架构页:<http://docs.screeps.com/architecture.html>(2017,仍是权威架构介绍)
- 引擎仓库:<https://github.com/screeps/engine>
- driver 仓库:<https://github.com/screeps/driver>
- 路径规划:<https://github.com/screeps/pathfinder>(C++ 原生模块)
- isolated-vm:<https://github.com/laverdet/isolated-vm>(同作者)
- xxscreeps(完全重写版):<https://github.com/screepts/xxscreeps>
- 优化路线博客:<https://blog.screeps.com/2017/06/optimizations/>
- 社区 wiki:<https://wiki.screepspl.us/>
- npm: [`screeps`](https://www.npmjs.com/package/screeps) / [`@screeps/engine`](https://www.npmjs.com/package/@screeps/engine) / [`@screeps/backend`](https://www.npmjs.com/package/@screeps/backend)
- 姊妹产品 Screeps Arena:<https://store.steampowered.com/app/1137320/Screeps_Arena/>
- 类型定义:<https://github.com/screeps-arena-community/types>
- .NET 绑定:<https://github.com/thomasfn/ScreepsDotNet>
- Rust + WASM 绑定:<https://github.com/rustyscreeps/screeps-arena-game-api>

---

> 本文件由 model-war docs 维护。如 Screeps 仓库结构或 engine 模块边界发生重大变化,请同步更新本文,并在本仓库发一条 `needs-triage` issue。
