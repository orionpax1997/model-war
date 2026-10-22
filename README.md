# model-war

四人对称 RTS 对战平台:规则、引擎与复算工具链。各模型赛前一次性写 TypeScript 策略脚本,在确定性沙箱内按 tick 结算 1v1v1v1 领土争夺对局,人类只观战。确定性重放是一等约束。

## 快速开始

```
pnpm install          # prepare 会自动装 git hooks;漏装就补 pnpm run setup:hooks
pnpm run build
pnpm run verify:fast  # 唯一收口命令:快反馈门禁 + 快速测试
```

装好后用户面是 `modelwar`(仓库唯一 bin,七个子命令 gen / run / report / match / replay / verify / map-lint):

```
node apps/cli/dist/modelwar.mjs --help
```

对局配置写在 `season.yaml`(模板 `season.example.yaml`)。生成管线要调模型时才读 `.env` 的 `COMMAND_CODE_API_KEY`(gitignored,值不进任何文档);其余开发与门禁都不需要它。

## 文档

| 文档 | 拥有 |
|---|---|
| [CONTEXT.md](CONTEXT.md) | 领域词汇与容易误用的概念 |
| [docs/vision.md](docs/vision.md) | 定位、服务对象、核心差异、非目标与产品取舍、长期风险 |
| [docs/gdd.md](docs/gdd.md) | 玩法设计意图、不可从代码推导的约束、规则侧决策记录 |
| [docs/hld.md](docs/hld.md) | 架构边界、进程模型、确定性手段、沙箱威胁模型、不可破坏的工程约束 |
| [docs/adr/](docs/adr/) | 决策记录(含 [索引](docs/adr/README.md)) |
| [docs/rules-v2/](docs/rules-v2/) | **面向模型的契约**(生成物,不手改;取值真源在 `rulesets/`) |

**代码是真源,但契约不是可删的**:`docs/rules-v2/` 是模型唯一能读到的规则输入,相当于公开 API 文档——它由代码、schema 与 `rulesets/` 生成,并由漂移门禁(`pnpm run check:drift`)保证不漂移。

规则与设计的详细层不再由文档各自复述一遍:机制与结算顺序看 `docs/rules-v2/rules.md`,参数取值看 `rulesets/*.json`,数据形状看 `packages/schema`,其余按上面的分工。

## 仓库地图

| 位置 | 装什么 |
|---|---|
| apps/cli | `modelwar` 唯一用户面,只做路由 |
| packages/schema | 类型 / 常量 / 参数 key / JSON Schema 的唯一真源 |
| packages/engine | 确定性内核 + quickjs-wasi 沙箱 |
| packages/replay | 回放格式与 stateHash 原语 |
| packages/runner | 赛季调度、进程池、排名、报告、叙事战报 |
| packages/gen | 脚本生成管线(唯一联网包,永不进对局进程) |
| packages/tools | 仓库自用门禁脚本与生成器(以源码执行,不进 dist) |
| rulesets/ | 参数取值真源 `rulesets/*.json` |
| benchmarks/ | 基准脚本:模型仅凭契约盲写、真引擎跑通的对照脚本 |
| archive/ | 冻结脚本与校验失败记录 |
| maps/ | 对局地图;runs/ 是对局产物(gitignored,可重生成) |
| probes/ | 上游缺陷的一次性复现探针 |

## 工作约定

- 实现期间跑 `pnpm run check:quick`,收口跑 `pnpm run verify:fast`;全量门禁(check / test:gates / test:slow / mutate 等)不是默认流程,按需跑(理由见 [AGENTS.md](AGENTS.md))。
- 提交信息禁 `Co-Authored-By`(单作者,commit-msg hook 强制)。
