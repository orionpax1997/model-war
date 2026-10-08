# H 生成管线 — grill-with-docs 收口记录

> 本文件只记**过程**与**指针**。裁定的事实按「每个事实只有一个家」落在别处,这里不复制取值:
> 工程决定 → `docs/hld.md`(§2.2.6 / §7.4 / §9);术语 → `CONTEXT.md`;条文 → `docs/srs.md` FR-5/FR-6。
> 下一步:`to-spec` 产 `.scratch/generation-pipeline/spec.md`,再 `to-tickets`。

## 已裁(两轮,全部按推荐)

范围与形态
- H 完成判据 = 管线代码 + **至少一次真实端到端**(1 个模型跑出真 `archive/<slug>/<runId>/` 三件套且过 `validateArchiveMeta`);≥4 模型选模与跑批归 **I**。
- AC1(无对局反馈路径)用**门禁**固化:depcruise 禁 `gen → engine/runner/replay`(engine 已有,补 replay/runner)+ gen 包内源码级测试禁 `runs/`、`.result.json`、`MatchResult` 等结果符号。
- `prompts/base.md` **薄壳 + 指针清单**:角色/任务/输出形态/协议声明 + `{{contract}}` + 可选 `{{strategy}}`;契约判据文本不复制。
- `strategy` 自由文本、缺省即不注入;不做按档分模板。
- 契约读入 = 每次运行从 `<root>/docs/rules-<RULESET_VERSION>/{rules.md,api.md}` 读盘。
- `models.yaml` **入库、只登记本季参赛集**;类型与校验是 gen 包私有(不进 schema 五类形状)。
- 模型客户端:`ModelClient` 接口 + 三个端点族分支(`chat-completions`/`messages`/`responses`),**不引厂商 SDK**;测试注入可编程 stub(CI 无凭证)。
- CLI:`modelwar gen --config models.yaml [--root <仓库根>] [--model <slug>]`;根解析同 `match`;gen 启动加载 `<root>/.env`(存在才加载)。

协议与产物
- `protocolRounds` = **模型调用总轮数,含初次生成**,`meta.prompts.length === protocolRounds`(既有冻结形状,勿改读入端断言)。
- 通过判据 = tsc 零错误 + `--phase iteration` 无 blocking;体积迭代期只提示、冻结期 `--phase freeze --max-bytes <rulesets 值>` 才拦;只剩非 blocking 提示也算通过。
- 传输错误(429/5xx/超时)与截断(`length`)退避**重试同一轮、不消耗轮数**;耗尽 → 该模型失败。
- 无状态全量重发 messages,不依赖 provider 会话;`meta.prompts[]` 每条 = 该轮**完整发出**的 prompt 文本。
- `generationLog` 不改形状:每条一行序列化 JSON 字符串。
- `archive/` **原子落盘**(临时目录 → rename),目标存在即拒;`runId` = 生成时间戳,一跑一目录、旧目录不删;`archive/` 必须入库。
- 失败品**不写 `archive/`**,写 `archive/<slug>/failed-<runId>.json`(逐轮 prompt 链 + generationLog + 最终诊断 + 分类 `tsc|contract|transport`),供 I 出失败名单。
- 多模型 **v0 串行**、模型内并发 1;不做 `--concurrency`;退出码:全成功 0、任一失败 1。
- 回喂探针 = gen 内一张**测试票**(stub 第 1 轮返回含 blocking 违规脚本、第 2 轮合法),断言回喂确实发生、`protocolRounds === prompts.length === 2`,**不是** throwaway prototype。

文档落点(已写)
- `CONTEXT.md`:新增《校验失败记录》。
- `docs/hld.md`:§2.2.6 表重写(模板/契约读入/客户端/模型配置/重试/日志)、§2.2.8 与 §3 去掉「SDK」、§7.4 补写盘原子/轮数语义/失败记录、§9 补 `--root`。
- `docs/adr/0003` 措辞对齐(「各厂商 SDK」→「厂商适配层」)。
- `docs/diagrams/v0-milestone-dag.md`:L 行登记「每赛季自动重标流水线」债。

## 待 to-spec/to-tickets 裁的(不再需用户裁)

- `prompts/base.md` 正式文本(薄壳 + 指针清单的逐条措辞)。
- 票的切法:模板/契约读入、`ModelClient`+HTTP 三族、tsc 编译步骤、校验器 spawn、回喂循环、archive 落盘、失败记录、CLI 接线、回喂探针测试、AC1 门禁。
- H 的 e2e 用哪个真实模型(从 `.modelwar-models.json` 挑,建成 `models.yaml` 格式范例);暂存文件 `.modelwar-providers.md`/`.modelwar-models.json` 在填完后删除。
