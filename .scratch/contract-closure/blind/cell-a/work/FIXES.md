# FIXES

## v1（初版）

- 依据 input/rules.md、input/api.md、input/PROMPT.base.md、input/STRATEGY.txt 编写。
- 策略取向：A 爆兵压制。基础农民上限 2，之后每条空产线全部出近战。
- 形态自检：顶层 `function loop()`；无 import/export/require/eval；
  未使用 Date/Math.random/performance/queueMicrotask/`__` 前缀；只用 API 表的
  getMyIndex/getObjectsByType/getRange/spawnUnit/isError/transfer/moveTo/harvest/attack。
- 座位只从 `getMyIndex()` 读一次存模块级数值；跨 tick 只存 `me`。
- 下单前先读 `producing`，空才下单。
- 每单位每 tick 至多一条单位级意图；`spawnUnit` 为玩家级。
- 错误判别走 `isError` / `errCode` 两步（本版只用到 `isError`）。
- 全整数运算，无 `Math.floor`，无浮点中间量。
