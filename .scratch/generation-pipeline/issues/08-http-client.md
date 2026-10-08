# 08: 真实模型客户端——HTTP 三端点族、`.env` 与本地假端点契约测试

**What to build:** `ModelClient` 的真实适配器,让生成管线能对真实厂商发请求;端点族按配置分家,凭证只从环境变量读。

**Blocked by:** 02(编译、校验与原子冻结)

**Status:** resolved

- [x] 按 `endpointFamily` 分别向 `chat-completions` / `messages` / `responses` 发请求,响应映射到端口的统一形状(`text` / `finishReason` / `usage`);**不引厂商 SDK**。
- [x] 鉴权取 `process.env[credentialEnvVar]`,缺失即明确报错;凭证绝不入库、不进日志、不进存档。
- [x] gen 启动时若 `<root>/.env` 存在即 `process.loadEnvFile()` 加载(可选,不存在不报错)。
- [x] 契约测试用**本地假端点**断言三种端点族的请求形状与响应映射(含 `usage` / `finishReason`);测试不触网、不需凭证。

## Answer

已实现并合并(合并提交 `4406da6`)。

- `http/client.ts` + `http/endpoints.ts`:按 `endpointFamily` 分别向 `chat-completions` / `messages` / `responses` 发请求,响应映射到端口的 `text` / `finishReason` / `usage` 统一形状;不引厂商 SDK。
- 鉴权只取 `process.env[credentialEnvVar]`,缺失即明确报错;凭证不入库、不进日志、不进存档;gen 启动时 `<root>/.env` 存在即 `process.loadEnvFile()`(可选,不存在不报错)。
- `transport-error.ts` 把 HTTP 方言翻译成 `TransportError{retryable}`(429 / 5xx / 超时可重试,其余 4xx 不可重试),退避策略收在票 06 一处。
- 契约测试用本地假端点断言三端点族的请求形状与响应映射(含 `usage` / `finishReason`);测试不触网、不需凭证。
