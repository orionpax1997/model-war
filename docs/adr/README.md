# ADR 索引

决策记录。**每份 ADR 只回答五个问题**:遇到了什么问题 / 为什么选这个方案 / 为什么没选别的 / 带来什么长期约束 / 什么情况下重新评估。

**它们不记录**:现在代码里有多少个类、某个函数在哪个文件、当前参数取值是多少。那些属于代码与 `rulesets/*.json`,会过期。

## 状态与取代关系

| 状态 | 含义 |
|---|---|
| accepted | 现行决策 |
| superseded | 已被后来的 ADR 取代(正文里写明取代者) |
| partially superseded | 主体仍现行,某一部分边界已被后来的 ADR 取代 |

取代关系写在 ADR 的抬头与正文里(「取代 ADR-XXXX」/「superseded by ADR-XXXX」),本表只登记当前状态。

| # | 标题 | 状态 | 取代关系 |
|---|---|---|---|
| [0001](./0001-sandbox-quickjs-wasi.md) | 沙箱选型:quickjs-wasi,且不为「未来换 VM」预留抽象层 | accepted | — |
| [0002](./0002-toolchain.md) | 工具链:pnpm 12 + TypeScript 7 + oxc 三件套,包间类型引用走 exports + project references | superseded | 被 ADR-0010 取代(CI 条款作废) |
| [0003](./0003-schema-single-source-distribution.md) | schema 真源:形状归属与跨包分发 | accepted | — |
| [0004](./0004-contract-api-surface-lands-in-rules-landing.md) | 规则文档的表格由真源包生成,而它的真源时点在规则落库那一格 | accepted | — |
| [0005](./0005-runner-seam-is-the-two-bridge-calls.md) | 执行器的缝就是那两次宿主桥调用,中间不设任何表示 | accepted | 收窄 ADR-0001 里的执行器缝表述 |
| [0006](./0006-script-api-type-surface-lands-in-engine.md) | 脚本 API 的类型面归对局内核,注入面归沙箱执行器 | accepted | — |
| [0007](./0007-runtime-bundle-artifact-is-committed.md) | 沙箱 runtime bundle 以确切字节进版本库,漂移门禁判「现算 == 入库」 | accepted | — |
| [0008](./0008-contract-prose-revision-does-not-bump-version.md) | 契约散文修订不升版本号,版本号只锚定规则集取值 | accepted | — |
| [0009](./0009-budget-final-values-are-revocable.md) | 预算终值可失效,但不可就地修改 | accepted | — |
| [0010](./0010-minimal-ci-pipelines.md) | 最小主/夜间流水线建成,ADR-0002 的「不建 CI/CD」条款作废 | partially superseded | `mutate` 只观测不设红线一条被 ADR-0026 取代(改为棘轮);主链成员、无凭证离线、`scan` 口径仍现行 |
| [0011](./0011-v1-scripts-migrate-to-v2-without-regen.md) | v1 冻结脚本直迁 v2:只改版本标签,不重新生成 | accepted | — |
| [0012](./0012-strip-fence-before-compile.md) | 编译前剥模型输出的围栏包装:管线改,不动提示词 | accepted | — |
| [0013](./0013-free-strategy-no-injected-line.md) | 自由策略:本季起不再向模型注入统一策略句 | accepted | — |
| [0014](./0014-script-entry-checked-by-validator.md) | 脚本入口的「存在性」检查落在静态校验器:gen 不解析、也不执行模型产物 | accepted | — |
| [0015](./0015-opt-in-score-source-feedback.md) | 无得分来源回喂仅作为显式有限实验 | partially superseded | 机会分配口径被 ADR-0017 取代 |
| [0016](./0016-production-action-facts.md) | 行动事实沿现有桥采集,以完整性约束回喂 | partially superseded | 反馈边界被 ADR-0017 / ADR-0019 取代 |
| [0017](./0017-uniform-two-fact-feedback.md) | 显式事实优化统一两轮,诊断修复按阶段独立计量 | accepted | 反馈的内容与呈现口径由 ADR-0025 演进(机会分配与计量边界仍现行) |
| [0018](./0018-generation-policy-and-candidate-selection.md) | 规范生成意图与完整候选选拔分开审计 | partially superseded | 选拔作为「另一次独立实验」的表述被 ADR-0024 取代(同字节复用一条被继承) |
| [0019](./0019-terminal-match-facts-feedback.md) | 两次事实反馈纳入真实终局计分依据与四方结果 | partially superseded | 选拔按独立计划的语义被 ADR-0024 取代;逐场全展开的边界被 ADR-0025 取代 |
| [0020](./0020-selection-tiebreak-compatibility.md) | 选拔决胜更新与历史身份兼容 | accepted | 历史决胜语义的适用范围由 ADR-0024 的 v1/v2 分流限定(`earlier-stage` 只属 v1 档) |
| [0021](./0021-google-generate-content-family.md) | Google 线协议作为第四个端点族,并承认无收尾哨兵的流 | accepted | — |
| [0022](./0022-generate-content-thinking-level-and-params-evidence.md) | Google 族的推理控制用 `thinkingLevel`,候选的实际参数随存档落档 | accepted | 满足 ADR-0021 的重评条件 |
| [0023](./0023-sparring-scripts-replace-benchmarks-as-opponents.md) | 优化与选拔的对手换成能力阶梯,基准脚本退回契约回归 | accepted | — |
| [0024](./0024-single-evaluation-grid-and-selection-as-recompute.md) | 一次生成只定义一张评测网格,选拔是排序加独立复算 | accepted | 局部取代 ADR-0018 / ADR-0019 的选拔独立性表述;限定 ADR-0020 的版本适用范围 |
| [0025](./0025-feedback-aggregates-and-cross-stage-gap.md) | 事实回喂分三层:聚合对差表、逐场一行、最差三场展开 | accepted | 演进 ADR-0017;局部取代 ADR-0019 的逐场全展开边界 |
| [0026](./0026-mutation-score-is-a-ratchet.md) | 变异分数是棘轮:不许比上次低,基线抬升必须显式为之 | accepted | 取代 ADR-0010 的「`mutate` 只观测」条款 |

## 写一份新 ADR

- 编号续接上表,文件名 `NNNN-<slug>.md`,抬头写 `status:`(必要时写 `superseded_by:` / `partially_superseded_by:`)。
- 正文只回答那五个问题;被否掉的方案**也要写进正文**(为什么没选),不要另开一份「备选方案清单」。
- 需要长期成立的东西(约束、口径、复核触发条件)写进 ADR;**会过期的东西**(当前实现、当前取值)不写。
