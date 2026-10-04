# FIXES

## v1（初版，原文见 script.v1.ts）

- 策略：C 占点不采集。产能只造 melee（8），不造 worker、不下 harvest；单位优先占中立点位，
  其次占敌方位点。
- 座位：`getMyIndex()` 读一次存 `myIndex`，不靠位置反推。
- 跨 tick 记忆：模块级只有 `myIndex` 一个数值；所有单位/点位/玩家每 tick 重新查询。
- 每单位每 tick 一条单位级意图：射程内有敌人则 `attack`，否则 `moveTo`；已与目标点位相邻则
  原地驻守（不提交第二意图），让占领进度累积。
- 下单：先读 `producing`，为 `null` 且余额 ≥ 8 才 `spawnUnit(base.id, "melee")`；
  `spawnUnit` 失败用 `isError`/`errCode` 两步判，`ERR_NOT_ENOUGH_RESOURCES` 时本 tick 停手。
- 全整数：只用 `getRange` 的切比雪夫距离与比较，无除法、无 `Math`。
- 禁用面检查：无 `import`/`export`/`require`/`eval`，无 `Date`/`Math.random`/`performance`/
  `queueMicrotask`，无 `__` 前缀全局。

### 已知假设（文档未展开处，不替契约补写）

- rules.md §5（占领进度机）为 TODO 占位。本站点可占、`progressOwner`/`progress` 为快照字段，
  且 `api.md` 动作表里没有独立的 capture 函数，故占领按“单位在点位相邻格驻留”处理。
- 站点格（资源点）多半不可站立：rules.md §4.1 采集明确要求“站在相邻格”，故占领也按相邻格，
  而不是站上点位格。
- 未把产线队列记进脚本：每次读 `producing`，符合“空才下单”。
- 射程按兵种表写死（melee 1 / ranged 2 / cavalry 1 / worker 0），不引入浮点。
