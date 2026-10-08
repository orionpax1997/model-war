# 09: 真实 e2e——1 个真实模型产出真存档

**What to build:** 用真实厂商凭据跑一次完整生成,产出第一份真实 `archive/`,证明 M3 的交付不是空壳;并让暂存的模型事实收进 `models.yaml`。

**Blocked by:** 05(失败路径)、06(传输韧性)、07(体积与相位)、08(真实 HTTP 客户端)

**Status:** ready-for-agent

- [ ] 从模型 catalog 挑 1 个真实模型,建成 `models.yaml` **格式范例**(只登记本季参赛集,不把 85 条当配置维护)。
- [ ] 跑真管线,产出真 `archive/<modelSlug>/<runId>/` 三件套,且 `modelwar match` 装载通过。
- [ ] 删除 gitignore 的暂存 `.modelwar-providers.md` 与 `.modelwar-models.json`(非密钥事实已收进 `models.yaml`)。
- [ ] 记录本次真实读数:实际 prompt 体积、`contextLength` 是否够读契约、实际协议轮数、是否触发过回喂。
