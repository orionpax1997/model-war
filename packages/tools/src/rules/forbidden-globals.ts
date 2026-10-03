/**
 * 禁列全局名规则(纯规则层):一段源码 → 一组带行列的违规。**不碰文件系统**,也不读时钟与环境:
 * 同一段源码永远得到同一组违规,这是生成管线每轮迭代都跑它、能 diff 两轮结果的前提。
 *
 * ── 判据:标识符链**整条**命中禁列表,不看作用域 ─────────────────────────────────
 * 禁列表(真源 `@model-war/schema` 的 `FORBIDDEN_GLOBAL_NAMES`,经 `script-surface.ts` 读入)
 * 的元素是**标识符链**而不是裸全局名,成员路径也在内(`Math.random` 就是一条链)。这是 C 交付的
 * 接口形状,不是本规则自选:链这个形状让「同一个标识符链上的一次确定性污染」可以与裸全局名
 * 同表表达,真要分成两张表只会得到一张四个元素、一张一个元素的表,裁决它们的差别不带来收益。
 *
 * 「整条命中」这三个字是本规则最容易写错的一处,值得说清它排除了什么:
 * - `x.Date` **放行**。如果改成「链的任一后缀命中就算」,`x.Date` 的后缀 `Date` 就命中了,
 *   于是所有「读一个恰好叫 `Date` 的属性」的合规写法全被误伤。误伤在五轮迭代预算里是
 *   **不对称地致命**的(spec《承载的重新划分》),所以宁可只判整条。
 * - 唯一的例外是宿主 VM 上的 `globalThis`:`globalThis.Date` 与 `Date` 是同一个引用,
 *   它是全局对象本身而不是某个对象的属性,所以比较之前先把它剥掉(带不带它不该改变判定)。
 *
 * 因为不查作用域,「这个标识符是不是一次全局查找」只能靠语法位置来判断,判据因此是:
 * - 裸引用(`Date.now()`、`performance`)**判违规**,出现在任何位置都判,不问之后怎么用;
 * - 当键用的名字(`x.Date`、`{ Date: 1 }`、`class A { Date() {} }`)**放行**——那是一次取值,
 *   不是一次按名字找全局;
 * - `const r = Math.random;` 在**声明处**就判违规:静态这一层能判的只有「这个名字出现在链上」。
 *
 * ── 边界:判不了的两处,以及为什么不补 ──────────────────────────────────────────
 * ① **动态下标**(`Math[k]`):成员名取不到,按「不在禁列内」放行。与禁浮点规则对 `Math[k]`
 *    的处理同一条纪律(那边是「不在白名单即违规」、这边是「不在黑名单即放行」——两张表的
 *    方向相反,纪律同源)。补齐它需要常量传播,那是数据流分析,不是静态遍历。
 * ② **解构与经变量中转**(`const { random } = Math;`、`const m = Math; m.random()`):链在这些位置断了,
 *    本规则看不见。看见它需要作用域信息,而 `oxc-parser` 0.152 不暴露任何作用域
 *    (spec《承载的重新划分》把全局白名单反转整个交给了编译器的名字解析,同一个前提在这里生效)。
 *    这两处是有记录的缺口,不是遗漏:它们要的是「解析器给不出的信息」。
 *
 * ── 为什么它在判定链的第一级 ──────────────────────────────────────────────────
 * 禁列必须先判。具体的漏洞是:禁列表里有 `Math.random`,而 `Math` 在内置全局白名单里;
 * 按白名单先判就会把 `Math.random` 放行(顺序见 `validate/pipeline.ts`)。同处在桥前缀那一格
 * 与本规则的裁决是:一个既命中禁列又带桥前缀的构造按本级判,理由见 `host-bridge.ts` 的头注。
 *
 * ── 「哪些位置上算一次引用」的判据归 `identifier-chain.ts` ──────────────────────
 * 本文件只写「什么样的链算违规」,链怎么取、键位上的名字为什么不算,都在那份公共件里
 * (宿主桥前缀规则共用同一份,理由见那个文件的头注)。
 */

import { parseToAst, positionAt, type ParsedSource } from "../parse-source.ts";
import { isForbiddenGlobalName } from "../script-surface.ts";
import { referenceChainsOf, type ChainSegment } from "./identifier-chain.ts";
import type { ScriptLintContext, ScriptLintStage, ScriptViolation } from "./script-lint.ts";

/** 全局对象本身。它是「等价写法」而不是「某个对象的属性」,所以比较之前先剥掉。 */
const GLOBAL_THIS = "globalThis";

/**
 * 剥掉开头的 `globalThis` 后,整条链是否落在禁列表里。命中时返回剥完的链,好让违规的位置
 * 落在真正要改的那个名字上(`globalThis.Math.random` 指的是 `Math.random`,不是那个等价前缀)。
 */
const forbiddenChainOf = (chain: readonly ChainSegment[]): readonly ChainSegment[] | undefined => {
  const effective = chain[0]?.name === GLOBAL_THIS ? chain.slice(1) : chain;
  if (effective.length === 0) {
    return undefined;
  }
  return isForbiddenGlobalName(effective.map((segment) => segment.name).join("."))
    ? effective
    : undefined;
};

const forbiddenMessage = (chain: string): string =>
  `禁列全局名 \`${chain}\`:它是确定性污染源或这个 VM 之外的读数,参赛脚本里不能出现;` +
  `请改用脚本自己算得出来的量(格数、步数、累计计数)。`;

/** 遍历一棵已解析成功的树,收出本级的违规。规则层与判定链两个入口共用这一份扫描。 */
const scanParsed = (program: unknown, source: string): readonly ScriptViolation[] => {
  const found: { readonly start: number; readonly chain: string }[] = [];
  for (const { chain } of referenceChainsOf(program)) {
    const hit = forbiddenChainOf(chain);
    if (hit !== undefined) {
      found.push({
        // 非空链的首段一定在;取不到时退回 0,不为它单开一条分支。
        start: hit[0]?.start ?? 0,
        chain: hit.map((s) => s.name).join("."),
      });
    }
  }

  return found.map(({ start, chain }) => {
    const { line, column } = positionAt(source, start);
    return {
      rule: "forbidden-global",
      message: forbiddenMessage(chain),
      line,
      column,
      blocking: true,
    };
  });
};

/**
 * 判定链上的第一级。上下文里已经带着解析结果,所以这里**不重复解析**——判定链把
 * 「解析失败独占」这件事挡在前面(见 `validate/pipeline.ts`),上下文里没有可用解析结果时
 * 本级返回空数组:那条路径的结论属于解析层,不由规则层重复产出。
 */
export const forbiddenGlobalStage: ScriptLintStage = (context: ScriptLintContext) => {
  const { parsed } = context;
  return parsed === undefined || !parsed.ok ? [] : scanParsed(parsed.program, context.source);
};

/**
 * 规则层的对外缝:一段源码 → 一组带行列的违规。形状与 `noFloatViolations` 同形,
 * 判据与上面那条完全同一份扫描,所以两个入口永远给出一致的结论。
 *
 * 解析不过时返回空数组:「解析失败」是判定链独占的那一条结论,它产自 `validate/pipeline.ts`。
 * 规则层在这里再产一份就等于同一件事有两个家,而调用方拿到的会是两条互相矛盾的违规。
 *
 * 源形态是 script-mode 的单文件(hld §2.2.2 的入口契约),规则跑在**编译后的产物**上,
 * 不在原始 TS 上跑(spec《规则跑在编译产物上》)。
 */
export const forbiddenGlobalViolations = (source: string): readonly ScriptViolation[] => {
  const parsed: ParsedSource = parseToAst(source, "script");
  return parsed.ok ? scanParsed(parsed.program, source) : [];
};
