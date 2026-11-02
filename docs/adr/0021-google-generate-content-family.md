---
status: accepted
---

# Google 线协议作为第四个端点族,并承认无收尾哨兵的流

名册要接 Google Gemini 系模型,而它的请求体形状(`contents` / `systemInstruction` / `generationConfig`、角色只有 `user` 与 `model`)、响应形状(`candidates[].content.parts[]`、`finishReason` 全大写、`usageMetadata`)与前三个端点族都不同。厂商 SDK(如 `@ai-sdk/google`)能把差异藏起来,但 hld §2.2.6 的「不引厂商 SDK」不是洁癖:gen 是整仓唯一联网的包,它的依赖面就是攻击面与升级面,而这里真正需要的只是一份稳定的 HTTP 形状。

决定新增第四个端点族 `generate-content`(取 Google 的动词名,与已有的 `chat-completions` / `messages` / `responses` 同为线协议名,不按厂商名),翻译仍集中在 `endpoints.ts`:`system` 抽到顶层 `systemInstruction`,`assistant` 换名 `model`,生成参数进 `generationConfig`,正文只拼非 `thought` 的 `parts[].text`,`MAX_TOKENS` 归一 `length`、安全类停止归一 `content_filter` 并保留原值在 `stopDetails`。`usageMetadata` 原样进日志,证据白名单补上它的 camelCase 计数名。

同时承认这条线协议与前三个不同的一点:**它的流没有收尾哨兵**。既不发 `data: [DONE]`,也没有 Anthropic 那样的 `message_stop` 事件,上游在最后一帧之后直接关连接。于是端点族多两个声明位:路径按配置求值(Google 把模型名与流式动词都写进路径,流式是 `:streamGenerateContent?alt=sse`),以及 `endsOnStreamClose`——流结束即收尾。后者带一个不可省的前置条件:累积器必须已经读到停止标记,`finishReason` 仍是 `unknown` 就照旧判「连接被中途切断」并可重试。

被否的方案:把 `generateContent` 也走 `chat-completions`(有些中转把 Google 套成 OpenAI 形状)。本渠道暴露的是原生 `v1beta` 路径,套壳要么加一层中间翻译、要么把真实协议藏进配置注释里,两种都比多写一个族更难查。另一个被否的是「流关闭即成功」而不校验停止标记:网关超时与中途断连会变成静默的半截产物,那正是本项目最不能接受的一类错误。

长期约束:端点族继续按线协议命名,新厂商若走同一线协议就只改配置;流式能力仍按「被真实响应验证过才声明」,Google 族的 `thinkingConfig` 还没有可核对的真实响应,故 policy 侧只能声明 `unverified`、不发该字段,也不预置推理控制映射;无哨兵收尾的「已读到停止标记」前置条件不得删除,删掉就等于用可靠性换一行代码。

重新评估的条件:渠道开始发 `[DONE]`(那时 `endsOnStreamClose` 可退役);Gemini 的 thinking 控制在真实响应里可核对(那时新增一族 reasoning control 与对应证据,而不是放开自由透传);或另一家厂商也走同一条线协议(那时只改配置,不改这个族)。
