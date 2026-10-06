/**
 * 21 个参数键的机器可读清单:13 个定稿键(handoff §1)+ 8 个预算键(handoff §2.1)。
 *
 * ── 为什么是 21 而不是 22(一处上游笔误,如实记在这里) ──
 *
 * spec 与 DAG 节点表都写「22 键 = 13 定稿 + 9 预算」,但同一份 handoff §2.1 的表只有 9 **行**,
 * 其中一行是「内存软阈 = 0.8 × `memoryTickCeiling`」,并明写「推导项,**入表不入 schema**」。
 * 也就是说 9 这个数把一个**派生展示项**当成预算键数了一遍。hld §5.3 收口句列的上限取值恰好
 * 8 项(事件计数上限、API 上限、`memoryLimit`、`memoryTickCeiling`、墙钟软限、墙钟硬超时、
 * `exceptionTickLimit`、脚本体积上限),与本清单的 8 个预算键一一对应;仓库里**不存在**第 9 个
 * 预算取值(中断计数粒度与 WASI 三件套按 spec《常量表的边界》归沙箱执行器,不是键)。
 * 故键清单落 21 个。数目写死在这里而不是留给读者心算:将来真出现第 9 个预算键,改这一处即可。
 *
 * ── 一条 AC 清单怎么转成机器可读的东西 ──
 *
 * 每个键带四样东西:它的 **JSON 值类型**、**量纲**、**取值范围**、以及**它在 JSON Schema 里的定义**。
 * 最后那项是关键:它让「键清单」与「规则集 JSON Schema 的 `properties`」由**同一次书写**产生,
 * 而不是两处各写一遍(手写对齐的失败模式从来不是「写不出来」,是「改一处忘了另一处」)。
 * `ruleset.ts` 只做一次 `Object` 投影,于是两处不可能错位。
 *
 * ── 「未定值」是判别式的,不是一个标志位 ──
 *
 * `calibration` 是个两态判别联合:预算键取 `{ state: "undetermined", placeholder: 0 }`。
 * 面向模型的规则文档(E 节点的生成物)据此把**该键的取值渲染成「未定」而不是数字**——判据是键
 * 自己身上那个 `state`,不是「值是不是 0」。这一点必须能区分:`0` 在别的键上完全可能是一个
 * 真的取值(例如终值标定后某个预算上限就是 0),而 CONTEXT.md 的「未定值」词条也只认
 * 「机制已定、终值归后续图」这一种情形。缺键**不是**未定值——缺键是 `required` 缺失,另一种错误。
 *
 * 占位值取 `0` 且 `placeholder` 的类型被钉成字面量 `0`:把占位改成别的数会**编译不过**,
 * 而「改成一个别的数」正是这类占位最典型的腐化方式。
 *
 * ── 本文件里的 `handoff §…` 是一律历史出处,不是当前依据 ──
 *
 * 标定环那份一次性交接单(`.scratch/rules-calibration/handoff.md`)**已作废**(它搬运的三样东西
 * 各自落库之后就没有第二个家了)。下面若干处引用它,记的是「这个键当初是被谁裁定的」这桩来历,
 * **不构成对当前事实的引用**:取值真源只有 `rulesets/vN.json`,含义与意图归 gdd《参数清单》,
 * 键的数目口径归 hld §5.3 / 本文件下面那段「为什么是 21」。要改键,改这里,不回那份单子。
 */

/**
 * 占位取值(未定值)。取 `0` 是上游裁定(handoff §2.1 / CONTEXT.md「未定值」):
 * 语义是**未定**而不是「零预算」,因此它不参与任何判罚逻辑,只影响文档怎么渲染。
 * 之所以仍然要求这些键**必填**,是为了不给 K 节点留一次「加必填」的破坏性 schema 变更。
 */
export const UNDETERMINED_VALUE = 0;

/** 一个键的量纲。取值本身不含数字——**取值归 `rulesets/vN.json`**,本清单只定义叫什么、什么形状。 */
export type RulesetKeyUnit =
  /** tick 数。 */
  | "tick"
  /** 资源。 */
  | "resources"
  /** 每 tick 的资源。 */
  | "resources/tick"
  /** 单个资源点的资源。 */
  | "resources/site"
  /** 兵种对象:量纲在它的六个子字段上,不在这一层。 */
  | "unit"
  /** 终局分。 */
  | "score"
  /** 除数(自身无量纲,由它算出的分有量纲)。 */
  | "divisor"
  /** 次,整局累计。 */
  | "exceptions"
  /** 次/tick(控制流事件)。 */
  | "events/tick"
  /** 次/tick(API 调用)。 */
  | "calls/tick"
  /** bytes。 */
  | "bytes"
  /** 毫秒。 */
  | "milliseconds";

/**
 * 键的 JSON 值类型。与 `ruleset.ts` 的 `Ruleset` 类型、规则集 JSON Schema 的 `properties`
 * 说的是同一件事(TS 类型 → JSON Schema 手工对齐,ADR-0003),三者的错位由类型级断言抓住。
 */
export type RulesetValueType =
  /** 非负整数。 */
  | "integer"
  /** 兵种对象 `{cost, hp, damage, range, speed, spawnTicks}`。 */
  | "unit-stats";

/**
 * 一个键的标定状态。**判别式而不是布尔标志**:下游(面向模型的规则文档生成器)要做的是
 * 「把这个键的取值渲染成「未定」还是渲染成数字」,而这件事只由 `state` 决定。
 *
 * 变成 `final` 的时机是唯一的:K 节点标定完预算终值时,把这 8 条一次改掉,
 * 文档渲染与取值文件一起跟着变——不需要另设一个布尔字段,也不会两处忘记改。
 */
export type RulesetKeyCalibration =
  /** 终值已定。 */
  | { readonly state: "final" }
  /**
   * **未定值**:机制已定、终值交给后续的图。取值文件里必填、当前取 `placeholder`。
   * 「缺键」不是这一态——缺键是另一种错误(见 `ruleset.ts` 的 `required`)。
   */
  | { readonly state: "undetermined"; readonly placeholder: 0 };

/**
 * JSON Schema 片段的最小类型。**刻意手写而不是从 ajv 取 `JSONSchemaType`**:
 * 真源包不依赖任何包(hld §3.2 的依赖门禁 `schema-has-no-dependencies`),ajv 的类型是那个包的一部分。
 * 用到的关键词就这几个,写全它们比引入一条依赖便宜;真写错形状(比如 `additionalProperties` 打成
 * `true`)由 `apps/cli` 那侧的 ajv 编译与键集合断言兜住,不是靠这一层类型。
 */
export type RulesetKeySchema =
  | {
      readonly type: "integer";
      readonly description: string;
      readonly minimum: number;
    }
  | {
      readonly type: "object";
      readonly description: string;
      readonly additionalProperties: false;
      readonly required: readonly string[];
      readonly properties: { readonly [field: string]: RulesetKeySchema };
    };

/** 一个键的完整清单条目。四个字段各有各的消费者,缺一个就有下游拿不到东西。 */
export type RulesetKeyEntry = {
  /** JSON 值类型。与 `Ruleset` 类型、JSON Schema `properties` 三处对齐。 */
  readonly valueType: RulesetValueType;
  /** 量纲。写给模型看的:「次数」与「毫秒」在提示词里的含义完全不同。 */
  readonly unit: RulesetKeyUnit;
  /**
   * 取值下界。`integer` 键必给;`unit-stats` 键不给(范围在六个子字段上,给一个假的顶层下界
   * 只会让人以为对象也有大小写)。今天所有键都没有上界:上界要么无意义(资源),要么由别的
   * 跨字段关系决定(例如 `memoryTickCeiling` 须低于读数封顶),JSON Schema 表达不了跨字段关系。
   */
  readonly minimum?: number;
  /** 标定状态。见 `RulesetKeyCalibration`。 */
  readonly calibration: RulesetKeyCalibration;
  /** 面向模型的说明,直接成为 JSON Schema 的 `description`(同一次书写,不留第二份文案)。 */
  readonly description: string;
  /** 该键在规则集 JSON Schema 里的定义。 */
  readonly schema: RulesetKeySchema;
};

/**
 * 四条兵种线的子字段定义。四处(`worker`/`melee`/`ranged`/`cavalry`)共用同一份字段表:
 * 它们是**同一种对象**的四个实例,不是四种形状——各自写一遍就是给「同一形状」造了四份真源。
 */
const UNIT_STATS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description: "兵种属性。六字段全必填,禁止额外属性。",
  required: ["cost", "hp", "damage", "range", "speed", "spawnTicks"],
  properties: {
    cost: { type: "integer", minimum: 1, description: "造价(资源)。" },
    hp: { type: "integer", minimum: 1, description: "生命值。" },
    damage: {
      type: "integer",
      minimum: 0,
      description: "单次攻击伤害。0 = 无攻击能力(农民),所以下界是 0 而不是 1。",
    },
    range: { type: "integer", minimum: 0, description: "射程(格,Chebyshev 距离)。" },
    speed: { type: "integer", minimum: 1, description: "每 tick 移动的格数。" },
    spawnTicks: {
      type: "integer",
      minimum: 1,
      description:
        "生产耗时(tick)。**双存键**:它同时由 `⌈cost × SPAWN_TICKS_COEFFICIENT⌉` 决定," +
        "取值文件里写错这个数会在装载期被拒(派生量断言,不是文档约定)。",
    },
  },
} as const satisfies RulesetKeySchema;

/** 一条兵种线在清单里的条目。四个实例共用字段表,只有 `description` 不同。 */
const unitLine = (description: string): RulesetKeyEntry => ({
  valueType: "unit-stats",
  unit: "unit",
  calibration: { state: "final" },
  description,
  schema: UNIT_STATS_SCHEMA,
});

/**
 * 键清单本体。**这是 21 个键的唯一出处**:键名、值类型、量纲、范围、标定状态、说明、
 * 以及它在 JSON Schema 里的定义,全部由这一份对象字面量产生。
 *
 * 键序即 `rulesets/vN.json` 里键的书写序,也就是生成物 `docs/rules-vN` 数值表的行序——
 * 数值表由它生成,行序不该另定一处。
 */
export const RULESET_KEY_CATALOG = {
  // ── 13 个定稿键(handoff §1)──────────────────────────────────────────────────
  tickLimit: {
    valueType: "integer",
    unit: "tick",
    minimum: 1,
    calibration: { state: "final" },
    description: "对局上限(总 tick 数)。超时走终局名次结算,不由超时判负。",
    schema: { type: "integer", minimum: 1, description: "对局上限(总 tick 数)。" },
  },
  captureTicks: {
    valueType: "integer",
    unit: "tick",
    minimum: 1,
    calibration: { state: "final" },
    description:
      "占领一个点位所需的累积 tick。基地与资源点**统一单值**,不分类型(gdd《地图与点位》)。",
    schema: {
      type: "integer",
      minimum: 1,
      description: "占领一个点位所需的累积 tick。基地与资源点统一单值。",
    },
  },
  initialResources: {
    valueType: "integer",
    unit: "resources",
    minimum: 0,
    calibration: { state: "final" },
    description:
      "开局资金。保证 tick 0 就能在「补经济」与「补兵」之间作选择;下界取 0(开局一无所有是自洽的)。",
    schema: { type: "integer", minimum: 0, description: "开局资金(资源)。" },
  },
  harvestRate: {
    valueType: "integer",
    unit: "resources/tick",
    minimum: 1,
    calibration: { state: "final" },
    description: "单个农民在一个有效采集 tick 里获得的资源量。",
    schema: { type: "integer", minimum: 1, description: "单个农民每有效采集 tick 获得的资源量。" },
  },
  carryLimit: {
    valueType: "integer",
    unit: "resources",
    minimum: 1,
    calibration: { state: "final" },
    description:
      "单个农民可携带的资源上限;满载一次需 `⌈carryLimit ÷ harvestRate⌉` 个有效采集 tick。",
    schema: { type: "integer", minimum: 1, description: "单个农民可携带的资源上限。" },
  },
  resourcePerSite: {
    valueType: "integer",
    unit: "resources/site",
    minimum: 1,
    calibration: { state: "final" },
    description: "单个资源点的总储量。与 `tickLimit` 共同决定枯竭压力是否真实存在。",
    schema: { type: "integer", minimum: 1, description: "单个资源点的总储量(资源)。" },
  },
  worker: unitLine("农民:无攻击能力,全图最脆弱的高价值目标。"),
  melee: unitLine("近战:性价比标杆。"),
  ranged: unitLine("远程:阵地输出,贴身即溃。"),
  cavalry: unitLine("骑兵:价值全部来自速度。"),
  baseScore: {
    valueType: "integer",
    unit: "score",
    minimum: 1,
    calibration: { state: "final" },
    description: "每控制一个主基地的终局分。",
    schema: { type: "integer", minimum: 1, description: "每控制一个主基地的终局分。" },
  },
  resourceScore: {
    valueType: "integer",
    unit: "score",
    minimum: 1,
    calibration: { state: "final" },
    description: "每控制一个资源点的终局分。",
    schema: { type: "integer", minimum: 1, description: "每控制一个资源点的终局分。" },
  },
  unitCostDivisor: {
    valueType: "integer",
    unit: "divisor",
    minimum: 1,
    calibration: { state: "final" },
    description: "存活单位总造价分的除数:该项加分为 `⌊Σ 存活单位造价 ÷ unitCostDivisor⌋`(分)。",
    schema: {
      type: "integer",
      minimum: 1,
      description: "存活单位总造价分的除数(下限 1:除数不得为 0,否则该项分无法计算)。",
    },
  },

  // ── 8 个预算键(handoff §2.1;第 9 行「内存软阈」是派生展示项,明令不入键清单)──────
  // 它们在 M1 阶段全部必填、取未定值:机制已定,终值归《预算与性能终值》图(K 节点)。
  exceptionTickLimit: {
    valueType: "integer",
    unit: "exceptions",
    minimum: 0,
    calibration: { state: "undetermined", placeholder: UNDETERMINED_VALUE },
    description: "累计异常判负阈值(次/整局)。达它则该方判负出局,点位回归中立。",
    schema: {
      type: "integer",
      minimum: 0,
      description: "累计异常判负阈值(次/整局)。M1 阶段为未定值。",
    },
  },
  eventTickLimit: {
    valueType: "integer",
    unit: "events/tick",
    minimum: 0,
    calibration: { state: "undetermined", placeholder: UNDETERMINED_VALUE },
    description:
      "单 tick 的控制流事件计数上限(次/tick):以循环回边 / 函数调用 / 函数返回为一格累计。" +
      "达顶则本 tick 该方 intents 全部丢弃并计一次异常。",
    schema: {
      type: "integer",
      minimum: 0,
      description: "单 tick 的控制流事件计数上限(次/tick)。M1 阶段为未定值。",
    },
  },
  apiCallTickLimit: {
    valueType: "integer",
    unit: "calls/tick",
    minimum: 0,
    calibration: { state: "undetermined", placeholder: UNDETERMINED_VALUE },
    description:
      "单 tick 的 API 调用计数上限(次/tick)。与控制流事件计数互为盲区:前者抓纯计算死循环," +
      "后者抓 API 轰炸。",
    schema: { type: "integer", minimum: 0, description: "单 tick 的 API 调用计数上限(次/tick)。" },
  },
  memoryLimit: {
    valueType: "integer",
    unit: "bytes",
    minimum: 0,
    calibration: { state: "undetermined", placeholder: UNDETERMINED_VALUE },
    description: "VM 线性内存的分配上限(bytes)。上限本身不可突破,超限转成可捕获的 JS 异常。",
    schema: { type: "integer", minimum: 0, description: "VM 线性内存的分配上限(bytes)。" },
  },
  memoryTickCeiling: {
    valueType: "integer",
    unit: "bytes",
    minimum: 0,
    calibration: { state: "undetermined", placeholder: UNDETERMINED_VALUE },
    description:
      "内存判据的判罚线(bytes):每 tick 末 `runGC()` 后的存活堆读数达它即视同一次异常。" +
      "软阈是它的 `MEMORY_SOFT_THRESHOLD_RATIO` 倍,是**纯展示项**、不入键清单。",
    schema: {
      type: "integer",
      minimum: 0,
      description: "内存判据的判罚线(bytes,tick 末存活堆读数)。",
    },
  },
  wallClockSoftLimit: {
    valueType: "integer",
    unit: "milliseconds",
    minimum: 0,
    calibration: { state: "undetermined", placeholder: UNDETERMINED_VALUE },
    description:
      "单 tick `loop()` 的墙钟软限(ms)。**只观测**:写进观测文件披露,不参与判罚,也不进回放。",
    schema: { type: "integer", minimum: 0, description: "单 tick loop() 的墙钟软限(ms,只观测)。" },
  },
  wallClockHardTimeout: {
    valueType: "integer",
    unit: "milliseconds",
    minimum: 0,
    calibration: { state: "undetermined", placeholder: UNDETERMINED_VALUE },
    description:
      "墙钟硬超时(ms),**只作废该场**:标记 `nondeterministic-timeout` 后按重跑 / 剔除处理," +
      "不判负(墙钟受机器负载影响,参与判罚会破坏可复算性)。",
    schema: { type: "integer", minimum: 0, description: "墙钟硬超时(ms,只作废该场)。" },
  },
  scriptSizeLimit: {
    valueType: "integer",
    unit: "bytes",
    minimum: 0,
    calibration: { state: "undetermined", placeholder: UNDETERMINED_VALUE },
    description:
      "顶层脚本体积上限(bytes),封「直线代码不计量、大循环体放大每格工作量」的计数盲区。" +
      "它是**规则集里的数值键**,与沙箱注入的 API 名表是两件事(hld §6.2 的「不进名单」说的是后者)。",
    schema: { type: "integer", minimum: 0, description: "顶层脚本体积上限(bytes)。" },
  },
} as const satisfies Readonly<Record<string, RulesetKeyEntry>>;

/**
 * 键清单里的键名联合。加一个键、删一个键,类型侧立刻变。
 *
 * 消费方(E 节点的文档生成器)判「这个键要不要把取值渲染成「未定」」的方式就是读那一个
 * `calibration.state`,不需要本包再导出一个守卫函数——本包的纪律是「无运行时代码」
 * (hld §3.2),连这种只包一行的便利也不给。
 */
export type RulesetKey = keyof typeof RULESET_KEY_CATALOG;
