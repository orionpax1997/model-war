# I 赛季调度:排名与报告

Status: ready-for-agent

图上的节点 I(`docs/diagrams/v0-milestone-dag.md` §4 节点表 `:179`,波次 8 `:236`),主干链 `E ✅ F ✅ G ✅ R ✅ K ✅ H ✅ → **I** → L → V0`(`:196`)。工作单元 = 一个 `.scratch/season-scheduler/`,走 `grill-with-docs`(已完成,五轮收口记录见本目录 `grill.md`)→ `to-spec`(本文件)→ `to-tickets` → `implement`。判据之家:`docs/hld.md` §2.1 / §3.1 / §7.4 / §7.5 / §8.1-§8.4 / §9 / §11;条款在 `docs/srs.md` FR-7(`:83-87`)、FR-8(`:89-94`)、v0 验收第 3 条(`:139`);估算口径 `docs/fsr.md:80`(M4,1 周)。**I 是当前主干唯一未开的交付格,`I --> L` 是 L 的最后一笔账;它是 M4★ 的承载格。** 词表用 `CONTEXT.md` 既有词条。

## Problem Statement

今天没有任何一条路径能把「≥4 份冻结脚本」变成**一场可复算的赛季 + 一份报告**。

- **`packages/runner` 是空壳**。`src/index.ts`(53 行)只导出 `MatchUp`(`:11-15`:`{ ruleset, seats: [string ×4] }`)、`enumerateMatchUps`(`:23`,纯组合枚举、四重循环、座位 = slug 升序)与模块私有的 `fourSeatsAt`(`:41`)。**座位轮换、地图池、种子数 K 一概没有**——文件头注 `:4-5` 与 JSDoc `:21` 自己写明「地图 × 种子 × 座位轮换的展开随调度器落地」。对照 hld §8.1(`:774-779`)的 `(mapIndex+seedIndex) mod 4` 与 `M×K ≡ 0 (mod 4)` 均摊条件,现有实现只做了组合枚举这一段。测试(`enumerate-match-ups.test.ts`,6 例)覆盖组合数量与顺序无关性,**零**座位轮换、零地图/种子、零均摊断言。
- **`runSeason` 全仓不存在**。`apps/cli/src/commands.ts:60` 把 `run` 子命令的 `handler` 登记为 `"runSeason"`、`provider` 为 `@model-war/runner`,但 `@model-war/runner` 没导出它;`apps/cli/src/index.ts:114-120` 因此走「未实现」分支,打 `modelwar run: 未实现——@model-war/runner 尚未导出 runSeason。` 并返回 1。`apps/cli/src/cli.test.ts:33` 的 `UNIMPLEMENTED = ["run"]` 把这条钉住。**六命令 5/6 已接线,唯一缺口是 `run`。**
- **`input.json` 生产端从未落地**。形状真源已存在(`packages/schema/src/match-input.ts` 的 `MatchInput` `:50-60`,键集恰为 `archives` / `map` / `mapSha256` / `ruleset` / `seed`,全必填、拒任何赛季字段——`validator.test.ts:1160-1163` 逐条拒掉 `season` / `seedCount` / `rankPoints` 等七项),读入端 `apps/cli/src/match/assemble.ts:200-234` 已接线,但**全仓没有一处生产代码写它**(只有测试夹具 `cli.test.ts:372`)。runner 是它的预期归属。
- **回放没有读入端**。`parseReplay` 全仓不存在;`readLinesOf`(`packages/replay/src/render.ts:51`)是模块私有 `const`,唯一调用点是 `render.ts:199`;`render.ts:17` 的注释写着「等真源包落库,把 `parseReplay` 接到 `readLinesOf` 那一处即可」。
- **没有赛季可跑**。`archive/` 下只有 1 个模型的 1 次生成(`deepseek-v4-flash/2026-10-08T05-12-42-057Z`);`runs/` 被 `.gitignore:28-29` 排除(赛季产物属本地产物,不入库)。

## Solution

交付 `packages/runner` 的三模块(`scheduler` / `ranker` / `reporter`)与 `run` 子命令的接线,由一条命令收口:`modelwar run --config season.yaml`。

输入是 `season.yaml`(参赛存档引用、地图池、种子数 K、并发度、`rankPoints`、ruleset 版本、`masterSeed`)与 `archive/` 下的冻结脚本;流程是「枚举组合 × 地图 × 种子 × 座位 → 每局物化 `input.json` → 每局 spawn 一个 `modelwar match` 子进程 → 只认退出码判定成败 → 异常重跑一次、再触发则剔除 → 名次积分纯函数记账 → 产出报告」;输出到 `runs/<runId>/`:

- **`input.json` + 对局产物** —— `runs/<runId>/matches/<combo>-<map>-<seed>/`,任意一局可凭 `input.json` 复算(FR-7 AC3 / NFR-2);
- **`report.md`**(人类 / 自媒体)、**`report.json`**(机器复算)、**`narrative/<对局>.md`**(从 events 生成的叙事战报);
- **校验失败名单**(读 gen 侧 `archive/<slug>/failed-<runId>.json`)与**对局问题清单**(§8.4 的 crash / 超时 / 内存披露),两节分开。

赛季的 API 成本**只发生在 `gen` 阶段**(冻结脚本);对局阶段跑的是 QuickJS 里的冻结 `script.js`,**零 API 调用**。因此「真实赛季」的可行性由选型与 `protocolRounds` 决定,放大 N 与 K 只吃 CPU。

## User Stories

1. 作为赛季组织者,我只改一份 `season.yaml` 就能换一批参赛存档、一批地图、一个种子数,不必改代码。
2. 作为赛季组织者,我用一条 `modelwar run --config season.yaml` 跑完整轮并拿到报告,无人工干预。
3. 作为赛季组织者,座位分配对全体参赛者一致且完全确定:组合内 4 名按 slug 升序为基准序列,座位 = 基准序列按 `(mapIndex+seedIndex) mod 4` 循环移位,**精确均摊要求 `M×K ≡ 0 (mod 4)`**,不满足时各座位对局数最多差 1 且差额落在同一相对位次。
4. 作为赛季组织者,对局可并发执行、互不干扰(并发默认 `min(cpus, 8)`,可在 `season.yaml` 覆写)。
5. 作为赛季组织者,一局子进程崩溃或硬超时不会拖垮整轮:该局重跑一次,再触发则记入问题清单并**排除出排名**,不静默丢弃。
6. 作为赛季组织者,我看到的名次是**名次积分制**:每场按最终名次记分(超时按领土分定名次,同分并列),并列名次分 = 并列名次区间分值之和 ÷ 并列人数。
7. 作为赛季组织者,我不被不存在的能力分心:v0 **不做 Elo**,只保证主排名。
8. 作为赛季组织者,我被拦住时是**明确拒绝**而不是拿到一份混了规则版本的假排名:赛季声明单一 ruleset,存档 `meta.ruleset` 不一致即报错退出。
9. 作为报告读者,我拿到 Markdown 报告(排名、对局均分、代表性对局叙事、校验失败名单、问题清单、规则版本标注)与 JSON 原始数据(每场输入引用 + 名次 + 分数)。
10. 作为报告读者,我能从校验失败名单回溯到该模型的校验失败记录(逐轮 prompt 链、生成日志、最终诊断)。
11. 作为复算者,我凭 `report.json` + `archive/` + 种子就能独立重算名次积分,结果与报告一致(NFR-2)。
12. 作为复算者,任意一局的输入被完整物化(脚本存档引用 + 地图 + 种子 + ruleset 版本),可凭 `input.json` 复算。
13. 作为报告侧,我能只靠 `events` 生成叙事战报(时间线:首触、易手、淘汰、经济死亡、终局),不重新解析状态。
14. 作为 CI,我要 fixture/stub 赛季的自动化测试**完全不依赖网络、凭证与真实模型**。
15. 作为赛季组织者,我要在一次真实赛季里把「≥4 个真实模型」跑通并留证,证明 M4 的交付不是空壳。
16. 作为后续节点 L 的开发者,我要 I 的产物边界清楚:枚举 / 调度 / 排名 / 报告 / `input.json` 物化是它的出口;NFR-3 阈值标定与复算链语义不是它的职责。

## Implementation Decisions

### 范围与完成判据
- I 交付**调度器 + 纯函数排名 + 报告 + 六命令接线收尾**,外加**一次真实赛季**(≥5 个真实模型冻结 + 一整轮 + 报告留证)。
- 代码验收走 **fixture/stub 赛季**(确定性、零 API 成本、可进 CI);真实赛季是**收口验证票**,不进 CI。两者不是二选一。
- NFR-3 的硬阈值 `X` 归 **L** 标定;I 只保证「一台普通开发机、无人工干预跑完整轮」,并在收口时产出墙钟读数供 L 用。
- **统计显著性不在 v0 验收口径**:报告里不得宣称名次可信;但 N=5 下每模型 48 局,已足以支撑「机制可跑通」之上的展示性排名。

### 参赛集与规模(本季定案)
| slug(存档目录名) | modelId | lab | contextLength |
|---|---|---|---|
| `deepseek-v4-flash` | `deepseek/deepseek-v4-flash` | DeepSeek | 1,000,000 |
| `deepseek-v4.1-flash` | `deepseek/deepseek-v4.1-flash` | DeepSeek | 1,000,000 |
| `gpt-6-luna` | `gpt-6-luna` | OpenAI | 1,050,000 |
| `mimo-v2.6-flash` | `xiaomi/mimo-v2.6-flash` | Xiaomi | 1,048,576 |
| `muse-spark-1.3-contributor` | `meta/muse-spark-1.3-contributor` | Meta | 1,048,576 |

- 全部 Command Code 聚合、`endpointFamily: chat-completions`、`baseUrl: https://api.commandcode.ai/provider/v1`、`credentialEnvVar: COMMAND_CODE_API_KEY`;五条均已**实测 200**(GOAT 套餐内),非纸面推断。
- `N=5`、`M=3`(`maps/` 现有 `corridor-split` / `fortress-core` / `open-clash`)、`K=4`(DAG `:179` 由 A 定死)。`M×K = 12 ≡ 0 (mod 4)` ✓。
- 对局总数 = `C(4,5) × 3 × 4 = 60`;每模型出场 `C(3,4) × 3 × 4 = 48` 局。
- **五条 `strategy` 注入同一句**(赛模型,不赛策略;策略是常量才赛得出模型差异)。旧的 `deepseek-v4-flash` 从「格式范例」升格为参赛集一员。

### 模块与接口
- **`packages/runner`**(改造,一包三模块):`src/{scheduler,ranker,reporter}.ts`,依赖方向单向 `runner → schema`(不得 import engine;也不新增 `runner → gen` 的边)。
- **`enumerateMatchUps`(原地扩展)**:签名从 `(players: readonly string[])` 扩为接收参赛存档引用、地图池与种子数,产出**带座位轮换的完整对局元组** `{ ruleset, seats: [archiveRef ×4], map, seed, comboId }`。座位轮换是纯函数:`(mapIndex+seedIndex) mod 4` 循环移位,基准序列 = 组合内 slug 升序;`M×K ≡ 0 (mod 4)` 断言随枚举器一起测。现有 6 个用例随之更新(不是新增第二处枚举)。
- **`ranker`(纯函数、独立成票、先行)**:输入 = 每局名次与 `rankPoints`,输出 = 每模型总分、有效局数、对局均分、排名。并列名次分 = 区间分值之和 ÷ 并列人数(并列第 2 → `(2+1)/2 = 1.5`);`rankPoints` 固定长度 4(四方对局),默认 `[3,2,1,0]`、可覆写、**不进 `rulesets/`**;**对局均分分母 = 有效局数**(剔除失败局后),并同留有效局数以暴露小样本;**v0 不做 Elo**。
- **`scheduler`**:枚举 → 每局物化 `input.json` → spawn `modelwar match <input.json>` → 收集退出码与产物 → 异常重跑/剔除 → 交给 ranker。
- **`reporter`**:`report.md` + `report.json` + `narrative/<对局>.md`(每局都生成;`report.md` 只引用代表性几篇)。
- **`apps/cli`**(改造):把 `run` 子命令接到 `runSeason`;从 `cli.test.ts:33` 的 `UNIMPLEMENTED` 移除 `run`;根目录解析复用 `gen`/`match` 的约定(默认 cwd,`--config` 相对根)。`gen` 启动时若 `<root>/.env` 存在即 `process.loadEnvFile()`(既有行为,`run` 不联网故不需要)。
- **`failure` 形状下沉到 `packages/schema`**(有意的形状搬迁):把 `FailureRecord`(`packages/gen/src/failure.ts:48-72`,键序 model / modelVersion / generatedAt / runId / ruleset / classification / protocolRounds / prompts / generationLog / diagnostics / message)与 `FAILURE_RECORD_PREFIX` 迁到真源包,`gen` 反向依赖 `schema` 的类型;报告侧从 `schema` 读,**不新增 `runner → gen` 边**(hld §2.2.5 / §7.5「形状家归真源包」的既有铁律,`archive-meta` / `replay-line` / `match-input` 三处已在 `schema`)。

### `season.yaml`(真源 = `packages/runner` 的 zod schema)
```yaml
masterSeed: "2026-m4"            # 必填;决定全部对局种子
ruleset: v1                      # 必填;赛季唯一规则版本
concurrency: 8                   # 选填;默认 min(cpus, 8)
rankPoints: [3, 2, 1, 0]         # 选填;默认 [3,2,1,0]
maps: [corridor-split, fortress-core, open-clash]   # 地图池(引用 maps/ 下的 slug)
seeds: 4                         # 必填;K,须满足 M×K ≡ 0 (mod 4)
participants:                    # 必填;参赛存档引用,下标即 playerIndex
  - archive/deepseek-v4-flash/<runId>
  - archive/deepseek-v4.1-flash/<runId>
  - archive/gpt-6-luna/<runId>
  - archive/mimo-v2.6-flash/<runId>
  - archive/muse-spark-1.3-contributor/<runId>
outputDir: runs/<runId>          # 选填;默认 runs/<新 runId>
```
- schema 用 zod 定义在 `packages/runner`,配一份 `season.example.yaml` 作格式范例;hld §9 只写「`modelwar run` 读 `season.yaml`」的契约与字段意图,**不复制 schema 细节**。
- `(mapIndex+seedIndex) mod 4` 的轮换算法是**调度器物化期**的事,不进 `input.json`(hld `:755`)。

### 对局输入物化
- 路径:`runs/<runId>/matches/<combo>-<map>-<seed>/input.json`(`<combo>` = 组合序号 `c<k>`,`<seed>` = 序号 `s<k>`,确定性命名)。
- 内容**恰为 `MatchInput`**(`archives` / `map` / `mapSha256` / `ruleset` / `seed`,五项全必填、不加任何赛季字段);哈希取每座存档的 `script.js` / `meta.json` 各一份与地图一份,**不含 `script.ts`**;**座位由 `archives` 的下标承载**(下标即 `playerIndex`)。
- 种子 = `seed = H(masterSeed, combo, mapIndex, seedIndex)`(确定性函数);写进 `input.json`,使任意一局可独立复算。
- 存档完整性**复用同一条校验路径**(`validateArchiveMeta`,`apps/cli/src/match/assemble.ts:287` 是唯一生产调用点),**不另写**;缺档报错退出(FR-6 AC2)。

### 并发、退出码与异常
- **每局一个 `modelwar match <input.json>` 子进程**,并发上限 `min(cpus, 8)`;调度器**只认退出码**(hld `:811-823`),真源 `apps/cli/src/exit-codes.ts`(`EXIT_OK=0` / `EXIT_USAGE_OR_VALIDATION=1` / `EXIT_ENGINE_FAULT=2` / `EXIT_NONDETERMINISTIC_TIMEOUT=3` / `EXIT_INTERNAL=4`)。
- 退出码 **2(engine-crash)/ 3(nondeterministic-timeout)** → 重跑一次;再触发 → 记入**对局问题清单**并**排除出排名**。硬超时复用既有的 `wallClockHardTimeout` 口径,不另造阈值。
- 退出码 **1 / 4** → 视为赛季级失败,**中止并报错退出**(不静默剔除;装载期校验错误本应在物化前就拦住)。
- 「一份完全正常的对局可带异常出局的席位」——规则内结果一律 0,绝不被 §8.4 的崩溃条款误判。
- 内存超限判负是**正常结果**(exit 0),在报告中披露。

### 报告
| 产物 | 内容 |
|---|---|
| `report.md` | 排名、对局均分、代表性对局叙事、**校验失败名单**、**对局问题清单**、规则版本标注 |
| `report.json` | 每场对局的输入引用 + 名次 + 分数;每模型的赛季总分 / 有效局数 / 对局均分;ruleset 版本;两份名单的机器可读字段 |
| `narrative/<对局>.md` | 从 `events`(七种:`first-contact` / `site-captured` / `unit-destroyed` / `player-eliminated` / `economy-dead` / `exception` / `victory`)生成的时间线,**每局都生成** |

- **叙事只消费 `events`,不重新解析状态**(hld `:790`)。
- **两份「失败」分两节,不合并**:「校验失败名单」= gen 侧 `failed-<runId>.json`(没参赛资格);「对局问题清单」= §8.4 的 crash / 超时 / 内存披露(参赛了但被剔除/披露)。处置不同,合并会误导读者。

### 规则版本隔离(前置拒绝,非分组)
- 赛季声明单一 ruleset;启动即校验所有存档 `meta.ruleset` 与 `season.yaml` 一致,不一致 → **退出码 1 报错退出**,而不是在同一份报告里分版本分节。复用 FR-10 AC2「错配时 runner 拒跑」的同一条校验路径。报告仍标注版本(满足 hld `:790` 的「标注」)。

### 回放读入端(最小面)
- I 里一票落地:`packages/replay` 导出 `readLinesOf` + 落地 `parseReplay`(接到 `render.ts:17` 注释所指的是同一处),供叙事战报与 NFR-2 复算链读回放。
- **边界**:只做读入端最小面,**不做复算语义**——复算链归 L。

### 文档收口(随 I 的 PR,一票)
- **三笔交办账登记进 hld §12** 并把指针指向 I 的票:A 的「两条等效命题在首轮赛季复验」(`docs/diagrams/v0-milestone-dag.md:254`)、G 的「spawn / 池 / 重跑编排归 I」(`:170`)、H 的四项(`.scratch/generation-pipeline/spec.md:141`);旧处改成指针。
- **DAG 过时句对齐**:`:35`(交付层七格 → 八格)、`:202`(V0 汇合六项 → 四项)、`:206`(结论 1 未列 H/K)、`:220`(L 行前置仍写「等 K」,K 已 ✅)。
- **DAG §5 frontier 表补 I 的行**(`:213-220` 现无 I 行,而 I 是主干唯一未开的交付格;I 只在 `:220` 作 L 的前置被提及)。
- **`packages/engine/src/index.ts` 头注对齐**:`:22-23` 说「状态模型随 `runMatch` 一起导出」,但代码(`:28-30`)实际没导出——以代码为准,改头注。

### 真实赛季留证
- `runs/**` 被 `.gitignore:28-29` 排除(赛季产物是本地产物)。**真实赛季的读数与报告结论落在 `.scratch/season-scheduler/e2e-readings.md`**(照 H 的 `.scratch/generation-pipeline/e2e-readings.md` 先例),不试图把 `runs/` 入库。
- 收口票:`modelwar gen --config models.yaml` 冻结 5 条(消耗 API)→ `modelwar run --config season.yaml` 跑完整轮(60 局,零 API)→ 报告留证。若某个模型冻结失败,写进校验失败名单 —— 这是 FR-8 AC4 的**实证**,不算翻车。

### 不改的东西
- `packages/schema/src/match-input.ts` 的 `MatchInput` 形状**不动**(I 只填值);
- `archive-meta` 十一键**不动**;
- `apps/cli/src/exit-codes.ts` 的码值表**不动**(I 是它的消费者)。

## Testing Decisions

**好测试的标准**:只断言外部可观察行为——写出的文件与字节、退出码、`report.json` 的内容、子进程观察到的输入。不断言内部函数调用、私有字段或实现步骤。

**缝**:
1. **`enumerateMatchUps` 纯函数直测**——座位轮换、均摊断言、顺序无关性(扩展现有 `enumerate-match-ups.test.ts`)。
2. **`ranker` 纯函数直测**——先写测试(tdd),再实现。
3. **CLI 子进程缝(既有,复用)**——`cli.test.ts` 的临时根 fixture,`modelwar run` 打一场 fixture 赛季。
4. **对局子进程**——打假 `modelwar match`(临时根下可控退出码),覆盖 0 / 2 / 3 / 4 与「重跑一次」序列。

**要测的模块与用例方向**:
- `@model-war/runner` 枚举:N=4/5/6 的组合数;`(mapIndex+seedIndex) mod 4` 每个座位的对局数精确相等(满足 `M×K ≡ 0 (mod 4)`);不满足时报错或差额 ≤1;结果与传入顺序无关。
- `ranker`:并列名次分(`(2+1)/2 = 1.5`);剔除失败局后分母 = 有效局数;`rankPoints` 覆写;v0 无 Elo 字段或为 `null`。
- `scheduler`(fixture 赛季):60 局全部物化 `input.json`;**逐局比对 `input.json` 与 `MatchInput` 的键集**(多余赛季字段即失败);combo/map/seed 命名确定;规则版本不一致 → 退出码 1。
- 异常路径:假 match 首发退出码 2 → 重跑一次;连续两次 2 → 记入问题清单、排除出排名、报告含该局;退出码 3 同;退出码 4 → 赛季中止并报错。
- `reporter`:`report.json` 可被独立重算排名(NFR-2);`narrative/<对局>.md` 每局都有;`report.md` 的失败名单与问题清单分两节,内容分别来自 gen 失败记录与 §8.4。
- `replay` 读入端:导出 `readLinesOf` + `parseReplay` 往返(`renderReplay` 改用 `parseReplay`)。
- CLI 接线:`cli.test.ts:33` 的 `UNIMPLEMENTED` 移除 `run`;`modelwar run --help` 含 `--config`。
- 文档收口:hld §12 三笔齐、DAG §5 表含 I 行(可作纯文本断言或人工核对,归该票)。

**先例(照抄它们的形态)**:
- 纯函数直测:`packages/runner/src/enumerate-match-ups.test.ts`、`packages/gen/src/assemble-prompt.test.ts`。
- 临时根 fixture + 打单文件 spawn CLI:`apps/cli/src/cli.test.ts`。
- 子进程退出码 / stdout 断言:`packages/tools/src/validate/run-validate-script.test.ts`。
- 真源只读 idiom:`packages/engine/src/run-match.test.ts`(`read("rulesets/v1.json")`)。

## Out of Scope

- **NFR-3 的阈值 `X`** 与整轮性能标定 → **L**(K 已交基准读数,`.scratch/budget-calibration/readings.md`)。
- **复算链语义**(按 `input.json` 重新执行、逐 tick hash 比对)→ **L**;I 只落地回放读入端最小面。
- **统计显著性 / 置信区间** → 不在 v0 验收口径。
- **Elo** → v0 不做,只保证主排名。
- 快照拷贝粒度、存储 / IO、`check:selfproof` 桩口径 → **L**。
- `docs/gdd.md` 的规则侧开放项 → 规则侧,I 只消费不裁定。

## Further Notes

- **grill 五轮收口**(逐问记录见本目录 `grill.md`)。关键裁决:
  1. **N=5 而非严格 4**:对局阶段零 API 成本(模型只在 `gen` 冻结期消耗协议轮数),补第 5 条同 lab 的 `deepseek-v4-flash` 使组合数从 1 升到 5、每模型局数从 12 升到 48,几乎白送。
  2. **验收 (c)**:fixture 赛季进 CI,真实赛季作收口验证票。
  3. **`parseReplay` 归 I,但只做读入端最小面**;复算语义留 L。
  4. **`enumerateMatchUps` 原地扩展**(不新开第二处枚举),均摊断言随它一起测。
  5. **`FailureRecord` 下沉 `packages/schema`**(有意的形状搬迁,方向正确),避免新增 `runner → gen` 边。
  6. **规则版本隔离 = 前置拒绝**,不是报告分组。
  7. **两份失败分两节**;叙事每局都生成;`masterSeed` 进 `season.yaml`。
  8. **子进程粒度 = 每局一个进程**,贴合「调度器只认退出码」。
- **待落文档**(守「每个事实只有一个家」):`packages/schema` 增 `FailureRecord` 真源后,hld §7.4 的「失败记录」措辞与 `CONTEXT.md` 的《校验失败记录》需对齐指针;hld §8 / §9 补 `season.yaml` 的字段意图与 `run` 的根目录解析;hld §12 登记三笔交办账(spec 的《文档收口》一票负责)。
- **诚实的空白**:I 是 O(N) 赛季规模的**首次**落地,现有测试没有「一场完整赛季」的先例;`enumerateMatchUps` 的扩展会改动既有 6 个用例的期望,需要一并更新而非绕过。真实赛季前,任何人都没见过 5 个 lab 的脚本同台。
- **流程纪律**:实现票的 `Status:` / `## Answer` / 验收勾选必须回写(K 与 H 都漏过这一步);提交信息**禁止 `Co-Authored-By`**;快反馈用 `pnpm run check:quick` + 该票测试,全部票合并后再由主线程跑一次 `pnpm run verify:fast`。
