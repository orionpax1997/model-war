# I 真实赛季读数(票 11)

一次真实赛季收口:`modelwar gen` 用真实厂商凭据冻结本赛季 5 条模型,`modelwar run` 跑完整轮 60 局。
本文件是**读数**,设计真源仍是 `docs/hld.md` §2.2.6 / §8 / §9 与 `.scratch/season-scheduler/spec.md`。

> **状态:阻塞 —— 冻结阶段未过关,整轮赛季未开跑。**
> 阻塞原因与证据见 §1/§7:真实 prompt(约 17.8k tok / 33729 字符)下,本季 4 条推理型模型单次
> 生成需 **150–176 s**,而 gen 的 HTTP 客户端硬超时是 **120 s**;`mimo` / `muse` 两条更被网关在
> ~130 s 处直接 **HTTP 524**。**只有 `gpt-6-luna` 冻结成功**,成功数 1(另有上一轮旧存档 1 条,合计
> 2 个不同 slug)< 赛季最低要求的 4 条,故 `modelwar run` 无法启动。修法属生产代码(超时/流式),按
> 交办约束**不在本票内改**,另开变更。

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

端点目录核对:请求 `GET https://api.commandcode.ai/provider/v1/models` **HTTP 200**(1.68 s,返回 87 条),
五条 `modelId` 逐条命中且支持 `/chat/completions`。故**配置本身无误**,失败不是模型名写错。

## 1. gen 冻结读数

### 1.1 批次运行(整批 5 条,串行)

命令行:`node apps/cli/dist/modelwar.mjs gen --config models.yaml`(root = worktree 根)。

| 项 | 值 |
| --- | --- |
| 退出码 | **1**(4 失败) |
| `runId`(整批共享) | `2026-10-08T14-49-44-003Z` |
| 墙钟 | **1979.2 s(32 min 59 s)** |
| 冻结成功 | `gpt-6-luna`(2 轮,见 §1.2) |
| 失败 | `deepseek-v4-flash` / `deepseek-v4.1-flash` / `mimo-v2.6-flash` / `muse-spark-1.3-contributor`,**全部第 1 轮传输失败**(未消耗协议轮) |

失败记录(FR-8 AC4 旁证,原样保留,勿删):

- `archive/deepseek-v4-flash/failed-2026-10-08T14-49-44-003Z.json`
- `archive/deepseek-v4.1-flash/failed-2026-10-08T14-49-44-003Z.json`
- `archive/mimo-v2.6-flash/failed-2026-10-08T14-49-44-003Z.json`
- `archive/muse-spark-1.3-contributor/failed-2026-10-08T14-49-44-003Z.json`

**注意分类**:**四条的 `classification` 都是 `transport`,不是 `tsc` / `contract`**。它们**不是**「校验失败」
(全程没走到编译 / 静态校验),而是**传输超时**。FR-8 AC4 的「校验失败名单」指 gen 侧没参赛资格的存档;
transport 失败进不进正式报告由报告侧口径决定,本票据实记录,不冒充校验失败。

### 1.2 唯一冻结成功者的逐轮读数(`gpt-6-luna`)

目录 `archive/gpt-6-luna/2026-10-08T14-49-44-003Z/`;`meta.validation = { passed: true, errors: [] }`;`tscVersion 7.0.2`。

| 轮 | `kind` | 结论 | `finishReason` | `prompt_tokens` / `completion_tokens`(其中 reasoning) | `errorCodes` |
| --- | --- | --- | --- | --- | --- |
| 1 | `tsc` | 编译失败 | `stop` | 20353 / 6477(4069) | `TS2345` |
| 2 | `contract` | **通过,冻结** | `stop` | 22795 / 2807(367) | `[]` |

累计 token ≈ 52432。**触发了 1 次回喂**(第 1 轮 tsc 诊断驱动 → 第 2 轮)。全程无截断、无 4xx/5xx。
`gpt-6-luna` 是本季唯一单次生成落在 120 s 内的模型(推理 token 量小,~4.4k vs deepseek 的 2.3 万+)。

### 1.3 有界重试(第 2 次,逐模型单跑)

批次失败后按约束做**一次有界重试**:对 4 条失败模型各跑 `gen --config models.yaml --model <slug>`
(并发 4 个后台进程),结果**全部再次失败**,各自墙钟 **≈485 s**(= 4 次尝试 × 120 s + 退避):

| 模型 | 退出码 | 墙钟 | 结论 |
| --- | --- | --- | --- |
| `deepseek-v4-flash` | 1 | 484.75 s | 第 1 轮 4 次全部 120 s 超时 |
| `deepseek-v4.1-flash` | 1 | 484.95 s | 同上 |
| `mimo-v2.6-flash` | 1 | 484.95 s | 同上 |
| `muse-spark-1.3-contributor` | 1 | 486.08 s | 同上 |

失败记录新增第二轮(各 slug 的 `failed-2026-10-08T15-35-01-*.json`)。**重试不能改变结果**:
瓶颈是每次请求本身的耗时,不是偶发网络抖动。

### 1.4 直连探针(客户端超时放到 600 s,量真实单次耗时)

用与 gen 逐字相同的渲染 prompt(含契约 + 模板 + 同一句 strategy,33729 字符),`fetch` 直打
`/chat/completions`,`AbortSignal.timeout(600000)`:

| 模型 | HTTP | 耗时 | `finish` | `prompt_tokens` / `completion_tokens`(reasoning) |
| --- | --- | --- | --- | --- |
| `deepseek/deepseek-v4-flash` | 200 | **151.7 s** | `stop` | 17802 / 25943(24145) |
| `deepseek/deepseek-v4.1-flash` | 200 | **175.8 s** | `stop` | 17802 / 25228(22834) |
| `xiaomi/mimo-v2.6-flash` | **524** | 130.5 s | — | —(网关截断,非 JSON) |
| `meta/muse-spark-1.3-contributor` | **524** | 132.5 s | — | —(同上) |

结论:两处独立的墙——(a)gen 客户端 `DEFAULT_TIMEOUT_MS = 120000`(< 实测 150–176 s);
(b)网关自身在 ~130 s 处对 `mimo` / `muse` 回 **524**(Cloudflare origin 超时)。**只调大客户端超时
解决不了 524**,那两条需要服务侧 / 流式路径。

## 2. `season.yaml` 取值

**未落盘。** 因冻结成功数(1 个新 slug + 1 条旧存档 = 2)< 4,paticipants 凑不出赛季最低人数,
`modelwar run` 必然在装载期拒绝,故本票**未写 `season.yaml`**。拟定值(spec 定案,待冻结补齐后即可用):

| 字段 | 拟定值 |
| --- | --- |
| `masterSeed` | `"2026-m4"` |
| `ruleset` | `v1` |
| `seeds` | `4` |
| `maps` | `[corridor-split, fortress-core, open-clash]` |
| `rankPoints` | `[3, 2, 1, 0]` |
| `concurrency` | `8` |
| `participants` | 需 5 条真实 `archive/<slug>/<runId>`,目前只有 `gpt-6-luna` 一条可用 |

`M × K = 12 ≡ 0 (mod 4)` ✓(规模不变)。预计对局总数 `C(4,5) × 3 × 4 = 60`,每模型 48 局。

## 3. 整轮墙钟 + 并发度

**未开跑**(见 §2)。预期 `concurrency = 8`(本机 `nproc = 8`);整轮墙钟需冻结齐备后实测。

## 4. 重跑与剔除

**未开跑**,故无对局级重跑 / 剔除读数。冻结层面的「重试」读数已在 §1.3。

## 5. 产物清单 + 失败名单

| 产物 | 状态 |
| --- | --- |
| `report.md` | ✗ 未生成(赛季未开跑) |
| `report.json` | ✗ 未生成 |
| `narrative/` | ✗ 未生成 |
| 冻结存档 | ✓ `archive/gpt-6-luna/2026-10-08T14-49-44-003Z/`(`script.ts` / `script.js` / `meta.json`) |
| 冻结失败记录 | ✓ 8 条 `archive/<slug>/failed-<runId>.json`(两批 × 4 slug),分类全为 `transport` |

## 6. NFR-3 供 L 标定的读数

本票**未产出整轮墙钟**(阻塞)。可供 L 参考的间接读数:**对局阶段零 API、每局一条子进程**不变;
冻结期单次推理型模型生成耗时 **150–176 s** 是「契约冻结」这条链路的真实量级(NFR-3 标的是**对局**墙钟,
不直接受此影响,但提示 gen 侧超时参数需与真实模型延迟匹配)。**不下任何统计结论**。

## 7. 与设计真源 / 交付意图的偏差裁定

1. **阻塞根因(需另开变更修)**:`packages/gen/src/http/client.ts` 的 `DEFAULT_TIMEOUT_MS = 120000`
   小于本季推理型模型的真实延迟(150–176 s);且 `mimo` / `muse` 被网关 524。**未在本票改生产代码**
   (交办约束:真 bug 单独变更)。修法方向:调大超时 / 改流式 / 对 524 的处置,由新票定夺。
2. **`gpt-6-luna` 的 `modelId` 无 provider 前缀**(spec 表逐字如此:lab 标 OpenAI,`modelId = gpt-6-luna`)。
   端点目录确认该 id 存在,配置正确;**未擅自加 `openai/` 前缀**。
3. **失败分类口径**:四条的 `classification = transport`,**不是校验失败**。读数里据实分开,不把
   transport 超时冒充 FR-8 AC4 的「校验失败名单」。
4. **旧的 `deepseek-v4-flash` 存档**(`archive/deepseek-v4-flash/2026-10-08T05-12-42-057Z/`)是上一轮
   E2E 实证留下的,仍在库内;本季批次里 `deepseek-v4-flash` 未成功,故它**不能**算入本季共享 `runId` 的
   参赛集。

## 8. 测量口径与注意

- token 数直接取端点返回的 `usage`(非估算);`reasoning_tokens` 在 `completion_tokens_details` 里。
- 墙钟用 `/usr/bin/time -f %e`(整批)/ 探针内 `Date.now()`(单次);探针为**单样本**,只为证明
  「> 120 s」这一量级,**不宣称统计意义**。
- 直连探针用与 gen 逐字相同的渲染 prompt,但**不写存档**,仅测耗时与状态码。
- 本文件是读数,设计真源仍是 hld §8 / §9 与 spec.md。
