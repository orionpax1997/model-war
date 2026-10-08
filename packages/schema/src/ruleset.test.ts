/**
 * 键清单与规则集形状的断言(真源包这一侧)。**只断言数据**,不碰文件系统、不碰 ajv——
 * ajv 那一侧在 `apps/cli/src/validator.test.ts`,两侧合起来才是「形状对不对」的完整答案。
 *
 * 断言对象是**清单的内容与内部一致性**,而不是某个函数的行为:这批数据是 E 节点生成
 * `rulesets/vN.json` 与 `docs/rules-vN` 数值表的唯一输入,它错了,错的是后面两份产物。
 *
 * 每条都配了**能被弄红的反例**(手法记在各条注释里),坏了的反例比没有反例更坏。
 */

import { expect, it } from "vitest";

import {
  FULL_PRODUCTION_COST_RATE,
  MEMORY_SOFT_THRESHOLD_RATIO,
  RULESET_JSON_SCHEMA,
  RULESET_KEYS,
  RULESET_KEY_CATALOG,
  RULESET_UNIT_KEYS,
  SPAWN_TICKS_COEFFICIENT,
  UNDETERMINED_VALUE,
  type Ruleset,
  type RulesetKey,
} from "./index.js";

// ── Q4:类型是上游,清单与 JSON Schema 由同一次书写产生 ──────────────────────

type RequiredKeysOf<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/**
 * 类型级断言:键清单的键集合 === `Ruleset` 类型的键联合。
 * 清单与类型各加一个字段而只改一边时,`tsc -b` 非零退出。
 * 另一条(`JSON Schema 的必填键集合 === 类型键联合`)落在 CLI 那侧,因为它需要 ajv 的形状。
 */
export type RulesetCatalogKeysMatchType = Assert<Equals<RulesetKey, RequiredKeysOf<Ruleset>>>;

// ── 数目:21 键,按标定状态分两半(定稿 / 未定)─────────────────────────────

/**
 * 21 个键的**字面清单**。写成字面量而不是从清单里数,是因为「数出来是 21」这条断言
 * 拦不住「有人往清单里加了一个不该有的键」——那正是要拦的那件事。
 *
 * 上游 spec 与 DAG 节点表写的是「22 键 = 13 + 9」,而 handoff §2.1 的表只有 9 **行**,
 * 其中「内存软阈」那一行是派生的展示项、明写「入表不入 schema」;hld §5.3 收口句列的上限
 * 取值恰好 8 项。仓库里**不存在**第 9 个预算取值。故此处是 21,来历见
 * `ruleset-keys.ts` 的头注。
 */
const EXPECTED_KEYS: readonly string[] = [
  // 13 个定稿键(handoff §1)
  "tickLimit",
  "captureTicks",
  "initialResources",
  "harvestRate",
  "carryLimit",
  "resourcePerSite",
  "worker",
  "melee",
  "ranged",
  "cavalry",
  "baseScore",
  "resourceScore",
  "unitCostDivisor",
  // 8 个预算键(handoff §2.1)
  "exceptionTickLimit",
  "eventTickLimit",
  "apiCallTickLimit",
  "memoryLimit",
  "memoryTickCeiling",
  "wallClockSoftLimit",
  "wallClockHardTimeout",
  "scriptSizeLimit",
];

const EXPECTED_FINAL_KEYS: readonly string[] = [
  ...EXPECTED_KEYS.slice(0, 13),
  // 预算键分批落定稿(票 05 落计数与异常三键,票 06 落内存两键,票 07 落墙钟两键与体积键):
  // 票 07 之后八键全部定稿,未定键集为空。
  "exceptionTickLimit",
  "eventTickLimit",
  "apiCallTickLimit",
  "memoryLimit",
  "memoryTickCeiling",
  "wallClockSoftLimit",
  "wallClockHardTimeout",
  "scriptSizeLimit",
];
const EXPECTED_UNDETERMINED_KEYS: readonly string[] = [];

const keysWith = (state: "final" | "undetermined"): readonly string[] =>
  RULESET_KEYS.filter((key) => RULESET_KEY_CATALOG[key].calibration.state === state);

it("键清单就是 21 个键,不多不少,顺序即书写序", () => {
  expect(RULESET_KEYS).toHaveLength(21);
  expect([...RULESET_KEYS]).toEqual(EXPECTED_KEYS);
  // 反例:往清单里加任意一个键(哪怕叫 `memorySoftThreshold`),上面两条立刻红。
  expect(Object.keys(RULESET_KEY_CATALOG)).toEqual([...RULESET_KEYS]);
});

it("定稿键与未定键按标定状态分得开(预算键分批落定稿)", () => {
  expect(keysWith("final")).toEqual(EXPECTED_FINAL_KEYS);
  expect(keysWith("undetermined")).toEqual(EXPECTED_UNDETERMINED_KEYS);
  // 两半合起来仍是 21 键,不多不少。
  expect(EXPECTED_FINAL_KEYS.length + EXPECTED_UNDETERMINED_KEYS.length).toBe(RULESET_KEYS.length);
});

it("内存软阈不入键清单(它是派生展示项,入表不入 schema)", () => {
  // 它既不在 21 个键里,也不可能是任何一个键的子字段。
  const mentionsSoftThreshold = RULESET_KEYS.filter((key) =>
    key.toLowerCase().includes("softthreshold"),
  );
  expect(mentionsSoftThreshold).toEqual([]);
  // 清单里只有两种值类型:整数与兵种对象。派生的浮点展示项没有位置可钻——
  // 要让它进来就得先加第三种值类型,那是一条要重新讨论的变更,不是顺手能加的一格。
  expect(
    [...new Set(RULESET_KEYS.map((key) => RULESET_KEY_CATALOG[key].valueType))].sort(),
  ).toEqual(["integer", "unit-stats"]);
  // 软阈的系数仍然以常量的形式存在,展示侧自己乘。
  expect(MEMORY_SOFT_THRESHOLD_RATIO).toBe(0.8);
});

// ── 「未定值」是判别式的,不是一个标志位 ───────────────────────────────────

it("票 07 收口:未定键集为空,21 键全部定稿;占位常量的语义仍保留", () => {
  expect(UNDETERMINED_VALUE).toBe(0);
  expect(EXPECTED_UNDETERMINED_KEYS).toEqual([]);
  expect(keysWith("undetermined")).toEqual([]);
  // 八个预算键全部落定稿——判据是键自己身上那个 `state`,不是「值是不是 0」。
  for (const key of EXPECTED_KEYS.slice(13)) {
    const entry = RULESET_KEY_CATALOG[key as RulesetKey];
    expect(entry.calibration).toEqual({ state: "final" });
    // 占位必须真的过得了形状:否则「先填占位跑起来」这句话只对计数类键成立。
    expect(entry.schema).toMatchObject({ type: "integer", minimum: 0 });
  }
});

it("键清单区分「未定的值」与「一个真的 0」:同一个取值,渲染不同", () => {
  // 判据只能来自键自己身上那个 `state`,不能来自「值是不是 0」——
  // 否则标定完成后某个预算上限恰好是 0,文档就会开始骗人。
  // 票 07 之后未定键集为空,但这条区分仍是判据本身:`initialResources` 是真的 0(下界 0)。
  const realZero = RULESET_KEY_CATALOG.initialResources;
  expect(realZero.calibration.state).toBe("final");
  // 下界是 0:取值 0 在它身上合法,合法的 0 不构成「未定」的证据。
  expect(realZero.schema).toMatchObject({ minimum: 0 });
  // `scriptSizeLimit` 曾是「未定值」的样本,票 07 落定后它 now final——这正是「状态可变、判据是状态」的证据:
  // 同一个键,标定状态改了,面向模型的渲染就跟着改。
  expect(RULESET_KEY_CATALOG.scriptSizeLimit.calibration).toEqual({ state: "final" });
  // 两态判别联合仍然在,`UNDETERMINED_VALUE`(占位)仍取 0;它与一个真的 0 是两个概念。
  expect(UNDETERMINED_VALUE).toBe(0);
  const undetermined = { state: "undetermined", placeholder: 0 } as const;
  // 断言走 `as string`:`state` 是字面量联合,直接比两个无交集的字面量会被 TS 报成「两边无交集」。
  expect(undetermined.state as string).not.toBe(realZero.calibration.state as string);
});

// ── 每条清单条目自身完整:四样东西缺一不可 ──────────────────────────────────

it("每条条目都带齐值类型 / 量纲 / 说明 / schema 定义,integer 键还带取值下界", () => {
  for (const key of RULESET_KEYS) {
    const entry = RULESET_KEY_CATALOG[key];
    expect(entry.valueType, `${key} 缺 valueType`).toBeTruthy();
    expect(entry.unit, `${key} 缺 unit`).toBeTruthy();
    expect(entry.description.length, `${key} 缺面向模型的说明`).toBeGreaterThan(0);
    // 说明与 schema 的 description 写在同一次书写里,后者必须是前者的同一段(可再加工)。
    expect(entry.schema.description.length).toBeGreaterThan(0);
    if (entry.valueType === "integer") {
      expect(typeof entry.minimum, `${key} 是整数键却没有下界`).toBe("number");
      // 下界同时进 schema:键清单说 0 起,schema 就必须真收 0。
      expect(entry.schema).toMatchObject({ type: "integer", minimum: entry.minimum });
    } else {
      // 兵种对象不给顶层下界:给一个假的会让人以为对象也有大小写。
      expect(entry.minimum, `${key} 是对象键,不该有顶层下界`).toBeUndefined();
    }
  }
});

// ── 派生量:系数是常量,双存由装载期断言(那一侧在 CLI) ─────────────────────

it("生产耗时系数能重算 handoff §1 四条兵种线的定稿值", () => {
  // (cost, spawnTicks) 抄自 handoff §1 的定稿值清单。系数若被改成 0.6 之类,这条红。
  const calibrated: readonly (readonly [number, number])[] = [
    [4, 2],
    [8, 4],
    [12, 6],
    [16, 8],
  ];
  for (const [cost, spawnTicks] of calibrated) {
    expect(Math.ceil(cost * SPAWN_TICKS_COEFFICIENT), `cost ${cost}`).toBe(spawnTicks);
  }
  // 系数是 2 的负幂,乘整数精确——这是「双存 + 装载期断言」能成立的前提,不是巧合。
  expect(SPAWN_TICKS_COEFFICIENT).toBe(0.5);
});

it("满产烧钱率是常量(2/tick),不是键", () => {
  expect(FULL_PRODUCTION_COST_RATE).toBe(2);
  expect([...RULESET_KEYS].some((key) => key.toLowerCase().includes("burn"))).toBe(false);
});

// ── 键清单 → JSON Schema:同一次书写的两个投影 ──────────────────────────────

it("JSON Schema 的 properties 与 required 都由键清单投影而来(逐项同一对象)", () => {
  // 用**同一性**而不是结构相等:同一性证明它们是同一个对象被引用两次,
  // 结构相等在有人手抄一份的时候也会过——而那正是要拦的失败模式。
  for (const key of RULESET_KEYS) {
    expect(RULESET_JSON_SCHEMA.properties[key], `${key} 的 schema 定义不同源`).toBe(
      RULESET_KEY_CATALOG[key].schema,
    );
  }
  expect([...RULESET_JSON_SCHEMA.required]).toEqual([...RULESET_KEYS]);
  expect(RULESET_JSON_SCHEMA.additionalProperties).toBe(false);
});

it("四条兵种线的键取自清单(unit-stats),不另写一份名单", () => {
  expect([...RULESET_UNIT_KEYS]).toEqual(["worker", "melee", "ranged", "cavalry"]);
  for (const key of RULESET_UNIT_KEYS) {
    expect(RULESET_KEY_CATALOG[key].valueType).toBe("unit-stats");
  }
  // 反例:清单里少一条 unit-stats,这条红(而不是等到某条兵种线在运行时没被断言)。
  expect(RULESET_UNIT_KEYS).toHaveLength(4);
});
