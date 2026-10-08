# 06: 第一场端到端赛季(fixture,串行)

**What to build:** `modelwar run --config season.yaml` 第一次真的跑起来——在 fixture 根上把一整轮赛季串行跑通(零并发)。这一票走通整条窄路:读 `season.yaml` → 枚举对局 → 逐局把输入**物化**成 `input.json` → spawn 一个 `modelwar match <input.json>` 子进程执行该局 → 读回放末行拿到名次 → 产出**最小** `report.json`(每局的输入引用 + 结果)。同时把 `run` 子命令接到真实处理器,并从 CLI 的「未实现」名单里移除 `run`。赛季启动即做**规则版本前置拒绝**:任一存档的 `meta.ruleset` 与赛季声明不一致 → 报错退出,而不是在报告里分版本分节。

**Blocked by:** 02(读回放末行取名次)、03(对局枚举与座位)、05(赛季配置装载)

**Status:** ready-for-agent

- [ ] `modelwar run` 退出码 0 并产出最小 `report.json`(每局输入引用 + 结果),不再打印「未实现」;CLI 的未实现名单里不再含 `run`。
- [ ] 每局 `input.json` 的键集**恰为**对局输入的五项(存档引用 / 地图 / 地图 hash / ruleset / 种子),多一个赛季字段即被自查拒绝;座位由存档引用列表的下标承载。
- [ ] 每局目录按 `<组合>-<地图>-<种子>` 确定性命名;种子由 `masterSeed` 确定性派生并写进 `input.json`,使任意一局可独立复算。
- [ ] 规则版本不一致 → 退出码 1 报错退出(复用 FR-10 AC2 的拒跑口径),复用既有存档校验路径、不另写。
- [ ] fixture 赛季全程**不联网、不需凭证**,可进 CI。
