/**
 * 模型裸文本 → 编译用源码:剥掉头尾的代码围栏包装(契约禁围栏后的管线兜底,hld §2.2.6)。
 *
 * ── 为什么是管线改而非提示词改(ADR-0012) ──
 *
 * 模板 `prompts/base.md` 明令禁围栏/解释文字,且 tsc 回喂已被实证纠正不了一个系统性不守约
 * 的模型(opus 连挂 10 轮,见 `.scratch/opus-probe/`)。提示词与回喂都已打满,只能在编译前剥包装。
 *
 * ── 语义(只动头尾,不改本体) ──
 *
 * - 无围栏行 → **原样返回**(同一字符串值):已守约的输出逐字节不变,编译诊断行号不受影响。
 * - 首尾各一道围栏(`` ``` `` 起首的行,语言标签不限) → 取首道之后、末道之前的那段**原字节**
 *   (内部行逐字节保留,不 trim;末行换行是围栏间原文自带的,一并保留):引导语(开围栏前)与尾随语
 *   (闭围栏后)同去;诊断行号自第一行代码起算,与剥后文本天然对齐。
 * - 只有一道围栏 → 取较长的一侧(开围栏遗漏闭合取之后,反之取之前);正中单道这种病态不猜,原样返回。
 *
 * 有效 TS 里不存在以 `` ``` `` 起首的行,故围栏判定不会误伤代码本体。
 */

/** 以 `` ``` `` 起首的行(前导空白容忍,语言标签与尾随空白不限)。 */
const FENCE_LINE = /^\s*```/;

/**
 * 从模型裸文本提取待编译的脚本文本。纯函数,不抛异常:空串与纯空白都原样返回。
 */
export const extractScriptSource = (text: string): string => {
  const lines = text.split("\n");
  const fences: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (FENCE_LINE.test(lines[index] ?? "")) {
      fences.push(index);
    }
  }
  if (fences.length === 0) {
    return text;
  }
  const first = fences[0] ?? 0;
  const last = fences[fences.length - 1] ?? 0;
  if (first === last) {
    // 单道围栏:正中(前后都有料)不猜,原样返回;否则取较长一侧(行接回,不增删换行)。
    if (first > 0 && first < lines.length - 1) {
      return text;
    }
    return first === 0 ? lines.slice(1).join("\n") : lines.slice(0, -1).join("\n");
  }
  // 首道之后、末道之前的那段原字节:行间 `\n` 接回,末行自带的换行(围栏行起首前的那个)一并保留;
  // 空围栏(首尾相邻)给空串。
  const inner = lines.slice(first + 1, last);
  return inner.length === 0 ? "" : `${inner.join("\n")}\n`;
};
