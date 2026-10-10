# model-war

四人对称 RTS 对战平台:规则、引擎与复算工具链。各模型赛前一次性写 TypeScript 策略脚本,在确定性沙箱内按 tick 结算 1v1v1v1 领土争夺对局,人类只观战。确定性重放是一等约束。

## 上手

```
pnpm install          # prepare 会自动装 git hooks;漏装就补 pnpm run setup:hooks
pnpm run build
pnpm run verify:fast  # 唯一收口命令:快反馈门禁 + 快速测试
```

装好后用户面是 `modelwar`(仓库唯一 bin,六个子命令 gen / run / match / replay / verify / map-lint):

```
node apps/cli/dist/modelwar.mjs --help
```

对局配置写在 `season.yaml`(模板 `season.example.yaml`)。生成管线要调模型时才读 `.env` 的 `COMMAND_CODE_API_KEY`(gitignored,值不进任何文档);其余开发与门禁都不需要它。

## 文档怎么读

按 fsr → srs → gdd → hld 顺序读,每份只拥有它那一层(完整所有权表在 [AGENTS.md](AGENTS.md),此处不复制):

| 文档 | 拥有 |
|---|---|
| [docs/fsr.md](docs/fsr.md) | 定位、竞品、可行性结论(why) |
| [docs/srs.md](docs/srs.md) | 范围、FR/NFR 与验收条款(what) |
| [docs/gdd.md](docs/gdd.md) | 规则机制、设计约束、参数意图 |
| [docs/hld.md](docs/hld.md) | 架构、进程模型、确定性手段、数据格式(how) |
| [docs/rules-v1/](docs/rules-v1/) | 面向模型的契约(生成物,不手改;取值真源在 rulesets/) |

- 领域词汇(对局 / 回放 / 冻结脚本 / 预算轨……)唯一真源:[CONTEXT.md](CONTEXT.md)
- 决策记录:[docs/adr/](docs/adr/)(如 ADR-0001 沙箱选型 quickjs-wasi、ADR-0009 预算终值可失效)
- 里程碑与对账状态:[docs/diagrams/v0-milestone-dag.md](docs/diagrams/v0-milestone-dag.md)
- agent 工作指引(issue 跟踪 / triage / 域约定):[docs/agents/](docs/agents/)
- 两份文档冲突时的采信顺序见 AGENTS.md;先修矛盾的一方,不要两边各留一份

## 仓库地图

| 位置 | 装什么 |
|---|---|
| apps/cli | `modelwar` 唯一用户面,只做路由 |
| packages/schema | 类型 / 常量 / 参数 key / JSON Schema 的唯一真源 |
| packages/engine | 确定性内核 + quickjs-wasi 沙箱 |
| packages/replay | 回放格式与 stateHash 原语 |
| packages/runner | 赛季调度、进程池、排名、报告、叙事战报 |
| packages/gen | 脚本生成管线(唯一联网包,永不进对局进程) |
| packages/tools | 仓库自用门禁脚本(以源码执行,不进 dist) |
| rulesets/ | 参数取值真源 `rulesets/*.json` |
| benchmarks/ | 基准脚本:模型仅凭契约盲写、真引擎跑通的对照脚本 |
| archive/ | 冻结脚本与校验失败记录 |
| maps/ | 对局地图;runs/ 是对局产物(gitignored,可重生成) |
| probes/ | 上游缺陷的一次性复现探针 |
| .scratch/ | 本地 issue 与 spec 的家,见 docs/agents/issue-tracker.md |

## 工作约定

- 实现期间跑 `pnpm run check:quick`,整份 spec 收口只认 `pnpm run verify:fast`;全量门禁(check / test:gates / test:slow / mutate 等)不是默认流程,按需跑(理由见 AGENTS.md)。
- 提交信息禁 `Co-Authored-By`(单作者,commit-msg hook 强制)。
