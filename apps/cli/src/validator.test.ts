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
 * 本文件断言四类数据(地图 / 规则集 / 冻结脚本存档 meta / 对局输入 input.json),它们走
 * **同一个校验器**:同一个 Ajv 实例、同一套「同类合并」渲染、同一种改指、同一个版本三处一致
 * 判据。断言风格也共用一份(`bad*()` 改坏 / `reject*()` 收下拒绝两种手法)。
 */

import {
  ARCHIVE_META_JSON_SCHEMA,
  MAP_JSON_SCHEMA,
  MATCH_INPUT_JSON_SCHEMA,
  OBSERVATION_LINE_JSON_SCHEMA,
  REPLAY_RESULT_LINE_JSON_SCHEMA,
  RULESET_JSON_SCHEMA,
  RULESET_KEYS,
  RULESET_VERSION,
} from "@model-war/schema";
import type {
  ArchiveMeta,
  JsonValue,
  MapDefinition,
  MapVariantSlot,
  MatchInput,
  MatchInputArchive,
  ObservationLine,
  ObservationLineKind,
  ReplayOutcomeReason,
  ReplayResultLine,
  Ruleset,
  UnitStats,
} from "@model-war/schema";
import { expect, it } from "vitest";

import {
  ARCHIVE_FILES_INCOMPLETE_KEYWORD,
  ARCHIVE_PROTOCOL_ROUNDS_KEYWORD,
  DERIVED_SPAWN_TICKS_KEYWORD,
  RULESET_TOO_NEW_KEYWORD,
  RULESET_VERSION_MISMATCH_KEYWORD,
  SHA256_MISMATCH_KEYWORD,
  UNKNOWN_RULESET_VERSION_KEYWORD,
  validateArchiveMeta,
  validateMap,
  validateMatchInput,
  validateObservationLine,
  validateReplayResultLine,
  validateRuleset,
  type ArchiveMetaProvenance,
  type MatchInputProvenance,
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

// ══ 冻结脚本存档 meta(hld §7.4)与对局输入 input.json(hld §7.4 末条)════════════
//
// 走的是**同一条缝、同一个校验器**:上面四份共用一个 Ajv 实例、同一份措辞表、同一种
// 「同类合并」。这两份的判据分工也与前两份同一条原则——形状归 ajv,跨字段的归装载期断言。
//
// **反例逐类齐全**:改哈希 → 红、删必填项 → 红、改版本号 → 红、多一个未声明字段 → 红
// (顶层与嵌套各一次)、缺档 → 红。十一项必填与五项必填是**逐项**过的,不是抽三项:
// 「半截字段也会让人以为形状已定」是本文件所在的那条纪律,抽查抓不住它。

// ── 类型级断言:schema 与 TS 类型必须一致,改一边必红 ──────────────────────────

type ArchiveMetaSchemaRequiredKeys = (typeof ARCHIVE_META_JSON_SCHEMA)["required"][number];
export type ArchiveMetaSchemaRequiredKeysMatchType = Assert<
  Equals<ArchiveMetaSchemaRequiredKeys, RequiredKeysOf<ArchiveMeta>>
>;

type MatchInputSchemaRequiredKeys = (typeof MATCH_INPUT_JSON_SCHEMA)["required"][number];
export type MatchInputSchemaRequiredKeysMatchType = Assert<
  Equals<MatchInputSchemaRequiredKeys, RequiredKeysOf<MatchInput>>
>;

/**
 * 座位数那条:类型是**定长 4 元组**,schema 侧是 `minItems` / `maxItems` 写 4。
 * 收紧成 3 或放宽成 6 时,两侧都不会自己报错,只有运行时拿着三份存档去撞 `minItems` 才炸。
 * 这条断言是那条路线上唯一能提前抓到数字漂移的东西(同 `MapVariantSlotArityMatchesSchema`)。
 */
type ArchivesSchemaMin = (typeof MATCH_INPUT_JSON_SCHEMA)["properties"]["archives"]["minItems"];
type ArchivesSchemaMax = (typeof MATCH_INPUT_JSON_SCHEMA)["properties"]["archives"]["maxItems"];
export type MatchInputSeatCountMatchesSchema = Assert<
  And<
    Equals<MatchInput["archives"]["length"], ArchivesSchemaMin>,
    Equals<MatchInput["archives"]["length"], ArchivesSchemaMax>
  >
>;

/**
 * 「要能赋给 `JsonValue`」那条纪律的机器形态:`JsonValue` 的对象那一支是索引签名,
 * 而**只有 type 别名拿得到隐式索引签名**(interface 拿不到)。所以下面两条不只是编译期
 * 的形式检查,它们是「有没有人把这个类型改回 interface」的唯一哨兵——改成 interface
 * 时它们立刻红,而不是等到某个跨进程的地方报一句「不能赋给 JsonValue」。
 */
type AssignableTo<A, B> = [A] extends [B] ? true : false;
export type ArchiveMetaIsJsonValue = Assert<AssignableTo<ArchiveMeta, JsonValue>>;
export type MatchInputIsJsonValue = Assert<AssignableTo<MatchInput, JsonValue>>;

// ── fixture ──────────────────────────────────────────────────────────────────

/** 拼一个合法的 sha256:小写十六进制 64 位。 */
const hash = (tag: string): string => tag.repeat(64);

/**
 * 十个**互不相同**的合法 sha256。每个座位各取不同的那一个,「哪一座位的哈希错了」才能被
 * 指针区分出来——四个座位共用同一个哈希时,只校验第一个座位的实现也能全过。
 */
const HASH = {
  script0: hash("a"),
  script1: hash("b"),
  script2: hash("c"),
  script3: hash("d"),
  meta0: hash("e"),
  meta1: hash("f"),
  meta2: hash("0"),
  meta3: hash("1"),
  map: hash("2"),
  /** 不属于任何一个座位的那个,专供「换一个值试试」的反例用。 */
  other: hash("3"),
} as const;

const SEAT_SCRIPT_HASHES = [HASH.script0, HASH.script1, HASH.script2, HASH.script3] as const;
const SEAT_META_HASHES = [HASH.meta0, HASH.meta1, HASH.meta2, HASH.meta3] as const;

/**
 * 座位号。收成字面量联合而不是 `number`:下标按 `number` 取会多出 `undefined`
 * (定长元组按变量取下标带未定义),而座位本来就只有 0..3 四个。
 */
type Seat = 0 | 1 | 2 | 3;

/** 座位号即数组下标。存档路径与哈希都带座位号,便于从诊断里读出是哪一座。 */
const seatOf = (seat: Seat): MatchInputArchive => ({
  archivePath: `archive/model-x/run-000${seat}`,
  scriptSha256: SEAT_SCRIPT_HASHES[seat],
  metaSha256: SEAT_META_HASHES[seat],
});

/** 一份完整的合法 meta。十一项全部有值,形状与四类装载期判据都能过。 */
const GOOD_META: ArchiveMeta = {
  model: "model-x",
  modelVersion: "snap-0001",
  generatedAt: "2026-10-01T00:00:00Z",
  // 与 prompts 的长度相等——这条双存由装载期断言判(反例就在下面那条用例里)。
  protocolRounds: 2,
  prompts: ["第一轮:协议与初版策略", "第二轮:按复算结果修正"],
  generationLog: ["tsc script.ts → script.js", "静态校验通过"],
  ruleset: RULESET_VERSION,
  validation: { passed: true, errors: [] },
  tscVersion: "7.0.2",
  scriptSha256: HASH.script0,
  sandboxRuntimeHash: HASH.other,
};

const GOOD_META_PROVENANCE: ArchiveMetaProvenance = {
  filesPresent: { scriptTs: true, scriptJs: true, metaJson: true },
  measuredScriptSha256: GOOD_META.scriptSha256,
  measuredSandboxRuntimeHash: GOOD_META.sandboxRuntimeHash,
  loadedRulesetVersion: RULESET_VERSION,
};

/** 一份完整的合法对局输入。五项齐,四个座位,哈希与实测一致。 */
const GOOD_INPUT: MatchInput = {
  archives: [seatOf(0), seatOf(1), seatOf(2), seatOf(3)],
  map: "open-clash",
  mapSha256: HASH.map,
  seed: 7,
  ruleset: RULESET_VERSION,
};

const measuredSeat = (seat: Seat) => ({
  scriptSha256: SEAT_SCRIPT_HASHES[seat],
  metaSha256: SEAT_META_HASHES[seat],
});

const GOOD_INPUT_PROVENANCE: MatchInputProvenance = {
  rulesetFileName: `${RULESET_VERSION}.json`,
  rulesDocDirName: `rules-${RULESET_VERSION}`,
  measuredArchives: [measuredSeat(0), measuredSeat(1), measuredSeat(2), measuredSeat(3)],
  measuredMapSha256: GOOD_INPUT.mapSha256,
};

/** 改坏数据的两种手法,与上面三份同一套(换值 / 删键)。 */
const badMeta = (
  base: ArchiveMeta,
  patch: Record<string, JsonValue> = {},
  drop: readonly string[] = [],
): JsonValue =>
  Object.fromEntries(Object.entries({ ...base, ...patch }).filter(([key]) => !drop.includes(key)));

const badInput = (
  base: MatchInput,
  patch: Record<string, JsonValue> = {},
  drop: readonly string[] = [],
): JsonValue =>
  Object.fromEntries(Object.entries({ ...base, ...patch }).filter(([key]) => !drop.includes(key)));

const rejectMeta = (value: JsonValue, provenance: ArchiveMetaProvenance = GOOD_META_PROVENANCE) => {
  const result = validateArchiveMeta(value, provenance);
  if (result.ok) {
    throw new Error(`本该被拒绝,却被接受了:${JSON.stringify(value)}`);
  }
  return result;
};

const rejectInput = (
  value: JsonValue,
  provenance: MatchInputProvenance = GOOD_INPUT_PROVENANCE,
) => {
  const result = validateMatchInput(value, provenance);
  if (result.ok) {
    throw new Error(`本该被拒绝,却被接受了:${JSON.stringify(value)}`);
  }
  return result;
};

const metaKeywords = (result: ReturnType<typeof rejectMeta>): readonly string[] =>
  result.machineDiagnostics.map((diagnostic) => diagnostic.keyword);

const metaPointers = (result: ReturnType<typeof rejectMeta>): readonly string[] =>
  result.machineDiagnostics.map((diagnostic) => diagnostic.pointer);

const inputKeywords = (result: ReturnType<typeof rejectInput>): readonly string[] =>
  result.machineDiagnostics.map((diagnostic) => diagnostic.keyword);

const inputPointers = (result: ReturnType<typeof rejectInput>): readonly string[] =>
  result.machineDiagnostics.map((diagnostic) => diagnostic.pointer);

// ── 一致性 ────────────────────────────────────────────────────────────────────

it("存档 meta 与对局输入:同一组 fixture 既过 TypeScript 类型(编译期)又过 ajv(运行期)", () => {
  // 编译期那半由 `: ArchiveMeta` / `: MatchInput` 标注与上面那组类型级断言承担。
  expect(validateArchiveMeta(GOOD_META, GOOD_META_PROVENANCE).ok).toBe(true);
  const input = validateMatchInput(GOOD_INPUT, GOOD_INPUT_PROVENANCE);
  expect(input.ok).toBe(true);
  // 收下时交出的是原值,不重写、不裁剪、不补默认值。
  if (input.ok) {
    expect(input.input).toEqual(GOOD_INPUT);
  }
});

it("meta schema 的必填键集合就是 hld §7.4 那一栏的十一项,且与 properties 一一对应", () => {
  // 名单是**抄 hld 的措辞**抄下来的,不是抄 schema 的:抄 schema 的话,少一项时两边一起少,
  // 这条断言就恒真了。逐项对照的是 hld.md:714-715 的十一项。
  const required = [...ARCHIVE_META_JSON_SCHEMA.required];
  expect(required).toEqual([
    "model",
    "modelVersion",
    "generatedAt",
    "protocolRounds",
    "prompts",
    "generationLog",
    "ruleset",
    "validation",
    "tscVersion",
    "scriptSha256",
    "sandboxRuntimeHash",
  ]);
  expect([...required].sort()).toEqual(Object.keys(ARCHIVE_META_JSON_SCHEMA.properties).sort());
});

it("input schema 的必填键集合就是 hld §7.4 那一栏的五项,且与 properties 一一对应", () => {
  // hld.md:721 逐项:4 × 存档路径 + 地图 + 种子 + ruleset 版本 + 各文件 hash。
  // 「各文件 hash」落在 archives 元素内(两格)与 mapSha256 一格,合计五项。
  const required = [...MATCH_INPUT_JSON_SCHEMA.required];
  expect(required).toEqual(["archives", "map", "mapSha256", "seed", "ruleset"]);
  expect([...required].sort()).toEqual(Object.keys(MATCH_INPUT_JSON_SCHEMA.properties).sort());
});

it("座位数在类型与 schema 之间是同一个数 4(定长四元组 ↔ minItems/maxItems)", () => {
  const archives = MATCH_INPUT_JSON_SCHEMA.properties.archives;
  expect(archives.minItems).toBe(4);
  expect(archives.maxItems).toBe(4);
  expect(GOOD_INPUT.archives).toHaveLength(4);
  // 反例:若哪一侧被写成 3 或 6,上面那圈当场红。
  expect(GOOD_INPUT.archives).not.toHaveLength(3);
});

// ── 缺必填项 → 红(十一项与五项逐项过,不是抽三项)────────────────────────────

it("meta:删掉任意一个必填项即被拒,诊断指向那个键(十一项逐项)", () => {
  // 正例先过一次,证明下面那些红不是因为 fixture 本来就不合法。
  expect(validateArchiveMeta(GOOD_META, GOOD_META_PROVENANCE).ok).toBe(true);
  for (const key of ARCHIVE_META_JSON_SCHEMA.required) {
    const result = rejectMeta(badMeta(GOOD_META, {}, [key]));
    expect(metaKeywords(result), `删掉 ${key} 竟不是缺键错`).toEqual(["required"]);
    expect(metaPointers(result)).toEqual([`/${key}`]);
  }
});

it("input:删掉任意一个必填项即被拒,诊断指向那个键;少一个座位同样被拒", () => {
  expect(validateMatchInput(GOOD_INPUT, GOOD_INPUT_PROVENANCE).ok).toBe(true);
  for (const key of MATCH_INPUT_JSON_SCHEMA.required) {
    const result = rejectInput(badInput(GOOD_INPUT, {}, [key]));
    expect(inputKeywords(result), `删掉 ${key} 竟不是缺键错`).toEqual(["required"]);
    expect(inputPointers(result)).toEqual([`/${key}`]);
  }
  // 座位数:三份存档不是四人对称的一盘棋,不是「少一个也能跑」。
  const threeSeats = badInput(GOOD_INPUT, {
    archives: [seatOf(0), seatOf(1), seatOf(2)],
  });
  expect(inputKeywords(rejectInput(threeSeats))).toEqual(["minItems"]);
  const fiveSeats = badInput(GOOD_INPUT, {
    archives: [seatOf(0), seatOf(1), seatOf(2), seatOf(3), seatOf(0)],
  });
  expect(inputKeywords(rejectInput(fiveSeats))).toEqual(["maxItems"]);
});

// ── 改哈希 → 红 ──────────────────────────────────────────────────────────────

it("meta:产物哈希与实测不符即被拒(记录值改与实测值改两个方向都红)", () => {
  expect(validateArchiveMeta(GOOD_META, GOOD_META_PROVENANCE).ok).toBe(true);

  // 方向一:meta 里记的那个哈希被换了(它仍长得像一个 sha256,只是不是这一个产物)。
  const recorded = rejectMeta(badMeta(GOOD_META, { scriptSha256: HASH.script3 }));
  expect(metaKeywords(recorded)).toEqual([SHA256_MISMATCH_KEYWORD]);
  expect(metaPointers(recorded)).toEqual(["/scriptSha256"]);

  // 方向二:目录里的产物被换了,而 meta 照旧(这正是「用了错误产物」那一条)。
  const measured = rejectMeta(GOOD_META, {
    ...GOOD_META_PROVENANCE,
    measuredScriptSha256: HASH.script3,
  });
  expect(metaKeywords(measured)).toEqual([SHA256_MISMATCH_KEYWORD]);
  expect(metaPointers(measured)).toEqual(["/scriptSha256"]);

  // sandbox-runtime 同理:换一副沙箱跑同一条脚本,结果不保证一致(FR-3),故它也是必检项。
  const runtime = rejectMeta(badMeta(GOOD_META, { sandboxRuntimeHash: HASH.script0 }));
  expect(metaPointers(runtime)).toEqual(["/sandboxRuntimeHash"]);
  expect(metaKeywords(runtime)).toEqual([SHA256_MISMATCH_KEYWORD]);
});

it("meta:哈希连形状都不对时由 ajv 判(散列的表示归 schema,取值比对归装载期)", () => {
  for (const broken of ["", "abc", HASH.script0.toUpperCase(), `${HASH.script0}0`]) {
    const result = rejectMeta(badMeta(GOOD_META, { scriptSha256: broken }));
    expect(metaKeywords(result), `${broken} 竟不是格式错`).toEqual(["pattern"]);
    expect(metaPointers(result)).toEqual(["/scriptSha256"]);
  }
});

it("input:各文件哈希与实测不符即被拒,诊断指到那一个座位(逐座位各验一次)", () => {
  expect(validateMatchInput(GOOD_INPUT, GOOD_INPUT_PROVENANCE).ok).toBe(true);

  // 四个座位逐个换掉 script.js 哈希:指针必须指到**那个座位**,不是笼统的根。
  for (const seat of [0, 1, 2, 3] as const) {
    const patched = badInput(GOOD_INPUT, {
      archives: GOOD_INPUT.archives.map((archive, index) =>
        index === seat ? { ...archive, scriptSha256: HASH.other } : archive,
      ),
    });
    const result = rejectInput(patched);
    expect(inputPointers(result), `座位 ${seat} 竟没被指出来`).toEqual([
      `/archives/${seat}/scriptSha256`,
    ]);
    expect(inputKeywords(result)).toEqual([SHA256_MISMATCH_KEYWORD]);
  }

  // meta.json 的哈希同样在位:换一份 meta 就是换一份存档。
  const metaSwapped = rejectInput(
    badInput(GOOD_INPUT, {
      archives: GOOD_INPUT.archives.map((archive, index) =>
        index === 3 ? { ...archive, metaSha256: HASH.meta0 } : archive,
      ),
    }),
  );
  expect(inputPointers(metaSwapped)).toEqual(["/archives/3/metaSha256"]);

  // 地图被改过而种子不变,地形就会在另一个形状上落。
  const mapSwapped = rejectInput(badInput(GOOD_INPUT, {}, []), {
    ...GOOD_INPUT_PROVENANCE,
    measuredMapSha256: HASH.other,
  });
  expect(inputPointers(mapSwapped)).toEqual(["/mapSha256"]);
});

// ── 改版本号 → 红(规则集版本三处一致,不静默降级)──────────────────────────────

it("meta:规则集版本错配即被拒(声明值 / 装载方读到的版本两头都红)", () => {
  expect(validateArchiveMeta(GOOD_META, GOOD_META_PROVENANCE).ok).toBe(true);

  const declared = rejectMeta(badMeta(GOOD_META, { ruleset: "v2" }));
  expect(metaKeywords(declared)).toEqual([RULESET_VERSION_MISMATCH_KEYWORD]);
  expect(metaPointers(declared)).toEqual(["/ruleset"]);

  // 装载方那一头错同样拒:「三处一致」不是三选二,更不是「内容对就行」。
  const loaded = rejectMeta(GOOD_META, {
    ...GOOD_META_PROVENANCE,
    loadedRulesetVersion: "v2",
  });
  expect(metaKeywords(loaded)).toEqual([RULESET_VERSION_MISMATCH_KEYWORD]);

  // 压根不是版本号的由 ajv 判形状,不混进版本比较那一类。
  expect(metaKeywords(rejectMeta(badMeta(GOOD_META, { ruleset: "latest" })))).toEqual(["pattern"]);
});

it("input:规则集版本错配即被拒,文件名与规则文档目录名各错一处都红", () => {
  expect(validateMatchInput(GOOD_INPUT, GOOD_INPUT_PROVENANCE).ok).toBe(true);

  const declared = rejectInput(badInput(GOOD_INPUT, { ruleset: "v2" }));
  expect(inputKeywords(declared)).toEqual([RULESET_VERSION_MISMATCH_KEYWORD]);
  expect(inputPointers(declared)).toEqual(["/ruleset"]);

  expect(
    inputKeywords(
      rejectInput(GOOD_INPUT, { ...GOOD_INPUT_PROVENANCE, rulesetFileName: "v2.json" }),
    ),
  ).toEqual([RULESET_VERSION_MISMATCH_KEYWORD]);
  expect(
    inputKeywords(
      rejectInput(GOOD_INPUT, { ...GOOD_INPUT_PROVENANCE, rulesDocDirName: "rules-v2" }),
    ),
  ).toEqual([RULESET_VERSION_MISMATCH_KEYWORD]);
});

// ── 缺档 → 红(hld §7.4:缺档报错退出,不跳过)──────────────────────────────────

it("meta:三件套少一件即被拒,不跳过(缺的是 script.ts / script.js / meta.json 三种)", () => {
  expect(validateArchiveMeta(GOOD_META, GOOD_META_PROVENANCE).ok).toBe(true);
  for (const missing of ["scriptTs", "scriptJs", "metaJson"] as const) {
    const result = rejectMeta(GOOD_META, {
      ...GOOD_META_PROVENANCE,
      filesPresent: { ...GOOD_META_PROVENANCE.filesPresent, [missing]: false },
    });
    expect(metaKeywords(result), `缺 ${missing} 竟未被拒`).toEqual([
      ARCHIVE_FILES_INCOMPLETE_KEYWORD,
    ]);
    // 缺的是**目录里的东西**,不是 meta.json 里哪个键不对,故指针写根。
    expect(metaPointers(result)).toEqual(["/"]);
  }
});

it("input:某个座位的存档缺档即被拒,诊断指到那个座位", () => {
  expect(validateMatchInput(GOOD_INPUT, GOOD_INPUT_PROVENANCE).ok).toBe(true);
  for (const seat of [0, 2, 3] as const) {
    const result = rejectInput(GOOD_INPUT, {
      ...GOOD_INPUT_PROVENANCE,
      measuredArchives: GOOD_INPUT_PROVENANCE.measuredArchives.map((measured, index) =>
        index === seat ? null : measured,
      ),
    });
    expect(inputPointers(result), `座位 ${seat} 缺档竟未被指出来`).toEqual([`/archives/${seat}`]);
    expect(inputKeywords(result)).toEqual([ARCHIVE_FILES_INCOMPLETE_KEYWORD]);
  }
});

it("meta:协议迭代轮数与逐轮 prompt 的条数不相等即被拒(双存判自洽)", () => {
  expect(validateArchiveMeta(GOOD_META, GOOD_META_PROVENANCE).ok).toBe(true);

  const rounds = rejectMeta(badMeta(GOOD_META, { protocolRounds: 3 }));
  expect(metaKeywords(rounds)).toEqual([ARCHIVE_PROTOCOL_ROUNDS_KEYWORD]);
  expect(metaPointers(rounds)).toEqual(["/prompts"]);

  const prompts = rejectMeta(badMeta(GOOD_META, { prompts: ["只剩一轮"] }));
  expect(metaKeywords(prompts)).toEqual([ARCHIVE_PROTOCOL_ROUNDS_KEYWORD]);
});

// ── 额外属性禁令(顶层与嵌套各一次)───────────────────────────────────────────

it("meta:多一个未声明字段即被拒(顶层与 validation 嵌套各一次)", () => {
  expect(validateArchiveMeta(GOOD_META, GOOD_META_PROVENANCE).ok).toBe(true);
  expect(metaPointers(rejectMeta(badMeta(GOOD_META, { season: "2026" })))).toEqual(["/season"]);
  expect(
    metaPointers(
      rejectMeta(
        badMeta(GOOD_META, { validation: { ...GOOD_META.validation, checkedAt: "2026-10-01" } }),
      ),
    ),
  ).toEqual(["/validation/checkedAt"]);
  // 嵌套那一层也必须是 `additionalProperties: false`:只关顶层的话,「存档已校验」是假话。
  expect(ARCHIVE_META_JSON_SCHEMA.properties.validation.additionalProperties).toBe(false);
});

it("input:多一个未声明字段即被拒(顶层与 archives 元素内各一次)", () => {
  expect(validateMatchInput(GOOD_INPUT, GOOD_INPUT_PROVENANCE).ok).toBe(true);
  expect(
    inputPointers(
      rejectInput(
        badInput(GOOD_INPUT, {
          archives: GOOD_INPUT.archives.map((archive, index) =>
            index === 1 ? { ...archive, model: "model-x" } : archive,
          ),
        }),
      ),
    ),
  ).toEqual(["/archives/1/model"]);
  expect(MATCH_INPUT_JSON_SCHEMA.properties.archives.items.additionalProperties).toBe(false);
});

// ── input 不含赛季配置 ───────────────────────────────────────────────────────

it("input:规则集那几项在,赛季那几项不在(一份对局只认自己这一份输入)", () => {
  // 「在」:五项齐,赛季那几项一个都不在文件里。
  expect(Object.keys(GOOD_INPUT).sort()).toEqual([
    "archives",
    "map",
    "mapSha256",
    "ruleset",
    "seed",
  ]);
  // 「不在」:hld §8 的赛季配置(参赛名单 / 地图池 / 种子数 / 并发度 / 名次分)逐个塞进去都被拒。
  // 塞进去的后果是那份文件长成第二个 season.yaml,而 FR-7 AC3 要的是「凭它复算这一盘」。
  for (const [key, value] of [
    ["season", "2026-autumn"],
    ["seasonConfig", {}],
    ["players", ["model-x", "model-y", "model-z", "model-w"]],
    ["mapPool", ["open-clash"]],
    ["seedCount", 4],
    ["concurrency", 8],
    ["rankPoints", [3, 2, 1, 0]],
  ] as const) {
    const result = rejectInput(badInput(GOOD_INPUT, { [key]: value }));
    expect(inputKeywords(result), `${key} 竟未被拒`).toEqual(["additionalProperties"]);
    expect(inputPointers(result)).toEqual([`/${key}`]);
  }
  // 规则集那几项在:规则集版本与规则文档目录名都由装载方交进 provenance,不是赛季参数。
  expect(GOOD_INPUT.ruleset).toBe(RULESET_VERSION);
  expect(GOOD_INPUT_PROVENANCE.rulesDocDirName).toBe(`rules-${RULESET_VERSION}`);
});

// ── 错型 ─────────────────────────────────────────────────────────────────────

it("meta 与 input:错型被拒(顶层与嵌套各一处)", () => {
  expect(metaKeywords(rejectMeta(badMeta(GOOD_META, { protocolRounds: "2" })))).toContain("type");
  expect(metaKeywords(rejectMeta(badMeta(GOOD_META, { prompts: "第一轮" })))).toContain("type");
  expect(
    metaKeywords(
      rejectMeta(badMeta(GOOD_META, { validation: { ...GOOD_META.validation, passed: "是" } })),
    ),
  ).toContain("type");
  expect(
    metaKeywords(rejectMeta(badMeta(GOOD_META, { validation: { passed: true, errors: [1] } }))),
  ).toContain("type");

  expect(inputKeywords(rejectInput(badInput(GOOD_INPUT, { seed: "7" })))).toContain("type");
  expect(inputKeywords(rejectInput(badInput(GOOD_INPUT, { seed: 1.5 })))).toContain("type");
  expect(inputKeywords(rejectInput(badInput(GOOD_INPUT, { seed: -1 })))).toContain("minimum");
  expect(inputPointers(rejectInput(badInput(GOOD_INPUT, { map: 3 })))).toEqual(["/map"]);
});

it("根不是对象时被拒,诊断指向根(meta 与 input 各一次)", () => {
  for (const value of ["meta", 4, null, [], [1, 2]] as const) {
    expect(metaPointers(rejectMeta(value))).toEqual(["/"]);
    expect(metaKeywords(rejectMeta(value))).toEqual(["type"]);
    expect(inputPointers(rejectInput(value))).toEqual(["/"]);
    expect(inputKeywords(rejectInput(value))).toEqual(["type"]);
  }
});

// ── 两层诊断(同一个渲染器)──────────────────────────────────────────────────

it("meta 与 input:机器层透出路径 / 关键字 / 消息三样,面向模型层按类合并成一行", () => {
  // 四处哈希不符 + 一处缺档:五件事对模型是**两行**——哈希是一类,缺档是另一类
  // (缺的是东西,不对的是东西,给的建议不同),分开报才说得上话。
  const broken = rejectInput(GOOD_INPUT, {
    ...GOOD_INPUT_PROVENANCE,
    measuredArchives: [null, measuredSeat(1), measuredSeat(2), measuredSeat(3)],
    measuredMapSha256: HASH.script0,
  });
  const pointers = inputPointers(broken);
  expect(pointers).toContain("/archives/0");
  expect(pointers).toContain("/mapSha256");
  for (const diagnostic of broken.machineDiagnostics) {
    expect(diagnostic.pointer.startsWith("/")).toBe(true);
    expect(diagnostic.keyword).not.toBe("");
    expect(diagnostic.message).not.toBe("");
  }
  expect([...broken.modelDiagnostics].sort()).toEqual(
    [
      "存档缺档(三件套不全或某个座位没有存档):/archives/0",
      "记录的哈希与实测不符:/mapSha256",
    ].sort(),
  );

  // meta 侧同一个渲染器:形状错与缺键各占一行,而缺两个键仍然只占一行(合并仍然生效)。
  const shape = rejectMeta(badMeta(GOOD_META, { model: 7 }, ["tscVersion", "validation"]));
  expect([...shape.modelDiagnostics].sort()).toEqual(
    ["值的类型不对:/model", "缺少必填字段:/validation、/tscVersion"].sort(),
  );
});

it("同一份坏数据两次校验给出同一份诊断(诊断本身必须稳定)", () => {
  const brokenMeta = badMeta(GOOD_META, { scriptSha256: HASH.script3 }, ["tscVersion"]);
  expect(rejectMeta(brokenMeta)).toEqual(rejectMeta(brokenMeta));

  const brokenInput = badInput(GOOD_INPUT, { ruleset: "v2" });
  expect(rejectInput(brokenInput)).toEqual(rejectInput(brokenInput));
});

// ── 回放末行 result(09 票:类型 / JSON Schema / 读入端三层里的第三层)───────────

/**
 * 类型级断言:JSON Schema 里 `reason` 的枚举与类型侧的 `ReplayOutcomeReason` 逐字相同。
 * 两侧各改一个值而只改一边时,`tsc -b` 非零退出——这是「类型是上游、schema 手工对齐」这条
 * 路线上唯一能提前抓住漂移的东西(与本文件顶部那两条键集合断言同源)。
 */
type ResultReasonEnum =
  (typeof REPLAY_RESULT_LINE_JSON_SCHEMA)["properties"]["reason"]["enum"][number];
export type ResultReasonEnumMatchesType = Assert<Equals<ResultReasonEnum, ReplayOutcomeReason>>;

/** 一份完整的合法末行。名次可并列、领土分非负、`reason` 在枚举内。 */
const GOOD_RESULT: ReplayResultLine = {
  type: "result",
  rankings: [1, 2, 2, 4],
  reason: "victory",
  territoryScores: [12, 4, 4, 0],
};

/** 改坏数据:换值 / 删键,与上面几份同一套手法。 */
const badResult = (
  patch: Record<string, JsonValue> = {},
  drop: readonly string[] = [],
): JsonValue =>
  Object.fromEntries(
    Object.entries({ ...GOOD_RESULT, ...patch }).filter(([key]) => !drop.includes(key)),
  );

const rejectResult = (value: JsonValue) => {
  const result = validateReplayResultLine(value);
  if (result.ok) {
    throw new Error(`本该被拒绝,却被接受了:${JSON.stringify(value)}`);
  }
  return result;
};

const resultKeywords = (result: ReturnType<typeof rejectResult>): readonly string[] =>
  result.machineDiagnostics.map((diagnostic) => diagnostic.keyword);

const resultPointers = (result: ReturnType<typeof rejectResult>): readonly string[] =>
  result.machineDiagnostics.map((diagnostic) => diagnostic.pointer);

it("回放 result:合法行被接受,并把原值交出来(不重写、不裁剪)", () => {
  const result = validateReplayResultLine(GOOD_RESULT);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.result).toEqual(GOOD_RESULT);
  }
});

it("回放 result schema 的必填键就是四栏,且与 properties 一一对应", () => {
  const required = [...REPLAY_RESULT_LINE_JSON_SCHEMA.required];
  expect(required).toEqual(["type", "rankings", "reason", "territoryScores"]);
  expect([...required].sort()).toEqual(
    Object.keys(REPLAY_RESULT_LINE_JSON_SCHEMA.properties).sort(),
  );
});

it("回放 result:删掉任意一个必填项即被拒,诊断指向那个键(四栏逐项)", () => {
  for (const key of REPLAY_RESULT_LINE_JSON_SCHEMA.required) {
    const result = rejectResult(badResult({}, [key]));
    expect(resultKeywords(result), `删掉 ${key} 竟不是缺键错`).toEqual(["required"]);
    expect(resultPointers(result)).toEqual([`/${key}`]);
  }
});

it("回放 result:多一个未声明的栏即被拒", () => {
  const result = rejectResult(badResult({ mystery: 1 }));
  expect(resultKeywords(result)).toEqual(["additionalProperties"]);
  expect(resultPointers(result)).toEqual(["/mystery"]);
});

it("回放 result:reason 取值不在四值枚举内即被拒(封闭联合在读入端的形状)", () => {
  const result = rejectResult(badResult({ reason: "surrender" }));
  expect(resultKeywords(result)).toEqual(["enum"]);
  expect(resultPointers(result)).toEqual(["/reason"]);
});

it("回放 result:名次与领土分都是定长四元组,长度不对即被拒", () => {
  expect(resultKeywords(rejectResult(badResult({ rankings: [1, 2, 3] })))).toEqual(["minItems"]);
  expect(resultKeywords(rejectResult(badResult({ rankings: [1, 2, 3, 4, 5] })))).toEqual([
    "maxItems",
  ]);
  expect(resultKeywords(rejectResult(badResult({ territoryScores: [0, 0, 0] })))).toEqual([
    "minItems",
  ]);
});

it("回放 result:名次低于 1、领土分为负、类型不对都被拒", () => {
  expect(resultKeywords(rejectResult(badResult({ rankings: [0, 1, 2, 3] })))).toEqual(["minimum"]);
  expect(resultKeywords(rejectResult(badResult({ territoryScores: [-1, 0, 0, 0] })))).toEqual([
    "minimum",
  ]);
  expect(resultKeywords(rejectResult(badResult({ type: "tick" })))).toEqual(["enum"]);
  expect(resultKeywords(rejectResult(badResult({ rankings: "1,2,3,4" })))).toEqual(["type"]);
});

// ── 观测行(09 票:回放之外那份 observations.jsonl 的一行)──────────────────────

/**
 * 类型级断言:JSON Schema 里 `kind` 的枚举与类型侧的 `ObservationLineKind` 逐字相同。
 * 两侧各改一个值而只改一边时,`tsc -b` 非零退出(与 `result.reason` 那条同源)。
 */
type ObservationKindEnum =
  (typeof OBSERVATION_LINE_JSON_SCHEMA)["properties"]["kind"]["enum"][number];
export type ObservationKindEnumMatchesType = Assert<
  Equals<ObservationKindEnum, ObservationLineKind>
>;

/** 一份完整的合法观测行。 */
const GOOD_OBSERVATION: ObservationLine = {
  type: "observation",
  tick: 12,
  seat: 2,
  kind: "wall-clock-soft",
  value: 15,
  limit: 10,
};

const badObservation = (
  patch: Record<string, JsonValue> = {},
  drop: readonly string[] = [],
): JsonValue =>
  Object.fromEntries(
    Object.entries({ ...GOOD_OBSERVATION, ...patch }).filter(([key]) => !drop.includes(key)),
  );

const rejectObservation = (value: JsonValue) => {
  const result = validateObservationLine(value);
  if (result.ok) {
    throw new Error(`本该被拒绝,却被接受了:${JSON.stringify(value)}`);
  }
  return result;
};

const observationKeywords = (result: ReturnType<typeof rejectObservation>): readonly string[] =>
  result.machineDiagnostics.map((diagnostic) => diagnostic.keyword);

const observationPointers = (result: ReturnType<typeof rejectObservation>): readonly string[] =>
  result.machineDiagnostics.map((diagnostic) => diagnostic.pointer);

it("观测行:合法行被接受,并把原值交出来(不重写、不裁剪)", () => {
  const result = validateObservationLine(GOOD_OBSERVATION);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.observation).toEqual(GOOD_OBSERVATION);
  }
});

it("观测行 schema 的必填键就是六栏,且与 properties 一一对应", () => {
  const required = [...OBSERVATION_LINE_JSON_SCHEMA.required];
  expect(required).toEqual(["type", "tick", "seat", "kind", "value", "limit"]);
  expect([...required].sort()).toEqual(Object.keys(OBSERVATION_LINE_JSON_SCHEMA.properties).sort());
});

it("观测行:删掉任意一个必填项即被拒,诊断指向那个键(六栏逐项)", () => {
  for (const key of OBSERVATION_LINE_JSON_SCHEMA.required) {
    const result = rejectObservation(badObservation({}, [key]));
    expect(observationKeywords(result), `删掉 ${key} 竟不是缺键错`).toEqual(["required"]);
    expect(observationPointers(result)).toEqual([`/${key}`]);
  }
});

it("观测行:多一个未声明的栏即被拒", () => {
  const result = rejectObservation(badObservation({ mystery: 1 }));
  expect(observationKeywords(result)).toEqual(["additionalProperties"]);
  expect(observationPointers(result)).toEqual(["/mystery"]);
});

it("观测行:kind 取值不在两值枚举内即被拒(只披露、不判罚那两类)", () => {
  const result = rejectObservation(badObservation({ kind: "tripped" }));
  expect(observationKeywords(result)).toEqual(["enum"]);
  expect(observationPointers(result)).toEqual(["/kind"]);
});

it("观测行:座位/读数/上限的类型与下界不对都被拒", () => {
  expect(observationKeywords(rejectObservation(badObservation({ seat: 4 })))).toEqual(["enum"]);
  expect(observationKeywords(rejectObservation(badObservation({ value: -1 })))).toEqual([
    "minimum",
  ]);
  expect(observationKeywords(rejectObservation(badObservation({ limit: "10" })))).toEqual(["type"]);
  expect(observationKeywords(rejectObservation(badObservation({ tick: 1.5 })))).toEqual(["type"]);
});
