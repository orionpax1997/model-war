# 盲写 cell-d：A 爆兵压制 × stealth/space-bunny-alpha（策略交叉验证）(task)

Type: task
Status: resolved
Blocked by: 06

## 模型与策略

- 模型：`stealth/space-bunny-alpha`
- 策略取向：A 爆兵压制——优先生产战斗单位，尽早争夺与压制（与 cell-a 同策略、同 prompt，仅模型不同）
- 输入：`draft/` 四文件（`no-risks`，不给 `wording-risks.md`）

## 任务

用 `blind/blind-run.sh` 对舱 `cell-d` 执行完整盲写管线：

1. `./blind-run.sh setup cell-d A no-risks`
2. `./blind-run.sh run cell-d stealth/space-bunny-alpha`
3. ≤5 轮回喂（只给静态校验错误，无对战反馈）
4. `./blind-run.sh collect cell-d`

## 三件套要求

回填 `.scratch/rules-calibration/blind/cell-d/` 必须包含：

- `work/script.v1.js`——初版原文，未改一字
- `work/FIXES.md`——每轮调错清单（API 误用/越界/快照误用，逐轮记录）
- 初版 prompt 与模型输出的会话存档（`session/` 目录或 JSONL）

轮次与自愈情况记入 `FIXES.md` 末尾。

## 验收

- 初版必须仅读 `input/` 内文件生成（SHA256SUMS.draft 钉死版本）
- ≥1 轮校验回喂可接受；5 轮仍不过记录为失败，不进 benchmarks/
- 舱内 `session/` 不出舱（collect 只取白名单文件）

## Notes

cell-d 与 cell-a（space-bunny-alpha vs deepseek-v4.1-flash，同策略 A）构成"策略稳定性跨模型"证据——验证"爆兵压制"这一策略取向是否在模型间稳定表达，而非偶然收敛。

## Answer

cell-d 盲写完成：**回喂 1 轮即过静态校验（1/5），无失败，进 `benchmarks/` 候选**。
策略稳定性跨模型证据成立——爆兵压制的骨架在两个模型间同构复现，差异只在工程严谨度。

交付三件套（`.scratch/rules-calibration/blind/cell-d/`）：

- `work/script.v1.js`——初版原文，**未改一字**，SHA256 `3a9895e0c22b1332ffb35751d7dc2f2bc8e553d21bc4dfd58a58ed240574a2c2`（411 行；两轮之间未被改动，舱内原文与回填副本逐字节相同）。
- `work/FIXES.md`——模型侧 v1 自检 + 第 1 轮回喂记录 + 驾驶员复核与措辞风险节 + 策略稳定性对照表。
- `work/script.v2.js`——回喂 1 后的终态脚本，SHA256 `db450c2e671a5703d4d8a5476bf10c6849653f9c18f0946a3f67ff41be70aed6`。
- `session/`——初版与回喂 1 两轮会话 JSONL + `PROMPT.round0.txt` / `PROMPT.round1.txt` 初版 prompt 存档。
- 附带（`collect` 白名单外，手工补）：`work/sim*.mjs` 模型自建 mock 引擎 4 个、`JAIL.log.round0` / `JAIL.log.round1` 每轮 stdout。

执行摘要：

- 管线：`setup cell-d A no-risks` → `run cell-d commandcode/stealth/space-bunny-alpha`（thinking=high，与 cell-a 同档位）→ 驾驶员独立静态复核 → 回喂 1 轮 → 复核通过 → `collect cell-d`。
- 盲输入合规：`input/` 与 cell-a 逐文件字节相同（`diff -r` 一致，`SHA256SUMS.draft` 四行哈希相同）；两轮会话 JSONL 显示模型只读 `input/` 内五个允许文件（README/rules/api/PROMPT.base/STRATEGY），未读 `TASK.txt` / `SHA256SUMS.draft` / `wording-risks.md`，未触舱外。
- 模型产出：策略取向 A，`pickType()` 爆兵为主（`MIN_WORKERS=2` 兜底农民、ranged/cavalry 按 `RATIO` 稀疏混入、防守半径 3 优先）；自认候选 A；轮转方向假设"值大者胜"，且**全脚本不依赖该方向分支**（只依赖 `move` 裁决结果，自证方向无关）。
- 驾驶员复核 v1：违禁项 0 命中、无浮点、API 全在白名单、跨 tick 只存数值与 `Map<number,number>`、每单位一 tick 一意图、类型剥离可编译——**2 项不通过**：① 入口落成 `function loop() {}`，与硬约束字面 `function loop(): void` 不符；② `var MY_INDEX = 0` 写死，违反 api.md §5「实写时从快照认出自己，禁止写死」。
- 回喂 1：只给上述 2 项静态错误 + 已通过项清单 + 改稿纪律（v1 冻结、v2 另写、FIXES 追加），**未给对战反馈、未给跨舱信息**。v2 全部通过，止于 1 轮。
- 自愈：模型侧 2 次（均为自建 mock 引擎跑满 600 tick、`exceptions = 0`；其中 v2 的"四座位全靠探测、tick 3 锁定"是回喂的直接产物）。

回喂 14 的措辞风险（本舱实证，完整版见 `work/FIXES.md` 驱动侧节）：

1. **`: void` 记法 4 舱 3:1 分裂**：cell-a/b/c 初版都照抄 `function loop(): void`（TS 记法），**只有 cell-d v1 落成 `function loop() {}`** 并自列为"待回喂风险 1"，回喂后才改回。同一句硬约束，4 个模型 3:1 服从字面——坐实"脚本源是 JS 还是 TS"契约未定义。
2. **`MY_INDEX` 写死是 4 舱孤例，但根因是契约空洞**：cell-a（`move()` 返回值探测）、cell-c（刷 `move` 试探回读 owner）都被迫自己发明探测。cell-d 独立复核后写出 9 条"契约无法闭环"清单，关键三条：`Snapshot` 无 `selfIndex`/`you`/`isSelf` 任何自标记字段（**候选 B 在当前 schema 下不存在**）；`loop()` 无参数、无 `getMyIndex()` 查询（**候选 A 字面形式在入口与快照两处都无可读字段**）；读未暴露字段按 §2/§8 判"越权"→ 整 tick 置空 + `exceptionTicks++`，把"试探式读 `players[0].you`"这条路被契约自己的越权规则堵死。**⇒ 候选 A/B 二选一这个提示在当前 schema 下没有可行解。**
3. **`ERR_*`/`ErrResult` 未展开（跨舱第 3 次命中）**：cell-a `isError()`、cell-c `typeof r !== 'string'`、cell-d `!r` 真值——三种写法、同一未定义类型；cell-d 还额外依赖 `ERR_NOT_OWNER` 做自愈，终稿改名则该分支静默失效。
4. **cell-a 4 条风险的复现**：no-risks 舱 `SHA256SUMS.draft` 仍含 `wording-risks.md` 哈希行；模型自记 FIXES 与驾驶员回喂轮次混栏；验收"session 不出舱"与三件套"要 session 存档"矛盾（`collect` 无条件 `cp -r session`）。另本舱新增一条：两轮都执行过 `ls -la /workspace/input/`，目录列表可见 `TASK.txt` / `SHA256SUMS.draft` **存在**（内容未读）。

策略稳定性结论（cell-a vs cell-d，同 prompt 同策略 A，详见 `work/FIXES.md` 驱动侧对照表）：

| 维度 | cell-a | cell-d | 判定 |
|---|---|---|---|
| 策略骨架 | worker 达标后转近战/远程 | `pickType()` 爆兵为主 + 农民兜底 + 稀疏混编 | 稳定复现 |
| 移动 | 单步 `move` + 地形绕行，不用 `findPath` | 同（先对角后单轴 + `getTerrainAt` 绕墙） | 结构相似 |
| index 自认 | 选候选 A，`move()` 返回值探测 | 选候选 A，v1 写死 → 回喂后改 `getObjectById` 回读探测 + 连续两次确认 | 取向一致，严谨度本舱更高 |
| 轮转方向 | 假设"值大者胜" | 同假设 + **自证方向无关** | 一致，本舱更完整 |
| 入口记法 | `function loop(): void` | `function loop() {}` → 回喂才改 | 分歧 |
| 静态错误类型 | 0 项 | 2 项（记法服从、index 写死） | 类型不同，**无某模型特有盲区** |

→ **"爆兵压制"在模型间稳定表达，非偶然收敛**：骨架、生产决策、移动方式、"候选 A + 值大者胜"两条记录全部同构；
差异集中在工程严谨度（cell-d 多做了方向无关性论证与确认计数自愈）；
静态错误类型确实不同（cell-a 零错误偏实现完备，cell-d 两项偏记法服从），
但**两者指向同一组措辞问题**（TS/JS 记法、index 无出口、`ErrResult` 未展开）。
