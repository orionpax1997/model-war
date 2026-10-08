# 11: 真实赛季收口验证

**What to build:** 用真实厂商凭据(Command Code 的 `COMMAND_CODE_API_KEY`,只从环境变量读)把「一轮含 ≥4 个真实模型的首轮赛季」真的跑出来并留证:先 `modelwar gen --config models.yaml` 冻结本赛季 5 条真实模型,再 `modelwar run --config season.yaml` 跑完整轮 60 局,产出正式报告(含失败名单)。这是 v0 验收第 3 条的承载票,也是 M4★ 的交付实证。**对局阶段零 API 调用**,成本只在冻结期。**注意**:赛季产物目录被 gitignore 排除,所以读数与结论落进 `.scratch/season-scheduler/e2e-readings.md`(照 H 的先例),不试图把 `runs/` 入库。若某个模型冻结失败,它写进**校验失败名单**——这恰好是 FR-8 AC4 的实证,不算翻车。

**Blocked by:** 01–09(全部功能票)

**Status:** ready-for-agent

- [ ] `modelwar gen` 冻结本赛季 5 条真实模型,产出真存档(每条均已实测在该套餐内可用)。
- [ ] `modelwar run` 无人工干预跑完整轮 60 局(每模型 48 局),退出码 0。
- [ ] `report.md` / `report.json` / `narrative/` 落盘;正式报告含失败名单。
- [ ] 读数(实际冻结轮数、契约 token 用量、整轮墙钟、并发度、有无重跑/剔除)写入 `.scratch/season-scheduler/e2e-readings.md`,供 L 标定 NFR-3。
- [ ] 若有模型冻结失败:其失败记录写进校验失败名单并在读数里记明。
