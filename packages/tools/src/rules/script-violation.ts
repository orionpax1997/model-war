/**
 * 参赛脚本静态校验的**违规形状**:纯规则层、判定链与面向模型层的渲染共用的那一个定义。
 *
 * 为什么把它单列一份而不是各规则各带一个类型(禁浮点与声明即依赖各带各的):
 * 判定链要按**类别名**排序,面向模型层要按**类别**把同类错误并成一行,而类别名同时是
 * 机器层 diff 的兜底键——三处共用一个判据,一旦分家就会出现「机器层叫 A、渲染层叫 B」
 * 或者「排序按 A、归并按 B」这种没人当场看得见的分叉。所以类别是**唯一**的一处定义,
 * 新规则加类别时必须同时在这里留一个名字(否则 `tsc` 会因 `RULE_LABELS` 不全而报错)。
 *
 * 形状与 `rules/no-float.ts` 的 `NoFloatViolation` 同形(规则类别 / 面向模型的文本 / 行列),
 * 两处不同,各有各的理由:
 * - `blocking` 是新增的一维。四条规则里只有「脚本体积」会分两档(迭代期只提示、冻结期拦),
 *   而它必须能被**机器层**分流:退出码、生成管线的下一轮决策都按这一位走,不能靠解析文本
 *   去猜「这句话是提示还是拦截」。迭代期的体积提示 `blocking` 为 false,其余一律 true。
 * - 行列允许为 `null`。体积级不是 AST 规则,它没有位置可言;硬给它一个 `1:1` 只会让
 *   「这个位置是猜的」这件事消失在数据里。
 */

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
