/**
 * **契约兼容层**:把终稿契约(`docs/rules-v1/`)与标定环那个桩(`.scratch/rules-calibration/sim/`)
 * 之间的四处缺口补上,让 `benchmarks/` 里的三份**终稿**产物能在那个**草案代**桩里跑起来。
 *
 * ── 为什么要有这一层,以及它为什么不是「修桩」 ─────────────────────────────────
 * 桩是标定环那个 throwaway feature 的产物,它跑过 1336 场、产出过 gdd §8 的记录 #7~#13。
 * **搬它或修它都会让那些记录不可复现**,所以本文件一行桩的代码都不改,只做宿主侧注入。
 * 而三份基准脚本是**终稿契约**下盲写出来的(`benchmarks/README.md` §1),终稿在草案之后
 * 加了三个 API 名字、把快照的产线字段换了形状。桩里没有这些,于是三份产物在桩里**跑不起来**
 * ——直接跑的结果是每一 tick 抛 `ReferenceError`,四问全部读数归零。
 *
 * 补法一律走桩**自己的扩展点**:桩的 `harness.mjs` 从 `SCRIPTS` 这张表读脚本,而表里的每一项
 * 带一个 `inject` 字段,宿主注入的前置片段(标定环自己的骑兵/农民探针就是这么用的)。
 * 于是本文件只产出一段**前置 JS**,由跑批入口注册进那张表——桩的加载路径、结算、指标口径
 * 一行未动。
 *
 * ── 四处缺口逐条:补什么、残余偏差在哪 ────────────────────────────────────────
 *
 * 1. **座位自认**。终稿有 `getMyIndex()`(交接单 P0-1/P0-N4 的唯一入口),桩是草案代,
 *    注入面里没有它,老脚本靠 `mirror.mjs` 的字符串改写补座位。补法:按座位注入一个常量函数。
 *    残余偏差:无——终稿的口径就是「宿主告诉你你是几号」,这一条与终稿**同义**,
 *    不同义的是老脚本那套「猜座位」,那套已被终稿作废。
 * 2. **错误判别**。终稿动作函数返回 `void | ErrResult`,配 `isError` / `errCode` 两步判别;
 *    桩返回 `void | 'ERR_*'`(裸字符串)。补法:`isError(r)` = 「r 既非 undefined 也非 null」,
 *    `errCode(r)` = 原样返回。残余偏差:返回值的**形状**不同(对象 vs 字符串),
 *    但「有没有错」与「错在哪」这两个判断在两种表示下同义——三份脚本只用这两个 helper,
 *    不碰返回值的内部结构。
 * 3. **错误码常量**。终稿把 7 个 `ERR_*` 当注入面里的字符串常量(真源包
 *    `SANDBOX_INJECTED_API_SYMBOL_CATALOG`,category `error-code`),桩不注入它们。
 *    补法:按那张目录逐个铺成同名同值的字符串。名单不在本文件里写第二份。
 * 4. **快照里的产线字段**。终稿把「这条产线在不在产」挂在 `site.producing = {type, remainingTicks}`
 *    上(`ERR_BASE_BUSY` 那一格的裁决:同一产线重复下单不是错误而是静默丢弃,那一格由这个字段供给),
 *    桩的快照仍是草案形态:顶层 `productions[]`,查询面里没有它。
 *    补法:脚本**自己**的订单簿——`spawnUnit` 被接受时记一笔 `{type, until: tick + spawnTicks}`,
 *    读 `producing` 时先按 `getTick()` 过期。**这条与标定环自己的做法同形**:老四舱脚本读不到
 *    `productions`,cell-a 的做法就是「本地记录自己下过的生产单,避免重复下单」
 *    (`.scratch/rules-calibration/blind/cell-a/work/script.v1.js:20`),所以这一条不引入新口径。
 *    残余偏差两处,都记在这里而不是藏起来:
 *    - 出兵格被自家单位占住时,引擎把订单挂起等格空,而订单簿会在 `spawnTicks` 后认为空闲;
 *    - 基地易主时引擎取消订单并退款,订单簿不知道这一刀。
 *    这两处的规模由桩自己的计数器给出(`spawnOrdersRejectedBusyBase` / `refunds`),跑批时逐场读数。
 *
 * ── 一处**刻意不补**的缺口,以及不补的代价 ────────────────────────────────────
 * `getObjectsByType('player')` 这一档:终稿把它列为四个座位资源/存活/异常计数的唯一读入口,
 * 桩只认 `'unit'` 与 `'site'`(`runtime.mjs` 里 `kind === 'unit' ? snap.units : snap.sites`)。
 * 三份脚本**都**用它读自己的 `resources`(`benchmarks/<舱名>/script.js` 各有一行
 * `getObjectsByType("player")` 然后取 `[me].resources`),不补的后果不是「读不到」而是
 * **读到别的东西**:桩会把一个点位对象塞进去,`.resources` 是 `undefined`,于是
 * `myRes >= 4` 恒假——**cell-b 一辈子不下单**,它的行为读数会是一条纯粹由桩的缺口造出来的假象。
 * 所以这一档**必须补**,补法是一个**宿主账本**:起始资金取规则集文件的 `initialResources`,
 * 每次 `spawnUnit` 被接受扣造价、每次 `transfer` 被接受加携带量(`harvest` 不动池子,
 * 引擎也是 harvest 记账在 `carrying` 上、交付才进池子)。
 * 账本与引擎真值的三处可能分叉,以及它们各自的规模:
 *   - 「产线忙被拒」:桩自己的 `spawnOrdersRejectedBusyBase` 逐场给读数;
 *   - 「基地易主退款」:桩自己的 `refunds` 逐场给读数;
 *   - 沙箱侧的 `spawnUnit`  affordability 判定读的是**真快照**的 `resources`
 *     (`runtime.mjs` 里 `snap.players[playerIndex].resources < cost`),
 *     所以「账本说付得起、引擎说付不起」这条形态在原理上就不发生。
 * 账本里给**别的**座位填 0:三份脚本都不读别人的资源,那一栏是占位,报告里明写。
 * `alive` 由「上一 tick 有没有被调用过」推出来(引擎对已淘汰方不再调 `loop`,而淘汰不可逆),
 * `exceptionTicks` 恒 0——后者不是猜的:四问之二就是判它为 0,真出现异常那一问当场红。
 */

/** 兼容层补的四处缺口 + 刻意记下来的一处口径。报告与人读文档引用这一份,不另写一份。 */
export const COMPAT_GAPS: readonly { readonly gap: string; readonly fill: string }[] = [
  { gap: "座位自认:getMyIndex()", fill: "按座位注入常量函数(与终稿同义)" },
  { gap: "错误判别:isError / errCode", fill: "按桩的裸字符串返回形态翻译(判断同义)" },
  { gap: "错误码常量:7 个 ERR_*", fill: "按真源包注入面目录逐个铺成同名同值字符串" },
  {
    gap: "快照产线字段:site.producing",
    fill: "脚本自己的订单簿 + getTick() 过期(与标定环老脚本同形)",
  },
  { gap: "getObjectsByType('player')", fill: "宿主账本:初始资金 + 下单扣款 + 交付入账" },
];

export type CompatPreludeInput = {
  /** 这一份产物坐在第几号(0..3)。 */
  readonly seat: number;
  /** 各兵种的 `spawnTicks`,取自规则集文件——订单簿的到期 tick 由它算。 */
  readonly spawnTicks: Readonly<Record<string, number>>;
  /** 各兵种的 `cost`,取自规则集文件——账本的扣款由它算。 */
  readonly unitCost: Readonly<Record<string, number>>;
  /** 开局资金,取自规则集文件的 `initialResources`——账本的初值由它算。 */
  readonly initialResources: number;
  /** 错误码名字清单,取自真源包的注入面目录(不在这里手写第二份)。 */
  readonly errorCodes: readonly string[];
};

/**
 * 产出注入到产物前面的一段 JS(桩在装载脚本前先跑它)。
 *
 * ── 为什么全部走 `globalThis.X = …` 而不是顶层 `function X()` ────────────────
 * 脚本级代码的函数声明会被**提升**:先声明 `function getObjectsByType`,再执行
 * `var raw = getObjectsByType` 的话,取到的是**它自己**,于是无限递归。
 * 桩里那些真 API 是 `globalThis.X = …` 装的(不是声明),所以只要我也不声明同名绑定,
 * 抓取到的就是桩的那一份,包一层也不会自己咬自己。
 *
 * `__compat_` 前缀是刻意的:宿主注入的适配代码不是参赛脚本的一部分(静态校验器只判
 * `benchmarks/<舱名>/script.js`,从不看这一段),用 `__` 开头是为了让读代码的人一眼看出
 * 「这段不是脚本自己写的」。
 */
export const compatPrelude = (input: CompatPreludeInput): string => {
  const raw = [
    "var __compat_spawnTicks = " + JSON.stringify(input.spawnTicks) + ";",
    "var __compat_cost = " + JSON.stringify(input.unitCost) + ";",
    "var __compat_errorCodes = " + JSON.stringify(input.errorCodes) + ";",
    "var __compat_seat = " + String(input.seat) + ";",
    "var __compat_busy = {};",
    "var __compat_money = " + String(input.initialResources) + ";",
    "var __compat_lastTick = null;",
    "var __compat_alive = true;",
    "var __compat_raw = {",
    "  got: globalThis.getObjectsByType,",
    "  gob: globalThis.getObjectById,",
    "  spawn: globalThis.spawnUnit,",
    "  harvest: globalThis.harvest,",
    "  transfer: globalThis.transfer,",
    "  tick: globalThis.getTick,",
    "};",
    "function __compat_syncProduction() {",
    "  var t = __compat_raw.tick();",
    "  for (var k in __compat_busy) {",
    "    if (t > __compat_busy[k].until) { delete __compat_busy[k]; }",
    "  }",
    "}",
    "function __compat_site(s, t) {",
    "  if (s !== undefined && s !== null && s.kind === 'base') {",
    "    var b = __compat_busy[s.id];",
    "    s.producing = b === undefined ? null : { type: b.type, remainingTicks: b.until - t };",
    "  }",
    "  return s;",
    "}",
    "function __compat_players(filter) {",
    "  var t = __compat_raw.tick();",
    "  if (__compat_lastTick !== null && t !== __compat_lastTick + 1) { __compat_alive = false; }",
    "  __compat_lastTick = t;",
    "  var rows = [];",
    "  for (var i = 0; i < 4; i += 1) {",
    "    if (filter !== undefined && filter !== null && filter.owner !== undefined",
    "        && filter.owner !== null && filter.owner !== i) { continue; }",
    "    rows.push({",
    "      index: i,",
    "      resources: i === __compat_seat ? __compat_money : 0,",
    "      alive: i === __compat_seat ? __compat_alive : true,",
    "      exceptionTicks: 0,",
    "    });",
    "  }",
    "  return rows;",
    "}",
    "globalThis.getObjectsByType = function (kind, filter) {",
    "  if (kind === 'player') { return __compat_players(filter); }",
    "  var out = __compat_raw.got(kind, filter);",
    "  __compat_syncProduction();",
    "  var t = __compat_raw.tick();",
    "  for (var i = 0; i < out.length; i += 1) { __compat_site(out[i], t); }",
    "  return out;",
    "};",
    "globalThis.getObjectById = function (id) {",
    "  __compat_syncProduction();",
    "  return __compat_site(__compat_raw.gob(id), __compat_raw.tick());",
    "};",
    "globalThis.spawnUnit = function (baseId, unitType) {",
    "  var r = __compat_raw.spawn(baseId, unitType);",
    "  if (r === undefined) {",
    "    __compat_money = __compat_money - __compat_cost[unitType];",
    "    if (__compat_busy[baseId] === undefined) {",
    "      __compat_busy[baseId] = {",
    "        type: unitType,",
    "        until: __compat_raw.tick() + __compat_spawnTicks[unitType],",
    "      };",
    "    }",
    "  }",
    "  return r;",
    "};",
    "globalThis.transfer = function (unitId) {",
    "  var u = __compat_raw.gob(unitId);",
    "  var carried = u === null || u === undefined ? 0 : u.carrying;",
    "  var r = __compat_raw.transfer(unitId);",
    "  if (r === undefined) { __compat_money = __compat_money + carried; }",
    "  return r;",
    "};",
    "globalThis.getMyIndex = function () { return __compat_seat; };",
    "globalThis.isError = function (r) { return r !== undefined && r !== null; };",
    "globalThis.errCode = function (r) { return r; };",
    "for (var ci = 0; ci < __compat_errorCodes.length; ci += 1) {",
    "  globalThis[__compat_errorCodes[ci]] = __compat_errorCodes[ci];",
    "}",
  ];
  return `${raw.join("\n")}\n`;
};
