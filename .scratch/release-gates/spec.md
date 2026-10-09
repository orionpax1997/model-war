# L 门禁、流水线、性能与存储

Status: resolved

图上的节点 L(`docs/diagrams/v0-milestone-dag.md` §4 收尾层节点表,波次 9)。工作单元 = `.scratch/release-gates/`,走 `grill-with-docs`(已完成,两轮九问)→ `to-spec`(本文件)→ `to-tickets` → `implement`。判据之家:`docs/hld.md` §2.2.7(脚本分层与门禁)、§12 开放项 #6/#7、§5.3 标定判据、§10.1/§10.3;条款在 `docs/srs.md` NFR-1(`:112-116`)/NFR-2(`:118-122`)/NFR-3(`:124-126`)/NFR-4(`:128-131`);重开决策 `docs/adr/0010-minimal-ci-pipelines.md`(ADR-0002 不建 CI 条款已 supersede)。**L 是当前唯一未开的主干格,四条硬依赖 G/R/K/I 全收口;另有一条虚线义务边 F ⇢ L。M2 的收尾并入本节点,M2 随本节点 PR 关账。** 词表用 `CONTEXT.md` 既有词条(含本轮新增:门禁／流水线／主流水线／夜间流水线／标定复算)。

## Problem Statement

仓库今天没有任何一条流水线,门禁全靠人手工敲;三处判据缺口直接卡住 V0:

1. **零 CI**。`.github/` 根本不存在,hld §2.2.7 写"不建 CI/CD 流水线(ADR-0002)",而 DAG 的 L 交付物要"主/夜间流水线建成"——两者直接互斥。srs NFR-1 的 AC 明写"CI 中存在重放一致性测试",今天这条无从兑现。ADR-0002 拒 CI 的理由("流水线形态与首个真实实现强相关")在 F/G/H/I 全收口后已消失,前提没了,条款还在。
2. **跨进程一致性没有门**。料全齐了:同进程十次重跑在 `determinism.test.ts`(134 行,check 链上),`modelwar match`/`verify` 已落地,真实基准脚本的跨进程 `match → verify` 全链已在 `cli.test.ts` 跑通(真沙箱、600  tick)——但没有独立门禁脚本、没进 `check`。F ⇢ L 的虚线义务(桩结论真引擎复验:属性测试/基准门禁 + 停止条件)也归这里,今天状态是未做。
3. **NFR-3 的 X 没人定**。K 交的是"每场每席峰值 → 全局最坏"(单局最坏 3801ms,无 p50/均值分布,读数明写"给 L 的输入指针");I 交的是整轮 74.92s/61 次执行/并发 8(引擎未逐局落墙钟,读数明写"单局墙钟分布仍归 L 实测")。srs NFR-3 点名"目标值由性能节点 L 定",今天 X 是空的。
4. **hld #6/#7 没有停止条件**。F 交了两项读数(快照拷贝 0.307ms vs 纯 clone 0.245ms;600tick 回放 2 388 636B),hld 两条都写"停止条件归 L"——今天 L 没开,两条都是"先测后优化"的空话。
5. **三处登记漂移**。hld 把 `check:quick` 写成 5 项实际 6 步;`check:runtime` 被 `CONTENT_RECHECKS` 消费但 hld 全文 0 次提及;`:210` 边界声明("引擎、结算管线、赛季调度、生成管线都不存在")与两处耗时基线(77 文件时代)全部过期。
6. **终值没有常驻守卫**。ADR-0009 三类失效事件(契约散文修订、快照结构变更、runtime/中断粒度变更)"都不会让默认门禁变红",纪律只能靠 `check:budget` 的失配断言变成可执行;`每赛季自动重标流水线` 点名归 L,今天不存在。

## Solution

建最小主/夜间流水线,把"门"一次配齐,不做重构、不设新红线(除 #6/#7 占比断言外),M2 随本节点关账。

交付物共七种:①`.github/workflows/` 两条链(主=快链,夜间=慢链+观测项),CI 只复核不新断言 ②跨进程一致性门禁(走 CLI 主接缝,含 F ⇢ L 复验矩阵)与 `verify` 统一到 `parseReplay` ③NFR-3 的 X(同机单进程 ≥30 局实测,均值+倍数余量) ④#6/#7 复测 + 可执行停止断言 ⑤`check:budget-recheck`(标定复算)挂夜间 + 三类失效触发表 ⑥Stryker(engine 结算管线)配置 + `scc` 观测,挂夜间,只落盘不设红线 ⑦hld §2.2.7 改写(归属层登记、边界与基线更新)+ M2/DAG 关账对账。

## User Stories

1. 作为合入者,我推 PR 时主流水线自动跑快链(`check:quick` + `test`),红了我就修,不必等人喊我敲命令。
2. 作为合入者,我知道 CI 失败等价于命名脚本失败,CI 里没有"CI 专属"断言让我去别处查第二套文档。
3. 作为值班者,我每天早上能看到夜间链的结果(慢链 + 观测项产物落盘),慢项红了我知道是哪一道门。
4. 作为 CI 读者,我看到的 hld 门禁表只有归属层(quick / `verify:fast` / `check` / 按需),命令细节永远以 `package.json` 为准,不会再读到过期复制。
5. 作为第三方复算者,我能凭"跨进程一致性门禁"的存在相信:正式对局样本重跑必得逐 tick 一致(srs NFR-1 AC),而不只是在同一进程里自洽。
6. 作为引擎维护者,我改快照结构时会被 #6 断言拦住(拷贝差值占比超 10% 即红),而不是在三个月后才发现单局墙钟涨了。
7. 作为引擎维护者,我改回放格式时会被 #7 断言拦住(单季总量超 1GB 或夜间读不完即红),而不是等磁盘报警。
8. 作为赛季运营者,我拿到 NFR-3 的 X(对局平均墙钟上限)与它的采样口径(机器、局数、p50/均值/最坏三栏),整轮排期有据可依。
9. 作为赛季运营者,我知道 X 是"均值+倍数余量"而不是最坏值拍脑袋,余量口径与 K 的分轨思想一致(物理量轨留倍数)。
10. 作为预算维护者,我在三类失效事件发生时知道跑哪条命令(`check:budget-recheck`),红了就开重标节点,而不是靠人记得终值可能失效。
11. 作为预算维护者,我每赛季看到的是一条可执行的复算命令 + 明文触发表,而不是一套会误报的 git-diff 自动嗅探。
12. 作为变异测试读者,我看到 Stryker 只跑 `packages/engine` 结算管线、结果只落盘不设红线,我不会把"配置落地"误读成"全仓变异分数达标"。
13. 作为代码行数读者,我看到 `scan`(scc)只做观测落盘,我不会去找一条不存在的行数红线。
14. 作为桩结论的读者,我能在 F ⇢ L 复验矩阵里逐条看到 gdd #7/#8/#9 的夹具位置、复验形态与停止条件,以及 #10 为何不复验(设计意图)。
15. 作为 M2 的关账者,我能凭本节点的 PR 同时关闭"无 CI、无跨进程门禁"两项,不必另开一轮关账。
16. 作为 V0 验收者,我看到 gdd/hld 开放项只剩 B 与规则侧,本节点关掉 hld #6/#7。
17. 作为渲染器/调度器维护者,我只认 `parseReplay` 一个读入端,`verify` 的自家 `parseLines` 分叉已被合并且有测试盯着。
18. 作为 L 的实现者,我第一票重测的耗时基线(同机 5 次取样报中位数)与旧数并列存放,旧基线不删只追加新行。
19. 作为 L 的实现者,我跑本节点内的 `check`/`test:gates`/`test:slow`/`check:selfproof` 是本职而非越界,票面写清"跑了哪条、为什么"即可。
20. 作为后续读者,我看到 ADR-0002 的状态是 `superseded by ADR-0010`,hld 与 DAG 不再互斥。

## Implementation Decisions

### 1. 流水线形态(ADR-0010 已裁,本节只落执行口径)

- 最小 `.github/workflows/`:主链 = PR/合入触发 `check:quick` + `test`;夜间链 = 定时触发 `check` / `test:gates` / `test:slow` / `check:selfproof` + `mutate`/`scan` 观测 + `check:budget-recheck`。workflow 内只调命名脚本,不直调 `node` 入口。
- `verify:fast` 仍是本地快反馈唯一入口;CI 无凭证、离线可跑(J 已办结约束不变)。
- hld §2.2.7 改写:门禁表只登记归属层,不逐条复制命令;真源永远是 `package.json`。`check:runtime` 补归属(末尾复核组)与用途(bundle 三段判定),`check:quick` 正名为 6 步。

### 2. 主接缝:CLI `modelwar match → verify`(不新开 engine API)

- 跨进程一致性门禁与 NFR-3 单局墙钟采样都走 `modelwar match <input.json>` → `modelwar verify <replay.jsonl>`。输入用 I 已产的冻结 `input.json`;断言是逐 tick hash 一致。形态复用 `cli.test.ts` 的 spawn 写法。
- `verify` 统一到 `parseReplay`(归属 `replay` 包),消掉自家 `parseLines` 第四份读入分叉;渲染器/scheduler/reporter 三处读入逻辑不动,本节点只收 `verify` 这一份。

### 3. 跨进程一致性门禁 + F ⇢ L 复验矩阵

- 新门禁脚本(命名按 `check:*` 归属"按需→夜间"层):抽正式对局样本(冻结脚本 + 种子),重跑并与 JSONL 比对,每 tick 状态 hash 一致(srs NFR-1 AC 的可执行形态)。`determinism.test.ts` 的同进程十次重跑不动,它仍是 `check` 链上那一层。
- F ⇢ L 复验矩阵单列:gdd #7/#8/#9 各一行(夹具位置/复验形态:属性测试或基准门禁/停止条件),#10 标设计意图不复验。M2 由本节点 PR 关闭,DAG/M2 措辞对账含在收尾票。

### 4. NFR-3 的 X 取值口径

- 同机单进程、同一批基准脚本(≥2 份)逐局落墙钟,≥30 局取 p50/均值/最坏三栏;X = 均值 + 倍数余量(物理量轨,沿 K 分轨思想);机器配置写进读数。I 的整轮吞吐(0.81 局/s,含并发排队)不作单局口径。
- 读数落 `.scratch/release-gates/readings.md`,X 写回 srs NFR-3 与 hld §10.1;hld #6/#7 的复测读数同文件。

### 5. #6/#7 停止条件(可执行断言,不重构)

- #6:深拷贝+深 freeze 与纯 clone 的差值占单局墙钟 <10% 即停(当前约 5%,复测确认即可);超了即红,不做零拷贝重构。
- #7:单季回放总量(局数×单局体量) <1GB 且夜间一次可读完(<10min)即停;超了即红,不做压缩/增量回放。真超的那天另开优化节点。
- 两条断言挂夜间层,不进 `check:quick`(它们要跑真局,零构建性质不能破)。

### 6. 标定复算 `check:budget-recheck` + 触发表

- 新脚本 = 标定复算动作:重跑预算探针 + 三份基准脚本,判"终值仍自洽"(探针仍被截停、基准仍不被截停,沿 K 的失配断言语义)。只编排现成东西,不新开探针格式。挂夜间流水线。
- 三类失效事件(契约散文修订、快照结构变更、runtime/中断粒度变更)各配一行触发说明(哪类变更→跑哪条命令→红了开重标节点)。不做 git-diff 嗅探。

### 7. `mutate`/`scan` 落地口径(只观测,不设红线)

- Stryker 只跑 `packages/engine` 结算管线(ADR-0002 原话范围),配置落库 + 挂夜间,结果落盘。不跑全仓;范围扩大的那天另开 ADR。
- `scan`(scc,手动装)只做行数/复杂度观测落盘。三夜基线之前不谈红线;L 内一律不设分数/行数红线。

### 8. 第一票:耗时基线重测 + 边界改写

- 同方法(同机、5 次取样、报中位数)重测 `check:quick`/`check:types`/`check`/`test:gates`/`test:slow`/`check:selfproof`;旧数留作历史基线,只追加新行。hld `:210` 按现状改写(F/G/H/I 落地后的真实覆盖面)。

## Testing Decisions

- 好测试只测外部行为:门禁脚本只断言退出码与产物(回放 hash 列、读数文件、落盘报告),不测内部编排顺序;每道新门禁都配一个能被弄红的反例(ADR-0002 纪律)。
- 跨进程门禁测 `match → verify` 全链(沿 `cli.test.ts:676-701` 的真实基准脚本形态);反向用例:改一 tick 即红。
- #6/#7 断言测阈值两侧:人为放大拷贝差值/回放体量即红,还原即绿(沿 `gates.test.ts` 既有位置纪律断言形态)。
- `check:budget-recheck` 测 K 的失配语义:终值下探针必截停、基准必不截停;任一反转即红。
- Stryker 配置测试只测"配置存在且 scope 限定 engine + 夜间可调通",不测变异分数。
- 先验:`gates.test.ts`/`gates-slow.test.ts` 的位置纪律与反例形态、`determinism.test.ts` 的十次重跑与反向自证、`probes:budget` 的读数落盘口径。

## Out of Scope

- 全仓 Stryker / 变异分数达标;`scan` 红线。
- 零拷贝快照重构;回放压缩/增量回放。
- git-diff 全自动失效嗅探;`verify` 之外三处读入逻辑的统一(render/scheduler/reporter 不动)。
- B(座位轮换 wayfinder);gdd #11/#15 规则侧开放项(规则侧,不在本节点)。
- 单局墙钟分布之外的整轮性能优化(并发度、沙箱开销不在 L 改,只测量)。
- `check` 全量门禁之外的专项质量检查变更新口径(`check:selfproof` 桩口径 I 已交办,本节点只消费不重裁)。

## Further Notes

- 本 spec 来自完整 grill-with-docs(两轮九问,裁决见会话):Q1→B 最小流水线+supersede 重开 ADR-0002;Q2→A 基线并入 L;Q3→A 归属层登记;Q4→A M2 并入 L;Q5→A 四术语已落 CONTEXT;Q6→A 单进程实测取 X;Q7→A engine 范围只观测无红线;Q8→A 占比/总量即停;Q9→A 复算命令+触发表。
- 已落盘域文档:`CONTEXT.md` +4 词条(门禁/流水线/主流水线/夜间流水线);`docs/adr/0010-minimal-ci-pipelines.md`(accepted);ADR-0002 已标 superseded。
- 接缝确认:主接缝走 CLI(不用 engine 函数级调用);`verify` 统一到 `parseReplay` 并进 L。
- 工作目录 `.scratch/release-gates/`,票放 `issues/<NN>-<slug>.md`;票面 `Status:` + `## Answer` + 验收勾选必须回写。实现期快反馈 `check:quick` + 相关测试;全票合并后跑一次 `verify:fast` 再标 PR ready;收尾 `code-review` 双轴。提交信息禁 `Co-Authored-By`。
- Stryker/`scc` 配置形态如需一手依据,to-tickets/implement 阶段按需调 `research`/context7;单局墙钟采样如需探针形态按需调 `prototype`(产物放 `.scratch/release-gates/prototype/`,README 声明 throwaway)。
