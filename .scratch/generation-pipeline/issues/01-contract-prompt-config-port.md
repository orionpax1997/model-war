# 01: 契约读入、prompt 模板与模型配置(含 `ModelClient` 端口与桩)

**What to build:** `modelwar gen --config models.yaml --root <root>` 能加载本季参赛配置、从规则契约与 `prompts/base.md` 组装出完整 prompt 文本,并经 `ModelClient` 端口对其中一个模型发一次请求、回得脚本文本(本票**不落存档、不编译**)。配置与契约出错时给明确报错并非零退出。

**Blocked by:** None(可立即开始)

**Status:** resolved

- [x] `models.yaml` 加载:一条模型条目按 `{ slug, endpointFamily, baseUrl, modelId, credentialEnvVar }` 加可选 `{ contextLength, protocolRounds, strategy, params }` 解析;缺字段 / 未知 `endpointFamily` / 缺 `credentialEnvVar` 给逐字段报错并非零退出。
- [x] 根目录解析与 `match` 一致(默认 cwd,`--root` 覆盖),`--config` 相对根;根下契约目录名与 `RULESET_VERSION` 不符、或缺 `rules.md` / `api.md` 即报错退出(不内嵌契约副本)。
- [x] `prompts/base.md` 薄壳模板被读取并渲染:`{{contract}}` 注入两份契约文档(拼接),`{{strategy}}` 缺省不注入;硬约束只以「见 `rules.md` §X / `api.md` §Y」的指针清单出现,**不复制判据文本**。
- [x] `ModelClient` 端口与可编程桩适配器就位;一次调用发出的 messages 含完整契约与模板渲染结果。
- [x] 测试(纯函数 + 端口):模板渲染的变量注入 / 缺省策略 / 指针清单不外泄判据文本;配置加载的各类错误;桩可编程回放。

## Answer

已实现并合并(合并提交 `0b73434`)。

- `models.yaml` 加载落 `packages/gen/src/config.ts`:必填 `slug` / `endpointFamily` / `baseUrl` / `modelId` / `credentialEnvVar`,可选 `contextLength` / `protocolRounds` / `strategy` / `params`;缺字段、未知端点族、缺 `credentialEnvVar` 均逐字段报错并非零退出。自带 `yaml-lite.ts` 解析器,不引 YAML 依赖。
- 契约读入 `contract.ts`:每次运行从 `<root>/docs/rules-<RULESET_VERSION>/{rules.md,api.md}` 读盘拼接(不嵌副本);目录名与版本不符、或缺文件即报错退出。根目录解析与 `match` 同约定(默认 cwd、`--root` 覆盖、`--config` 相对根)。
- `prompts/base.md` 薄壳模板 + `prompt.ts`:`{{contract}}` 注入两份契约的拼接结果、`{{strategy}}` 缺省整段不注入;硬约束只以指针清单出现,模板内不含判据文本。
- `ModelClient` 端口(`model-client.ts`)与可编程桩(`stub-client.ts`)就位;测试覆盖模板注入 / 缺省策略、配置各类错误、桩回放与 CLI 接线。
