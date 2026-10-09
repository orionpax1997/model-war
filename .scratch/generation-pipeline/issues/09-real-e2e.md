# 09: 真实 e2e——1 个真实模型产出真存档

**What to build:** 用真实厂商凭据跑一次完整生成,产出第一份真实 `archive/`,证明 M3 的交付不是空壳;并让暂存的模型事实收进 `models.yaml`。

**Blocked by:** 05(失败路径)、06(传输韧性)、07(体积与相位)、08(真实 HTTP 客户端)

**Status:** resolved

- [x] 从模型 catalog 挑 1 个真实模型,建成 `models.yaml` **格式范例**(只登记本季参赛集,不把 85 条当配置维护)。
- [x] 跑真管线,产出真 `archive/<modelSlug>/<runId>/` 三件套,且 `modelwar match` 装载通过。
- [x] 删除 gitignore 的暂存 `.modelwar-providers.md` 与 `.modelwar-models.json`(非密钥事实已收进 `models.yaml`)。
- [x] 记录本次真实读数:实际 prompt 体积、`contextLength` 是否够读契约、实际协议轮数、是否触发过回喂。

## Answer

已实现并合并(提交 `a8b010d` / `8cf4ebf`,经 PR #10 / 合并提交 `46019a4` 进入 `main`)。

- `models.yaml` 落地为**格式范例**:只登记本季参赛集一条(`deepseek-v4-flash`,Command Code 聚合、`chat-completions`),不把服务商 85 条目录当配置长期维护。`prompts/base.md` 的「交付与协议」一行改为「只输出脚本全文本身,不要 Markdown 代码块围栏」(管线把模型回文本逐字写成 `script.ts`,没有剥围栏的一步)。
- 真管线产出 `archive/deepseek-v4-flash/2026-10-08T05-12-42-057Z/` 三件套,`modelwar match` 装载通过(真沙箱跑满 600 tick、退出码 0,stderr 无任何装载期诊断)。
- gitignore 暂存的 `.modelwar-providers.md` 与 `.modelwar-models.json` 已从工作区删除(两者从未入库,故无对应 commit;`.gitignore` 条目仍保留)。
- 真实读数落在 `.scratch/generation-pipeline/e2e-readings.md`:第 1 轮 prompt **63902 B**(契约拼接 62230 B);`contextLength = 1000000` 够读契约(实测最大请求 `prompt_tokens = 21013`,约 2.1%);实际 **3 轮**(配置 5,未用尽);**触发 2 次回喂**,均由 tsc 诊断驱动(不含任何引擎 / 对局信息),`meta.prompts.length === meta.protocolRounds === 3`。
