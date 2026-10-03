/**
 * 规则集的形状(hld §7.1)与派生量。**类型与 JSON Schema 同源**,后者由
 * `ruleset-keys.ts` 的键清单投影而来(见下面「为什么本文件里可以有几句代码」)。
 *
 * 本模块**不含判罚逻辑**:派生量的计算与「双存是否自洽」的断言在 `apps/cli` 的校验器
 * (读入端唯一入口)。真源包交付形状、常量与「这个值叫什么」,不交付「这个值算出来是多少」
 * (spec《校验器:落在 CLI 应用》、spec《常量表的边界》)。
 *
 * ── 派生量:双存 + 装载期断言 ──
 *
 * `spawnTicks` 是一个**既在取值文件里、又由派生式决定**的值。两种存法各有一头的好处:
 * 取值文件是那份数据的真源(缺了它,兵种表的可读性就依赖读者做算术),而系数只活在文件里
 * 就是第二真源(改系数的人不会想到去改四个兵种行)。所以**两个都留**,一致性在装载期断言,
 * 不等即拒跑(断言在 `apps/cli/src/validator.ts`,关键词 `derived-spawn-ticks`)。
 *
 * ── 为什么本文件里可以有几句代码 ──
 *
 * hld §3.2 说本包「无运行时代码」,指的是**没有逻辑**:没有校验、没有读盘、没有分支策略、
 * 不依赖任何包(依赖门禁规则名 `schema-has-no-dependencies` 盯着的就是后者)。而把一个键清单
 * 投影成 `required` 与 `properties` 是三次 `Object` 映射,没有一处判断。替代方案是手写
 * 21 条 `properties` 加一条 21 项的 `required` 数组——那正是 spec《参数键清单与派生量》
 * 要避免的「两处各写一遍」,而两处一漂移,错误就只会在装载期以一条莫名其妙的诊断出现。
 */

import { RULESET_KEY_CATALOG, type RulesetKey } from "./ruleset-keys.js";

/**
 * 一条兵种线的属性。四个字段名与键清单里 `unit-stats` 的 `schema` 同名同义,
 * 错位由 `validator.test.ts` 的「双过 fixture」与键集合断言当场抓住。
 */
export type UnitStats = {
  readonly cost: number;
  readonly hp: number;
  readonly damage: number;
  readonly range: number;
  readonly speed: number;
  /** 生产耗时。与 `⌈cost × SPAWN_TICKS_COEFFICIENT⌉` **双存**,装载期断言两者相等。 */
  readonly spawnTicks: number;
};

/**
 * 一份规则集的全部内容(hld §7.1)。21 个键**全部必填**,没有可选键——
 * 9 个预算键在 M1 阶段取 `0`(未定值),但**取 0 不等于可以不写**:
 * 缺键是 `required` 缺失的另一种错误,而「还没标定」不需要一个新字段来表达。
 *
 * 取值文件里**没有版本键**:规则版本号由三处名字承担(`rulesets/vN.json` 的文件名、
 * `docs/rules-vN/` 的目录名、真源包的 `RULESET_VERSION` 常量),三处一致性由装载期判定。
 * 版本号若既在文件名里又在文件内容里,那就是两处可能各写各的。
 */
export type Ruleset = {
  readonly tickLimit: number;
  readonly captureTicks: number;
  readonly initialResources: number;
  readonly harvestRate: number;
  readonly carryLimit: number;
  readonly resourcePerSite: number;
  readonly worker: UnitStats;
  readonly melee: UnitStats;
  readonly ranged: UnitStats;
  readonly cavalry: UnitStats;
  readonly baseScore: number;
  readonly resourceScore: number;
  readonly unitCostDivisor: number;
  readonly exceptionTickLimit: number;
  readonly eventTickLimit: number;
  readonly apiCallTickLimit: number;
  readonly memoryLimit: number;
  readonly memoryTickCeiling: number;
  readonly wallClockSoftLimit: number;
  readonly wallClockHardTimeout: number;
  readonly scriptSizeLimit: number;
};

/**
 * 生产耗时系数 α:`spawnTicks = ⌈cost × α⌉`。
 *
 * **它是常量,不是键**——取值文件里没有 `spawnTicksCoefficient` 那一格。它也不该有:
 * 派生式的系数由定义持有,不是可标定的数据(可标定的是「这条兵种线多少钱、多久」)。
 *
 * 写浮点在这里是**有理由**的(否则就该被禁浮点门禁问一句):α = 0.5 是 2 的负幂,
 * 而 `cost` 是 JSON Schema 约束下的整数(上界 2^53),于是 `cost × 0.5` 在 IEEE-754 下**精确**,
 * `Math.ceil` 不引入任何误差。任何非 2 的幂的系数都会让「双存 + 装载期断言」变成一句空话,
 * 改用别的系数时必须连同这条一起重新论证。
 */
export const SPAWN_TICKS_COEFFICIENT = 0.5;

/**
 * 满产烧钱率(资源/tick):四条产线同时开工时,资源净消耗的上界。
 *
 * 与 α 同族——同为派生式的一部分,故同为真源包的常量(handoff §1 的派生规则:
 * 「满产烧钱率统一 2/tick」)。它同样**不是键**:规则集里没有那一格,因为它是由
 * 「四条线都造得出来」这个事实推出来的量,填一个数进去只会多一个能填错的格子。
 */
export const FULL_PRODUCTION_COST_RATE = 2;

/**
 * 内存软阈系数:软阈 = `MEMORY_SOFT_THRESHOLD_RATIO × memoryTickCeiling`(hld §5.3 的 0.8)。
 *
 * **内存软阈本身不是键**(handoff §2.1 明写「推导项,入表不入 schema」),理由与派生量通用:
 * 落进取值文件只会多一个能填错的格子,而它与 `memoryTickCeiling` 不一致时没有第二个数会对。
 * 消费方(报告披露 `memory-pressure`、规则文档的数值表)自己乘这个系数即可。
 */
export const MEMORY_SOFT_THRESHOLD_RATIO = 0.8;

/**
 * 键清单的键序。它同时是 `required` 的顺序、`rulesets/vN.json` 的书写序,
 * 以及生成物 `docs/rules-vN` 数值表的行序——**行序不该另定一处**。
 *
 * `Object.keys` 的返回类型是 `string[]`,这里的一次断言由三样东西盯着:紧邻它的类型级断言
 * `RulesetCatalogKeysMatchType`(schema 包)与 `RulesetSchemaRequiredKeysMatchType`(CLI 包),
 * 以及 `ruleset.test.ts` 里把 `required` 与本数组逐项比对的运行期断言。
 */
export const RULESET_KEYS: readonly RulesetKey[] = Object.keys(RULESET_KEY_CATALOG) as RulesetKey[];

/**
 * 四条兵种线的键,**取自键清单里 `valueType === "unit-stats"` 的那几条**而不是另写一份。
 * 派生量断言要遍历它们(每条线各断言一次「双存是否自洽」),而手写的名单会与键清单分叉。
 */
export const RULESET_UNIT_KEYS: readonly RulesetKey[] = RULESET_KEYS.filter(
  (key) => RULESET_KEY_CATALOG[key].valueType === "unit-stats",
);

/** 键清单的条目 → JSON Schema 的 `properties`。一次投影,两处不可能错位。 */
const propertiesOf = (): { readonly [key: string]: unknown } =>
  Object.fromEntries(RULESET_KEYS.map((key) => [key, RULESET_KEY_CATALOG[key].schema]));

/**
 * 规则集的 JSON Schema(hld §2.2.5:形状定义归真源包所有)。
 *
 * 与 `MAP_JSON_SCHEMA` 同纪律的两条:
 * - `additionalProperties: false` 一律关掉。理由与地图那边一样:不关掉的话,手写 schema
 *   只是一份注释,而且会让「拼错键名」这种最常见的笔误静默通过(键名拼错 → 少一个必填键,
 *   所以真源侧的 `required` 兜住了它;而 `tickLimitX` 这种多出来的键只会白过)。
 * - 形状之外一概不管:派生量自洽(`spawnTicks` 与系数)、版本三处一致,都是**跨字段**判断,
 *   draft-07 表达不了,归 `apps/cli` 在装载期判。
 */
export const RULESET_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "model-war 规则集",
  description:
    "一份对局的全部规则参数(hld §7.1)。21 个键全部必填;其中 8 个预算键(键清单里标为「未定值」的)" +
    "在 M1 阶段取 0," +
    "语义是**未定值**而非零预算,面向模型的规则文档据此渲染成「未定」。派生量自洽与版本三处一致" +
    "由 apps/cli 在装载期判,本 schema 只管单份 JSON 的形状。",
  type: "object",
  additionalProperties: false,
  required: RULESET_KEYS,
  properties: propertiesOf(),
} as const;
