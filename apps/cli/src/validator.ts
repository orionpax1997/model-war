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
 * 本文件已有六份形状(地图 / 规则集 / 存档 meta / 对局输入 / 回放 meta 行 / 回放末行 `result`),走的是**同一个 Ajv 实例、
 * 同一套投影与合并渲染**。新增一种数据形状是「再加一个 `validateXxx` + 它的装载期断言」,
 * 不是新写一份校验器:真正的风险不是校验点少,而是日后有人为了让别的包也能校验而手写一份
 * 形状 if —— 那才是第二真源。
 */

// 取具名导出而不是默认导出:ajv 是 CJS 包且 `module.exports` 就是 Ajv 类本身,
// 而它的 .d.ts 用 ESM 语法写成,于是 `import Ajv from "ajv"` 拿到的类型是整个命名空间
// (不可构造)。具名导入两侧一致。
import { Ajv } from "ajv";
import type { ErrorObject, SchemaObject } from "ajv";
import {
  ARCHIVE_META_JSON_SCHEMA,
  MAP_JSON_SCHEMA,
  MATCH_INPUT_JSON_SCHEMA,
  REPLAY_META_LINE_JSON_SCHEMA,
  REPLAY_RESULT_LINE_JSON_SCHEMA,
  RULESET_JSON_SCHEMA,
  RULESET_UNIT_KEYS,
  RULESET_VERSION,
  SPAWN_TICKS_COEFFICIENT,
  type ArchiveMeta,
  type JsonValue,
  type MapDefinition,
  type MatchInput,
  type ReplayMetaLine,
  type ReplayResultLine,
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

/**
 * 哈希与实测不符:文件里记的 sha256 与装载方当场算出来的不一样。
 *
 * 两份形状(存档 meta / 对局输入)都可能有这个错,而且它们是**同一件事**:记录的那份产物
 * 与真正要跑的那份不是同一个。只用一个关键字,于是同一份对局输入里的五处哈希不符对模型
 * 合并成一行——那正是「同类合并」存在的理由(五轮迭代预算)。
 */
export const SHA256_MISMATCH_KEYWORD = "sha256-mismatch";

/**
 * 存档缺档(hld §7.4 的三件套 `script.ts` / `script.js` / `meta.json` 不全,或某个座位
 * 根本没有那份存档)。**不跳过、不补默认值**(FR-6 AC2),故它与「哈希不符」分开报:
 * 缺的是东西,不对的是东西,给模型的建议不同。
 */
export const ARCHIVE_FILES_INCOMPLETE_KEYWORD = "archive-files-incomplete";

/** 协议迭代轮数与逐轮 prompt 的条数不相等(`protocolRounds` 与 `prompts` 双存的自洽)。 */
export const ARCHIVE_PROTOCOL_ROUNDS_KEYWORD = "archive-protocol-rounds-mismatch";

/** 拒绝时的那一半结果。几类数据的形状相同,所以共用这一个类型而不是各写一遍。 */
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

export type ArchiveMetaValidation =
  | { readonly ok: true; readonly meta: ArchiveMeta }
  | ValidationRejection;

export type MatchInputValidation =
  | { readonly ok: true; readonly input: MatchInput }
  | ValidationRejection;

export type ReplayResultLineValidation =
  | { readonly ok: true; readonly result: ReplayResultLine }
  | ValidationRejection;

export type ReplayMetaLineValidation =
  | { readonly ok: true; readonly meta: ReplayMetaLine }
  | ValidationRejection;

// `allErrors: true` 是合并的前提:默认的 fail-fast 只报第一条错,
// 面向模型层就退化成「每次回喂只修一个错」,五轮预算必被吃光。
const ajv = new Ajv({ allErrors: true });

// `as const` 产出的只读数组/字面量类型不能直接喂给 ajv 的 `SchemaObject`(那边要可变数组),
// 唯一的适配就是这一次断言。schema 自身写错形状不会在这里被拦住——
// 拦住它的是 `validator.test.ts` 里那组双过的 fixture 与键集合的类型级断言。
const checkMapShape = ajv.compile(MAP_JSON_SCHEMA as SchemaObject);
const checkRulesetShape = ajv.compile(RULESET_JSON_SCHEMA as SchemaObject);
// 存档 meta 与对局输入:同一实例、同一次编译(模块顶层)。新起第二个 Ajv 实例会让
// 「唯一一份校验器」这句话当场失效,所以这两行与上面两行是同一件事的续写。回放末行 `result`
// 也在这里编译(同一实例)。
const checkArchiveMetaShape = ajv.compile(ARCHIVE_META_JSON_SCHEMA as SchemaObject);
const checkMatchInputShape = ajv.compile(MATCH_INPUT_JSON_SCHEMA as SchemaObject);
// 回放的两行(meta / 末行 `result`)也在这里编译(同一实例)。`meta` 行是 `verify` 的装载期入口:
// 执行方式 / 版本 / hash / 三件套的耦合由 JSON Schema 的 if/then 表达,ajv 一层就够。
const checkReplayMetaShape = ajv.compile(REPLAY_META_LINE_JSON_SCHEMA as SchemaObject);
const checkReplayResultShape = ajv.compile(REPLAY_RESULT_LINE_JSON_SCHEMA as SchemaObject);

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
  [SHA256_MISMATCH_KEYWORD]: "记录的哈希与实测不符",
  [ARCHIVE_FILES_INCOMPLETE_KEYWORD]: "存档缺档(三件套不全或某个座位没有存档)",
  [ARCHIVE_PROTOCOL_ROUNDS_KEYWORD]: "协议迭代轮数与逐轮 prompt 的条数不一致",
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
 *
 * `declaredVersion` 是「文件内容里自己声明的版本号」,取值文件**内部没有版本键**,
 * 于是那一格传 `undefined`;而 `input.json` / `meta.json` 里有一格自己声明的版本,
 * 那一格传声明值并把指针指到那个键上——**同一个错法(不属于本仓这个版本)报同一个关键字**,
 * 只是指针更准,合并规则对它照样生效。
 */
const rulesetProvenanceDiagnostic = (
  provenance: RulesetProvenance,
  pointer: string,
  declaredVersion?: string,
): Diagnostic | undefined => {
  const namesMatch =
    provenance.rulesetFileName === expectedRulesetFileName &&
    provenance.rulesDocDirName === expectedRulesDocDirName;
  // `declaredVersion === undefined` = 取值文件**内部没有版本键**(那一格不存在,不是「错」)。
  const declaredMatch = declaredVersion === undefined || declaredVersion === RULESET_VERSION;
  if (namesMatch && declaredMatch) {
    return undefined;
  }
  const declared = declaredVersion === undefined ? "" : `、文件里声明的版本 ${declaredVersion}`;
  return {
    pointer,
    keyword: RULESET_VERSION_MISMATCH_KEYWORD,
    message:
      `规则集版本三处不一致:版本常量 ${RULESET_VERSION}、取值文件名 ` +
      `${provenance.rulesetFileName}、规则文档目录名 ${provenance.rulesDocDirName}${declared};` +
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

  const version = rulesetProvenanceDiagnostic(provenance, "/");
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

// ── 冻结脚本存档 meta(hld §7.4)────────────────────────────────────────────────

/**
 * 存档目录那一侧的事实。**纯函数不读盘**,所以「三件套在不在」「文件内容哈希是多少」
 * 是装载方的活,判它们与记录值是否一致是本函数的活——分界与 `RulesetProvenance` 同一条。
 *
 * 为什么三件套的「在不在」也要交进来:FR-6 AC2 明写「缺档报错退出,不跳过」,而
 * 「缺档」压根不在 `meta.json` 的内容里(内容齐了,目录里少一个文件一样是缺档)。
 * 把它做成必填参数而不是可选开关,是与版本判据同一个理由:可选等于留一个
 * 「跳过检查」的静默后门。
 */
export type ArchiveMetaProvenance = {
  /** 三件套各自是否在位。`metaJson` 缺档时压根进不到本函数(它就是入参),但仍列在这里,
   * 免得装载方为了让判据对称而临时拼一个恒为真的键。 */
  readonly filesPresent: {
    readonly scriptTs: boolean;
    readonly scriptJs: boolean;
    readonly metaJson: boolean;
  };
  /** 装载方当场算出的 `script.js` 的 sha256;缺档时传 `null`(此时只报缺档,不比对哈希)。 */
  readonly measuredScriptSha256: string | null;
  /** 本仓沙箱 runtime 的实测 hash(与 meta 里记的那个比,不是与另一份 meta 比)。 */
  readonly measuredSandboxRuntimeHash: string;
  /** 装载方实际装载的规则集版本(由 `rulesets/vN.json` 的文件名读出)。 */
  readonly loadedRulesetVersion: string;
};

/** 缺一份文件时,三条里最要紧的那一条——三件套的名字取自 hld §7.4 的拓扑。 */
const missingArchiveFile = (present: ArchiveMetaProvenance["filesPresent"]): string | undefined => {
  if (!present.scriptTs) {
    return "script.ts";
  }
  if (!present.scriptJs) {
    return "script.js";
  }
  return present.metaJson ? undefined : "meta.json";
};

/**
 * 装载期判据:三件套齐不齐、两个哈希与实测是否相等、轮数与 prompt 条数是否相等、
 * 规则集版本三处是否一致。**四类诊断一次收齐**,理由与派生量那条同源:
 * 「缺了 script.js 且哈希也变了」与「只缺了 script.js」对模型是两件难度完全不同的事,
 * 逐条早退会把一次回喂变成四次。
 */
const archiveMetaDiagnostics = (
  meta: ArchiveMeta,
  provenance: ArchiveMetaProvenance,
): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];

  const missing = missingArchiveFile(provenance.filesPresent);
  if (missing !== undefined) {
    // 指针写根 `/`:这条诊断说的不是 meta.json 里哪个键不对,而是**存档目录整个不合格**。
    diagnostics.push({
      pointer: "/",
      keyword: ARCHIVE_FILES_INCOMPLETE_KEYWORD,
      message: `存档三件套不全:缺 ${missing}(不跳过、不补默认值)`,
    });
  } else if (
    provenance.measuredScriptSha256 !== null &&
    provenance.measuredScriptSha256 !== meta.scriptSha256
  ) {
    diagnostics.push({
      pointer: "/scriptSha256",
      keyword: SHA256_MISMATCH_KEYWORD,
      message: `meta 记的 script.js 哈希是 ${meta.scriptSha256},实测 ${provenance.measuredScriptSha256}`,
    });
  }

  if (provenance.measuredSandboxRuntimeHash !== meta.sandboxRuntimeHash) {
    diagnostics.push({
      pointer: "/sandboxRuntimeHash",
      keyword: SHA256_MISMATCH_KEYWORD,
      message:
        `meta 记的 sandbox-runtime 哈希是 ${meta.sandboxRuntimeHash},` +
        `本仓实测 ${provenance.measuredSandboxRuntimeHash}`,
    });
  }

  if (meta.prompts.length !== meta.protocolRounds) {
    diagnostics.push({
      pointer: "/prompts",
      keyword: ARCHIVE_PROTOCOL_ROUNDS_KEYWORD,
      message: `协议迭代轮数写了 ${meta.protocolRounds},而逐轮 prompt 有 ${meta.prompts.length} 条`,
    });
  }

  const version = rulesetProvenanceDiagnostic(
    {
      rulesetFileName: `${provenance.loadedRulesetVersion}.json`,
      rulesDocDirName: `rules-${provenance.loadedRulesetVersion}`,
    },
    "/ruleset",
    meta.ruleset,
  );
  if (version !== undefined) {
    diagnostics.push(version);
  }

  return diagnostics;
};

/**
 * 校验一份冻结脚本存档的 `meta.json`。**纯函数**,与 `validateMap` / `validateRuleset`
 * 同一条缝:不读盘、不碰 CLI 退出码。
 *
 * 判据的分工(与另两份同一条原则):**形状**由 ajv 判(缺键 / 错型 / 额外属性都在那里),
 * 跨字段的那些(缺档、哈希、轮数、版本)归装载期断言。它们全部收进同一个
 * `ValidationRejection`,共用同一套两层诊断。
 *
 * 本函数**只交诊断,不交退出码**——退出码语义归引擎脊柱那张票(hld §9 的 `match` 子命令)。
 */
export const validateArchiveMeta = (
  value: JsonValue,
  provenance: ArchiveMetaProvenance,
): ArchiveMetaValidation => {
  if (!checkArchiveMetaShape(value)) {
    return rejectionOf((checkArchiveMetaShape.errors ?? []).map(toMachineDiagnostic));
  }

  // ajv 已经保证十一项齐了且形状正确,故这次认作 `ArchiveMeta` 是安全的。
  const meta = value as ArchiveMeta;
  const diagnostics = archiveMetaDiagnostics(meta, provenance);
  if (diagnostics.length > 0) {
    return rejectionOf(diagnostics);
  }

  return { ok: true, meta };
};

// ── 对局输入物化件 input.json(hld §7.4 末条)──────────────────────────────────

/** 装载方实测的一份存档的文件哈希。缺哪一档由装载方如实报缺档,不在这里留空串。 */
export type MeasuredArchive = {
  readonly scriptSha256: string;
  readonly metaSha256: string;
};

/**
 * 对局输入那一侧的事实。`measuredArchives` 与 `input.json` 里的 `archives` **同序**,
 * 元素为 `null` 表示那个座位的存档缺档(读不到 `script.js` / `meta.json`)。
 *
 * 为什么实测哈希是必填而不是可选:「哈希不符即拒」是复算链的地基(NFR-2),
 * 留一个「没传就跳过」的后门,这条地基就只剩一半。
 */
export type MatchInputProvenance = {
  /** 取值文件名,例如 `v1.json`。与 `input.json` 里声明的 `ruleset` 一起构成三处一致的另两处。 */
  readonly rulesetFileName: string;
  /** 规则文档目录名,例如 `rules-v1`。 */
  readonly rulesDocDirName: string;
  /** 四个座位各自的实测文件哈希,下标即座位号。 */
  readonly measuredArchives: readonly (MeasuredArchive | null)[];
  /** 地图 JSON 的实测 sha256。 */
  readonly measuredMapSha256: string;
};

/**
 * 装载期判据:规则集版本三处一致、四个座位的存档在不在、各文件哈希与实测是否相等、
 * 地图哈希是否相等。**一次收齐**,理由同 `archiveMetaDiagnostics`。
 */
const matchInputDiagnostics = (
  input: MatchInput,
  provenance: MatchInputProvenance,
): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];

  input.archives.forEach((archive, seat) => {
    const measured = provenance.measuredArchives[seat];
    if (measured === undefined || measured === null) {
      // 缺的是整个座位那份存档,与 meta 侧的三件套缺档是同一件事,故同关键字。
      diagnostics.push({
        pointer: `/archives/${seat}`,
        keyword: ARCHIVE_FILES_INCOMPLETE_KEYWORD,
        message: `座位 ${seat} 的存档 ${archive.archivePath} 缺档(读不到 script.js / meta.json)`,
      });
      return;
    }
    if (measured.scriptSha256 !== archive.scriptSha256) {
      diagnostics.push({
        pointer: `/archives/${seat}/scriptSha256`,
        keyword: SHA256_MISMATCH_KEYWORD,
        message:
          `座位 ${seat} 记的 script.js 哈希是 ${archive.scriptSha256},` +
          `实测 ${measured.scriptSha256}`,
      });
    }
    if (measured.metaSha256 !== archive.metaSha256) {
      diagnostics.push({
        pointer: `/archives/${seat}/metaSha256`,
        keyword: SHA256_MISMATCH_KEYWORD,
        message:
          `座位 ${seat} 记的 meta.json 哈希是 ${archive.metaSha256},` +
          `实测 ${measured.metaSha256}`,
      });
    }
  });

  if (provenance.measuredMapSha256 !== input.mapSha256) {
    diagnostics.push({
      pointer: "/mapSha256",
      keyword: SHA256_MISMATCH_KEYWORD,
      message: `记的地图哈希是 ${input.mapSha256},实测 ${provenance.measuredMapSha256}`,
    });
  }

  const version = rulesetProvenanceDiagnostic(provenance, "/ruleset", input.ruleset);
  if (version !== undefined) {
    diagnostics.push(version);
  }

  return diagnostics;
};

/**
 * 校验一份对局输入 `input.json`。**纯函数**,与前三个校验器同一条缝。
 *
 * **它不认赛季配置**:赛季配置归 hld §8,那份文件由 runner 在物化时读,不进这一份。
 * 理由写在 `packages/schema/src/match-input.ts` 的头注里(一句话版:FR-7 AC3 要的是
 * 「每个对局可凭它复算」,而复算一件对局不需要参赛名单与并发度)。
 */
export const validateMatchInput = (
  value: JsonValue,
  provenance: MatchInputProvenance,
): MatchInputValidation => {
  if (!checkMatchInputShape(value)) {
    return rejectionOf((checkMatchInputShape.errors ?? []).map(toMachineDiagnostic));
  }

  // ajv 已经保证四个座位与五项齐了,故这次认作 `MatchInput` 是安全的。
  const input = value as MatchInput;
  const diagnostics = matchInputDiagnostics(input, provenance);
  if (diagnostics.length > 0) {
    return rejectionOf(diagnostics);
  }

  return { ok: true, input };
};

// ── 回放 meta 行(hld §7.5)──────────────────────────────────────────────────────

/**
 * 校验一份回放 JSONL 的**第 1 行 `meta`**(`verify` 的装载期入口)。
 *
 * 形状与耦合的家都在真源包 `packages/schema/src/replay-line.ts`:类型 `ReplayMetaLine`
 * (判别联合)与 JSON Schema `REPLAY_META_LINE_JSON_SCHEMA`(`runner` 与五个沙箱栏的耦合由
 * `if/then` 表达)。本函数是**读入端校验**那一层:纯函数、不读盘、不碰退出码。
 *
 * 与另几个校验器同一条缝:ajv 一层就够,没有跨字段的装载期断言(那类判据是纯结构之外的,
 * 如「meta 的读数与本次执行是否一致」归 `verify`,不在这个纯函数里)。
 */
export const validateReplayMetaLine = (value: JsonValue): ReplayMetaLineValidation => {
  if (!checkReplayMetaShape(value)) {
    return rejectionOf((checkReplayMetaShape.errors ?? []).map(toMachineDiagnostic));
  }

  // ajv 已经保证十三栏齐、类型对、判别耦合成立,故这次认作 `ReplayMetaLine` 是安全的。
  return { ok: true, meta: value as ReplayMetaLine };
};

// ── 回放末行 result(hld §7.5)──────────────────────────────────────────────────

/**
 * 校验一份回放 JSONL 的**末行 `result`**(09 票销掉 `match-result` 那一层所交付的读入端)。
 *
 * 形状与取值域的家都在真源包 `packages/schema/src/replay-line.ts`:类型 `ReplayResultLine`
 * 与 JSON Schema `REPLAY_RESULT_LINE_JSON_SCHEMA`(`reason` 收成四值 `enum`、名次与领土分
 * 都是定长四元组)。本函数是**第三层「读入端校验」**,与前四个校验器同一条缝:纯函数、不读盘、
 * 不碰退出码,接受 / 拒绝的断言落在它自己身上。
 *
 * 与 `validateMap` / `validateRuleset` 不同,这份形状没有跨字段的装载期断言(哈希、版本、
 * 派生量):`rankings` 与 `territoryScores` 的长度、取值域、`reason` 的枚举都在 JSON Schema 的
 * 表达力之内,ajv 一层就够。真要出下一层(例如「已淘汰者领土分恒为 0」),它也应落在这里,而不是
 * 在某个包内再写一份形状 if——那才是第二真源(见头注第 3 条)。
 *
 * **它目前还没有生产调用点**:`modelwar replay` 的读盘渲染器住在 `@model-war/replay`,而
 * `packages/replay` 的依赖方向是 `schema ← replay`、**不能**反向依赖持有 ajv 的 `apps/cli`
 * (`hld §3.2`)。接线归哪一票、以什么形态接,记在 09 票的 `## Answer` 里;本函数先把「第三层」
 * 交付出来,它与 `validator.test.ts` 的断言就是这句话的机器形态。
 */
export const validateReplayResultLine = (value: JsonValue): ReplayResultLineValidation => {
  if (!checkReplayResultShape(value)) {
    return rejectionOf((checkReplayResultShape.errors ?? []).map(toMachineDiagnostic));
  }

  // ajv 已经保证三栏齐、类型对、取值域在枚举内,故这次认作 `ReplayResultLine` 是安全的。
  return { ok: true, result: value as ReplayResultLine };
};
