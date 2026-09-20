# HLD:model-war v0 概要设计文档

| 项 | 值 |
|---|---|
| 文档版本 | v1.4(2026-09-20) |
| 状态 | 待评审 |
| v1.3 变更 | 沙箱选型定稿:quickjs-wasi(§5 重写);engine 允许 quickjs-wasi 依赖(§2.2.8);Node ≥ 22(§2.2.1);进程模型简化为进程内 4 VM 串行(§2.3);预算主判据改为指令计数 + API 计数(§5.3) |
| v1.4 变更 | 工程结构定稿:`apps/cli` + `packages/{schema,replay,engine,runner,gen}`(`tools` 包取消,§3.1/§3.2);`schema` 为唯一真源、文档与 validator 白名单为生成物(§2.2.5);沙箱 API 面下沉为 VM 内 runtime bundle(§4.5、§5.1);确定性原语归 `driver`、RNG 消费顺序入 rules-vN(§4.6);工具链增补 oxfmt / oxlint-tsgolint / fast-check / `check:fast` 分层 / 明确不做清单(§2.2) |
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
│  │  确定性 tick 循环 ── 快照分发 ──→ QuickJS VM × 4(进程内,串行执行)     │          │
│  │        ↑ 收集 intents(串行执行,天然按 playerIndex 有序)│           │          │
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
| 运行时 | Node.js ≥ 22 LTS(仅 LTS 版本,锁定到 `package.json#engines`) | quickjs-wasi 要求 Node ≥ 22;引擎除沙箱外零运行时依赖(见 §5、§2.2.8) |
| 模块体系 | ESM(`"type": "module"`) | Node 22 原生支持;避免 CJS/ESM 双轨 |

#### 2.2.2 工程结构与构建

| 项 | 选择 | 依据 |
|---|---|---|
| Monorepo | pnpm workspace(锁定 lockfile,CI 用 `--frozen-lockfile`) | 多包单仓,包间边界清晰(§3.2) |
| 拓扑 | `apps/cli` + `packages/{schema,replay,engine,runner,gen}` | CLI 是 app 不是库;回放格式独立成包(§3.1、§3.2) |
| 包间类型引用 | TypeScript project references(`tsc -b`)+ `paths`;**禁 `baseUrl`** | 增量编译;编译期强制依赖方向,防止 engine 误 import runner;`baseUrl` 已被 TypeScript 7 移除 |
| 共享编译基座 | 根 `tsconfig.base.json` | 各包继承,不另设配置包 |
| 构建(库包) | 纯 `tsc -b` 产物 | 库 + 子进程入口,无需打包器 |
| 构建(CLI) | `apps/cli` 用 esbuild 打成单文件 | 唯一 bin;子命令 `await import()` 动态加载便于分包 |
| 脚本预编译 | 冻结脚本以 `tsc` 单独编译为 script-mode JS,产物文本载入 VM;**编译器版本锁定并写入存档 meta** | 判据是"语义可预测 + 冻结后不再变",不是快(FR-6 内容 hash 归档);VM 内只 `evalCode(js, {filename})`,脚本 `import`/`require` 静态校验期即拒(§6.2) |
| CLI 入口 | 唯一 bin 在 `apps/cli`;`node:util` `parseArgs` 解析子命令,零第三方依赖 | §9 的六个子命令;依赖不落任何库包 |
| 任务编排 | 不引入 Turborepo 等编排层 | 每多一层配置 = agent 多一份上下文负载;pnpm + `tsc -b` 足够 |

#### 2.2.3 代码质量:oxc 统一工具链

格式化与静态检查统一采用 [oxc](https://oxc.rs/)(Rust 实现的 JS/TS 工具链),不引入 ESLint/Prettier:

| 项 | 工具 | 说明 |
|---|---|---|
| 格式化 | **oxfmt**(Beta;Prettier 兼容,内置 import 排序;默认 `printWidth: 100`) | 全仓库统一配置,`oxfmt --check` 进 CI;兜底:遇 conformance 缺口时切回 Prettier(一行配置改动) |
| Lint(语法+结构) | **oxlint**(ESLint 生态兼容,内置规则丰富) | 即时;替代 ESLint 成为主 linter |
| Lint(类型感知) | **oxlint-tsgolint**(`--type-aware`) | 底层是对 `typescript-go`(即 TypeScript 7)编译 + API shim 的 `tsgolint`,故**强制 TS 7.0+**;覆盖 typescript-eslint 常用规则集的绝大多数 |
| 类型检查 | **`tsc -b` 为唯一类型闸门** | `oxlint --type-check` 的官方 CLI 页仍标 *experimental*,仅并行试跑收集一致性,暂不设为闸门 |
| 确定性 Lint | 自定义规则 `no-float-literal`:engine 包内禁浮点字面量、禁白名单外的 `Math` 浮点函数 | FR-2 AC3 / NFR-1 的机械化保障;以 oxlint JS 插件(alpha)实现,若插件通道不稳则退化为基于 oxc-parser 的自建校验脚本,CI 强制 |
| 沙箱 API 白名单 | oxlint `no-restricted-globals` / `no-restricted-imports`(定时器与异步调度源 `setTimeout`/`setInterval`/`setImmediate`/`queueMicrotask` 明确在禁列,见 §6.2) | gen 静态校验参赛脚本时启用(§6.2);白名单符号表由 `schema` 生成(§2.2.5);运行时 QuickJS 内默认即无定时器,静态禁令为纵深防御 |
| 复杂度(日常) | oxlint 原生 `complexity` | **warn 级,不进 gate**(理由见下) |
| 复杂度(仓库扫描) | `scc --by-file --cognitive --hotspots` | 偶尔手动,非门禁 |
| 提交门禁(可选) | Husky + lint-staged:暂存区 oxfmt + oxlint + typecheck | 本仓库已有 setup-pre-commit 技能,按需启用;不作为 v0 验收项 |

**三条必须记住的约束**:

1. **类型感知 lint 需要已解析的类型信息**——monorepo 必须先 `tsc -b` 生成 `.d.ts`,`--type-aware` 才有正确输入。若 `engine` 改了而 `runner` 的 `.d.ts` 是旧的,**lint 结果是错的**。故 CI 静态阶段的执行顺序固定为 `tsc -b` → `oxlint --type-aware`(§2.2.7)。
2. **`oxlint-tsgolint` 版本号跟随 TypeScript 版本**(命名形如 `v7.0.2001` = TS 7.0 的 patch 1),不能单独顺手升 oxlint;二者须同时升级。
3. **`baseUrl` 已被 TypeScript 7 移除**,路径别名一律用 `paths`(TS 5+ 原生支持)。

**复杂度与耦合的分层原则**:复杂度是**诊断信号**,耦合是**硬约束**,不放同一层。dependency-cruiser 规则(§2.2.10)= error,硬门禁;复杂度阈值 = **warn,不进 gate**。理由:复杂度门禁会诱导 agent 抽函数——复杂度没有消失,只是从 A 函数搬到 B 函数,还多出为拆而拆的小模块,在 AI-first 仓库里是净损失。复杂度单独看价值低,真正该看的是 **hotspot = 复杂度 × 改动频率**;`scc --hotspots` 是该方法的平价近似。

#### 2.2.4 测试

| 项 | 选择 | 覆盖内容 |
|---|---|---|
| 测试框架 | Vitest(单进程内跑;沙箱测试用真实 quickjs-wasi VM 或 `StubRunner` 替身,见 §5) | 引擎结算单元测试、沙箱异常/超限裁决测试(FR-4) |
| 属性测试 | **fast-check** | 把 SRS 的 AC 直接写成可执行命题,见下表 |
| 确定性回放 | 固定种子 + 固定脚本 → 逐 tick `stateHash` 断言;`modelwar verify` 重算比对 | FR-2 AC1(重跑 10 次全一致)、NFR-1 AC |
| 地图校验测试 | map-lint 对 `maps/` 全量断言四重对称 | FR-1 AC2 |
| 规则文档验收 | `benchmarks/` 下人类手写 ≥2 个基准脚本,仅凭 `docs/rules-v1` 编写 | FR-10 AC1 / SRS 验收口径 2(人工流程,测试仅保证可运行) |
| 变异测试 | StrykerJS(`@stryker-mutator/core` + Vitest runner) | 度量测试有效性,见下 |

**属性测试(收益最高的一层)**:把 AC 直接写成可执行命题,替代硬编码重跑:

| 条款 | 属性 |
|---|---|
| FR-2 AC1 确定性 | `hashOf(run(s,p)) === hashOf(run(s,p))` |
| FR-2 AC2 序列化往返 | `deepEqual(parse(serialize(st)), st)` |
| FR-1 AC2 双方对等 | `deepEqual(mirror(m).p1, mirror(m).p2)` |
| FR-3 AC1 不可变性 | `step` 后原 `state` 深比较不变 |
| NFR-1 整数闭包 | `step` 输出全为整数(动态补静态类型之漏) |
| FR-7 AC1 种子派生 | `seedOf(combo,map,i)` 同名输入必同输出、组合间无碰撞 |
| FR-8 AC1 排名 | 名次分守恒、置换不变(纯函数,见 §8.2) |

**已知陷阱**:`JSON.stringify(-0) === "0"`,往返丢符号。全整数 + JSONL 的组合正好踩在这上面——属性测试会逮到,手写例子测试不会。

**禁止项**:

| 禁止 | 理由 |
|---|---|
| `vitest -u` 快照测试 | 测试红了 agent 会去**更新快照**而非查 bug——把测试改绿,不是把代码改对。回放一律用显式 `stateHash` |
| 覆盖率门禁 | agent 极擅长刷覆盖率。要看测试是否真钉住行为,用 Stryker 变异分数 |
| pre-commit 跑全量测试 | 慢钩子会被绕过,一旦被绕过就等于不存在。只跑 changed-files 的 format + typecheck |

**变异测试定位**:变异测试的耗时与测试套件规模成正比,且属于"事后体检"而非"合并前门禁"——因此**不进主流水线**,仅夜间定时(cron)或手动触发(`pnpm run mutation`)。范围优先覆盖 engine 结算管线(processor/driver 的结算顺序、边界条件)——这是确定性正确性的核心区,变异得分是"确定性测试没有退化成摆设断言"的量化证据(NFR-1 的佐证指标)。得分显著下降以 issue 跟进,不直接堵合并。

#### 2.2.5 数据与 schema(唯一真源)

| 项 | 选择 | 依据 |
|---|---|---|
| 真源 | **`schema` 包为唯一真源**:类型、常量表、数值 key 清单、JSON Schema | 消除"`docs/rules-v1` 与 `rulesets/v1.json` 双真源 + 人工同步"的漂移(§6.1、§7.1) |
| 文档生成 | 由 `schema` 生成 `docs/rules-v1/api.md` 的 API/常量表、由 `rulesets/v1.json` 生成 `rules.md` 的数值表;**散文部分人工编写** | 生成物进版本库,CI 跑 `git diff --exit-code`,未重新提交即报错(FR-10 AC2) |
| 数据格式校验 | JSON Schema(schema 包内定义,运行时用 `ajv`) | ruleset / 地图 / 存档 meta / result / 回放行的读入端强制校验;版本错配在装载期报错(FR-10 AC2) |
| hash | `node:crypto` SHA-256(标准库) | stateHash、地图 hash、存档完整性,零第三方依赖 |
| 随机数与 ID | **归 `driver` 所有**:整数 LCG + `IdGen`;RNG 消费顺序写入 rules-vN | 确定性原语不散落;消费顺序是回放断裂的经典成因(§4.6) |

#### 2.2.6 gen 管线专属依赖(唯一允许联网的包)

| 项 | 选择 | 依据 |
|---|---|---|
| prompt 模板 | `prompts/` 目录下的数据文件(不进 gen 代码) | 改提示词不必改代码;与 `docs/rules-v1` 同为 gen 的输入 |
| 模型 API 客户端 | OpenAI-compatible HTTP 客户端 + 各厂商 SDK 适配层 | 新模型接入只改配置(FR-5 AC3);凭证一律走环境变量,不落仓库 |
| 重试与限流 | 指数退避 + 每模型并发 1 | 生成阶段无性能压力,简单可靠 |
| 生成日志 | 结构化 JSON 落盘(进存档 meta) | FR-6 AC1 元数据完整性 |

#### 2.2.7 脚本分层与 CI 质量门禁

**脚本分层(本地/agent 编辑循环与 CI 分离)**:

| 脚本 | 内容 | 用途 |
|---|---|---|
| `check:fast` | `oxfmt --check` + `oxlint --type-aware` | agent 每轮编辑循环,目标 < 5s |
| `check` | `check:fast` + `tsc -b` + `vitest run` + `depcruise` + 生成物漂移检查 | CI 全量 |
| `test:props` | `vitest run --project properties` | 长时属性测试,单独跑 |
| `mutate` | `stryker run` | CI 夜跑 |
| `scan` | `scc --by-file --cognitive --hotspots` | 偶尔手动,非门禁 |
| pre-commit | 仅 changed-files 的 format + typecheck | — |

> 快慢分离是关键:agent 走 `check:fast`,CI 走 `check`,不让 agent 等全套。类型感知 lint 超过 ~10s,agent 就会"写完一起跑",反馈回路断掉。

CI(GitHub Actions 或等价物)分两条流水线。

**主流水线**(每次 PR 与主干 push,快速循环,全部通过才可合并):

| 阶段 | 内容 | 对应需求 |
|---|---|---|
| 1. 编译 | `tsc -b`(**必须先于类型感知 lint**,见 §2.2.3 约束 1) | — |
| 2. 静态 | oxlint(`--type-aware`,含 `no-float-literal`)、oxfmt --check、dependency-cruiser 依赖规则校验(§2.2.10)、**生成物漂移检查 `git diff --exit-code`** | FR-2 AC3、FR-10 AC2、NFR-4 AC2 |
| 3. 单测+属性 | Vitest 全量(结算、属性、沙箱裁决、地图校验) | FR-1/3/4 |
| 4. 集成 | 样例对局端到端跑通 + `modelwar verify` 重放一致性 + 重跑 10 次 hash 断言 | FR-2、NFR-1 |
| 5. 基准 | `benchmarks/` 双人类基准脚本对打一场,断言正常终局(不判策略胜负) | SRS 验收口径 2 的回归防线 |

**夜间流水线**(定时 cron 或手动触发,不阻塞 PR):

| 内容 | 说明 |
|---|---|
| StrykerJS 变异测试(engine 优先) | 变异得分报告落盘(`runs/mutation/` 或 artifacts);得分下降开 issue 跟进(§2.2.4) |
| 全量重放一致性扫描 | 对 `runs/` 存量对局批量 `modelwar verify`,守护"历史结果永远可复算"(NFR-2) |

CI 环境无网络、无模型 API、无凭证——保证 CI 上跑的永远是无头引擎与固定脚本,与生产对局同构。

#### 2.2.8 依赖策略(总原则)

| 包 | 运行时第三方依赖 | 理由 |
|---|---|---|
| engine | 仅允许 `quickjs-wasi` + **`node:crypto`**(收紧) | 沙箱即该依赖(见 §5);除 stateHash 用的 `node:crypto` 外**禁一切 `node:*`**,由 dependency-cruiser 强制——等于用 lint 证明"纯函数",比代码审查可靠 |
| runner / apps/cli | 受控少量(schema 校验器;CLI 零第三方依赖) | 只做调度与读文件,不参与结算 |
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
| 规则强制 | `.dependency-cruiser.cjs` 将 §3.2 全部规则写成可执行断言(含包级边界与 engine 内层方向),违规非零退出,挂在 CI 静态阶段 |
| 价值 | §3.2 的包边界——特别是"gen 永不进对局进程"(NFR-4 AC2)与"engine 纯函数"——从口头约定变为机器门禁;架构漂移在 PR 期即被拦下 |

> 依赖规则与 TS project references 双保险:前者管运行时 import,后者管编译期类型引用。

#### 2.2.11 明确不做

| 项 | 原因 |
|---|---|
| Rust(引擎 / SDK / 工具链) | 已拍定。NFR-3 算力预算下瓶颈不在 CPU;多语言仓库对 agent 是净负担。沙箱留 adapter 位即可 |
| 自研类型检查器 | oxc 官方已放弃,转而集成 tsgolint |
| `typescript-eslint` | 慢一个数量级,对 agent 编辑循环是致命的 |
| `isolated-vm` / node-gyp 类原生模块 | agent 环境装不上(需 Python + build-tools),CI 不稳 |
| Turborepo 等任务编排层 | 多一层配置 = agent 多一份上下文负载 |
| 覆盖率门禁 / 快照测试 | 会被 agent 刷,见 §2.2.4 禁止项 |
| 复杂度做成 error 门禁 | 见 §2.2.3 分层原则 |
| mod 系统 / 多存储后端 / 多进程(竞品 Screeps 形态) | v0 单机离线,扩展面由 `rulesets/` + `maps/` 承担(见 docs/competitors/screeps.md §8.2) |
| Docker(主路径) | gen 只是调 API,不需要容器隔离 |

### 2.3 进程与执行模型(核心决策)

| 层 | 单位 | 生命周期 | 隔离目的 |
|---|---|---|---|
| runner | 主进程 | 整轮赛季 | 调度、聚合;不执行任何参赛代码 |
| engine | **每场对局一个子进程** | 单场对局 | 单场崩溃不污染其余场次(FR-7 AC2);内存上限可在进程级施加 |
| sandbox | 对局进程内,每方一个 QuickJS VM(同进程、串行执行,见 §5) | 与对局同生命周期 | 脚本无网络/FS/宿主访问(FR-4 AC1);一方崩溃不影响他方(AC3) |

执行模型:引擎每 tick 按 playerIndex 0..3 顺序串行执行四方 `loop()`——快照构建 → VM#i 执行并收集 intents → 下一方。**无并发、无到达顺序问题**:确定性天然成立,无需归位逻辑(见 §4.6)。同进程串行是 quickjs-wasi 选型的直接推论:VM 是 WASM 实例,不可跨线程共享;且单 tick 四次串行执行的开销远小于进程/线程切换(见 §10.1)。

---

## 3. 系统分解

### 3.1 包结构与职责矩阵

```
model-war/
├─ apps/
│  └─ cli/                    # 唯一用户面与唯一 bin(modelwar)
│     └─ src/
│        ├─ index.ts          # 只做子命令路由
│        └─ commands/{gen,run,match,replay,verify,map-lint}.ts
├─ packages/
│  ├─ schema/                 # 唯一真源:类型 + 常量表 + 数值 key + JSON Schema
│  ├─ replay/                 # 回放格式 + 解析/序列化 + stateHash 原语(只依赖 schema)
│  ├─ engine/                 # 确定性内核 + 沙箱(driver/processor/world/snapshot/runner/sandbox-runtime/replay-writer/ruleset)
│  ├─ runner/                 # 赛季调度、进程池、排名与种子纯函数、报告、叙事战报
│  └─ gen/                    # 脚本生成管线(离线,永不进对局进程)
├─ benchmarks/               # 人类基准脚本(≥2):标定 ⚙ 预算 + CI 回归
├─ prompts/                  # gen 的 prompt 模板(数据文件)
├─ tsconfig.base.json         # 共享编译基座(project references)
├─ rulesets/                  # 规则数值数据文件(NFR-4 AC1:改数值不改代码)
│  └─ v1.json
├─ maps/                      # 地图 JSON(3 张 ⚙,四重旋转对称)
├─ docs/rules-v1/             # 规则文档 + API 文档(表格/数值表由 schema+ruleset 生成)
├─ archive/                   # 冻结脚本存档(FR-6)
├─ runs/<runId>/              # 对局产物:回放 JSONL、result、报告、叙事战报
└─ CLI 统一入口 `modelwar`(位于 apps/cli,见 §9)
```

| 模块 | 职责 | 对应需求 |
|---|---|---|
| engine:driver | **状态唯一所有者**:GameState、Random(整数 LCG)、IdGen、`apply()` 唯一写入口 | FR-2 AC3、NFR-1 |
| engine:processor | 结算管线(顺序为数据)+ `intents/*.ts` 的 `check()`/`run()` 注册表 | FR-1、FR-3 AC3 |
| engine:world | 状态模型、对象系统、只读查询 | FR-1 |
| engine:snapshot | 只读快照构建与冻结 | FR-3 AC1 |
| engine:runner | 执行器缝:`Runner` 接口 + `QuickJsRunner`(唯一真实实现)+ `StubRunner`(测试替身) | FR-4、§5.2 |
| engine:sandbox-runtime | 沙箱内 API 面(TS → IIFE bundle,版本 + hash 入 meta) | FR-4、§10.1 |
| engine:replay-writer | JSONL 写出(行格式取自 `replay` 包) | FR-2 AC2、gdd §8.3 |
| engine:ruleset-loader | 数值配置装载与版本比对 | NFR-4 AC1、FR-10 AC2 |
| runner:scheduler | 组合×地图×种子场次枚举与并发调度 | FR-7 |
| runner:ranker | 名次积分、并列处理、胜率矩阵、可选 Elo(**纯函数**) | FR-8 |
| runner:reporter | Markdown 报告 + JSON 原始数据 + 叙事战报 | FR-8 AC2、gdd §8.3 |
| gen:pipeline | prompt 组装(`prompts/`)→ 模型 API → 校验迭代 → 冻结 | FR-5 |
| gen:validator | 编译 + API 误用静态检查(白名单由 `schema` 生成) | FR-5 |
| gen:archiver | 元数据强制存档 | FR-6 |
| replay | 回放行格式、解析/序列化、stateHash 计算与比对原语 | FR-2 AC2、NFR-1 |
| cli:replay-view | 终端 ASCII 查看器(只读回放,不依赖 engine) | FR-9 |
| cli:replay-verify | 重放一致性断言(编排 engine 重执行,比对 JSONL) | NFR-1 |
| cli:map-lint | 地图四重旋转对称校验 | FR-1 AC2、gdd §11-3 |

### 3.2 依赖规则

```
                        schema
                    ↑   ↑   ↑   ↑
        ┌───────────┘   │   │   └──────────────┐
    replay ─────────────┤   │                  │
      ↑                 │   │                  │
   engine ←─────────────┘   │            sandbox-runtime
      ↑                     │
    runner / gen ───────────┘
      ↑
   apps/cli(唯一允许 import 全部包的层)

engine 内部(单向):world → driver → processor → replay-writer
                    world → snapshot → runner(Runner 缝 → sandbox-runtime)
```

- `schema` 包**只含类型与 JSON Schema,无运行时代码**——各包共享数据格式定义不违反 NFR-4 AC2(该条款约束的是运行时进程隔离:gen 永不在对局进程内)。
- `replay` 只依赖 `schema`;**库包一律不得含 `bin`**,唯一 bin 在 `apps/cli`。
- **`runner`、`apps/cli` 与报告/叙事代码不得 import `engine`**:runner 只以子进程 + 文件消费 engine;回放格式取自 `replay` 包(消除旧稿中"报告要解析回放、却又禁止 import engine"的矛盾)。
- `engine` 不 import `runner`/`gen`;`gen ⇎ engine`,且 `gen` 禁 import 任何 result 类型(FR-5 AC1)。
- `engine` 内除 `node:crypto` 外禁一切 `node:*`——"纯函数"性质由 lint 证明,不靠人工审查。
- `sandbox-runtime` 不得 import 宿主代码(只消费 `schema` 生成的常量/API 名表)。
- 上述全部规则由 dependency-cruiser 强制执行(§2.2.10),违规直接导致 CI 失败,不依赖人工审查。

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
  exceptionTicks: number;       // 累计异常 tick 数,达 100 ⚙(待标定)判负(gdd §3.4);随 JSONL 持久化,VM 中断/重建后由持久化值续算不清零
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
  remaining?: number;           // 仅资源点有(储量 5000 ⚙);基地无此字段
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
- intent 提交后由 `processor` 的 `check()` 统一校验(属主正确、参数在界、目标存在且合法),**无效 intent 丢弃并写入当 tick 事件流**(调试可观测),不触发异常判罚——异常判罚仅针对脚本抛出异常与超预算(gdd §3.4)。
- `attack` 合法性:目标须存在且为敌方单位(打任何兵种均合法,含农民);攻击者若无攻击能力(如农民),该条 intent 无效丢弃、不计异常。

### 4.3 tick 结算管线(每 tick 严格按此顺序)

```
0. dispatch   构建四方只读快照 → 按 playerIndex 0..3 串行执行各 VM 的 `loop()` 并收集 intents(预算/超时裁决在此层)
1. validate   intent 先按单位分组、每单位只留最后一个(静默丢弃,不计异常),分组后按 playerIndex 0..3 再按 unitId 排序逐条校验;无效者丢弃
2. movement   移动结算:
                a) 全部合法 move/moveTo 目标格计算
                b) 冲突裁决:目标格被多方竞争时,按 (tick + playerIndex) mod 4
                   轮转优先(gdd §3.3);平局不存在(轮转序为全序)
                c) 单格单单位;移动成功的单位占据目标格
3. combat     同 tick 所有 attack 同时结算:
                a) 先计算全部伤害(攻击者本 tick 死亡不影响其攻击生效,gdd §6.2)
                b) 统一扣血,归零者死亡移除(不参与后续阶段)
4. objectTick 按对象 id 升序:
                a) 占领:单轨累积 / 转轨重计 / 冻结保留(gdd §3.2)
                b) 采集:农民在己方资源点相邻格 harvest,+2 ⚙/tick,满 50 停
                c) 交付:transfer,carrying 清零入玩家池
                d) 生产:各队列 ticksLeft--,归零出兵;出兵格被**任意**单位占据则挂起等待(格子空出自动续出);若基地易主则取消该条队列并**全额退款**(新主人不继承旧队列)
5. evaluate   胜负判定(顺序即规范,见 gdd §3.1):
                a) 淘汰:无单位且无基地 → 出局,点位回归中立
                b) 全点位(16)归属单一玩家 → 胜
                c) 三方淘汰且一方尚存 → 捷径条款即胜(兜底)
                d) 淘汰方 `loop()` 不再执行(其 VM 暂停调用,状态保留以便重放取证)
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

- 快照 = GameState 的**深拷贝**,经单次 `__setSnapshot` 传入 VM;脚本持有的引用在下 tick 全部作废(每 tick 新快照)。**`Object.freeze` 仍由引擎侧在深拷贝上执行**(防宿主回调误写),VM 内不再依赖冻结语义——隔离靠拷贝边界,而非冻结。
- **API 面由沙箱内 runtime bundle 实现**(`engine/sandbox-runtime`,TS → IIFE,版本 + hash 写入回放 meta 与存档 meta),不再逐函数 `vm.newFunction` 注入(见 §5.1):
  1. 每 tick 只跨宿主边界两次——`__setSnapshot(snapshot)` 进、`__drainIntents()` 出;
  2. 查询函数(`getObjectsByType/getObjectById/getTick/getRange/findPath/getTerrainAt`)与 action 函数(`move/moveTo/attack/harvest/transfer/spawnUnit`,签名基准见 gdd §7,定稿于 rules-vN)全部在 VM 内运行,跨边界调用数从 O(API 调用数) 降到 O(1)/tick;
  3. 脚本可见全局 = VM 内 runtime 暴露的 API + 注入的常量表,**不注入任何宿主能力**。
- 运行时校验(FR-3 AC3):action 函数做"收集 + 界检查 + API 计数自增",不触碰引擎真实状态;查询函数在 VM 内快照副本上操作;intent 合法性由 `processor` 的 `check()` 统一裁决(§4.2、§4.3)——**同一份 `check()` 也用于 VM 内的即时 `ERR_*` 反馈**(dual validation),杜绝"沙箱一份、宿主一份"的逻辑漂移。

### 4.6 确定性保障(对应 NFR-1,一票否决项)

| 层 | 措施 |
|---|---|
| 运算 | 引擎代码禁浮点(oxlint 自定义规则 `no-float-literal` 禁 `number` 字面量小数点/`Math` 浮点函数白名单外使用,见 §2.2.3);资源、伤害、进度、领土分全整数;领土分公式 `⌊Σ造价/2⌋` 本身为整数运算 |
| 迭代顺序 | 一切多对象处理按 id 升序;玩家处理按 index 0..3;不存在 Set/Map 迭代参与结算 |
| 随机数 | 唯一 `Random`(整数 LCG)归 `driver` 所有;**消费顺序固定为 playerIndex 升序 → unitId 升序**,写入 rules-vN(变更即规则变更、需升版本) |
| 异步隔离 | 同进程串行执行,无并发、无到达顺序问题;**`vm.executePendingJobs()` 每 tick 后必须排空**(§5.1),Promise 回调不得跨 tick 残留;管线内无任何异步 |
| 移动裁决 | 轮转优先 `(tick + playerIndex) mod 4` 是全序,无平局 |
| 路径搜索 | A* 邻居展开顺序固定(八向按固定方向表),tie-break 按 id;无浮点启发式(用整数化的 Chebyshev ×2) |
| 预算裁决 | 见 §5.3:指令计数(QuickJS 中断计数) + API 调用计数为主判据,二者均可复现 |
| 验证 | CI 重放一致性:抽样正式对局 → 重新执行 → 与 JSONL 逐 tick stateHash 比对(NFR-1 AC) |
| 地图 | 地图 JSON 带内容 hash,回放头部记录;对称性由 map-lint 工具校验(§7.4) |

**stateHash**:对每 tick emit 的规范化状态(排序后的对象数组序列化)计算 SHA-256,写入 JSONL。哈希计算本身在回放写出路径上,不参与结算。

### 4.7 寻路(A*)

- `findPath` 暴露给脚本;`moveTo` 内部复用同一实现——**同一实现保证脚本查询结果与引擎实际移动一致**。
- CostMatrix 参数化(v1 固定:墙不可通行,其余等价);启发式用整数 Chebyshev(×2 与步长同量纲避免浮点)。
- 寻路调用量计入脚本 API 调用预算(§5.3),防止脚本用寻路做算力攻击。

---

## 5. sandbox 概要设计(选型已定:**quickjs-wasi**,https://github.com/vercel-labs/quickjs-wasi)

每方脚本运行在一个独立 QuickJS VM(WASM 实例)中,同对局进程、每 tick 按 playerIndex 串行执行。以下设计直接引用该库的已验证能力。

**边界说明**:本项目不为"未来换 VM"保留抽象层(那是投机抽象);下面 §5.0 的 `Runner` 缝**只为可测性**存在。

### 选型结论

v0 采用 `quickjs-wasi`(QuickJS-NG 编译为 WASM 的快照型 JS 运行时,MIT 协议,零第三方依赖;版本锁定到 `package.json`,升级需重跑重放一致性测试)。此前候选(QuickJS 嵌入 / WASM + fuel / isolated-vm)的比较结论:

- **隔离**:One VM = One WASM 实例,线性内存互不可见;包只做显式 I/O(调用方负责提供 wasm 字节),默认无 FS/网络——满足 FR-4 AC1,且比 worker_threads 的"去全局"做法审计面更小。
- **预算可复现**:`interruptHandler` 按字节码指令触发(文档称约每指令一次),可做指令计数主判据;`memoryLimit` 超限表现为可捕获的 JS 异常——二者都不依赖墙钟,满足 FR-4 AC2 / NFR-1。
- **崩溃语义**:WASM 执行无进程崩溃概念;死循环/深递归表现为中断异常或 WASM trap,VM 可按 §5.2 计数后继续使用或重建——FR-4 AC3 的"一方崩溃不影响他方"降级为"一方失控只计异常分,不污染引擎与他方 VM"。
- **记忆能力**:VM 常驻对局全程,模块级变量天然跨 tick 保留(FR-3);附带的 snapshot/restore 能力暂不用(状态以 GameState + JSONL 为准,不以 VM 快照为准)。
- **执行器缝(仅为可测性)**:`engine/runner` 定义 host 侧 `Runner` 接口(`init/tick/dispose`)+ `QuickJsRunner`(本库,唯一真实实现)+ `StubRunner`(测试替身:回放预置 intent、抛异常、触发 trap、超预算)。**在出现第二个真实 VM 实现之前,不新增任何抽象层**——这条缝不服务"未来换 VM",只让 §5.2 的四类裁决与结算管线可脱离 WASM 穷举测试。
- **API 面在 VM 内实现**:见 §4.5。runtime bundle 的**版本 + hash** 记入回放 meta 与存档 meta(FR-6 归档语义)。
- **代价**:Node ≥ 22(上游构建前置要求与 `using` 显式资源管理写法;运行时仅依赖标准 WebAssembly API,见 §2.2.1);库虽提供 `moduleLoader` 模块选项,本项目不配置——`import` 在静态校验期即拒绝(§6.2);深递归无 `JS_SetMaxStackSize`,表现为 WASM trap 而非可捕获异常(见 §5.2)。

### 5.1 隔离与注入

- 每方一个独立 `QuickJS.create({wasm, memoryLimit, interruptHandler, wasi})` 实例;四个 VM 同进程串行执行,不共享线性内存。`wasm` 字节由 `apps/cli`/runner 层在启动时读盘后传入 engine(engine 保持零 I/O)+ `WebAssembly.compile` 预编译,四 VM 复用同一 `WebAssembly.Module`(库文档推荐做法,实例化远快于重编译)。
- **WASI 覆盖**:`wasi` 工厂覆盖 `clock_time_get` 为固定值(冻结 `Date.now()`/`new Date()`;且 QuickJS 内部 xorshift64* PRNG 以该时钟值播种,同值即同 `Math.random()` 序列——确定性免费获得),`random_get` 覆盖为确定性填充(如全 `0x42`),`timezoneOffset` 固定为 0(UTC)。三者取值与 `quickjs-wasi` 版本号一并写入回放 meta 行(见 §7.5),可审计。
- 脚本可见全局 = **VM 内 runtime bundle 暴露的 API 面**(§4.5)+ `schema` 生成的常量表 + 纯函数子集;`fetch`/`fs`/`process` 等宿主能力一律不注入——隔离靠"不给"而非"拿掉",无遗漏面。**不加载任何 `.so` 扩展**(url/encoding/headers/crypto/structured-clone 均不启用),扩展攻击面为零。
- 载入次序:`evalCode(runtimeBundle)` 建 API 面 → `evalCode(scriptTs→js)` 载入选手脚本 → 每 tick `__setSnapshot(snapshot)` → `callFunction(loopFn)` → `__drainIntents()`。runtime bundle 与脚本同处一个全局环境,但 runtime 的内部计数器藏在闭包内。
- 载入方式:冻结脚本经 `tsc` 编译为 script-mode JS 文本后,`vm.evalCode(js, {filename})` 一次性载入;此后每 tick 以 `vm.callFunction(loopFn, ...)` 触发(引用在载入时取得并持有)。`moduleLoader` 不配置——`import` 语句在静态校验期即拒绝(§6.2)。
- 定时器与异步调度源在 QuickJS 内默认即不存在;**`vm.executePendingJobs()` 每 tick 执行 `loop()` 后必须调用排空**,Promise 回调不得跨 tick 残留——任何依赖回调时序的副作用视为不确定行为,脚本不得依赖(落入 rules-vN 确定性约束,FR-10 AC3)。
- 跨 tick 记忆只认模块级变量(VM 常驻);`Promise` 决议回调不保证跨 tick 可见(见上条)。

### 5.2 异常裁决(gdd §3.4 的实现化)

| 情形 | 处理 | 确定性 |
|---|---|---|
| `loop()` 抛异常(含内存超限转成的 JS 异常) | 本 tick 该方 intents 置空(单位原地待命);`exceptionTicks++`;达 100 ⚙(待标定)→ 判负出局(按淘汰规则,点位回归中立;判定顺序见 gdd §3.1) | ✅ 计数可复现 |
| 中断超限(`interruptHandler` 返回 true,指令数到顶) | 同上,计入 exceptionTicks;VM 中断后仍可用,无需重建 | ✅ |
| WASM trap(深递归栈溢出等,不可捕获) | 视同该 tick 异常计一次;重建该方 VM(从脚本源码重载,模块级记忆清零——视为失控的代价),`exceptionTicks` 由 JSONL 持久化值续算不清零;其余三方与引擎不受影响(FR-4 AC3) | ✅ 计数可复现 |
| 内存超限(`memoryLimit`,转 JS 异常) | 按第一行处理(可捕获,VM 继续可用);触发情况在报告中披露 | ✅ |

`exceptionTicks` 为对局状态的一部分,随每 tick JSONL 持久化(`players` 字段);VM 中断或重建后由持久化值续算,**不清零**(否则反复失控可逃逸 100-tick 淘汰)。

### 5.3 计算预算(双计数主判据 + 墙钟硬超时兜底)

**形态:指令计数 + API 调用计数双主判据(均可复现),墙钟硬超时只做兜底。** 以下数值全部为 ⚙,用 ≥2 个人类基准脚本标定(SRS 验收口径 2)。

| 机制 | 实现 | 数值 ⚙ | 判罚 | 是否影响确定性 |
|---|---|---|---|---|
| 指令计数 | QuickJS `interruptHandler` 回调计数(约每字节码指令一次,回调须保持轻量);到顶返回 true 中断本 tick | 上限 10000 ⚙/tick(待标定) | 超限 → 本 tick 该方 intents 丢弃 + `exceptionTicks++`(与异常同轨) | ✅ 可复现(纯计数) |
| API 调用计数 | 宿主注入的 action/查询函数内自增计数器;到顶后续调用直接抛 JS 异常(脚本可 try/catch,但 intent 已无意义) | 上限 10000 ⚙/tick(待标定,与指令计数独立) | 同上 | ✅ 可复现(纯计数) |
| 墙钟软限 | 单 tick `loop()` 执行时长 | 100 ms ⚙/tick(待标定) | 同上,计入 exceptionTicks;触发需在对局记录中标记,供报告披露 | ⚠ 有噪声——仅作冗余保险,正常情况下先触发任一计数上限 |
| 墙钟硬超时 | 防死循环:中断逃逸(如宿主回调卡死)的最后防线 | 10 s ⚙/tick | 销毁并重建该方 VM → 视同 trap(§5.2) | 该方出局裁决可复现 |

设计理由:双计数互相覆盖对方的盲区——纯计算型死循环由指令计数抓住,API 轰炸(如每 tick 数万次 `findPath`)由调用计数抓住;墙钟因机器负载有噪声,只做兜底且不单独决定胜负。

---

## 6. 脚本契约与静态校验

### 6.1 契约载体

`docs/rules-v1/` 两份文档:`rules.md`(规则)与 `api.md`(API 签名与语义),自包含(FR-10 AC1:人类仅凭文档可写出过审脚本)。二者同时是 gen 管线的 prompt 输入;其**表格部分(API/常量/数值)由 `schema` 包与 `rulesets/v1.json` 生成**,validator 的白名单同理——规则真源是 `schema` + `rulesets/v1.json`,文档是生成物(CI `git diff --exit-code` 保证不漂移,§2.2.5)。

### 6.2 静态校验规则(gen:validator)

| 类别 | 规则 |
|---|---|
| 编译 | `tsc --noEmit` 通过;导出 `loop(): void` 入口 |
| 全局白名单 | oxlint `no-restricted-globals`:除注入 API 与 QuickJS 内置纯函数子集(`Math`、`JSON`、`Number`、`String`、`Array`、`Map`/`Set`、`Object` 等)外全禁;白名单符号表由 `schema` 生成,与沙箱 runtime 暴露的 API 面同源;`Date` 视为确定性污染源(见下行),不视为可用纯函数 |
| 模块系统 | 禁 `import`/`require`/动态 `eval`(单文件自包含) |
| 确定性污染源 | 禁 `Date`、`Math.random`、其他一切非确定源(运行时 WASI 时钟已冻结,本行为纵深防御:静态拒绝 > 运行时冻结) |
| API 误用 | 类型层面由 `schema` 包的公开 `.d.ts` 约束(结构化意图类型) |

校验失败 → 仅错误信息回喂模型(≤5 轮,FR-5 AC1);代码审查条款确保不存在对战结果回传路径。

---

## 7. 数据设计

### 7.1 ruleset 数据文件(`rulesets/v1.json`)

承载 gdd 全部 ⚙ 数值:兵种表(造价/HP/伤害/射程/速度/生产耗时)、经济参数(采集率/携带上限/初始资金)、占领参数(占领阈值)、tick 上限、异常判负阈值、预算参数。引擎读它,`docs/rules-v1` 由人工与之同步,**版本号必须一致**(runner 启动时比对,错配拒跑,FR-10 AC2)。

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
- **快照性能备注**:快照进出 VM 经 `__setSnapshot` 单次结构化拷贝(见 §4.5);拷贝粒度优化见 §10.1 与开放项 §12.2-4。
- **map-lint 工具**强制校验:四重旋转对称(terrain 与 sites 绕中心 90° 旋转自洽)、所有点位不重叠且不在墙上、地图数 ≥3 ⚙ 且风格覆盖(开阔/廊道/要塞)。校验不过的地图不进地图池。

### 7.3 种子的用途(**【HLD 提案】**,填补上游空白)

上游文档定义了"K 种子"场次维度,但 v0 规则集本身无随机过程(地图固定、初始固定)——种子若不落地,多种子场次将完全重复。**提案:种子驱动对称地图变体**——地图 JSON 的 `variantSlots` 声明可变墙体槽位(成组四重对称),引擎以种子做确定性填充(整数 LCG)。效果:同一地图模板在不同种子下产生微扰变体,保持四重对称与点位布局不变。此提案需在规则定稿时回写 gdd §11 开放项 3。范围限定:变体只做装饰性微扰(墙体槽位填充);K 种子不增加风格多样性计数,gdd §4.1"3 张风格迥异地图"要求不变。

### 7.4 冻结脚本存档(`archive/<modelSlug>/<runId>/`)

```
script.ts      # 冻结源码,一字不改
meta.json      # 模型名、模型版本/快照标识、生成日期、协议迭代轮数、
               # 完整 prompt(逐轮)、生成日志、ruleset 版本、校验结果、
               # 脚本编译器(tsc)版本、sandbox-runtime hash
```

- runner 启动即校验元数据完整性,缺档**报错退出**(FR-6 AC2,不跳过)。
- 对局输入物化:`runs/<runId>/matches/<combo>-<map>-<seed>/` 内含 `input.json`(4 × 存档路径 + 地图 + 种子 + ruleset 版本 + 各文件 hash)与产物——任意一场可凭 input.json 复算(FR-7 AC3、NFR-2)。

### 7.5 回放 JSONL(`matches/<...>/replay.jsonl`)

```
第 1 行   {"type":"meta", ruleset, quickjsWasiVersion, sandboxRuntimeHash, wasiClock, wasiRandomFill, timezoneOffset, mapHash, seed, players:[{model, archiveRef}], ...}
第 n 行   {"type":"tick", "tick":n, players, units, sites, productions,
           events:[...], "stateHash":"..."}
末 行    {"type":"result", rankings, reason, territoryScores}
```

- 每 tick 记录足以绘制完整画面的状态:点位归属、占领进度条、单位位置血量携带、玩家资源(gdd §8.3 可渲染要求)。
- **events 事件流**(叙事与战报的统一来源):`first-contact`、`site-captured`、`unit-destroyed`(聚合)、`player-eliminated`、`economy-dead`(无农民单位且 resources < 农民造价,v1 = 50 ⚙,取值自 ruleset)、`budget-exceeded`、`exception`、`victory`。叙事战报生成器只消费 events,不重新解析状态。

---

## 8. runner 与排名概要设计

### 8.1 场次调度

- 输入:`season.yaml`(参赛脚本存档目录列表、地图池、种子数 K ⚙=5、并发度、ruleset 版本)。
- 枚举:全部 4 人组合 × M 地图 × K 种子,种子值 = 确定性函数(组合、地图、序号)——**全场次对全体参赛者一致,无人可选**(FR-7 AC1)。
- 并发:进程池语义的对局子进程池,并发度默认 `min(cpus, 8)` ⚙;单场互不干扰。

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
| `modelwar run --config season.yaml` | runner | 整轮赛季 + 报告 |
| `modelwar match <input.json>` | engine | 单场对局(调试用,可脱离 runner 独立执行) |
| `modelwar replay <replay.jsonl>` | apps/cli → `replay` | 终端 ASCII 回放,单步/暂停(FR-9);只读回放,**不依赖 engine** |
| `modelwar verify <replay.jsonl>` | apps/cli → engine + `replay` | 按 input.json 重新执行,逐 tick hash 比对(NFR-1,CI 调用) |
| `modelwar map-lint <maps/>` | apps/cli | 地图对称性与合法性校验 |

> 唯一 bin 在 `apps/cli`;`index.ts` 只做路由,各子命令 `await import()` 动态加载(§2.2.2)。库包不含 `bin`(§3.2)。

---

## 10. 非功能设计落地

### 10.1 性能(NFR-3:吞吐量口径,见 srs)

预算分解:以算例 75 场(N=5/M=3/K=5)× 1500 tick ≈ 11 万 tick 计。单 tick 成本 = 4 快照构建(`__setSnapshot` 单次拷贝进 VM) + 4 次串行 VM 执行 + 结算(≤ 数百对象)。宿主↔VM 跳边界次数为 O(1)/tick(§4.5);主要成本在快照拷贝。若超标优先优化快照粒度(按需字段拷贝),再调对局子进程并发度。优化优先级:**先测沙箱开销**(FSR 风险预案:快照改结构化共享/按需拷贝)→ 再调对局进程并发度。任何优化不得改变结算结果(stateHash 回归测试守护)。

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
| FR-7 赛季调度 runner | §8.1、§8.4 |
| FR-8 排名与报告 | §8.2、§8.3 |
| FR-9 CLI 回放查看器 | §9 |
| FR-10 规则文档 | §6.1、§7.1(版本一致性) |
| NFR-1 确定性 | §4.6(最高优先级,一票否决) |
| NFR-2 可信性 | §10.3 |
| NFR-3 性能 | §10.1 |
| NFR-4 可维护性 | §3.2、§10.2 |

设计待定项覆盖情况(SRS §5 现为指针,不列明细):计算预算 → §5.3(双计数主判据,数值 ⚙ 待标定);异常/超时判负细则 → §5.2(阈值 ⚙ 待标定);规则集数值 → rulesets/v1.json(基准脚本验证);并列积分 → §8.2(提案);平局处理 → 已定稿(领土分 + 并列)。

---

## 12. 设计决策与开放项

### 12.1 本文档新增决策(评审后回写上游)

| # | 决策 | 状态 |
|---|---|---|
| H1 | 沙箱选型 quickjs-wasi + 预算双计数主判据 + 墙钟兜底,超限走 exceptionTicks 同轨(§5) | 已定稿,已回写 gdd §11-1 |
| H2 | 种子 = 对称地图变体生成(§7.3,装饰性微扰,不计风格多样性) | 已接受,已回写 gdd §11-3 |
| H3 | 并列名次均分名次分(§8.2) | 待评审,回写 gdd §11-5 |
| H4 | 每 tick 一条 JSONL 行 + 事件流作为叙事唯一来源(§7.5) | 设计定稿 |
| H5 | 每场对局独立子进程 + 进程池(§2.3) | 设计定稿 |
| H6 | 包拓扑:`apps/cli` + `packages/{schema,replay,engine,runner,gen}`;`tools` 包取消;库包不含 `bin`(§3.1) | 设计定稿 |
| H7 | `schema` 为唯一真源,`docs/rules-v1` 表格与 validator 白名单为生成物,CI 跑 `git diff --exit-code`(§2.2.5) | 设计定稿 |
| H8 | 沙箱 API 面下沉为 VM 内 runtime bundle(每 tick 两次跳宿主边界),版本 + hash 入 meta(§4.5、§5.1) | 待评审(需实测收益) |
| H9 | `engine/runner` 测试缝(`Runner` + `QuickJsRunner` + `StubRunner`;禁第二条真实实现)(§5) | 设计定稿 |
| H10 | 确定性原语(Random/IdGen)归 `driver`;RNG 消费顺序写入 rules-vN(§2.2.5、§4.6) | 设计定稿 |
| H11 | 工具链:oxfmt + oxlint-tsgolint(须在 `tsc -b` 后跑)+ fast-check 属性测试 + `check:fast`/`check` 分层 + 明确不做清单(§2.2) | 待评审 |

### 12.2 留给详细设计 / v0 验证的开放项

| # | 项 | 备注 |
|---|---|---|
| 1 | 预算具体数值(指令计数上限、API 调用上限、软/硬时限、100 异常 tick 阈值) | 用人类基准脚本标定(SRS 验收口径 2) |
| 2 | 地图 3 张具体坐标与 variantSlots 设计 | map-lint 校验 + 策略多样性测试(FSR R2/R3) |
| 3 | ruleset v1 全部 ⚙ 数值终值 | gdd §11-4 |
| 4 | 快照进出 VM 的拷贝粒度优化(字段裁剪/按需拷贝) | §10.1,先测后优化 |
| 5 | H8 的实测:VM 内 runtime bundle 的跨边界收益是否显著 | 若不显著则回退为逐函数注入(§10.1,先测后优化) |

---

## 13. 里程碑映射(FSR §6)

| 里程碑 | 本文档承接章节 |
|---|---|
| M1 规则 v1 | §2.2.5(schema 真源与生成物)、§6.1、§7.1、§7.2、§7.3(map-lint 先行) |
| M2 引擎 | §4、§5(核心工作量;driver、processor 注册表、runtime bundle、Runner 缝) |
| M3 生成管线 | §2.2.6(`prompts/`)、§6.2、§7.4 |
| M4 runner | §8、§9、§10.3 |
