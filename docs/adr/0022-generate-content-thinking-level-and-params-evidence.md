---
status: accepted
---

# Google 族的推理控制用 `thinkingLevel`,候选的实际参数随存档落档

ADR-0021 给 Google 线协议加了端点族,但把推理控制留在 `unverified`——因为当时没有任何可核对的真实响应。后果在 S2 赛季暴露:`gemini-4-argon` 的生成日志里 `reasoning: 0`、响应里没有 `thoughtsTokenCount`,同批其他渠道的模型首轮就烧掉 4.8k–16.7k reasoning tokens。它是在**零思考**下一次性写出脚本的,而名次被拿去和其他模型比。

2026-11-02 的直连探测把这格填上了:同一个渠道(`https://opencode.ai/inference/go/google/v1beta`),不带 `generationConfig` 时 `usageMetadata` 无 `thoughtsTokenCount`;带 `thinkingConfig: { thinkingLevel: "high" }` 时 HTTP 200 且 `thoughtsTokenCount: 118`。渠道接受且生效。

决定新增第七种 `ReasoningControl`:`thinking-level`,只对 `generate-content` 族合法,`generationParams()` 产出 `thinkingConfig: { thinkingLevel: "high", includeThoughts: true }`,由 `generateContentConfig` 原样透传进 `generationConfig`。`intent` 仍只有 `high` 一档,所以档位取值写死在映射里,不引入可配的三级枚举——多一个可配项就多一处「配了但没人发」的口子。

同时补一条证据纪律:每个优化阶段的候选把**实际发出的参数**写进 `optimization.candidates[].params`。此前只有 `generationLog[].params` 逐轮记录,要回答「冻结的那份候选用什么参数生成的」得先由 `selection.selected.stage` 找到 `protocolRound`,再回日志里比对,链子绕且容易被改动破坏。落档的是 `generationParams()` 的返回值本身(JSON 往返一次),与日志同源,不是事后重新推导的二手结论。

被否的方案:

- **用 `medium` / `low` 档位**:两档首帧只要 4–14 s,看着诱人,但真实响应里 `usageMetadata`
  没有 `thoughtsTokenCount`、渠道侧 `reasoning: 0` —— 它们在这个渠道上等于不思考。要牺牲的正是
  这个改动想换的东西。
- **调大输出上限来“间接限思考”**:思考 token 与 `maxOutputTokens` 是两套账,压上限只会截断答案。
- **把空闲超时留在 300 s、接受频繁重试**:一次失败白烧 5 分钟×4 次尝试,而且重试会重新思考,
  不收敛。见下段。

- **用 `thinkingBudget` 而不是 `thinkingLevel`**:Google 两套都有,但预算式与已有的 `thinking-enabled`(`budget_tokens`)语义重叠,而渠道对预算值的接受度尚未探测;等级式与本仓 `intent: high` 一一对应,且是这次唯一被真实响应验证过的形状。
- **放开 `params` 自由透传**:那等于取消「参数须有 policy 证据」这条纪律,生成侧再也无法证明「发出去的就是配置里声明过的」。
- **把 `params` 塞进 `meta` 顶层的第十二项**:`archive-meta.ts` 的头注把形状定死,加顶层字段会波及每份已冻结的 `meta.json` 与引用它的 `input.json`;而 `optimization` 本来就是可选的旁证扩展点,旧档没有 `params` 也照旧装载。

长期约束:新增端点族时,推理控制必须每个族单独占一格(`chat-effort` / `responses-effort` / `adaptive-effort` / `thinking-enabled` / `thinking-level` 各有归属族),不允许出现「任意族都能发任意控制」的通用口子;`candidates[].params` 在新档必须写,旧档缺它是兼容而不是默认值;`thinkingLevel` 固定 `high`,要降档先有真实响应证据与对应 policy 字段。

## 附带一:`includeThoughts` 不是可选装饰,是能跑通的前提

只发 `thinkingLevel: "high"` 时,思考期上游**一帧不发**。真实生成提示(18.6k tokens)下首帧要等 7 m 38 s,而网关的静默上限在 300 s 左右:连接被提前掐断,四次重试全部 `fetch failed`。把空闲超时从 300 s 提到 900 s 没用——那是我们这侧在等,不是网关。

加上 `includeThoughts: true` 后,思考增量本身成为帧:首帧 5 s,总时长 646 s(`thoughtsTokenCount: 39160`、思考文本 32k 字符),`finishReason: STOP` 正常完成。思考帧会持续重置空闲计时器,所以那个 900 s 常量在这里反而用不上,它在其他「真的断流」场景仍生效。

副作用与处理方式:`thought` 帧必须从正文里滤掉。`endpoints.ts` 本来就只拼 `part.thought !== true` 的文本,无需新逻辑;但这条已不再是「保险」而是**必要条件**——滤错就会把模型的内心独白当成脚本源码交给编译。

## 附带二:空闲超时从 300 s 提到 900 s

`thinkingLevel=high` 的代价是**首帧之前什么都没有**:实测同一请求首帧 245 s(短提示、think 19 066 tokens)到 7 m 38 s(真实生成提示、输入 18.6k tokens),而 `medium` / `low` 首帧只要 4–14 s。`packages/gen` 的空闲超时原本是 300 s,恰好卡在两者之间,把一个「想得很久但活得好好的」请求判成死连接,四次重试全打在同一堵墙上。

空闲超时的语义是「多久没字节算死连接」。思考期间没有字节**不等于**死连接,而流中途静默那层保护不该为它让路——两者要么各一个旋钮,要么把线画在真正死掉的那一侧。选后者:常量提到 900 s,流中途静默超过它的仍是死连接。这条改动波及所有端点族(它是全局常量,不是 per-model 旋钮),代价是「渠道整体僵死」的失败反馈晚 10 分钟才出现;换来的是慢热模型不再被误杀。

不接 `models.yaml` 的 per-model 旋钮:那会把「多久算死」变成每家渠道一个口径,而它本来只该由「真的有帧在流」与否决定。

重新评估的条件:渠道对 `thinkingBudget` 给出可核对响应(那时两种形状择一统一);模型支持多档 `thinkingLevel` 且赛季需要按需降档;或 `params` 落档被证明不足以回答「当时发的是什么」(例如端点侧还有隐式注入,那时要连请求头一起落)。
