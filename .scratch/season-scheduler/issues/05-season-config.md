# 05: `season.yaml` 契约与装载

**What to build:** 赛季配置的形状与加载器。`season.yaml` 声明:根种子 `masterSeed`、唯一 `ruleset` 版本、种子数 K、参赛存档引用列表;可选并发度、`rankPoints`、地图池、输出目录。加载器用 zod 校验并给出清晰报错;配一份 `season.example.yaml` 作格式范例,且与本赛季 5 条参赛模型一致。**schema 真源只在 runner 一处**,hld / srs / gdd 只写字段意图不复制细节。

**Blocked by:** None(can start immediately)

**Status:** ready-for-agent

- [ ] 必填 `masterSeed` / `ruleset` / `seeds(K)` / 参赛存档引用列表;选填 `concurrency`(默认 `min(cpus, 8)`)/ `rankPoints`(默认 `[3,2,1,0]`)/ `maps` / `outputDir`(默认 `runs/<新 runId>`)。
- [ ] 校验:缺必填、类型错、`M×K` 不满足均摊条件、参赛者少于 4、引用了不存在的存档 → 各自清晰报错。
- [ ] `season.example.yaml` 能被加载器读通,并与本赛季 5 条参赛集一致。
- [ ] `rankPoints` 的默认与「不进 `rulesets/`」在本票固化。
