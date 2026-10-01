# 盲写 cell-b：B 扩张运营 × minimax-cn/MiniMax-M3(task)

Type: task
Status: resolved
Blocked by: 06

## 模型与策略

- 模型：`minimax-cn/MiniMax-M3`
- 策略取向：B 扩张运营——优先占领资源点与扩张经济，再转军事
- 输入：`draft/` 四文件（`no-risks`，不给 `wording-risks.md`）

## 任务

用 `blind/blind-run.sh` 对舱 `cell-b` 执行完整盲写管线：

1. `./blind-run.sh setup cell-b B no-risks`
2. `./blind-run.sh run cell-b minimax-cn/MiniMax-M3`
3. ≤5 轮回喂（只给静态校验错误，无对战反馈）
4. `./blind-run.sh collect cell-b`

## 三件套要求

回填 `.scratch/rules-calibration/blind/cell-b/` 必须包含：

- `work/script.v1.js`——初版原文，未改一字
- `work/FIXES.md`——每轮调错清单（API 误用/越界/快照误用，逐轮记录）
- 初版 prompt 与模型输出的会话存档（`session/` 目录或 JSONL）

轮次与自愈情况记入 `FIXES.md` 末尾。

## 验收

- 初版必须仅读 `input/` 内文件生成（SHA256SUMS.draft 钉死版本）
- ≥1 轮校验回喂可接受；5 轮仍不过记录为失败，不进 benchmarks/
- 舱内 `session/` 不出舱（collect 只取白名单文件）

## Notes

cell-b 与 cell-a（策略 A vs B，模型档位相近）构成"策略区分度"证据——对 fsr R2 规则有区分度的核心。

## Answer

cell-b 盲写完成，初版即过静态校验：**回喂 0 轮，无失败，进 `benchmarks/` 候选**。

交付三件套（`.scratch/rules-calibration/blind/cell-b/`）：

- `work/script.v1.js`——初版原文，未改一字，SHA256 `067d84408280570159c93c4c7b0847fa77f96555336bcca90e5160b3fbec5e43`（263 行；舱内原文与回填副本逐字节相同）。
- `work/FIXES.md`——模型侧 0/1 轮自检记录 + 驾驶员回填时追加的复核、与 cell-a 策略区分度对比、索引单点风险、API 类型差异。
- `session/`——初版会话 JSONL（282887 字节）+ 模型 stdout 全文（`JAIL.log`，7979 字节）+ 初版 prompt 快照（`PROMPT.txt`）。

执行摘要：

- 管线：`setup cell-b B no-risks` → `run cell-b minimax-cn/MiniMax-M3`（单次 `pi -p`，thinking=high，约 12 分钟，无追加语）→ 驾驶员独立静态复核 → `collect cell-b`。
- 盲输入合规：会话 JSONL 显示模型只读 `input/` 内七文件（README/rules/api/PROMPT.base/STRATEGY/TASK/SHA256SUMS.draft）与自建 `work/` 文件，未触舱外（舱内也无 repo）。
- 模型产出：策略取向 B（扩张运营），4 段 phase（0/1/2/3 对齐 rules.md §1），worker 目标 6–8 后转近战；自认候选 A（`MY_INDEX = 0` 直接写死，假设"容器顺序 = players 数组顺序"）；轮转方向假设"值大者胜"。
- 驾驶员复核：违禁项 0 命中、顶层 `function loop(): void` 在位（第 13 行）、TypeScript `transpileModule` 类型剥离后编译通过、被调 API 全在 `api.md` 白名单内（`findPath` 仅在注释中提及"不调以省预算"，实际无调用）、跨 tick 仅存数值 id；**无静态错误可回喂**。
- 自愈：模型交付前自跑"列目录 → 读 6 份 input 文件 → 建 work/ → 写 script.v1.js → 写 FIXES.md → 验证文件"最小闭环，自行规避"无 `players`/`productions` 查询接口""单位级 intent 覆盖""满载前不交付等坑，无需驾驶员回喂。

### 前置模型注册

cell-b 用 `minimax-cn/MiniMax-M3`（`anthropic-messages` API，`https://api.minimaxi.com/anthropic`），是 cell-a 的 `commandcode/deepseek-v4.1-flash` 之外另一档模型的盲写实证。`~/.pi/agent/models.json` 本无该 provider 条目，本次盲写前追加（详见 models.json 的 `minimax-cn` provider / `MiniMax-M3` model）。

### 与 cell-a 的策略区分度（用于 14 汇总）

- 生产顺序：cell-a worker=3 即转近战；cell-b 持续扩工至 6–8（按 phase 浮动）后才转军事 —— 与"扩张运营"取向严格一致。
- 军事比重：cell-a 全程以攻击为先；cell-b 大量 tick 没有军事产出、纯靠工人占地采金。
- 阶段意识：cell-b 显式按 rules.md §1 时间轴切 4 段（cell-a 没有），是策略 B 的天然产物。
- 生产队列追踪：cell-a 用模块级 `pendingBaseIds/pendingLeft/pendingTypes` 自记；cell-b 不自记，依赖 `spawnUnit` 返回 `ERR_NOT_ENOUGH_RESOURCES` 自然过滤 —— 两种风格在生产节流上的等价性是 08 桩模拟的检验项。
- 占领触发理解：cell-b 显式判 `d=0` 中立资源点 → `move(0,0)` 触发占领累积（cell-a 默认 `stepTo` 走过去）—— 是本次模型对 `rules.md §5` 措辞"站在点位格上即驱动占领"的独立理解，可写入 14 措辞待裁清单。

### 索引（候选 A）单点风险（比 cell-a 更脆弱）

`MY_INDEX = 0` 直接写死。若引擎按"宿主终裁、沙箱内不即时校验"则此舱首发即 MY_INDEX=0（可能错位）。比 cell-a 的 `move()` 探测还脆弱 —— cell-a 至少能探测到 host 兜底，cell-b 完全静态。**这是 cell-b 比 cell-a 更严重的同源单点，写入 14 的措辞待裁清单**。

### 协议/工具冲突（同 cell-a 共存）

- cell-b 模型走 anthropic-messages 协议、cell-a 走 OpenAI Chat Completions。对脚本侧无影响（脚本只产出文本）。14 汇总时不要把这点当成"模型差异"误归因。
- 其余（TS/JS 校验、`no-risks` 舱 SHA256 泄露、自记 FIXES 与回喂协议混栏、"session/ 不出舱" vs collect 白名单）已在 cell-a 的 FIXES.md 中汇总，本舱不再重复。
