# H 生成管线:脚本生成与冻结存档

Status: ready-for-agent

图上的节点 H(`docs/diagrams/v0-milestone-dag.md` §4)。工作单元 = 一个 `.scratch/generation-pipeline/`,走 `grill-with-docs`(已完成,二十七问,收口记录见本目录 `grill.md`)→ `to-spec`(本文件)→ `to-tickets` → `implement`。判据之家:`docs/hld.md` §2.2.6 / §7.4 / §9、`CONTEXT.md`;条款在 `docs/srs.md` FR-5 / FR-6;渲染契约在 `docs/rules-v1/`。词表用 `CONTEXT.md` 既有词条(冻结脚本／基准脚本／校验失败记录／对局／回放／报告／模型配置以外的实现词不进 glossary)。**H 是 I 的唯一 gate**,M3 是 V0 汇合条件之一。

## Problem Statement

今天没有任何一条路径能把「一份模型配置 + 一份规则契约」变成**可参赛的冻结脚本**。

`prompts/` 只有 `.gitkeep`,`models.yaml` 全仓不存在,`packages/gen` 只有 27 行、只会把两份文档拼成一段字符串,`apps/cli` 里 `gen` 命令已登记却指向一个不存在的处理函数——`modelwar gen` 现在只会打印「未实现」并返回 1。`archive/` 里只有 `.gitkeep`:**全仓没有一份冻结脚本或 `meta.json`**。这意味着:

- **对局装载段(`modelwar match`)拿不到任何脚本**。它的缺档判据(`archive-files-incomplete`)只会对空目录报红;即便强行塞脚本进去,`meta.json` 的十一项也没人写得出——`scriptSha256`、`sandboxRuntimeHash`、`ruleset` 三处一致与 `prompts.length === protocolRounds` 这些断言,尚无任何真实产物可校验。
- **赛季开不了跑**。I 的枚举、座位轮换、排名与报告全部等 H;M3 是 V0 的汇合条件。
- **盲写实证没有沉淀**。`.scratch/rules-landing/blind/` 与 `.scratch/contract-closure/blind/` 两次证明「单模板 + 变量、只回喂校验错误」可行(6 舱契约零违规),但那套是舱外手工流程:`blind-run.sh` 借 bwrap 现起一个 pi 外壳代发模型请求,`static-check.ts` 是并行于官方校验器的一条独立判据。**协议的回喂分支两次都未被触发**(0 次契约回喂),它的「救回能力」从未被测量。

## Solution

交付一条**离线、唯一允许联网、永不进对局进程**的生成管线,由一条命令收口:`modelwar gen --config models.yaml`。

输入是 `prompts/` 下的 prompt 模板、`docs/rules-vN/` 的契约文档、`models.yaml` 的模型配置;流程是「组装 prompt → 调模型 → tsc 编译 + 静态校验 → 失败则**只**把校验错误回喂、上限 N 轮 → 通过则冻结」。输出分两类:

- **冻结脚本**——`archive/<modelSlug>/<runId>/` 三件套(`script.ts` / `script.js` / `meta.json`),原子落盘、进版本库,历史对局在新克隆上凭它复算;
- **校验失败记录**——跑满轮数仍未过校验(或传输重试耗尽)的模型,写 `archive/<modelSlug>/failed-<runId>.json`,供报告侧读成失败名单;`archive/` 只收通过校验的。

管线全程**只回喂静态校验错误**,代码里不存在把对局结果传回生成环节的路径——这条由可执行门禁固化,而不是靠散文承诺。

## User Stories

1. 作为赛季组织者,我只改一份配置就能把一个新模型纳入本季,不必改任何代码,这样「新模型发布后第一时间横向对比」才成立。
2. 作为赛季组织者,我用一条 `modelwar gen` 命令生成并冻结全部参赛脚本,不必手工跑任何脚本。
3. 作为赛季组织者,我能 `--model <slug>` 单跑一个模型,以便排障而不重跑整批。
4. 作为赛季组织者,一个模型失败不会中断整批,其余模型照常产出,我在结束时拿到汇总退出码。
5. 作为赛季组织者,我能看到每个失败模型**为什么**失败(tsc 不过 / 契约校验不过 / 传输耗尽)。
6. 作为赛季组织者,我重复运行不会覆盖旧存档:每次生成落在新的时间戳 `runId` 目录里,旧冻结脚本原样不动。
7. 作为平台维护者,我改提示词只改 `prompts/` 下的模板数据文件,不改 gen 代码。
8. 作为平台维护者,我改规则契约只改 `docs/rules-vN/`,下一次生成自动用上新契约,不必改代码、不必重建任何产物。
9. 作为平台维护者,我要能在存档里看到某次生成用的是哪一版规则、哪一版编译器、哪个沙箱 runtime,以及逐轮的完整 prompt。
10. 作为平台维护者,我要模型生成时**只能**收到规则契约与校验错误;任何对战结果都不得进入生成环节,且这条有门禁兜住。
11. 作为报告读者,我能从报告的失败名单回溯到该模型的校验失败记录(逐轮 prompt 链、生成日志、最终诊断)。
12. 作为对局装载段,我拿到的每份存档三件套都完整、`script.js` 的 sha256 与 meta 记载一致、`ruleset` 三处一致、`prompts.length` 等于 `protocolRounds`,否则拒跑。
13. 作为复算者,我能凭 `input.json` 在任意一份冻结脚本上复算历史对局,且编译产物字节稳定。
14. 作为 CI,我要生成管线的自动化测试**完全不依赖网络与凭证**,这样在无密钥的环境里也能跑。
15. 作为接入新模型的人,同端点族的模型我只加一条配置;遇到新的端点族才需要动适配层。
16. 作为运维者,网络抖动(429 / 5xx / 超时)与模型输出截断都走退避重试,且**不消耗**协议轮数——「上限 N 轮」始终指校验驱动的迭代。
17. 作为审计者,我能在存档里读到第 1 轮以及每一轮回喂后**完整发出**的 prompt 文本。
18. 作为赛季组织者,我不用为「生成到一半崩了」担心:不会留下半截存档目录,失败只会留下失败记录。
19. 作为平台维护者,脚本体积上限只在**冻结期**硬拦;迭代期它只提示,不阻断模型继续修。
20. 作为平台维护者,凭证只从环境变量读、绝不写进仓库;`.env` 只是本机便利,不是仓库的一部分。
21. 作为平台维护者,我能对生成管线的核心协议(≤N 轮只回喂校验错误)有**回归测试**,而不只是一次性实证。
22. 作为平台维护者,当模型的输出触发校验失败时,回喂的内容只有校验器面向模型的那段文本,不含引擎内部诊断、更不含对局数据。
23. 作为报告侧,我能只靠失败记录文件就渲染出「校验失败名单」,不需要重跑生成。
24. 作为赛季组织者,我要 `modelwar gen` 帮助里能看到它接受 `--config` / `--root` / `--model`。
25. 作为后续节点(I / L)的开发者,我要 H 的产物边界清楚:存档、失败记录、退出码是它的出口;选模、输入物化、报告、性能与存储不是它的职责。

## Implementation Decisions

### 范围与完成判据
- H 交付**管线代码 + 至少一次真实端到端**(1 个真实模型跑出真三件套且过 `validateArchiveMeta`)。≥4 个参赛模型的**选择**、`input.json` 物化、硬超时重跑剔除、回放读入端接线归 **I**。
- 多模型 v0 **串行**(一次一个,模型内并发固定 1),不做 `--concurrency`。失败隔离:单模型失败不中止整批;退出码「全部成功=0,任一失败=1」;成功存档与失败记录照写。

### 模块与接口
- **`@model-war/gen`**(改造):从「只做文档拼接的空壳」扩成整条管线。依赖方向单向 `gen → schema`;永不 import engine/runner/replay 的运行时。
- **`apps/cli`**(改造):把已登记的 `gen` 命令接到 gen 的真实处理函数;根目录解析复用 `match` 的约定(默认 cwd,`--root` 覆盖),`--config` 相对根。gen 启动时若 `<root>/.env` 存在即 `process.loadEnvFile()`,凭证只经 `process.env[credentialEnvVar]` 读。
- **`prompts/base.md`**(新增,数据文件):**薄壳 + 指针清单**。占位符 `{{contract}}`(= 契约读入两份文档拼接)与可选 `{{strategy}}`;硬约束只写「见 `rules.md` §X / `api.md` §Y」,**不复制判据文本**——真源仍是 `docs/rules-vN`。
- **`models.yaml`**(新增,入库;内容非密钥):只登记**本季参赛集**。字段:`slug`、`endpointFamily`(`chat-completions` / `messages` / `responses`)、`baseUrl`、`modelId`、`credentialEnvVar`,可选 `contextLength`、`protocolRounds`、`strategy`、`params`。**类型与加载校验是 gen 包私有**,不进 `schema` 的五类数据形状(那不是跨进程交换的配置)。
- **校验器**(不改,消费):以子进程形态调 `packages/tools` 的静态校验器源码入口,契约是「`<产物文件> --max-bytes <N> --phase iteration|freeze`,stdout = 面向模型的文本,退出码 = 放行/拦」。**不给 `tools` 补 bin**。
- **编译步骤**(新增,在 gen 内):每次生成派生一份临时脚本 tsconfig(只覆盖 `files` / `outDir` / `rootDir`,`extends` 仓库根的 `tsconfig.scripts.json`),`spawn tsc -p <临时配置>` 产出 script-mode JS;不改动仓库里那份契约配置;`meta.tscVersion` 填实际调用到的版本(ADR-0002 锁 7.0.2)。编译诊断与静态校验诊断**同池计入轮数**,逐轮在日志里分栏标 `kind`。

### 模型客户端(唯一新缝)
- gen 内定义端口,形状仿 `SeatRunner` 的「接口 + 真/桩适配器」:

```ts
interface ModelClient {
  send(messages: readonly ChatMessage[], params: ModelParams):
    Promise<{ text: string; finishReason: string; usage: unknown }>;
}
```

- **真实适配器**:OpenAI-compatible HTTP 客户端 + **三个端点族分支**(`chat-completions` / `messages` / `responses`),**不引厂商 SDK**——本期全部已开通模型都落在这三族,按厂商再包一层只是让依赖面随节点扩张。
- **桩适配器**:可编程回放,供测试与本地演练;CI 无凭证,所有自动化测试走桩 + 本地 fixture。
- 无状态全量重发 `messages`,不依赖任何 provider 会话状态(才可复算、可审计)。

### 协议与轮数
- `protocolRounds` = **模型调用总轮数,含初次生成**(第 1 轮 = 初次生成,之后每轮回喂一次校验错误);`meta.prompts` 逐条记该轮**完整发出**的 prompt 文本,长度与 `protocolRounds` **相等**(既有冻结形状与读入端断言,勿改)。上限可配(默认 5),不是「5 次回喂」。
- 回喂内容**只有**校验器 stdout(面向模型的文本);不含引擎诊断、不含任何对局信息。
- 传输层错误(429 / 5xx / 超时)与截断(`finishReason = length`)走指数退避**重试同一轮、不消耗协议轮数**;重试耗尽记为另一类失败。
- 退避参数(初始间隔 / 倍数 / 上限 / 最大重试)是 **gen 内部常量**,不进 `rulesets/*.json`。
- 通过判据 = tsc 零错误 **且** 迭代期无 blocking 违规;只剩非 blocking 提示也算通过。体积上限迭代期只提示、冻结期以 `--phase freeze --max-bytes <rulesets 取值>` 硬拦。

### 存档与失败记录
- **原子落盘**:三件套先在临时目录组装,冻结期校验全过才 rename 到 `archive/<modelSlug>/<runId>/`;目标已存在即拒绝。失败不留半截目录——「目录存在 ⇔ 三件套完整」是不变量。
- `runId` 是生成时间戳;**一跑一目录、旧目录不删**;`archive/` 必须入库。
- **失败品不写 `archive/`**:写 `archive/<modelSlug>/failed-<runId>.json`,含逐轮 prompt 链 + 生成日志 + 最终诊断 + 失败分类 `tsc` / `contract` / `transport`。
- `meta.generationLog` **不改形状**(守十一键冻结):每条一行序列化 JSON 字符串,逐轮记 `{ round, kind: "tsc" | "contract", model, params, usage, finishReason, errorCodes }`。

### 契约读入
- 每次运行从 `<root>/docs/rules-<RULESET_VERSION>/{rules.md,api.md}` 读盘,不嵌入副本;目录名 / 文件缺失或与 `RULESET_VERSION` 不符即报错退出。

### AC1 的固化(可执行门禁,不是散文)
- depcruise 规则:`gen` 不得依赖 `engine` / `runner` / `replay`(`engine` 一条已存在,补另两条);
- gen 包内一条源码级测试:gen 源码不得出现 `runs/`、`.result.json`、`MatchResult` 等对局结果符号。

### 不改的东西
- `packages/schema` 的 `archive-meta` 十一键**形状不动**,gen 只填值;`packages/tools` 的校验器与 `tsconfig.scripts.json` 不动(消费方)。

## Testing Decisions

**好测试的标准**:只断言外部可观察行为——写出的文件与字节、退出码、`meta.json` / 失败记录的内容、桩观察到的请求。不断言内部函数调用、私有字段或实现步骤。

**缝(新缝只有一个)**:
1. **`ModelClient` 端口——唯一新缝**。全部管线行为经此注入可编程桩;桩按序回放脚本与校验失败。
2. **CLI 子进程缝(既有,复用)**:一条接线冒烟,`modelwar gen --config models.yaml --root <临时根>`,端点指向本地假服务。
3. 校验器与 tsc 走**既有子进程缝**,不 mock。

**要测的模块与用例方向**:
- `@model-war/gen` 管线(经端口 + 临时根 fixture):
  - 顺利路径:桩回一个合法脚本 → 产出 `archive/<slug>/<runId>/` 三件套、`meta` 十一项齐、`prompts.length === protocolRounds === 1`、退出码 0。
  - **回喂探针(核心回归)**:桩第 1 轮回含 blocking 违规的脚本、第 2 轮回合法脚本 → 断言回喂确实发生、`protocolRounds === prompts.length === 2`、日志记到两轮。
  - 轮数用尽:桩每轮都回违规脚本 → 写 `failed-<runId>.json`、**不建** `archive/<slug>/<runId>/`、退出码非零。
  - 传输失败:桩抛 5xx / 超时 → 同一轮重试、轮数不涨;耗尽 → 记 `transport` 失败。
  - 截断:桩回 `finishReason = length` → 重试同一轮,不把半截代码回喂。
  - 原子性:冻结期校验失败 → 目标目录不存在、无半截三件套。
  - 只回喂校验错误:桩收到的后续 user 消息不含任何非校验文本。
- 模板组装:`assemblePrompt` 的纯函数直测(变量注入、缺省策略、契约指针)。
- `models.yaml` 加载:字段缺失 / 端点族未知 / 缺 `credentialEnvVar` → 清晰报错。
- HTTP 适配器:契约测试打到**本地假端点**,断言三端点族的请求形状与响应映射(网络缝,与端口同源)。
- CLI 接线:子进程冒烟 + 帮助文本含三条选项。
- AC1:depcruise 规则 + gen 源码级断言。

**先例(照抄它们的形态)**:
- 纯函数直测:`packages/gen/src/assemble-prompt.test.ts`。
- 端口 + 真/桩适配器:`packages/engine/src/runner/index.ts` 的 `SeatRunner` 与 `packages/engine/src/runner/stub.ts`;测试内假实现见 `packages/engine/src/processor/observations.test.ts`。
- 子进程退出码/stdout 断言:`packages/tools/src/validate/run-validate-script.test.ts`。
- 临时根 fixture + 打单文件 spawn CLI:`apps/cli/src/cli.test.ts`。
- 临时目录里跑真 tsc(派生 `run.json`):`packages/tools/src/script-compile-config.test.ts`。
- 真源只读 idiom:`packages/engine/src/run-match.test.ts`(`read("rulesets/v1.json")`)。

## Out of Scope

- 选 ≥4 个真实模型、参赛模型数、`input.json` 物化、硬超时 / 崩溃重跑与剔除、回放读入端接线 → **I**。
- 校验失败名单进报告、`report.md` / `report.json` / 叙事战报 → 报告侧(I / FR-8);H 只产出失败记录。
- 每赛季自动重标流水线(ADR-0009 失效事件)、NFR-3 墙钟取值、存储 / IO、快照拷贝粒度、`check:selfproof` 桩口径 → **L**(H 的 grill 顺手把这笔债登记进了 DAG 的 L 行)。
- 规则文档 / 数值表漂移检查 → C 建的 tools(ADR-0003),不是 H。
- `docs/gdd.md` 的两条规则侧开放项(参赛脚本整数闭包、`progress` 反推)→ **规则侧**,H **只消费,不裁定**。
- 给 `packages/tools` 补 bin、改 `archive-meta` 形状、引厂商 SDK、做跨模型并发。

## Further Notes

- **两处 grill 修正了交接单的假设**:① `protocolRounds` 含初次生成(读入端 `apps/cli/src/validator.ts` 是严格相等断言,盲写夹具 `protocolRounds = prompts.length = 1` 佐证),所以「≤5 轮」= 总调用 ≤5;② 两批盲写舱的 `PROMPT.base.md` 逐字相同、协议**从未被触发**(6 舱 0 次契约回喂),所以只升格模板形态,`blind-run.sh` / `static-check.ts` 留在 `.scratch` 作证,回喂链改由**测试票**长期兜底。
- **失败记录是新路径**,已在 `docs/hld.md` §7.4 落一行(守「每个事实只有一个家」)。
- **文档已随 grill 更新**:`CONTEXT.md` 新增《校验失败记录》;`docs/hld.md` §2.2.6 / §2.2.8 / §3 / §7.4 / §9;`docs/adr/0003` 措辞对齐;`docs/diagrams/v0-milestone-dag.md` L 行登记重标债。
- **端点事实**:本期只接一家聚合商 Command Code;凭据 `COMMAND_CODE_API_KEY` 在 `.env`(gitignore);非密钥事实(端点 / 模型标识 / 上下文)在 gitignore 的 `.modelwar-providers.md` 与 `.modelwar-models.json`(85 模型 catalog),**填完 `models.yaml` 后删除**,不把 85 条当配置长期维护。`modelId` 需带 provider 前缀;Claude 系走 `/messages`、其余走 `/chat/completions`,并支持 `/responses`。
- H 的 e2e 用哪个真实模型,在 to-tickets 阶段从 catalog 里挑,建成 `models.yaml` 的格式范例。
