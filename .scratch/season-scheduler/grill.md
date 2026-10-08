# I 赛季调度:grill 收口记录

五轮 `grill-with-docs` 的逐问与裁决。判据之家与交付面见 `spec.md`;本文件只记「问了什么、裁了什么、依据是什么」。

裁决口径:每问的「→」是给出的推荐;用户对全部推荐答「按推荐」,除第 4 轮 Q1 指定「用我那 4 条 + 同 lab 的」。

---

## 第 1 轮:范围与契约

❓ **Q1 采样规模与「≥4 个真实模型」的语义** — `M=3`(仓库 3 张图)、`K=4`(DAG `:179` 由 A 定死),`C(4,N)` 决定组合数;「≥4」是硬下限还是目标?12 局/模型是「机制可跑通」还是「名次可信」?选型是否限定公开 API、有无预算上限?

→ 「≥4」当硬下限;12 局只当机制跑通信号,v0 不宣称名次可信,统计显著性移出验收口径;限定公开 OpenAI 兼容 API + 明确预算上限。(**第 4 轮改为 N=5**。)

❓ **Q2 `parseReplay` 归谁** — 叙事战报与 NFR-2 复算链都要读回放,但 `render.ts:17` 挂着 TODO、`readLinesOf` 私有。三种归法:(i) I 顺带补一票;(ii) 归 L 复算链;(iii) replay 包独立票。

→ 选 (i),边界「只做读入端最小面(`readLinesOf` 导出 + `parseReplay`),不做复算语义」;复算归 L。

❓ **Q3 三笔交办账是否登记进 hld §12** — A 的等效命题复验(DAG `:254`)、G 的 spawn/池/重跑编排(`:170`)、H 的四项(`generation-pipeline/spec.md:141`)都不在 hld §12;§12 只剩 #3(B)、#6(L)、#7(L)。

→ 全部登记进 hld §12,指针指向 I 的票;旧处改指针。

❓ **Q4 `season.yaml` 的形状与真源家** — hld `:774` 只给字段意图,未给格式与家。

→ 真源 = `packages/runner` 的 zod schema + `season.example.yaml`;hld §9/§8 只写契约与字段意图;`rankPoints` 默认 `[3,2,1,0]`、不进 `rulesets/`。

❓ **Q5 并发默认与超时口径** — hld `:779` 给并发默认 `min(cpus, 8)`,§8.4 定重跑一次,但没定成败判定与超时口径。

→ 并发默认 `min(cpus, 8)` 可覆写;子进程成败**只认退出码**;超时复用 `wallClockHardTimeout`;重跑一次后仍失败 → 写入失败名单 → 排除出排名。

❓ **Q6 `runner` 包票序骨架、`ranker` 是否独立先行** — `packages/runner` 是空壳,`runSeason` 全仓无实现,DAG 曾说 `ranker` 可「趁 H 还在跑顺手做掉」(H 已收口,条件失效)。

→ `ranker` 独立成票且先行(纯函数、适 tdd、不依赖子进程池);报告票后置;全部票面粒度留 `to-tickets`。

---

## 第 2 轮:验收、契约细节

❓ **Q1 验收口径:是否必须真跑 ≥4 真实模型的赛季** — (a) 只用 stub 赛季;(b) 必须真跑并留证;(c) 两者都要。

→ 选 (c):fixture 赛季进 CI;另加一次真实赛季留证(不进 CI)。**关键事实:对局阶段零 API 调用**,成本只在 `gen` 冻结期。

❓ **Q2 预算上限的落点** — 上限口径?写成选型门槛还是运行约束?

→ 按 `gen` 单模型冻结成本设门槛(约束 `protocolRounds` 等),`models.yaml`/`season.yaml` 可调而非硬编码。放大 N/K 只吃 CPU。

❓ **Q3 ranker 契约:并列、均分分母、Elo** — hld `:781-784` 已定并列分与总分,未定:(a) 失败局是否进均分分母;(b) `rankPoints` 是否可配长度;(c) v0 做不做 Elo。

→ (a) 分母 = 有效局数,并留有效局数;(b) 固定长度 4;(c) v0 不做 Elo,只留字段。

❓ **Q4 叙事战报粒度** — `narrative/` 每局都生成还是只给代表性对局?

→ 每局都生成(events 的纯函数、便宜、确定);`report.md` 只引用几篇。

❓ **Q5 确定性:种子来源** — (a) `season.yaml` 给 `masterSeed` + 派生;(b) 每局种子直接由 `(combo, map, seedIndex)` 派生。

→ 选 (a):`seed = H(masterSeed, combo, mapIndex, seedIndex)`,写进 `input.json`;换来赛季级可重放。

❓ **Q6 子进程池的进程模型** — (a) 每局 spawn 一个 `modelwar match`;(b) 长驻 worker 池。

→ 选 (a):贴合「调度器只认退出码」,无 IPC 状态串味风险;性能不达标先按 hld §10.1 调沙箱开销与并发度。

---

## 第 3 轮:实现面

❓ **Q1 `runner` 包结构:一包三模块还是三包**

→ 一包三模块(`packages/runner/src/{scheduler,ranker,reporter}.ts`);拆包要连 hld 拓扑图一起改,收益不成比例。

❓ **Q2 规则版本隔离:拒绝还是分组**

→ 前置拒绝:赛季声明单一 ruleset,存档 `meta.ruleset` 不一致 → 退出码 1;复用 FR-10 AC2 的拒跑路径;报告仍标注版本。

❓ **Q3 报告里两份「失败」是否分开** — 校验失败名单(gen 侧,没参赛资格)vs 对局问题清单(§8.4,参赛后被剔除/披露)。

→ 分两节,不合并(处置不同,合并会误导)。

❓ **Q4 真实赛季留证是否含「冻结 ≥4 模型」这一步**

→ 当 I 的收口验证票(PR 内最后一票):`gen` 冻结 ≥5 模型 → `run` 一整轮 → 报告留证;冻结失败写进校验失败名单也算实证。

❓ **Q5 文档收口账怎么走**

→ 作 spec 里一票「文档收口」,随 I 的 PR:登记 hld §12 三笔 + 修 DAG 过时句 + 补 frontier 表 I 行。

---

## 第 4 轮:模型选型(收口)

❓ **Q1 参赛集规模:严格 4 条还是 5 条**

→ 用户指定:**用自己那 4 条 + 同 lab 的 `deepseek-v4-flash`**,不补第五个 lab。N=5,`C(4,5)=5` 组合 × 3 图 × 4 种子 = 60 局,每模型 48 局。

❓ **Q2 旧条 `deepseek-v4-flash` 怎么处置**

→ 按 Q1 保留为第五条参赛条目。

❓ **Q3 `strategy` 注入口径:统一还是各异**

→ 五条注入同一句(赛模型不赛策略)。

**模型选型事实**:M4 唯一需要外部一手资料的一格。用账号实测(非纸面):`https://api.commandcode.ai/provider/v1` 目录 87 条,5 条全部 200(GOAT 套餐内)。详见 `spec.md` 的参赛集表。

---

## 第 5 轮:事实带出的最后两个分叉

（explore 子代理核实 `packages/runner` / `replay` / `exit-codes` / `input.json` 现状后)

❓ **Q1 「校验失败名单」的形状归谁的家** — 现住 `packages/gen/src/failure.ts:48`,不在真源包;而 runner 依赖 `schema`(hld §3.2)、仓库无 `runner → gen` 边。(a) runner import gen 类型;(b) `FailureRecord` 下沉 `packages/schema`;(c) runner 宽松读 JSON。

→ 选 (b):形状家归真源包(与 `archive-meta` / `replay-line` / `match-input` 同家),gen 反向依赖 schema;(a) 会把唯一联网包拖进 runner 依赖面。

❓ **Q2 `enumerateMatchUps` 怎么扩展** — 现签名 `(players: readonly string[])`、只做组合枚举。(a) 原地扩成「组合 × 地图 × 种子 × 座位」;(b) 保持组合枚举、轮换新写一处。

→ 选 (a):轮换是纯函数,`M×K ≡ 0 (mod 4)` 断言属枚举器不变量,拆两处会跨模块才算全;现有 6 个用例随之更新。

**另记**(归文档收口票):`packages/engine/src/index.ts:22-23` 头注说状态模型随 `runMatch` 导出,但代码(`:28-30`)没导出——头注与代码不符,顺手对齐。
