# `messages` 族工具调用往返

`claude-haiku-5-5` 是名册里唯一挂 `/messages`(Anthropic 形状)而非 `/chat/completions` 的席位。
本目录记录该族的工具调用协议事实:声明形状会不会被拒、`tool_use` 回什么形状、`tool_result`
配不配得上。三件事各一次真请求,脚本可重跑。

它**不判**翻译正确性——那是 `packages/gen/src/http/endpoints.ts` 的事。

## 跑法

凭证从仓库根的 `.env` 读 `COMMAND_CODE_API_KEY`,脚本里不留 key:

```sh
node probes/messages-tool-roundtrip/probe.mjs
node probes/messages-tool-roundtrip/probe.mjs --json /tmp/messages-tool-roundtrip.json   # 落原始响应体
```

退出码 `0` = 三步都到了预期形状;`1` = 有一步没到(会把原始响应体打出来)。

## 读数(2026-11-21)

| | 请求 | 状态 | `stop_reason` | `content` 块 |
|---|---|---|---|---|
| ① | 不带 `tools` | 200 | `end_turn` | `text` |
| ② | 带 `tools` | 200 | `tool_use` | `tool_use` |
| ③ | 回显 assistant + 发 `tool_result` | 200 | `end_turn` | `thinking`, `text` |

①的原文(截断到 `usage` 前):

```json
{"model":"claude-haiku-5-5","type":"message","role":"assistant","content":[{"type":"text","text":"Hi there! How can I help you today?"}],"stop_reason":"end_turn",…}
```

②的 `content` 原文——**这是本族与 chat 族最实质的差别**:

```json
[{"type":"tool_use","id":"toolu_018uPE8eFnpritXWKqgCGX7W","name":"bash","input":{"command":"ls -la /"},"caller":{"type":"direct"}}]
```

- 键是 `id` / `name` / `input` 三个,没有 chat 族那种 `{type:"function", function:{…}}` 包裹。
- **`input` 是对象,不是 JSON 字符串。** chat 族的 `arguments` 是原文字符串,本仓 `TaggedToolCall`
  刻意存原文以保住逐字性(ADR-0031);本族没有那个位置,`argumentsJson` 到这里必须先 `JSON.parse`。
  这是「模型看到的字节 = 落盘的字节」在 `messages` 族上**不成立**的地方,不是实现疏漏。
- `caller` 是网关额外给的,不在本仓的类型里,不必回传。

③的 `thinking` 块说明推理是开着的,`signature` 也回来了:

```json
{"type":"thinking","thinking":"","signature":"CAQSnAYKEAgUGAI4AUIIdGhpbmtpbmc…"}
```

多步会话必须把 assistant 的 `content` **原样回显**(含 `thinking` 块与 `signature`),否则配对与
推理连续性都会断。

## 这份证据推翻了什么

ADR-0032 的 2026-11-20 修订段记的是:`claude-haiku-5-5` 在 `/messages` 上**带不带 `tools` 都是
HTTP 403 `permission_error`**,于是判「该席位整体被渠道拒 → `tool_result` 能否配对零证据 → 按
fail-closed 不声明工具」。2026-11-21 同一 key、同一端点、同一请求体形状复测,三步全部 200。

403 那两次是真发生过的(原文逐字记在 ADR 里),它也不是档位不足——同日的
`claude-haiku-4-5-20251001` 返的是另一句明确的 `MODEL_NOT_IN_PLAN: … available in Pro and above
plans`,两个措辞不同。据操作者说明,那两次是**代理/链路故障**,不是席位与账号档位的事实。

于是判据从「零证据」变成「证据在,翻译待实现」。ADR-0032 已补修订段,`endpoints.ts` 里三处
「零证据所以不写翻译」的注释也一并订正了。

## 一条旁证:渠道自己说必须走 `/messages`

```sh
curl -sS -X POST "https://api.commandcode.ai/provider/v1/chat/completions" \
  -H "authorization: Bearer $COMMAND_CODE_API_KEY" -d '{"model":"claude-haiku-5-5",…}'
# HTTP 400 {"error":{"message":"Model \"claude-haiku-5-5\" must be called via /provider/v1/messages
#   (Anthropic Messages shape).","code":"unsupported_model"}}
```

所以 `models.yaml` 给这个 slug 配 `endpointFamily: messages` 是对的,不是配错才是 403。
