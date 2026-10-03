/**
 * 参赛脚本静态校验的**词汇表**:违规形状、全序比较、一级判定的形状与上下文。
 * 纯规则层、判定链(`validate/pipeline.ts`)与面向模型层的渲染(`validate/render-violations.ts`)
 * 三处共用这一份定义。
 *
 * ── 它为什么在 `rules/` 下(层次方向,改之前先读这一段) ────────────────────────
 * 依赖箭头只能是 **`validate/` → `rules/`** 一条,不许反向。反过来写会同时坏掉两件事:
 * - `validate/pipeline.ts` 本来就要 import `rules/` 里的各级 stage(`forbiddenGlobalStage` 等),
 *   规则层再 import 回 pipeline 就成了**环**。类型级的 import 擦得掉,环还在图上,
 *   而「哪个方向是对的」这件事会在后三张票(桥前缀 / 模块系统 / 体积)的文件里各猜一次。
 * - 更根本的一条:阶段接口(`ScriptLintStage`)与它的上下文是**规则要满足的约束**,
 *   不是判定链施加给规则的。约束的家在被约束的那一侧(依赖倒置),所以家定在 `rules/`。
 * 顺带一个具体好处:桥前缀、模块系统、体积三张票要落的文件本来就在 `rules/` 下,
 *   它们 import 这个词汇表是同目录往上一层,不必跨到 `validate/`。
 * 判定链的**顺序**仍然归 `validate/pipeline.ts`——那是裁决,不在这里。
 *
 * ── 为什么违规形状单列一份而不是各规则各带一个类型(禁浮点与声明即依赖各带各的) ──
 * 判定链要按**类别名**排序,面向模型层要按**类别**把同类错误并成一行,而类别名同时是
 * 机器层 diff 的兜底键——三处共用一个判据,一旦分家就会出现「机器层叫 A、渲染层叫 B」
 * 或者「排序按 A、归并按 B」这种没人当场看得见的分叉。所以类别是**唯一**的一处定义,
 * 新规则加类别时必须同时在 `render-violations.ts` 的 `RULE_LABELS` 里留一个名字
 * (那张表是穷尽 `Record`,忘了会让 `tsc -b` 当场报错)。
 *
 * 形状与 `rules/no-float.ts` 的 `NoFloatViolation` 同形(规则类别 / 面向模型的文本 / 行列),
 * 两处不同,各有各的理由:
 * - `blocking` 是新增的一维。四条规则里只有「脚本体积」会分两档(迭代期只提示、冻结期拦),
 *   而它必须能被**机器层**分流:退出码、生成管线的下一轮决策都按这一位走,不能靠解析文本
 *   去猜「这句话是提示还是拦截」。迭代期的体积提示 `blocking` 为 false,其余一律 true。
 * - 行列允许为 `null`。体积级不是 AST 规则,它没有位置可言;硬给它一个 `1:1` 只会让
 *   「这个位置是猜的」这件事消失在数据里。
 *
 * ── 「规则层的对外缝」的形状,为什么解释只有这一份 ───────────────────────────
 * 每条 AST 规则都导出两个入口:`xxxStage`(判定链那一级,吃共享上下文)与 `xxxViolations`
 * (裸调用方那一道,一段源码进)。两者**共用同一份 `scanParsed`**,所以一个调用方无论走
 * 哪条入口,拿到的结论逐项相同——那不是巧合,是同一个函数。
 * 三条共享这件事的纪律,家在这里而不在各规则的头注里(重复三遍的那段话就是它):
 * - 解析不过时**返回空数组**。「解析失败」是判定链独占的那一条结论,它产自
 *   `validate/pipeline.ts`;规则层在这里再产一份就等于同一件事有两个家,而调用方拿到的会是
 *   两条互相矛盾的违规。
 * - 源形态是 script-mode 的单文件(hld §2.2.2 的入口契约),规则跑在**编译后的产物**上,
 *   不在原始 TS 上跑(spec《规则跑在编译产物上》)。
 * 各规则头注里只留自己那条规则的判据与边界。
 */

import type { ParsedSource } from "../parse-source.ts";

/** 违规类别。`syntax-error` 不是一条规则,而是「无法判定」的确定结论。 */
export type ScriptLintRule =
  /** 解析失败,独占结果:此时一条规则违规都不报。 */
  | "syntax-error"
  /** 禁列全局名:标识符链命中禁列表。 */
  | "forbidden-global"
  /** 宿主桥:标识符链的根带宿主桥前缀。 */
  | "host-bridge"
  /** 模块系统:静态/动态 import、export、require、动态 eval。 */
  | "module-system"
  /** 脚本体积:字节数超过传入上限。 */
  | "script-size";

export type ScriptViolation = {
  readonly rule: ScriptLintRule;
  /** 面向模型的一句话:说清「哪里错了」与「改什么」,不是内部记号。 */
  readonly message: string;
  /** 1 起;`script-size` 没有位置,两者皆为 null。 */
  readonly line: number | null;
  readonly column: number | null;
  /** false = 只提示不拦(迭代期的体积提示)。面向模型层与退出码都按它分流。 */
  readonly blocking: boolean;
};

/**
 * 违规序列的全序比较:先按行、再按列、再按规则类别名,最后按文本兜底。
 *
 * **为什么排序是契约而不是实现细节**:生成管线要 diff 两轮迭代的结果,顺序不确定就 diff 不出来
 * (spec《违规输出》)。遍历是按对象的键序走的,那不保证与源码顺序一致,所以必须显式排。
 *
 * 位置的默认值是 `+∞` 而不是 `0`:没有位置的违规(`script-size`)要落在**末尾**而不是开头——
 * 排在开头会让「第一行是什么违规」这件事随有体积超标与否而变。
 *
 * 末位的文本兜底是为了让它真的成为**全序**:同一位置、同一类别可能出现不止一条
 * (禁列表同时收了 `Math` 与 `Math.random` 时,同一个 `Math.random` 命中两条链),
 * 没有末位键的话排序结果依赖输入次序,那不是全序。
 */
export const compareViolations = (left: ScriptViolation, right: ScriptViolation): number => {
  const lineOrder =
    (left.line ?? Number.POSITIVE_INFINITY) - (right.line ?? Number.POSITIVE_INFINITY);
  if (lineOrder !== 0) {
    return lineOrder;
  }
  const columnOrder =
    (left.column ?? Number.POSITIVE_INFINITY) - (right.column ?? Number.POSITIVE_INFINITY);
  if (columnOrder !== 0) {
    return columnOrder;
  }
  const ruleOrder = left.rule.localeCompare(right.rule);
  if (ruleOrder !== 0) {
    return ruleOrder;
  }
  return left.message.localeCompare(right.message);
};

/** 校验时机。`iteration` = 每轮迭代都跑(体积只提示),`freeze` = 冻结前最后一道(体积也拦)。 */
export type ScriptLintPhase = "iteration" | "freeze";

export type ScriptLintContext = {
  /** 编译后产物的源码文本。 */
  readonly source: string;
  /** 产物的**字节数**(不是字符串长度)。 */
  readonly byteLength: number;
  /**
   * 体积上限,字节。**由调用方传入,判定链不给默认值**——取值在规则集文件里,那是 E 的交付物。
   *
   * 它在**共享上下文**里而不是各条规则的第二个参数:后者会让三条 AST 规则各多带一个
   * 自己根本不看的参数,而它们拿不到别的补偿。共享上下文是纯数据(调用方给的常量 +
   * 一次解析结果),不违反「纯函数不碰文件系统、不读时钟、不读环境」。
   */
  readonly maxBytes: number;
  readonly phase: ScriptLintPhase;
  /** 解析结果,由判定链解析一次后放进来;语法失败时为 undefined。 */
  readonly parsed: ParsedSource | undefined;
};

/**
 * 一级判定:吃上下文,吐违规。空数组 = 这一级没问题。
 *
 * 五级判定链按裁决排定,顺序在 `validate/pipeline.ts`,不在这里:本形状只说「一级长什么样」,
 * 不说「哪一级在前」——把它写进接口会让顺序看起来是可插拔的,而它不是。
 */
export type ScriptLintStage = (context: ScriptLintContext) => readonly ScriptViolation[];
