/**
 * 读入端校验器:本仓库**唯一**一份 ajv 校验(spec《校验器:落在 CLI 应用》)。
 *
 * 为什么落在这儿而不落回真源包:真源包交付 JSON Schema **数据**,不交付校验器——
 * 它受包依赖规则约束,不能依赖 ajv(hld §3.2)。而 ajv 只需要一个宿主:CLI 是唯一用户面,
 * 外部数据(文件 / 参数 / 子进程输出)全都从它进来,一处校验覆盖全部入口(hld §2.2.8)。
 *
 * 三条纪律,改代码前先读:
 *
 * 1. **纯函数**。签名是「一段 JSON 值 → 接受 / 带诊断拒绝」,不碰文件系统、不碰 CLI 退出码。
 *    接受 / 拒绝的断言落在本文件导出的函数上(spec《Testing Decisions》副缝);
 *    `map-lint` 的地图校验断言也落在这里,不去测子命令的退出码。
 * 2. **不新增任何 CLI 子命令**(hld §9 的六条不动)。真正的风险不是校验点少,而是日后有人
 *    为了让别的包也能校验而手写一份形状 if —— 那才是第二真源。
 * 3. **诊断分两层**:机器层是 ajv 的原始诊断(路径 + 关键字 + 消息),原样透出;
 *    面向模型层是渲染后的短句,含 JSON 指针,并**对同类错误合并成一行**
 *    (生成管线的五轮迭代预算撑不撑得住,取决于这个合并)。
 *
 * 本文件已有两份形状(地图 / 规则集),走的是**同一个 Ajv 实例、同一套投影与合并渲染**。
 * 新增一种数据形状是「再加一个 `validateXxx` + 它的装载期断言」,不是新写一份校验器:
 * 真正的风险不是校验点少,而是日后有人为了让别的包也能校验而手写一份形状 if —— 那才是第二真源。
 */

// 取具名导出而不是默认导出:ajv 是 CJS 包且 `module.exports` 就是 Ajv 类本身,
// 而它的 .d.ts 用 ESM 语法写成,于是 `import Ajv from "ajv"` 拿到的类型是整个命名空间
// (不可构造)。具名导入两侧一致。
import { Ajv } from "ajv";
import type { ErrorObject, SchemaObject } from "ajv";
import {
  MAP_JSON_SCHEMA,
  RULESET_JSON_SCHEMA,
  RULESET_UNIT_KEYS,
  RULESET_VERSION,
  SPAWN_TICKS_COEFFICIENT,
  type JsonValue,
  type MapDefinition,
  type Ruleset,
  type UnitStats,
} from "@model-war/schema";

/** 机器层的一条诊断:ajv 原始的路径 / 关键字 / 消息,或装载期断言自己产出的同形条目。 */
export type Diagnostic = {
  /** JSON 指针。ajv 的 `instancePath` 为空串(即根)时写作 `/`。 */
  readonly pointer: string;
  /** ajv 关键字;非 ajv 产出的装载期断言用自定义关键字,见下面两个常量。 */
  readonly keyword: string;
  /** 消息原文。机器层不做任何改写,改写只发生在面向模型层。 */
  readonly message: string;
};

/**
 * 装载期版本断言的两个关键字。它们不是 ajv 的关键字,单独命名以免门禁排障时
 * 把「ajv 说了」与「我们判了」混成同一类;分两个是因为两种错法要给的建议不同
 * (一个是版本太新、地图跑不了,一个是版本压根不存在)。
 */
export const RULESET_TOO_NEW_KEYWORD = "ruleset-min-too-new";
export const UNKNOWN_RULESET_VERSION_KEYWORD = "unknown-ruleset-version";

/**
 * 规则集版本三处不一致:`rulesets/vN.json` 的文件名 / `docs/rules-vN/` 的目录名 /
 * 真源包的 `RULESET_VERSION` 常量。**只报一个关键字**,因为三处里错几处是同一件事:
 * 「这份数据与本仓的规则版本不是同一个版本」,对模型的建议也是同一条(别拿它跑)。
 */
export const RULESET_VERSION_MISMATCH_KEYWORD = "ruleset-version-mismatch";

/**
 * 派生量与取值不自洽:取值文件里写的 `spawnTicks` ≠ `⌈cost × SPAWN_TICKS_COEFFICIENT⌉`。
 *
 * 它不是 ajv 的关键字,而是装载期断言——派生式是**跨字段**的(一条兵种线的 `cost` 与
 * `spawnTicks` 之间的关系),draft-07 表达不了。这类断言与版本断言同轨,同形同措辞表。
 */
export const DERIVED_SPAWN_TICKS_KEYWORD = "derived-spawn-ticks";

/** 拒绝时的那一半结果。两类数据的形状相同,所以共用这一个类型而不是各写一遍。 */
export type ValidationRejection = {
  readonly ok: false;
  /** 机器层:逐条原始诊断,供门禁排障与自动化分流。 */
  readonly machineDiagnostics: readonly Diagnostic[];
  /** 面向模型层:含 JSON 指针的短句,**同类合并成一行**,可直接回喂模型。 */
  readonly modelDiagnostics: readonly string[];
};

export type MapValidation =
  | { readonly ok: true; readonly map: MapDefinition }
  | ValidationRejection;

// `allErrors: true` 是合并的前提:默认的 fail-fast 只报第一条错,
// 面向模型层就退化成「每次回喂只修一个错」,五轮预算必被吃光。
const ajv = new Ajv({ allErrors: true });

// `as const` 产出的只读数组/字面量类型不能直接喂给 ajv 的 `SchemaObject`(那边要可变数组),
// 唯一的适配就是这一次断言。schema 自身写错形状不会在这里被拦住——
// 拦住它的是 `validator.test.ts` 里那组双过的 fixture 与键集合的类型级断言。
const checkMapShape = ajv.compile(MAP_JSON_SCHEMA as SchemaObject);
const checkRulesetShape = ajv.compile(RULESET_JSON_SCHEMA as SchemaObject);

const MAJOR_OF_VERSION = /^v([0-9]+)$/;

const majorOf = (version: string): number | undefined => {
  const matched = MAJOR_OF_VERSION.exec(version);
  return matched === null ? undefined : Number(matched[1] ?? "");
};

/**
 * 规则版本下界的判据:`rulesetMin` 是**地图要求的最低**规则集版本,故要求
 * `1 ≤ rulesetMin ≤ RULESET_VERSION`(未发布过的版本号不认)。
 *
 * 三处需要解释:
 *
 * - **方向**。判据是「装载的规则集版本 ≥ 地图要求的下界」,不是反过来。反过来(声明的版本
 *   必须 ≥ 当前版本)会把一张要求 v2 的地图在 v1 规则集下放行,那正是 hld §7.1「错配拒跑」
 *   要防的事:拿尚未发布的规则集去跑图。
 * - **不是取等号**。字段叫 `rulesetMin` 而不是 `ruleset`,为的就是规则集升到 v2 时声明 v1 的
 *   老地图继续合法——取等号会让每次规则集升版作废全部地图。在只有 v1 的今天,下界与等号
 *   的可接受集合相同(只有 v1),所以「≠ v1 即拒」成立;把判据写在下界这一侧,v2 落地时
 *   不必改代码,也不必改 schema。
 * - **不写成 JSON Schema**。版本号之间的比较是跨字段的语义判断,draft-07 表达不了;
 *   schema 那边只管形状(`^v[0-9]+$`),比较放在装载期。
 */
const rulesetBoundDiagnostic = (declared: string): Diagnostic | undefined => {
  const declaredMajor = majorOf(declared);
  const currentMajor = majorOf(RULESET_VERSION) ?? 0;
  if (declaredMajor === undefined || declaredMajor < 1) {
    return {
      pointer: "/rulesetMin",
      keyword: UNKNOWN_RULESET_VERSION_KEYWORD,
      message: `规则集版本 ${declared} 不存在(本仓自 ${RULESET_VERSION} 起)`,
    };
  }
  if (declaredMajor > currentMajor) {
    return {
      pointer: "/rulesetMin",
      keyword: RULESET_TOO_NEW_KEYWORD,
      message: `地图要求的规则集版本 ${declared} 高于本仓的 ${RULESET_VERSION}`,
    };
  }
  return undefined;
};

/**
 * 诊断指向哪里。
 *
 * `required` / `additionalProperties` 这两类,ajv 的 `instancePath` 指的是**出问题的对象的父**,
 * 而真正出问题的是它点名的那一个键。取父路径会让「缺 /terrain」显示成「缺 /」,
 * 面向模型层的那一句就失去了可操作性,所以这里改指被点名的键。
 */
const pointerOf = (error: ErrorObject): string => {
  const { missingProperty, additionalProperty } = error.params as {
    missingProperty?: string;
    additionalProperty?: string;
  };
  const named = missingProperty ?? additionalProperty;
  if (named !== undefined) {
    return `${error.instancePath}/${named}`;
  }
  return error.instancePath === "" ? "/" : error.instancePath;
};

/** 面向模型层的措辞表:每个 ajv 关键字一句短句。缺失的键直接透出关键字,不静默丢。 */
const MODEL_PHRASE: Readonly<Record<string, string>> = {
  required: "缺少必填字段",
  additionalProperties: "出现了未声明的字段",
  type: "值的类型不对",
  pattern: "取值不符合格式约束",
  enum: "取值不在允许的取值集合内",
  minimum: "数值低于允许下界",
  minLength: "字符串短于允许长度",
  minItems: "数组元素数不足",
  maxItems: "数组元素数超出",
  items: "数组元素的形状不对",
  [RULESET_TOO_NEW_KEYWORD]: "声明的规则集版本高于本仓规则集版本",
  [UNKNOWN_RULESET_VERSION_KEYWORD]: "声明的规则集版本不存在",
  [RULESET_VERSION_MISMATCH_KEYWORD]:
    "规则集版本三处不一致(取值文件名 / 规则文档目录名 / 版本常量)",
  [DERIVED_SPAWN_TICKS_KEYWORD]: "生产耗时与派生式不一致",
};

const phraseOf = (keyword: string): string => MODEL_PHRASE[keyword] ?? `不满足 ${keyword} 约束`;

/** ajv 诊断 → 本包的诊断形状。逐字段透出,只在 `pointer` 上做上面说的那处改指。 */
const toMachineDiagnostic = (error: ErrorObject): Diagnostic => ({
  pointer: pointerOf(error),
  keyword: error.keyword,
  message: error.message ?? "",
});

/**
 * 把机器层渲染成面向模型层:**按关键字合并**,同类错误并成一行。
 *
 * 合并是本文件的硬要求(spec 用户故事 15):缺三个键是一行「缺少必填字段:/a、/b、/c」,
 * 而不是三行。逐行输出会把五轮迭代预算吃光,而这三行对模型说的是同一件事。
 * 顺序按首次出现的关键字稳定输出,不排序——同一份输入两次渲染的措辞必须一致。
 */
const renderModelDiagnostics = (diagnostics: readonly Diagnostic[]): readonly string[] => {
  const byKeyword = new Map<string, string[]>();
  for (const diagnostic of diagnostics) {
    const pointers = byKeyword.get(diagnostic.keyword) ?? [];
    if (!pointers.includes(diagnostic.pointer)) {
      pointers.push(diagnostic.pointer);
    }
    byKeyword.set(diagnostic.keyword, pointers);
  }
  return [...byKeyword].map(([keyword, pointers]) => `${phraseOf(keyword)}:${pointers.join("、")}`);
};

/** 拒绝结果的唯一构造处:机器层原样透出,面向模型层在这里渲染(合并只发生一次)。 */
const rejectionOf = (machineDiagnostics: readonly Diagnostic[]): ValidationRejection => ({
  ok: false,
  machineDiagnostics,
  modelDiagnostics: renderModelDiagnostics(machineDiagnostics),
});

/**
 * 校验一段地图 JSON。**纯函数**:不读盘、不写文件、不设退出码、不打日志。
 *
 * 接受时返回 `MapDefinition`:ajv 只保证形状,这里是把 JSON 值认作 `MapDefinition` 的
 * 唯一一处断言(TS 侧不可证);两侧的一致性由 `validator.test.ts` 的 fixture 双过兜住。
 */
export const validateMap = (value: JsonValue): MapValidation => {
  if (!checkMapShape(value)) {
    return rejectionOf((checkMapShape.errors ?? []).map(toMachineDiagnostic));
  }

  // 到这里 `rulesetMin` 必已通过 `^v[0-9]+$`,所以这层判据只比大小,不再判形状。
  // 这是一次断言而不是一次校验:ajv 已经保证了它是个字符串,而 TS 侧的对应类型是
  // `RulesetVersion`("v1" 字面量),两者相等性由 `validator.test.ts` 的断言盯着。
  const declared = (value as { rulesetMin: string }).rulesetMin;
  const bound = rulesetBoundDiagnostic(declared);
  if (bound !== undefined) {
    return rejectionOf([bound]);
  }

  return { ok: true, map: value as MapDefinition };
};

// ── 规则集(hld §7.1)──────────────────────────────────────────────────────────

/**
 * 一份规则集是**从哪些名字装载上来的**。
 *
 * 规则版本号不在取值文件里(它由三处名字承担:文件名、规则文档目录名、版本常量),
 * 于是「这三处是不是同一个版本」这件事**不在值里**,只能由装载方把它知道的两处名字交进来。
 * 纯函数不读盘,所以读文件名与读目录名是调用方的活,判一致性是本函数的活——
 * 分界与 `map-lint` 那条一样:本文件只判,不取。
 *
 * 因此这个参数**必填**:让它可选等于留一个「跳过版本检查」的静默后门,而版本错配
 * 拒跑(hld §7.1)是这类数据唯一的软肋。
 */
export type RulesetProvenance = {
  /** 取值文件名,例如 `v1.json`。 */
  readonly rulesetFileName: string;
  /** 规则文档目录名,例如 `rules-v1`。 */
  readonly rulesDocDirName: string;
};

export type RulesetValidation =
  | { readonly ok: true; readonly ruleset: Ruleset }
  | ValidationRejection;

/** 装载期判据:文件名与目录名都必须由 `RULESET_VERSION` 推出来。 */
const expectedRulesetFileName = `${RULESET_VERSION}.json`;
const expectedRulesDocDirName = `rules-${RULESET_VERSION}`;

/**
 * 版本三处一致性的判据。指针写根 `/`:这条诊断说的不是文件里哪个键不对,而是
 * **这份文件整个不属于本仓的这个版本**(它没有 JSON 指针可指)。
 */
const rulesetProvenanceDiagnostic = (provenance: RulesetProvenance): Diagnostic | undefined => {
  if (
    provenance.rulesetFileName === expectedRulesetFileName &&
    provenance.rulesDocDirName === expectedRulesDocDirName
  ) {
    return undefined;
  }
  return {
    pointer: "/",
    keyword: RULESET_VERSION_MISMATCH_KEYWORD,
    message:
      `规则集版本三处不一致:版本常量 ${RULESET_VERSION}、取值文件名 ` +
      `${provenance.rulesetFileName}、规则文档目录名 ${provenance.rulesDocDirName};` +
      `应当是 ${expectedRulesetFileName} 与 ${expectedRulesDocDirName}`,
  };
};

/**
 * 派生量断言:每条兵种线写下的 `spawnTicks` 必须等于 `⌈cost × SPAWN_TICKS_COEFFICIENT⌉`。
 *
 * **四条的诊断一次收齐**,而不是发现第一条就返回:「四条线里错了两条」与「错了四条」
 * 对模型是两件难度完全不同的事,逐条早退会把一次回喂变成四次。
 *
 * 算术在这里是**精确**的:系数是 0.5(2 的负幂),`cost` 是 ajv 已约束过的整数,
 * 于是 `cost × α` 在 IEEE-754 下无误差,`Math.ceil` 只是取整。真源包那侧写了同一条理由。
 */
const derivedSpawnTicksDiagnostics = (ruleset: Ruleset): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  for (const key of RULESET_UNIT_KEYS) {
    const stats = ruleset[key as keyof Ruleset] as UnitStats;
    const expected = Math.ceil(stats.cost * SPAWN_TICKS_COEFFICIENT);
    if (stats.spawnTicks === expected) {
      continue;
    }
    diagnostics.push({
      pointer: `/${key}/spawnTicks`,
      keyword: DERIVED_SPAWN_TICKS_KEYWORD,
      message:
        `${key}.spawnTicks 写了 ${stats.spawnTicks},而派生式 ` +
        `⌈cost ${stats.cost} × ${SPAWN_TICKS_COEFFICIENT}⌉ = ${expected}`,
    });
  }
  return diagnostics;
};

/**
 * 校验一份规则集。**纯函数**,与 `validateMap` 同一条缝:不读盘、不碰 CLI 退出码。
 *
 * 三道判据按这个顺序,理由是「先说最可操作的那条」:
 * 1. **形状**(ajv):缺键 / 错型 / 额外属性都在这里。缺预算键在这里是 `required` 缺失,
 *    与「键存在但取未定值」是**两种不同的错误**——后者是合法的取值,压根不在这里被拒。
 * 2. **版本三处一致**:形状不对时先修形状;形状对了才谈它属不属于本仓的版本。
 * 3. **派生量自洽**:形状与版本都过了,兵种表才可能被读出数值——此时不一致是**数据自相矛盾**,
 *    不拒就会带着一张互相打架的兵种表走进对局。
 */
export const validateRuleset = (
  value: JsonValue,
  provenance: RulesetProvenance,
): RulesetValidation => {
  if (!checkRulesetShape(value)) {
    return rejectionOf((checkRulesetShape.errors ?? []).map(toMachineDiagnostic));
  }

  const version = rulesetProvenanceDiagnostic(provenance);
  if (version !== undefined) {
    return rejectionOf([version]);
  }

  // ajv 已经保证每条兵种线的六个字段都是整数,故下面这次认作 `Ruleset` 的断言是安全的。
  const ruleset = value as Ruleset;
  const derived = derivedSpawnTicksDiagnostics(ruleset);
  if (derived.length > 0) {
    return rejectionOf(derived);
  }

  return { ok: true, ruleset };
};
