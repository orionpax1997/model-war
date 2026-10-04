# HLD:model-war v0 概要设计文档

| 项 | 值 |
|---|---|
| 版本 | v2.3 |
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
| 对称公平 | 地图由 map-lint 断言四重旋转对称(§7.2);初始条件由地图 + ruleset 推导,引擎不硬编码;座位在赛季内轮换(§8.1) |
| 规则面最小 | 全部规则数值进 `rulesets/*.json`;引擎只实现 gdd 定义的通用机制 |
| 戏剧性优先 | 回放 JSONL 与事件流自第一天按"可渲染、可叙事"设计 |
| 排名降级 | 报告双轨:`report.md`(人类可读)+ `report.json`(机器可复算),二者同级输出。叙事战报是第三样东西,只给人看,不作判定依据(CONTEXT.md 三者分立) |

## 2. 总体架构

### 2.1 架构总图

```
┌─ 离线:脚本生成管线(gen)─────────────────────────────────────────┐
│  docs/rules-vN + docs/rules-vN/api.md + models.yaml + prompts/    │
│        ↓ prompt 组装 → 模型 API(各厂商)→ 脚本 + 模型名           │
│  静态校验(tsc 编译 + API 误用 lint)                              │
│        │ 失败:仅回喂校验错误,≤5 轮                               │
│        ↓ 通过                                                     │
│  冻结脚本:archive/<model>/<runId>/{script.ts, script.js, meta.json}│
└───────────────────────────────────────────────────────────────────┘
                          │ 只通过文件交换(srs NFR-4 AC2)
                          ↓
┌─ 在线:对战与排名(runner)────────────────────────────────────────┐
│  modelwar run --config season.yaml                                │
│    ↓ 对局调度:C(4,N) 组合 × M 地图 × K 种子 + 座位轮换(srs FR-7)│
│    ↓ 每场对局 = 独立子进程(崩溃隔离)                             │
│  ┌─ 对局进程(engine)───────────────────────────────────┐         │
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
| 运行时 | Node.js ≥ 22.18(锁 `package.json#engines`) | **下限来自我们自己的代码特征,不是沙箱库的前置要求**:ESM、资源管理与稳定版解析 API,以及工具包以源码形态执行(靠 Node 的类型擦除跑 `.ts`,该能力自 22.18 起默认开启)。`quickjs-wasi@3.6.2` 既不声明 `engines` 字段也不要求任何运行标志(实测其 `package.json` 无 `engines`),此前把下限归因于它是错的。引擎除沙箱外零运行时依赖 |
| 模块体系 | ESM(`"type": "module"`) | 避免 CJS/ESM 双轨 |

#### 2.2.2 工程结构与构建

| 项 | 选择 | 依据 |
|---|---|---|
| Monorepo | pnpm workspace(锁 lockfile,CI 用 `--frozen-lockfile`) | 多包单仓,包间边界清晰(§3.2) |
| 拓扑 | `apps/cli` + `packages/{schema,replay,engine,runner,gen,tools}`(拓扑图与新增 `tools` 的理由见 §3.1) | CLI 是 app 不是库;回放格式独立成包;仓库自用工具独立成包 |
| 包间类型引用 | workspace `exports` 的 `types` 条件 + TypeScript project references(`tsc -b`);**既不用 `paths`,也禁用 `baseUrl`** | 编译期强制依赖方向;`baseUrl` 已被 TypeScript 7 移除(TS5102,连写都写不进去) |
| 共享编译基座 | 根 `tsconfig.base.json` | 各包继承,不另设配置包;参赛脚本那份刻意不继承它,理由见 §6.2 |
| 构建(库包) | 纯 `tsc -b` 产物;两个例外:`tools` 只产 `.d.ts`(`emitDeclarationOnly`,运行面是源码,§3.1)、VM 内 runtime bundle(打包方式属实现期选择,形态见 §4.5) | 库 + 子进程入口,无需打包器 |
| 构建(CLI) | `apps/cli` 用 esbuild 打成单文件 | 唯一 bin;子命令 `await import()` 动态加载便于分包 |
| 脚本预编译 | 冻结脚本由 gen 包用 `tsc` 编译为 script-mode JS;编译器版本锁定并写入存档 meta | 判据是"语义可预测 + 冻结后不再变",不是快 |
| CLI 入口 | 唯一 bin 在 `apps/cli`;`node:util` `parseArgs` 解析子命令,零第三方依赖 | §9 的六个子命令 |

**包间类型引用为什么不用 `paths`(实测;完整矩阵在 `docs/adr/0002-toolchain.md`)**:把 `paths` 直指各包源码、且没有对应的 project reference 时,TypeScript 7 会把对方源码并进引用方的 program,两条错误同时报——`TS6059`(`rootDir` 越界)与 `TS6307`(文件不在引用方 tsconfig 的文件列表内);产物还会被发到错误的位置。退一步只跑 `tsc -p packages/engine`(依赖包未构建)则是 `TS2307`:TypeScript 7 不对裸包名做“产物缺失就回退到源码”的兜底。有了 project reference,`paths` 虽然不报错,但它与 `exports` 同时解析同一模块,剩下的作用只是“给同一个模块多一条解析路径”——而那正是 pnpm 软链布局下类型声明不可移植(TS2883 一类)的成因。故 `paths` 全仓库一处不写。**`tsc -b`(从仓库根)是唯一的类型闸门命令**,`tsc -b --noEmit` 不行:被引用项目不得禁用 emit(TS6310),且构建树已是最新时它会静默返回 0,别据此以为它能用。「禁用 `baseUrl`」的原结论不变,理由更硬了:TypeScript 7 已将其移除(TS5102)。

**脚本入口契约(定稿)**:参赛脚本是**单文件 script-mode TS**,顶层声明 `function loop(): void` 作为入口,**不写 `export` / `import`**(validator 对二者直接报错回喂,§6.2)。理由:VM 内以 `evalCode` 载入脚本模式 JS、`moduleLoader` 不配置,带 `export` / `import` 的产物在载入期直接取 `SyntaxError`,连执行都进不去。是否 `export` 是编译期即可判定的事实,不进入运行时容错。**实测(quickjs-wasi 3.6.2 / Node v24.15.0 / Linux x64 / 2026-09-24 主测 + 2026-10-01 复核,探针不落库)**:无 `export` 的 script-mode 产物经 `evalCode` 载入不报错,`loop` 的 `typeof` 是 `function`,`callFunction` 调得动且副作用可观察(tick 计数 +1);同一 VM 里 `export const a = 1` 取 `SyntaxError: unsupported keyword: export`,静态 `import x from "std"` 取 `SyntaxError`,且语法错误后 VM 仍可续用。三种形态的判别全部发生在载入期,不需要运行时容错。

#### 2.2.3 代码质量:oxc 统一工具链

格式化与静态检查统一采用 [oxc](https://oxc.rs/),不引入 ESLint/Prettier:

| 项 | 工具 | 说明 |
|---|---|---|
| 格式化 | **oxfmt** | 全仓库统一配置,`oxfmt --check` 进 CI |
| Lint(语法+结构) | **oxlint** | 替代 ESLint 成为主 linter |
| Lint(类型感知) | **oxlint-tsgolint**(`--type-aware`) | 底层是 `tsgolint`。**已 stable,是真检查**:oxlint 1.86.0 的 `--help` 对它的描述就是“Enable rules that require type information”,不带 experimental 标记;它进 `check:types`,不再并行试跑(§12 #5 已按子项收口) |
| 类型检查 | **`tsc -b` 为唯一类型闸门** | `oxlint --type-check`(连带 TS 编译器诊断)在 1.86.0 的 `--help` 里仍标 *experimental*,不设为闸门;上一版把 `--type-aware` 也归为“仅并行试跑”,已失效 |
| 确定性 Lint | **自建校验器 `packages/tools/src/rules/no-float.ts`**,建立在 `oxc-parser` 之上:engine 包运行时源码禁浮点字面量(指数形式即便求值为整数也判违规),`Math` 成员只认白名单 | FR-2 AC3 / NFR-1 的机械化保障。**刻意不建在 oxlint 的 JS 插件通道上**:该通道上游标为 alpha、不在 semver 承诺内,而这是一票否决级的约束(ADR-0002)。作用域是“目录薄壳”决定的,纯函数层不碰文件系统 |
| 沙箱 API 白名单 | **分两层,两侧都不交给 oxlint**:`__*` 前缀与确定性污染源等**名字级别的禁令**由 `packages/tools` 的静态校验器承担;**「白名单反转」由编译器的名字解析承担**(脚本在一个 `lib` 只含现代 ECMAScript、不含 DOM、不含任何 `@types`、只额外引入脚本 API 类型声明的环境里编译,「找不到这个名字」即反转)。`oxlint` 的 `no-restricted-globals` 两条都表达不了 | 该规则只接受精确名字列表(实测 oxlint 1.86.0 的 `configuration_schema.json`:`globals` 项的形状是 `string` 或 `{ name, message }`,没有任何模式字段),既表达不了 `__*` 前缀禁令,也没有「白名单反转」的对应物(承载方式见 §6.2)。**反转之所以不建在 `oxc-parser` 的自建检查上**——实测该解析器不暴露任何作用域信息(§6.2 实测表,带版本组合),而白名单反转的本质是自由变量判定;自建分析器的失败模式是漏掉任何一处声明位置、也就是误伤一份合规脚本,而误报在五轮迭代预算里不对称地致命(同一条谨慎此前已为「不建在 oxlint 的 alpha 插件通道上」付过一次,ADR-0002)。白名单符号表由 `schema` 生成;运行时 QuickJS 内默认无定时器,静态禁令为纵深防御 |
| 复杂度 | oxlint `complexity`(warn,不进 gate);热点扫描 `scc --by-file --cognitive --hotspots`(手动) | 复杂度是诊断信号,耦合是硬约束,不放同一层 |

**三条必须记住的约束**:

1. **类型感知 lint 需要已解析的类型信息**:monorepo 必须先 `tsc -b` 生成 `.d.ts`,`--type-aware` 才有正确输入。CI 静态阶段顺序固定为 `tsc -b` → `oxlint --type-aware`。
2. **`oxlint-tsgolint` 的版本号就是它所配套的 TypeScript 版本**:形状是 `7.0.<tsPatch><golintPatch>`,**末三位是 tsgolint 自己的 patch,前面剩下的整个 patch 段是 TypeScript 的 patch**——`oxlint-tsgolint@7.0.2003` ⇄ `typescript@7.0.2`。TypeScript 的 patch 一变,前面那段跟着变,末三位归零。**这条耦合没有任何工具会替你检查**:oxlint 的 peer 依赖只保证 tsgolint 的下界,不比对 TypeScript 版本,错位是静默的(类型感知 lint 不会报错、不会警告,只是不再基于正确的类型信息运行)。因此由仓库自己的断言脚本 `packages/tools/src/toolchain-coupling.ts` 承担(根脚本 `coupling`,在 `check:quick` 内),逐项断言:两项都精确锁版、版本号能解出配套版本、配套版本等于 manifest 里写的 TypeScript、`node_modules` 里实际装着的与 manifest 一致。配套为 0,错位为 1;反例不靠改 `package.json`,直接传两个假版本号。
3. **包间类型引用一律走 workspace `exports` + project references**;`paths` 与 `baseUrl` 一处不写(依据与实测错误码见 §2.2.2)。

**复杂度与耦合的分层原则**:dependency-cruiser 规则(§3.2)= error 硬门禁;复杂度阈值 = warn 不进 gate。理由:复杂度门禁会诱导 agent 抽函数——复杂度没有消失,只是从 A 搬到 B,还多出为拆而拆的小模块。真正该看的是 hotspot = 复杂度 × 改动频率,`scc --hotspots` 是平价近似。

#### 2.2.4 测试

| 项 | 选择 | 覆盖内容 |
|---|---|---|
| 测试框架 | Vitest(沙箱测试用真实 quickjs-wasi VM 或 `StubRunner` 替身) | 引擎结算单元测试、沙箱异常/超限裁决测试(FR-4) |
| 属性测试 | **fast-check** | 把 srs 的 AC 写成可执行命题,见下表 |
| 确定性回放 | 固定种子 + 固定脚本 → 逐 tick `stateHash` 断言;`modelwar verify` 重算比对 | FR-2 AC1、NFR-1 AC |
| 地图校验 | `modelwar map-lint <maps/>` 对地图池跑单图与池两层断言(清单见 §7.2) | FR-1 AC2 |
| 规则文档验收 | `benchmarks/` 下模型生成 ≥2 个基准脚本,仅凭 `docs/rules-v1` 编写 | FR-10 AC1、srs §4 第 2 条(模型 dry-run 流程,测试仅保证可运行) |
| 变异测试 | StrykerJS(度量测试有效性);**尚未安装**,配置随引擎结算管线落地(ADR-0002:先装一个没有配置、也没有被任何脚本调用的 Stryker,只会让人以为这条门禁存在) | 夜跑体检 |

属性测试(收益最高的一层),把 AC 直接写成命题:

| 条款 | 属性 |
|---|---|
| FR-2 AC1 确定性 | `hashOf(run(s,p)) === hashOf(run(s,p))` |
| FR-2 AC2 序列化往返 | `deepEqual(parse(serialize(st)), st)` |
| FR-1 AC2 四方对等 | `deepEqual(rotate90(m).seats[i], m.seats[(i+1)%4])` |
| FR-3 AC1 不可变性 | `step` 后原 `state` 深比较不变 |
| NFR-1 整数闭包 | `step` 输出全为整数(动态补静态类型之漏) |
| FR-7 AC1 种子与座位派生 | 同名输入必同输出、组合间无碰撞;各 seat 的对局数之差 ≤ 1(M×K 为 4 的倍数时严格相等) |
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
| 真源 | **`schema` 包 = 五类数据形状(规则集 / 地图 / 存档 meta / result / 回放行)的 TS 类型与 JSON Schema + 常量表 + 参数 key 清单;`rulesets/*.json` = 全部参数取值** | 消除"规则文档与数值文件双真源 + 人工同步"的漂移。每类形状的**家只有这一个**,别的包不再重复声明(§3.1、§7.5) |
| JSON Schema 的形态 | **导出的数据对象(`.ts` 里 `export const X_JSON_SCHEMA`),不是独立 `.json` 文件** | ajv 接受 JS 对象,不需要文件;`description` 是写给模型看的说明,写在源码里自然,顺带避开 `resolveJsonModule` 与本仓库编译配置的组合风险(ADR-0003) |
| 文档生成 | 由 `schema` 生成 `docs/rules-v1/api.md` 的 API/常量表,由 `rulesets/v1.json` 生成 `rules.md` 的数值表;**散文部分人工编写** | 生成物进版本库,漂移检查(`check:drift`,§2.2.7)逐件判定「重生成后无差异 + 生成物在版本库里」,未重新生成或未提交即报错(FR-10 AC1:文档里的数值表与 API 表必须真的是当前规则集的) |
| 数据格式校验 | JSON Schema 归真源包(交付**数据**),**校验器只在 `apps/cli` 一处**(唯一一份 `ajv` 实例,导出 `validateMap` / `validateRuleset` 两个纯函数) | 真源包受 §3.2 的包依赖规则约束、不能依赖 ajv;CLI 是唯一用户面,外部数据(文件 / 参数 / 子进程输出)全从它进来,一处校验覆盖全部入口(§2.2.8)。诊断分两层:机器层透出 ajv 原始条目,面向模型层渲染成短句并**对同类错误合并成一行** |
| hash | `node:crypto` SHA-256(标准库) | stateHash、地图 hash、存档完整性校验,零第三方依赖 |
| 随机数与 ID | **归 `driver` 所有**:整数 LCG + `IdGen`;RNG 消费顺序写入 rules-vN | 确定性原语不散落;消费顺序是回放断裂的经典成因(§4.6) |

**「读入端强制校验」的覆盖面当前只有两类,是刻意的不完整,不是半成品**。本仓现在真正被校验的只有**规则集与地图**;存档 meta / result / 回放行三类的**家已经定在真源包**(见上表第一行),但**字段尚未回填**,因此真源包里只有它们的占位清单(标记 + 回填触发条件),没有 schema。另有一件要说清:规则集与地图两类的**校验通路已交付**(唯一一份 ajv 校验器、两个纯函数、两层诊断、装载期版本与派生量断言),但**接进子命令装载路径的只有地图那一半**——`modelwar map-lint <maps/>` 已经跑通「读文件 → 校验 → 带定位诊断拒跑 → 非零退出」这条通路;规则集那一侧的调用点随 runner 落地。因此 **FR-10 AC2 的「错配拒跑」与「读入端强制校验」仍按尚未兑现记**:地图侧机制、家与诊断形态已定死并跑通,规则集侧差的是接线,不是设计。**写在这里是为了不让后来者以为它已经兑现**,也为了说明为什么不写半截 schema:放行额外属性的空 schema 等于不校验,却会让人以为「存档 meta 已校验」,比不写更坏。

**漂移检查的实现是三段判定,不是裸的 `git diff --exit-code`**:① 内容一致性——真源现在会产出的东西与工作树里那个文件逐字节比(抓「改了真源没重跑」与「生成物被手改 / 被删」);② 对 `HEAD` 的差异检查,**限定在生成物路径上**(`git diff --quiet HEAD -- <生成物路径>`,抓「生成了但没提交」)——限定是为了不把开发者工作树里别的未提交内容报出来,把报错指向错误的地方;③ 按生成物路径的状态检查(`git ls-files`,未被索引跟踪即失败,抓「新增生成物没进版本库」)。后两刀是分开的:裸 `git diff` 看不见未跟踪文件,而新增生成物恰恰是漂移检查最该抓住的情形。路径清单从生成物注册表本身取,不另存一份(§3.1)。

#### 2.2.6 gen 管线专属依赖(唯一允许联网的包)

| 项 | 选择 | 依据 |
|---|---|---|
| prompt 模板 | `prompts/` 目录下的数据文件(不进 gen 代码) | 改提示词不必改代码;与 `docs/rules-v1` 同为 gen 的输入 |
| 模型 API 客户端 | OpenAI-compatible HTTP 客户端 + 各厂商 SDK 适配层 | 新模型接入只改配置(FR-5 AC3);凭证一律走环境变量 |
| 重试与限流 | 指数退避 + 每模型并发 1 | 生成阶段无性能压力 |
| 生成日志 | 结构化 JSON 落盘(进存档 meta) | FR-6 AC1 |

#### 2.2.7 脚本分层与 CI 质量门禁

门禁以**命名脚本手工触发**,不建 CI/CD 流水线(ADR-0002;流水线形态与仓库首个真实实现强相关)。下表是 `package.json` 里的实际内容,不是计划:

| 脚本 | 实际内容 | 用途 |
|---|---|---|
| `check:quick` | `oxfmt --check` + `oxlint` + 工具版本耦合断言 + 禁浮点门禁 | agent 每轮编辑循环 |
| `check:no-float` | `node packages/tools/src/gate/run-no-float-gate.ts`(禁浮点门禁) | 仓库源码禁浮点字面量 |
| `generate` | `tsc -b packages/schema && node packages/tools/src/generate/run-generate.ts && tsc -b` | 重跑生成器,产出全部生成物并入库(§3.1);**要一次构建**,故不是门禁而是提交前的动作 |
| `check:declared-deps` | `node packages/tools/src/gate/run-declared-deps-gate.ts` | 挂在 `check` 末尾:工具包运行时源码里 import 的第三方包必须在它自己的 `package.json` 里声明(§3.2);**零构建**,与读 `dist` 的 `check:deps` 互补 |
| `check:drift` | `node packages/tools/src/generate/run-drift-gate.ts`(生成物漂移检查) | 挂在 `check` 末尾,**不进 `check:quick`**:它需要一次 `tsc -b`(生产函数 import 真源包),而 `check:types` 里已经有,快门禁的零构建性质因此不受影响 |
| `check:types` | `check:quick` + `tsc -b` + `oxlint --type-aware` | 改完一个 issue 跑一次 |
| `check:deps` | `tsc -b` + dependency-cruiser(巡航 `dist` 而非 `src`,§2.2.10) | 依赖方向 |
| `check` | `check:types` + vitest(`unit` + `property` 两个 project)+ `check:deps` + `check:declared-deps` + `check:drift` | 全量 |
| `test:props` | `vitest run --project property` | 长时属性测试,单独跑 |
| `test:gates` | `vitest run --project gates`(门禁自测:每道门禁的退出码与反向用例) | 单独跑;**不能混进 `check`**,否则 `check → gates → check` 无限套娃 |
| `mutate` / `scan` | **尚未落脚本**:Stryker 配置随引擎结算管线落地;`scc` 是手动装的外部工具 | — |

**参赛脚本静态校验器(§6.2 那个工具)不是本仓库的门禁**:`package.json` 里没有它的 `check:*` 脚本,它也不巡航本仓库源码——它服务于生成管线,调用方式是 gen 管线以子进程 spawn 它的入口(§6.2)。**要说清的是「不进 `check`」这句限定只到「它不是一道仓库门禁」为止,不是说它的测试不跑**:`check` 含 `vitest run --project unit`,而该工具的规则与入口自测落在 `unit` 的拾取范围(`packages/*/src/**/*.test.ts`)内,所以每次 `check` 都会跑到它们。真把它们抽出去只能像 `gates` 那样单开一个 project,而那会让这些反例失去常态覆盖。

> 快慢分离是关键:agent 走 `check:quick`,需要类型感知 lint 时跑 `check:types`,全量走 `check`。类型感知 lint 超过 ~10s,agent 就会"写完一起跑",反馈回路断掉。

**门禁耗时(实测;观测项,不是承诺)**。测量方法:在合并后的仓库树上先跑一次 `pnpm run build`,随后**连续 5 次**取该门禁的墙钟(`/usr/bin/time` 墙钟),**报中位数**(不报单次最好成绩);环境 Node v24.15.0 / Linux x64。

| 门禁 | 5 次取样(s,2026-10-03 复测,基线提交 `a7f41f6` + 本票的文档改动) | 中位数 | 上一轮中位数(2026-10-01) |
|---|---|---|---|
| `check:quick` | 1.05 / 1.03 / 1.05 / 1.05 / 1.08 | **1.05s** | 1.04s |
| `check:types` | 1.83 / 1.79 / 1.82 / 1.86 / 1.88 | **1.83s** | 1.75s |
| `check`(全量) | 5.49 / 5.65 / 5.81 / 5.65 / 5.78 | **5.65s** | 4.52s |

**先说清楚这些数字的适用边界**:两次取数之间,`oxfmt --check` 的目标清单从 49 个文件长到 **77 个**(apps/ 与 packages/ 下 68 个 + 根 9 个配置文件),`check` 里的测试从空壳变成 17 个测试文件、152 条用例(含门禁自测的反例),于是全量门禁的中位数从 4.52s 涨到 5.65s——**这就是同一方法重测一次能拿到的信息:增长是可测的,不需要靠猜**。快门禁几乎没动(1.04s → 1.05s),因为新增的代码与测试都不在它的巡航面上;生成物漂移检查与「声明即依赖」门禁都刻意**不进快门禁**——前者要一次 `tsc -b`(ADR-0003 给这一条记了实测数字),后者要在每轮编辑循环里多付一次全源码树遍历加读 manifest;快门禁那四项本身在两次取数之间没有变过,这是分层取舍,不是遗漏。

即便如此,它**仍然只在这个规模上成立**:引擎、结算管线、赛季调度、生成管线都还不存在,`check` 跑的是校验器与门禁这一层的测试。门禁耗时随源码量与依赖图规模增长——77 个文件仍然不是真实仓库。

> 上一版这里写的是「`check:quick` 目标 < 5s」,那是一个没有实测支撑的许愿。现在有数字了,但**它不能变成承诺**:`< 5s` 若写成硬约束,后来者为了凑数字能改门禁的覆盖面(少查几个包、把类型感知挪出快门),而那比慢 5s 坏得多。**正确用法是把它当基线**:仓库长大后用同一方法(同机、5 次取样、报中位数)重测一次;只有重测出来的中位数显著上升,才谈是否再加一层分层。先前那条未经验证的许愿到此作废。

**主流水线**(每次 PR 与主干 push,全部通过才可合并;**尚未建成**,当前全部以命名脚本手工触发):

| 阶段 | 内容 | 对应需求 |
|---|---|---|
| 1. 编译 | `tsc -b`(必须先于类型感知 lint) | — |
| 2. 静态 | `oxfmt --check`、`oxlint --type-aware`、禁浮点门禁、工具版本耦合断言、dependency-cruiser、生成物漂移检查 `check:drift`(末尾一道,§2.2.7) | FR-2 AC3、FR-10 AC2、NFR-4 AC2 |
| 3. 单测+属性 | Vitest 全量(结算、属性、沙箱裁决、地图校验) | FR-1/3/4 |
| 4. 集成 | 样例对局端到端 + `modelwar verify` 重放一致性 + 重跑 10 次 hash 断言 | FR-2、NFR-1 |
| 5. 基准 | `benchmarks/` 双模型基准脚本对打一个对局,断言正常终局(不判策略胜负) | srs §4 第 2 条的回归防线 |

**夜间流水线**(定时或手动,不阻塞 PR):StrykerJS 变异测试(engine 优先);对 CI 可取到的对局样本批量 `modelwar verify`,守护"历史结果永远可复算"(NFR-2)。

CI 环境无网络、无模型 API、无凭证——保证 CI 上跑的永远是无头引擎与固定脚本,与生产对局同构。

#### 2.2.8 依赖策略

| 包 | 运行时第三方依赖 | 理由 |
|---|---|---|
| engine | 仅 `quickjs-wasi` + `node:crypto` | 除 stateHash 外**禁一切 `node:*`**,由 dependency-cruiser 强制——等于用 lint 证明"纯函数"。engine 不做磁盘 I/O:wasm 字节由 `apps/cli`/runner 读盘后传入,回放写向注入的输出 sink(§3.1),`engine` 包内不出现 `fs` |
| runner / apps/cli | 受控少量(`ajv` 校验器**只在 `apps/cli`**;CLI 参数解析用 `node:util` 的 `parseArgs`,不引命令行库) | 只做调度与读文件,不参与结算。校验器不落回真源包,理由与覆盖面见 §2.2.5 |
| gen | 允许(HTTP 客户端、SDK) | 唯一联网包,永不进对局进程(NFR-4 AC2) |
| tools | 第三方依赖面由 `check:declared-deps` 管(声明即依赖);包图方向只由 tsc 兜,**两者的取舍见 §3.2,此处不复述** | 静态校验器以源码形态由 Node 的类型擦除执行(`node packages/tools/src/…`,§3.1);这是 Node 下限取 22.18 的成因之一(§2.2.1) |
| devDependencies | 全仓库共享(oxlint、oxfmt、Vitest、dependency-cruiser、`oxc-parser`、tsc) | 不进入任何运行时 |

#### 2.2.9 观测与调试

| 项 | 选择 | 依据 |
|---|---|---|
| 引擎日志 | 对局级结构化 JSON 落盘(`runs/<runId>/logs/`),默认静默 | 排障可追溯;不打断 JSONL 回放的纯数据性 |
| 对局内调试 | **不建专用工具**:`modelwar match` 重跑一个对局 + JSONL diff 即等价物 | 确定性引擎下"调试 = 重放" |
| 叙事战报 | runner 内置生成器,只消费回放 events 流(§7.5) | 主输出要求 |

#### 2.2.10 依赖治理(dependency-cruiser)

| 能力 | 用法 |
|---|---|
| 可视化 | `depcruise --output-type dot` 生成模块依赖图,产物入 `docs/diagrams/` |
| 规则强制 | 根目录 `.dependency-cruiser.js` 把 §3.2 全部规则写成可执行断言,违规非零退出,挂在全量门禁 `check` 上(经 `check:deps`) |
| 基线卫生三则 | 除 §3.2 的架构规则外,配置里另有 `no-circular` / `not-to-unresolvable` / `not-to-deprecated` 三条**基线**。它们不是额外的架构主张,是让那批方向规则**真的会触发**的前提:图里有环、有解析不了的 import 时,「谁不得 import 谁」的断言会静默失去意义 |
| 价值 | 包边界(尤其"gen 永不进对局进程"与"engine 纯函数")从口头约定变为机器门禁 |

> 依赖规则与 TS project references 双保险:前者管运行时 import,后者管编译期类型引用。

**四条实测出来的操作事实**(细节与原始输出在 `.dependency-cruiser.js` 的头注里,那里是它们的第一现场):

1. **规则只作用于运行时代码,测试代码豁免**。依据是 §3.2 已有的那条:门禁约束的是运行时行为,而测试代码不进对局进程;测试与属性测试文件必然要读盘、spawn 进程、依赖 vitest。
2. **巡航入口是 `tsc -b` 的产物 `dist`,不是 `src`**。dependency-cruiser 18.4.0 把可用的 TypeScript 编译器硬编码为 `>=2.0.0 <7.0.0`,而本仓库的 TypeScript 7.0.2 **不再有 JS 编程 API**(`transpileModule` 不存在)。直接巡航 `src` 会得到「`x typescript >=2.0.0 <7.0.0` / `x .ts`(不可扫描)」,然后报告「0 modules, 0 dependencies cruised」并**退出 0**——一条永远全绿的假门禁。故 `check:deps` 自带 `tsc -b`,巡航 `packages/*/dist` 与 `apps/*/dist`(acorn 能解析,import 说明符原样保留),**依赖门禁必须排在 `tsc -b` 之后**。门禁自测里有一条用例专门断言巡航规模不为零,防这条假门禁复发。
3. **`packages/tools` 有意落在本图的巡航范围之外**:它以源码形态执行、`emitDeclarationOnly`,`dist` 里没有 `.js`,depcruise 看不见它(实测巡航出的模块里一个 `tools` 的都没有)。这是取舍不是疏漏——让该包产 `.js` 就要让快门禁付一次构建,而快门禁必须零构建(§2.2.1 的 Node 下限成因之一)。缺掉的覆盖面怎么补、还剩哪半开着,见 §3.2。
4. **`to.path` 匹配 specifier 还是 resolved realpath 是互斥的两态**:dist 未 build 时是 `@model-war/replay`,build 之后是 `packages/replay/dist/index.js`。每条架构规则都用 `(?:specifier|resolved)` 交替式,两种状态都成立;另外 depcruise 会**剥掉 `node:` 前缀**,故内建模块一律用 `dependencyTypes: ["core"]` + `pathNot` 表达。

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
| engine | **每个对局一个子进程** | 一个对局 | 一个对局崩溃不污染其余对局(FR-7 AC2);内存上限可在进程级施加 |
| sandbox | 对局进程内,每方一个 QuickJS VM(同进程、串行执行,§5) | 与对局同生命周期 | 脚本无网络/FS/宿主访问(FR-4 AC1);一方崩溃不影响他方(AC3) |

执行模型:引擎每 tick 按 playerIndex 0..3 顺序串行执行四方 `loop()`——快照构建 → VM#i 执行并收集 intents → 下一方。**无并发、无到达顺序问题**:确定性天然成立,无需归位逻辑。

runner 通过子进程调用 `modelwar match`(§9)执行一个对局;两者之间只交换 `input.json` 与产物文件。

## 3. 系统分解

### 3.1 包结构与职责矩阵

```
model-war/
├─ apps/
│  └─ cli/                    # 唯一用户面与唯一 bin(modelwar)
│     └─ src/{index.ts, commands.ts}   # commands.ts = 六个子命令的登记表(命令名、承载包、待导出符号)
├─ packages/
│  ├─ schema/                 # 唯一真源:五类数据形状的类型与 JSON Schema + 常量表 + 参数 key 清单(无运行时代码)
│  ├─ replay/                 # 回放的解析/序列化 + stateHash 原语 + 回放文件格式版本常量(只依赖 schema;行的形状归 schema)
│  ├─ engine/                 # 确定性内核 + 沙箱(driver/processor/world/snapshot/runner/sandbox-runtime/replay-writer/ruleset-loader)
│  ├─ runner/                 # 赛季调度、进程池、排名与种子纯函数、报告、叙事战报
│  ├─ gen/                    # 脚本生成管线(离线,永不进对局进程)
│  └─ tools/                  # 仓库自用静态校验器(禁浮点门禁、工具版本耦合断言、声明即依赖门禁)+ 生成器(生成物注册表);以源码执行,不产 JS、不设 bin
├─ benchmarks/                # 模型基准脚本(≥2)
├─ prompts/                   # gen 的 prompt 模板(数据文件)
├─ scripts/                   # 面向人的一次性开通脚本(不进运行时;当前只有 J 的凭证 wizard)
├─ rulesets/v1.json           # 规则数值数据文件(取值真源)
├─ maps/                      # 地图 JSON
├─ docs/rules-v1/{rules.md,api.md}   # 面向模型的文档(表格为生成物)
├─ archive/<model>/<runId>/   # 冻结脚本存档
└─ runs/<runId>/              # 对局产物:回放 JSONL、result、报告、叙事战报
```

**为什么多出 `packages/tools` 这第七个成员**:静态校验器有**两个消费者**——仓库自身的确定性门禁(已落)与将来的参赛脚本静态校验(它的名表读取点已随 `schema` 落地,AST 规则随那张票)——而现有包里没有一个放得下:`schema` 被 §3.2 明文限定为**无行为代码**,把门禁挂在它下面会让"真源"长出行为;`gen` 是**唯一联网包**,把仓库自身的门禁挂在它下面会污染依赖方向(且门禁绝不该继承联网面)。放进独立工具包后依赖方向仍单向,且它不进任何对局进程。形态上的代价是:本包**以源码形式由 Node 的类型擦除直接执行**(`node packages/tools/src/<entry>.ts`),因此全仓库遵守「可擦除语法」(禁 `enum`/`namespace`/参数属性,由基座 `erasableSyntaxOnly` 兜住),`tsconfig` 用 `emitDeclarationOnly` 只产 `.d.ts`(被引用项目不得禁用 emit),`exports` 指向 `./src/index.ts`。

| 模块 | 职责 | 对应需求 |
|---|---|---|
| engine:driver | **状态唯一所有者**:GameState、Random(整数 LCG)、IdGen、`apply()` 唯一写入口 | FR-2 AC3、NFR-1 |
| engine:processor | 结算管线(顺序为数据)+ `intents/*.ts` 的 `check()`/`run()` 注册表 | FR-1、FR-3 AC3 |
| engine:world | 状态模型、对象系统、只读查询 | FR-1 |
| engine:snapshot | 只读快照构建与只读封存 | FR-3 AC1 |
| engine:runner | 执行器缝:`Runner` 接口 + `QuickJsRunner`(唯一真实实现)+ `StubRunner`(测试替身) | FR-4、§5.2 |
| engine:sandbox-runtime | 沙箱内 API 面(TS → IIFE bundle,版本 + hash 入 meta) | FR-4 |
| engine:replay-writer | JSONL 写出(行格式取自 `schema` 包,§2.2.5;写向注入的输出 sink,不直接碰 `fs`) | FR-2 AC2 |
| engine:ruleset-loader | 参数装载与版本比对 | NFR-4 AC1、FR-10 AC2 |
| runner:scheduler | 组合 × 地图 × 种子 × 座位的对局枚举与并发调度 | FR-7 |
| runner:ranker | 名次积分、并列处理、可选 Elo(**纯函数**) | FR-8 |
| runner:reporter | Markdown 报告 + JSON 原始数据 + 叙事战报 | FR-8 AC2 |
| gen:pipeline / validator / archiver | prompt 组装 → 模型 API → 校验迭代 → 冻结脚本;API 误用静态检查挂真源包的类型面而非符号表(名单由 `schema` 生成,§6.2),白名单反转在编译步骤而不在本包;元数据强制存档 | FR-5、FR-6 |
| replay | 回放的解析/序列化、stateHash 原语、回放**文件格式**版本常量;**不再声明行的类型**(归 `schema`,§2.2.5) | FR-2 AC2、NFR-1 |
| tools:rules / gate | 禁浮点纯规则(源码 → 带行列的违规)+ 目录薄壳与退出码;工具版本耦合断言;声明即依赖门禁。**名单类数据一个名字都不在这里存**——真源在 `schema` 一侧,本包经生成器读生成物(§3.2) | FR-2 AC3、NFR-1 |
| tools:generate | 生成器:真源 → 生成物,持有一张**生成物注册表**(每件 = id、产出路径、生产函数);**新增生成物是加一行注册**。漂移检查按注册表逐件判定(§2.2.5、§2.2.7) | FR-10 AC2 |
| cli:replay-view / replay-verify / map-lint | ASCII 查看器(不依赖 engine);重放一致性断言;地图对称性校验 | FR-9、NFR-1、FR-1 AC2 |

**生成器为什么在 `packages/tools` 而不在 `packages/gen`**(ADR-0003)。理由按权重:①生成物漂移检查要进 PR 主流水线,而 `gen` 是唯一联网包,将来按 §2.2.6 要装 HTTP 客户端与各厂商 SDK——一条只读写仓库内文件、零联网的仓库门禁,不该让依赖面随别的节点扩张;②它要推翻上面那段「工具包之所以独立存在,就是为了不把门禁挂在唯一联网包下」;③两个包的产物语义不同——生成管线按批次追加存档,而生成物是整体重生成、判定标准是「重生成后无差异」,放一起会让漂移检查的判定逻辑与追加语义缠在一起。落进 `schema` 或新开第 8 个包也被排除:前者受「无运行时代码」约束,后者要连拓扑图与本表一起改,代价与收益不成比例。

**生成器与真源之间是混合传输,分界线是「能不能 afford 构建」**:生成器是低频入口(跑一次、产物入库),因此它**import 真源包**并为此在本包正式声明那条依赖;而工具包的规则层是每次提交都跑的快门禁,零构建是硬要求,因此它**读生成出来的源文件**,不 import 真源包。同一份名单在两侧都拿得到,分界线只按调用频率划(实测:让规则层直接 import 真源包,`check:quick` 由 1.04s 涨到约 1.36s,+31%,且新克隆第一次跑门禁就要先构建)。这层反直觉的间接是整件事里最容易被后来者「简化」掉的一处——简化掉它,快门禁就多了一个构建前置。

### 3.2 依赖规则

```
schema ←── replay ←── engine ←── apps/cli
   ↑                    ↑           ↑
   └──────── runner ────┘           │
   └──────── gen ───────────────────┘

packages/tools ──→ @model-war/schema   依赖图的根,本包唯一允许的 @model-war 依赖
               └─→ 其余 import 都是第三方包,必须在本包 package.json 里声明
```

- `schema` 只含类型、常量与 JSON Schema,**无运行时代码**;各包共享数据格式定义不违反 NFR-4 AC2(该条款约束的是运行时进程隔离,与测试代码无关)。
- `replay` 只依赖 `schema`;**库包一律不得含 `bin`**,唯一 bin 在 `apps/cli`。
- `runner` 与报告/叙事代码**不得 import `engine`**:只以子进程 + 文件消费。`apps/cli` 通过 engine 公共 API 调用 match / verify,而 map-lint 是 CLI 自己的模块(§3.1、§9)。
- `engine` 不 import `runner`/`gen`;`gen ⇎ engine`,且 `gen` 禁 import 任何 result 类型(FR-5 AC1)。
- `engine` 内除 `node:crypto` 外禁一切 `node:*`。
- `engine` 内部单向:`world → driver → processor → replay-writer`;`world → snapshot → runner(Runner 缝 → sandbox-runtime)`。`sandbox-runtime` 不 import 宿主代码,只消费 `schema` 生成的常量/API 名表。
- 上述规则全部由 dependency-cruiser 强制(§2.2.10),违规直接导致全量门禁失败。
- **工具包只允许 import 真源包这一个根包**,不得 import `replay` / `engine` / `runner` / `gen` / `apps/cli`(ADR-0003 的混合传输:名单类数据的真源在 `schema`,工具包经生成器拿生成物)。这条边指向依赖图的根,方向合法;**但它没有机器守护**,见下面那段缺口说明。
- **作用域:本节全部规则只作用于运行时代码,测试代码豁免。理由**:门禁约束的是运行时行为——进对局进程的代码路径;测试代码不进对局进程(测试与属性测试必然要读盘、spawn 进程、依赖 vitest),不构成隔离风险(§2.2.10 第 1 条)。

**`packages/tools` 有意落在依赖门的巡航范围之外,这是取舍不是疏漏**:它以源码形态执行、`emitDeclarationOnly`,`dist` 里没有 `.js`,depcruise 因此看不见它(实测巡航出的模块里一个 `tools` 的都没有)。让本包产 `.js` 就要让快门禁付一次构建,而快门禁必须零构建(§2.2.1 的 Node 下限成因之一)。缺掉的覆盖面分两块,**一块已补、一块仍开着**:

- **第三方依赖面:已由 `check:declared-deps` 兜住。** 该门禁读 `packages/tools/package.json` 的 `dependencies` 与本包运行时源码里的每一个 import 说明符,两者对不上即非零退出;它**零构建**(读源码树),与读 `dist` 的 `check:deps` 形态互补。此前这一格记的是「没人兜底」并点名仓库正吃着它(本包 import `oxc-parser` 而 manifest 一个都没声明),那处偷跑已改成正式声明。
- **包图方向:只由 tsc 兜,本门禁看不到。** 本包现已正式声明 `@model-war/schema` 并加了 project reference,pnpm 只软链已声明的包,于是 import `@model-war/engine` 得 **TS2307**、`tsc -b` 非零退出。**但编译器只拦「没声明」,拦不住「声明了而方向反了」**——真源包不得反向 import 工具包这条仍靠规范,不由门禁承担。

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
                a) 占领:单轨累积 / 转轨重计 / 占领进度保留不动(gdd《占领机制》)
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

**座位与先后手**:轮转优先只保证一个对局内首发顺序逐 tick 轮转,不消除头对头偏置(下标差 d 的两人,低下标在 `(4-d)/4` 的 tick 中先手)。故座位必须在赛季内轮换,公式见 §8.1。

### 4.5 快照与脚本 API 面

- 快照 = GameState 的**深拷贝**,经单次 `__setSnapshot` 传入 VM;脚本持有的引用在下 tick 全部作废,**对象身份不跨 tick 保证**(跨 tick 记忆只能用自己的状态与数值 id,不得缓存对象引用)。`Object.freeze` 由引擎侧在深拷贝上执行(防宿主回调误写);**隔离靠拷贝边界,而非只读封存语义**。
- **API 面由沙箱内 runtime bundle 实现**(`engine/sandbox-runtime`,TS → IIFE):
  1. 每 tick 只跨宿主边界两次——`__setSnapshot(snapshot)` 进、`__drainIntents()` 出;
  2. 查询函数(`getObjectsByType` / `getObjectById` / `getTick` / `getRange` / `findPath` / `getTerrainAt`)与 action 函数(`move` / `moveTo` / `attack` / `harvest` / `transfer` / `spawnUnit`)全部在 VM 内运行,跨边界调用数从 O(API 调用数) 降到 O(1)/tick;
  3. 脚本可见全局 = runtime 暴露的 API + `schema` 生成的常量表,不注入任何宿主能力。
- **形态定案**:v0 保留 bundle 形态,不回退逐函数注入(§2.2.2 的回退路径仅留档)。
- **宿主桥函数不可见(实测已确认)**:runtime bundle 初始化时把 `__setSnapshot` / `__drainIntents` 捕获进闭包并**从 VM 全局删除**。实测(quickjs-wasi 3.6.2 / Node v24.15.0 / Linux x64 / 2026-10-01 复核探针,探针不落库):删除后 `'__setSnapshot' in globalThis` 为 `false`,`typeof` 为 `undefined`,按 `__` 前缀枚举返回空数组——脚本**枚举不到、也捞不回来**;而闭包内的引用照常工作(`callFunction` 能调得动),删除不伤引擎自己那条路。
- 但删除**不是判罚手段,只是消灭暴露面**,这一点必须写清:脚本引用已删除的桥,拿到的是**普通的 guest `ReferenceError`**,不是任何专属的越权信号。未捕获时它以 `JSException` 形式冒到宿主;**被脚本 `try/catch` 吞掉时宿主零痕迹,脚本继续跑完本 tick**(实测:吞掉后 `after` 标志照常置位,闭包通道仍可用)。因此 §5.2 那行「访问已删除的宿主桥 → 视同 `loop()` 抛异常」只在脚本**不**吞异常时成立。真正的防线是 `__*` 前缀的静态禁令(§2.2.3 / §6.2),删除只是纵深防御里的一层。
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
| 预算裁决 | 控制流事件计数 + API 调用计数为主判据;墙钟只观测;硬超时使对局作废而非参与判罚(§5.3) |
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

v0 采用 `quickjs-wasi`(QuickJS-NG 编译为 WASM 的快照型 JS 运行时,MIT 协议,零第三方依赖;版本锁定到 `package.json`,**锁定 3.6.2**(基线 ≥3.5.0:3.3.x 的 `memoryLimit` 计账与 OOM 异常形态各有回归))。相对此前候选(QuickJS 嵌入 / WASM + fuel / isolated-vm):

**先交代本节行为结论的出处**:以下五条全部来自 `quickjs-wasi@3.6.2` 的实测,环境 **Node v24.15.0 / Linux x64**,主测量日期 **2026-09-24**(数据与原始输出在 `.scratch/sandbox-budget/spike/`,逐条判定见 `spike/FINDINGS.md`;#1 与 #5 另有 2026-10-01 的复核探针,探针不落库)。**这些结论只对 3.6.2 成立**,换版本即失效。复验责任见本节末“升级条款”与 §12 #8。

| # | 行为 | 结论 | 机制与参数落在 |
|---|---|---|---|
| 1 | 脚本入口契约 | 单文件 script-mode 编译产物经 `evalCode` 载入即成,`loop` 是 `function` 且 `callFunction` 调得动;带 `export` / `import` 的产物在**载入期**就取 `SyntaxError`。来源:`spike/results/m7-doc-gaps.txt`(M7.2,M7.3)+ 2026-10-01 复核探针 | §2.2.2 |
| 2 | 深递归的失败形态 | **host 侧 `RangeError: Maximum call stack size exceeded`,`isJSException: false`**——不是 WASM RuntimeError trap,也不是 JSException;guest 吞不掉;**VM 溢出后仍可续用**。来源:`spike/results/m3-runaway.txt`(M3 deep-default/deep-guard-off,VM 续用 `eval:3`) | §5.0 崩溃语义、§5.2 |
| 3 | `interruptHandler` 的截停能力 | 每 **5000 次控制流事件**(循环回边 / 调用 / 返回)触发一次,**不是每条字节码指令**;中断以 host 侧 `InternalError: interrupted` 呈现,**guest 不可捕获**,VM 续用;纯计数回调拖慢 ≤~3%。来源:`spike/results/m1-interrupt.txt`(M1.1 `itersPerCb: 5000.00`,M1.2 −2.5%~+2.4%,M1.3 `catchRan: NO`) | §5.0 预算可复现、§5.3 |
| 4 | 内存读数字段名 | 判据读 `getMemoryUsage().mallocSize`(与 `memoryLimit` 同记账口径);`memoryUsedSize` 更低且不含空闲池,不作判据;读数封顶是 `memoryLimit − 最大单次分配`,**不是 `−64KB`**。来源:`spike/results/m2-memory.txt`(基线 `mallocSize:75128` vs `memoryUsedSize:64098`) + `.scratch/sandbox-budget/findings/02b-*`(02 的 `−64KB` 模型已被 02b 推翻,封顶为准操作模型) | §5.3 |
| 5 | 宿主桥函数删除后的不可见性 | 删后脚本枚举不到、也捞不回来,闭包内的引用照常工作;但越权只表现为普通 `ReferenceError`,**被脚本 `try/catch` 吞掉时宿主零痕迹**。来源:2026-10-01 复核探针(删除模拟:`in` 为 `false`、`typeof` 为 `undefined`、按 `__` 前缀枚举为空;闭包调用照常返回;引用已删桥未捕获时 host 侧 `ReferenceError` JSException,吞掉后 `after` 标志照常置位) | §4.5 |

- **隔离**:One VM = One WASM 实例,线性内存互不可见;包只做显式 I/O(wasm 字节由调用方提供),默认无 FS/网络——满足 FR-4 AC1,且比 worker_threads 的"去全局"做法审计面更小。
- **预算可复现**:`interruptHandler` 每 5000 次控制流事件(循环回边/调用/返回)触发一次(回调内自乘计数),与 API 调用计数构成双主判据——实测口径是**控制流事件计数**而非指令计数(直线代码不计量,由 §6.2 脚本体积上限封盲区);`memoryLimit` 超限(≥3.5.0)表现为**可捕获的 JS 异常**(`InternalError: out of memory`),内存判据锚定 tick 末存活堆读数(§5.3)——均不依赖墙钟。回调开销与粒度已实测校对(纯计数 handler 对比无 handler 拖慢 −2.5%~+2.4%,即 ≤~3%;回调摊销 1–4µs/次,故**回调内绝不能放墙钟或重活**)。
- **崩溃语义**:WASM 执行无进程崩溃概念;死循环由中断计数截停;**深递归栈溢出实测为 host 侧 `RangeError`(`isJSException: false`),既不是 WASM RuntimeError trap 也不是 JSException,guest 吞不掉,VM 溢出后仍可续用**——所以栈溢出**不需要**防御性重建(§5.2);WASM trap 只剩引擎故障级可能,FR-4 AC3 的"一方崩溃不影响他方"降级为"一方失控只计异常分,不污染引擎与他方 VM"。
- **记忆能力**:VM 常驻对局全程,模块级变量天然跨 tick 保留(FR-3);snapshot/restore 能力暂不用(状态以 GameState + JSONL 为准)。
- **执行器缝**:host 侧 `Runner` 接口(`init/tick/dispose`)+ `QuickJsRunner`(唯一真实实现)+ `StubRunner`(测试替身:回放预置 intent、抛异常、触发 trap、超预算)。**在出现第二个真实 VM 实现之前不新增抽象层**——这条缝只让 §5.2 的四类裁决与结算管线可脱离 WASM 穷举测试。
- **代价**:Node ≥ 22.18(**下限的成因是我们自己的代码,不是本库**,§2.2.1);`moduleLoader` 不配置(`import` 在静态校验期即拒绝,运行时 script-mode 同样把它当 `SyntaxError`);**`maxStackSize` 选项确实存在**(3.6.2 有;`0` = 关守卫,显式设值 ≤512KB),v0 **不启用**——启用会把栈溢出变成 guest 可捕获异常、可被脚本吞掉;不启用(默认或显式 `0`)则溢出为 host `RangeError`,host 必见。**上一版这里写的“无 `maxStackSize`、栈溢出表现为 WASM trap”两句都不成立**,已按实测改正。

**升级条款当前是空头承诺,须写明**:"升级 `quickjs-wasi` 需重跑重放一致性测试与沙箱行为复测"这条既有条款,在**沙箱执行器落地之前没有任何可执行的东西支撑它**——重放一致性要有一个真实的对局可重跑,行为复测要有一个真实的 VM 宿主来驱动,而两者都还不存在(骨架里 `engine` 只有导出符号,没有 `QuickJsRunner`)。**复验责任挂在“实现真实沙箱执行器”那张票上**:它落地时的**第一条验收**就是按当时的版本组合把上表五条重跑一遍,并把新数字写回本节(§12 #8 记着这件事)。在那之前,本节的数字只对 3.6.2 成立,且**没有任何机器会提醒后来者它们已经过期**。

### 5.1 隔离与注入

- 每方一个独立 `QuickJS.create({wasm, memoryLimit, interruptHandler, wasi})` 实例;四个 VM 同进程串行执行,不共享线性内存。`wasm` 字节由 runner 层读盘传入 engine(engine 不做磁盘 I/O)+ `WebAssembly.compile` 预编译,四 VM 复用同一 `WebAssembly.Module`。
- **WASI 覆盖**(三件套取值定为工程常量,非对局参数):`clock_time_get` 覆盖为 `1700000000000`(`Date.now()`/`new Date()` 在对局内因此定格;QuickJS 内部 PRNG 以该值播种 xorshift64*,同值即同 `Math.random()` 序列),`random_get` 覆盖为固定字节填充,`timezoneOffset` 固定为 0。三件套取值与 `quickjs-wasi` 版本号一并写入回放 meta 行(§7.5),可审计。
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
| 越权调用(未定义 action / 访问已删除的宿主桥 / 访问未暴露字段) | 脚本未吞异常时视同 `loop()` 抛异常;**吞掉时 host 无感知,防线是 `__*` 静态禁令**(§4.5) | ✅ |

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
| 墙钟硬超时 | 防宿主卡死的最后防线(如宿主回调卡死) | **不判负**:标记 `nondeterministic-timeout`,按 §8.4 与 `engine-crash` 同轨处理(重跑 / 剔除并披露) | 隔离出判罚路径,判罚仍可复现 |

设计理由:双计数互相覆盖对方的盲区——纯计算型死循环由事件计数抓住,API 轰炸(如每 tick 数万次 `findPath`)由调用计数抓住。**预算判据必须锚定 host 可直接测量的量,不依赖 guest 异常可见性**(guest 吞 OOM 异常时 host 零痕迹,故内存判据锚定 tick 末存活堆读数)。墙钟受机器负载影响,任何参与判罚的墙钟都会破坏 FR-2,故硬超时只作废当前对局,不改变对局内的胜负判定。

**全部上限取值(事件计数上限、API 上限、内存上限、`memoryTickCeiling`、软限、硬超时、exceptionTickLimit、脚本体积上限)为 `rulesets/v1.json` 中的参数**,用 ≥2 个模型基准脚本标定(srs §4 第 2 条)。标定注脚:`memoryTickCeiling` 取值须 > 正常脚本 tick 末存活峰值 + 余量,且低于读数封顶(`memoryLimit − 最大单次分配`)。升级条款:若赛中"tick 内瞬时借满即还"型脚本普遍牟利,升级为 patch quickjs-wasi 加 sticky OOM 标志、判据回到确证事件(后备设计已评估,触发条件由运营定)。

## 6. 脚本契约与静态校验

### 6.1 契约载体

`docs/rules-v1/` 两份文档:`rules.md`(机制、结算顺序、确定性约束)与 `api.md`(API 签名与语义),自包含(FR-10 AC1)。二者同时是 gen 管线的 prompt 输入;其**表格部分(API/常量/数值)由 `schema` 包与 `rulesets/v1.json` 生成**,validator 白名单同理(§2.2.5)。

### 6.2 静态校验规则(gen:validator)

**承载分三层**:编译通过与「白名单反转」由生成管线的**编译步骤**承担,其余四类由 `packages/tools` 的**静态校验器**承担,入口签名由脚本编译配置的类型声明保证。**静态校验器不是参赛脚本能用什么名字的唯一裁判**——裁判权与编译步骤合并(实测依据见本节末,工具链一面的理由见 §2.2.3)。

| 类别 | 规则 |
|---|---|
| 编译 | **校验流水线里有这一步**,不是校验器内部跑这一步:编译责任在 gen 包(§7.4,engine 不引入 tsc),`tsc` 编译通过 + 顶层声明 `function loop()` 入口(返回类型可省略,不写成必须标注 `: void`)。编译诊断由管线直接透传给模型,校验器不复现它。**参赛脚本的编译配置(脚本 tsconfig)由规则落库这一格定、生成管线按它实现**,落点是根层 `tsconfig.scripts.json`:它**刻意不继承** `tsconfig.base.json`(`types: []` + 不带 DOM 的 `lib`,否则等于把 Node 类型带进沙箱),而它承载的正是下面那条白名单反转与入口签名。定与实现分开是刻意的:承载形状与契约面同源,它是下游的实现 |
| 模块系统 | 禁 `export` / `import` / 动态 `import()` / `require` / 动态 `eval`(单文件自包含)。静态校验器承担,判据是「这段代码是不是从自己之外取来的」 |
| 全局白名单 | **承载方是编译器的名字解析**:脚本在一个 `lib` 只含现代 ECMAScript、不含 DOM、不含任何 `@types`、只额外引入脚本 API 类型声明的环境里编译,「找不到这个名字」就是精确的白名单反转。**静态校验器不做反转**,也不为它自建作用域分析(实测与理由见本节末)。名字级别的禁令(`__*` 前缀全禁、确定性污染源)仍由它承担。内置全局表与注入符号表的真源在 `schema`,本包经生成器读生成物(§3.2),与沙箱 runtime 暴露的 API 面同源;**名单取值不在本文档复制**(见下一行与 `packages/schema/src/builtin-globals.ts`) |
| 内置全局白名单的收录判据 | **这一格放的是一条收录准则(一整句话的判据),不是名单的取值**:判据原文、判据的边界(什么算这一格里的名字)与逐个名字的「为什么收/不收」都在 `packages/schema/src/builtin-globals.ts` 的头注,那是它们的家,本文档只留指针。**这张表的消费者是面向模型的规则文档,不参与白名单反转的判定**;两侧不得互相引用为依据 |
| 确定性污染源 | 禁 `Date`、`Math.random`、`performance`、`queueMicrotask` 及其他非确定源(运行时 WASI 时钟已定格,本行为纵深防御)。静态校验器承担 |
| API 误用 | **依赖真源包的类型面(公开 `.d.ts`),不是符号表**:符号表是一张名字数组,给不出签名与结构化 intent 类型,判「用错」靠的是类型面。类型面**尚未回填**(家已定、字段未交付,§2.2.5 那条纪律),内容由对局内核与沙箱执行器回填;不补的话「编译步骤放行但运行时报未定义」在结构上仍可能发生——放行的是编译器,静态校验器在这条上从不是裁判 |
| 脚本体积 | 顶层脚本体积上限——封"直线代码不计量、大循环体放大每格工作量"的计数盲区。**量测对象是编译后产物的字节数**(不是原始 TS 源码,也不是字符数);取值入 `rulesets/v1.json`,由生成管线作为参数传入、校验器不给默认值;**检查时机:每轮迭代都查,迭代期只提示不拦,冻结期才拦** |

**四条规则统一跑在编译产物上,不在原始 TS 上跑**:模块语法、桥前缀、禁列在编译后仍逐条可判定,而在原始 TS 上跑会漏掉类型断言与类型标注这类 TS 特有形态,等于为它们再写一套判据;顺带消掉了「模块源码 / 脚本源码」两种源形态的分支。

**实测结论(只对所记版本组合成立,换版本即失效)**。以下两条来自 2026-10-03 的一次探针,环境 **`oxc-parser` 0.152.0**(native binding `linux-x64-gnu`)+ Node v24.15.0 / Linux x64,**探针不落库**(与 §5.0 五条沙箱实测同一处置):

| # | 行为 | 结论 |
|---|---|---|
| 1 | 解析结果的可见面 | `ParseResult` 只有 `program` / `module` / `comments` / `errors` 四个 getter,`module` 只有 `hasModuleSyntax` / `staticImports` / `staticExports` / `dynamicImports` / `importMetas`;**没有符号表、没有引用解析、没有「这个名字是不是自由变量」的任何 API**,包的全部导出(含 `raw-transfer/*` 子路径)里也没有 symbol/scope 相关入口 |
| 2 | 标识符不区分引用位与声明位 | 声明位置与引用位置的标识符反序列化后是**同一个 `type` 字符串 `"Identifier"`、同一组字段**,逐字段深比较只差 `start`/`end`。判「引用还是声明」只能靠**父节点字段位置**(实测:`…declarations[0].id` vs `…argument.left`),而哪些父节点字段算声明位(变量/函数/参数/解构简写/`catch` 参数/`for-of` 绑定/class 方法名/对象字面量键)得自己维护 |

**承载权因此从静态校验器移到编译器**:白名单反转的本质是自由变量判定,而这一层解析不提供作用域;自建分析器的失败模式是**漏掉任何一处声明位置 = 误伤一份合规脚本**,而误报在五轮迭代预算里不对称地致命(模型拿到一条改不掉的违规,五轮耗尽,这一轮生成作废),漏报的代价只是回到现状。编译器的名字解析对这种不对称性零成本,且已在流水线上。

**测试边界沿用禁浮点门禁那条先例:遍历层不单独测**——本工具的输入是**一份产物文件,不是一棵目录**,所以连「目录遍历」这一层都不存在,入口只做「读文件 → 判定链 → 退出码」;测的是退出码与面向模型的文本。

校验失败 → 仅错误信息回喂模型(≤5 轮,FR-5 AC1);`gen` 代码中不存在对战结果回传路径。

## 7. 数据设计

### 7.1 ruleset 数据文件(`rulesets/v1.json`)

**全部参数取值的真源**:兵种表、经济参数、占领参数、tick 上限、异常阈值、领土分权重、点位数量不变量(每方主基地数)、预算参数。地图的尺寸与具体点位数量归地图数据(§7.2),不在此文件。参数的含义与设计意图由 gdd《参数清单》定义,取值一致性由 JSON Schema 校验;版本号的一致性口径见本节末段。

**键清单与必填性**:参数的**名字、类型、量纲、取值范围与含义**由真源包的键清单持有(它是机器可读的那一份,gdd《参数清单》定义含义与意图);取值文件按清单逐键落值。本仓现为 21 个键 = 13 个定稿键 + 8 个预算键。**全部必填,没有可选键**。

**预算键的未定值口径,以及「缺键 ≠ 未定值」**:8 个预算键在标定完成前**一律必填**,取占位值 `0`,语义是**未定值**——机制已定、终值归后续的标定(hld §12 #2)。因此在 JSON Schema 里,**缺键与「键存在但取 0」是两种不同的错误**:前者是 `required` 缺失,直接拒;后者通过校验,只影响**面向模型的规则文档怎么渲染**——数值表把未定值渲染成「未定」而不是数字,是文档可见性,不为它引任何判罚逻辑。清单里每一键的标定状态是键自身的一个两态字段,不是一个全局标志位:某个预算上限标定完之后它的终值**可以真的取 0**,那时文档就该显示 0 而不是「未定」。

**派生量双存 + 装载期断言**:生产耗时一类既出现在取值文件里、又由派生式算出的键,**两个都保留**——取值文件是那份数据的真源(缺了它,兵种表的可读性就依赖读者做算术),而派生系数只活在代码里就是第二真源。一致性由**装载期断言**判,不等即拒跑;断言与校验器同在 `apps/cli` 那一个入口(§2.2.5),真源包不交付「这个值算出来是多少」。

**规则版本号三处一致,一致性由机器判定**:版本号由三处名字承担——取值文件 `rulesets/vN.json` 的文件名、规则文档目录名 `docs/rules-vN/`、真源包导出的版本常量——**取值文件内部没有版本键**(同一个值若既在文件名里又在内容里,那就是两处可能各写各的)。三处对不上在装载期拒跑,不静默降级。取值本身由真源包的项目键清单与 `rulesets/*.json` 承担,本文档不复制。

### 7.2 地图 JSON(`maps/*.json`)

```jsonc
{
  "name": "open-clash",
  "size": <正整数>,                 // 网格边长,取值归 maps/*.json,本文档不复制
  "rulesetMin": "v1",
  "terrain": ["...", ...],          // 行字符串,'.'=平原,'#'=墙
  "sites": [ { "id": 1, "kind": "base", "x": 10, "y": 10, "initialOwner": 0 }, ... ],
  "spawnUnits": [ { "owner": 0, "type": "worker", "offset": [0,0] }, ... ],
  "variantSlots": [ [[x,y],[x,y],[x,y],[x,y]], ... ]  // 静态候选轨道清单,见下;机制见 gdd《地图变体》
}
```

**七字段全部必填,并且禁止额外属性**:JSON Schema 对地图设 `additionalProperties: false`,规则集同理(§7.1)——手写 schema 若放行额外属性,那只是一份注释,不是校验。跨字段的自洽(terrain 行长等于 `size`、点位不越界、四重对称)JSON Schema 表达不了,归 map-lint。

- 初始单位配置围绕主基地,由地图声明,引擎不硬编码。
- **map-lint 强制校验**,分两层。**单图层**:四重旋转对称(terrain 与 sites 绕中心 90° 旋转自洽)、点位不重叠且不在墙上、变体槽位是合法轨道。**池层**:地图数满足规则下限、池内 `size` 一致(三张图取同一值;取值由 `maps/*.json` 承担,本文档不复制)、每方开局恰好拥有家附近**最近的一圈**资源点、家门到最近自家矿的**矿路红线**、以及两两墙格 **Jaccard 相似度上限**。校验不过的地图不进地图池。

  几条判据的读法值得写全,因为它们最容易被读成一个更松的形状:

  - **「最近一圈」用 Chebyshev 理论距离,不按绕墙的路径距离**(直接算坐标差,不是网格最短路)。并列**一律判失败**而不是自动 tie-break——任何自动选择都会把一个设计歧义悄悄定死。四方最近一圈的**并集**须由完整的四重轨道构成,那是「四方初始条件对等」可判的那一句;逐方判会误判内圈高危矿(每方各拿一个,一方的最近圈不是整条轨道)。
  - **矿路红线用八向最短路(墙不可通行),与上面那条刻意用不同的尺,不许顺手统一**。两把尺量的根本不是同一件事:红线问「走过去要多少格」,归属问「声明的最近与坐标上的最近是否一致」。红线若也用理论距离,就量不到墙——它判不出「墙把矿路拉长了」,而那正是这条红线存在的理由(采集往返随路长放大),一张矿摆在隔壁、中间隔一道墙绕路很远的图会被放行。归属若反过来改成路径距离,改一堵墙就可能改掉某家的开局矿归属,于是「迭代这张图」变成「每加一堵墙重验四条归属」的排雷——点位归属是**与墙正交**的设计维度,只有理论距离下才成立。矿摆得远不一定是错的,矿走不到才一定是。
  - **两把尺并存是有意的设计,不是过渡状态**;当前这几张真图在两把尺下结论一致(路径不因墙拉伸),所以换尺对它们的零成本**不是**「这把尺无关紧要」的证据——差别只在刻意把矿路绕远的图上才显形。
  - **风格由墙判,不引入自报的 `style` 字段**:一张标着「开阔」而布满墙的图必须挡住。开阔/廊道/要塞只是描述性标签(gdd §4)。
  - **Jaccard 上限是按一道缝定的**:真图两两之间的实测相似度,与「同风格只挪动一处结构」这类最像真实手误的探针之间留着一道缝,阈值就落在这道缝里。**放宽要有理由**,否则这条断言会在第一次压力下退化成摆设。

  **红线与上限的取值归校验器的具名常量**,本文档不复制;当初量到的数字与负对照探针在那些常量的头注里——要让日后想改阈值的人先看见它们。
- **变体槽位的元素形状已定稿**:一条**完整四重旋转轨道的 4 个坐标对**。类型侧是定长 4 元组、schema 侧是 `minItems/maxItems: 4` 加坐标对形状,map-lint 只再判「这 4 格是不是同一条轨道」——**四重对称这条不变量因此从运行时断言挪进了类型层**。取 4 元组而不是「一个代表元坐标」或「一个带语义字段的对象」,理由写在 `MapVariantSlot` 的头注里,那处裁法的家在那里,本文档不复述。
- `variantSlots` 是**静态候选轨道清单**:清单在地图 JSON 里,种子只决定从候选里选中哪些填(§7.3)。它**不是**某个种子上实际填上的那几条——读成后者会以为清单的大小随种子变,而那会直接推翻「地图 + 种子 → 地形是纯函数」。槽位不得压点位及其八邻域、不得压初始落点、不得与地形里已有的墙格重叠,三条都是跨字段判据,归 map-lint。

### 7.3 种子的用途

规则集本身无对局内随机过程,故种子驱动**地图变体**:**候选轨道清单在地图 JSON 里**(§7.2 的 `variantSlots`,静态数据),种子只决定从候选里选中哪些填上墙,以确定性方式(整数 LCG)填充,保持四重对称与点位布局不变。变体只做装饰性微扰,不计入风格多样性(gdd《地图变体》)。地图坐标与槽位设计已定稿并落库(`maps/`);**变体是否参与策略决策由 gdd《开放项》#6 裁决**,本节只管「种子怎么选出候选并填墙」这件事。

### 7.4 冻结脚本存档(`archive/<modelSlug>/<runId>/`)

```
script.ts      # 定版源码,一字不改(FR-6 AC1)
script.js      # 由 gen 包在定版前用 tsc 编译为 script-mode JS;文本 + sha256 入 meta.json
meta.json      # 模型名、模型版本/快照标识、生成日期、协议迭代轮数、完整 prompt(逐轮)、
               # 生成日志、ruleset 版本、校验结果、tsc 版本、script.js 的 sha256、sandbox-runtime hash
```

- 编译责任在 gen 包(定版前完成),engine 不引入 tsc(§2.2.8)。
- `meta.json` 的**形状家归真源包**(§2.2.5),字段随生成管线那一票回填;在此之前本仓没有它的 JSON Schema,读入端不校验它(这是刻意的,不是漏做)。
- runner 启动即校验元数据完整性,缺档**报错退出**(FR-6 AC2,不跳过)。
- 对局输入物化:`runs/<runId>/matches/<combo>-<map>-<seed>/input.json`(4 × 存档路径 + 地图 + 种子 + ruleset 版本 + 各文件 hash)与产物——任意一个对局可凭 input.json 复算(FR-7 AC3、NFR-2)。

### 7.5 回放 JSONL(`matches/<...>/replay.jsonl`)

```
第 1 行   {"type":"meta", schemaVersion, ruleset, quickjsWasiVersion, sandboxRuntimeHash,
           wasiClock, wasiRandomFill, timezoneOffset, mapHash, seed, players:[{model, archiveRef, seat}]}
第 n 行   {"type":"tick", tick, players, units, sites, productions, events:[...], stateHash}
末 行    {"type":"result", rankings, reason, territoryScores}
```

- `schemaVersion` 由 `replay` 包 `CURRENT_SCHEMA_VERSION` 常量承担,跨版本兼容性以它为准(FR-9 AC2)。**它是回放文件格式的版本,不是行的形状**:行(meta / tick / result 三类)的类型与 JSON Schema 归真源包,`replay` 包只做编解码、不再声明行的类型(§2.2.5、§3.1)。这一格曾经有两个家(§2.2.5 说形状在真源包、§3.1 说行格式取自 `replay` 包),按「每个事实只有一个家」留在真源包。
- 每 tick 记录足以绘制完整画面的状态:点位归属、占领进度条、单位位置血量携带、玩家资源。
- **events 事件流**(叙事战报的统一来源):`first-contact`、`site-captured`、`unit-destroyed`(聚合)、`player-eliminated`、`economy-dead`(判定条件由 gdd《经济与生产》定义)、`budget-soft-warning`、`exception`、`victory`。叙事战报生成器只消费 events,不重新解析状态。

## 8. runner 与排名概要设计

### 8.1 对局枚举与座位轮换

- 输入:`season.yaml`(参赛脚本存档目录列表、地图池、种子数 K、并发度、ruleset 版本)。
- 枚举:全部 4 人组合 × M 地图 × K 种子(srs FR-7 AC1);种子值 = 确定性函数(组合、地图、序号),同一对局的输入物化对全体参赛者一致。
- **座位轮换**:把组合内 4 名参赛者按 slug 升序为基准序列,座位 = 基准序列按 `(mapIndex + seedIndex) mod 4` 循环移位。**精确均摊要求 `M × K ≡ 0 (mod 4)`**(地图数通常为 3,故 K 需为 4 的倍数;K 具体取多少由 gdd《开放项》#6 的裁决给出,本节只给均摊条件);不满足时各座位的对局数最多差 1,差额落在同一相对位次——该残留不对称由 §12 的座位胜率统计验证,不做逐座位校正。分配对全体一致且完全确定(FR-7 AC1)。
- 并发:进程池语义的对局子进程池,并发度默认 `min(cpus, 8)`;对局之间互不干扰。

### 8.2 排名(名次积分制)

- 名次由 gdd《胜利与淘汰》的排序规则决定(引擎在 `outcome` 中给出),`runner:ranker` 只做**纯函数记账**:名次分向量由赛季配置给出(`season.yaml` 的 `rankPoints`,默认 `[3,2,1,0]`,**不进 `rulesets/`**——赛制不该经 rules-vN 泄漏给模型);并列名次分 = 并列名次区间分值之和 ÷ 并列人数(并列第 2 → (2+1)/2 = 1.5)。
- 赛季总分 = Σ 对局得分;对局均分排名;Elo 为可选副产品输出,不进主报告标题(FR-8 AC1)。

### 8.3 报告输出(`runs/<runId>/`)

| 产物 | 内容 | 消费者 |
|---|---|---|
| `report.md` | 排名、对局均分、代表性对局叙事、校验失败名单、规则版本标注 | 人类 / 自媒体素材 |
| `report.json` | 每个对局的输入引用 + 名次 + 分数 | 机器复算(NFR-2 AC) |
| `narrative/<对局>.md` | 从 events 生成的叙事战报(时间线:首触、易手、淘汰、经济死亡、终局) | 自媒体文案 |

### 8.4 对局异常的处理

进程崩溃(engine bug)或硬超时 → 标记 `engine-crash` / `nondeterministic-timeout` 并重跑一次;再触发则记入报告的**问题清单并排除出排名**,不静默丢弃(FR-7 AC2)。内存超限判负在报告中披露。

## 9. CLI 设计(统一入口 `modelwar`)

| 命令 | 模块 | 说明 |
|---|---|---|
| `modelwar gen --config models.yaml` | gen | 生成并冻结脚本(可 `--model <slug>` 只跑一个模型的一轮生成) |
| `modelwar run --config season.yaml` | runner | 整轮赛季 + 报告 |
| `modelwar match <input.json>` | engine | 执行一个对局(runner 与调试都走这条路径) |
| `modelwar replay <replay.jsonl>` | apps/cli → `replay` | 终端 ASCII 回放,单步/暂停;只读回放,**不依赖 engine** |
| `modelwar verify <replay.jsonl>` | apps/cli → engine + `replay` | 按 input.json 重新执行,逐 tick hash 比对(CI 调用) |
| `modelwar map-lint <maps/>` | apps/cli | 地图对称性与合法性校验 |

> 唯一 bin 在 `apps/cli`;`index.ts` 只做路由,各子命令 `await import()` 动态加载。库包不含 `bin`。

## 10. 非功能落地

### 10.1 性能(NFR-3)

预算分解:以算例 75 个对局 × 1500 tick ≈ 11 万 tick 计。单 tick 成本 = 4 次快照构建(单次拷贝进 VM) + 4 次串行 VM 执行 + 结算(≤ 数百对象);宿主↔VM 跳边界次数为 O(1)/tick,主要成本在快照拷贝与 VM 执行。若超标,优化优先级:**先测沙箱开销**(快照改按需字段拷贝)→ 再调对局子进程并发度。任何优化不得改变结算结果(stateHash 回归守护)。

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
| 5a | TypeScript 7.0 GA 时点 | **已收口**:7.0.2(2026-07-08 GA,Go 实现,`tsgo` 名已取消)为精确锁版,见 ADR-0002 锁定版本表。本项关闭。 |
| 5b | 类型感知 lint 的可用性与耗时 | **已收口**:oxlint-tsgolint 已 stable(oxlint 1.86.0 `--help` 无 experimental 标记),进 `check:types` 不再并行试跑;版本耦合形状 `7.0.<tsPatch><golintPatch>` 由 `coupling` 断言脚本强制(§2.2.3)。耗时见 §2.2.7 实测表(只此一处,不在此复述)。本项关闭,后续只剩随仓库规模重测。 |
| 5c | oxfmt 0.x 风险 | **已收口为接受风险**:官方称 JS/TS 已 100% 通过 Prettier conformance,未兑现的只是 1.0 发布;由 caret + lockfile + `oxfmt --check` 门禁兜住(ADR-0002)。**不设降级到 Prettier 的退路**。本项关闭。 |
| 6 | 快照进出 VM 的拷贝粒度优化 | §10.1,先测后优化 |
| 7 | 回放体积与夜间全量扫描的存储/IO 方案 | 每 tick 全量状态的体量未评估 |
| 8 | 沙箱行为五条结论的复验 | §5 上表五条只对 `quickjs-wasi@3.6.2` 成立;实现真实沙箱执行器的 ticket 落地时第一条验收即按当时版本组合重跑五条并写回 §5。在那之前升级条款为空头承诺(§5.0 “升级条款”段)。 |
