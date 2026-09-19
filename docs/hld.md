# HLD:model-war v0 概要设计文档

| 项 | 值 |
|---|---|
| 文档版本 | v1.0(2026-09-12) |
| 状态 | 待评审 |
| 上游文档 | [fsr.md](./fsr.md)(定位与可行性)、[srs.md](./srs.md)(需求规格,FR/NFR 编号来源)、[gdd.md](./gdd.md)(规则集设计基准) |
| 覆盖范围 | v0 全部五个工件:`engine`、`runner`、`gen`、`docs/rules-vN`、CLI 回放查看器 |
| 数值标记 | ⚙ 沿用 gdd.md 的可调参数标记;HLD 提案(上游文档未定、本文档首次给出)以 **【HLD 提案】** 标注,定稿后回写上游 |

---

## 1. 引言

### 1.1 目的

本文档是 v0 的概要设计(HLD):给出系统分解、模块职责与接口、关键数据结构、进程/线程模型、确定性保障方案,以及 SRS §5 设计待定项的解决方案。详细设计(函数级)由后续 spec / issue 承接,本文档不展开。

### 1.2 阅读顺序建议

fsr(为什么做)→ srs(做成什么样)→ gdd(规则是什么)→ **本文档(怎么拆、怎么搭)**。

### 1.3 设计支柱(继承自 gdd.md §1,工程含义)

| 支柱 | 工程含义 |
|---|---|
| 确定性可复算 | 一切结算顺序显式定义;引擎禁浮点;任何"方便但不确定"的实现自动否决 |
| 对称公平 | 地图 schema 内置四重旋转对称校验;初始条件由地图+规则数据推导,引擎不硬编码 |
| 规则面最小 | 四兵种固定数值全部进数据文件;引擎逻辑只实现通用机制 |
| 戏剧性优先 | 回放 JSONL 与事件流自第一天按"可渲染、可叙事"设计(gdd.md §8.3) |
| 娱乐优先、排名降级 | 报告双轨:叙事战报(md)+ 可复算原始数据(json),二者同级输出 |

---

## 2. 总体架构

### 2.1 架构总图

```
┌─ 离线:脚本生成管线(gen)──────────────────────────────────────────┐
│                                                                      │
│  docs/rules-vN ──┐                                                   │
│  docs/rules-vN/api.md ─┤→ prompt 组装 → 模型 API(各厂商)           │
│  models.yaml ────┘          │  (脚本 + 模型名)                      │
│                             ↓                                       │
│                    静态校验(tsc 编译 + API 误用 lint)                │
│                      │ 失败:仅回喂校验错误,≤5 轮                    │
│                      ↓ 通过                                          │
│                    冻结存档:archive/<model>/<runId>/{script.ts,     │
│                              meta.json}        (FR-5 / FR-6)        │
└──────────────────────────────────────────────────────────────────────┘
                                    │ 只通过文件交换(NFR-4 AC2)
                                    ↓
┌─ 在线:对战与排名(runner)─────────────────────────────────────────┐
│                                                                      │
│  runner CLI(modelwar run)                                           │
│    ↓ 场次调度:C(4,N) 组合 × M 地图 × K 种子(FR-7)                 │
│    ↓ 每场对局 = 独立子进程(崩溃隔离)                                │
│  ┌─ 单场对局进程(engine)────────────────────────────────┐          │
│  │  对局输入物化:4 × 存档引用 + 地图 + 种子 + ruleset vN  │          │
│  │                                                        │          │
│  │  确定性 tick 循环 ── 快照分发 ──→ 沙箱 worker × 4       │          │
│  │        ↑ 收集 intents(按 playerIndex 归位)│           │          │
│  │  结算管线(移动裁决→同时攻击→对象 tick→胜负)            │          │
│  │        ↓                                               │          │
│  │  JSONL 回放 + result.json(每 tick 状态 + 事件 + hash)  │          │
│  └────────────────────────────────────────────────────────┘          │
│    ↓ 聚合                                                             │
│  排名(名次积分 3/2/1/0)+ 叙事战报 + Markdown/JSON 报告(FR-8)       │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ↓
  独立工具(不依赖引擎运行时):CLI ASCII 回放查看器(FR-9)
                              重放一致性校验器(NFR-1,CI 用)
```

### 2.2 技术选型与工具链

#### 2.2.1 语言与运行时

| 项 | 选择 | 依据 |
|---|---|---|
| 语言 | TypeScript 严格模式(`strict: true`,禁 `any` 隐式逃逸) | FSR §2.3:与脚本语言同构、与 web 远期规划同构 |
| 运行时 | Node.js ≥ 20 LTS(仅 LTS 版本,锁定到 `package.json#engines`) | worker_threads 成熟;引擎零运行时依赖 |
| 模块体系 | ESM(`"type": "module"`) | Node 20 原生支持;避免 CJS/ESM 双轨 |

#### 2.2.2 工程结构与构建

| 项 | 选择 | 依据 |
|---|---|---|
| Monorepo | pnpm workspace(锁定 lockfile,CI 用 `--frozen-lockfile`) | 多包单仓,包间边界清晰(§3.2) |
| 包间类型引用 | TypeScript project references(`tsc -b`) | 增量编译;编译期强制依赖方向,防止 engine 误 import runner |
| 构建 | 纯 `tsc` 产物(engine);CLI 可选 `tsup` 打包 | engine 是库 + 子进程入口,无需打包器 |
| 脚本预编译 | 冻结脚本以 `tsc` 单独编译为 JS 后注入沙箱 | 沙箱内不走模块加载,隔离面最小(§5.1) |
| CLI 入口 | 统一 `modelwar` bin,`commander` 解析子命令 | §9 的六个子命令;依赖仅落 CLI 层 |

#### 2.2.3 代码质量:oxc 统一工具链

格式化与静态检查统一采用 [oxc](https://oxc.rs/)(Rust 实现的 JS/TS 工具链),不引入 ESLint/Prettier:

| 项 | 工具 | 说明 |
|---|---|---|
| 格式化 | **oxfmt**(Prettier 兼容,内置 import 排序) | 全仓库统一配置,`oxfmt --check` 进 CI;约 30× 于 Prettier,提交门禁无感 |
| Lint | **oxlint**(ESLint 生态兼容,800+ 内置规则,类型感知) | 替代 ESLint 成为主 linter;覆盖 typescript-eslint 常用规则集 |
| 确定性 Lint | 自定义规则 `no-float-literal`:engine 包内禁浮点字面量、禁白名单外的 `Math` 浮点函数 | FR-2 AC3 / NFR-1 的机械化保障;以 oxlint JS 插件(alpha)实现,若插件通道不稳则退化为基于 oxc-parser 的自建校验脚本(tools 包),CI 强制 |
| 沙箱 API 白名单 | oxlint `no-restricted-globals` / `no-restricted-imports` | gen 静态校验参赛脚本时启用(§6.2) |
| 提交门禁(可选) | Husky + lint-staged:暂存区 oxfmt + oxlint + typecheck | 本仓库已有 setup-pre-commit 技能,按需启用;不作为 v0 验收项 |

#### 2.2.4 测试

| 项 | 选择 | 覆盖内容 |
|---|---|---|
| 测试框架 | Vitest(单进程内跑,worker 测试用真实 worker_threads) | 引擎结算单元测试、快照冻结测试(FR-3 AC1)、沙箱异常/超限裁决测试(FR-4) |
| 确定性快照测试 | Vitest snapshot:固定种子 + 固定脚本 → 逐 tick stateHash 断言 | FR-2 AC1(重跑 10 次全一致) |
| 重放一致性 | `modelwar verify` 集成测试:抽样正式对局 JSONL 重算比对 | NFR-1 AC,CI 中执行 |
| 地图校验测试 | map-lint 对 `maps/` 全量断言四重对称 | FR-1 AC2 |
| 规则文档验收 | 人类手写 ≥2 个基准脚本,仅凭 `docs/rules-v1` 编写 | FR-10 AC1 / SRS 验收口径 2(人工流程,测试仅保证可运行) |
| 变异测试 | StrykerJS(`@stryker-mutator/core` + Vitest runner) | 度量测试有效性,见下 |

**变异测试定位**:变异测试的耗时与测试套件规模成正比,且属于"事后体检"而非"合并前门禁"——因此**不进主流水线**,仅夜间定时(cron)或手动触发(`pnpm run mutation`)。范围优先覆盖 engine 结算管线(resolver/world 的结算顺序、边界条件)——这是确定性正确性的核心区,变异得分是"确定性测试没有退化成摆设断言"的量化证据(NFR-1 的佐证指标)。得分显著下降以 issue 跟进,不直接堵合并。

#### 2.2.5 数据与 schema

| 项 | 选择 | 依据 |
|---|---|---|
| 数据格式校验 | JSON Schema(schema 包内定义,运行时用 `ajv` 或轻量手写校验器) | ruleset / 地图 / 存档 meta / result 的读入端强制校验;版本错配在装载期报错(FR-10 AC2) |
| hash | `node:crypto` SHA-256(标准库) | stateHash、地图 hash、存档完整性,零第三方依赖 |
| 随机数 | 自实现整数 LCG(种子驱动) | 不用任何带浮点的 RNG;供地图变体(§7.3)与未来规则使用 |

#### 2.2.6 gen 管线专属依赖(唯一允许联网的包)

| 项 | 选择 | 依据 |
|---|---|---|
| 模型 API 客户端 | OpenAI-compatible HTTP 客户端 + 各厂商 SDK 适配层 | 新模型接入只改配置(FR-5 AC3);凭证一律走环境变量,不落仓库 |
| 重试与限流 | 指数退避 + 每模型并发 1 | 生成阶段无性能压力,简单可靠 |
| 生成日志 | 结构化 JSON 落盘(进存档 meta) | FR-6 AC1 元数据完整性 |

#### 2.2.7 CI 与质量门禁

CI(GitHub Actions 或等价物)分两条流水线。

**主流水线**(每次 PR 与主干 push,快速循环,全部通过才可合并):

| 阶段 | 内容 | 对应需求 |
|---|---|---|
| 1. 静态 | typecheck(`tsc -b`)、oxlint(含 `no-float-literal`)、oxfmt --check、dependency-cruiser 依赖规则校验(§2.2.10) | FR-2 AC3、NFR-4 AC2 |
| 2. 单测 | Vitest 全量(结算、快照、沙箱裁决、地图校验) | FR-1/3/4 |
| 3. 集成 | 样例对局端到端跑通 + `modelwar verify` 重放一致性 + 重跑 10 次 hash 断言 | FR-2、NFR-1 |
| 4. 基准 | 双人类基准脚本对打一场,断言正常终局(不判策略胜负) | SRS 验收口径 2 的回归防线 |

**夜间流水线**(定时 cron 或手动触发,不阻塞 PR):

| 内容 | 说明 |
|---|---|
| StrykerJS 变异测试(engine 优先) | 变异得分报告落盘(`runs/mutation/` 或 artifacts);得分下降开 issue 跟进(§2.2.4) |
| 全量重放一致性扫描 | 对 `runs/` 存量对局批量 `modelwar verify`,守护"历史结果水远可复算"(NFR-2) |

CI 环境无网络、无模型 API、无凭证——保证 CI 上跑的永远是无头引擎与固定脚本,与生产对局同构。

#### 2.2.8 依赖策略(总原则)

| 包 | 运行时第三方依赖 | 理由 |
|---|---|---|
| engine | **零依赖**(仅 `node:` 标准库) | 确定性审计面最小;供应链变更不可能破坏复现 |
| runner / tools | 受控少量(`commander`、schema 校验器) | 只做调度与读文件,不参与结算 |
| gen | 允许(HTTP 客户端、SDK) | 唯一联网包,永不进对局进程(NFR-4 AC2) |
| devDependencies | 全仓库共享(oxlint、oxfmt、Vitest、StrykerJS、dependency-cruiser、tsc) | 不进入任何运行时 |

#### 2.2.9 观测与调试

| 项 | 选择 | 依据 |
|---|---|---|
| 引擎日志 | 对局级结构化 JSON 落盘(`runs/<runId>/logs/`),默认静默 | 排障可追溯;不打断 JSONL 回放的纯数据性 |
| 对局内时间旅行调试 | **不建专用工具**:`modelwar match` 单场重跑 + JSONL diff 即等价物 | 确定性引擎下"调试 = 重放",避免工具面膨胀 |
| 叙事战报 | runner 内置生成器,只消费回放 events 流(§7.5) | gdd §8.3 |

#### 2.2.10 依赖治理(dependency-cruiser)

| 能力 | 用法 |
|---|---|
| 可视化 | `depcruise --output-type dot` 生成模块依赖图,产物入 `docs/diagrams/`,随架构评审更新 | 
| 规则强制 | `.dependency-cruiser.cjs` 将 §3.2 依赖规则写成可执行断言(engine 不得 import runner/gen;gen 不得 import engine/runner;全局禁循环依赖),违规非零退出,挂在 CI 静态阶段 | 
| 价值 | §3.2 的包边界——特别是"gen 永不进对局进程"(NFR-4 AC2)——从口头约定变为机器门禁;架构漂移在 PR 期即被拦下 |

> 依赖规则与 TS project references 双保险:前者管运行时 import,后者管编译期类型引用。

### 2.3 进程与线程模型(核心决策)

| 层 | 单位 | 生命周期 | 隔离目的 |
|---|---|---|---|
| runner | 主进程 | 整轮 benchmark | 调度、聚合;不执行任何参赛代码 |
| engine | **每场对局一个子进程** | 单场对局 | 单场崩溃不污染其余场次(FR-7 AC2);内存上限可在进程级施加 |
| sandbox | 对局进程内,每方一个 worker_threads | 与对局同生命周期 | 脚本无网络/FS/宿主访问(FR-4 AC1);一方崩溃不影响他方(AC3) |

通信协议:主线程每 tick 构建 4 份冻结快照,分发至各 worker;worker 执行 `loop()` 并回传 intent 数组。**收集按 playerIndex 归位,不依赖到达顺序**——worker 的异步完成顺序不影响结算结果(确定性要求见 §4.6)。

---

## 3. 系统分解

### 3.1 包结构与职责矩阵

```
model-war/
├─ packages/
│  ├─ engine/            # 确定性引擎 + 沙箱(对局进程的全部逻辑)
│  ├─ runner/            # 循环赛调度、并发执行、排名聚合、报告输出
│  ├─ gen/               # 脚本生成管线(离线,永不进对局进程)
│  └─ schema/            # 纯类型与 JSON Schema:state/intent/地图/存档/结果
├─ rulesets/             # 规则数值数据文件(NFR-4 AC1:改数值不改代码)
│  └─ v1.json
├─ maps/                 # 地图 JSON(3 张 ⚙,四重旋转对称)
├─ docs/rules-v1/        # 面向模型的规则文档 + API 文档(FR-10)
├─ archive/              # 冻结脚本存档(FR-6)
├─ runs/<runId>/         # 对局产物:回放 JSONL、result、报告、叙事战报
└─ cli entrances 统一为 `modelwar` 命令(见 §9)
```

| 模块 | 职责 | 对应需求 |
|---|---|---|
| engine:tick-loop | tick 驱动、结算管线编排 | FR-1 |
| engine:resolver | intent 校验、移动碰撞裁决、攻击批处理结算 | FR-1、FR-3 AC3 |
| engine:world | 状态模型、对象系统、占领/采集/生产机制 | FR-1 |
| engine:snapshot | 只读快照构建与冻结 | FR-3 AC1 |
| engine:sandbox | worker 宿主、注入 API、预算与异常裁决 | FR-4 |
| engine:replay-writer | JSONL 状态流输出(可渲染、可叙事) | FR-2 AC2、gdd §8.3 |
| engine:ruleset-loader | 数值配置装载与版本比对 | NFR-4 AC1、FR-10 AC2 |
| runner:scheduler | 组合×地图×种子场次枚举与并发调度 | FR-7 |
| runner:ranker | 名次积分、并列处理、胜率矩阵、可选 Elo | FR-8 |
| runner:reporter | Markdown 报告 + JSON 原始数据 + 叙事战报 | FR-8 AC2、gdd §8.3 |
| gen:pipeline | prompt 组装 → 模型 API → 校验迭代 → 冻结 | FR-5 |
| gen:validator | 编译 + API 误用静态检查 | FR-5 |
| gen:archiver | 元数据强制存档 | FR-6 |
| tools:replay-view | 终端 ASCII 查看器(只读 JSONL) | FR-9 |
| tools:replay-verify | 重放一致性断言(重新执行 vs JSONL) | NFR-1 |
| tools:map-lint | 地图四重旋转对称校验 | FR-1 AC2、gdd §11-3 |

### 3.2 依赖规则

```
schema ← engine ← runner(以子进程方式启动 engine)
schema ← gen
schema ← tools
```

- `schema` 包**只含类型与 JSON Schema,无运行时代码**——三包共享数据格式定义不违反 NFR-4 AC2(该条款约束的是运行时进程隔离:gen 永不在对局进程内)。
- `engine` 不 import `runner`/`gen`;`runner` 只通过 CLI 接口 + 文件消费 `engine`。
- 上述依赖方向由 dependency-cruiser 规则强制执行(§2.2.10),违规直接导致 CI 失败,不依赖人工审查。

---

## 4. engine 概要设计

### 4.1 状态模型(核心数据结构)

```ts
// 全整数;无浮点字段(FR-2 AC3)
interface GameState {
  tick: number;                 // 唯一时间单位
  players: Player[4];           // index 0..3,固定
  units: Unit[];                // 按 id 升序维护
  sites: Site[];                // 按 id 升序维护(基地 + 资源点)
  productions: Production[];    // 各基地独立队列,单条
  nextId: number;               // 全局单调递增,对象创建时分配
  outcome: Outcome | null;      // 终局:排名 + 原因
}

interface Player {
  index: 0|1|2|3;
  resources: number;            // 全局共享池,无上限(gdd §5)
  alive: boolean;
  exceptionTicks: number;       // 累计异常 tick 数,达 100 ⚙ 判负(gdd §3.4)
}

interface Unit {
  id: number;
  owner: 0|1|2|3;
  type: 'worker' | 'melee' | 'ranged' | 'cavalry';
  x: number; y: number;         // 网格坐标,Chebyshev 八向
  hp: number;
  carrying: number;             // 农民携带量,≤ 50 ⚙
}

interface Site {
  id: number;
  kind: 'base' | 'resource';
  x: number; y: number;         // 点位为单格(gdd §3.2 堵点战术)
  owner: -1 | 0|1|2|3;          // -1 = 中立
  progressOwner: -1 | 0|1|2|3;  // 占领进度归属
  progress: number;             // 0..30 ⚙
  remaining: number;            // 资源点储量,5000 ⚙;基地无此字段
}

interface Production { baseId: number; type: UnitType; ticksLeft: number }
```

设计要点:

- **id 全局单调递增**(含被销毁对象),所有"按对象处理"的阶段一律按 **id 升序** 迭代,这是 gdd §3.3"字典序"的可执行化——数值 id 升序与字符串字典序等价定序,二者取其一并在 rules-vN 中显式声明(取**数值升序**)。
- 数值(HP、造价、速度、占领阈值等)**不出现**在以上结构中,统一来自 `rulesets/v1.json`,由 ruleset-loader 装载。

### 4.2 intent 模型(脚本 → 引擎的唯一通道)

```ts
type Intent =
  | { kind: 'move';     unitId: number; dx: -1|0|1; dy: -1|0|1 }
  | { kind: 'moveTo';   unitId: number; x: number; y: number }        // 引擎端逐 tick 寻路
  | { kind: 'attack';   unitId: number; targetId: number }
  | { kind: 'harvest';  unitId: number; siteId: number }
  | { kind: 'transfer'; unitId: number }                               // 交付至相邻己方基地
  | { kind: 'spawn';    baseId: number; unitType: UnitType };          // 下单即扣款
```

- 一个单位每 tick 至多一个单位级 intent;`spawn` 为玩家级 intent。重复提交同单位 intent:**【HLD 提案】取该单位最后一个,前面的静默丢弃**(不视为异常,不占用异常配额)。
- intent 提交后由 resolver 统一校验(属主正确、参数在界、目标存在且合法),**无效 intent 丢弃并写入当 tick 事件流**(调试可观测),不触发异常判罚——异常判罚仅针对脚本抛出异常与超预算(gdd §3.4)。

### 4.3 tick 结算管线(每 tick 严格按此顺序)

```
0. dispatch   构建四方只读快照 → 分发 worker → 收集 intents(预算/超时裁决在此层)
1. validate   intent 逐条校验(按 playerIndex 0..3,再按提交顺序;无效者丢弃)
2. movement   移动结算:
                a) 全部合法 move/moveTo 目标格计算
                b) 冲突裁决:目标格被多方竞争时,按 (tick + playerIndex) mod 4
                   轮转优先(gdd §3.3);平局不存在(轮转序为全序)
                c) 单格单单位;移动成功的单位占据目标格
3. combat     同 tick 所有 attack 同时结算:
                a) 先计算全部伤害(攻击者本 tick 死亡不影响其攻击生效,gdd §6.2)
                b) 统一扣血,归零者死亡移除(不参与后续阶段)
4. objectTick 按对象 id 升序:
                a) 占领:站位驱动 progress 累积 / 侵蚀 / 无人衰减(gdd §3.2)
                b) 采集:农民在己方资源点相邻格 harvest,+2 ⚙/tick,满 50 停
                c) 交付:transfer,carrying 清零入玩家池
                d) 生产:各队列 ticksLeft--,归零出兵(基地格被占则**【HLD 提案】**
                   挂起等待,出兵时刻延后,扣款不退)
5. evaluate   胜负判定:
                a) 全点位(16)归属单一玩家 → 胜
                b) 三方淘汰且一方尚存 → 捷径条款即胜
                c) 淘汰:无单位且无基地 → 出局,点位回归中立(gdd §3.1)
                d) 淘汰方脚本停止 dispatch(其 worker 空转跳过)
6. emit       写 JSONL 一行(完整可渲染状态 + 事件 + stateHash);tick++
7. loop guard tick ≥ 1500 ⚙ → 超时,按领土分定名次,同分并列(gdd §3.1)
```

**顺序即规范**:以上顺序写入 `docs/rules-v1`(确定性约束的显式说明,FR-10 AC3)。任何顺序调整都是规则变更,需升 ruleset 版本。

### 4.4 移动碰撞裁决细则

- **【HLD 提案】** 冲突分两类,分别处理:
  1. **同格竞争**(多方单位目标格相同):按轮转优先级 `(tick + playerIndex) mod 4` 取胜者,其余单位**原地不动**(不尝试次优目标,规则面最小)。
  2. **交换/穿行**(A→B 格同时 B→A 格):视为双方目标格被占,均移动失败(避免环形追逐的不确定链式裁决)。
- `moveTo` 每 tick 由引擎执行一步 A*(见 §4.7),等价于"本 tick 的 move",参与同一套冲突裁决;路径不跨 tick 缓存,每 tick 重算(简单、确定)。
- 骑兵速度 2:**【HLD 提案】** 每 tick 结算两次单步移动,第二次单步同样参与冲突裁决(即本 tick 的移动阶段执行两轮,轮转优先中的 `tick` 值不变)。

### 4.5 快照与脚本 API 面

- 快照 = GameState 的**深拷贝 + `Object.freeze` 递归冻结**,单位/点位数组按 id 排序;脚本持有的引用在下 tick 全部作废(每 tick 新快照)。
- 脚本可用的全局仅两类:
  1. **只读 state**(当 tick 快照,经冻结包装);
  2. **action 函数**(`move/moveTo/attack/harvest/transfer/spawnUnit` + 查询 `getObjectsByType/getObjectById/getTick/getRange/findPath/getTerrainAt`,签名基准见 gdd §7,定稿于 rules-vN)。
- 运行时校验(FR-3 AC3):查询函数在快照副本上操作;action 函数只做"收集 + 界检查",不触碰引擎真实状态;intent 合法性在 resolver 统一裁决(§4.2)。

### 4.6 确定性保障(对应 NFR-1,一票否决项)

| 层 | 措施 |
|---|---|
| 运算 | 引擎代码禁浮点(oxlint 自定义规则 `no-float-literal` 禁 `number` 字面量小数点/`Math` 浮点函数白名单外使用,见 §2.2.3);资源、伤害、进度、领土分全整数;领土分公式 `⌊Σ造价/2⌋` 本身为整数运算 |
| 迭代顺序 | 一切多对象处理按 id 升序;玩家处理按 index 0..3;不存在 Set/Map 迭代参与结算 |
| 异步隔离 | worker 完成顺序不定 → intents 按 playerIndex 归位后才进入管线;管线内无任何异步 |
| 移动裁决 | 轮转优先 `(tick + playerIndex) mod 4` 是全序,无平局 |
| 路径搜索 | A* 邻居展开顺序固定(八向按固定方向表),tie-break 按 id;无浮点启发式(用整数化的 Chebyshev ×2) |
| 预算裁决 | 见 §5.3:采用可复现的指令计数为主判据 |
| 验证 | CI 重放一致性:抽样正式对局 → 重新执行 → 与 JSONL 逐 tick stateHash 比对(NFR-1 AC) |
| 地图 | 地图 JSON 带内容 hash,回放头部记录;对称性由 map-lint 工具校验(§7.4) |

**stateHash**:对每 tick emit 的规范化状态(排序后的对象数组序列化)计算 SHA-256,写入 JSONL。哈希计算本身在回放写出路径上,不参与结算。

### 4.7 寻路(A*)

- `findPath` 暴露给脚本;`moveTo` 内部复用同一实现——**同一实现保证脚本查询结果与引擎实际移动一致**。
- CostMatrix 参数化(v1 固定:墙不可通行,其余等价);启发式用整数 Chebyshev(×2 与步长同量纲避免浮点)。
- 寻路调用量计入脚本指令预算(§5.3),防止脚本用寻路做算力攻击。

---

## 5. sandbox 概要设计

### 5.1 隔离结构

```
对局子进程(engine)
├─ 主线程:GameState、结算管线、JSONL writer
├─ worker #0 ── 脚本 A(冻结 script.ts 编译产物)
├─ worker #1 ── 脚本 B
├─ worker #2 ── 脚本 C
└─ worker #3 ── 脚本 D
```

- worker 初始化时移除宿主全局(`require`/`process`/`fetch`/`fs` 等全部不可见,仅注入 §4.5 的 API 面与语言内置 `Math`/`JSON` 等纯函数子集)。
- 冻结脚本以 `tsc` 预编译为 JS 后加载(worker 内 `vm`/模块加载均不走网络与 FS,脚本代码由主线程经消息传入或从受控构建产物读取)。
- 模块级变量天然跨 tick 保留(worker 常驻,FR-3 记忆能力)。

### 5.2 异常裁决(gdd §3.4 的实现化)

| 情形 | 处理 | 确定性 |
|---|---|---|
| `loop()` 抛异常 | 本 tick 该方 intents 置空(单位原地待命);`exceptionTicks++`;达 100 ⚙ → 判负出局(按淘汰规则,点位回归中立) | ✅ 计数可复现 |
| worker 崩溃/无法响应 | 视同每 tick 异常,持续累计至出局阈值;其余三方与引擎不受影响(FR-4 AC3) | ✅ |
| 内存超限 | 进程级内存上限触发 → 该方判负出局,其余三方继续(通过重启对局进程内三方可执行子集?否——**【HLD 提案】** 内存超限判负由 runner 以"该场作废、标记特殊败"处理,见 §8.4) | ⚠ 记录在案 |

### 5.3 计算预算(SRS §5 待定项 ③ 的 **【HLD 提案】**)

**形态:指令计数为主判据 + 墙钟硬超时为兜底保护,二者职责分离。**

| 机制 | 数值 ⚙ | 判罚 | 是否影响确定性 |
|---|---|---|---|
| 指令计数:action/查询 API 调用次数,每方每 tick 计数 | 上限 10000 次/tick(待基准脚本标定) | 超限 → 本 tick 该方 intents 丢弃 + `exceptionTicks++`(与异常同轨) | ✅ 可复现(纯计数) |
| 墙钟软限:单 tick `loop()` 执行时长 | 100 ms/tick(待标定) | 同上,计入 exceptionTicks | ⚠ 有噪声——**【HLD 提案】** 软限仅作为指令计数的冗余保险,正常情况下先触发指令上限;软限触发需在对局记录中标记,供报告披露 |
| 墙钟硬超时:防死循环 | 10 s/tick | 强杀 worker → 视同 worker 崩溃(§5.2) | 该方出局裁决可复现(超时必然发展为崩溃出局) |

设计理由:FR-4 AC2 要求预算裁决可复现——纯计数完全满足;墙钟因机器负载有噪声,故只做兜底且不单独决定胜负,其触发本身就是脚本失控的信号,发展为出局的时间线是确定的。

---

## 6. 脚本契约与静态校验

### 6.1 契约载体

`docs/rules-v1/` 两份文档:`rules.md`(规则)与 `api.md`(API 签名与语义),自包含(FR-10 AC1:人类仅凭文档可写出过审脚本)。二者同时是 gen 管线的 prompt 输入与 validator 的规则来源(单一事实源)。

### 6.2 静态校验规则(gen:validator)

| 类别 | 规则 |
|---|---|
| 编译 | `tsc --noEmit` 通过;导出 `loop(): void` 入口 |
| 全局白名单 | oxlint `no-restricted-globals`:除注入 API 与纯函数子集(`Math`(去 `random`)、`JSON`、`Number`、`String`、`Array`、`Map`/`Set` 等)外全禁 |
| 模块系统 | 禁 `import`/`require`/动态 `eval`(单文件自包含) |
| 确定性污染源 | 禁 `Date`、`Math.random`、其他一切非确定源 |
| API 误用 | 类型层面由 `schema` 包的公开 `.d.ts` 约束(结构化意图类型) |

校验失败 → 仅错误信息回喂模型(≤5 轮,FR-5 AC1);代码审查条款确保不存在对战结果回传路径。

---

## 7. 数据设计

### 7.1 ruleset 数据文件(`rulesets/v1.json`)

承载 gdd 全部 ⚙ 数值:兵种表(造价/HP/伤害/射程/速度/生产耗时)、经济参数(采集率/携带上限/初始资金)、占领参数(阈值/侵蚀率/衰减率)、tick 上限、异常判负阈值、预算参数。引擎读它,`docs/rules-v1` 由人工与之同步,**版本号必须一致**(runner 启动时比对,错配拒跑,FR-10 AC2)。

### 7.2 地图 JSON(`maps/*.json`)

```jsonc
{
  "name": "open-clash",
  "size": 50,                       // ⚙
  "rulesetMin": "v1",
  "terrain": ["...", ...],          // 50 行字符串,'.'=平原,'#'=墙(具体编码详细设计定)
  "sites": [ { "id": 1, "kind": "base", "x": 10, "y": 10, "initialOwner": 0 }, ... ],
  "spawnUnits": [ { "owner": 0, "type": "worker", "offset": [0,0] }, ... ],
  "initialResources": 300,          // ⚙
  "variantSlots": [ ... ]           // 【HLD 提案】见 §7.3
}
```

- 初始单位配置(3 农民 + 2 近战,围绕主基地)由地图声明,引擎不硬编码。
- **map-lint 工具**强制校验:四重旋转对称(terrain 与 sites 绕中心 90° 旋转自洽)、所有点位不重叠且不在墙上、地图数 ≥3 ⚙ 且风格覆盖(开阔/廊道/要塞)。校验不过的地图不进地图池。

### 7.3 种子的用途(**【HLD 提案】**,填补上游空白)

上游文档定义了"K 种子"场次维度,但 v0 规则集本身无随机过程(地图固定、初始固定)——种子若不落地,多种子场次将完全重复。**提案:种子驱动对称地图变体**——地图 JSON 的 `variantSlots` 声明可变墙体槽位(成组四重对称),引擎以种子做确定性填充(整数 LCG)。效果:同一地图模板在不同种子下产生微扰变体,保持四重对称与点位布局不变。此提案需在规则定稿时回写 gdd §11 开放项 3。

### 7.4 冻结脚本存档(`archive/<modelSlug>/<runId>/`)

```
script.ts      # 冻结源码,一字不改
meta.json      # 模型名、模型版本/快照标识、生成日期、协议迭代轮数、
               # 完整 prompt(逐轮)、生成日志、ruleset 版本、校验结果
```

- runner 启动即校验元数据完整性,缺档**报错退出**(FR-6 AC2,不跳过)。
- 对局输入物化:`runs/<runId>/matches/<combo>-<map>-<seed>/` 内含 `input.json`(4 × 存档路径 + 地图 + 种子 + ruleset 版本 + 各文件 hash)与产物——任意一场可凭 input.json 复算(FR-7 AC3、NFR-2)。

### 7.5 回放 JSONL(`matches/<...>/replay.jsonl`)

```
第 1 行   {"type":"meta", ruleset, mapHash, seed, players:[{model, archiveRef}], ...}
第 n 行   {"type":"tick", "tick":n, players, units, sites, productions,
           events:[...], "stateHash":"..."}
末 行    {"type":"result", rankings, reason, territoryScores}
```

- 每 tick 记录足以绘制完整画面的状态:点位归属、占领进度条、单位位置血量携带、玩家资源(gdd §8.3 可渲染要求)。
- **events 事件流**(叙事与战报的统一来源):`first-contact`、`site-captured`、`unit-destroyed`(聚合)、`player-eliminated`、`economy-dead`(农民全灭且存款不足)⚠、`budget-exceeded`、`exception`、`victory`。叙事战报生成器只消费 events,不重新解析状态。

---

## 8. runner 与排名概要设计

### 8.1 场次调度

- 输入:`season.yaml`(参赛脚本存档目录列表、地图池、种子数 K ⚙=5、并发度、ruleset 版本)。
- 枚举:全部 4 人组合 × M 地图 × K 种子,种子值 = 确定性函数(组合、地图、序号)——**全场次对全体参赛者一致,无人可选**(FR-7 AC1)。
- 并发:worker-pool 语义的对局子进程池,并发度默认 `min(cpus, 8)` ⚙;单场互不干扰。

### 8.2 排名(名次积分制)

- 每场对局产出 1-4 名:胜利/捷径即胜为第 1;其余按**出局顺序倒序 + 超时领土分**定名次;同分并列(gdd §3.1、§8.2)。
- 记分:第 1/2/3/4 名 = 3/2/1/0 分;**并列名次【HLD 提案】按并列者均分名次分**(如并列第 2:两人各得 (2+1)/2 = 1.5 分)——这是 gdd §11 开放项 5 的提案,定稿后回写。
- 赛季总分 = Σ 场分;场均分排名;胜率矩阵、Elo 为可选副产品输出,不进主报告标题(FR-8 AC1)。

### 8.3 报告输出(`runs/<runId>/`)

| 产物 | 内容 | 消费者 |
|---|---|---|
| `report.md` | 排名、场均分、代表性对局叙事、失败名单(校验不过的模型)、规则版本标注 | 人类 / 自媒体素材 |
| `report.json` | 每场对局的输入引用 + 名次 + 分数 | 机器复算(NFR-2 AC) |
| `narrative/<场次>.md` | 从 events 生成的叙事化战报(时间线:首触、易手、淘汰、经济死亡、终局) | 自媒体文案 |

### 8.4 对局异常的调度层处理

单场对局进程崩溃(engine bug,非脚本方问题)→ 该场标记 `engine-crash` 并重跑一次;再崩则记入报告的问题清单,**不静默丢弃**(FR-7 AC2)。内存超限判负(§5.2)在报告中披露触发情况。

---

## 9. CLI 设计(统一入口 `modelwar`)

| 命令 | 模块 | 说明 |
|---|---|---|
| `modelwar gen --config models.yaml` | gen | 生成并冻结脚本(逐模型,可单跑 `--model <slug>`) |
| `modelwar run --config season.yaml` | runner | 整轮循环赛 + 报告 |
| `modelwar match <input.json>` | engine | 单场对局(调试用,可脱离 runner 独立执行) |
| `modelwar replay <replay.jsonl>` | tools:replay-view | 终端 ASCII 回放,单步/暂停(FR-9) |
| `modelwar verify <replay.jsonl>` | tools:replay-verify | 按 input.json 重新执行,逐 tick hash 比对(NFR-1,CI 调用) |
| `modelwar map-lint <maps/>` | tools:map-lint | 地图对称性与合法性校验 |

---

## 10. 非功能设计落地

### 10.1 性能(NFR-3:75 场 / 1 小时)

预算分解:75 场 × 1500 tick ≈ 11 万 tick。单 tick 成本 = 4 快照深拷贝 + 4 worker 消息往返 + 结算(≤ 数百对象)。优化优先级:**先测沙箱开销**(FSR 风险预案:快照改结构化共享/按需拷贝)→ 再调对局进程并发度。任何优化不得改变结算结果(stateHash 回归测试守护)。

### 10.2 可维护性(NFR-4)

- 数值与逻辑分离:ruleset JSON + 地图 JSON(§7.1、§7.2),改数值零代码改动。
- 包间仅文件交换(§3.2);gen 与 engine 无任何运行时耦合,架构审查以 import 图为准。

### 10.3 可信性(NFR-2)

复算链:`report.json` → `input.json`(存档引用 + 地图 + 种子)→ `modelwar match` 重跑 → 比对结果。全程不需要模型 API 与网络。

---

## 11. 需求追溯矩阵

| 需求 | 设计承接 |
|---|---|
| FR-1 引擎 | §4(全节),AC2 → §7.2 map-lint |
| FR-2 确定性与回放 | §4.6、§7.5、§9 verify |
| FR-3 脚本接口 | §4.2、§4.5、§6.1 |
| FR-4 沙箱与预算 | §5(全节) |
| FR-5 生成管线 | §2.1 离线侧、§6.2 |
| FR-6 可追溯存档 | §7.4 |
| FR-7 循环赛 runner | §8.1、§8.4 |
| FR-8 排名与报告 | §8.2、§8.3 |
| FR-9 CLI 回放查看器 | §9 |
| FR-10 规则文档 | §6.1、§7.1(版本一致性) |
| NFR-1 确定性 | §4.6(最高优先级,一票否决) |
| NFR-2 可信性 | §10.3 |
| NFR-3 性能 | §10.1 |
| NFR-4 可维护性 | §3.2、§10.2 |

SRS §5 待定项覆盖情况:计算预算形态 → §5.3(提案);异常/超时判负细则 → §5.2(阈值 ⚙ 待标定);规则集数值 → rulesets/v1.json(基准脚本验证);并列积分 → §8.2(提案);平局处理 → 已定稿(领土分 + 并列)。

---

## 12. 设计决策与开放项

### 12.1 本文档新增决策(评审后回写上游)

| # | 决策 | 状态 |
|---|---|---|
| H1 | 预算形态 = 指令计数为主 + 墙钟兜底,超限走 exceptionTicks 同轨(§5.3) | 待评审,回写 srs §5 / gdd §11-1 |
| H2 | 种子 = 对称地图变体生成(§7.3) | 待评审,回写 gdd §11-3 |
| H3 | 并列名次均分名次分(§8.2) | 待评审,回写 gdd §11-5 |
| H4 | 每 tick 一条 JSONL 行 + 事件流作为叙事唯一来源(§7.5) | 设计定稿 |
| H5 | 每场对局独立子进程 + 进程池(§2.3) | 设计定稿 |

### 12.2 留给详细设计 / v0 验证的开放项

| # | 项 | 备注 |
|---|---|---|
| 1 | 预算具体数值(指令上限、软/硬时限) | 用人类基准脚本标定(SRS 验收口径 2) |
| 2 | 地图 3 张具体坐标与 variantSlots 设计 | map-lint 校验 + 策略多样性测试(FSR R2/R3) |
| 3 | ruleset v1 全部 ⚙ 数值终值 | gdd §11-4 |
| 4 | 生产出兵遇基地格被占的挂起细则 | §4.3-4d 提案,详细设计时定稿 |
| 5 | 快照深拷贝的性能优化形态 | §10.1,先测后优化 |

---

## 13. 里程碑映射(FSR §6)

| 里程碑 | 本文档承接章节 |
|---|---|
| M1 规则 v1 | §6.1、§7.1、§7.2、§7.3(map-lint 先行) |
| M2 引擎 | §4、§5(核心工作量) |
| M3 生成管线 | §6.2、§7.4 |
| M4 runner | §8、§9、§10.3 |
