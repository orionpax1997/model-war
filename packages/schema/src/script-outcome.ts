/**
 * 「没生效」的后果真源:脚本的意图或 `loop()` 一次没有按预期生效时,**丢的是什么**。
 *
 * ── 为什么这一半不住在符号表那个文件里 ──
 *
 * `script-surface.ts` 那张表回答的是「脚本运行时能拿到哪些名字」,判据是「擦掉类型标注后还剩不剩
 * 一个值」。后果不是名字,判据也不一样:它回答的是「这次调用没生效时,这一 tick 丢的是什么」。
 * 合成一张表的后果不是少一个文件,而是那张表的判据从一句变成两句——而判据一多,就没人说得清
 * 往里加一行要满足哪一句。
 *
 * ── 为什么两个方向各查一半,而不是抄一份 ──
 *
 * 后果行按名字**引用**错误码,不重写码的语义。于是同一个码可能落进两行、或者一个码哪行都不落,
 * 这两类错位在纯数据上都是可能的:它们唯一的防线是机器断言,而断言放在两个文件各自的测试里,
 * 各查一半再互相点名(`script-outcome.test.ts` 查「每个码恰好一行」与「引用的名字都是真的错误码」,
 * `script-surface.test.ts` 查全档都带触发条件)。文档那侧同样是投影:错误码表里「落在哪类」
 * 那一栏由 `SCRIPT_OUTCOME_BY_CODE` 取,不另写。
 *
 * ── 为什么两类后果的措辞写在类上,不在每行里 ──
 *
 * 「丢单条」与「丢整 tick 且计一次」是**两类**后果的共性,抄进每一行就是六份措辞各写一遍,
 * 而分叉的形状正是「有的行说丢单条、有的行说不扣款」这种看着没毛病的矛盾。这里给类一次措辞,
 * 每行只写它自己额外的那一点(挂起、退款、重建容器),共性那一半由类渲染。
 */

/**
 * 「没生效」的两类后果。
 *
 * 刻意只有这两档,且是一个**判别式**而不是布尔位:多一档(比如「延迟到下 tick」)会让
 * 「模型据此决定要不要兜」这件事重新变成需要判断的题,而现在它是一次查表。
 *
 * `discard` 与 `exception` 的差别不是「轻一点 / 重一点」,是**丢的范围与是否计数**:一个只丢
 * 那一条意图,另一个把本 tick 全部意图置空并给累计计数加一。所以每一行都必须落在这两档之一,
 * 没有第三档可选。
 */
export type ScriptOutcomeKind = "discard" | "exception";

/** 一类后果的措辞。面向模型的契约文档逐字渲染它,所以它写给模型看。 */
export type ScriptOutcomeClass = {
  /** 面向模型的两个字。表里「落在哪类」那一栏就是它。 */
  readonly label: string;
  /** 这一类**丢的是什么**:丢的范围。模型据此判断「要不要兜」。 */
  readonly loss: string;
  /** 这一类**累计**在哪儿:计数加不加一、加了会怎样。 */
  readonly tally: string;
};

/**
 * 两类后果的措辞。**键就是 `ScriptOutcomeKind`**,不多不少——多一个键会有一类没有任何一行落进去,
 * 少一个键则有一行落不进类,两者都由 `script-outcome.test.ts` 判红。
 *
 * 这里是「丢弃 vs 异常」那句话唯一的家:草案时期它散在对照表的每行里,而那些行本来就是同一句话的
 * 重复,抄一遍就会在某一行上走样。
 */
export const SCRIPT_OUTCOME_CLASSES: Readonly<Record<ScriptOutcomeKind, ScriptOutcomeClass>> = {
  discard: {
    label: "丢弃",
    loss: "只丢这一条意图:本 tick 其余意图照常结算,不扣款、不计异常。",
    tally: "不计入 `exceptionTicks`。",
  },
  exception: {
    label: "异常",
    loss: "本 tick 该方的**全部**意图置空(原地待命),这一 tick 白跑。",
    tally: "给 `exceptionTicks` 加一;累计达 `exceptionTickLimit` 则判负出局(机制见 rules.md §8)。",
  },
};

/** 后果行的一行:一种「没有按预期生效」的情形,以及它落在哪一类。 */
export type ScriptOutcomeEntry = {
  /** 一句情形:什么情况下会走到这一行。写给模型看,判定口径是模型自己能在快照上算出来的那些。 */
  readonly situation: string;
  /** 落在这两档的哪一档。 */
  readonly kind: ScriptOutcomeKind;
  /** 这一行**特有**的那一点后果。共性的那一半在 `SCRIPT_OUTCOME_CLASSES` 上,不重抄。 */
  readonly outcome: string;
  /**
   * 一句例子:一个具体的调用或局面。空着的写法是「模型照这句写不出脚本」。
   *
   * **刻意不写具体数字。** 数值归 `rulesets/vN.json` 那条链(它渲染成契约文档里的数值表),
   * 而本行会被逐字渲染进「丢弃 vs 异常」对照表——那里写死的取值与数值表那一格构成两份会分叉的
   * 第二家,改规则集时只有一份跟着变,于是没人判红。要一个带数的例子就去引数值表,不在这里拄。
   */
  readonly example: string;
  /**
   * 这一情形可能返回的错误码。**按名字引用**符号表,不重写码的语义。
   *
   * 空数组是合法的:有些情形压根不返回码(`loop()` 抛异常、沙箱内的整 tick 判罚)。
   * 一行引用了两个码、或者一个码被两行引用,都由 `script-outcome.test.ts` 判红。
   */
  readonly codes: readonly string[];
};

/**
 * 「没生效」的六种情形。两类后果都有行;**四行不返回任何码**,它们不是错误而是「这一 tick 白跑」或
 * 「静默丢弃」;**另两行返回码**,且它们合计覆盖符号表里的每一个码(一个码恰好一行)。
 *
 * 行序即模型最该先看的那几条在前:**调用侧的丢弃在前,`loop()` 侧的异常在后**——因为「写错参数
 * 最多丢一条、写崩 `loop()` 才丢整 tick」是这份表最该被一眼看到的那条对照,而它恰好横跨两张表。
 * 行序是书写序,不是判据:判据是「这一行说的是不是一件模型能自己算出来的事」。
 */
export const SCRIPT_OUTCOME_CATALOG: readonly ScriptOutcomeEntry[] = [
  {
    situation: "同一单位在一 tick 内提交了多条单位级意图:取最后一条,前面的静默作废。",
    kind: "discard",
    outcome: "被覆盖的那些意图不留任何痕迹:不写事件流、不计异常、不扣款。",
    example: "同一农民连调两次 `move`,只有最后一次生效——所以每单位每 tick 只写最终意图。",
    codes: [],
  },
  {
    situation:
      "动作函数的界检查没过:点名的单位或基地不存在、不归本方、射程外、目标非法、点位类型不对、参数越界。",
    kind: "discard",
    outcome: "沙箱内即时返回对应错误码,引擎在结算时按同一套界检查再裁一次;该条意图无效。",
    example: "`attack` 打基地、`harvest` 指基地、无攻击能力的单位调 `attack`。",
    codes: [
      "ERR_INVALID_UNIT",
      "ERR_NOT_OWNER",
      "ERR_OUT_OF_RANGE",
      "ERR_INVALID_TARGET",
      "ERR_INVALID_SITE",
      "ERR_BAD_ARGS",
    ],
  },
  {
    situation: "`spawnUnit` 资金不足:这一单下单无效。",
    kind: "discard",
    outcome: "不占产线队列、不扣款,资金一个不少地留着。",
    example: "钱不够买下一个兵种时再下单 → 这一单无效,钱一个不少地留着(换个兵种也一样)。",
    codes: ["ERR_NOT_ENOUGH_RESOURCES"],
  },
  {
    situation:
      "`loop()` 抛异常:算力或 API 调用超预算、越权调用(调不存在的 API、调已删的宿主桥)、内存超限转成的异常、栈溢出。",
    kind: "exception",
    outcome: "本 tick 该方全部意图置空;容器续用、跨 tick 记忆保留,下一 tick 从头再来。",
    example: "死循环被截停;调了一个不存在的 `fly()`。",
    codes: [],
  },
  {
    situation: "tick 末存活堆占用 ≥ `memoryTickCeiling`。",
    kind: "exception",
    outcome: "与 `loop()` 抛异常同后果:判据锚定读数,tick 内瞬时触顶后自行释放的分配不判。",
    example: "本 tick 分配很大但当场释放,读数没超 → 不判罚。",
    codes: [],
  },
  {
    situation: "引擎级故障(极罕见,脚本写不出也测不出)。",
    kind: "exception",
    outcome: "除置空外还防御性重建该方容器:模块级记忆清零,异常计数由持久化值续算、不清零。",
    example: "这一行的唯一用途是让脚本知道「记忆极 rare 会丢」,别的照常写。",
    codes: [],
  },
];

/**
 * 错误码 → 它落在哪一行。**由上面的目录投影而来**,不另存一份。
 *
 * 投影而不是再抄一张对照表:码与它落在哪一类只该有一处可改,改了这里,错误码表里「落在哪类」
 * 那一栏与「丢弃 vs 异常」对照表都跟着变。
 *
 * 同一个码落进两行时**后者覆盖前者**,投影本身不抛:抛了会让这份真源在被改坏的那一次 import
 * 就炸,而真源包的职责是陈述事实、不是当场发火。防线是 `script-outcome.test.ts` 里
 * 「每个码恰好落在一行」那条断言——它会在同一处给出码名。
 */
export const SCRIPT_OUTCOME_BY_CODE: ReadonlyMap<string, ScriptOutcomeEntry> = new Map(
  SCRIPT_OUTCOME_CATALOG.flatMap((entry) => entry.codes.map((code) => [code, entry] as const)),
);
