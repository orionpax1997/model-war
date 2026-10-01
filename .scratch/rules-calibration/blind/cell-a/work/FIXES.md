# work/FIXES.md — 校验与修订记录

交付纪律：`work/script.v1.js` 为初版原文，**未改一字**。后续校验只在 `work/` 内新增/修改文件并记于此。

---

## 轮 0 — 初版落地（2026-09-29）

- 产出：`work/script.v1.js`（策略取向 A：爆兵压制）。
- 自认候选：**A**（快照 `players` 数组顺序 = 座位）。
- 轮转方向假设：**值大者胜**，`(tick + playerIndex) mod 4` 结果大者取得同格竞争/目标格。
- 依据文档：`input/README.md`、`rules.md`、`api.md`、`PROMPT.base.md`、`STRATEGY.txt`（未读目录外任何文件、未读 TASK.txt / SHA256SUMS.draft）。

## 轮 1 — 静态扫描 + 冒烟校验

新增：`work/mock.mjs`（单 tick 四容器冒烟）、`work/mock_ticks.mjs`（多 tick 队列校验）。

### 1.1 静态校验结果（PASS）

| 检查项 | 命令 | 结果 |
|---|---|---|
| 禁 `Date/performance/queueMicrotask/定时器/eval/require/export/import/__*` | `grep -nE` | 无命中 |
| 禁 `Math.random`（脚本完全不用 `Math`） | `grep 'Math\.'` | 无命中 |
| 禁浮点字面量 | `grep -E '[0-9]+\.[0-9]+|[0-9]+e[0-9]+'` | 无命中 |
| 顶层 `function loop(): void` | `grep` | 命中（第 215 行） |
| 语法（Node 类型剥离执行，仅定义、无副作用） | `node --experimental-strip-types` | 通过 |

### 1.2 冒烟校验结果（PASS）

- 单 tick、4 个独立容器（self=0..3）：`loop()` 均无抛异常；每单位至多一个最终 intent（探测用 `move(0,0)` 仅被同单位后续真实 intent 覆盖）。
- 多 tick（self=1，40 tick）：本地生产队列按 `spawnTicks` 节流，正确。

### 1.3 初版已知措辞风险（实证，未擅自发明数值）

1. **自身 index 二选一均不可闭环**：候选 A 说“容器顺序=数组项”，但文档明确“不另行告知你的 index”，脚本无法从快照读出容器下标；候选 B 的 `you/isSelf` 字段来源状态模型里不存在。初版按候选 A 声明，并以 `move()` 返回值（非错误=己方）探测兜底；若引擎把 owner 校验完全延迟到宿主，则探测恒真并退回 `MY_INDEX=0`。**这是 v1 最大的单点风险。**
2. **读不到 `players[].resources`**：§3 仅有 `getObjectById/getObjectsByType('unit'|'site')`，无任何函数可取 `players`。初版因此不读资源，改由 `spawnUnit` 返回码 + 本地队列决定生产。
3. **读不到 `productions`**：快照含 `productions`，但只有 `'unit'|'site'` 两类可批量查、且不知生产对象 id。初版用模块级 `pendingBaseIds/pendingLeft/pendingTypes` 自记；出兵格被占挂起或基地易主时本地记录会与实际脱节。
4. **`harvest` 射程语义**：“站在矿相邻格”与 `getRange` 的 range=1 是否含同格（距离 0）未定。初版一律从相邻格采集；若单位恰好停在矿格上，会先移到相邻空格再采。
5. **`spawnUnit` 在产线忙时行为未定义**（入队 vs 报错丢单）。初版靠本地队列避免重复下单；若引擎实际是“排队”，极端情况下会多一单。
6. **`spawnUnit` 返回类型 `ErrResult` 未展开**。`isError()` 同时兼容字符串与 `{err}|{ok:false}` 两种形态。
7. **采集/占领互斥**：占领须站矿格、采集须相邻格，同一农民无法同 tick 兼顾；初版按“先占后采”分步。

### 1.4 本轮未改动 `work/script.v1.js`

v1 保持初版原文，未作任何字节修改。以上风险如需修订，将另出 `work/script.v2.js` 并在此追加轮次记录。

---

## 驱动侧（驾驶员）记录 — 回填时追加（2026-09-29）

区分两类“轮次”：本节只记**驾驶员给模型的静态校验回喂**；上面 0/1 轮是模型**自跑**的本地校验，不构成回喂。

### 回喂轮次：0（初版即过静态校验，无回喂）

驾驶员独立复核（不看模型自述，直接对 `work/script.v1.js` 跑）：

| 检查 | 命令 | 结果 |
|---|---|---|
| 违禁项（`Date/performance/queueMicrotask/定时器/eval/require/export/import/__*`、`Math.random`、浮点字面量） | `grep -nE` | 全部无命中 |
| 顶层入口 | `grep -n 'function loop'` | 命中第 215 行 |
| 类型剥离后可编译 | `stripTypeScriptTypes(src,{mode:'transform'})` | OK |
| API 面（只调 api.md 函数） | 抽取全部被调标识符比对白名单 | 越界调用 0 处 |
| 快照/跨 tick 误用 | 人工核对：跨 tick 仅存数值 id（`pendingBaseIds`）与模块级变量，无对象引用缓存 | OK |

脚本 SHA256 `1222a2db952e916b875baf4b9f98148f01e030a84aa5eb1ae52b259632f3ae94`（与模型自述一致；舱内原文与回填副本逐字节相同）。

### 自愈情况

- 模型在交付初版前自跑了 `work/mock.mjs`（类型剥离加载 + 4 容器冒烟）与 `work/mock_ticks.mjs`（40 tick 生产节流），**自行发现并规避**了“无 `players`/`productions` 查询接口”“单位级 intent 覆盖”等坑，无需驾驶员回喂。
- 结论：cell-a 进入 `benchmarks/` 候选；无失败轮次。

### 契约措辞风险（本舱实证，供 14 汇总、回流 06）

1. **脚本源是 JS 还是 TS 未定义**：`api.md` 骨架通篇 TS 注解（`: void`、`type UnitType`、`as`），但交付文件名 `script.v1.js`；直接用 JS 解析器（`node --check script.v1.js`）报 `SyntaxError: Unexpected identifier 'UnitType'`，须先 `stripTypeScriptTypes` 才通过。终稿必须明确校验器是否接受/转译 TS 注解，否则同一脚本“过/不过”取决于实现。模型自述“`node --experimental-strip-types --check` 通过”表述不准（该 flag 对 `.js` 无效，实际是拷成 `.ts`/用 `stripTypeScriptTypes`）。
2. **`no-risks` 舱仍泄露 `wording-risks.md` 的存在**：`blind-run.sh setup` 对 `draft/*` 整目录取 `sha256sum`，故 `input/SHA256SUMS.draft` 含 `wording-risks.md` 一行哈希（文件本身未投放）。建议 setup 按 `ALLOW_LIST` 生成哈希。
3. **自记 FIXES 与回喂协议语义叠加**：`TASK.txt` 让模型自写 `work/FIXES.md`，模型据此自拟“轮 1”，与“驾驶员回喂轮次”混在一个文件里；终稿协议应把两栏分开（模型自检 vs 回喂），否则“≤5 轮”口径不可核。

### 索引（候选 A）单点风险

模型以 `move()` 返回值探测自身 index（候选 A 兜底）。若引擎按“界检查即时返回 `ERR_*`”则探测有效；若按“宿主终裁、沙箱内不即时校验”则恒真、退回 `MY_INDEX=0`（错位）。此条已是本舱最大单点风险，写入 14 的措辞待裁清单。

### 协议/工具冲突

- **本票验收与交付要求自相矛盾**：“三件套要求”要 session 存档，“验收”却写“舱内 `session/` 不出舱”；而 `collect` 实现是无条件 `cp -r "$JAIL/session"`。本次照交付要求保留了 `session/`（JSONL + `PROMPT.txt`）。终稿要么把“不出舱”改为“只出白名单 session 存档”，要么去掉三件套里的 session 项。
