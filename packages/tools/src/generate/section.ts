/**
 * 区块形态的机械件:定界标记怎么拼、区块怎么抽、区块怎么填。
 *
 * ── 为什么抽与填只有这一份实现 ──
 *
 * 生成器用 `writeSection` 填,漂移检查用 `readSection` 抽。分成两份的后果不是「多一处要改」,
 * 是「生成器写的」与「检查比的」不再是同一段东西——而漂移检查会一直绿着,因为它压根没在检查
 * 那块地方。整份比与按段比是同一个道理:比较口径只许有一份。抽与填共用同一条正则,分叉在构造上就不可能。
 *
 * ── 标记的纪律 ──
 *
 * 标记是**稳定的串**:由 `id` 拼出,不随真源内容、行号或文件长度变化。它在目标文件里
 * **各自独占一行、且只出现一次**——独占一行是抽得出的前提,只出现一次是抽得准的前提:
 * 文档里若把标记单独摆成一行来讲解它,那一行会被当成真的标记(抽取取第一个命中)。
 *
 * 正文形态由真源侧排版,本模块不重排版。区块正文要过格式化门禁,靠的是排版零件只有
 * `emit.ts` 一份(`PRINT_WIDTH` 复刻 `.oxfmtrc.json` 的 `printWidth`);这里另起一套宽度判断,
 * 分叉的后果是每跑一次生成器就多一份与格式化器不一致的正文,`pnpm run fmt` 当场变红。
 */

import type { SectionMarker } from "./artifact.ts";

/** 抽出区块的结果。**三种状态,没有一个是「没事可做」**——这个性质是刻意的,见 `readSection`。 */
export type SectionRead =
  | { readonly state: "found"; readonly content: string }
  /** 文件里一行定界标记都没有:整段被删、标记被手改、或文件根本不是那一份。 */
  | { readonly state: "unmarked" }
  /** 只找到一端:另一端被手改、被删,或终点排在起点之前。 */
  | { readonly state: "unterminated" };

/** 默认定界标记:起止各带一个字样,所以「只出现一次」就能定位出整个区间。 */
export const sectionMarker = (id: string): SectionMarker => ({
  begin: `<!-- generated:${id}:begin -->`,
  end: `<!-- generated:${id}:end -->`,
});

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 行内 `[\t ]*` 容忍缩进与行尾空白,`\r?` 容忍 CRLF;**不用 `\s`**——它会吃掉换行,把标记两行并成一行。 */
const padded = (line: string): string => `[\\t ]*${escapeRegExp(line)}[\\t ]*\\r?`;

/** 文件里有没有一行(整行)就是这个标记。 */
const hasMarkerLine = (file: string, line: string): boolean =>
  new RegExp(`^${padded(line)}$`, "m").test(file);

/**
 * 整个区块一条正则:首行标记之后到末行标记之前,夹住的**全部字节**就是区块正文。
 *
 * 正文那一段用惰性匹配,所以终点取的是**最近**的那一处末行标记;`m` 标志让 `^`/`$` 按行锚定。
 * 抽与填共用它,所以「检查比的那段」与「生成器填的那段」不可能是两个口径。
 */
const sectionPattern = (marker: SectionMarker): RegExp =>
  new RegExp(
    `^(?<begin>${padded(marker.begin)}\\n)(?<content>[\\s\\S]*?)(?<end>^${padded(marker.end)}$)`,
    "m",
  );

/** 抽出区块正文(不含两行定界标记);区块外的散文原样丢掉,不比。
 *
 * **「抽不出」没有一条被折算成「一致」**,这是本函数唯一要紧的性质:检查若把抽不到当成无事可做,
 * 「把定界标记删掉」就是一条绕过检查的路——正文可以任意漂移而检查一直绿。所以抽不出分
 * `unmarked` 与 `unterminated` 两态,让调用方**分别**报出来,而不是笼统地放行。
 */
export const readSection = (file: string, marker: SectionMarker): SectionRead => {
  if (!hasMarkerLine(file, marker.begin)) {
    // 只剩末行标记 = 起点被手改或被删,与「什么都没剩」分开报:前者是「半段区块」,后者是「整段没了」。
    return hasMarkerLine(file, marker.end) ? { state: "unterminated" } : { state: "unmarked" };
  }
  const matched = sectionPattern(marker).exec(file);
  return matched === null || matched.groups === undefined
    ? { state: "unterminated" }
    : { state: "found", content: matched.groups["content"] ?? "" };
};

/**
 * 把新正文填回区块,返回填好后的目标文件全文。区块外的散文与两行标记**逐字节原样保留**。
 *
 * 目标文件里找不到完整的定界标记时**抛错而不是硬填**:生成器不猜这段该落在哪。猜的后果是把
 * 正文塞进一份散文里,而工作树看上去「生成器跑过了」——那比不跑更坏。
 */
export const writeSection = (file: string, marker: SectionMarker, content: string): string => {
  const pattern = sectionPattern(marker);
  if (!pattern.test(file)) {
    throw new Error(
      `文件里找不到完整的定界标记(${marker.begin} / ${marker.end})。` +
        `生成器不猜这段该落在哪——手工把标记行写回去,或撤销对它们的改动后重跑。`,
    );
  }
  return file.replace(
    pattern,
    (_whole: string, begin: string, _old: string, end: string): string => begin + content + end,
  );
};
