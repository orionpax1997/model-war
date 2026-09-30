# 盲写 cell-a：A 爆兵压制 × deepseek/deepseek-v4.1-flash(task)

Type: task
Status: resolved
Blocked by: 06

## 模型与策略

- 模型：`commandcode/deepseek/deepseek-v4.1-flash`
- 策略取向：A 爆兵压制——优先生产战斗单位，尽早争夺与压制
- 输入：`draft/` 四文件（`no-risks`，不给 `wording-risks.md`）

## 任务

用 `blind/blind-run.sh` 对舱 `cell-a` 执行完整盲写管线：

1. `./blind-run.sh setup cell-a A no-risks`
2. `./blind-run.sh run cell-a commandcode/deepseek/deepseek-v4.1-flash`
3. ≤5 轮回喂（只给静态校验错误，无对战反馈）
4. `./blind-run.sh collect cell-a`

## 三件套要求

回填 `.scratch/rules-calibration/blind/cell-a/` 必须包含：

- `work/script.v1.js`——初版原文，未改一字
- `work/FIXES.md`——每轮调错清单（API 误用/越界/快照误用，逐轮记录）
- 初版 prompt 与模型输出的会话存档（`session/` 目录或 JSONL）

轮次与自愈情况记入 `FIXES.md` 末尾。

## 验收

- 初版必须仅读 `input/` 内文件生成（SHA256SUMS.draft 钉死版本）
- ≥1 轮校验回喂可接受；5 轮仍不过记录为失败，不进 benchmarks/
- 舱内 `session/` 不出舱（collect 只取白名单文件）

## Notes

cell-a 与 cell-d（space-bunny-alpha 同策略 A）对比用于验证"策略稳定性"——两舱 prompt 完全相同，模型不同。

## Answer

cell-a 盲写完成，初版即过静态校验：**回喂 0 轮，无失败，进 `benchmarks/` 候选**。

交付三件套（`.scratch/rules-calibration/blind/cell-a/`）：

- `work/script.v1.js`——初版原文，未改一字，SHA256 `1222a2db952e916b875baf4b9f98148f01e030a84aa5eb1ae52b259632f3ae94`（267 行；舱内原文与回填副本逐字节相同）。
- `work/FIXES.md`——模型侧 0/1 轮自检记录 + 驾驶员回填时追加的复核与措辞风险节。
- `session/`——初版会话 JSONL（32 行）+ 模型 stdout 全文（`JAIL.log`）+ 初版 prompt 快照（`PROMPT.txt`）。

执行摘要：

- 管线：`setup cell-a A no-risks` → `run cell-a commandcode/deepseek/deepseek-v4.1-flash`（单次 `pi -p`，thinking=high，约 20 分钟，无追加语）→ 驾驶员独立静态复核 → `collect cell-a`。
- 盲输入合规：会话 JSONL 显示模型只读 `input/` 内五文件（README/rules/api/PROMPT.base/STRATEGY）与自建 `work/` 文件，未触舱外（舱内也无 repo）。
- 模型产出：策略取向 A（爆兵压制），worker 目标 3 后转近战/远程；自认候选 A（players 数组顺序=座位），以 `move()` 返回值探测兜底；轮转方向假设“值大者胜”。
- 驾驶员复核：违禁项 0 命中、顶层 `loop(): void` 在位、类型剥离后编译通过、被调 API 全在 `api.md` 白名单内、跨 tick 只存数值 id；**无静态错误可回喂**。
- 自愈：模型交付前自跑 `work/mock.mjs`+`work/mock_ticks.mjs`（类型剥离加载 + 4 容器冒烟 + 40 tick 生产节流），自行规避“无 `players`/`productions` 查询接口”“单位级 intent 覆盖”等坑。

回喂 14 的措辞风险（本舱实证，完整版见 `work/FIXES.md` 末节）：

1. **脚本源 JS/TS 未定义**：骨架通篇 TS 注解，交付名却是 `.js`；`node --check script.v1.js` 直接 `SyntaxError`，须先 `stripTypeScriptTypes`。终稿须明确校验器是否接受 TS。
2. **`no-risks` 舱泄露 `wording-risks.md` 存在**：`setup` 对 `draft/*` 整目录取哈希，`input/SHA256SUMS.draft` 含其一行；文件本身未投放。
3. **自记 FIXES 与回喂协议混栏**：`TASK.txt` 让模型自写 FIXES，模型自拟“轮 1”，与“驾驶员回喂轮次”混写，“≤5 轮”口径不可核。
4. **验收内部矛盾**：“三件套要求”要 session 存档，“验收”却写“舱内 `session/` 不出舱”，而 `collect` 无条件 `cp -r session`。本次按交付要求保留 `session/`；14 须统一口径。
5. **index 自认单点风险**：候选 A 靠 `move()` 返回值探测；若引擎改为“宿主终裁、沙箱内不即时校验”则探测恒真、退回 `MY_INDEX=0` 错位。
