/**
 * 回放 JSONL **行**的形状(hld §7.5:第 1 行 `meta` / 第 n 行 `tick` / 末行 `result`)。
 * **类型与 JSON Schema 同文件、同一次书写**,纪律与 `map.ts` 一致
 * (ADR-0003:TypeScript 是真源,JSON Schema 手工对齐)。
 *
 * ── 这一格为什么现在能定死 ────────────────────────────────────────────────────
 *
 * `pending.ts` 原来挂着 `replay-line`,理由是「字段随那一票的实现才确定」。而那三项栏已经被
 * hld §7.5 **逐项列全**,写出侧也已经在写它了(引擎的 `buildMetaLine` / `buildTickLine`),
 * 于是「字段还可能变」这件事已经不成立了——它已经变完了,只是没落库。故本票(02b)销账。
 *
 * ── 行的形状归本包,编解码归 `replay` 包(hld §7.5 末段)─────────────────────────
 *
 * 那一格曾经有两个家(§2.2.5 说形状在真源包、§3.1 说行格式取自 `replay` 包),按「每个事实
 * 只有一个家」留在本包:`replay` 包只做编解码 + 回放**文件格式版本**常量,不再声明行类型。
 *
 * ── meta 行用判别联合,不用「四个可空键」─────────────────────────────────────────
 *
 * 四个沙箱栏(QuickJS 版本 / 运行时 hash / WASI 时钟 / 确定性随机填值)在桩执行器下恒为
 * `null`——「未发生」必须与「恰好是空串」分得开。写成 `string | null` 的四个可选键,
 * 「桩那一支**没有**读数可填」这件事就退化成一个约定;写成判别联合之后,它在**类型上**
 * 无法表达错:`runner: "stub"` 那一支上四个栏只能是 `null`,填别的值编译不过。
 *
 * ── tick 行的嵌套列:形状在两处,对应关系由机器钉住 ─────────────────────────────
 *
 * `players` / `units` / `sites` / `events` 四列的元素形状,它们的**内存形状**归
 * `packages/engine/src/world/state.ts` 与 `packages/engine/src/processor/events.ts`
 * (状态模型那一格);而**行格式**归本文件。同一份栏位清单因此在两处各写一次——
 * 代价明写在这里,兜底是 `packages/engine/src/replay-line.test.ts` 那条**双向可赋值断言**:
 * 状态模型多一栏、少一栏或改一栏型,那条用例当场红。「两份」在这一格是**由编译器兜住的
 * 两份**,不是靠自觉同步的两份。
 *
 * ── 末行 `result` 的 `reason` 刻意只约束成字符串 ───────────────────────────────
 *
 * `rankings` / `reason` / `territoryScores` 三栏是 hld §7.5 逐字列出的,故本文件把它们定死;
 * 而**终局原因的取值域与名次语义**归 `match-result`(pending 那一条,留给 09 票定稿)。
 * 在它定稿之前把四个取值抄进本文件,就是给一个还没定稿的事实写第二个家。
 */

import type { RulesetVersion } from "./index.js";

/** 座位号。固定 0..3;它是**编号**不是参数。meta 行的 `players[]` 与 `rankings[]` 都按下标认座位。 */
export type ReplaySeat = 0 | 1 | 2 | 3;

/** 一个座位在 meta 行里的三栏。`archiveRef` 指向冻结脚本存档目录 `archive/<modelSlug>/<runId>/`。 */
export type ReplayPlayerRef = {
  readonly model: string;
  readonly archiveRef: string;
  readonly seat: ReplaySeat;
};

/** meta 行除执行器读数之外的那些栏(与 `runner` 那一支合起来是十二栏)。 */
type ReplayMetaCommon = {
  readonly type: "meta";
  /** 回放**文件格式**的版本(不是行形状的版本);取值由 `replay` 包的 `CURRENT_SCHEMA_VERSION` 提供。 */
  readonly schemaVersion: number;
  readonly ruleset: RulesetVersion;
  readonly timezoneOffset: string;
  readonly mapHash: string;
  readonly seed: number;
  /** 四方参赛者,下标即座位号。 */
  readonly players: readonly ReplayPlayerRef[];
};

/**
 * meta 行:十二栏,`runner` 是判别式。
 *
 * `stateHashOf` 的规范化序列化按**对象键升序**遍历,所以这一栏在文件里的书写顺序
 * (hld §7.5 的列出顺序)与哈希无关:哈希那侧自己会排。书写顺序归写出侧(引擎的 `buildMetaLine`),
 * 那一处的用例钉住了它。
 */
export type ReplayMetaLine = ReplayMetaCommon &
  (
    | {
        readonly runner: "stub";
        readonly quickjsWasiVersion: null;
        readonly sandboxRuntimeHash: null;
        readonly wasiClock: null;
        readonly wasiRandomFill: null;
      }
    | {
        readonly runner: "quickjs";
        readonly quickjsWasiVersion: string;
        readonly sandboxRuntimeHash: string;
        readonly wasiClock: string;
        readonly wasiRandomFill: string;
      }
  );

/** tick 行里的一个玩家。`exceptionTicks` 随 JSONL 持久化,VM 重建后由持久化值续算(hld §5.2)。 */
export type ReplayPlayer = {
  readonly index: ReplaySeat;
  readonly resources: number;
  readonly alive: boolean;
  readonly exceptionTicks: number;
};

/** tick 行里的一个单位。农民携带量在 `carrying`,其余兵种恒 0。 */
export type ReplayUnit = {
  readonly id: number;
  readonly owner: ReplaySeat;
  readonly type: ReplayUnitType;
  readonly x: number;
  readonly y: number;
  readonly hp: number;
  readonly carrying: number;
};

/** 四条兵种线。与规则集那四个键同名——它们是同一个封闭集合的两处投影,故逐字对齐。 */
export type ReplayUnitType = "worker" | "melee" | "ranged" | "cavalry";

/** 一条产线当前的订单。挂在点位上,不是一张独立的队列表(hld §4.1)。 */
export type ReplaySiteProduction = {
  readonly type: ReplayUnitType;
  readonly remainingTicks: number;
};

/** tick 行里的一个点位。`owner` 与 `progressOwner` 为 `-1` 表示中立。 */
export type ReplaySite = {
  readonly id: number;
  readonly kind: "base" | "resource";
  readonly x: number;
  readonly y: number;
  readonly owner: number;
  readonly progressOwner: number;
  readonly progress: number;
  /** 仅资源点有:这个矿还剩多少资源。「不是资源点」与「已采空」用「键不存在」与 `0` 分开。 */
  readonly remaining?: number;
  readonly producing: ReplaySiteProduction | null;
};

/** 八种事件(hld §7.5)。名字是回放与战报共同读的,所以一个都不能改写。 */
export type ReplayEventKind =
  | "exception"
  | "budget-soft-warning"
  | "first-contact"
  | "unit-destroyed"
  | "site-captured"
  | "economy-dead"
  | "player-eliminated"
  | "victory";

/**
 * tick 行里的一条事件。
 *
 * `subjectId` 是它的**定序主体**:单位级事件取单位 id、点位级取点位 id、玩家级取座位号。
 * 其余字段随各自的机制票(04–09)回填——那时本类型加栏,引擎侧的 `Event` 跟着加栏,
 * 两侧由 `packages/engine/src/replay-line.test.ts` 那条双向可赋值断言盯着。
 */
export type ReplayEvent = {
  readonly kind: ReplayEventKind;
  readonly subjectId: number;
};

/**
 * tick 行的载荷:**整行去掉 `stateHash` 自身**(hld §4.6)。
 *
 * 单独导出是因为 `stateHash` 是「载荷的摘要」这句话的字面结构:摘要在载荷之外,于是载荷本身
 * 也是一份可被引用的形状(写出侧算哈希用、读入端复核哈希用)。
 */
export type ReplayTickPayload = {
  readonly type: "tick";
  readonly tick: number;
  readonly players: readonly ReplayPlayer[];
  readonly units: readonly ReplayUnit[];
  readonly sites: readonly ReplaySite[];
  readonly events: readonly ReplayEvent[];
};

/** tick 行 = 载荷 + 摘要。`stateHash` 是**最后**一栏,因为它是前头所有栏的摘要。 */
export type ReplayTickLine = ReplayTickPayload & {
  readonly stateHash: string;
};

/**
 * 末行 `result`。三栏逐字来自 hld §7.5。
 *
 * `reason` 的**取值域**归 `match-result`(pending 那一条),本票只落「有这一栏、它是字符串」。
 * `rankings[i]` 是玩家 i 的名次(1 起、可并列)。
 */
export type ReplayResultLine = {
  readonly type: "result";
  readonly rankings: readonly number[];
  readonly reason: string;
  readonly territoryScores: readonly number[];
};

/** 回放里出现的三种行。写盘侧逐行产出,读盘侧按 `type` 分派。 */
export type ReplayLine = ReplayMetaLine | ReplayTickLine | ReplayResultLine;

// ── JSON Schema ───────────────────────────────────────────────────────────────

/** 键序即 `required` 序、`meta.json` 之类的书写序,不容另定一处。 */
const META_REQUIRED_KEYS = [
  "type",
  "schemaVersion",
  "ruleset",
  "quickjsWasiVersion",
  "sandboxRuntimeHash",
  "wasiClock",
  "wasiRandomFill",
  "timezoneOffset",
  "mapHash",
  "seed",
  "players",
  "runner",
] as const;

const TICK_REQUIRED_KEYS = [
  "type",
  "tick",
  "players",
  "units",
  "sites",
  "events",
  "stateHash",
] as const;

const RESULT_REQUIRED_KEYS = ["type", "rankings", "reason", "territoryScores"] as const;

/** sha256 的形状:小写十六进制 64 位。与另两份形状里的那一份同义,故逐字相同。 */
const SHA256 = {
  type: "string",
  pattern: "^[0-9a-f]{64}$",
} as const;

/** 座位号:`0..3` 的定长四元组。四人对称,故写死四而不是「数组 + 长度断言」。 */
const SEAT = {
  enum: [0, 1, 2, 3],
} as const;

/** 点位属主:座位或中立(`-1`)。取值域比座位宽一格。 */
const OWNER = {
  type: "integer",
  minimum: -1,
  maximum: 3,
} as const;

const PLAYER_REF = {
  type: "object",
  additionalProperties: false,
  required: ["model", "archiveRef", "seat"],
  properties: {
    model: { type: "string", minLength: 1, description: "模型名。" },
    archiveRef: {
      type: "string",
      minLength: 1,
      description: "冻结脚本存档目录 archive/<modelSlug>/<runId>/ 的引用。",
    },
    seat: { ...SEAT, description: "座位号;与数组下标一致(下标即座位)。" },
  },
} as const;

const REPLAY_PLAYER = {
  type: "object",
  additionalProperties: false,
  required: ["index", "resources", "alive", "exceptionTicks"],
  properties: {
    index: SEAT,
    resources: { type: "integer", description: "资源池余额,全整数。" },
    alive: { type: "boolean", description: "是否尚存(未满足 gdd 的淘汰条件)。" },
    exceptionTicks: {
      type: "integer",
      minimum: 0,
      description: "累计异常 tick 数;随 JSONL 持久化,VM 重建后由持久化值续算(hld §5.2)。",
    },
  },
} as const;

const REPLAY_UNIT = {
  type: "object",
  additionalProperties: false,
  required: ["id", "owner", "type", "x", "y", "hp", "carrying"],
  properties: {
    id: { type: "integer", description: "全局单调递增的对象号(含被销毁对象)。" },
    owner: SEAT,
    type: {
      enum: ["worker", "melee", "ranged", "cavalry"],
      description: "四条兵种线之一,与规则集那四个键同名。",
    },
    x: { type: "integer", description: "网格坐标 x。" },
    y: { type: "integer", description: "网格坐标 y。" },
    hp: { type: "integer", description: "剩余血量,全整数。" },
    carrying: { type: "integer", minimum: 0, description: "农民携带量;其余兵种恒 0。" },
  },
} as const;

const REPLAY_SITE_PRODUCTION = {
  type: "object",
  additionalProperties: false,
  required: ["type", "remainingTicks"],
  properties: {
    type: { enum: ["worker", "melee", "ranged", "cavalry"] },
    remainingTicks: { type: "integer", minimum: 0, description: "这一单还剩几个 tick。" },
  },
} as const;

const REPLAY_SITE = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "x", "y", "owner", "progressOwner", "progress", "producing"],
  properties: {
    id: { type: "integer" },
    kind: { enum: ["base", "resource"] },
    x: { type: "integer" },
    y: { type: "integer" },
    owner: { ...OWNER, description: "属主;-1 为中立。" },
    progressOwner: { ...OWNER, description: "占领进度当前归属方;-1 为中立。" },
    progress: { type: "integer", minimum: 0, description: "占领进度。" },
    remaining: {
      type: "integer",
      minimum: 0,
      description: "仅资源点有:矿还剩多少。键不存在 = 不是资源点,与「已采空(0)」是两件事。",
    },
    producing: {
      description: "这一条产线当前的订单,没有订单时为 null。",
      oneOf: [{ type: "null" }, REPLAY_SITE_PRODUCTION],
    },
  },
} as const;

const REPLAY_EVENT = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "subjectId"],
  properties: {
    kind: {
      enum: [
        "exception",
        "budget-soft-warning",
        "first-contact",
        "unit-destroyed",
        "site-captured",
        "economy-dead",
        "player-eliminated",
        "victory",
      ],
      description: "八种事件之一(hld §7.5)。名字是回放与战报共同读的,改一个即改一份存档格式。",
    },
    subjectId: {
      type: "integer",
      description: "定序主体:单位级取单位 id、点位级取点位 id、玩家级取座位号。",
    },
  },
} as const;

/**
 * meta 行的 JSON Schema(hld §2.2.5)。十二栏全必填,`additionalProperties: false`。
 *
 * **`runner` 与四个沙箱栏的耦合由 `allOf` + `if/then` 表达**,与类型侧的判别联合同一条纪律:
 * 桩执行器那一支上四栏只能是 `null`(「未发生」与「恰好是空串」要能区分),真沙箱那一支上
 * 四栏都必须是字符串。JSON Schema 表达不了 `oneOf` 那种「联合的联合」,但 `if/then` 够用。
 */
// `then` 在这里是 **JSON Schema 的关键字**(if/then/else),不是「一个可 awaited 的对象」——
// oxlint 的 `unicorn/no-thenable` 会把它读成 thenable。本仓用 if/then 表达「按判别字段分栏」
// (桩那一支四个沙箱栏必须是 null),禁掉它等于禁掉 JSON Schema 的一部分,故整块关掉。
/* oxlint-disable unicorn/no-thenable */
export const REPLAY_META_LINE_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "model-war 回放 meta 行",
  description:
    "回放 JSONL 的第 1 行(hld §7.5):十二栏。四个沙箱栏在桩执行器下为 null," +
    "真沙箱下为字符串;这一层耦合由 if/then 表达,与类型侧的判别联合同一条纪律。",
  type: "object",
  additionalProperties: false,
  required: META_REQUIRED_KEYS,
  properties: {
    type: { enum: ["meta"] },
    schemaVersion: { type: "integer", minimum: 1, description: "回放文件格式版本(FR-9 AC2)。" },
    ruleset: {
      type: "string",
      pattern: "^v[0-9]+$",
      description: "本对局所用的规则集版本(与三处版本一致,hld §7.1)。",
    },
    quickjsWasiVersion: {
      type: ["string", "null"],
      description: "QuickJS WASI 版本;桩执行器下为 null。",
    },
    sandboxRuntimeHash: {
      ...SHA256,
      description: "沙箱运行时 hash;桩执行器下为 null(不写空串:「未发生」要与「空串」分得开)。",
    },
    wasiClock: { type: ["string", "null"], description: "WASI 时钟读数;桩执行器下为 null。" },
    wasiRandomFill: {
      type: ["string", "null"],
      description: "WASI 确定性随机填值;桩执行器下为 null。",
    },
    timezoneOffset: { type: "string", minLength: 1, description: "装载时的时区偏移。" },
    mapHash: { ...SHA256, description: "地图 JSON 的 sha256。" },
    seed: { type: "integer", minimum: 0, description: "种子。" },
    players: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      description: "四方参赛者,下标即座位号。",
      items: PLAYER_REF,
    },
    runner: {
      enum: ["stub", "quickjs"],
      description:
        "这一局是谁跑的。两者产出的回放在结构上无法区分,而沙箱行为类结论只在真沙箱上成立," +
        "所以它是数据而不是文件名约定。",
    },
  },
  allOf: [
    {
      if: { properties: { runner: { enum: ["stub"] } }, required: ["runner"] },
      then: {
        properties: {
          quickjsWasiVersion: { type: "null" },
          sandboxRuntimeHash: { type: "null" },
          wasiClock: { type: "null" },
          wasiRandomFill: { type: "null" },
        },
      },
    },
    {
      if: { properties: { runner: { enum: ["quickjs"] } }, required: ["runner"] },
      then: {
        properties: {
          quickjsWasiVersion: { type: "string", minLength: 1 },
          sandboxRuntimeHash: SHA256,
          wasiClock: { type: "string", minLength: 1 },
          wasiRandomFill: { type: "string", minLength: 1 },
        },
      },
    },
  ],
} as const;
/* oxlint-enable unicorn/no-thenable */

/**
 * tick 行的 JSON Schema(hld §7.5 的「第 n 行」)。
 *
 * `stateHash` 是**载荷**(整行去掉它自己)的摘要,故它必填;「它等于载荷的摘要」是**跨行**判据,
 * draft-07 表达不了,归读入端的复核(hld §4.6 与 `modelwar verify`)。
 */
export const REPLAY_TICK_LINE_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "model-war 回放 tick 行",
  description:
    "回放 JSONL 的第 n 行(hld §7.5):足以绘制完整画面的状态 + 事件 + stateHash。" +
    "数组顺序本身就是状态的一部分(不变量:units/sites 按数值 id 升序维护),故本 schema 不排任何序。",
  type: "object",
  additionalProperties: false,
  required: TICK_REQUIRED_KEYS,
  properties: {
    type: { enum: ["tick"] },
    tick: { type: "integer", minimum: 0, description: "这一行结算完的那一 tick。" },
    players: { type: "array", items: REPLAY_PLAYER, description: "四方状态,下标即座位号。" },
    units: {
      type: "array",
      description: "全部单位,按数值 id 升序。顺序是状态的一部分:哈希那侧保序不重排。",
      items: REPLAY_UNIT,
    },
    sites: { type: "array", description: "全部点位,按数值 id 升序。", items: REPLAY_SITE },
    events: {
      type: "array",
      description:
        "这一 tick 的事件流,已按「产出它的那一步 → 步内按对象数值 id 升序」定全序(hld §7.5)。",
      items: REPLAY_EVENT,
    },
    stateHash: { ...SHA256, description: "载荷(整行去掉这一栏)的规范化摘要(hld §4.6)。" },
  },
} as const;

/**
 * 末行 `result` 的 JSON Schema(hld §7.5)。
 *
 * `rankings` 与 `territoryScores` 定长四元组(下标即座位);`reason` 只约束成字符串——
 * **取值域归 `match-result`**(pending 那一条),在它定稿之前不把四个取值抄进来。
 */
export const REPLAY_RESULT_LINE_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "model-war 回放 result 行",
  description:
    "回放 JSONL 的末行(hld §7.5):名次、终局原因、领土分。reason 的取值域与名次语义归 " +
    "match-result(尚未定稿),本 schema 只落行格式。",
  type: "object",
  additionalProperties: false,
  required: RESULT_REQUIRED_KEYS,
  properties: {
    type: { enum: ["result"] },
    rankings: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      description: "名次,下标即座位号,取值 1 起、可并列(gdd《胜利与淘汰》)。",
      items: { type: "integer", minimum: 1 },
    },
    reason: { type: "string", minLength: 1, description: "终局原因;取值域见 match-result。" },
    territoryScores: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      description: "领土分,下标即座位号(gdd《胜利与淘汰》的那条公式)。",
      items: { type: "integer", minimum: 0 },
    },
  },
} as const;
