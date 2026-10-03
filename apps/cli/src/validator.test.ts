/**
 * 校验器的自测——spec《Testing Decisions》的**副缝**:断言对象是「一段 JSON 值 → 接受 / 带诊断拒绝」,
 * 这是一个纯函数,不碰文件系统、不碰 CLI 退出码。`map-lint` 的地图校验断言也落在这里,
 * 不去测子命令的退出码。
 *
 * 本文件属于 `unit` project,因而混在全量门禁 `check` 里(它就是普通单测);
 * 它**刻意不进** `gates` project——那道工程会 spawn `check`,而 `check` 里含 `vitest run`,
 * 混进去就是 `check → 本文件 → check` 的套娃(vitest.config.ts 的 GATES_TEST 常量)。
 *
 * 每条用例都配了**现做现验的反例**:从一份被接受的合法地图出发,加一个字段 / 删一个字段 /
 * 改一个类型,确认判决跟着内容走。坏了的反例比没有反例更坏。
 */

import { MAP_JSON_SCHEMA, RULESET_VERSION } from "@model-war/schema";
import type { JsonValue, MapDefinition } from "@model-war/schema";
import { expect, it } from "vitest";

import {
  RULESET_TOO_NEW_KEYWORD,
  UNKNOWN_RULESET_VERSION_KEYWORD,
  validateMap,
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
 * 变体槽位取**最松形态**:元素刻意不被约束(待地图图回填),所以这里把各种形态都塞进去。
 * 一旦有人给槽位写窄了约束,这条 fixture 当场红。
 */
const LOOSE_SLOTS: MapDefinition = {
  ...MINIMAL,
  name: "loose-slots",
  variantSlots: [{}, [], "任意字符串", 42, null, [1, 2, 3], { axis: { kind: "wall" } }],
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
  variantSlots: [{ kind: "wall", offsets: [[0, 0]] }],
};

const FIXTURES: readonly MapDefinition[] = [MINIMAL, LOOSE_SLOTS, SYMMETRIC];

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

it("变体槽位取最松形态时通过(元素形状尚未定稿,等 A 节点回填)", () => {
  expect(validateMap(LOOSE_SLOTS).ok).toBe(true);
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
