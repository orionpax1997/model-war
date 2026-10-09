# 11: 真实赛季收口验证

**What to build:** 用真实厂商凭据(Command Code 的 `COMMAND_CODE_API_KEY`,只从环境变量读)把「一轮含 ≥4 个真实模型的首轮赛季」真的跑出来并留证:先 `modelwar gen --config models.yaml` 冻结本赛季 5 条真实模型,再 `modelwar run --config season.yaml` 跑完整轮 60 局,产出正式报告(含失败名单)。这是 v0 验收第 3 条的承载票,也是 M4★ 的交付实证。**对局阶段零 API 调用**,成本只在冻结期。**注意**:赛季产物目录被 gitignore 排除,所以读数与结论落进 `.scratch/season-scheduler/e2e-readings.md`(照 H 的先例),不试图把 `runs/` 入库。若某个模型冻结失败,它写进**校验失败名单**——这恰好是 FR-8 AC4 的实证,不算翻车。

**Blocked by:** 01–09(全部功能票);另需先生成侧传输修复——`.scratch/generation-pipeline/issues/10-streaming-transport.md`(已完成)

**Status:** resolved

- [x] `modelwar gen` 冻结本赛季 5 条真实模型,产出真存档(每条均已实测在该套餐内可用)。
- [x] `modelwar run` 无人工干预跑完整轮 60 局(每模型 48 局),退出码 0。
- [x] `report.md` / `report.json` / `narrative/` 落盘;正式报告含失败名单。
- [x] 读数(实际冻结轮数、契约 token 用量、整轮墙钟、并发度、有无重跑/剔除)写入 `.scratch/season-scheduler/e2e-readings.md`,供 L 标定 NFR-3。
- [x] 若有模型冻结失败:其失败记录写进校验失败名单并在读数里记明。(本季冻结 **0 失败**,此条为无触发项;报告里的校验失败名单 8 条是上一轮阻塞尝试留下的陈旧记录,已在读数 §5/§7 记明。)

## Comments

**2026-10-08 阻塞:冻结阶段未过关,整轮赛季未开跑。**

`models.yaml` 已扩到 spec 的 5 条参赛集(全部 `chat-completions` / Command Code / `COMMAND_CODE_API_KEY` /同一句 strategy / `temperature: 0`,端点目录逐条核对存在)。冻结 `gen --config models.yaml`:

- 退出码 1,墙钟 1979 s;整批 `runId = 2026-10-08T14-49-44-003Z`。
- 仅 `gpt-6-luna` 冻结成功(2 轮,1 次 tsc 回喂,≈52k tok);其余 4 条**第 1 轮传输失败**(分类 `transport`,未消耗协议轮),失败记录 `archive/<slug>/failed-<runId>.json` 已留。
- 有界重试(逐模型单跑)结果相同,各 ≈485 s。

根因(直连探针实测):真实 prompt ≈ 33729 字符 / 17802 tok 下,推理型模型单次生成需 **150–176 s**(`deepseek-v4-flash` 151.7 s / `deepseek-v4.1-flash` 175.8 s),而 `packages/gen/src/http/client.ts` 的 `DEFAULT_TIMEOUT_MS = 120000` 更短;**`mimo` / `muse` 两条被网关在 ~130 s 处直接 HTTP 524**。

成功数 1(新)+ 1(旧存档)= 2 个 slug < 赛季最低 4 条,`season.yaml` 无法成形,`modelwar run` 无法启动。

**该修属生产代码(超时 / 流式 / 524 处置),按交办约束不在本票内改,另开变更。** 读数与全部证据见 `.scratch/season-scheduler/e2e-readings.md`。本票保持未解决。

## Answer

已实现并合并。前置的 gen 传输修复先行(票 10):`fix/gen-streaming` 分支把 `chat-completions` 请求切到 SSE 流式、超时改成空闲口径,合并提交 `9659c58`(该票自带两轴评审与修复 `6fad0de`);本票工作分支 `ticket/11-real-season` 并入该修复后重跑。

- **冻结 `gen --config models.yaml`**:退出码 **0**,`runId = 2026-10-09T01-09-09-599Z`,墙钟 **2183.09 s(36 min 23 s)**,5/5 冻结成功、零失败。逐模型逐轮 token / 轮数 / 回喂见读数 §1.1。5 条新存档 `archive/<slug>/2026-10-09T01-09-09-599Z/`(三件套)已提交入库。
- **整轮 `run --config season.yaml`**:退出码 **0**,赛季 `runId = 2026-10-09T01-53-05-717Z`,墙钟 **74.92 s**,并发 **8**,60 局(61 次执行,含 1 次重跑)。排名:1 `muse-spark-1.3-contributor`(99.50) / 2 `deepseek-v4-flash`(71) / 3 `deepseek-v4.1-flash`(68) / 4 `mimo-v2.6-flash`(62.50) / 5 `gpt-6-luna`(53)。
- **产物**:`report.md` / `report.json`(51.1 KB)/ `narrative/` **60 篇** / `matches/*/input.json` **60 份**;`runs/**` 按 gitignore 不入库。
- **重跑与剔除**:1 条对局问题 `c3-corridor-split-s2`(`engine-crash`,退出码 2),重跑 1 次仍触发 → 排除出排名。该崩溃对同一 `input.json` 可确定性复现,属引擎侧缺陷,已另开票(读数 §7)。
- **流式修复的实证**:同一批 5 条模型,非流式时代 4 条传输超时 / 524,流式后零传输失败;`mimo-v2.6-flash` 单轮 `completion_tokens = 83855`(reasoning 79084)、持续出字约 22 min 后正常 `stop`,印证「空闲超时」而非「总时长」才是正确口径。
- **发现的缺陷(另开票,不在本票内改)**:① 报告侧 `readFailureRecords` 全盘扫描,把上一轮阻塞尝试的 8 条陈旧 `failed-*.json` 列进「校验失败名单」,与主排名里同一批模型参赛矛盾;② `quickjs-ng` GC 断言崩溃可确定性复现。二者读数均见 `e2e-readings.md` §5/§7。
