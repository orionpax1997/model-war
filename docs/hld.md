# HLD:model-war v0 概要设计文档

| 项 | 值 |
|---|---|
| 版本 | v2.1 |
| 状态 | 待评审 |
| 上游文档 | [fsr.md](./fsr.md)(定位与风险)、[srs.md](./srs.md)(需求,FR/NFR 编号来源)、[gdd.md](./gdd.md)(规则机制与设计约束) |
| 覆盖范围 | srs §1.1 的五个 v0 交付物 |
| 本文件拥有 | 架构与包拓扑、进程模型、确定性手段、沙箱与预算机制、数据结构、数据格式、CLI、CI 与工具链、工程侧开放项 |
| 本文件不写 | 规则机制与参数含义(→ gdd)、参数取值(→ `rulesets/*.json`)、需求定义(→ srs)、可行性论证(→ fsr) |

本文档是概要设计(HLD):系统分解、模块职责与接口、关键数据结构、进程模型、确定性保障方案。函数级详细设计由后续 spec / issue 承接。

## 1. 设计支柱(工程含义)

| 支柱 | 工程含义 |
|---|---|
| 确定性可复算 | 一切结算顺序显式定义;引擎禁浮点;任何"方便但不确定"的实现自动否决 |
| 对称公平 | 地图 schema 内置四重旋转对称校验;初始条件由地图 + ruleset 推导,引擎不硬编码;座位在赛季内轮换(§8.1) |
| 规则面最小 | 全部规则数值进 `rulesets/*.json`;引擎只实现 gdd 定义的通用机制 |
| 戏剧性优先 | 回放 JSONL 与事件流自第一天按"可渲染、可叙事"设计 |
| 排名降级 | 报告双轨:叙事战报(md)+ 可复算原始数据(json),二者同级输出 |

## 2. 总体架构

### 2.1 架构总图

```
┌─ 离线:脚本生成管线(gen)─────────────────────────────────────────┐
│  docs/rules-vN + docs/rules-vN/api.md + models.yaml + prompts/    │
│        ↓ prompt 组装 → 模型 API(各厂商)→ 脚本 + 模型名           │
│  静态校验(tsc 编译 + API 误用 lint)                              │
│        │ 失败:仅回喂校验错误,≤5 轮                               │
│        ↓ 通过                                                     │
│  冻结存档:archive/<model>/<runId>/{script.ts, script.js, meta.json}│
└───────────────────────────────────────────────────────────────────┘
                          │ 只通过文件交换(srs NFR-4 AC2)
                          ↓
┌─ 在线:对战与排名(runner)────────────────────────────────────────┐
│  modelwar run --config season.yaml                                │
│    ↓ 场次调度:C(4,N) 组合 × M 地图 × K 种子 + 座位轮换(srs FR-7)│
│    ↓ 每场对局 = 独立子进程(崩溃隔离)                             │
│  ┌─ 单场对局进程(engine)───────────────────────────────┐         │
│  │  输入物化:4 × 存档引用 + 地图 + 种子 + ruleset vN     │         │
│  │  确定性 tick 循环 ─ 快照分发 → QuickJS VM × 4(进程内串行)│      │
│  │  结算管线(移动裁决 → 同时攻击 → 对象 tick → 胜负)     │         │
│  │  输出:replay.jsonl(meta + 每 tick 状态/事件/hash + 末行 result)│  │
│  └───────────────────────────────────────────────────────┘         │
│    ↓ 聚合                                                          │
│  名次积分 + 叙事战报 + Markdown/JSON 报告(srs FR-8)               │
└───────────────────────────────────────────────────────────────────┘
                          ↓
  独立工具(不依赖引擎运行时):CLI ASCII 回放查看器、重放一致性校验器
```

### 2.2 技术选型与工具链

#### 2.2.1 语言与运行时

| 项 | 选择 | 依据 |
|---|---|---|
| 语言 | TypeScript 严格模式(`strict: true`,禁 `any` 隐式逃逸) | 与脚本语言同构、与 web 远期规划同构 |
| 运行时 | Node.js ≥ 22 LTS(锁 `package.json#engines`) | quickjs-wasi 的前置要求;引擎除沙箱外零运行时依赖 |
| 模块体系 | ESM(`"type": "module"`) | 避免 CJS/ESM 双轨 |

#### 2.2.2 工程结构与构建

| 项 | 选择 | 依据 |
|---|---|---|
| Monorepo | pnpm workspace(锁 lockfile,CI 用 `--frozen-lockfile`) | 多包单仓,包间边界清晰(§3.2) |
| 拓扑 | `apps/cli` + `packages/{schema,replay,engine,runner,gen}` | CLI 是 app 不是库;回放格式独立成包 |
| 包间类型引用 | TypeScript project references(`tsc -b`)+ `paths`;**禁 `baseUrl`** | 增量编译;编译期强制依赖方向;`baseUrl` 已被 TypeScript 7 移除 |
| 共享编译基座 | 根 `tsconfig.base.json` | 各包继承,不另设配置包 |
| 构建(库包) | 纯 `tsc -b` 产物;唯一例外是 VM 内 runtime bundle(打包方式属实现期选择,形态见 §4.5) | 库 + 子进程入口,无需打包器 |
| 构建(CLI) | `apps/cli` 用 esbuild 打成单文件 | 唯一 bin;子命令 `await import()` 动态加载便于分包 |
| 脚本预编译 | 冻结脚本由 gen 包用 `tsc` 编译为 script-mode JS;编译器版本锁定并写入存档 meta | 判据是"语义可预测 + 冻结后不再变",不是快 |
| CLI 入口 | 唯一 bin 在 `apps/cli`;`node:util` `parseArgs` 解析子命令,零第三方依赖 | §9 的六个子命令 |

**脚本入口契约(定稿)**:参赛脚本是**单文件 script-mode TS**,顶层声明 `function loop(): void` 作为入口,**不写 `export` / `import`**(validator 对二者直接报错回喂,§6.2)。理由:VM 内以 `evalCode` 载入脚本模式 JS、`moduleLoader` 不配置,`export` 产物在两种 tsc `module` 设置下分别是"无法执行"与"编译报错"。是否 `export` 是编译期即可判定的事实,不进入运行时容错。

#### 2.2.3 代码质量:oxc 统一工具链

格式化与静态检查统一采用 [oxc](https://oxc.rs/),不引入 ESLint/Prettier:

| 项 | 工具 | 说明 |
|---|---|---|
| 格式化 | **oxfmt** | 全仓库统一配置,`oxfmt --check` 进 CI |
| Lint(语法+结构) | **oxlint** | 替代 ESLint 成为主 linter |
| Lint(类型感知) | **oxlint-tsgolint**(`--type-aware`) | 底层是 `tsgolint`,故**强制 TS 7.0+**,版本号跟随 TS(如 `v7.0.2001`),二者须同时升级;**该依赖系于未 GA 的 TS 7.0**,属工具链 gate(§12 #5) |
| 类型检查 | **`tsc -b` 为唯一类型闸门** | `oxlint --type-check` 仍标 *experimental*,仅并行试跑,不设为闸门 |
| 确定性 Lint | 自定义规则 `no-float-literal`:engine 包内禁浮点字面量、禁白名单外的 `Math` 浮点函数 | FR-2 AC3 / NFR-1 的机械化保障;以 oxlint JS 插件实现,通道不稳则退化为基于 oxc-parser 的自建校验脚本,CI 强制 |
| 沙箱 API 白名单 | oxlint `no-restricted-globals` / `no-restricted-imports`(定时器与异步调度源 `setTimeout`/`setInterval`/`setImmediate`/`queueMicrotask` 明确在禁列,宿主桥函数 `__*` 同禁) | gen 静态校验参赛脚本时启用(§6.2);白名单符号表由 `schema` 生成;运行时 QuickJS 内默认即无定时器,静态禁令为纵深防御 |
| 复杂度 | oxlint `complexity`(warn,不进 gate);热点扫描 `scc --by-file --cognitive --hotspots`(手动) | 复杂度是诊断信号,耦合是硬约束,不放同一层 |

**三条必须记住的约束**:

1. **类型感知 lint 需要已解析的类型信息**:monorepo 必须先 `tsc -b` 生成 `.d.ts`,`--type-aware` 才有正确输入。CI 静态阶段顺序固定为 `tsc -b` → `oxlint --type-aware`。
2. **`oxlint-tsgolint` 版本号跟随 TypeScript 版本**,不能单独升 oxlint。
3. **路径别名一律用 `paths`**(`baseUrl` 已被 TypeScript 7 移除)。

**复杂度与耦合的分层原则**:dependency-cruiser 规则(§3.2)= error 硬门禁;复杂度阈值 = warn 不进 gate。理由:复杂度门禁会诱导 agent 抽函数——复杂度没有消失,只是从 A 搬到 B,还多出为拆而拆的小模块。真正该看的是 hotspot = 复杂度 × 改动频率,`scc --hotspots` 是平价近似。

#### 2.2.4 测试

| 项 | 选择 | 覆盖内容 |
|---|---|---|
| 测试框架 | Vitest(沙箱测试用真实 quickjs-wasi VM 或 `StubRunner` 替身) | 引擎结算单元测试、沙箱异常/超限裁决测试(FR-4) |
| 属性测试 | **fast-check** | 把 srs 的 AC 写成可执行命题,见下表 |
| 确定性回放 | 固定种子 + 固定脚本 → 逐 tick `stateHash` 断言;`modelwar verify` 重算比对 | FR-2 AC1、NFR-1 AC |
| 地图校验 | map-lint 对 `maps/` 全量断言四重旋转对称 | FR-1 AC2 |
| 规则文档验收 | `benchmarks/` 下模型生成 ≥2 个基准脚本,仅凭 `docs/rules-v1` 编写 | FR-10 AC1、srs §4 第 2 条(模型 dry-run 流程,测试仅保证可运行) |
| 变异测试 | StrykerJS(`@stryker-mutator/core` + Vitest runner),夜跑 | 度量测试有效性 |

属性测试(收益最高的一层),把 AC 直接写成命题:

| 条款 | 属性 |
|---|---|
| FR-2 AC1 确定性 | `hashOf(run(s,p)) === hashOf(run(s,p))` |
| FR-2 AC2 序列化往返 | `deepEqual(parse(serialize(st)), st)` |
| FR-1 AC2 四方对等 | `deepEqual(rotate90(m).seats[i], m.seats[(i+1)%4])` |
| FR-3 AC1 不可变性 | `step` 后原 `state` 深比较不变 |
| NFR-1 整数闭包 | `step` 输出全为整数(动态补静态类型之漏) |
| FR-7 AC1 种子与座位派生 | 同名输入必同输出、组合间无碰撞;各 seat 场次数差 ≤ 1(M×K 为 4 的倍数时严格相等) |
| FR-8 AC1 排名 | 名次分守恒、参赛者置换不变(纯函数,§8.2) |

**已知陷阱**:`JSON.stringify(-0) === "0"`,往返丢符号。全整数 + JSONL 的组合正好踩在这上面——属性测试会逮到,手写例子测试不会。

**禁止项**:

| 禁止 | 理由 |
|---|---|
| `vitest -u` 快照测试 | 测试红了 agent 会去更新快照而非查 bug。回放一律用显式 `stateHash` |
| 覆盖率门禁 | agent 极擅长刷覆盖率;要看测试是否钉住行为,用 Stryker 变异分数 |
| pre-commit 跑全量测试 | 慢钩子会被绕过。只跑 changed-files 的 format + typecheck |

**变异测试定位**:属"事后体检"而非合并前门禁,只夜跑,范围优先 engine 结算管线——变异得分是"确定性测试没有退化成摆设断言"的量化证据。得分显著下降开 issue 跟进,不堵合并。

#### 2.2.5 数据与 schema(唯一真源)

| 项 | 选择 | 依据 |
|---|---|---|
| 真源 | **`schema` 包 = 类型 + 常量表 + 参数 key 清单 + JSON Schema;`rulesets/*.json` = 全部参数取值** | 消除"规则文档与数值文件双真源 + 人工同步"的漂移 |
| 文档生成 | 由 `schema` 生成 `docs/rules-v1/api.md` 的 API/常量表,由 `rulesets/v1.json` 生成 `rules.md` 的数值表;**散文部分人工编写** | 生成物进版本库,CI 跑 `git diff --exit-code`,未重新提交即报错(FR-10 AC2) |
| 数据格式校验 | JSON Schema(schema 包内定义,运行时用 `ajv`) | ruleset / 地图 / 存档 meta / result / 回放行的读入端强制校验;版本错配在装载期报错(FR-10 AC2) |
| hash | `node:crypto` SHA-256(标准库) | stateHash、地图 hash、存档完整性校验,零第三方依赖 |
| 随机数与 ID | **归 `driver` 所有**:整数 LCG + `IdGen`;RNG 消费顺序写入 rules-vN | 确定性原语不散落;消费顺序是回放断裂的经典成因(§4.6) |

#### 2.2.6 gen 管线专属依赖(唯一允许联网的包)

| 项 | 选择 | 依据 |
|---|---|---|
| prompt 模板 | `prompts/` 目录下的数据文件(不进 gen 代码) | 改提示词不必改代码;与 `docs/rules-v1` 同为 gen 的输入 |
| 模型 API 客户端 | OpenAI-compatible HTTP 客户端 + 各厂商 SDK 适配层 | 新模型接入只改配置(FR-5 AC3);凭证一律走环境变量 |
| 重试与限流 | 指数退避 + 每模型并发 1 | 生成阶段无性能压力 |
| 生成日志 | 结构化 JSON 落盘(进存档 meta) | FR-6 AC1 |

#### 2.2.7 脚本分层与 CI 质量门禁

| 脚本 | 内容 | 用途 |
|---|---|---|
| `check:quick` | `oxfmt --check` + `oxlint`(无 type-aware) | agent 每轮编辑循环,目标 < 5s |
| `check:types` | `check:quick` + `tsc -b` + `oxlint --type-aware` | 改完一个 issue 跑一次 |
| `check` | `check:types` + `vitest run` + `depcruise` + 生成物漂移检查 | CI 全量 |
| `test:props` | `vitest run --project properties` | 长时属性测试,单独跑 |
| `mutate` | `stryker run` | 夜跑 |
| `scan` | `scc --by-file --cognitive --hotspots` | 偶尔手动 |

> 快慢分离是关键:agent 走 `check:quick`,需要类型感知 lint 时跑 `check:types`,CI 走 `check`。类型感知 lint 超过 ~10s,agent 就会"写完一起跑",反馈回路断掉。

**主流水线**(每次 PR 与主干 push,全部通过才可合并):

| 阶段 | 内容 | 对应需求 |
|---|---|---|
| 1. 编译 | `tsc -b`(必须先于类型感知 lint) | — |
| 2. 静态 | oxlint(`--type-aware`,含 `no-float-literal`)、`oxfmt --check`、dependency-cruiser、生成物漂移检查 `git diff --exit-code` | FR-2 AC3、FR-10 AC2、NFR-4 AC2 |
| 3. 单测+属性 | Vitest 全量(结算、属性、沙箱裁决、地图校验) | FR-1/3/4 |
| 4. 集成 | 样例对局端到端 + `modelwar verify` 重放一致性 + 重跑 10 次 hash 断言 | FR-2、NFR-1 |
| 5. 基准 | `benchmarks/` 双模型基准脚本对打一场,断言正常终局(不判策略胜负) | srs §4 第 2 条的回归防线 |

**夜间流水线**(定时或手动,不阻塞 PR):StrykerJS 变异测试(engine 优先);对 CI 可取到的对局样本批量 `modelwar verify`,守护"历史结果永远可复算"(NFR-2)。

CI 环境无网络、无模型 API、无凭证——保证 CI 上跑的永远是无头引擎与固定脚本,与生产对局同构。

#### 2.2.8 依赖策略

| 包 | 运行时第三方依赖 | 理由 |
|---|---|---|
| engine | 仅 `quickjs-wasi` + `node:crypto` | 除 stateHash 外**禁一切 `node:*`**,由 dependency-cruiser 强制——等于用 lint 证明"纯函数"。engine 不做磁盘 I/O:wasm 字节由 `apps/cli`/runner 读盘后传入,回放写向注入的输出 sink(§3.1),`engine` 包内不出现 `fs` |
| runner / apps/cli | 受控少量(schema 校验器;CLI 参数解析用 `node:util` 的 `parseArgs`,不引命令行库) | 只做调度与读文件,不参与结算 |
| gen | 允许(HTTP 客户端、SDK) | 唯一联网包,永不进对局进程(NFR-4 AC2) |
| devDependencies | 全仓库共享(oxlint、oxfmt、Vitest、StrykerJS、dependency-cruiser、tsc) | 不进入任何运行时 |

#### 2.2.9 观测与调试

| 项 | 选择 | 依据 |
|---|---|---|
| 引擎日志 | 对局级结构化 JSON 落盘(`runs/<runId>/logs/`),默认静默 | 排障可追溯;不打断 JSONL 回放的纯数据性 |
| 对局内调试 | **不建专用工具**:`modelwar match` 单场重跑 + JSONL diff 即等价物 | 确定性引擎下"调试 = 重放" |
| 叙事战报 | runner 内置生成器,只消费回放 events 流(§7.5) | 主输出要求 |

#### 2.2.10 依赖治理(dependency-cruiser)

| 能力 | 用法 |
|---|---|
| 可视化 | `depcruise --output-type dot` 生成模块依赖图,产物入 `docs/diagrams/` |
| 规则强制 | `.dependency-cruiser.cjs` 把 §3.2 全部规则写成可执行断言,违规非零退出,挂在 CI 静态阶段 |
| 价值 | 包边界(尤其"gen 永不进对局进程"与"engine 纯函数")从口头约定变为机器门禁 |

> 依赖规则与 TS project references 双保险:前者管运行时 import,后者管编译期类型引用。

#### 2.2.11 明确不做

| 项 | 原因 |
|---|---|
| Rust(引擎 / SDK / 工具链) | NFR-3 算力预算下瓶颈不在 CPU;多语言仓库对 agent 是净负担。沙箱留 adapter 位即可 |
| 自研类型检查器 | oxc 官方已放弃,转而集成 tsgolint |
| `typescript-eslint` | 慢一个数量级,对 agent 编辑循环是致命的 |
| `isolated-vm` / node-gyp 类原生模块 | agent 环境装不上(需 Python + build-tools),CI 不稳 |
| Turborepo 等任务编排层 | 多一层配置 = agent 多一份上下文负载 |
| 覆盖率门禁 / 快照测试 | 会被 agent 刷,见 §2.2.4 |
| 复杂度做成 error 门禁 | 见 §2.2.3 分层原则 |
| mod 系统 / 多存储后端 / 多进程(竞品 Screeps 形态) | v0 单机离线,扩展面由 `rulesets/` + `maps/` 承担(见 `docs/competitors/screeps.md` §8.2) |
| Docker(主路径) | gen 只是调 API,不需要容器隔离 |

### 2.3 进程与执行模型

| 层 | 单位 | 生命周期 | 隔离目的 |
|---|---|---|---|
| runner | 主进程 | 整轮赛季 | 调度、聚合;不执行任何参赛代码 |
| engine | **每场对局一个子进程** | 单场对局 | 单场崩溃不污染其余场次(FR-7 AC2);内存上限可在进程级施加 |
| sandbox | 对局进程内,每方一个 QuickJS VM(同进程、串行执行,§5) | 与对局同生命周期 | 脚本无网络/FS/宿主访问(FR-4 AC1);一方崩溃不影响他方(AC3) |

执行模型:引擎每 tick 按 playerIndex 0..3 顺序串行执行四方 `loop()`——快照构建 → VM#i 执行并收集 intents → 下一方。**无并发、无到达顺序问题**:确定性天然成立,无需归位逻辑。

runner 通过子进程调用 `modelwar match`(§9)执行单场;两者之间只交换 `input.json` 与产物文件。

## 3. 系统分解

### 3.1 包结构与职责矩阵

```
model-war/
├─ apps/
│  └─ cli/                    # 唯一用户面与唯一 bin(modelwar)
│     └─ src/{index.ts, commands/{gen,run,match,replay,verify,map-lint}.ts}
├─ packages/
│  ├─ schema/                 # 唯一真源:类型 + 常量表 + 参数 key + JSON Schema(无运行时代码)
│  ├─ replay/                 # 回放格式 + 解析/序列化 + stateHash 原语(只依赖 schema)
│  ├─ engine/                 # 确定性内核 + 沙箱(driver/processor/world/snapshot/runner/sandbox-runtime/replay-writer/ruleset-loader)
│  ├─ runner/                 # 赛季调度、进程池、排名与种子纯函数、报告、叙事战报
│  └─ gen/                    # 脚本生成管线(离线,永不进对局进程)
├─ benchmarks/                # 模型基准脚本(≥2)
├─ prompts/                   # gen 的 prompt 模板(数据文件)
├─ rulesets/v1.json           # 规则数值数据文件(取值真源)
├─ maps/                      # 地图 JSON
├─ docs/rules-v1/{rules.md,api.md}   # 面向模型的文档(表格为生成物)
├─ archive/<model>/<runId>/   # 冻结脚本存档
└─ runs/<runId>/              # 对局产物:回放 JSONL、result、报告、叙事战报
```

| 模块 | 职责 | 对应需求 |
|---|---|---|
| engine:driver | **状态唯一所有者**:GameState、Random(整数 LCG)、IdGen、`apply()` 唯一写入口 | FR-2 AC3、NFR-1 |
| engine:processor | 结算管线(顺序为数据)+ `intents/*.ts` 的 `check()`/`run()` 注册表 | FR-1、FR-3 AC3 |
| engine:world | 状态模型、对象系统、只读查询 | FR-1 |
| engine:snapshot | 只读快照构建与冻结 | FR-3 AC1 |
| engine:runner | 执行器缝:`Runner` 接口 + `QuickJsRunner`(唯一真实实现)+ `StubRunner`(测试替身) | FR-4、§5.2 |
| engine:sandbox-runtime | 沙箱内 API 面(TS → IIFE bundle,版本 + hash 入 meta) | FR-4 |
| engine:replay-writer | JSONL 写出(行格式取自 `replay` 包;写向注入的输出 sink,不直接碰 `fs`) | FR-2 AC2 |
| engine:ruleset-loader | 参数装载与版本比对 | NFR-4 AC1、FR-10 AC2 |
| runner:scheduler | 组合 × 地图 × 种子 × 座位的场次枚举与并发调度 | FR-7 |
| runner:ranker | 名次积分、并列处理、可选 Elo(**纯函数**) | FR-8 |
| runner:reporter | Markdown 报告 + JSON 原始数据 + 叙事战报 | FR-8 AC2 |
| gen:pipeline / validator / archiver | prompt 组装 → 模型 API → 校验迭代 → 冻结;API 误用静态检查(白名单由 `schema` 生成);元数据强制存档 | FR-5、FR-6 |
| replay | 回放行格式、解析/序列化、stateHash 原语 | FR-2 AC2、NFR-1 |
| cli:replay-view / replay-verify / map-lint | ASCII 查看器(不依赖 engine);重放一致性断言;地图对称性校验 | FR-9、NFR-1、FR-1 AC2 |

### 3.2 依赖规则

```
schema ←── replay ←── engine ←── apps/cli
   ↑                    ↑           ↑
   └──────── runner ────┘           │
   └──────── gen ───────────────────┘
```

- `schema` 只含类型、常量与 JSON Schema,**无运行时代码**;各包共享数据格式定义不违反 NFR-4 AC2(该条款约束的是运行时进程隔离)。
- `replay` 只依赖 `schema`;**库包一律不得含 `bin`**,唯一 bin 在 `apps/cli`。
- `runner` 与报告/叙事代码**不得 import `engine`**:只以子进程 + 文件消费。`apps/cli` 通过 engine 公共 API 调用(match / verify / map-lint)。
- `engine` 不 import `runner`/`gen`;`gen ⇎ engine`,且 `gen` 禁 import 任何 result 类型(FR-5 AC1)。
- `engine` 内除 `node:crypto` 外禁一切 `node:*`。
- `engine` 内部单向:`world → driver → processor → replay-writer`;`world → snapshot → runner(Runner 缝 → sandbox-runtime)`。`sandbox-runtime` 不 import 宿主代码,只消费 `schema` 生成的常量/API 名表。
- 上述规则全部由 dependency-cruiser 强制(§2.2.10),违规直接导致 CI 失败。

## 4. engine 概要设计

### 4.1 状态模型

```ts
// 全整数;无浮点字段(FR-2 AC3)
interface GameState {
  tick: number;                 // 唯一时间单位
  players: Player[4];            // index 0..3,固定
  units: Unit[];                // 按数值 id 升序维护
  sites: Site[];                // 按数值 id 升序维护(基地 + 资源点)
  productions: Production[];     // 各基地独立队列,单条
  nextId: number;               // 全局单调递增,对象创建时分配
  outcome: Outcome | null;      // 终局:排名 + 原因
}

// Outcome:{ rankings: number[]; reason: 'victory' | 'shortcut' | 'timeout'; territoryScores: number[] }
// rankings[i] = 玩家 i 的名次(1 起,可并列),由 gdd《胜利与淘汰》的排序规则产生

interface Player {
  index: 0|1|2|3;
  resources: number;            // 全局共享池,无上限
  alive: boolean;
  exceptionTicks: number;       // 累计异常 tick 数;随 JSONL 持久化,VM 中断/重建后由持久化值续算不清零
}

interface Unit {
  id: number;
  owner: 0|1|2|3;
  type: 'worker' | 'melee' | 'ranged' | 'cavalry';
  x: number; y: number;         // 网格坐标,Chebyshev 八向
  hp: number;
  carrying: number;             // 农民携带量
}

interface Site {
  id: number;
  kind: 'base' | 'resource';
  x: number; y: number;         // 点位为单格
  owner: -1 | 0|1|2|3;          // -1 = 中立
  progressOwner: -1 | 0|1|2|3;
  progress: number;
  remaining?: number;           // 仅资源点
}

interface Production { baseId: number; type: UnitType; ticksLeft: number }
```

- **id 全局单调递增**(含被销毁对象),一切"按对象处理"的阶段按**数值 id 升序**迭代。数值升序是唯一被声明的定序语义,写入 rules-vN。
- 一切数值(HP、造价、速度、阈值、上限)**不出现**在上述结构中,统一来自 `rulesets/v1.json` 装载。
- 胜利条件、淘汰条件、点位数量等由 gdd《对局规则》定义,引擎按"地图数据的点位数"判定,不硬编码数量。

### 4.2 intent 模型(脚本 → 引擎的唯一通道)

```ts
type Intent =
  | { kind: 'move';      unitId: number; dx: -1|0|1; dy: -1|0|1 }
  | { kind: 'moveTo';    unitId: number; x: number; y: number }   // 引擎端逐 tick 寻路
  | { kind: 'attack';    unitId: number; targetId: number }
  | { kind: 'harvest';   unitId: number; siteId: number }
  | { kind: 'transfer';  unitId: number }                          // 交付全部携带量至相邻己方基地(多个时取 id 最小者,见 gdd《经济与生产》)
  | { kind: 'spawnUnit'; baseId: number; unitType: UnitType };      // 下单即扣款;资金不足则无效(ERR_NOT_ENOUGH_RESOURCES)
```

- 一个单位每 tick 至多一个单位级 intent;`spawnUnit` 为玩家级 intent。重复提交同单位 intent:**取该单位最后一个,前面的静默丢弃**(不视为异常,不占用异常配额)。
- intent 由 `processor` 的 `check()` 统一校验(属主正确、参数在界、目标存在且合法),**无效 intent 丢弃并写入当 tick 事件流**(调试可观测),不触发异常判罚——异常判罚只针对脚本抛出异常与超预算(gdd《异常与出局》)。
- `attack` 目标须存在且为敌方单位;攻击者无攻击能力时该条 intent 无效丢弃、不计异常。

### 4.3 tick 结算管线(每 tick 严格按此顺序)

```
0. dispatch   构建四方只读快照 → 按 playerIndex 0..3 串行执行各 VM 的 loop()
              并收集 intents(预算与异常裁决在此层)
1. validate   intent 先按单位分组、每单位只留最后一个(静默丢弃,不计异常),
              分组后按 playerIndex 0..3 再按 unitId 升序逐条校验;无效者丢弃
2. movement   移动结算(基准与冲突裁决见 §4.4)
3. combat     同 tick 全部 attack 同时结算:
                a) 先计算全部伤害(攻击者本 tick 死亡不影响其攻击生效)
                b) 统一扣血,归零者死亡移除(不参与后续阶段)
4. objectTick 按对象数值 id 升序:
                a) 占领:单轨累积 / 转轨重计 / 冻结保留(gdd《占领机制》)
                b) 采集:按 gdd《经济与生产》结算,满携带上限即停
                c) 交付:carrying 清零入玩家池
                d) 生产:各队列 ticksLeft--,归零出兵;出兵格被任意单位占据则挂起等待;
                   基地易主时按 gdd《经济与生产》处理队列(退款走玩家池,全整数运算)
5. evaluate   胜负判定(顺序即规范,gdd《胜利与淘汰》)
                a) 淘汰:满足淘汰条件者出局,点位回归中立
                b) 全部点位归属单一玩家 → 胜
                c) 仅剩一方尚存 → 捷径条款即胜(兜底)
                d) 淘汰方 loop() 不再执行(VM 暂停调用,状态保留以便重放取证)
6. emit       写 JSONL 一行(完整可渲染状态 + 事件 + stateHash);tick++
7. loop guard tick 达 ruleset 的 tickLimit → 超时,按 gdd《胜利与淘汰》的领土分规则定名次
```

**顺序即规范**:以上顺序与 §4.4 的裁决细则写入 `docs/rules-v1`(FR-10 AC3)。任何顺序调整都是规则变更。

### 4.4 移动与碰撞裁决

**占位判定基准(定稿)**:一轮移动结算**只以该轮开始时的占位为准**。单位离开它本轮所在的格子,不会使该格在本轮对后来者变为可进入;同一格至多一个单位成功进入。由此:

- **同格竞争**:多方单位目标格相同 → 按轮转优先级 `(tick + playerIndex) mod 4` 取胜者,其余原地不动(不尝试次优目标,规则面最小)。该序列是全序,无平局。
- **交换/穿行**(A→B 同时 B→A)与**链式移动**(A→B 同时 B→C):按基准判定,B 格本轮被占,故 A 移动失败;B 移动是否成功只取决于 C,二者互不牵连——不需要链式裁决,也不存在环形追逐。
- 己方单位之间同样按此裁决(无友军穿越)。

`moveTo` 每 tick 由引擎执行一步 A*(§4.7),等价于"本 tick 的 move",参与同一套裁决;路径不跨 tick 缓存,每 tick 重算。

骑兵的二次移动:**重复整轮结算一次**——第一轮结算后的占位即第二轮的基准,轮转优先中的 `tick` 值不变。

**座位与先后手**:轮转优先只保证单场内首发顺序逐 tick 轮转,不消除头对头偏置(下标差 d 的两人,低下标在 `(4-d)/4` 的 tick 中先手)。故座位必须在赛季内轮换,公式见 §8.1。

### 4.5 快照与脚本 API 面

- 快照 = GameState 的**深拷贝**,经单次 `__setSnapshot` 传入 VM;脚本持有的引用在下 tick 全部作废,**对象身份不跨 tick 保证**(跨 tick 记忆只能用自己的状态与数值 id,不得缓存对象引用)。`Object.freeze` 由引擎侧在深拷贝上执行(防宿主回调误写);**隔离靠拷贝边界,而非冻结语义**。
- **API 面由沙箱内 runtime bundle 实现**(`engine/sandbox-runtime`,TS → IIFE):
  1. 每 tick 只跨宿主边界两次——`__setSnapshot(snapshot)` 进、`__drainIntents()` 出;
  2. 查询函数(`getObjectsByType` / `getObjectById` / `getTick` / `getRange` / `findPath` / `getTerrainAt`)与 action 函数(`move` / `moveTo` / `attack` / `harvest` / `transfer` / `spawnUnit`)全部在 VM 内运行,跨边界调用数从 O(API 调用数) 降到 O(1)/tick;
  3. 脚本可见全局 = runtime 暴露的 API + `schema` 生成的常量表,不注入任何宿主能力。
- **形态定案**:v0 保留 bundle 形态,不回退逐函数注入(§2.2.2 的回退路径仅留档)。
- **宿主桥函数不可见**:runtime bundle 初始化时把 `__setSnapshot` / `__drainIntents` 捕获进闭包并**从 VM 全局删除**,任何以 `__` 开头的全局名同时进静态黑名单(§2.2.3)。越权调用按 §5.2 处理。
- 运行时校验(FR-3 AC3):action 函数做"收集 + 界检查 + API 计数自增",不触碰引擎真实状态;查询函数在 VM 内快照副本上操作;intent 合法性由 `processor` 的 `check()` 统一裁决——**同一份 `check()` 也用于 VM 内的即时 `ERR_*` 反馈**(dual validation),杜绝"沙箱一份、宿主一份"的逻辑漂移。

### 4.6 确定性保障(NFR-1,一票否决)

| 层 | 措施 |
|---|---|
| 运算 | 引擎代码禁浮点(§2.2.3);资源、伤害、进度、领土分全整数 |
| 迭代顺序 | 一切多对象处理按数值 id 升序;玩家处理按 index 0..3;不存在 Set/Map 迭代参与结算 |
| 随机数 | **对局内不消费随机数**;唯一 `Random`(整数 LCG)在 `engine` 内、开局前一次性用于地图变体填充(§7.3),消费顺序 = 变体槽位 id 升序。rules-vN 只声明"对局内无随机" |
| 异步隔离 | 同进程串行执行;**`vm.executePendingJobs()` 每 tick 执行 `loop()` 后必须排空**,Promise 回调不得跨 tick 残留;管线内无异步 |
| 移动裁决 | 占位基准 + 轮转优先(§4.4),全序、无平局、无链式依赖 |
| 路径搜索 | A* 邻居展开顺序固定(八向按固定方向表),tie-break 按 id;启发式整数化(Chebyshev ×2) |
| 预算裁决 | 控制流事件计数 + API 调用计数为主判据;墙钟只观测;硬超时使该场无效化而非参与判罚(§5.3) |
| 验证 | CI 重放一致性:抽样对局重新执行,与 JSONL 逐 tick stateHash 比对 |
| 地图 | 地图 JSON 带内容 hash,回放头部记录;对称性由 map-lint 校验 |

**stateHash**:对每 tick emit 的规范化状态(排序后的对象数组序列化)计算 SHA-256,写入 JSONL。哈希计算在写出路径上,不参与结算。

### 4.7 寻路(A*)

- `findPath` 暴露给脚本;`moveTo` 内部复用同一实现——**同一实现保证脚本查询结果与引擎实际移动一致**。
- CostMatrix 参数化(v1:墙不可通行,其余等价);启发式整数 Chebyshev(×2 与步长同量纲,避免浮点)。
- 寻路调用量计入脚本 API 调用预算,防止用寻路做算力攻击。

## 5. 沙箱(sandbox)概要设计(选型:quickjs-wasi)

每方脚本运行在一个独立 QuickJS VM(WASM 实例)中,同对局进程、每 tick 按 playerIndex 串行执行。

**边界说明**:不为"未来换 VM"保留抽象层(那是投机抽象);§5.0 的 `Runner` 缝**只为可测性**存在。

### 5.0 选型结论

决策记录(候选取舍与后果):`docs/adr/0001-sandbox-quickjs-wasi.md`。

v0 采用 `quickjs-wasi`(QuickJS-NG 编译为 WASM 的快照型 JS 运行时,MIT 协议,零第三方依赖;版本锁定到 `package.json`,**锁定 3.6.2**(基线 ≥3.5.0:3.3.x 的 `memoryLimit` 计账与 OOM 异常形态各有回归),升级需重跑重放一致性测试与沙箱行为复测)。相对此前候选(QuickJS 嵌入 / WASM + fuel / isolated-vm):

- **隔离**:One VM = One WASM 实例,线性内存互不可见;包只做显式 I/O(wasm 字节由调用方提供),默认无 FS/网络——满足 FR-4 AC1,且比 worker_threads 的"去全局"做法审计面更小。
- **预算可复现**:`interruptHandler` 每 5000 次控制流事件(循环回边/调用/返回)触发一次(回调内自乘计数),与 API 调用计数构成双主判据——实测口径是**控制流事件计数**而非指令计数(直线代码不计量,由 §6.2 脚本体积上限封盲区);`memoryLimit` 超限(≥3.5.0)表现为可捕获的 JS 异常,内存判据锚定 tick 末存活堆读数(§5.3)——均不依赖墙钟。回调开销与粒度已实测校对(拖慢 ≤3%)。
- **崩溃语义**:WASM 执行无进程崩溃概念;死循环由中断计数截停;深递归栈溢出表现为 host 侧 `RangeError`(VM 可续用);WASM trap 仅剩引擎故障级可能——FR-4 AC3 的"一方崩溃不影响他方"降级为"一方失控只计异常分,不污染引擎与他方 VM"。
- **记忆能力**:VM 常驻对局全程,模块级变量天然跨 tick 保留(FR-3);snapshot/restore 能力暂不用(状态以 GameState + JSONL 为准)。
- **执行器缝**:host 侧 `Runner` 接口(`init/tick/dispose`)+ `QuickJsRunner`(唯一真实实现)+ `StubRunner`(测试替身:回放预置 intent、抛异常、触发 trap、超预算)。**在出现第二个真实 VM 实现之前不新增抽象层**——这条缝只让 §5.2 的四类裁决与结算管线可脱离 WASM 穷举测试。
- **代价**:Node ≥ 22;`moduleLoader` 不配置(`import` 在静态校验期即拒绝);quickjs-wasi 有 `maxStackSize` 选项(≤512KB),v0 不启用——启用会把栈溢出变成 guest 可捕获异常、可被脚本吞掉;不启用则溢出为 host `RangeError`,host 必见。

### 5.1 隔离与注入

- 每方一个独立 `QuickJS.create({wasm, memoryLimit, interruptHandler, wasi})` 实例;四个 VM 同进程串行执行,不共享线性内存。`wasm` 字节由 runner 层读盘传入 engine(engine 不做磁盘 I/O)+ `WebAssembly.compile` 预编译,四 VM 复用同一 `WebAssembly.Module`。
- **WASI 覆盖**(三件套取值定为工程常量,非对局参数):`clock_time_get` 覆盖为 `1700000000000`(冻结 `Date.now()`/`new Date()`;QuickJS 内部 PRNG 以该值播种 xorshift64*,同值即同 `Math.random()` 序列),`random_get` 覆盖为固定字节填充,`timezoneOffset` 固定为 0。三件套取值与 `quickjs-wasi` 版本号一并写入回放 meta 行(§7.5),可审计。
- 脚本可见全局 = runtime bundle 暴露的 API + `schema` 生成的常量表 + 纯函数子集;`fetch`/`fs`/`process` 等宿主能力一律不注入——隔离靠"不给"而非"拿掉"。**不加载任何 `.so` 扩展**(url/encoding/headers/crypto/structured-clone 均不启用)。
- 载入次序:`evalCode(runtimeBundle)` 建 API 面 → `evalCode(script.js, {filename})` 载入选手脚本 → 每 tick `__setSnapshot(snapshot)` → `callFunction(loopFn)` → `__drainIntents()`。runtime bundle 与脚本同处一个全局环境,但 runtime 的内部计数器与宿主桥引用都在闭包内,且桥函数在初始化后被删除(§4.5)。
- 定时器与异步调度源在 QuickJS 内默认即不存在;`vm.executePendingJobs()` 每 tick 排空。跨 tick 记忆只认模块级变量。

### 5.2 异常裁决(gdd《异常与出局》的实现化)

| 情形 | 处理 | 确定性 |
|---|---|---|
| `loop()` 抛异常(host 侧异常同此行:含内存超限转成的 JS 异常、深递归栈溢出的 host `RangeError`) | 本 tick 该方 intents 置空(单位原地待命);`exceptionTicks++`;达 ruleset 的 exceptionTickLimit → 判负出局(点位回归中立)。**VM 续用、记忆保留** | ✅ 计数可复现 |
| 中断超限(`interruptHandler` 返回 true) | 同上;VM 中断后仍可用,无需重建 | ✅ |
| WASM trap(引擎故障级;**脚本栈溢出不属此类**,实测为 host `RangeError`) | 视同该 tick 异常计一次(同第一行)+ **防御性重建**该方 VM(重载脚本,模块级记忆清零);trap 事件写入回放 events 流与报告,夜间扫描复核——同一回放不复现则事后按 §8.4 `engine-crash` 同轨处理 | ✅ 判罚可复现;复核在扫描层 |
| 内存判据超限(该 tick 末存活堆读数 ≥ `memoryTickCeiling`) | 视同第一行(intents 置空 + `exceptionTicks++`);判据于每 tick 末 `runGC()` 后取 `getMemoryUsage().mallocSize`(与分配上限同记账口径),纯记账、可复现;**guest 吞掉 OOM 不影响判据**——判据锚定读数,不依赖异常可见性。残余条款:tick 内瞬时触顶后自行释放的分配不触发判据(分配上限本身不可突破),已在规则文档披露。未被 guest 捕获的超限异常仍走第一行(host 可见) | ✅ |
| 越权调用(未定义 action / 访问已删除的宿主桥 / 访问未暴露字段) | 视同 `loop()` 抛异常 | ✅ |

注脚:异常/超预算不清记忆、不重建 VM;仅 WASM trap 的防御性重建会清记忆。`exceptionTicks` 是对局状态的一部分,随每 tick JSONL 持久化,VM 中断或重建后由持久化值续算,**不清零**(否则反复失控可逃逸淘汰)。**预算判据锚定 host 可直接测量的量,不依赖 guest 异常可见性**。OOM 异常身份不可靠(headroom 耗尽时 fallback 抛 `null`),引擎判定不得依赖 `e.name`。

### 5.3 计算预算(双计数主判据 + 墙钟只观测)

**形态:控制流事件计数 + API 调用计数为双主判据(均可复现);内存侧三层 = 分配上限(硬)+ 判罚线(硬)+ 软阈值(观测);墙钟不参与判罚。**

| 机制 | 实现 | 判罚 | 是否影响确定性 |
|---|---|---|---|
| 控制流事件计数 | QuickJS `interruptHandler` 回调计数(每 5000 次控制流事件一格:循环回边/调用/返回;回调须保持轻量,计数自乘);到顶返回 true 中断本 tick。直线代码不计量,由 §6.2 脚本体积上限封盲区 | 本 tick 该方 **intents 全部丢弃** + `exceptionTicks++`(与异常同轨) | ✅ 纯计数 |
| API 调用计数 | 宿主注入的 action/查询函数内自增计数器;到顶后**本 tick 内该方后续所有 intent 一并作废** | 同上。脚本 `try/catch` 捕获异常不能保留已提交的 intent——引擎按"该方本 tick 作废"处理 | ✅ 纯计数 |
| 内存分配上限 | `memoryLimit`(VM 线性内存)——引擎分配上限,上限本身不可突破 | 超限转 JS 异常(未捕获按 §5.2 第一行处理) | ✅ |
| 内存判据 | 软/硬双阈值;判据 = 每 tick 末 `runGC()` 后 `getMemoryUsage().mallocSize`(存活堆读数) | 硬线 `memoryTickCeiling`(ruleset 参数)超线 = 视同 §5.2 第一行;软阈值(0.8×硬,推导)仅写报告披露 `memory-pressure`。`runGC()` 固定扫描税 0.5–3.3ms/tick,入 NFR-3 标定考量 | ✅ 纯记账 |
| 墙钟软限 | 单 tick `loop()` 执行时长 | 写入回放 events 流 `budget-soft-warning` + 报告披露;**只观测** | ✅ 不参与判罚 |
| 墙钟硬超时 | 防宿主卡死的最后防线(如宿主回调卡死) | **不判负**:该场标记 `nondeterministic-timeout`,按 §8.4 与 `engine-crash` 同轨处理(重跑 / 剔除并披露) | 隔离出判罚路径,判罚仍可复现 |

设计理由:双计数互相覆盖对方的盲区——纯计算型死循环由事件计数抓住,API 轰炸(如每 tick 数万次 `findPath`)由调用计数抓住。**预算判据必须锚定 host 可直接测量的量,不依赖 guest 异常可见性**(guest 吞 OOM 异常时 host 零痕迹,故内存判据锚定 tick 末存活堆读数)。墙钟受机器负载影响,任何参与判罚的墙钟都会破坏 FR-2,故硬超时只把该场对局作废,不改变对局内的胜负判定。

**全部上限取值(事件计数上限、API 上限、内存上限、`memoryTickCeiling`、软限、硬超时、exceptionTickLimit、脚本体积上限)为 `rulesets/v1.json` 中的参数**,用 ≥2 个模型基准脚本标定(srs §4 第 2 条)。标定注脚:`memoryTickCeiling` 取值须 > 正常脚本 tick 末存活峰值 + 余量,且低于读数封顶(`memoryLimit − 最大单次分配`)。升级条款:若赛中"tick 内瞬时借满即还"型脚本普遍牟利,升级为 patch quickjs-wasi 加 sticky OOM 标志、判据回到确证事件(后备设计已评估,触发条件由运营定)。

## 6. 脚本契约与静态校验

### 6.1 契约载体

`docs/rules-v1/` 两份文档:`rules.md`(机制、结算顺序、确定性约束)与 `api.md`(API 签名与语义),自包含(FR-10 AC1)。二者同时是 gen 管线的 prompt 输入;其**表格部分(API/常量/数值)由 `schema` 包与 `rulesets/v1.json` 生成**,validator 白名单同理(§2.2.5)。

### 6.2 静态校验规则(gen:validator)

| 类别 | 规则 |
|---|---|
| 编译 | `tsc` 编译通过;顶层声明 `function loop(): void` 入口 |
| 模块系统 | 禁 `export` / `import` / 动态 `import()` / `require` / 动态 `eval`(单文件自包含) |
| 全局白名单 | oxlint `no-restricted-globals`:除注入 API 与内置纯函数子集(`Math`、`JSON`、`Number`、`String`、`Array`、`Map`/`Set`、`Object` 等)外全禁;白名单符号表由 `schema` 生成,与沙箱 runtime 暴露的 API 面同源;`Date` 视为确定性污染源,不可用;`__*` 前缀全禁 |
| 确定性污染源 | 禁 `Date`、`Math.random`、`performance`、`queueMicrotask` 及其他非确定源(运行时 WASI 时钟已冻结,本行为纵深防御) |
| API 误用 | 类型层面由 `schema` 包的公开 `.d.ts` 约束(结构化 intent 类型) |
| 脚本体积 | 顶层脚本体积上限(取值入 `rulesets/v1.json`)——封"直线代码不计量、大循环体放大每格工作量"的计数盲区 |

校验失败 → 仅错误信息回喂模型(≤5 轮,FR-5 AC1);`gen` 代码中不存在对战结果回传路径。

## 7. 数据设计

### 7.1 ruleset 数据文件(`rulesets/v1.json`)

**全部参数取值的真源**:兵种表、经济参数、占领参数、tick 上限、异常阈值、领土分权重、点位数量不变量(每方主基地数)、预算参数。地图的尺寸与具体点位数量归地图数据(§7.2),不在此文件。参数的含义与设计意图由 gdd《参数清单》定义,取值一致性由 JSON Schema 校验,版本号必须与 `docs/rules-vN` 一致(runner 启动时比对,错配拒跑,FR-10 AC2)。

### 7.2 地图 JSON(`maps/*.json`)

```jsonc
{
  "name": "open-clash",
  "size": 50,
  "rulesetMin": "v1",
  "terrain": ["...", ...],          // 行字符串,'.'=平原,'#'=墙
  "sites": [ { "id": 1, "kind": "base", "x": 10, "y": 10, "initialOwner": 0 }, ... ],
  "spawnUnits": [ { "owner": 0, "type": "worker", "offset": [0,0] }, ... ],
  "variantSlots": [ ... ]           // 变体槽位,机制见 gdd《种子变体》
}
```

- 初始单位配置围绕主基地,由地图声明,引擎不硬编码。
- **map-lint 强制校验**:四重旋转对称(terrain 与 sites 绕中心 90° 旋转自洽)、点位不重叠且不在墙上、地图池内 `size` 一致、地图数满足规则要求且风格覆盖(开阔/廊道/要塞)。校验不过的地图不进地图池。
- `variantSlots` 的字段形状随 gdd《开放项》#2 的地图设计一并定稿;在此之前 map-lint 只校验其四重对称性。

### 7.3 种子的用途

规则集本身无对局内随机过程,故种子驱动**地图变体**:按地图 `variantSlots` 声明的成组四重对称墙体槽位,以种子做确定性填充(整数 LCG),保持对称性与点位布局不变。变体只做装饰性微扰,不计入风格多样性(gdd《种子变体》)。地图坐标与槽位设计是规则侧开放项(gdd《开放项》);**变体是否参与策略决策(决定 K 的边际价值)同样是规则侧开放项**。

### 7.4 冻结脚本存档(`archive/<modelSlug>/<runId>/`)

```
script.ts      # 冻结源码,一字不改(FR-6 AC1)
script.js      # 由 gen 包在冻结前用 tsc 编译为 script-mode JS;文本 + sha256 入 meta.json
meta.json      # 模型名、模型版本/快照标识、生成日期、协议迭代轮数、完整 prompt(逐轮)、
               # 生成日志、ruleset 版本、校验结果、tsc 版本、script.js 的 sha256、sandbox-runtime hash
```

- 编译责任在 gen 包(冻结前完成),engine 不引入 tsc(§2.2.8)。
- runner 启动即校验元数据完整性,缺档**报错退出**(FR-6 AC2,不跳过)。
- 对局输入物化:`runs/<runId>/matches/<combo>-<map>-<seed>/input.json`(4 × 存档路径 + 地图 + 种子 + ruleset 版本 + 各文件 hash)与产物——任意一场可凭 input.json 复算(FR-7 AC3、NFR-2)。

### 7.5 回放 JSONL(`matches/<...>/replay.jsonl`)

```
第 1 行   {"type":"meta", schemaVersion, ruleset, quickjsWasiVersion, sandboxRuntimeHash,
           wasiClock, wasiRandomFill, timezoneOffset, mapHash, seed, players:[{model, archiveRef, seat}]}
第 n 行   {"type":"tick", tick, players, units, sites, productions, events:[...], stateHash}
末 行    {"type":"result", rankings, reason, territoryScores}
```

- `schemaVersion` 由 `replay` 包 `CURRENT_SCHEMA_VERSION` 常量承担(`replay` 为唯一真源),跨版本兼容性以它为准(FR-9 AC2)。
- 每 tick 记录足以绘制完整画面的状态:点位归属、占领进度条、单位位置血量携带、玩家资源。
- **events 事件流**(叙事与战报的统一来源):`first-contact`、`site-captured`、`unit-destroyed`(聚合)、`player-eliminated`、`economy-dead`(判定条件由 gdd《经济与生产》定义)、`budget-soft-warning`、`exception`、`victory`。叙事战报生成器只消费 events,不重新解析状态。

## 8. runner 与排名概要设计

### 8.1 场次与座位

- 输入:`season.yaml`(参赛脚本存档目录列表、地图池、种子数 K、并发度、ruleset 版本)。
- 枚举:全部 4 人组合 × M 地图 × K 种子(srs FR-7 AC1);种子值 = 确定性函数(组合、地图、序号),场次对全体参赛者一致。
- **座位轮换**:把组合内 4 名参赛者按 slug 升序为基准序列,座位 = 基准序列按 `(mapIndex + seedIndex) mod 4` 循环移位。**精确均摊要求 `M × K ≡ 0 (mod 4)`**(地图数通常为 3,故 K 取 4 的倍数);不满足时各座位场次数最多差 1,差额落在同一相对位次——该残留不对称由 §12 的座位胜率统计验证,不做逐座位校正。分配对全体一致且完全确定(FR-7 AC1)。
- 并发:进程池语义的对局子进程池,并发度默认 `min(cpus, 8)`;单场互不干扰。

### 8.2 排名(名次积分制)

- 名次由 gdd《胜利与淘汰》的排序规则决定(引擎在 `outcome` 中给出),`runner:ranker` 只做**纯函数记账**:名次分向量由赛季配置给出(`season.yaml` 的 `rankPoints`,默认 `[3,2,1,0]`,**不进 `rulesets/`**——赛制不该经 rules-vN 泄漏给模型);并列名次分 = 并列名次区间分值之和 ÷ 并列人数(并列第 2 → (2+1)/2 = 1.5)。
- 赛季总分 = Σ 场分;场均分排名;Elo 为可选副产品输出,不进主报告标题(FR-8 AC1)。

### 8.3 报告输出(`runs/<runId>/`)

| 产物 | 内容 | 消费者 |
|---|---|---|
| `report.md` | 排名、场均分、代表性对局叙事、校验失败名单、规则版本标注 | 人类 / 自媒体素材 |
| `report.json` | 每场对局的输入引用 + 名次 + 分数 | 机器复算(NFR-2 AC) |
| `narrative/<场次>.md` | 从 events 生成的叙事化战报(时间线:首触、易手、淘汰、经济死亡、终局) | 自媒体文案 |

### 8.4 对局异常的处理

进程崩溃(engine bug)或硬超时 → 该场标记 `engine-crash` / `nondeterministic-timeout` 并重跑一次;再触发则记入报告的**问题清单并排除出该场排名**,不静默丢弃(FR-7 AC2)。内存超限判负在报告中披露。

## 9. CLI 设计(统一入口 `modelwar`)

| 命令 | 模块 | 说明 |
|---|---|---|
| `modelwar gen --config models.yaml` | gen | 生成并冻结脚本(可 `--model <slug>` 单跑) |
| `modelwar run --config season.yaml` | runner | 整轮赛季 + 报告 |
| `modelwar match <input.json>` | engine | 单场对局(runner 与调试都走这条路径) |
| `modelwar replay <replay.jsonl>` | apps/cli → `replay` | 终端 ASCII 回放,单步/暂停;只读回放,**不依赖 engine** |
| `modelwar verify <replay.jsonl>` | apps/cli → engine + `replay` | 按 input.json 重新执行,逐 tick hash 比对(CI 调用) |
| `modelwar map-lint <maps/>` | apps/cli | 地图对称性与合法性校验 |

> 唯一 bin 在 `apps/cli`;`index.ts` 只做路由,各子命令 `await import()` 动态加载。库包不含 `bin`。

## 10. 非功能落地

### 10.1 性能(NFR-3)

预算分解:以算例 75 场 × 1500 tick ≈ 11 万 tick 计。单 tick 成本 = 4 次快照构建(单次拷贝进 VM) + 4 次串行 VM 执行 + 结算(≤ 数百对象);宿主↔VM 跳边界次数为 O(1)/tick,主要成本在快照拷贝与 VM 执行。若超标,优化优先级:**先测沙箱开销**(快照改按需字段拷贝)→ 再调对局子进程并发度。任何优化不得改变结算结果(stateHash 回归守护)。

### 10.2 可维护性(NFR-4)

- 数值与逻辑分离:`rulesets/` + `maps/`,改数值零代码改动。
- 包间仅文件交换(§3.2);gen 与 engine 无任何运行时耦合,架构审查以 import 图为准。

### 10.3 可信性(NFR-2)

复算链:`report.json` → `input.json`(存档引用 + 地图 + 种子 + 座位)→ `modelwar match` 重跑 → 逐 tick `stateHash` 与末行 `result` 与原 `replay.jsonl` 比对。全程不需要模型 API 与网络。

## 11. 需求追溯矩阵

| 需求 | 设计承接 |
|---|---|
| FR-1 引擎 | §4(全节),AC2 → §7.2 map-lint |
| FR-2 确定性与回放 | §4.6、§7.5、§9 verify |
| FR-3 脚本接口 | §4.2、§4.5、§6.1 |
| FR-4 沙箱与预算 | §5(全节) |
| FR-5 生成管线 | §2.1 离线侧、§6.2 |
| FR-6 可追溯存档 | §7.4 |
| FR-7 赛季调度 runner | §8.1、§8.4 |
| FR-8 排名与报告 | §8.2、§8.3 |
| FR-9 CLI 回放查看器 | §9、§7.5 schemaVersion |
| FR-10 规则文档 | §6.1、§7.1 |
| NFR-1 确定性 | §4.6、§5.3 |
| NFR-2 可信性 | §10.3 |
| NFR-3 性能 | §10.1 |
| NFR-4 可维护性 | §3.2、§10.2 |

## 12. 开放项(工程侧)

规则侧的开放项(数值终值、地图坐标、机制取舍)见 gdd《开放项》,此处不重复。

| # | 项 | 备注 |
|---|---|---|
| 2 | 预算参数终值(事件计数上限、API 上限、内存上限、`memoryTickCeiling`、软限、硬超时、exceptionTickLimit、脚本体积上限) | 用模型基准脚本标定(srs §4 第 2 条) |
| 3 | 座位轮换的效果验证 | 用基准脚本对局统计各座位胜率,验证偏置被摊平(§8.1) |
| 5 | 工具链可用性:**TypeScript 7.0 GA 时点**、oxlint-tsgolint 的性能(决定 `check:quick` < 5s 是否成立)、oxfmt 的 conformance | 任一不成立即退化为 oxlint 普通模式 + `tsc` + Prettier(§2.2.3) |
| 6 | 快照进出 VM 的拷贝粒度优化 | §10.1,先测后优化 |
| 7 | 回放体积与夜间全量扫描的存储/IO 方案 | 每 tick 全量状态的体量未评估 |
