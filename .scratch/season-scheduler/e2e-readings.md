# I 真实赛季读数(票 11)

一次真实赛季收口:`modelwar gen` 用真实厂商凭据冻结本赛季 5 条模型,`modelwar run` 跑完整轮 60 局。
本文件是**读数**,设计真源仍是 `docs/hld.md` §2.2.6 / §8 / §9 与 `.scratch/season-scheduler/spec.md`。

> **状态:已完成(2026-10-09)。** 冻结 5/5 成功,整轮 60 局退出码 0,`report.md` / `report.json` /
> `narrative/` 落盘。此前 2026-10-08 的冻结阻塞(4/5 传输超时 + 网关 524)已由 gen 传输流式修复解除
> (见 `.scratch/generation-pipeline/issues/10-streaming-transport.md`);阻塞阶段的读数与失败记录仍原样
> 保留在 §8。本轮另发现两处与本票交付无关的缺陷,见 §7,已另开票,不在本票内改。

---

## 0. 本季参赛集(5 条,spec「参赛集与规模」定案)

| 项 | 值 |
| --- | --- |
| 服务商 | Command Code(聚合,`baseUrl = https://api.commandcode.ai/provider/v1`) |
| `endpointFamily` | `chat-completions`(五条同) |
| 凭据变量 | `COMMAND_CODE_API_KEY`(只从环境变量读,不落任何文件 / 日志;只经 `<root>/.env` 便利加载) |
| `strategy` | 五条注入同一句:`扩张运营:先稳住经济与点位,攒够家底再转军事,按 tick 节奏推进不冒进。`(spec:「赛模型,不赛策略」) |
| `protocolRounds` | `5`(五条同) |
| `params` | `{ temperature: 0 }`(五条同) |

| `slug` | `modelId` | lab | `contextLength` | 端点目录存在性 |
| --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | `deepseek/deepseek-v4-flash` | DeepSeek | `1000000` | ✓ |
| `deepseek-v4.1-flash` | `deepseek/deepseek-v4.1-flash` | DeepSeek | `1000000` | ✓ |
| `gpt-6-luna` | `gpt-6-luna` | OpenAI | `1050000` | ✓ |
| `mimo-v2.6-flash` | `xiaomi/mimo-v2.6-flash` | Xiaomi | `1048576` | ✓ |
| `muse-spark-1.3-contributor` | `meta/muse-spark-1.3-contributor` | Meta | `1048576` | ✓ |

端点目录核对(阻塞阶段实测):`GET https://api.commandcode.ai/provider/v1/models` **HTTP 200**(1.68 s,87 条),
五条 `modelId` 逐条命中且支持 `/chat/completions`。故配置本身无误,当时的失败不是模型名写错。

## 1. gen 冻结读数(已完成)

命令行:`node apps/cli/dist/modelwar.mjs gen --config models.yaml`(root = worktree 根)。

| 项 | 值 |
| --- | --- |
| 退出码 | **0**(5/5 冻结成功) |
| `runId`(整批共享) | `2026-10-09T01-09-09-599Z` |
| 墙钟 | **2183.09 s(36 min 23 s)** |
| 冻结成功 | 5 条(见 §1.1) |
| 失败 | 无(stderr 零失败行;本 `runId` 下 0 条 `failed-*.json`) |

### 1.1 逐模型逐轮读数(`usage` 取自端点返回,非估算)

| `slug` | 轮数 | 轮 | `kind` | 结论 | `finishReason` | `prompt_tokens` / `completion_tokens`(reasoning) | `errorCodes` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | 2 | 1 | `tsc` | 编译失败 | `stop` | 17802 / 29619(26172) | `TS2532` |
| | | 2 | `contract` | **通过,冻结** | `stop` | 21324 / 4097(555) | `[]` |
| `deepseek-v4.1-flash` | 1 | 1 | `contract` | **通过,冻结** | `stop` | 17802 / 28833(26606) | `[]` |
| `gpt-6-luna` | 1 | 1 | `contract` | **通过,冻结** | `stop` | 20353 / 10882(7768) | `[]` |
| `mimo-v2.6-flash` | 1 | 1 | `contract` | **通过,冻结** | `stop` | 18905 / 83855(79084) | `[]` |
| `muse-spark-1.3-contributor` | 2 | 1 | `tsc` | 编译失败 | `stop` | 18105 / 12014(6903) | `TS7006`, `TS2345` |
| | | 2 | `contract` | **通过,冻结** | `stop` | 23460 / 7104(1889) | `[]` |

- 每条的 `meta.validation = { passed: true, errors: [] }`;`meta.prompts.length === meta.protocolRounds`(逐轮 prompt 完整留档);`tscVersion 7.0.2`。
- **共触发 2 次回喂**(`deepseek-v4-flash` 1 次、`muse-spark-1.3-contributor` 1 次),均由 tsc 诊断驱动、不含任何引擎 / 对局信息。
- 全轮 `finishReason = stop`:**无截断**、无 4xx/5xx、无缺凭证。

### 1.2 流式修复的实测效果(本批最关键的读数)

- 阻塞阶段用**非流式**请求时,本季 4 条推理型模型单次生成 150–176 s,`mimo` / `muse` 更被网关在 **~130 s 回 HTTP 524**。
- 修复(channel: `chat-completions` 走 SSE + 空闲超时)后,**同一批次 5/5 冻结成功,零传输失败**。
- `mimo-v2.6-flash` 单轮 `completion_tokens = 83855`(其中 reasoning **79084**),在流式下持续出字约 **22 min** 后正常 `stop`——
  这条模型在非流式时代无法读到结果(524)。它同时印证:把客户端超时设成「整次请求总时长」会误杀这类慢而持续出字的合法生成,
  「空闲超时」才是正确口径(设计理由见票 10)。
- 整批墙钟 2183 s ≈ 36 min,其中 `mimo` 一条占约 22 min。

## 2. `season.yaml` 取值(已落盘)

| 字段 | 值 |
| --- | --- |
| `masterSeed` | `"2026-m4"` |
| `ruleset` | `v1` |
| `seeds` | `4` |
| `maps` | `[corridor-split, fortress-core, open-clash]` |
| `rankPoints` | `[3, 2, 1, 0]` |
| `concurrency` | `8`(本机 `nproc = 8`) |
| `participants` | 5 条 `archive/<slug>/2026-10-09T01-09-09-599Z`(即 §0 五条,共享本季 `runId`) |

`M × K = 12 ≡ 0 (mod 4)` ✓。对局总数 `C(4,5) × 3 × 4 = 60`,每模型出场 48 局。

## 3. 整轮墙钟 + 并发度

命令行:`node apps/cli/dist/modelwar.mjs run --config season.yaml`。

| 项 | 值 |
| --- | --- |
| 退出码 | **0** |
| `runId`(赛季) | `2026-10-09T01-53-05-717Z` |
| 整轮墙钟 | **74.92 s** |
| 并发度 | `8`(配置值 = min(cpus, 8)) |
| 对局执行次数 | **61**(60 局 + 1 局重跑,见 §4) |
| 成功对局 | **59** |
| 成功对局吞吐 | ≈ `61 / 74.92 s ≈ 0.81 局/s`(并发 8 下,观测到的调度吞吐) |

对局阶段**零 API 调用**(跑的是冻结 `script.js`),成本只在 §1 的冻结期。

## 4. 重跑与剔除

- **1 条对局问题**:`c3-corridor-split-s2`(map `corridor-split`,seed `2936867027`)→ `engine-crash`(退出码 2),
  **按 §8.4 重跑 1 次,再触发**,记入「对局问题清单」并 **排除出排名**(`excludedFromRanking: true`)。
- 该崩溃**可确定性复现**:对同一份 `input.json` 直跑 `modelwar match` 两次,两次都是同一处 quickjs-ng 断言
  (`Assertion failed: JS_REF_COUNT(p) > 0 … gc_decref_child` / `JS_REF_COUNT(sh) == 0 … js_free_shape0`)→ `exitCode 2`。
  该局四席为 `mimo` / `muse` / `deepseek-v4-flash` / `gpt-6-luna`。**根因不在本票范围**,见 §7。
- 无退出码 1 / 4 的赛季级失败,故无中止;无退出码 3(不确定超时)。

## 5. 产物清单 + 两份名单

| 产物 | 状态 |
| --- | --- |
| `report.md` | ✓ `runs/<runId>/report.md`(3.8 KB:排名、代表性叙事、两份名单) |
| `report.json` | ✓ `runs/<runId>/report.json`(51.1 KB:61 条对局记录 + 5 条 standings + 两份名单) |
| `narrative/` | ✓ **60 篇**(每局一篇,含被剔除的那局) |
| `input.json` | ✓ **60 份**(`matches/<combo>-<map>-<seed>/input.json`,每局可独立复算) |
| 冻结存档 | ✓ 5 条 `archive/<slug>/2026-10-09T01-09-09-599Z/`(三件套 `script.ts` / `script.js` / `meta.json`) |

**排名(报告口径,展示性,不作统计推断):**

| 名次 | 模型 | 赛季总分 | 有效局数 | 对局均分 |
| --- | --- | --- | --- | --- |
| 1 | `muse-spark-1.3-contributor` | 99.50 | 47 | 2.12 |
| 2 | `deepseek-v4-flash` | 71 | 47 | 1.51 |
| 3 | `deepseek-v4.1-flash` | 68 | 48 | 1.42 |
| 4 | `mimo-v2.6-flash` | 62.50 | 47 | 1.33 |
| 5 | `gpt-6-luna` | 53 | 47 | 1.13 |

- 「校验失败名单」(`report.json.validationFailures`):**8 条,全部是阻塞阶段 2026-10-08 的陈旧 transport 记录**,
  不是本季的冻结失败(本季冻结 **0 失败**)。报告确实列出了它们,且措辞称这些模型「没有参赛资格」——
  与 §5 排名里这 5 条**本季都参赛了**矛盾。**这是报告侧 `readFailureRecords` 按盘全扫口径暴露的问题**,见 §7,另开票。
- 「对局问题清单」(`report.json.matchIssues`):1 条(§4 的引擎崩溃;退出码 2、重跑 1、排除出排名)。

## 6. NFR-3 供 L 标定的读数

- **对局阶段零 API、每局一条 `modelwar match` 子进程**;60 局 + 1 重跑在并发 8 下整轮 **74.92 s**。
- 引擎未逐局落墙钟读数(报告不含单局墙钟),故本票只能给**整轮墙钟与吞吐**(§3);单局墙钟分布仍归 L 标定时实测。
- 冻结期单条推理型模型生成 **150 s–22 min** 量级(`mimo` reasoning 79k tok 最长);这是「契约冻结」链路的量级,
  提示 gen 侧超时参数须与真实模型延迟匹配(已由票 10 的空闲超时口径解决)。**不下任何统计结论。**

## 7. 与设计真源 / 交付意图的偏差裁定

1. **`readFailureRecords` 全盘扫描口径**(缺陷,另开票):报告把 `archive/` 下**所有** `failed-*.json` 当作校验失败名单,
   不区分是哪一批 gen、也不看该 slug 本季是否参赛。真实赛季里表现为主排名内 5 条模型同时出现在「没有参赛资格」名单(§5)。
   本票**未改**生产代码(票 11 是收口验证票,不是规格变更票)。
2. **`quickjs-ng` 引擎崩溃**(缺陷,另开票):`c3-corridor-split-s2` 确定性触发 GC 断言(§4)。属引擎 / 沙箱侧问题,
   不在 I(scheduler/ranker/reporter)与 gen 传输修复的范围。
3. **`gpt-6-luna` 的 `modelId` 无 provider 前缀**(spec 表逐字如此:lab 标 OpenAI,`modelId = gpt-6-luna`)。
   端点目录确认该 id 存在,**未擅自加 `openai/` 前缀**。
4. **旧的 `deepseek-v4-flash` 存档**(`archive/deepseek-v4-flash/2026-10-08T05-12-42-057Z/`)是 H 的 E2E 实证遗留,
   本季未使用;本季该模型用的是本轮新存档(§0)。

## 8. 阻塞阶段存档(2026-10-08,历史)

冻结修复前的一轮尝试,留作旁证,原文读数与失败记录不删:

- 整批(`gen` 5 条)退出码 **1**,墙钟 **1979.2 s**;仅 `gpt-6-luna` 冻结成功,其余 4 条 `classification = transport`
  (**不是** tsc / contract 校验失败)。
- 4 条失败记录(8 个文件,两轮尝试):`archive/<slug>/failed-2026-10-08T14-49-44-003Z.json` 与
  `archive/<slug>/failed-2026-10-08T15-35-01-*.json`(slug ∈ {`deepseek-v4-flash`, `deepseek-v4.1-flash`,
  `mimo-v2.6-flash`, `muse-spark-1.3-contributor`})。这些就是 §5 报告里那 8 条陈旧失败名单的来源。
- 直连探针(客户端超时放到 600 s)量真实单次耗时:`deepseek-v4-flash` 151.7 s / `deepseek-v4.1-flash` 175.8 s(均 200),
  `mimo-v2.6-flash` 130.5 s / `muse-spark-1.3-contributor` 132.5 s(均 **HTTP 524**,网关 origin 超时)。
- 两处独立的墙:(a) 客户端 `DEFAULT_TIMEOUT_MS = 120000` < 实测 150–176 s;(b) 网关自身在 ~130 s 回 524。
  修法 = 流式(字节尽早开始流动绕开 524)+ 空闲超时,已落 `.scratch/generation-pipeline/issues/10-streaming-transport.md`。
- 当时未写 `season.yaml`(成功数 < 4,participants 凑不出),故无整轮读数。

## 9. 测量口径与注意

- token 数直接取端点返回的 `usage`(非估算);`reasoning_tokens` 在 `completion_tokens_details` 里。
- 墙钟:冻结批用 `/usr/bin/time -f %e`;整轮赛季同法。均为**单次**读数,不宣称统计意义。
- `runs/**` 按 `.gitignore` 排除,不入库;`archive/**`(冻结脚本三件套)按仓规入库,新克隆可凭 §2 的 `season.yaml` + 存档复算整轮。
- 本文件是读数,设计真源仍是 hld §8 / §9 与 spec.md。
