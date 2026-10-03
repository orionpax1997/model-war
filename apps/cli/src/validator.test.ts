/**
 * 校验器的自测——spec《Testing Decisions》的**副缝**:断言对象是「一段 JSON 值 → 接受 / 带诊断拒绝」,
 * 这是一个纯函数,不碰文件系统、不碰 CLI 退出码。`map-lint` 的地图校验断言也落在这里,
 * 不去测子命令的退出码。
 *
 * 本文件属于 `unit` project,因而混在全量门禁 `check` 里(它就是普通单测);
 * 它**刻意不进** `gates` project——那道工程会 spawn `check`,而 `check` 里含 `vitest run`,
 * 混进去就是 `check → 本文件 → check` 的套娃(vitest.config.ts 的 GATES_TEST 常量)。
 *
 * 每条用例都配了**现做现验的反例**:从一份被接受的合法数据出发,加一个字段 / 删一个字段 /
 * 改一个类型,确认判决跟着内容走。坏了的反例比没有反例更坏。
 *
 * 本文件断言两类数据(地图 / 规则集),它们走**同一个校验器**:同一个 Ajv 实例、同一套
 * 「同类合并」渲染、同一种改指。断言风格也共用一份(`bad()` / `reject()` 两种改坏手法)。
 */

import {
  MAP_JSON_SCHEMA,
  RULESET_JSON_SCHEMA,
  RULESET_KEYS,
  RULESET_VERSION,
} from "@model-war/schema";
import type {
  JsonValue,
  MapDefinition,
  MapVariantSlot,
  Ruleset,
  UnitStats,
} from "@model-war/schema";
import { expect, it } from "vitest";

import {
  DERIVED_SPAWN_TICKS_KEYWORD,
  RULESET_TOO_NEW_KEYWORD,
  RULESET_VERSION_MISMATCH_KEYWORD,
  UNKNOWN_RULESET_VERSION_KEYWORD,
  validateMap,
  validateRuleset,
} from "./validator.js";

// ── Q4:类型是上游,JSON Schema 手工对齐——漂移由断言兜住,不是靠自觉 ────────────

type RequiredKeysOf<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];
type SchemaRequiredKeys = (typeof MAP_JSON_SCHEMA)["required"][number];
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/**
 * 类型级断言:JSON Schema 的**必填键集合**等于 TS 类型的**键联合**。
 * 两边各加一个字段而只改一边时,`tsc -b` 非零退出——而这条断言正是本仓库唯一
 * 能抓住那种漂移的东西(spec 用户故事 4)。运行期那半在下面「键集合」那条用例里。
 */
export type MapSchemaRequiredKeysMatchType = Assert<
  Equals<SchemaRequiredKeys, RequiredKeysOf<MapDefinition>>
>;

/**
 * 同源断言(收紧后的那一半):`MapVariantSlot` 的**定长**与 JSON Schema 侧那条轨道的
 * `minItems` / `maxItems` 写的是同一个数。
 *
 * **为什么这条断言对定长形状尤其要紧**:上面那条(必填键集合)抓的是「加了一个键」,
 * 而收紧变体槽位这类改动是**改一个数字**——类型改成 3 元组而 schema 仍写 4,或反过来,
 * 两侧都不会自己报错,只有运行时拿着一份 3 格轨道去撞 `minItems` 才炸。数字漂移必须由类型级断言兜住,
 * 因为它是这条「类型是上游、schema 手工对齐」路线上唯一能提前抓到它的东西。
 */
type And<A extends boolean, B extends boolean> = A extends true
  ? B extends true
    ? true
    : false
  : false;
type SlotSchemaMin = (typeof MAP_JSON_SCHEMA)["properties"]["variantSlots"]["items"]["minItems"];
type SlotSchemaMax = (typeof MAP_JSON_SCHEMA)["properties"]["variantSlots"]["items"]["maxItems"];
export type MapVariantSlotArityMatchesSchema = Assert<
  And<
    Equals<MapVariantSlot["length"], SlotSchemaMin>,
    Equals<MapVariantSlot["length"], SlotSchemaMax>
  >
>;

/** 规则集那一份:同一个断言,另一组键。规则集的 `required` 由键清单投影而来,不是手写数组。 */
type RulesetSchemaRequiredKeys = (typeof RULESET_JSON_SCHEMA)["required"][number];
export type RulesetSchemaRequiredKeysMatchType = Assert<
  Equals<RulesetSchemaRequiredKeys, RequiredKeysOf<Ruleset>>
>;

// ── fixture:同一组数据既当编译期样本,又当运行期样本 ──────────────────────────

/** 最简的合法地图:四行地形、一个主基地、一个中立资源点、一名初始农民。 */
const MINIMAL: MapDefinition = {
  name: "open-clash",
  size: 4,
  rulesetMin: "v1",
  terrain: ["....", "....", "....", "...."],
  sites: [
    { id: 0, kind: "base", x: 1, y: 1, initialOwner: 0 },
    { id: 1, kind: "resource", x: 2, y: 2, initialOwner: null },
  ],
  spawnUnits: [{ owner: 0, type: "worker", offset: [0, 0] }],
  variantSlots: [],
};

/**
 * 变体槽位取**定稿形态**:一个元素就是一条完整四重轨道的 4 个坐标对。
 * 这条 fixture 是「收紧生效」的正面样本——改松它(元素不足 4、不是坐标对、坐标为负)当场红。
 */
const TIGHT_SLOTS: MapDefinition = {
  ...MINIMAL,
  name: "tight-slots",
  variantSlots: [
    [
      [1, 0],
      [0, 1],
      [3, 3],
      [2, 0],
    ],
    [
      [0, 0],
      [3, 0],
      [3, 3],
      [0, 3],
    ],
  ],
};

/** 四方对称的地图,用来证明「对称」不是形状问题(那条归 map-lint)。 */
const SYMMETRIC: MapDefinition = {
  name: "quad",
  size: 4,
  rulesetMin: "v1",
  terrain: [".##.", "....", "....", ".##."],
  sites: [
    { id: 0, kind: "base", x: 1, y: 1, initialOwner: 0 },
    { id: 1, kind: "base", x: 2, y: 1, initialOwner: 1 },
    { id: 2, kind: "base", x: 1, y: 2, initialOwner: 2 },
    { id: 3, kind: "base", x: 2, y: 2, initialOwner: 3 },
  ],
  spawnUnits: [
    { owner: 0, type: "worker", offset: [0, 0] },
    { owner: 1, type: "worker", offset: [1, 0] },
  ],
  variantSlots: [
    [
      [0, 0],
      [3, 0],
      [3, 3],
      [0, 3],
    ],
  ],
};

const FIXTURES: readonly MapDefinition[] = [MINIMAL, TIGHT_SLOTS, SYMMETRIC];

/**
 * 坏数据一律由合法 fixture 改出来,不另立一套看不懂的样本。
 * `patch` 换值,`drop` 删键——两个改法能叠着用,于是「同时缺键又错型」只需要一行。
 */
const bad = (
  base: MapDefinition,
  patch: Record<string, JsonValue> = {},
  drop: readonly string[] = [],
): JsonValue =>
  Object.fromEntries(Object.entries({ ...base, ...patch }).filter(([key]) => !drop.includes(key)));

const reject = (value: JsonValue) => {
  const result = validateMap(value);
  if (result.ok) {
    throw new Error(`本该被拒绝,却被接受了:${JSON.stringify(value)}`);
  }
  return result;
};

const keywordsOf = (result: ReturnType<typeof reject>): readonly string[] =>
  result.machineDiagnostics.map((diagnostic) => diagnostic.keyword);

const pointersOf = (result: ReturnType<typeof reject>): readonly string[] =>
  result.machineDiagnostics.map((diagnostic) => diagnostic.pointer);

// 本文件按 dist 里的工作区包跑(import `@model-war/schema` 发生在模块加载时刻,
// 补构建只能是 vitest.global-setup.ts 的活,不是 beforeAll 的活)。

// ── 一致性(Q4 的第一半:同一组 fixture 两侧都过) ─────────────────────────────

it("同一组 fixture 既过 TypeScript 类型(编译期)又过 ajv(运行期)", () => {
  // 编译期那半由上面的 `: MapDefinition` 标注承担:形状漂了 `tsc -b` 就红。
  for (const fixture of FIXTURES) {
    expect(validateMap(fixture).ok, `${fixture.name} 应当被接受`).toBe(true);
  }
});

it("schema 的必填键集合就是七个字段,且与 properties 一一对应", () => {
  // 类型级那一半在 `MapSchemaRequiredKeysMatchType`(tsc 把关);这里把两处都落到运行期,
  // 免得「必填表与属性表对不上」这种事要靠人去读。
  const required = [...MAP_JSON_SCHEMA.required];
  expect(required).toEqual([
    "name",
    "size",
    "rulesetMin",
    "terrain",
    "sites",
    "spawnUnits",
    "variantSlots",
  ]);
  expect([...required].sort()).toEqual(Object.keys(MAP_JSON_SCHEMA.properties).sort());
});

it("合法地图被接受,并把原值交出来(不重写、不裁剪)", () => {
  const result = validateMap(SYMMETRIC);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.map).toEqual(SYMMETRIC);
  }
});

it("变体槽位取定稿形态时通过(一个元素 = 一条完整四重轨道的 4 个坐标对)", () => {
  expect(validateMap(TIGHT_SLOTS).ok).toBe(true);
});

it("变体槽位的定长在 schema 与类型之间是同一个数(同源断言的运行期那一半)", () => {
  // 编译期那半是上面的 `MapVariantSlotArityMatchesSchema`;这里把两处都落到运行期,
  // 免得「类型说 4、schema 说别的」这种事要靠人去读两侧。
  const slot = MAP_JSON_SCHEMA.properties.variantSlots.items;
  expect(slot.minItems).toBe(4);
  expect(slot.maxItems).toBe(4);
  // 坐标对那一层也是定长 2:「一个坐标」不是本 schema 认识的东西。
  const coord = slot.items;
  expect(coord.type).toBe("array");
  if (coord.type === "array") {
    expect(coord.minItems).toBe(2);
    expect(coord.maxItems).toBe(2);
  }
});

it("变体槽位被收紧后,松形态逐条被拒(收紧生效的直接证据)", () => {
  // 手法:把 MINIMAL 的 variantSlots 换成一条由坏元素构成的清单,一层层往里坏:
  // 元素不是数组 → 轨道长度不对 → 坐标对长度不对 → 坐标本身不对。
  const one = (slot: JsonValue): readonly [JsonValue] => [slot];
  const keywordsOfSlot = (slot: JsonValue): readonly string[] =>
    keywordsOf(reject(bad(MINIMAL, { variantSlots: one(slot) })));

  // 元素不是一个数组——这正是收紧前被放行的形态(对象 / 字符串 / 数字 / null)。
  for (const loose of [{}, "任意字符串", 42, null] as const) {
    expect(keywordsOfSlot(loose)).toContain("type");
  }

  // 轨道不足 4 格 / 超过 4 格:定长 4 元组在 JSON Schema 侧就是 minItems + maxItems。
  expect(keywordsOfSlot([])).toContain("minItems");
  expect(
    keywordsOfSlot([
      [1, 0],
      [0, 1],
      [3, 3],
    ]),
  ).toContain("minItems");
  expect(
    keywordsOfSlot([
      [1, 0],
      [0, 1],
      [3, 3],
      [2, 0],
      [1, 1],
    ]),
  ).toContain("maxItems");
  // 曾经被放行的「8 个数字摊平」形态:长度超了,而且每一项都不是坐标对。
  expect(keywordsOfSlot([1, 0, 0, 1, 3, 3, 2, 0])).toContain("maxItems");

  // 坐标对长度不对:轨道仍是 4 格,但其中一格不是坐标对(缺项 → minItems、多项 → maxItems)。
  expect(keywordsOfSlot([[1, 0], [0, 1], [3, 3], [2]])).toContain("minItems");
  expect(
    keywordsOfSlot([
      [1, 0],
      [0, 1],
      [3, 3],
      [2, 0, 9],
    ]),
  ).toContain("maxItems");

  // 坐标本身不对:负坐标越出网格下界(`>= size` 归 map-lint,`>= 0` 归本 schema);
  // 非整数坐标不是网格格。
  expect(
    keywordsOfSlot([
      [1, 0],
      [0, 1],
      [3, 3],
      [-2, 0],
    ]),
  ).toContain("minimum");
  expect(
    keywordsOfSlot([
      [1, 0],
      [0, 1],
      [3, 3],
      [2.5, 0],
    ]),
  ).toContain("type");
  expect(
    keywordsOfSlot([
      [1, 0],
      [0, 1],
      [3, 3],
      ["2", 0],
    ]),
  ).toContain("type");
});

// ── 拒绝:每一类坏数据各一条,每条都从合法数据改出来 ───────────────────────────

it("缺键被拒", () => {
  const result = reject(bad(MINIMAL, {}, ["sites", "terrain"]));
  expect(new Set(keywordsOf(result))).toContain("required");
  expect([...pointersOf(result)].sort()).toEqual(["/sites", "/terrain"]);
});

it("错型被拒", () => {
  expect(keywordsOf(reject(bad(MINIMAL, { size: "4" })))).toContain("type");
  expect(keywordsOf(reject(bad(MINIMAL, { size: 4.5 })))).toContain("type");
  expect(keywordsOf(reject(bad(MINIMAL, { name: "" })))).toContain("minLength");
  expect(keywordsOf(reject(bad(MINIMAL, { terrain: ["..", "x#", "..", ".."] })))).toContain(
    "pattern",
  );
  expect(keywordsOf(reject(bad(MINIMAL, { terrain: [] })))).toContain("minItems");
});

it("点位与初始单位的内部形状被拒:错 kind、initialOwner 错型、offset 长度不对", () => {
  expect(
    keywordsOf(
      reject(bad(MINIMAL, { sites: [{ id: 0, kind: "tower", x: 1, y: 1, initialOwner: 0 }] })),
    ),
  ).toContain("enum");

  expect(
    keywordsOf(
      reject(bad(MINIMAL, { sites: [{ id: 0, kind: "base", x: 1, y: 1, initialOwner: "无主" }] })),
    ),
  ).toContain("type");

  expect(
    keywordsOf(
      reject(bad(MINIMAL, { spawnUnits: [{ owner: 0, type: "worker", offset: [0, 0, 0] }] })),
    ),
  ).toContain("maxItems");
});

it("多一个字段即被拒(额外属性禁令的反例,顶层与嵌套各一次)", () => {
  // 反例的形状:先确认这份数据本是被接受的,再加一个字段——判决必须跟着内容走。
  expect(validateMap(MINIMAL).ok).toBe(true);
  expect(pointersOf(reject(bad(MINIMAL, { progress: { 0: 0.5 } })))).toEqual(["/progress"]);

  // `progress` 尤其要拒干净:它是**对局运行时状态**,不是地图数据(hld §7.2 的七字段里没有它)。
  // 写进地图文件说明有人把两样东西混成了一样,而真源包不拥有它、引擎也没说要它。
  expect(
    pointersOf(
      reject(
        bad(MINIMAL, {
          sites: [{ id: 0, kind: "base", x: 1, y: 1, initialOwner: 0, progress: 3 }],
        }),
      ),
    ),
  ).toEqual(["/sites/0/progress"]);
});

it("规则版本错配在装载期被拒,不静默降级", () => {
  // 与真源包导出的常量一致的那一个必须被接受——判据挂在常量上,不是写死字符串。
  expect(validateMap(bad(MINIMAL, { rulesetMin: RULESET_VERSION })).ok).toBe(true);

  const tooNew = reject(bad(MINIMAL, { rulesetMin: "v2" }));
  expect(keywordsOf(tooNew)).toEqual([RULESET_TOO_NEW_KEYWORD]);
  expect(tooNew.machineDiagnostics[0]?.pointer).toBe("/rulesetMin");

  // 未发布过的版本号不是「低于下界」,是压根不存在:两种错法给模型的建议不同,分开报。
  expect(keywordsOf(reject(bad(MINIMAL, { rulesetMin: "v0" })))).toEqual([
    UNKNOWN_RULESET_VERSION_KEYWORD,
  ]);

  // 压根不是版本号的由 ajv 判(形状),不混进装载期那一类(版本比较)。
  expect(keywordsOf(reject(bad(MINIMAL, { rulesetMin: "latest" })))).toEqual(["pattern"]);
});

it("根不是对象时被拒,诊断指向根", () => {
  for (const value of ["open-clash", 4, null, [], [1, 2]] as const) {
    const result = reject(value);
    expect(pointersOf(result)).toEqual(["/"]);
    expect(keywordsOf(result)).toEqual(["type"]);
  }
});

// ── 两层诊断 ─────────────────────────────────────────────────────────────────

it("机器层透出路径 / 关键字 / 消息三样,一条不少", () => {
  const result = reject(bad(MINIMAL, { size: "4", name: 1 }));
  expect(result.machineDiagnostics.length).toBeGreaterThanOrEqual(2);
  for (const diagnostic of result.machineDiagnostics) {
    expect(diagnostic.pointer.startsWith("/")).toBe(true);
    expect(diagnostic.keyword).not.toBe("");
    expect(diagnostic.message).not.toBe("");
  }
});

it("面向模型层是含 JSON 指针的短句", () => {
  expect(reject(bad(MINIMAL, { size: "4" })).modelDiagnostics).toEqual(["值的类型不对:/size"]);
});

it("面向模型层对同类错误合并成一行(逐行列出就会吃光五轮迭代预算)", () => {
  const result = reject(bad(MINIMAL, {}, ["name", "sites", "spawnUnits"]));

  // 机器层仍是三条:合并只发生在面向模型层,排障信息不许被压掉。
  expect(keywordsOf(result)).toEqual(["required", "required", "required"]);
  expect(result.modelDiagnostics).toHaveLength(1);
  const [line] = result.modelDiagnostics;
  expect(line).toContain("/name");
  expect(line).toContain("/sites");
  expect(line).toContain("/spawnUnits");
});

it("不同类的错误不合并,各占一行", () => {
  const result = reject(bad(MINIMAL, { size: "4", progress: 1 }, ["sites"]));
  expect(result.machineDiagnostics).toHaveLength(3);
  // 按集合比而不是按顺序比:行序跟着 ajv 的报错序走,那不是本文件的断言对象。
  expect([...result.modelDiagnostics].sort()).toEqual(
    ["缺少必填字段:/sites", "出现了未声明的字段:/progress", "值的类型不对:/size"].sort(),
  );
});

it("同一份坏数据两次校验给出同一份诊断(诊断本身必须稳定)", () => {
  const broken = bad(MINIMAL, { size: "4", progress: 1 }, ["sites"]);
  expect(reject(broken)).toEqual(reject(broken));
});

// ══ 规则集(hld §7.1)══════════════════════════════════════════════════════════
//
// 走的是**同一条缝、同一个校验器**:上面那份地图与下面这份规则集共用一个 Ajv 实例、
// 同一个 `pointerOf` 改指、同一份措辞表、同一种「同类合并」。这里不新立一套断言风格。
//
// 键数说明:21 个键 = 13 定稿 + 8 预算。spec 与 DAG 写的「22 = 13 + 9」把派生的
// 「内存软阈」当预算键数了一遍(handoff §2.1 该行明写「入表不入 schema」,hld §5.3 的
// 上限取值恰好 8 项)。数目的来历写在 `packages/schema/src/ruleset-keys.ts` 的头注里。

const GOOD_PROVENANCE = {
  rulesetFileName: `${RULESET_VERSION}.json`,
  rulesDocDirName: `rules-${RULESET_VERSION}`,
} as const;

const unit = (
  cost: number,
  hp: number,
  damage: number,
  range: number,
  speed: number,
): UnitStats => ({
  cost,
  hp,
  damage,
  range,
  speed,
  // 这里**现算**生产耗时而不是抄交接单:本 fixture 同时是「取值文件里有这个数」的反例,
  // 抄一遍的话,系数与取值同时错位的那一次就会被 fixture 自己抹平(而且抹得看不见)。
  spawnTicks: Math.ceil(cost * 0.5),
});

/**
 * 一份完整的合法规则集:13 个定稿键取 handoff §1 的定稿值,8 个预算键取未定值 `0`。
 *
 * 它能通过**三道**判据(形状 / 版本 / 派生量自洽)才叫合法——尤其四条兵种线的
 * `spawnTicks` 会被装载期逐条对一遍派生式,所以这份 fixture 本身就是派生量的反例:
 * 把任一条的 `spawnTicks` 改一个数,「合法规则集被接受」这条当场红。
 */
const V1: Ruleset = {
  tickLimit: 600,
  captureTicks: 10,
  initialResources: 16,
  harvestRate: 1,
  carryLimit: 20,
  resourcePerSite: 200,
  worker: unit(4, 2, 0, 1, 1),
  melee: unit(8, 12, 3, 1, 1),
  ranged: unit(12, 4, 2, 2, 1),
  cavalry: unit(16, 6, 2, 1, 2),
  baseScore: 4,
  resourceScore: 1,
  unitCostDivisor: 6,
  exceptionTickLimit: 0,
  eventTickLimit: 0,
  apiCallTickLimit: 0,
  memoryLimit: 0,
  memoryTickCeiling: 0,
  wallClockSoftLimit: 0,
  wallClockHardTimeout: 0,
  scriptSizeLimit: 0,
};

/** 预算终值标定后(K 节点)的那一形态:8 个预算键取正数,其余不变。 */
const K_CALIBRATED: Ruleset = {
  ...V1,
  exceptionTickLimit: 40,
  eventTickLimit: 200_000,
  apiCallTickLimit: 5_000,
  memoryLimit: 67_108_864,
  memoryTickCeiling: 8_388_608,
  wallClockSoftLimit: 5,
  wallClockHardTimeout: 30_000,
  scriptSizeLimit: 262_144,
};

/** 坏数据一律由合法 fixture 改出来,与地图那边同一手法(`patch` 换值 / `drop` 删键)。 */
const badRuleset = (
  base: Ruleset,
  patch: Record<string, JsonValue> = {},
  drop: readonly string[] = [],
): JsonValue =>
  Object.fromEntries(Object.entries({ ...base, ...patch }).filter(([key]) => !drop.includes(key)));

/** 从一个对象里删掉一个键(嵌套层的改坏手法;顶层有 `drop`,这里补上嵌套那一半)。 */
const omitField = (value: object, dropped: string): Record<string, JsonValue> =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== dropped));

const rejectRuleset = (
  value: JsonValue,
  provenance: { rulesetFileName: string; rulesDocDirName: string } = GOOD_PROVENANCE,
) => {
  const result = validateRuleset(value, provenance);
  if (result.ok) {
    throw new Error(`本该被拒绝,却被接受了:${JSON.stringify(value)}`);
  }
  return result;
};

const rulesetKeywords = (result: ReturnType<typeof rejectRuleset>): readonly string[] =>
  result.machineDiagnostics.map((diagnostic) => diagnostic.keyword);

const rulesetPointers = (result: ReturnType<typeof rejectRuleset>): readonly string[] =>
  result.machineDiagnostics.map((diagnostic) => diagnostic.pointer);

// ── 一致性(Q4:同一组 fixture 两侧都过 + 必填键集合 === 键联合)─────────────────

it("规则集:同一组 fixture 既过 TypeScript 类型(编译期)又过 ajv(运行期)", () => {
  // 编译期那半由上面的 `: Ruleset` 标注与类型级断言承担;运行期这半在这里。
  for (const fixture of [V1, K_CALIBRATED] as const) {
    expect(validateRuleset(fixture, GOOD_PROVENANCE).ok).toBe(true);
  }
});

it("规则集 schema 的必填键集合就是 21 个键,且与 properties 一一对应", () => {
  const required = [...RULESET_JSON_SCHEMA.required];
  expect(required).toHaveLength(21);
  expect([...required].sort()).toEqual(Object.keys(RULESET_JSON_SCHEMA.properties).sort());
  // 与 `RULESET_KEYS` 逐项同序:键序同时是取值文件的书写序与生成文档的行序,不容另定。
  expect(required).toEqual([...RULESET_KEYS]);
});

it("完整的合法规则集被接受,并把原值交出来(不重写、不裁剪)", () => {
  const result = validateRuleset(V1, GOOD_PROVENANCE);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.ruleset).toEqual(V1);
  }
});

// ── 缺键 ≠ 未定值:两种不同的错误,各自被拒 ──────────────────────────────────

it("预算键取未定值 0 被接受(它是合法取值,不是缺键)", () => {
  expect(V1.exceptionTickLimit).toBe(0);
  expect(validateRuleset(V1, GOOD_PROVENANCE).ok).toBe(true);
});

it("缺预算键被拒,且与「键存在但取 0」是两种不同的错误", () => {
  // 反例的形状:同一批键,一个取 0(过),一个删掉(拒)。
  expect(validateRuleset(V1, GOOD_PROVENANCE).ok).toBe(true);

  const result = rejectRuleset(
    badRuleset(V1, {}, ["exceptionTickLimit", "memoryTickCeiling", "scriptSizeLimit"]),
  );
  expect(new Set(rulesetKeywords(result))).toContain("required");
  expect([...rulesetPointers(result)].sort()).toEqual([
    "/exceptionTickLimit",
    "/memoryTickCeiling",
    "/scriptSizeLimit",
  ]);
  // 合并仍然生效:三个缺键对模型是**一行**,不是三行。
  expect(result.modelDiagnostics).toHaveLength(1);
});

it("预算终值取正数也合法(键清单的未定是文档口径,不是把取值钉死在 0)", () => {
  expect(validateRuleset(K_CALIBRATED, GOOD_PROVENANCE).ok).toBe(true);
  // 反例:若某个预算键被写成 `const: 0` 或 `enum: [0]`,上一条会红;下界若被写成 1,
  // 占位值 0 就填不进去了——M1 阶段连跑都跑不起来。
  expect(rulesetKeywords(rejectRuleset(badRuleset(V1, { memoryLimit: -1 })))).toContain("minimum");
});

// ── 五种坏数据:缺键 / 错型 / 额外键 / 版本错配 / 派生量不自洽 ────────────────

it("错型被拒(顶层与兵种对象的子字段各一次)", () => {
  expect(rulesetKeywords(rejectRuleset(badRuleset(V1, { tickLimit: "600" })))).toContain("type");
  expect(rulesetKeywords(rejectRuleset(badRuleset(V1, { tickLimit: 600.5 })))).toContain("type");

  const result = rejectRuleset(badRuleset(V1, { melee: { ...V1.melee, hp: "12" } }));
  expect(rulesetKeywords(result)).toContain("type");
  expect(rulesetPointers(result)).toEqual(["/melee/hp"]);

  // 子字段缺一个也是缺键:兵种对象同样是必填齐全的对象。
  expect(
    rulesetKeywords(rejectRuleset(badRuleset(V1, { ranged: omitField(V1.ranged, "speed") }))),
  ).toContain("required");
});

it("多一个字段即被拒(额外属性禁令的反例,顶层与兵种对象内各一次)", () => {
  expect(validateRuleset(V1, GOOD_PROVENANCE).ok).toBe(true);
  expect(rulesetPointers(rejectRuleset(badRuleset(V1, { spawnTicksCoefficient: 0.5 })))).toEqual([
    "/spawnTicksCoefficient",
  ]);

  // `spawnTicksCoefficient` 尤其要拒干净:系数是**真源包的常量**,不是取值文件里的格子。
  // 放进去意味着有人打算让它可标定,而派生式只认代码里那一个。
  expect(
    rulesetPointers(rejectRuleset(badRuleset(V1, { worker: { ...V1.worker, sight: 5 } }))),
  ).toEqual(["/worker/sight"]);
});

it("规则版本错配在装载期被拒,不静默降级(文件名与规则文档目录名都要对)", () => {
  // 与真源包的版本常量一致的那一组必须被接受——判据挂在常量上,不是写死字符串。
  expect(validateRuleset(V1, GOOD_PROVENANCE).ok).toBe(true);

  const both = rejectRuleset(V1, { rulesetFileName: "v2.json", rulesDocDirName: "rules-v2" });
  expect(rulesetKeywords(both)).toEqual([RULESET_VERSION_MISMATCH_KEYWORD]);
  expect(both.machineDiagnostics[0]?.pointer).toBe("/");

  // 只错一处同样拒:「三处一致」不是三选二。
  expect(
    rulesetKeywords(rejectRuleset(V1, { rulesetFileName: "v1.json", rulesDocDirName: "rules-v2" })),
  ).toEqual([RULESET_VERSION_MISMATCH_KEYWORD]);
  expect(
    rulesetKeywords(rejectRuleset(V1, { rulesetFileName: "v2.json", rulesDocDirName: "rules-v1" })),
  ).toEqual([RULESET_VERSION_MISMATCH_KEYWORD]);
});

it("派生量不自洽被拒:取值文件写的生产耗时必须等于 ⌈cost × 系数⌉", () => {
  // 合法基线(本断言自己就是它的反例:合法数据先过一次)。
  expect(validateRuleset(V1, GOOD_PROVENANCE).ok).toBe(true);

  const result = rejectRuleset(
    badRuleset(V1, {
      worker: { ...V1.worker, spawnTicks: 3 },
      cavalry: { ...V1.cavalry, spawnTicks: 9 },
    }),
  );
  expect(rulesetKeywords(result)).toEqual([
    DERIVED_SPAWN_TICKS_KEYWORD,
    DERIVED_SPAWN_TICKS_KEYWORD,
  ]);
  expect([...rulesetPointers(result)].sort()).toEqual([
    "/cavalry/spawnTicks",
    "/worker/spawnTicks",
  ]);

  // 两条派生量错误对模型是**一行**:它们是同一件事(兵种表自相矛盾)。
  expect(result.modelDiagnostics).toHaveLength(1);
  expect(result.modelDiagnostics[0]).toContain("/worker/spawnTicks");
  expect(result.modelDiagnostics[0]).toContain("/cavalry/spawnTicks");
});

it("派生量断言只在形状过了之后才跑(错型数据报的是形状错,不是派生量错)", () => {
  const result = rejectRuleset(badRuleset(V1, { melee: { ...V1.melee, cost: "8" } }));
  expect(rulesetKeywords(result)).toContain("type");
  expect(rulesetKeywords(result)).not.toContain(DERIVED_SPAWN_TICKS_KEYWORD);
});

it("根不是对象时被拒,诊断指向根", () => {
  for (const value of ["v1", 600, null, [], [1, 2]] as const) {
    const result = rejectRuleset(value);
    expect(rulesetPointers(result)).toEqual(["/"]);
    expect(rulesetKeywords(result)).toEqual(["type"]);
  }
});

it("规则集的两层诊断形状与地图一致(同一个渲染器)", () => {
  const result = rejectRuleset(badRuleset(V1, { tickLimit: "600" }, ["memoryLimit"]));
  for (const diagnostic of result.machineDiagnostics) {
    expect(diagnostic.pointer.startsWith("/")).toBe(true);
    expect(diagnostic.keyword).not.toBe("");
    expect(diagnostic.message).not.toBe("");
  }
  expect([...result.modelDiagnostics].sort()).toEqual(
    ["缺少必填字段:/memoryLimit", "值的类型不对:/tickLimit"].sort(),
  );
});

it("同一份坏规则集两次校验给出同一份诊断(诊断本身必须稳定)", () => {
  const broken = badRuleset(V1, { tickLimit: "600", scriptSizeLimit: -1 }, ["memoryLimit"]);
  expect(rejectRuleset(broken)).toEqual(rejectRuleset(broken));
});
