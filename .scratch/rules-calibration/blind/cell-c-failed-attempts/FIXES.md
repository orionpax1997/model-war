# FIXES.md — 校验与修订记录（cell-c 首轮，C 农民海 × xiaomi/mimo-v2.6-pro）

> 归档位置：本文件原为 `cell-c/work/FIXES.md`；因人决策换模型重跑本案例（`commandcode/deepseek/deepseek-v4.1-flash`），
> 于 2026-09-29 移入本目录作为 mimo 失败轮的存档。新 cell-c 舱的产物见 `../cell-c/`。

**结局：失败——模型全程未产出 `work/script.v1.js`，无初版可钉，不进 `benchmarks/`。**

交付纪律口径：`work/script.v1.js` 本应为初版原文、未改一字——本次该文件**不存在**（模型 7 次执行会话均未走到输出阶段）。本文件为驾驶侧记录。

---

## 模型侧轮次：0（无产出）

- 静态校验回喂轮次：**0**（没有脚本可校验，无回喂发生）。
- 自愈情况：**无**。模型每次会话均在"读完 6 份 input 文件后的设计回合"因输出流失效而中止，未写出任何文件（`work/` 全程为空）。
- API 误用 / 越界 / 快照误用：**不适用**（无脚本，无从检查）。
- 盲输入合规（会话 JSONL 核对）：所有会话模型只执行 `ls` 与 `read`，读取对象仅为 `input/` 内允许文件（README/rules/api/PROMPT.base/STRATEGY），未触舱外、未读 TASK.txt / SHA256SUMS.draft——**输入面干净**，失败与污染无关。

## 驾驶侧执行史（7 次执行尝试，2026-09-29 15:41–20:20）

| # | 时间 | 环境变更 | 失败形态 | 首个设计流思考量 |
|---|---|---|---|---|
| T1 | 15:41 | 基线（thinking=high，maxTokens 32000） | ×2 `Stream exceeded maximum duration before function timeout` | 100239 / 107922 chars |
| T2 | 16:58 | `MW_THINKING=low`（当时不透传，与 high 无差别） | 同 T1 | 88288 chars |
| T3 | 17:28 | effort 透传修复 + maxTokens 64000 | `Stream ended without finish_reason` / `Stream error occurred` / 1 流未落盘即断 | 34663 / 48015 chars |
| T4 | 18:14 | `MW_THINKING=off` | 同 T1（off 不下发任何参数，服务端思考照跑） | 120017 chars |
| T5 | 18:36 | low + `MW_RETRIES=10` | ×2 同 T1 | 93766 / 101102 chars |
| T6 | 19:06 | maxTokens 20000 | 流存活并被 `max_tokens` 截断（`stop:length`），但 pi `-p` 遇 length 以空文本终止，无产出 | 81226 chars（截断于 20000 tokens） |
| T7 | 19:37 | maxTokens 28000 + 分步工作追加语 | ×2 同 T1 + ×1 流瞬断；人叫停收摊 | 89105 / 84489 chars |

全部执行会话存档：本目录下 `session-*/`（7 份 JSONL，按尝试分目录）。

## 根因（实证，供 07/14 汇总）

1. **mimo-v2.6-pro 对"读规范→写完整脚本"的设计回合呈系统性长思考膨胀**：无论思考档位（high/low/off），单条设计流思考稳定在 84K–120K chars（≈ 21K–30K tokens），且中途不发任何 tool call，无法被拆段。
2. **commandcode 网关单流存在 ~15 分钟硬上限**（实测死线 ≈ 90K chars ≈ 22K tokens/流）：超时即断流报 `Stream exceeded maximum duration before function timeout`；此外该网关当日偶发瞬断（`Stream ended without finish_reason` / `Stream error occurred`，20K chars 的短流也被击中过一次）。
3. 二者叠加 = 死锁：思考量低不下来，流长压不下去。`max_tokens` 截断（T6）能救流，但 pi `-p` 遇 `length` 直接终止会话，产出为空。
4. **思考档位透传缺陷（工具侧发现，已修复）**：`commandcode` 原 compat 未开 `supportsReasoningEffort`，pi 对 openai-completions 不下发任何思考参数——`--thinking low/high/off` 对服务端**全部无差别**。修复后 `reasoning_effort` 透传生效（红黑树探针单流最大思考 35703→12319 chars），但对设计型回合仍压不住膨胀（T5/T7 照样 84K+）。
5. **服务端 reasoning_effort 词表**（探针 400 报错暴露）：`"low"|"medium"|"high"|"xhigh"|"max"`——无 `minimal`/`off`/`none`，最低就是 `low`。`thinkingBudgets` 设置对 openai-completions 不下发（仅 Google/Bedrock/Anthropic 系生效）。

## 轮次与自愈情况（末尾汇总）

- 校验回喂轮次：0 / 5（未使用）。
- 模型自愈：0 次（无产出即无从自愈）。
- 驾驶侧环境救援：7 次尝试 × 3 类手段（思考档位、max_tokens、重试与追加语），全部无效。
- **结论：cell-c 记录为失败，不进 `benchmarks/`。** 失败属"模型档位 × 网关"可用性问题，不是契约措辞误读——这本身就是 07「基准策略脚本」要的模型档位可用性证据：xiaomi/mimo-v2.6-pro 经 commandcode 网关无法稳定完成单回合长输出的盲写任务。

## 契约/管线措辞风险（增量，cell-a/b 之外的新增项）

1. **pi `-p` 遇 `stopReason=length` 静默终止**：截断的 thinking-only 输出被当作最终答复（stdout 空、退出码 0），调用方无从区分"模型答完"与"输出被截断"。若终稿校验器/采集器复用 `pi -p` 管线，必须显式核对产出文件存在性。
2. **模型档位可用性须前置探针**：先跑小额探针（同量级负载）确认"单流思考量 < 网关流上限"再入舱，避免舱内反复重建。本次 T1–T7 的排查过程即反例。
3. T7 使用了一条**追加语**（纯工作方式指令："分步工作、每步落盘"，零域信息，不触 PROMPT.base 的污染条款）——此为本舱与 cell-a/b 的 prompt 差异，即便 T7 成功也须在 14 披露；最终未成稿，仅作记录。
