# rules-v1 API（契约草案 prototype）

> throwaway 草案。快照失效与"丢弃 vs 异常"是最高频误读点，先读 §1–§2 再写脚本。

## 0. 脚本形态（静态校验先行）

- 单文件自包含，顶层声明 `function loop(): void` 入口；禁 `export / import / require / 动态 eval`。
- 可见全局 = 本页 API + 常量表（§6）+ 纯函数子集（`Math`（除 `Math.random`）、`JSON`、`Number`、`String`、`Array`、`Map/Set`、`Object`）。
- 禁用：`Date`、`Math.random`、`performance`、`queueMicrotask`、定时器、一切非确定源；`__*` 前缀全局全禁（宿主桥已删除，进黑名单）。
- 脚本体积上限 `TODO(→预算与性能终值图)`。
- 校验失败 → 仅错误信息回喂（≤5 轮），无对战反馈。

## 1. 快照（读到的世界是副本，下 tick 作废）

- 每 tick 引擎给你一份只读的世界副本（改它不影响引擎，但也别依赖“我改了副本”做任何事）。
- 你持有的任何对象引用下 tick 全部作废，对象身份不跨 tick 保证。
- 跨 tick 记忆只能用：你自己的模块级变量 + 数值 id（`id` 全局单调递增，销毁不复用）。别缓存对象引用，别缓存 `getObjectById` 返回值。
- 查询函数一律在你的脚本容器内快照副本上操作，不触碰引擎真实状态。

快照形状（字段只读，数值含义见 rules.md）：

```ts
interface Snapshot {
  tick: number;
  players: { index: 0|1|2|3; resources: number; alive: boolean; exceptionTicks: number }[4];
  units: { id: number; owner: 0|1|2|3; type: UnitType; x: number; y: number; hp: number; carrying: number }[];
  sites: { id: number; kind: 'base'|'resource'; x: number; y: number;
           owner: -1|0|1|2|3; progressOwner: -1|0|1|2|3; progress: number; remaining?: number }[];
  productions: { baseId: number; type: UnitType; ticksLeft: number }[];
}
```
（字段名以终稿 `schema` 生成为准；草案先按此写，变了会通知。）

## 2. 两类"没生效"：丢弃（不计异常） vs 异常（计 `exceptionTicks`）

| 情形 | 后果 | 例子 |
|---|---|---|
| 同单位一 tick 提交多个单位级 intent | 取该单位最后一个，前面的静默丢弃，不计异常 | 同一农民 `move` 两次 → 第一次被覆盖 |
| intent 非法（属主错、参数越界、目标不存在/不合法、无攻击能力者 `attack`） | 该条丢弃 + 写入当 tick 事件流（调试可见），不计异常 | `attack` 打基地；`harvest` 指基地；无攻击能力者 `attack` |
| `spawnUnit` 资金不足 | 下单无效（`ERR_NOT_ENOUGH_RESOURCES`），不占队列不扣款，不计异常 | 开局 16 块钱买 12 的远程后剩 4，再买 8 的近战 → 第二单无效 |
| `loop()` 抛异常（含超预算：算力超限 / API 调用超限；越权调用：未定义 action、已删桥函数、未暴露字段；内存超限转成的异常；深递归栈溢出） | 本 tick 该方全部 intents 置空（原地待命）+ `exceptionTicks++`；容器续用、记忆保留 | 死循环被截停;调用了不存在的 `fly()` |
| tick 末存活堆 ≥ `memoryTickCeiling` | 同上（置空 + 计数），阈值 `TODO(→预算与性能终值图)` | OOM 被吞掉也照样判（判据锚定读数，不看异常可见性） |
| 引擎级故障（极罕见，非脚本可触发） | 视同异常计一次 + 防御性重建该方容器（模块级记忆清零），计数由持久化值续算不清零 | 脚本写不出也测不出，只需知道“记忆极 rare 会丢” |

结论：写错参数最多丢单条；写崩 `loop()` 才丢整 tick。累计达 `exceptionTickLimit`（`TODO(→预算与性能终值图)`）判负出局。

## 3. 查询函数（只读，不限次但 `findPath` 计入预算）

```ts
getTick(): number;
// 当前 tick。别拿它当随机种子（对局内无随机）。

getObjectById(id: number): Unit | Site | Production | null;
// 按数值 id 取快照对象。返回的是副本引用，本 tick 内有效，下 tick 作废。

getObjectsByType(kind: 'unit' | 'site', filter?: {
  owner?: 0|1|2|3|-1; type?: UnitType; kind?: 'base'|'resource';
}): (Unit | Site)[];
// 按类型批量取。owner=-1 表中立（仅 site）。结果数组是新数组，元素仍是快照引用（下 tick 作废）。

getRange(ax: number, ay: number, bx: number, by: number): number;
// Chebyshev 距离 max(|dx|,|dy|)。攻击/采集/交付的射程都用它心算。

getTerrainAt(x: number, y: number): 'plain' | 'wall' | 'out';
// 地形查询。'out' 表地图外。点位不在墙上（地图保证），但寻路仍须绕墙。

findPath(sx: number, sy: number, tx: number, ty: number): { x: number; y: number }[] | null;
// 寻路路径（不含起点，含终点），与 `moveTo` 实际移动同一实现，结果可信。
// 每 tick 调用量计入 API 预算（别用它做算力攻击）；不可达返回 null。
```

## 4. 动作函数（收集 + 界检查，不直写引擎）

调用只做“收集 + 参数界检查 + API 计数”，合法性终裁由引擎统一校验（同一份校验逻辑既做沙箱内即时 `ERR_*` 反馈，也做宿主最终裁决，不存在两套逻辑打架）。一个单位每 tick 至多一个单位级 intent；`spawnUnit` 为玩家级。

```ts
move(unitId: number, dx: -1|0|1, dy: -1|0|1): void | ERR_*;
// 走一步（含对角）。目标格裁决按 rules.md §3（占位基准 + 轮转优先）。出界/撞墙/参数越界 → 该条无效丢弃。

moveTo(unitId: number, x: number, y: number): void | ERR_*;
// 引擎每 tick 沿 findPath 走一步，等价于本 tick 的 move，参与同一套裁决；路径每 tick 重算，不缓存。

attack(unitId: number, targetId: number): void | ERR_*;
// 目标须存在且为敌方单位。射程：melee/cavalry=1（相邻格），ranged=2。
// 无攻击能力者（worker）调用 → 无效丢弃。基地不可为目标。

harvest(unitId: number, siteId: number): void | ERR_*;
// 农民在己方资源点相邻格（射程 1）采集 +1/tick。非农民 / 非己方点 / 非资源点 / 距离超限 → 无效丢弃。

transfer(unitId: number): void | ERR_*;
// 交全部携带量到相邻己方基地（射程 1）；同时相邻多个取 id 最小者。非相邻/无己方基地相邻 → 无效丢弃。

spawnUnit(baseId: number, unitType: UnitType): ErrResult;
// baseId 须为己方基地；下单即扣款；资金不足 → ERR_NOT_ENOUGH_RESOURCES（无效，不占队列不扣款）。
// 出兵格被占 → 挂起（非错误）；基地易主 → 队列取消退款（见 rules.md §4）。
```

`ERR_*` 全表（目前只有 `ERR_NOT_ENOUGH_RESOURCES` 在来源文档里点名出现过，其余为草案按“界检查”职能反推的候选码，终稿以 `schema` 生成为准）：`ERR_NOT_ENOUGH_RESOURCES`、`ERR_INVALID_UNIT`（候选：id 不存在）、`ERR_NOT_OWNER`（候选：非己方单位/基地）、`ERR_OUT_OF_RANGE`（候选：射程外）、`ERR_INVALID_TARGET`（候选：目标非法，如打基地）、`ERR_INVALID_SITE`（候选：点位类型/归属不对）、`ERR_BAD_ARGS`（候选：参数越界）。即时返回仅为反馈，终裁以引擎丢弃/结算为准。

## 5. 最小 `loop()` 骨架（先读快照：你的 index 藏在快照里）

每 tick 引擎只给你快照，不另行告诉你“你是谁”。开局先从快照里找自己的 index（如下 `MY_INDEX`），之后所有“己方/敌方”判断都以它为准，不要写死数字。

```ts
// 策略自拟。骨架只示范“读快照 → 认出自己 → 组装 intent → 返回”，不含任何策略分支。
type UnitType = 'worker' | 'melee' | 'ranged' | 'cavalry';

// TODO(→终稿确认)：如何从快照认出自己的 index，目前只有两种候选：
// 候选 A：快照里 players 数组的顺序与座位对应，自己是第几个容器即第几项——但这依赖引擎实现细节；
// 候选 B：快照 players 某项带“you/isSelf”标记——来源状态模型里没有这个字段。
// 盲写时二选一并记下选了哪个，它的卡点就是 wording-risks 的实证输入。
const MY_INDEX = 0 as 0|1|2|3; // 占位：实写时从快照认出自己，禁止写死

let myUnits: number[] = []; // 只存数值 id，不存对象引用

function loop(): void {
  const units = getObjectsByType('unit', { owner: MY_INDEX });
  myUnits = units.map(u => (u as { id: number }).id);
  for (const id of myUnits) {
    move(id, 0, 0); // 占位：同单位后一次调用覆盖前一次，写最终意图即可
  }
}
```

## 6. 常量表

```ts
type UnitType = 'worker' | 'melee' | 'ranged' | 'cavalry';
type IntentKind = 'move' | 'moveTo' | 'attack' | 'harvest' | 'transfer' | 'spawnUnit';
type ErrCode = 'ERR_NOT_ENOUGH_RESOURCES' | 'ERR_INVALID_UNIT' | 'ERR_NOT_OWNER'
  | 'ERR_OUT_OF_RANGE' | 'ERR_INVALID_TARGET' | 'ERR_INVALID_SITE' | 'ERR_BAD_ARGS';
```

数值常量（与 rules.md §10 同源，正式版由 `rulesets/v1.json` 生成）：
`tickLimit=600`、`harvestRate=1`、`carryLimit=20`、`resourcePerSite=125`、
`baseScore=4`、`resourceScore=1`、`unitCostDivisor=6`、`captureTicks=10`、
roster 见 rules.md §10、`initialResources=16`。
`exceptionTickLimit` / 预算三数 / 地图量：`TODO(→预算与性能终值图 / 地图票)`。
