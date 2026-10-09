# 10: gen 传输流式化——SSE 绕开网关 524,超时改为空闲口径

**What to build:** 把 `chat-completions` 端点族的请求切成 SSE 流式,使一次长生成在真正开始出字后不再被网关的 origin 超时(HTTP 524)或客户端 wall-clock 上限掐断;客户端超时从「整次请求总时长」改成「两次读到数据之间的空闲上限」。这是真实赛季(season 票 11)卡住后的前置修复:票 11 已实测,不修传输层,真实模型整批只有 1/5 冻结成功。

**Blocked by:** 无(基于已合并的 08 HTTP 客户端)

**Status:** resolved

## 根因(已实测,勿重复调查)

- `packages/gen/src/http/client.ts` 的 `DEFAULT_TIMEOUT_MS = 120_000`;真实契约(≈17.8k prompt tokens)下推理型模型单次生成 **150–176 s**(deepseek-flash 151.7 s、deepseek-v4.1 175.8 s)⇒ 客户端先超时,记为 `classification=transport`。
- `xiaomi/mimo-v2.6-flash` / `meta/muse-spark-1.3-contributor` 被网关在 **~130 s 处回 HTTP 524**(Cloudflare origin 超时)⇒ 只调大客户端超时救不了。
- Command Code 网关(`https://api.commandcode.ai/provider/v1/chat/completions`)**支持 SSE**:`stream: true` 后逐帧吐 chunk(实测 2026-10,`content-type: text/event-stream`)。流式下字节从一开始就流动,故既不再触发 origin 空闲超时(524),也让「总时长」不再是必须卡的量。

### SSE 帧实测形状(chat-completions,`stream: true`)

```
data: {"choices":[{"index":0,"delta":{"role":"assistant"},
        "finish_reason":null}], ...}                         ← 首帧
data: {"choices":[{"delta":{"reasoning_content":"The"},...}], ...}  ← 推理增量(非产物)
data: {"choices":[{"delta":{"content":"hi"},...}], ...}          ← 正式正文增量
data: {"choices":[{"delta":{},"finish_reason":"stop"}], ...}     ← 终点帧
data: {"choices":[],"usage":{"prompt_tokens":…,"completion_tokens":…,
        "completion_tokens_details":{"reasoning_tokens":…}}}      ← usage 帧(choices 为空)
data: [DONE]
```

- 截断时 `finish_reason` 直接是 `"length"`(实测 `max_tokens: 8` ⇒ `finish_reason: "length"`),`retry.ts` 的既有重试口径不动。
- `usage` 帧带 OpenAI 形状(含 `completion_tokens_details.reasoning_tokens`),与现非流式 `root.usage` 同形。
- 帧之间以空行分隔;`data: [DONE]` 收尾。

## 设计决定(照此实现,别扩面)

1. **只做 `chat-completions` 流式**。本期 5 条真实模型全部 `endpointFamily: chat-completions`;`messages` / `responses` 两族的 SSE 帧格式不同且本期无真实验证面,**保持非流式**,不写没测试的翻译。因此 `EndpointSpec` 上的流式能力是**可选字段**,只有 chat-completions 声明它。
2. **请求体** = 非流式请求体叠加 `stream: true` 与 `stream_options: { include_usage: true }`(端点已实测接受;`include_usage` 是 OpenAI 标准取 usage 的方式)。`params` 里若有同名键,流式字段以本层为准。
3. **按 `content-type` 分派解析**:响应 `content-type` 含 `text/event-stream` → 走 SSE 累积;否则回退现有一次性 JSON 解析。回退不是多此一举:它挡住了「端点忽略 `stream`、照旧回整段 JSON」的服务商,也让既有 `parseChatCompletions` 仍是活代码。
4. **超时改成空闲口径**:把现有 `AbortSignal.timeout(总时长)` 替换为「手动 `AbortController` + 定时器」,定时器在**每次读到一段数据时重置**;`DEFAULT_TIMEOUT_MS` 提到 `300_000`。非流式族没有中途数据可重置,行为等价于旧的总时长上限;流式下则是「两帧之间最多静默 300 s」。这是流式正确的语义:总时长设限会把「慢但一直在出字」的合法生成误杀,而真问题(524)本就是空闲超时。
5. **超时是 gen 内部工程常量,不接 `models.yaml` / 环境变量**:与 `retry.ts` 的 `RETRY` 同性质(运行韧性参数,不描述对局规则),单一真源就是常量本身,不做per-model 旋钮。
6. **失败归类沿用既有口径**(`transport-error.ts` / `retry.ts` 不动):
   - 流在 `[DONE]` 之前断掉(连接被切 / 读失败)→ `TransportError{ retryable: true }`;
   - 帧里是 `{"error": …}`(网关流中报错)→ `TransportError{ retryable: true }`;
   - `finish_reason: "length"` ⇒ 照 `retry.ts` 重发同一轮、不消耗协议轮数(本次改动不碰这里);
   - 状态码分类(429 / 5xx 可重试,其余 4xx 不可)不变。
7. **`text` 只累积 `delta.content`**;`delta.reasoning_content` 不进 `text`(它不是产物,回喂半截推理等于污染)。`usage` 取最后一个带 `usage` 的帧(保持 OpenAI 原形,`reasoning_tokens` 随 `completion_tokens_details` 一并留档)。`ModelResponse` 端口形状**不变**。
8. 不引任何 SSE / 厂商库,仍只用 Node 内置 `fetch` + `TextDecoder`。

### 落点

- `packages/gen/src/http/client.ts`:请求体分派 + 空闲超时 + SSE 读取(`data:` 行累积、`\r\n` 容忍、忽略注释/非 data 行)+ content-type 分派 + 失败归类。
- `packages/gen/src/http/endpoints.ts`:`EndpointSpec` 增可选 `streaming` 字段(流式 buildBody + 逐帧累积器工厂);`chat-completions` 声明之。
- `packages/gen/src/http/client.test.ts`:假端点补 SSE 用例(照现有 `node:http` 假端点形态);既有非流式用例改为按 content-type 回退路径仍然通过(现有 200 用例回的是 `application/json`,天然走回退)。
- `packages/gen/src/http/endpoints.test.ts`:补流式累积器的纯函数用例。

## 验收

- [x] `chat-completions` 请求体含 `stream: true` 与 `stream_options.include_usage`;`messages` / `responses` 请求体不带流式字段。
- [x] 假端点回 `text/event-stream` 多帧 → 客户端累积 `text` / `finishReason` / `usage`,与非流式返回同形。
- [x] 假端点回 `application/json` → 仍按旧路径解析(回退用例)。
- [x] 截断帧(`finish_reason: "length"`)→ 返回 `finishReason: "length"`(交给 `retry.ts` 重发同一轮,此处不重试)。
- [x] 流在 `[DONE]` 前断掉 / 帧含 `error` → `TransportError{ retryable: true }`。
- [x] 空闲超时:帧间静默超过注入的 `timeoutMs` → `TransportError{ retryable: true }`、无 status。
- [x] 端点持续吐帧、总时长超过 `timeoutMs` 但帧间隔始终小于它 → 正常成功(证明超时是空闲口径)。
- [x] `pnpm run check:quick` 与 `pnpm vitest run --project unit --project property packages/gen` 全绿。
- [x] **不动 `packages/gen` 之外的包**;不改 `packages/schema` / `archive-meta` / `apps/cli`。

## Answer

已实现(提交 `222eeba`,分支 `fix/gen-streaming`;票文件回写见紧随其后的 docs 提交)。

### 落点

- `packages/gen/src/http/endpoints.ts`
  - `EndpointSpec.streaming?`(第 34–35 行):**可选**流式能力。`StreamAccumulator`(第 39 行,`push` / `result`)与 `StreamingEndpoint`(第 59–61 行,流式 `buildBody` + 累积器工厂)两个类型随之新增。
  - `chatCompletionsStreamBody`(第 102 行):非流式体 + `stream: true` + `stream_options.include_usage`,排在 `...params` 之后,故 params 同名键压不过本层。
  - `createChatCompletionsAccumulator`(第 115 行):只拼 `delta.content`(忽略 `reasoning_content`);`finish_reason` 取最后一个非空值、缺省 `"stop"`;`usage` 取最后一个非空帧。
  - `endpointSpec` 的 `chat-completions` 分支声明 `streaming`(第 243–246 行);`messages` / `responses` **不声明**。
- `packages/gen/src/http/client.ts`
  - `DEFAULT_TIMEOUT_MS = 300_000`(第 50 行),文档改成「空闲上限」口径。
  - `isEventStream`(第 90 行,按 `content-type` 含 `text/event-stream` 分派);`dataPayloadOf`(第 97 行,`data:` 前缀 + `\r` 容忍 + 忽略非 data / 注释行);`parseSseFrame`(第 113 行,非法 JSON / 顶层非空 `error` → 可重试 `TransportError`)。
  - `readEventStream`(第 151 行):按 `\n` 切行、残留半行留在缓冲等下一个 chunk;`[DONE]` 收尾;`[DONE]` 前流结束 → 可重试 `TransportError`;空闲超时中断不挂 `status`,其余读失败挂已知状态码。
  - `send`(第 224 行起):手动 `AbortController` + 定时器,`armIdleTimer`(第 242 行)在响应头到达与每个 chunk 处重置;`chat-completions` 走流式体,其余族仍用非流式体;`ok && streaming && isEventStream` 才走 SSE,否则回退 `response.text()` + `JSON.parse` + `spec.parseResponse`。
- `transport-error.ts` / `retry.ts` / `model-client.ts` 未改;`ModelResponse` 端口形状不变。

### 新增 / 改动的测试

- `packages/gen/src/http/endpoints.test.ts`
  - 新增 5 条:**流式能力只在 chat-completions 声明**(第 181 行);流式请求体叠加两个流式字段、params 同名键压不过(第 187 行);累积器忽略 `reasoning_content`(第 208 行);`usage` 取最后一个非空帧、`usage:null` 不算(第 224 行);`finish_reason` 取最后一个非空值 / 缺省 `stop`(第 249、256 行)。
- `packages/gen/src/http/client.test.ts`
  - 原「chat-completions body 形状」用例改为断言**带两个流式字段**的请求体(第 147 行)。
  - 新增 8 条:JSON 回退(第 174 行);SSE 多帧累积出与非流式同形(第 192 行);**一帧被切成两个 chunk 也拼得回**(第 225 行);CRLF + 注释 / event / id 行容忍(第 248 行);`finish_reason=length` 透传(第 267 行);`[DONE]` 前断掉(第 284 行);error 帧(第 298 行);**帧间静默超时(第 315 行)与「总时长 > timeoutMs 但帧间隔 < timeoutMs 仍成功」(第 330 行,空闲口径证明)**。

### 验证

- `pnpm run check:quick` ✅(fmt / oxlint / toolchain coupling / quickjs coupling / no-float / budget 全绿)。
- `pnpm vitest run --project unit --project property packages/gen` ✅ `13 files / 120 tests passed`(基线 105)。
- 额外跑过 `pnpm run typecheck`(`tsc -b`)✅。

### SSE 帧实测复核要点(未触真网,留给票 11 首次真跑)

帧形状取自本票「实测」一节,本地假端点按**逐字形状**复刻(首帧 `delta.role` + `finish_reason:null`、`reasoning_content` 增量、`content` 增量、`delta:{}` 终点帧、`choices:[]` 的 usage 帧、`data: [DONE]`);本次**无凭证、未发真实请求**,故真网复核留三条:

1. 首字节是否在默认 300s 空闲窗口内到达(流式下应远早于此;若网关在 `stream: true` 下仍先憋住,那 524 就没被绕开)。
2. 收尾帧是否带 `usage`(即 `include_usage` 被网关透传);`reasoning_tokens` 是否随 `completion_tokens_details` 落进 `meta.generationLog`。
3. 真模型是否确实先吐 `reasoning_content` 再吐正文——若正文出现被截断的重复片段,先查是否误把推理增量拼进了 `text`(本实现已排除)。

### 与票面的偏离

无功能偏离。两点实现细节的选择:

- 非流式族(以及 SSE 回退路径)的空闲计时器在「响应头到达」时重置一次,故上界是「连接/头部窗口 + 整段响应窗口」各一个 `timeoutMs`,而不是旧实现单一的「从发起算起」。语义仍是「没有中途数据可重置时的总时长上限」,与票面「等价于旧的总时长上限」一致。
- 非法 JSON 的 `data:` 帧归为**可重试** `TransportError`(票面只点名了断流与 error 帧)。理由是它同属「网关给了我们读不懂的字节」这类传输故障,重发一次可能正好避开。

