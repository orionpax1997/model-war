/**
 * `rulesets/v1.json` 这份**落库取值文件**的自测(规则落库 01 号票)。
 *
 * 为什么与 `validator.test.ts` 分成两个文件:那边断言的是「一段 JSON 值 → 接受 / 带诊断拒绝」
 * 这个**纯函数**(不碰文件系统,数据全是文件里手造的 fixture);这里断言的是**仓库里那一份文件**
 * (读真文件,不重抄)。两者合起来才是「规则集有取值」这句话的完整答案:前一个答「校验器判得对不对」,
 * 这一个答「我们交出去的那一份对不对」。
 *
 * 断言对象只有一件:**这份文件与键清单、与标定环交接单、与派生式三者的关系**。
 * 键清单本身(21 个键的名字、量纲、标定状态)归 `packages/schema/src/ruleset.test.ts`,
 * 派生式与版本断言的实现归 `validator.ts`;这里只钉「落库的那一份没跑偏」。
 *
 * 刻意不做的事(spec《Testing Decisions》第三缝「单点,刻意不接线」):**不接进任何子命令的装载路径**,
 * 也不新增子命令(hld §9 的六条不动)。所以本文件断的是纯函数 `validateRuleset` 的判决,
 * 不是某个命令的退出码——因此它属于 `unit` project 而不是 `gates`:`gates` 断的是
 * 「全量门禁 / 命令的退出码与报告文本」,而这条通路刻意没有命令可断。
 *
 * 每条用例都配了**现做现验的反例**:从这份真文件出发删一个键、加一个键、改一个派生量,
 * 确认判决跟着内容走,且诊断**带 JSON 指针**。坏了的反例比没有反例更坏。
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RULESET_KEYS,
  RULESET_KEY_CATALOG,
  RULESET_VERSION,
  SPAWN_TICKS_COEFFICIENT,
  UNDETERMINED_VALUE,
  type JsonValue,
  type Ruleset,
  type RulesetKey,
  type RulesetKeyCalibration,
} from "@model-war/schema";
import { expect, it } from "vitest";

import {
  DERIVED_SPAWN_TICKS_KEYWORD,
  RULESET_VERSION_MISMATCH_KEYWORD,
  type ValidationRejection,
  validateRuleset,
} from "./validator.js";

// ── 被断言的那份文件(读它,不重抄)─────────────────────────────────────────────

/**
 * 取值文件的路径与规则文档目录的路径。**版本号由这三处名字承担**(文件名、目录名、版本常量),
 * 文件内部没有版本键,所以下面那两处名字是从仓库布局的真实路径上取的,不是手写的字面量。
 */
const RULESET_PATH = fileURLToPath(new URL("../../../rulesets/v1.json", import.meta.url));
const RULES_DOC_DIR_PATH = fileURLToPath(new URL("../../../docs/rules-v1", import.meta.url));

/** 版本三处一致判据的另两处:装载方把它知道的名字交进来,判一致性是校验器的活。 */
const PROVENANCE = {
  rulesetFileName: basename(RULESET_PATH),
  rulesDocDirName: basename(RULES_DOC_DIR_PATH),
} as const;

/** 落库的那份取值。标注成 `Ruleset` 是刻意的:键名与字段类型由 `tsc -b` 先判一遍。 */
const V1: Ruleset = JSON.parse(readFileSync(RULESET_PATH, "utf8"));

/** 改坏数据的两种手法,与 `validator.test.ts` 同一套(换值 / 删键),多一种「加键」。 */
const patched = (patch: Record<string, JsonValue>): JsonValue => ({ ...V1, ...patch });

const without = (dropped: readonly string[]): JsonValue =>
  Object.fromEntries(Object.entries(V1).filter(([key]) => !dropped.includes(key)));

const rejected = (value: JsonValue, provenance = PROVENANCE): ValidationRejection => {
  const result = validateRuleset(value, provenance);
  if (result.ok) {
    throw new Error(`本该被拒绝,却被接受了:${JSON.stringify(value)}`);
  }
  return result;
};

const keywordsOf = (result: ValidationRejection): readonly string[] =>
  result.machineDiagnostics.map((diagnostic) => diagnostic.keyword);

const pointersOf = (result: ValidationRejection): readonly string[] =>
  result.machineDiagnostics.map((diagnostic) => diagnostic.pointer);

/**
 * 键清单按标定状态分的两半。切法取自键清单本身,**不在这里另列一份名单**——
 * 八个预算键要分三批从 `undetermined` 落成 `final`,写死任何一边的数量都会让
 * 「落值票」红在一个与本票无关的理由上。判据是键自己身上那个 `state`,不是「值是不是 0」。
 */
const FINAL_KEYS = RULESET_KEYS.filter(
  (key) => RULESET_KEY_CATALOG[key].calibration.state === "final",
);

const UNDETERMINED_KEYS = RULESET_KEYS.filter(
  (key) => RULESET_KEY_CATALOG[key].calibration.state === "undetermined",
);

/**
 * 13 个定稿键的终值,**逐字抄自标定环交接单 §1**(`resourcePerSite` 是票 09 改值后的 200,
 * 不是草案里的 125;四条兵种线的 `spawnTicks` 与 `⌈cost × α⌉` 一致,下面另有断言逐条对)。
 *
 * **这份抄本存在的唯一理由是把「文件里的数 = 交接单的数」变成机器可判的**,取值真源仍是
 * `rulesets/v1.json`;抄本与文件不一致时红的是下面那条断言,而不是一次看不出所以然的失败。
 * 抄本的键集必须**与 `FINAL_KEYS` 完全重合**:八个预算键分批落定稿时,每落一个就得在这里
 * 补上它的终值,否则下面那条断言会以「要一个终值」失败。
 * 类型标注是 `Partial<Ruleset>`:键名拼错、兵种线六个子字段写错或写漏,由 `tsc -b` 先拦一道。
 */
const FINAL_VALUES: Partial<Ruleset> = {
  tickLimit: 600,
  captureTicks: 10,
  initialResources: 16,
  harvestRate: 1,
  carryLimit: 20,
  resourcePerSite: 200,
  worker: { cost: 4, hp: 2, damage: 0, range: 1, speed: 1, spawnTicks: 2 },
  melee: { cost: 8, hp: 12, damage: 3, range: 1, speed: 1, spawnTicks: 4 },
  ranged: { cost: 12, hp: 4, damage: 2, range: 2, speed: 1, spawnTicks: 6 },
  cavalry: { cost: 16, hp: 6, damage: 2, range: 1, speed: 2, spawnTicks: 8 },
  baseScore: 4,
  resourceScore: 1,
  unitCostDivisor: 6,
  // 预算键分批落定稿(票 05 落计数与异常三键);仍为未定值的键不在这里。
  exceptionTickLimit: 3,
  eventTickLimit: 10000,
  apiCallTickLimit: 300,
};

/**
 * 「一个键在给定标定状态下应有的取值」——本文件按标定状态分组的**唯一判据点**。
 * 未定键 → 它自己身上的占位值;定稿键 → 终值抄本里的终值。
 *
 * 定稿键在抄本里找不到终值时**抛错**,而不是返回 `undefined` 让后面的比较去红:
 * 失败措辞必须是「这个键要一个终值」,好让落值票一眼看到该补什么,也让下面那条
 * 反向用例能直接问出「切成定稿之后的判据要的是什么」。
 *
 * 抽成一个函数是为了让反向用例拿一份「临时切成定稿」的标定去问**同一份判据**,
 * 而不是另写一条只在反向用例里成立的断言。
 */
const valueForCalibration = (
  key: RulesetKey,
  calibration: RulesetKeyCalibration,
): Ruleset[RulesetKey] => {
  if (calibration.state === "undetermined") {
    return calibration.placeholder;
  }
  if (!Object.hasOwn(FINAL_VALUES, key)) {
    throw new Error(`定稿键 ${key} 要一个终值,但终值抄本里没有它`);
  }
  return FINAL_VALUES[key]!;
};

// ── 一、这份文件能被校验器收下 ────────────────────────────────────────────────

it("落库的 rulesets/v1.json 被校验器收下,三道判据(形状 / 版本 / 派生量)全过", () => {
  const result = validateRuleset(V1, PROVENANCE);
  expect(result.ok).toBe(true);
  // 收下时交出的是原值,不重写、不裁剪、不补默认值。
  if (result.ok) {
    expect(result.ruleset).toEqual(V1);
  }
});

it("版本三处一致:取值文件名与规则文档目录名都对得上版本常量", () => {
  expect(PROVENANCE.rulesetFileName).toBe(`${RULESET_VERSION}.json`);
  expect(PROVENANCE.rulesDocDirName).toBe(`rules-${RULESET_VERSION}`);

  // 反例:只错一处同样拒(「三处一致」不是三选二),诊断指向根——它说的不是哪个键不对,
  // 而是「这份文件整个不属于本仓的这个版本」。
  const result = rejected(V1, {
    rulesetFileName: "v2.json",
    rulesDocDirName: PROVENANCE.rulesDocDirName,
  });
  expect(keywordsOf(result)).toEqual([RULESET_VERSION_MISMATCH_KEYWORD]);
  expect(pointersOf(result)).toEqual(["/"]);
});

it("文件里没有版本键(版本由三处名字承担,内容里再写一份就是第二处可能各写各的)", () => {
  expect(Object.keys(V1).filter((key) => /version/i.test(key))).toEqual([]);
  // 反例:把版本号塞进内容,键数立刻不对(多键),下面那条「多一个键即被拒」当场红。
  expect(keywordsOf(rejected(patched({ version: RULESET_VERSION })))).toContain(
    "additionalProperties",
  );
});

// ── 二、键集 == 键清单(缺键、多键两个方向都查)───────────────────────────────

it("键集就是键清单的 21 个键,不多不少,顺序即书写序", () => {
  // 比的是**这份文件里的键**与键清单,不是两个常量互比——后者在文件还没落库时就恒真。
  expect(Object.keys(V1)).toEqual([...RULESET_KEYS]);
  expect([...RULESET_KEYS]).toHaveLength(21);
  // 键序同时是 `required` 序、取值文件的书写序与生成数值表的行序,不容另定一处。
  expect(FINAL_KEYS.length + UNDETERMINED_KEYS.length).toBe(RULESET_KEYS.length);
});

it("少一个键即被拒,诊断指向那个键(键数不对不是「接受一份缺键的规则集」)", () => {
  for (const key of ["tickLimit", "exceptionTickLimit", "memoryTickCeiling", "scriptSizeLimit"]) {
    const result = rejected(without([key]));
    expect(keywordsOf(result), `删掉 ${key} 竟不是缺键错`).toEqual(["required"]);
    expect(pointersOf(result)).toEqual([`/${key}`]);
  }
  // 缺键与「键存在但取 0」是两种不同的错误:后者是合法取值(下面第三条)。
  expect(validateRuleset(V1, PROVENANCE).ok).toBe(true);
});

it("多一个键即被拒,诊断指向那个键", () => {
  for (const key of ["memorySoftThreshold", "spawnTicksCoefficient", "fullProductionCostRate"]) {
    const result = rejected(patched({ [key]: 1 }));
    expect(keywordsOf(result), `多出 ${key} 竟未被拒`).toEqual(["additionalProperties"]);
    expect(pointersOf(result)).toEqual([`/${key}`]);
  }
});

// ── 三、定稿键与未定键:各按标定状态取应有的值 ───────────────────────────────

it("定稿键逐字取终值抄本(抄本与定稿键集完全重合,不数数)", () => {
  // 先逐键取终值:新落定的键还没补终值,失败就是「这个键要一个终值」。
  for (const key of FINAL_KEYS) {
    expect(V1[key], `${key} 的取值与它的终值不一致`).toEqual(
      valueForCalibration(key, RULESET_KEY_CATALOG[key].calibration),
    );
  }
  // 再查反方向:抄本里不许有定稿键之外的键(某个键退回未定值却还留着终值,这条红)。
  // 用集合重合代替「抄本长度 = 常数」,数量随落值批次变,写死就会假红。
  expect(Object.keys(FINAL_VALUES).sort()).toEqual([...FINAL_KEYS].sort());
  // 反例:把 `resourcePerSite` 写回草案时代的 125(票 09 已改值为 200),上面那圈当场红。
  expect(FINAL_VALUES.resourcePerSite).not.toBe(125);
});

it("未定键各取自己身上标定的占位值,不硬编未定键的数量", () => {
  // 八个预算键分三批落定稿,未定键数会从 8 一路变到 0;这里不写死它,分组取自标定状态本身。
  for (const key of UNDETERMINED_KEYS) {
    const calibration = RULESET_KEY_CATALOG[key].calibration;
    // 判据是键自己的标定状态,不是「值是不是 0」:占位值从键身上取,不是一个字面量。
    if (calibration.state !== "undetermined") {
      throw new Error(`${key} 被切进了未定值那半,它的标定状态却不是 undetermined`);
    }
    expect(calibration.placeholder).toBe(UNDETERMINED_VALUE);
    expect(V1[key], `${key} 未取该键标定的占位值`).toEqual(valueForCalibration(key, calibration));
  }
});

it("反向用例:把一个未定键临时切成定稿,判据就要终值而不是接受占位值", () => {
  // 判据按标定状态分组,所以「切成定稿」只改状态、不改取值(V1 里那份仍是占位值)。
  // 本地复现:在 `ruleset-keys.ts` 里把某个预算键的 `calibration` 改成 `{ state: "final" }`——
  // 上面「定稿键逐字取终值抄本」那条随即要求补终值,而不是拿占位值蒙混过去。
  const key = UNDETERMINED_KEYS[0];
  if (key === undefined) {
    throw new Error("没有未定键,反向用例没法做");
  }

  // 正方向:未定状态 → 占位值,且与落库文件里的那份一致。
  expect(valueForCalibration(key, RULESET_KEY_CATALOG[key].calibration)).toEqual(V1[key]);
  expect(V1[key]).toBe(UNDETERMINED_VALUE);

  // 切成定稿 → 同一份判据不再接受占位值,而是抛「要一个终值」。
  expect(() => valueForCalibration(key, { state: "final" })).toThrow(
    new RegExp(`定稿键 ${key} 要一个终值`),
  );
});

it("「未定」由标定状态判别,不由值是不是 0 推断——这份文件里就有一个真的 0", () => {
  // 反例在文件内部:`worker.damage` 是**真的 0**(农民无攻击能力),而它所在的键标着 final。
  // 判据若写成「值是 0 就渲染未定」,这条农民会被误标成未定键。
  expect(V1.worker.damage).toBe(0);
  expect(RULESET_KEY_CATALOG.worker.calibration).toEqual({ state: "final" });
  expect(UNDETERMINED_KEYS).not.toContain("worker");
});

// ── 四、派生量与推导项:是公式,不是格子 ───────────────────────────────────────

it("生产耗时是派生量的双存键:文件里写错一个数就在装载期被拒,诊断指向那个字段", () => {
  // 合法基线:四条兵种线的 `spawnTicks` 都等于 `⌈cost × α⌉`(上面「被收下」那条已判过一遍)。
  expect(validateRuleset(V1, PROVENANCE).ok).toBe(true);
  expect(Math.ceil(V1.worker.cost * SPAWN_TICKS_COEFFICIENT)).toBe(V1.worker.spawnTicks);

  const result = rejected(patched({ worker: { ...V1.worker, spawnTicks: 3 } }));
  expect(keywordsOf(result)).toEqual([DERIVED_SPAWN_TICKS_KEYWORD]);
  expect(pointersOf(result)).toEqual(["/worker/spawnTicks"]);
});

it("满产烧钱率、内存软阈、派生系数与开局资源点归属都不是键(公式与地图侧不变量)", () => {
  // 逐条对应为什么:满产烧钱率与内存软阈是派生式(系数是真源包的常量,软阈明写「入表不入 schema」);
  // `spawnTicksCoefficient` 是派生系数本身;开局资源点归属是地图侧的不变量,由地图声明与地图校验器断言。
  for (const key of [
    "fullProductionCostRate",
    "memorySoftThreshold",
    "spawnTicksCoefficient",
    "initialSiteOwnership",
  ]) {
    expect(Object.keys(V1), `${key} 不该作为键出现`).not.toContain(key);
  }
});
