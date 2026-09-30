# FIXES — 校验/修复记录（work/ 内）

## v1（初版，未改一字）
- 文件：`work/script.v1.js`
- 策略取向：C 农民海（`input/STRATEGY.txt`）
- 自认候选：B（自标记）。做法：开局对快照内**全部**单位按 `id % 8` 发唯一方向试探 `move`；
  下一 tick 用 `getObjectById` 回读位置，走到预期格者判定为己方，再由其 `owner` 反推 `myIndex`。
  未选候选 A（容器顺序）：只读快照里没有任何字段暴露“自己是第几个容器”，脚本侧不可读。
- 轮转方向假设：值大者胜，即 `(tick + playerIndex) mod 4` 大者先进入目标格（`rules.md` §3）。
  TODO 标注：来源仅写“取胜者”，方向待终稿确认。
- 硬约束自查：
  - 单文件、顶层 `function loop(): void`，无 `export/import/require/eval`。
  - 全整数；无 `Date/Math.random/performance/queueMicrotask/定时器/__*`；无浮点字面量。
  - 只调 API：`getObjectsByType/getObjectById/getTick/getRange/getTerrainAt/move/moveTo/harvest/transfer/spawnUnit`。
    （未用 `findPath`，避免算力预算；未用 `attack`——本策略无军事单位。）
  - 跨 tick 只存数值 id / 数值 Map，不缓存快照对象引用。
  - 每单位每 tick 只写一条最终意图。
- 静态语法校验：`node`（Node v24 内建 TS type stripping）解析通过，无语法错误。
- 待回喂（仅静态校验错误会回喂，无对战反馈）：体积上限、预算三数、地图坐标/数量均为 TODO，未知。
- 已知文档不一致（记为 wording-risks 输入，不改文档）：
  1. `api.md` §5 的“候选 B”描述为读取 `players` 的 `you/isSelf` 字段，而 `PROMPT.base.md` 写的是“自标记”；
     两者不是同一回事，本稿按 PROMPT 的“自标记”实现。
  2. 快照声明了 `players`/`productions`/`tick`，但查询函数未提供读取入口（`getObjectsByType` 只支持 `unit|site`），
     故无法读己方 `resources`，只能靠 `spawnUnit` 返回码判断资金；异常计数与自身存活状态同样不可读。

---

## 驱动侧（驾驶员）记录 — 换模型重试轮（2026-09-29）

背景：本舱首轮（`xiaomi/mimo-v2.6-pro`，thinking=high）7 次尝试全败、无产出，已归档 `../../cell-c-failed-attempts/`（含其 FIXES.md）。
人决策换模型重跑，策略 C 与 prompt 不变。本轮模型：`commandcode/deepseek/deepseek-v4.1-flash`（与 cell-a 同模型，便于跨策略对照）。

### 重试执行史（3 次尝试）

| # | 时间 | 档位 | 结果 | 设计流思考量 |
|---|---|---|---|---|
| T1 | 13:26–13:47 | thinking=high | 失败：首流 5 min 被截（38K chars）→ 重试流 123K chars 触网关单流上限，无产出 | 38093 / 123520 chars |
| T2 | 14:04–14:25 | thinking=high | 失败：单条设计流 125349 chars 达上限截断，无产出 | 125349 chars |
| T3 | 14:27–15:00 | **thinking=low** | **成功**：产出 `work/script.v1.js` + `work/FIXES.md` | 77913 / 91255 chars |

- 失败轮会话存档：`../session-failed-attempts/attempts/T1|T2/`（JSONL + JAIL.log）。
- 网关单流上限为**时间型**（≈20 min/流），非字符数型：T3 的 91K 流历时 21 min 仍存活，T1/T2 的 123K/125K 流被截。
- **披露**：T3 用 `MW_THINKING=low`（驾驶侧救援），与 cell-a（high）档位不同；且实证 low 对设计型回合的压缩有限（78K/91K vs high 的 123K/125K），成功主要来自流存活。跨舱对比时须带此口径。

### 回喂轮次：0 / 5（初版即过静态校验，无回喂）

驾驶侧独立复核（不看模型自述，直接对 `work/script.v1.js` 跑，脚本 SHA256 `29bb5efbbce4019a4f8b0b1dd9f7014f383408fc1c03b9ba5b8d9bbf2769c28a`，与舱内原文逐字节相同）：

| 检查 | 命令/方法 | 结果 |
|---|---|---|
| 违禁项（`Date`/`Math.random`/`performance`/`queueMicrotask`/定时器/`eval`/`require`/`import|export`/`__*`） | 正则逐项 | 全部无命中 |
| 浮点字面量 | 剥注释后正则 | 无命中 |
| 顶层入口 | `^function loop\(\): void` | 命中 |
| API 面（只调 api.md §3/§4 函数） | 抽取全部调用标识符，扣除文件内自定义函数（`beginMark/endMark/nearestBase/nearestSite/openAdjacent`）后比对白名单 | 越界调用 **0** 处 |
| 快照/跨 tick 误用 | 模块级声明逐项核对 | 仅数值与 `Map<number,number>`，无对象引用缓存、无对象 id 之外的句柄 |
| 类型剥离可编译 | `stripTypeScriptTypes(src,{mode:'transform'})` | OK（Node v24） |
| 盲输入合规 | 成功轮会话 JSONL | 只 `ls` + `read` `input/` 内 5 个允许文件（README/rules/api/PROMPT.base/STRATEGY），未读 TASK.txt / SHA256SUMS.draft / wording-risks.md |

### 自愈情况：1 次（模型侧自跑）

模型在交付前自跑 `node --check /tmp/chk.ts`（拷成 `.ts` 用类型剥离语法检查）确认无语法错误，并把结果记入其自写的 `work/FIXES.md`。无驾驶员回喂。

### 契约措辞风险（本舱实证，供 14 汇总、回流 06）

1. **`api.md` §5「候选 B」定义与 `PROMPT.base.md` 不一致**：api.md 说候选 B = 快照 `players` 项带 `you/isSelf` 标记（并注明"来源状态模型里没有这个字段"），PROMPT 说候选 B = "自标记"。模型按 PROMPT 的"自标记"实现（对全部单位发 `move` 试探、回读位置反推 owner），路线可行但代价大（开局整 tick 用于探测）。终稿必须二选一收口。
2. **`players`/`productions`/`tick` 声明在快照里但无读取入口**：§3 只提供 `getObjectsByType('unit'|'site')`，`resources`、`exceptionTicks`、`alive`、自身 `index` 全部读不到 → "认出自己"只能靠刷 `move` 试探，`spawnUnit` 资金只能靠返回码。此为"快照字段有、API 面缺"的契约空洞（cell-a 已提，本舱再次命中，策略 C 下暴露更彻底）。
3. **`ErrResult` 未展开**：`spawnUnit` 返回 `ErrResult`，本稿用 `typeof r !== 'string'` 判成功；cell-a 用 `isError()`。若终稿 ErrResult 是 `{err}|{ok:false}` 对象，本稿会把失败当成功（重复下单）。契约须给出判别式。
4. **`-p` 遇 `stopReason=length` 静默终止**（cell-c 首轮已提）：本舱 T1–T3 再次确认，采集器必须核产出文件存在性。
5. **网关单流上限的时间型性质**：失败形态只报 `Stream exceeded maximum duration before function timeout`，不披露上限值；不同流上限不一致（T3 21 min 存活 vs T1 20 min 被截）。舱前探针之外无稳定规避手段；建议 06/hld 侧把"单流时长上限"列为盲写管线的显式环境约束。
