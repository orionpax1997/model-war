# H 真实 e2e 读数(票 09)

一次真实端到端:`modelwar gen` 用真实厂商凭据产出第一份冻结脚本,`modelwar match` 装载它跑完一局。
本文件是**读数**,设计真源仍是 `docs/hld.md` §2.2.6 / §7.4 / §9 与 `spec.md`。

## 0. 本次用的模型

| 项 | 值 |
| --- | --- |
| `slug` | `deepseek-v4-flash` |
| `modelId` | `deepseek/deepseek-v4-flash` |
| `endpointFamily` | `chat-completions` |
| 服务商 | Command Code(聚合,`baseUrl = https://api.commandcode.ai/provider/v1`) |
| `contextLength` | `1000000` |
| `protocolRounds`(配置) | `5` |
| `params` | `{ temperature: 0 }` |
| 凭据变量 | `COMMAND_CODE_API_KEY`(只从环境变量读,不落任何文件 / 日志) |

## 1. 实际 prompt 体积

契约读入 = `<root>/docs/rules-v1/{rules.md,api.md}` 逐字拼接(spec: `rules + "\n\n" + api`)。

| 项 | 字节 | 说明 |
| --- | --- | --- |
| `rules.md` | 30284 | 契约真源 |
| `api.md` | 31946 | 契约真源 |
| 拼接后契约 | 62230 | = `rules + "\n\n" + api` |
| 模板 `prompts/base.md` | 1598 | 薄壳 + 指针清单 |
| 第 1 轮完整 prompt(渲染后) | **63902** | 33729 个 UTF-16 字符 |

估算 token:按 2.5 B/token 的往高估口径 ≈ **25561 tok**。真实 API 报的第 1 轮 `prompt_tokens`
是 **17802**(≈3.59 B/token);两者差在往高估口径比 CJK 实际分词更保守。
回喂把逐轮 transcript 全量重发,故 prompt 逐轮增长:`prompts[0]` 63902 B → `prompts[1]` 69033 B →
`prompts[2]` 74387 B(增量 = 上一轮模型回文本 + 校验文本,与契约 §2.2 一致)。

## 2. `contextLength` 是否够读契约

够,且余量充裕:

- `contextLength = 1000000`。
- 实测最大的一次请求 `prompt_tokens = 21013`(第 3 轮,已含两轮回喂),只占约 **2.1%**。
- 按服务商目录里「≥ 契约 token 的 ×10 余量」判尺:契约 ≈ 17802–25561 tok(口径见 §1),×10 后
  仍 ≤ 1,000,000。结论:**1M 上下文足够**(≈56× 于单轮契约)。

## 3. 实际协议轮数

**3 轮(> 1)**;`protocolRounds` 配置 5,未用尽。逐轮 `kind` 与结论:

| 轮 | `kind` | 结论 | `finishReason` | `prompt_tokens` / `completion_tokens` | `errorCodes` |
| --- | --- | --- | --- | --- | --- |
| 1 | `tsc` | 编译失败 | `stop` | 17802 / 18703(其中 reasoning 17239) | `TS2532`, `TS18048` |
| 2 | `tsc` | 编译失败 | `stop` | 19345 / 2072(其中 reasoning 436) | `TS2349` |
| 3 | `contract` | **通过,冻结** | `stop` | 21013 / 7421(其中 reasoning 5774) | `[]` |

累计 token ≈ 86356。全轮 `finishReason = stop`,**没有截断**。

## 4. 是否触发过回喂(本票最关心)

**触发了,共 2 次。** 这是与两次盲写实证(6 舱 0 次契约回喂)的关键差别:

- 第 1 轮 tsc 编译失败(`TS2532` / `TS18048`)→ 把 tsc 诊断文本逐字回喂 → 第 2 轮。
- 第 2 轮 tsc 编译失败(`TS2349`)→ 把 tsc 诊断文本逐字回喂 → 第 3 轮通过。

即:回喂环在本轮由 **tsc 那一栏**驱动(不是合约静态校验栏),两次都是编译诊断,内容只有 tsc 文本、
不含任何引擎 / 对局信息。`meta.prompts.length === meta.protocolRounds === 3`,逐轮 prompt 完整留档。

## 5. `modelwar match` 结果

```
node apps/cli/dist/modelwar.mjs match runs/e2e/matches/c0/input.json --root .
modelwar match: 600 tick 已结算,回放写入 .../runs/e2e/matches/c0/replay.jsonl(runner=quickjs,timeout)
EXIT=0
```

**退出码 0。** 一句话结论:这份真冻结脚本能被装载段接受、能在真沙箱(quickjs)里跑满 600 tick 到
回合计时上限并产出回放。

「装载通过」的证据(input.json 的 4 席都指向这一份真存档):

- `assemble` 未拒跑——退出码是 0,不是装载失败码;stderr 里**没有任何装载期诊断**
  (`archive-files-incomplete` / `sha256-mismatch` / `ruleset-version-mismatch` / `sandbox-runtime-hash-mismatch` 一个都没出现)。
- 四席的 `archivePath` 用仓库根相对路径,`scriptSha256` / `metaSha256` 为现场实测值;
  `ruleset: "v1"` 三处一致,`sandboxRuntimeHash` 与 `SANDBOX_RUNTIME_HASH` 一致。
- 跑出了回放文件 `runs/e2e/matches/c0/replay.jsonl`(600 tick 已结算的产物)。

## 6. 最终存档

| 项 | 值 |
| --- | --- |
| 目录 | `archive/deepseek-v4-flash/2026-10-08T05-12-42-057Z/` |
| `runId` | `2026-10-08T05-12-42-057Z` |
| `scriptSha256` | `18272019d7cd92da43e23fe3a78ded9d923c40798633525dbc02b86b5e162e6c` |
| `meta.json` sha256 | `4e4eb87b8027ee5d7cdbffd7e8fc7edbcd2c06309ba670d6997bc2786fb2f8ef` |
| 三件套 | `script.ts` / `script.js` / `meta.json` |
| `tscVersion` | `7.0.2` |

`script.js` 现场 sha256 与 `meta.scriptSha256` 相等(就是上表那个值);`meta.validation = { passed: true, errors: [] }`。

## 7. 生成过程中遇到的真实报错

- **无端点 / 鉴权 / 截断错误**:全部轮次 `finishReason = stop`,没有 4xx/5xx、没有缺凭证、没有
  截断重试;`retry.ts` 的退避分支本次未被触发。
- 真实的失败只有**两轮 tsc 编译诊断**(见 §3),都是模型自造的 TypeScript 错误,不是端点问题:
  - 第 1 轮:`TS2532`(Object is possibly 'undefined')、`TS18048`('x' is possibly 'undefined')。
  - 第 2 轮:`TS2349`(This expression is not callable)。
- 耗时:生成 ≈ 7 min(含两轮回喂与真 tsc + 校验器子进程);`match` ≈ 4 s(600 tick 一局)。

## 8. 与模板 / 配置相关的裁定

- `models.yaml` 的 `params` 给了 `temperature: 0`(保守值),`protocolRounds` 显式写 5。
- `prompts/base.md` 的「交付与协议」一行由「输出只给一个代码块」改为「只输出脚本全文本身,**不要
  Markdown 代码块围栏,不要任何解释文字**」——生成管线把模型回文本**逐字**写成 `script.ts`
  (没有剥围栏的一步),若模型把脚本包在 Markdown 代码块围栏里,产物第 1 行就是三个反引号、直接编译
  失败。本次模型输出即为裸脚本,未出现围栏。模板仍是「薄壳 + 指针清单」,未复制任何判据文本。
