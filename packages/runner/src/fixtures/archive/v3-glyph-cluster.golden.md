# 生成归档报告

> usage 的 cache / reasoning 是组成明细，不重复加总。缺失用 null；部分数据只给已记录小计。缓存写再按 TTL 分 5m / 1h 两档，它们与总量是组成关系而非互相冲突；缓存命中率 = 缓存读 / 总输入，只算两项都记到的轮，合计覆盖不完整时不给值。收敛响应与全部 HTTP 尝试是重叠证据，不相加作账单；传输错误消费未知。
> 三类分数互不替代：生成阶段（网格平均名次积分，分母 = 每候选场数）／选拔复算（独立子进程重跑同一张网格，只作校验读数，不是第二个排名依据）／赛季（赛季报告口径，本报告不冒充）。不属本档口径的分数写「不适用」，不补零、不留空。
> 配置和渠道能力是请求意图与支持声明；HTTP 接受不证明参数执行，服务端模型回报不认证后端身份。证据来源自由文本、prompt、原响应与诊断不公开。
> --run-id 显式指定本轮标识：其它记录为历史；未指定时全部未分轮，不将历史失败当作本轮失败或参赛资格。
> 最终观测独立读取 observed-<runId>.jsonl；旧档标记最后完成试跑，可能在 infra 后留旧读数。回喂前后的候选按协议 round 单列，不合并命中数。成功档最后 round 与最终文件精确匹配且新事实 hash 符合 meta 编译 JS hash 时标记最终候选。
> 缓存命中率是**回归哨兵**，不是效率指标：agent 形态每步重发完整历史，分子分母同步长，命中率是步数的函数而不是缓存效率的函数。它低于该步的理论值只说明前缀被打断了（时间戳注入、序列化不确定、中途改 system）——那是别处看不见的真 bug 信号。有信息量的是每步 prompt 大小与增长。
> 步级耗时是诊断列，不是排名主指标：`stepMs = sendMs + harnessMs`（模型慢还是沙箱慢由两列分开回答），会话总墙钟由 `max(atMs + sendMs + harnessMs)` 跨步聚合，档案顶层不另放一份。分位按最近秩（不插值）；缺数据写 null，不写 0。

- 本轮：成功记录 0；失败记录 0（记录数，不是参赛模型数）
- 历史：成功记录 0；失败记录 0（记录数，不是参赛模型数）
- 未分轮：成功记录 1；失败记录 0（记录数，不是参赛模型数）

## fixture-v3-glyph-cluster · success

- 来源：`archive/fixture-v3-glyph-cluster/2026-01-03T00-00-00-001Z/meta.json`
- 运行标识：2026-01-03T00-00-00-001Z；归属：unscoped
- 协议轮数：15（已收敛，不含 transport 末行）
- 已记录有效阶段数：3；不同 JS 数：3
- 模型预算：每阶段收敛响应上限 null；全程上限 null；实际已收敛 15
- HTTP 尝试：已记录 17；完整尝试证据覆盖 15/15 轮；带 token 统计响应 15；传输错误 2；已记录但消费未知 2
- 本地预算：有效候选优化观测 null 场（不代表全部重跑/无效候选执行）；选拔上限 null 场；已证实执行 null 场；复用 null 场
- 日志：partial（收敛可读 15/15 轮；记录 16 行）
- 分组键：modelVersion=stealth/glyph-cluster:free；harnessDigest=9c3ba5e089f7577d7ab7b5869bc5383cac3729f411d8890000e90763f720b542
- 形状：archiveSchemaVersion=3；harness=bash-mini/0.1；上下文窗口=256000；终止=wall-clock（第 15 步）
- 受污染：clean（429 尝试 2 次；累计退避 3266 ms；命中判据=无）

| 轮次 | sendMs | 输入 token | 输出 token | 缓存读 | 缓存写 | 推理 | 缓存命中率 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 34958 | 1865 | 360 | 0 | 0 | 271 | 0.0% |
| 2 | 36380 | 7377 | 958 | 1536 | 0 | 835 | 20.8% |
| 3 | 54416 | 12992 | 1241 | 0 | 0 | 1116 | 0.0% |
| 4 | 62931 | 18657 | 2384 | 12800 | 0 | 2242 | 68.6% |
| 5 | 32330 | 24315 | 1111 | 1536 | 0 | 906 | 6.3% |
| 6 | 57187 | 30058 | 1760 | 24064 | 0 | 1664 | 80.1% |
| 7 | 229439 | 32145 | 9618 | 29696 | 0 | 5418 | 92.4% |
| 8 | 69095 | 36394 | 1990 | 31744 | 0 | 1972 | 87.2% |
| 9 | 41758 | 37182 | 817 | 36352 | 0 | 749 | 97.8% |
| 10 | 222638 | 43586 | 8930 | 36864 | 0 | 4697 | 84.6% |
| 11 | 93363 | 47868 | 1711 | 43520 | 0 | 1693 | 90.9% |
| 12 | 54446 | 48752 | 1437 | 47616 | 0 | 1406 | 97.7% |
| 13 | 165783 | 53482 | 7241 | 48640 | 0 | 3777 | 90.9% |
| 14 | 179503 | 56989 | 5914 | 53248 | 0 | 2351 | 93.4% |
| 15 | 63451 | 60595 | 1786 | 56832 | 0 | 1768 | 93.8% |

### 步级度量（轮号 = 步号）

- 步数：15；轮 × 步关联：15/15 匹配（缺日志行的步=无；缺过程记录的轮=无；传输末行不占步，不算不匹配）
- 步级耗时 p50/p95/max：stepMs=62971 / 230021 / 230021（n=15）；sendMs=62931 / 229439 / 229439（n=15）；会话中位数 stepMs=62971；会话总墙钟（max of atMs+stepMs）=1719495
- prompt 大小 p50/p95/max：36394 / 60595 / 60595（n=15）；每步增长 input[i]−input[i−1] 的最大值=6404（首步是 null，不是 0）

| 步 | 动作 | stepMs | sendMs | harnessMs | atMs | 输入 token | 增长 | 缓存命中率 | 结果 | 关联 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | bash | 35025 | 34958 | 67 | 0 | 1865 | null | 0.0% | null | round==step |
| 2 | bash | 36439 | 36380 | 59 | 35025 | 7377 | 5512 | 20.8% | null | round==step |
| 3 | bash | 54469 | 54416 | 53 | 71464 | 12992 | 5615 | 0.0% | null | round==step |
| 4 | bash | 62971 | 62931 | 40 | 125933 | 18657 | 5665 | 68.6% | null | round==step |
| 5 | bash | 32373 | 32330 | 43 | 188904 | 24315 | 5658 | 6.3% | null | round==step |
| 6 | bash | 57222 | 57187 | 35 | 221277 | 30058 | 5743 | 80.1% | null | round==step |
| 7 | bash | 230021 | 229439 | 582 | 278499 | 32145 | 2087 | 92.4% | null | round==step |
| 8 | evaluate | 172839 | 69095 | 103744 | 508520 | 36394 | 4249 | 87.2% | null | round==step |
| 9 | bash | 41808 | 41758 | 50 | 681359 | 37182 | 788 | 97.8% | null | round==step |
| 10 | bash | 223176 | 222638 | 538 | 723167 | 43586 | 6404 | 84.6% | null | round==step |
| 11 | evaluate | 192520 | 93363 | 99157 | 946343 | 47868 | 4282 | 90.9% | null | round==step |
| 12 | bash | 54484 | 54446 | 38 | 1138863 | 48752 | 884 | 97.7% | null | round==step |
| 13 | bash | 166373 | 165783 | 590 | 1193347 | 53482 | 4730 | 90.9% | null | round==step |
| 14 | bash | 180053 | 179503 | 550 | 1359720 | 56989 | 3507 | 93.4% | null | round==step |
| 15 | evaluate | 179722 | 63451 | 116271 | 1539773 | 60595 | 3606 | 93.8% | null | round==step |

候选序（`evaluate` 即提交）：
- 真源：候选描述符（`optimization.candidates`）；动作标签只作注，不参与筛选
- 第 8 步：scriptSha256=9c120a50f0ad1d8382e42a74cdf59a84e51e4f91af7a63e507c4bb64cfdf81f5
- 第 11 步：scriptSha256=53672aaff47e4e013693d1e01ac8f267c9aa309dedb488d24d794f5659e57e8c；与上一次提交（第 8 步）字节不同；之间经过 2 步（9:bash / 10:bash）
- 第 15 步：scriptSha256=40cef1169f8ed17b87291fc29b0e8bffa74fa9163495abe0391a745481dc2c99；与上一次提交（第 11 步）字节不同；之间经过 3 步（12:bash / 13:bash / 14:bash）

### 参数与尝试证据

- 第 1 轮：已收敛响应；实际参数 {}；采样偏置已配置=false
- 配置 ID=fixture-v3-glyph-cluster；ID 匹配=false；端点族=chat-completions；后端身份=unverified
- 端点能力：official=unverified；channel=accepted
- 推理意图=high；控制=unverified；thinking 预算=null；official=unverified；channel=unverified
- 输出字段=server-default；上限=null；含推理=unknown；official=unverified；channel=unverified
- 缓存断点：mode=null；official=null；channel=null
- 请求头契约：authentication=bearer；版本头有记录=false
- 停止：{"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":null,"state":"missing"}}；尝试证据=recorded
- 第 1 轮 attempt 1：response；失败细分=null；停止 {"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":"stop","state":"recorded"}}；token 输入 token=1865；输出 token=360；缓存读=0；缓存写=0；推理=271
- 第 2 轮：已收敛响应；实际参数 {}；采样偏置已配置=false
- 配置 ID=fixture-v3-glyph-cluster；ID 匹配=false；端点族=chat-completions；后端身份=unverified
- 端点能力：official=unverified；channel=accepted
- 推理意图=high；控制=unverified；thinking 预算=null；official=unverified；channel=unverified
- 输出字段=server-default；上限=null；含推理=unknown；official=unverified；channel=unverified
- 缓存断点：mode=null；official=null；channel=null
- 请求头契约：authentication=bearer；版本头有记录=false
- 停止：{"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":null,"state":"missing"}}；尝试证据=recorded
- 第 2 轮 attempt 1：response；失败细分=null；停止 {"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":"stop","state":"recorded"}}；token 输入 token=7377；输出 token=958；缓存读=1536；缓存写=0；推理=835
- 第 3 轮：已收敛响应；实际参数 {}；采样偏置已配置=false
- 配置 ID=fixture-v3-glyph-cluster；ID 匹配=false；端点族=chat-completions；后端身份=unverified
- 端点能力：official=unverified；channel=accepted
- 推理意图=high；控制=unverified；thinking 预算=null；official=unverified；channel=unverified
- 输出字段=server-default；上限=null；含推理=unknown；official=unverified；channel=unverified
- 缓存断点：mode=null；official=null；channel=null
- 请求头契约：authentication=bearer；版本头有记录=false
- 停止：{"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":null,"state":"missing"}}；尝试证据=recorded
- 第 3 轮 attempt 1：transport-error；失败细分=rate-limited；停止 {"finishReason":{"value":null,"state":"missing"},"status":{"value":null,"state":"missing"},"reason":{"value":null,"state":"missing"}}；token 输入 token=null；输出 token=null；缓存读=null；缓存写=null；推理=null
- 第 3 轮 attempt 2：transport-error；失败细分=rate-limited；停止 {"finishReason":{"value":null,"state":"missing"},"status":{"value":null,"state":"missing"},"reason":{"value":null,"state":"missing"}}；token 输入 token=null；输出 token=null；缓存读=null；缓存写=null；推理=null
- 第 3 轮 attempt 3：response；失败细分=null；停止 {"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":"stop","state":"recorded"}}；token 输入 token=12992；输出 token=1241；缓存读=0；缓存写=0；推理=1116
- 第 4 轮：已收敛响应；实际参数 {}；采样偏置已配置=false
- 配置 ID=fixture-v3-glyph-cluster；ID 匹配=false；端点族=chat-completions；后端身份=unverified
- 端点能力：official=unverified；channel=accepted
- 推理意图=high；控制=unverified；thinking 预算=null；official=unverified；channel=unverified
- 输出字段=server-default；上限=null；含推理=unknown；official=unverified；channel=unverified
- 缓存断点：mode=null；official=null；channel=null
- 请求头契约：authentication=bearer；版本头有记录=false
- 停止：{"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":null,"state":"missing"}}；尝试证据=recorded
- 第 4 轮 attempt 1：response；失败细分=null；停止 {"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":"stop","state":"recorded"}}；token 输入 token=18657；输出 token=2384；缓存读=12800；缓存写=0；推理=2242
- 第 5 轮：已收敛响应；实际参数 {}；采样偏置已配置=false
- 配置 ID=fixture-v3-glyph-cluster；ID 匹配=false；端点族=chat-completions；后端身份=unverified
- 端点能力：official=unverified；channel=accepted
- 推理意图=high；控制=unverified；thinking 预算=null；official=unverified；channel=unverified
- 输出字段=server-default；上限=null；含推理=unknown；official=unverified；channel=unverified
- 缓存断点：mode=null；official=null；channel=null
- 请求头契约：authentication=bearer；版本头有记录=false
- 停止：{"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":null,"state":"missing"}}；尝试证据=recorded
- 第 5 轮 attempt 1：response；失败细分=null；停止 {"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":"stop","state":"recorded"}}；token 输入 token=24315；输出 token=1111；缓存读=1536；缓存写=0；推理=906
- 第 6 轮：已收敛响应；实际参数 {}；采样偏置已配置=false
- 配置 ID=fixture-v3-glyph-cluster；ID 匹配=false；端点族=chat-completions；后端身份=unverified
- 端点能力：official=unverified；channel=accepted
- 推理意图=high；控制=unverified；thinking 预算=null；official=unverified；channel=unverified
- 输出字段=server-default；上限=null；含推理=unknown；official=unverified；channel=unverified
- 缓存断点：mode=null；official=null；channel=null
- 请求头契约：authentication=bearer；版本头有记录=false
- 停止：{"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":null,"state":"missing"}}；尝试证据=recorded
- 第 6 轮 attempt 1：response；失败细分=null；停止 {"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":"stop","state":"recorded"}}；token 输入 token=30058；输出 token=1760；缓存读=24064；缓存写=0；推理=1664
- 第 7 轮：已收敛响应；实际参数 {}；采样偏置已配置=false
- 配置 ID=fixture-v3-glyph-cluster；ID 匹配=false；端点族=chat-completions；后端身份=unverified
- 端点能力：official=unverified；channel=accepted
- 推理意图=high；控制=unverified；thinking 预算=null；official=unverified；channel=unverified
- 输出字段=server-default；上限=null；含推理=unknown；official=unverified；channel=unverified
- 缓存断点：mode=null；official=null；channel=null
- 请求头契约：authentication=bearer；版本头有记录=false
- 停止：{"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":null,"state":"missing"}}；尝试证据=recorded
- 第 7 轮 attempt 1：response；失败细分=null；停止 {"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":"stop","state":"recorded"}}；token 输入 token=32145；输出 token=9618；缓存读=29696；缓存写=0；推理=5418
- 第 8 轮：已收敛响应；实际参数 {}；采样偏置已配置=false
- 配置 ID=fixture-v3-glyph-cluster；ID 匹配=false；端点族=chat-completions；后端身份=unverified
- 端点能力：official=unverified；channel=accepted
- 推理意图=high；控制=unverified；thinking 预算=null；official=unverified；channel=unverified
- 输出字段=server-default；上限=null；含推理=unknown；official=unverified；channel=unverified
- 缓存断点：mode=null；official=null；channel=null
- 请求头契约：authentication=bearer；版本头有记录=false
- 停止：{"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":null,"state":"missing"}}；尝试证据=recorded
- 第 8 轮 attempt 1：response；失败细分=null；停止 {"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":"stop","state":"recorded"}}；token 输入 token=36394；输出 token=1990；缓存读=31744；缓存写=0；推理=1972
- 第 9 轮：已收敛响应；实际参数 {}；采样偏置已配置=false
- 配置 ID=fixture-v3-glyph-cluster；ID 匹配=false；端点族=chat-completions；后端身份=unverified
- 端点能力：official=unverified；channel=accepted
- 推理意图=high；控制=unverified；thinking 预算=null；official=unverified；channel=unverified
- 输出字段=server-default；上限=null；含推理=unknown；official=unverified；channel=unverified
- 缓存断点：mode=null；official=null；channel=null
- 请求头契约：authentication=bearer；版本头有记录=false
- 停止：{"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":null,"state":"missing"}}；尝试证据=recorded
- 第 9 轮 attempt 1：response；失败细分=null；停止 {"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":"stop","state":"recorded"}}；token 输入 token=37182；输出 token=817；缓存读=36352；缓存写=0；推理=749
- 第 10 轮：已收敛响应；实际参数 {}；采样偏置已配置=false
- 配置 ID=fixture-v3-glyph-cluster；ID 匹配=false；端点族=chat-completions；后端身份=unverified
- 端点能力：official=unverified；channel=accepted
- 推理意图=high；控制=unverified；thinking 预算=null；official=unverified；channel=unverified
- 输出字段=server-default；上限=null；含推理=unknown；official=unverified；channel=unverified
- 缓存断点：mode=null；official=null；channel=null
- 请求头契约：authentication=bearer；版本头有记录=false
- 停止：{"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":null,"state":"missing"}}；尝试证据=recorded
- 第 10 轮 attempt 1：response；失败细分=null；停止 {"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":"stop","state":"recorded"}}；token 输入 token=43586；输出 token=8930；缓存读=36864；缓存写=0；推理=4697
- 第 11 轮：已收敛响应；实际参数 {}；采样偏置已配置=false
- 配置 ID=fixture-v3-glyph-cluster；ID 匹配=false；端点族=chat-completions；后端身份=unverified
- 端点能力：official=unverified；channel=accepted
- 推理意图=high；控制=unverified；thinking 预算=null；official=unverified；channel=unverified
- 输出字段=server-default；上限=null；含推理=unknown；official=unverified；channel=unverified
- 缓存断点：mode=null；official=null；channel=null
- 请求头契约：authentication=bearer；版本头有记录=false
- 停止：{"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":null,"state":"missing"}}；尝试证据=recorded
- 第 11 轮 attempt 1：response；失败细分=null；停止 {"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":"stop","state":"recorded"}}；token 输入 token=47868；输出 token=1711；缓存读=43520；缓存写=0；推理=1693
- 第 12 轮：已收敛响应；实际参数 {}；采样偏置已配置=false
- 配置 ID=fixture-v3-glyph-cluster；ID 匹配=false；端点族=chat-completions；后端身份=unverified
- 端点能力：official=unverified；channel=accepted
- 推理意图=high；控制=unverified；thinking 预算=null；official=unverified；channel=unverified
- 输出字段=server-default；上限=null；含推理=unknown；official=unverified；channel=unverified
- 缓存断点：mode=null；official=null；channel=null
- 请求头契约：authentication=bearer；版本头有记录=false
- 停止：{"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":null,"state":"missing"}}；尝试证据=recorded
- 第 12 轮 attempt 1：response；失败细分=null；停止 {"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":"stop","state":"recorded"}}；token 输入 token=48752；输出 token=1437；缓存读=47616；缓存写=0；推理=1406
- 第 13 轮：已收敛响应；实际参数 {}；采样偏置已配置=false
- 配置 ID=fixture-v3-glyph-cluster；ID 匹配=false；端点族=chat-completions；后端身份=unverified
- 端点能力：official=unverified；channel=accepted
- 推理意图=high；控制=unverified；thinking 预算=null；official=unverified；channel=unverified
- 输出字段=server-default；上限=null；含推理=unknown；official=unverified；channel=unverified
- 缓存断点：mode=null；official=null；channel=null
- 请求头契约：authentication=bearer；版本头有记录=false
- 停止：{"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":null,"state":"missing"}}；尝试证据=recorded
- 第 13 轮 attempt 1：response；失败细分=null；停止 {"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":"stop","state":"recorded"}}；token 输入 token=53482；输出 token=7241；缓存读=48640；缓存写=0；推理=3777
- 第 14 轮：已收敛响应；实际参数 {}；采样偏置已配置=false
- 配置 ID=fixture-v3-glyph-cluster；ID 匹配=false；端点族=chat-completions；后端身份=unverified
- 端点能力：official=unverified；channel=accepted
- 推理意图=high；控制=unverified；thinking 预算=null；official=unverified；channel=unverified
- 输出字段=server-default；上限=null；含推理=unknown；official=unverified；channel=unverified
- 缓存断点：mode=null；official=null；channel=null
- 请求头契约：authentication=bearer；版本头有记录=false
- 停止：{"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":null,"state":"missing"}}；尝试证据=recorded
- 第 14 轮 attempt 1：response；失败细分=null；停止 {"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":"stop","state":"recorded"}}；token 输入 token=56989；输出 token=5914；缓存读=53248；缓存写=0；推理=2351
- 第 15 轮：已收敛响应；实际参数 {}；采样偏置已配置=false
- 配置 ID=fixture-v3-glyph-cluster；ID 匹配=false；端点族=chat-completions；后端身份=unverified
- 端点能力：official=unverified；channel=accepted
- 推理意图=high；控制=unverified；thinking 预算=null；official=unverified；channel=unverified
- 输出字段=server-default；上限=null；含推理=unknown；official=unverified；channel=unverified
- 缓存断点：mode=null；official=null；channel=null
- 请求头契约：authentication=bearer；版本头有记录=false
- 停止：{"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":null,"state":"missing"}}；尝试证据=recorded
- 第 15 轮 attempt 1：response；失败细分=null；停止 {"finishReason":{"value":"stop","state":"recorded"},"status":{"value":null,"state":"missing"},"reason":{"value":"stop","state":"recorded"}}；token 输入 token=60595；输出 token=1786；缓存读=56832；缓存写=0；推理=1768

### 计划、陪练与三类分数

- 生成阶段计划：不适用（版本 1 历史档没有计划字段，不迁移、不回填）；v3 分步档的优化段也不装计划——网格计划不进档案；这一跑跟谁打从候选旁挂的 `.grid.json` 读（见下）
- 陪练：未记录（第 8 步候选，来源 archive/fixture-v3-glyph-cluster/observed-2026-01-03T00-00-00-001Z-round-8.jsonl.grid.json）
- 陪练：未记录（第 11 步候选，来源 archive/fixture-v3-glyph-cluster/observed-2026-01-03T00-00-00-001Z-round-11.jsonl.grid.json）
- 陪练：未记录（第 15 步候选，来源 archive/fixture-v3-glyph-cluster/observed-2026-01-03T00-00-00-001Z-round-15.jsonl.grid.json）
- 同字节直读：看下表「复用来源」列——标出阶段号的是编译产物与那一阶段字节相同、复用它的网格结果
- 不适用 = 该口径不属本档（v1 历史档没有网格分数；无选拔段时没有复算读数；赛季分数恒不适用）

| 阶段 | 协议轮 | JS hash | TS hash | 复用来源 | 生成阶段分数 | 选拔复算（校验读数） | 赛季分数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 8 | 9c120a50f0ad1d8382e42a74cdf59a84e51e4f91af7a63e507c4bb64cfdf81f5 | null | null | 均分 0.625（总分 20 / 分母 32） | 不适用 | 不适用 |
| 1 | 11 | 53672aaff47e4e013693d1e01ac8f267c9aa309dedb488d24d794f5659e57e8c | null | null | 均分 0.71875（总分 23 / 分母 32） | 不适用 | 不适用 |
| 2 | 15 | 40cef1169f8ed17b87291fc29b0e8bffa74fa9163495abe0391a745481dc2c99 | null | null | 均分 0.34375（总分 11 / 分母 32） | 不适用 | 不适用 |

### 合计（仅收敛响应）

- sendMs：1397678（已记录小计 1397678；覆盖 15/15）
- 输入 token：512257（已记录小计 512257；覆盖 15/15）
- 输出 token：47258（已记录小计 47258；覆盖 15/15）
- 缓存读：424448（已记录小计 424448；覆盖 15/15）
- 缓存写：0（已记录小计 0；覆盖 15/15）
- 推理：30865（已记录小计 30865；覆盖 15/15）
- 缓存命中率：82.9%（已记录 82.9%；缓存读 424448 / 输入 512257；覆盖 15/15）

### 逐轮字段来源

- 第 1 轮 sendMs：34958（generationLog.sendMs）
- 第 1 轮 输入 token：1865（recorded）；采用 usage.prompt_tokens；口径 total-input
- 第 1 轮 输出 token：360（recorded）；采用 usage.completion_tokens
- 第 1 轮 缓存读：0（recorded）；采用 usage.prompt_tokens_details.cached_tokens
- 第 1 轮 缓存写：0（recorded）；采用 usage.cache_creation_input_tokens
- 第 1 轮 推理：271（recorded）；采用 usage.completion_tokens_details.reasoning_tokens
- 第 2 轮 sendMs：36380（generationLog.sendMs）
- 第 2 轮 输入 token：7377（recorded）；采用 usage.prompt_tokens；口径 total-input
- 第 2 轮 输出 token：958（recorded）；采用 usage.completion_tokens
- 第 2 轮 缓存读：1536（recorded）；采用 usage.prompt_tokens_details.cached_tokens
- 第 2 轮 缓存写：0（recorded）；采用 usage.cache_creation_input_tokens
- 第 2 轮 推理：835（recorded）；采用 usage.completion_tokens_details.reasoning_tokens
- 第 3 轮 sendMs：54416（generationLog.sendMs）
- 第 3 轮 输入 token：12992（recorded）；采用 usage.prompt_tokens；口径 total-input
- 第 3 轮 输出 token：1241（recorded）；采用 usage.completion_tokens
- 第 3 轮 缓存读：0（recorded）；采用 usage.prompt_tokens_details.cached_tokens
- 第 3 轮 缓存写：0（recorded）；采用 usage.cache_creation_input_tokens
- 第 3 轮 推理：1116（recorded）；采用 usage.completion_tokens_details.reasoning_tokens
- 第 4 轮 sendMs：62931（generationLog.sendMs）
- 第 4 轮 输入 token：18657（recorded）；采用 usage.prompt_tokens；口径 total-input
- 第 4 轮 输出 token：2384（recorded）；采用 usage.completion_tokens
- 第 4 轮 缓存读：12800（recorded）；采用 usage.prompt_tokens_details.cached_tokens
- 第 4 轮 缓存写：0（recorded）；采用 usage.cache_creation_input_tokens
- 第 4 轮 推理：2242（recorded）；采用 usage.completion_tokens_details.reasoning_tokens
- 第 5 轮 sendMs：32330（generationLog.sendMs）
- 第 5 轮 输入 token：24315（recorded）；采用 usage.prompt_tokens；口径 total-input
- 第 5 轮 输出 token：1111（recorded）；采用 usage.completion_tokens
- 第 5 轮 缓存读：1536（recorded）；采用 usage.prompt_tokens_details.cached_tokens
- 第 5 轮 缓存写：0（recorded）；采用 usage.cache_creation_input_tokens
- 第 5 轮 推理：906（recorded）；采用 usage.completion_tokens_details.reasoning_tokens
- 第 6 轮 sendMs：57187（generationLog.sendMs）
- 第 6 轮 输入 token：30058（recorded）；采用 usage.prompt_tokens；口径 total-input
- 第 6 轮 输出 token：1760（recorded）；采用 usage.completion_tokens
- 第 6 轮 缓存读：24064（recorded）；采用 usage.prompt_tokens_details.cached_tokens
- 第 6 轮 缓存写：0（recorded）；采用 usage.cache_creation_input_tokens
- 第 6 轮 推理：1664（recorded）；采用 usage.completion_tokens_details.reasoning_tokens
- 第 7 轮 sendMs：229439（generationLog.sendMs）
- 第 7 轮 输入 token：32145（recorded）；采用 usage.prompt_tokens；口径 total-input
- 第 7 轮 输出 token：9618（recorded）；采用 usage.completion_tokens
- 第 7 轮 缓存读：29696（recorded）；采用 usage.prompt_tokens_details.cached_tokens
- 第 7 轮 缓存写：0（recorded）；采用 usage.cache_creation_input_tokens
- 第 7 轮 推理：5418（recorded）；采用 usage.completion_tokens_details.reasoning_tokens
- 第 8 轮 sendMs：69095（generationLog.sendMs）
- 第 8 轮 输入 token：36394（recorded）；采用 usage.prompt_tokens；口径 total-input
- 第 8 轮 输出 token：1990（recorded）；采用 usage.completion_tokens
- 第 8 轮 缓存读：31744（recorded）；采用 usage.prompt_tokens_details.cached_tokens
- 第 8 轮 缓存写：0（recorded）；采用 usage.cache_creation_input_tokens
- 第 8 轮 推理：1972（recorded）；采用 usage.completion_tokens_details.reasoning_tokens
- 第 9 轮 sendMs：41758（generationLog.sendMs）
- 第 9 轮 输入 token：37182（recorded）；采用 usage.prompt_tokens；口径 total-input
- 第 9 轮 输出 token：817（recorded）；采用 usage.completion_tokens
- 第 9 轮 缓存读：36352（recorded）；采用 usage.prompt_tokens_details.cached_tokens
- 第 9 轮 缓存写：0（recorded）；采用 usage.cache_creation_input_tokens
- 第 9 轮 推理：749（recorded）；采用 usage.completion_tokens_details.reasoning_tokens
- 第 10 轮 sendMs：222638（generationLog.sendMs）
- 第 10 轮 输入 token：43586（recorded）；采用 usage.prompt_tokens；口径 total-input
- 第 10 轮 输出 token：8930（recorded）；采用 usage.completion_tokens
- 第 10 轮 缓存读：36864（recorded）；采用 usage.prompt_tokens_details.cached_tokens
- 第 10 轮 缓存写：0（recorded）；采用 usage.cache_creation_input_tokens
- 第 10 轮 推理：4697（recorded）；采用 usage.completion_tokens_details.reasoning_tokens
- 第 11 轮 sendMs：93363（generationLog.sendMs）
- 第 11 轮 输入 token：47868（recorded）；采用 usage.prompt_tokens；口径 total-input
- 第 11 轮 输出 token：1711（recorded）；采用 usage.completion_tokens
- 第 11 轮 缓存读：43520（recorded）；采用 usage.prompt_tokens_details.cached_tokens
- 第 11 轮 缓存写：0（recorded）；采用 usage.cache_creation_input_tokens
- 第 11 轮 推理：1693（recorded）；采用 usage.completion_tokens_details.reasoning_tokens
- 第 12 轮 sendMs：54446（generationLog.sendMs）
- 第 12 轮 输入 token：48752（recorded）；采用 usage.prompt_tokens；口径 total-input
- 第 12 轮 输出 token：1437（recorded）；采用 usage.completion_tokens
- 第 12 轮 缓存读：47616（recorded）；采用 usage.prompt_tokens_details.cached_tokens
- 第 12 轮 缓存写：0（recorded）；采用 usage.cache_creation_input_tokens
- 第 12 轮 推理：1406（recorded）；采用 usage.completion_tokens_details.reasoning_tokens
- 第 13 轮 sendMs：165783（generationLog.sendMs）
- 第 13 轮 输入 token：53482（recorded）；采用 usage.prompt_tokens；口径 total-input
- 第 13 轮 输出 token：7241（recorded）；采用 usage.completion_tokens
- 第 13 轮 缓存读：48640（recorded）；采用 usage.prompt_tokens_details.cached_tokens
- 第 13 轮 缓存写：0（recorded）；采用 usage.cache_creation_input_tokens
- 第 13 轮 推理：3777（recorded）；采用 usage.completion_tokens_details.reasoning_tokens
- 第 14 轮 sendMs：179503（generationLog.sendMs）
- 第 14 轮 输入 token：56989（recorded）；采用 usage.prompt_tokens；口径 total-input
- 第 14 轮 输出 token：5914（recorded）；采用 usage.completion_tokens
- 第 14 轮 缓存读：53248（recorded）；采用 usage.prompt_tokens_details.cached_tokens
- 第 14 轮 缓存写：0（recorded）；采用 usage.cache_creation_input_tokens
- 第 14 轮 推理：2351（recorded）；采用 usage.completion_tokens_details.reasoning_tokens
- 第 15 轮 sendMs：63451（generationLog.sendMs）
- 第 15 轮 输入 token：60595（recorded）；采用 usage.prompt_tokens；口径 total-input
- 第 15 轮 输出 token：1786（recorded）；采用 usage.completion_tokens
- 第 15 轮 缓存读：56832（recorded）；采用 usage.prompt_tokens_details.cached_tokens
- 第 15 轮 缓存写：0（recorded）；采用 usage.cache_creation_input_tokens
- 第 15 轮 推理：1768（recorded）；采用 usage.completion_tokens_details.reasoning_tokens
- 日志第 16 行：未收敛日志只能是传输失败末行

### 初次候选（协议轮 8）

- JS 来源：archive/fixture-v3-glyph-cluster/observed-2026-01-03T00-00-00-001Z-round-8.jsonl.candidate.js；状态：verified
- scriptSha256=9c120a50f0ad1d8382e42a74cdf59a84e51e4f91af7a63e507c4bb64cfdf81f5；实际 hash=9c120a50f0ad1d8382e42a74cdf59a84e51e4f91af7a63e507c4bb64cfdf81f5
- 实际参数（白名单投影）：{}；采样偏置已配置=false
- 观测状态：missing；来源：archive/fixture-v3-glyph-cluster/observed-2026-01-03T00-00-00-001Z-round-8.jsonl
- 实际场数 null；noScoreSource null

### 中间候选（协议轮 11）

- JS 来源：archive/fixture-v3-glyph-cluster/observed-2026-01-03T00-00-00-001Z-round-11.jsonl.candidate.js；状态：verified
- scriptSha256=53672aaff47e4e013693d1e01ac8f267c9aa309dedb488d24d794f5659e57e8c；实际 hash=53672aaff47e4e013693d1e01ac8f267c9aa309dedb488d24d794f5659e57e8c
- 实际参数（白名单投影）：{}；采样偏置已配置=false
- 观测状态：missing；来源：archive/fixture-v3-glyph-cluster/observed-2026-01-03T00-00-00-001Z-round-11.jsonl
- 实际场数 null；noScoreSource null

### 最终候选（协议轮 15）

- JS 来源：archive/fixture-v3-glyph-cluster/observed-2026-01-03T00-00-00-001Z-round-15.jsonl.candidate.js；状态：verified
- scriptSha256=40cef1169f8ed17b87291fc29b0e8bffa74fa9163495abe0391a745481dc2c99；实际 hash=40cef1169f8ed17b87291fc29b0e8bffa74fa9163495abe0391a745481dc2c99
- 实际参数（白名单投影）：{}；采样偏置已配置=false
- 观测状态：missing；来源：archive/fixture-v3-glyph-cluster/observed-2026-01-03T00-00-00-001Z-round-15.jsonl
- 实际场数 null；noScoreSource null


## 步级分位（按 modelVersion + harnessDigest 分组）

> 分位按会话里每一步的读数汇总（最近秩，不插值）；会话中位数是各会话中位数的中位数。受污染会话按 ADR-0036 单列在下一张表、不参与本表分位——「已单列」一列把排除做成可见，而不是让它静默地少几行。步级成本全是诊断列，不是排名主指标。

| modelVersion | harnessDigest | 干净会话 | 步数 | stepMs p50/p95/max | sendMs p50/p95/max | 会话中位数 stepMs | 已单列（受污染） |
| --- | --- | ---: | ---: | --- | --- | ---: | ---: |
| stealth/glyph-cluster:free | 9c3ba5e089f7577d7ab7b5869bc5383cac3729f411d8890000e90763f720b542 | 1 | 15 | 62971 / 230021 / 230021（n=15） | 62931 / 229439 / 229439（n=15） | 62971 | 0 |

## 受污染会话（单列，成绩保留）

> 判据在报告侧（ADR-0036）：累计退避 > 60000 ms 或 429 次数 ≥ 3 即受污染。两个数都是估值不是实测；返第一季数据时改的只是报告侧阈值，不动采集。撞过限流的会话**成绩不作废**：步数、被挡次数、等了多少秒、分数都在下面的表里。
> one-shot 档这一格恒 null：`readFailureRecords` 刻意跳过参赛模型（`reporter.ts`），本报告不为封存的历史榜改那条口径——所以「没有受污染会话」不等于「所有会话都干净」。累计退避读的是日志行的 `backoffMs`（生成侧按**实测**等待写：没有退避写 0）；旧档没有这一格时写 null 而不是 0：缺数据不补零，那些会话的判据仍只由 429 次数承担。

- 本次报告里没有受污染会话（one-shot 档该列恒 null，不代表干净）。
