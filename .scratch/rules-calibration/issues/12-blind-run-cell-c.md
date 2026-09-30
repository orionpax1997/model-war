# 盲写 cell-c：C 农民海（首轮 xiaomi/mimo-v2.6-pro 失败 → 重试 deepseek-v4.1-flash）(task)

Type: task
Status: resolved
Blocked by: 06

## 模型与策略

- 模型：`xiaomi/mimo-v2.6-pro`
- 策略取向：C 农民海——以农民为主力占领/堵点，检验 gdd #4 张力
- 输入：`draft/` 四文件（`no-risks`，不给 `wording-risks.md`）

## 任务

用 `blind/blind-run.sh` 对舱 `cell-c` 执行完整盲写管线：

1. `./blind-run.sh setup cell-c C no-risks`
2. `./blind-run.sh run cell-c xiaomi/mimo-v2.6-pro`
3. ≤5 轮回喂（只给静态校验错误，无对战反馈）
4. `./blind-run.sh collect cell-c`

## 三件套要求

回填 `.scratch/rules-calibration/blind/cell-c/` 必须包含：

- `work/script.v1.js`——初版原文，未改一字
- `work/FIXES.md`——每轮调错清单（API 误用/越界/快照误用，逐轮记录）
- 初版 prompt 与模型输出的会话存档（`session/` 目录或 JSONL）

轮次与自愈情况记入 `FIXES.md` 末尾。

## 验收

- 初版必须仅读 `input/` 内文件生成（SHA256SUMS.draft 钉死版本）
- ≥1 轮校验回喂可接受；5 轮仍不过记录为失败，不进 benchmarks/
- 舱内 `session/` 不出舱（collect 只取白名单文件）

## Notes

农民海策略专门检验 gdd #4（农民海是否无脑最优）——脚本是实证载体，非直接验证（实证在 08 桩模拟票）。

## Answer

cell-c 盲写**失败**：`xiaomi/mimo-v2.6-pro` 7 次执行会话均未产出 `work/script.v1.js`，**校验回喂 0/5 轮（无脚本可校验），不进 `benchmarks/`**。失败属模型档位 × 网关可用性问题，非契约措辞误读。人决策：换模型重跑本案例（留待裁：另开票或重开本票，及替补模型选择——策略 C 农民海与 prompt 不变）。

交付物（`.scratch/rules-calibration/blind/`；首轮 mimo 失败记录已整体归档至 `cell-c-failed-attempts/`，腾出 `cell-c/` 给换模型重试轮）：

- `cell-c-failed-attempts/FIXES.md`——三件套记录：模型侧 0 轮、驾驶侧 7 次尝试执行史（T1–T7）、根因 5 条、新增管线措辞风险 3 条（含 pi `-p` 遇 `length` 静默终止、模型档位须前置探针）。
- `cell-c-failed-attempts/PROMPT.txt`——初版 prompt 快照（含 T7 追加语披露）。
- `cell-c-failed-attempts/session-*/`——全部 7 次失败会话 JSONL（按尝试分目录），盲输入合规证据在此（模型只读 `input/` 5 个允许文件）。
- `cell-c-failed-attempts/{MANIFEST.txt,JAIL.log}`。

根因（详见 FIXES.md）：

1. mimo 对「读规范→写完整脚本」设计回合呈系统性思考膨胀（单流 84K–120K chars，思考档位 high/low/off 无差别，中途无 tool call 不可拆段）；
2. commandcode 网关单流 ~15 分钟硬上限（死线 ≈ 22K tokens/流），超时断流 `Stream exceeded maximum duration before function timeout`，当日另有偶发瞬断；
3. `max_tokens` 截断能救流（T6 实证 `stop:length` 存活），但 pi `-p` 遇 `length` 以空文本静默终止；
4. 工具侧发现并修复：commandcode compat 原未开 `supportsReasoningEffort`，思考档位全程不透传（low/high/off 对服务端无差别）；修复后探针思考量 35703→12319 chars，但压不住设计型回合；服务端 effort 词表实证为 `low|medium|high|xhigh|max`（无 minimal/off）。

执行环境注记：`blind-run.sh` 新增 `MW_THINKING`/`MW_RETRIES` 两个 env 旋钮（默认 high/3，不影响其它舱）；`~/.pi/agent/models.json` mimo 条目加 `compat.supportsReasoningEffort` + 全档 `thinkingLevelMap`（修复性，保留），`maxTokens` 已恢复 32000。T7 用了纯工作方式追加语（零域信息，不触污染条款）——未成稿，仅作披露。

三件套验收对照：初版原文/FIXES/会话存档三件套已回填，但 `script.v1.js` 项因无产出为空——按验收第 2 条记录为失败。session/ 出舱仍按 cell-a 先例（14 未收口的口径矛盾，本舱沿用交付要求）。

---

## 重试轮（2026-09-29，人决策：换模型重跑本案例）

模型换 `commandcode/deepseek/deepseek-v4.1-flash`（与 cell-a 同模型，便于跨策略 C vs A 对照）；策略 C、prompt、`no-risks` 输入均不变。

**结局：成功。**

- T1/T2（thinking=high）：同 mimo 失效形态——设计流思考 123K/125K chars，触网关单流时间上限（≈20 min）截断，无产出。
- T3（`MW_THINKING=low`）：产出 `work/script.v1.js`（254 行，SHA256 `29bb5efb…769c28a`）+ `work/FIXES.md`。
- **回喂轮次 0 / 5**：初版即过驾驶侧独立静态校验（禁项 0、越界 API 调用 0、浮点 0、类型剥离可编译、跨 tick 仅存数值/`Map<number,number>`）。
- 自认候选 **B（自标记）**；轮转方向假设 **值大者胜**。
- 盲输入合规：成功轮会话只读 `input/` 内 5 个允许文件，未触舱外、未读 TASK.txt/SHA256SUMS.draft/wording-risks.md。

交付物（`blind/cell-c/`）：`work/script.v1.js`、`work/FIXES.md`（模型侧自查 + 驾驶侧复核/重试史/措辞风险 5 条）、`session/`（成功轮 JSONL + `PROMPT.txt`）、`session-failed-attempts/attempts/T1|T2/`（失败轮 JSONL+JAIL.log）、`input/{STRATEGY.txt,SHA256SUMS.draft}`、`MANIFEST.txt`、`JAIL.log`。

新增措辞风险 5 条（详见 `cell-c/work/FIXES.md` 末节），首条为 `api.md` §5「候选 B = `players` 的 `you/isSelf`」与 `PROMPT.base.md`「候选 B = 自标记」**定义冲突**——实为两个不同方案，须在 06 收口。

**口径披露（供 14/07 汇总带入）**：T3 用 `thinking=low`，与 cell-a（high）档位不同；且实证 low 对设计型回合压缩有限（78K/91K vs high 123K/125K），成功主要来自流存活而非档位。本舱仍为「同模型、同策略 C、异档位」样本。

**结论**：cell-c 由失败改记通过，可进 07/14 的模型可用性表与策略稳定性对照（cell-a A 爆兵 vs cell-c C 农民海，同模型异策略）。
