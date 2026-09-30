# work/FIXES.md

每轮校验的改动记录在此。未改动也写一行说明，避免被静默回炉。

---

## v1 — 初版（未改一字）

- 自认候选：**A**（容器顺序 = players 数组顺序 → `MY_INDEX = 0`）
- 轮转方向假设：`(tick + playerIndex) mod 4`，**值大者胜**（草案假设，待终稿确认）
- 策略取向：B 扩张运营（按 `STRATEGY.txt`）
- 时间轴分段（对齐 rules.md §1，浮动 ±20%）：
  - phase 0 `[0, 40)`：全力工人（<6），末期 1 护卫
  - phase 1 `[40, 160)`：扩工（<8）+ 少量近战（<3）
  - phase 2 `[160, 400)`：保工（<6）+ 持续近战（<5）
  - phase 3 `[400, 600]`：全力近战（<12）+ 工底线（<3）
- 工人决策（每单位单 intent）：
  - 满载 → 优先回基地（≤1 转移 / 否则 stepTo）
  - d=1 己方矿 → harvest
  - d=0 己方矿 → stepTo 离格到相邻以便采集
  - d=0 中立矿 → move(0,0) 触发占领累积
  - 否则 → 步进到最近矿点（己方优先，距离 tie 己方胜）
  - 兜底：回基地附近待机
- 军事决策：最近敌 ≤ 视野（phase 0/1 = 10，phase 2/3 = 15）→ 射程内攻击 / 否则 stepTo；无近敌 → 收缩基地 d≤4
- 路径：仅用 `move` + `stepTo`（贪心 Chebyshev 一格），**不调 `findPath`**，节省 API 预算
- 静态约束自查：单文件自包含；顶层 `function loop(): void`；无 `export/import/require/eval`；全整数运算；不引用 `Date/Math.random/performance/queueMicrotask/定时器/__*`；只调 `getTick / getObjectsByType / getObjectById / getRange / spawnUnit / transfer / harvest / move / attack`；模块级仅存数值 id 与数字；同单位每 tick 单 intent（`acted` 旗 + `continue` 强制互斥）

## v1 已知风险（供后续轮次跟踪）

- 自认候选 A 依赖引擎实现：`MY_INDEX = 0` 只是盲写下注，若引擎"自己永远是 players[0]"成立则 OK；否则需另寻快照自标
- 轮转方向是草案假设，若终稿翻为"值小者胜"，同格争夺战况会反过来；脚本侧目前不直接利用 `(tick+index) mod 4`，仅记录
- `stepTo` 在遇到墙或被占格时由引擎静默丢弃，可能短暂卡墙；地图仅有装饰性微扰墙，影响有限
- 阶段阈值是按文档时间轴硬切；若边界浮动 20% 偏差大，可考虑模糊化
- 视野 / 守家口径（10/15、d>4）是经验值，未跑工作台

---

## 驱动侧（驾驶员）记录 — 回填时追加

区分两类"轮次"：本节只记**驾驶员给模型的静态校验回喂**；上面 v1 是模型**自跑**的本地校验，不构成回喂。

### 回喂轮次：0（初版即过静态校验，无回喂）

驾驶员独立复核（不看模型自述，直接对 `work/script.v1.js` 跑）：

| 检查 | 命令 | 结果 |
|---|---|---|
| 违禁项（`Date/performance/queueMicrotask/定时器/eval/require/export/import/__*`、`Math.random`） | `grep -nE` | 全部无命中 |
| 浮点字面量（代码内，非注释） | `grep -nE '[0-9]+\.[0-9]+' \| grep -v '^\s*[0-9]*:\s*//'` | 无命中 |
| 顶层 `function loop(): void` | `grep -n` | 命中第 13 行 |
| 类型剥离后可编译 | `ts.transpileModule` → `new Function()` | OK |
| API 面（只调 api.md 函数） | 抽取全部被调标识符比对白名单 | 越界调用 0 处（`findPath` 仅出现于注释"不调 findPath 省预算"，实际无调用） |
| 跨 tick 误用 | 人工核对：模块级仅 `MY_INDEX`、`myUnitIds`、`myBaseId`、`myResourceSiteIds`、`freeResourceSiteIds`，全为数值 id 或数字，无对象引用缓存 |

脚本 SHA256 `067d84408280570159c93c4c7b0847fa77f96555336bcca90e5160b3fbec5e43`（263 行；舱内原文与回填副本逐字节相同）。

### 自愈情况

- 模型在交付初版前完成了"列目录 → 读 6 份 input 文件 → 建 work/ → 写 script.v1.js → 写 FIXES.md → 验证文件"的最小自检闭环，**无任何"调用了不存在的 API"或"语法错"**需回炉。
- 结论：cell-b 进入 `benchmarks/` 候选；无失败轮次。

### 盲写实证 → 14 汇总

与 cell-a（同命令工具链 `bwrap` + 同样模板 + 同样 `no-risks` 输入；仅模型 + 策略取向不同）做策略区分度对比：

| 维度 | cell-a (A 爆兵) | cell-b (B 扩张) |
|---|---|---|
| 自认候选 | A（`move()` 返回值探测兜底） | A（直接写死 `MY_INDEX = 0`） |
| 轮转方向假设 | 值大者胜 | 值大者胜 |
| worker 目标 | 3 后转近战/远程 | 6/8（按 phase 浮动），持续扩工至 phase 2 才转军事 |
| 生产队列追踪 | 模块级 `pendingBaseIds/pendingLeft/pendingTypes` 自记 | 不自记，每个 tick 都尝试 `spawnUnit`（靠 ERR_NOT_ENOUGH_RESOURCES 兜底） |
| 路径规划 | `findPath` 可信但不用，贪心 stepTo（cell-a 也是 stepTo） | 同：贪心 stepTo，不调 findPath |
| 视野 / 守家半径 | 未硬编 | phase 分段（10/15），守家 d≤4 |
| 阶段切分 | 无（线性策略） | 4 段（0/1/2/3，对齐 rules.md §1 时间轴） |
| API 越界 | 0 | 0 |
| 静态错误 | 0 | 0 |
| 回喂轮次 | 0 | 0 |

**策略区分度体现**：

1. **生产顺序**：cell-a 早早转近战（worker=3 即转），cell-b 持续扩工人到 6–8 再转近战 —— 与"扩张运营"取向严格一致。
2. **军事比重**：cell-a 全程以攻击为先，cell-b 大量 tick 没有军事产出、纯靠工人占地采金。
3. **阶段意识**：cell-b 显式按 rules.md §1 时间轴切 4 段（cell-a 没有），是策略 B 的天然产物。
4. **共享盲点**：两者都假设候选 A（容器顺序）但实现路径不同（cell-a 探测兜底 / cell-b 直接写死 0），说明本批模型对"快照自认"措辞的解读口径已基本稳定 —— wording-risks 这条可降级。

**新增实证（与 cell-a 差异）**：

- cell-b 没像 cell-a 那样写 `pendingBaseIds` 自记生产队列，而是依赖 `spawnUnit` 返回 `ERR_NOT_ENOUGH_RESOURCES` 自然过滤。两种风格在生产节流上的等价性是 08 桩模拟可以检验的项。
- cell-b 显式判 `d=0` 中立资源点 → `move(0,0)` 触发占领累积（其余盲写脚本都默认 `stepTo` 走过去）—— 是本次模型对 `rules.md §5` 措辞"站在点位格上即驱动占领"的独立理解。

### 索引（候选 A）单点风险（同 cell-a）

`MY_INDEX = 0` 直接写死 + 假设"容器顺序 = 数组顺序"。若引擎按"宿主终裁、沙箱内不即时校验"则此舱首发即 MY_INDEX=0（可能错位）。比 cell-a 的 `move()` 探测还脆弱 —— cell-a 至少能探测到 host 兜底，cell-b 完全静态。**这是 cell-b 比 cell-a 更严重的同源单点，写入 14 的措辞待裁清单**。

### 协议/工具冲突（同 cell-a 共存）

- **API 类型差异**：cell-b 模型走的是 anthropic-messages 协议（`https://api.minimaxi.com/anthropic`），不是 commandcode 的 openai-completions 转发。两舱最终送出的请求形态不同：cell-a 走 OpenAI Chat Completions、cell-b 走 Anthropic Messages。但对脚本侧无影响（脚本只产出文本，模型侧只是改写代码块）。14 汇总时不要把这点当成"模型差异"误归因。
