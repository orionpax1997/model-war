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
 * 按白名单先判就会把 `Math.random` 放行(顺序见 `validate/pipeline.ts`)。
 */

import { identifierName, isAstNode, startOf, walk, type AstNode } from "../ast.ts";
import { parseToAst, positionAt, type ParsedSource } from "../parse-source.ts";
import { isForbiddenGlobalName } from "../script-surface.ts";
import type { ScriptLintContext, ScriptLintStage } from "../validate/pipeline.ts";
import type { ScriptViolation } from "./script-violation.ts";

/** 全局对象本身。它是「等价写法」而不是「某个对象的属性」,所以比较之前先剥掉。 */
const GLOBAL_THIS = "globalThis";

/** 标识符链的一段:名字 + 该段的起始偏移(违规的位置指到链的**头**一段)。 */
type ChainSegment = {
  readonly name: string;
  readonly start: number;
};

/**
 * 取一个节点上的标识符链;取不到就返回 undefined。
 *
 * 取不到的三种情况:不是标识符也不是成员表达式(字面量、调用表达式……)、成员名是动态下标、
 * 链的中途断了(对象不是标识符也不是成员表达式,例如 `foo().bar`)。**一律返回 undefined,
 * 不做「猜它是全局的」那种判断**——本规则要的恰恰是猜都不猜。
 */
const chainOf = (node: AstNode | undefined): readonly ChainSegment[] | undefined => {
  if (node === undefined) {
    return undefined;
  }
  if (node.type === "Identifier") {
    const name = identifierName(node);
    return name === undefined ? undefined : [{ name, start: startOf(node) }];
  }
  if (node.type !== "MemberExpression") {
    return undefined;
  }
  const { property } = node;
  const member = memberNameOf(node);
  if (member === undefined) {
    return undefined;
  }
  const object = chainOf(isAstNode(node.object) ? node.object : undefined);
  if (object === undefined) {
    return undefined;
  }
  // 成员那一段的偏移指向 `property`(`.random` 里那个 `random`),它与节点不同源时退回整个成员表达式。
  const memberStart = isAstNode(property) ? startOf(property) : startOf(node);
  return [...object, { name: member, start: memberStart }];
};

/** 成员名:非计算属性取 `property.name`;计算属性取字符串字面量的值;动态下标取不到。 */
const memberNameOf = (node: AstNode): string | undefined => {
  const { property } = node;
  if (node.computed !== true) {
    return identifierName(property);
  }
  if (isAstNode(property) && property.type === "Literal" && typeof property.value === "string") {
    return property.value;
  }
  return undefined;
};

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

/**
 * 非计算的「键」不是一次名字查找,把这样的节点登记下来,遍历到它们时直接跳过:
 * `obj.Date`、`{ Date: 1 }`、`class A { Date() {} }` 里的 `Date` 都不是全局引用。
 *
 * 解构简写 `{ performance }` 里的那个标识符是**被绑定的名字**,同样不是引用,一并登记。
 * 要判出来需要知道父节点是不是解构模式——本规则不查作用域,拿不到父节点,于是走 `walk`
 * 的「先访问父后访问子」这条性质(见 `../ast.ts` 的头注):访问到 `ObjectPattern` 时就把它的
 * 简写属性登记掉,轮到那些属性被访问时登记已经生效。
 * 这也是 key 与 value 要**按对象身份**而不是按名字登记的原因:实测解构简写的 key 与 value
 * 是两个独立节点(不是同一个对象),而对象字面量的简写 `{ performance }` 里 value 是真的引用
 * ——按名字登记会把那个漏掉。
 */
const markNonReferences = (node: AstNode, keys: Set<AstNode>): void => {
  if (node.type === "ObjectPattern" && Array.isArray(node.properties)) {
    for (const property of node.properties) {
      if (isAstNode(property) && property.shorthand === true) {
        if (isAstNode(property.key)) {
          keys.add(property.key);
        }
        if (isAstNode(property.value)) {
          keys.add(property.value);
        }
      }
    }
    return;
  }
  if (node.computed === true) {
    return;
  }
  if (isAstNode(node.key)) {
    keys.add(node.key);
  }
  if (node.type === "MemberExpression" && isAstNode(node.property)) {
    keys.add(node.property);
  }
};

/** 遍历一棵已解析成功的树,收出本级的违规。规则层与判定链两个入口共用这一份扫描。 */
const scanParsed = (program: unknown, source: string): readonly ScriptViolation[] => {
  const keyNodes = new Set<AstNode>();
  const found: { readonly start: number; readonly chain: string }[] = [];
  walk(program, (node) => {
    markNonReferences(node, keyNodes);
    if (keyNodes.has(node)) {
      return;
    }
    // 标识符节点也进来查:裸的 `Date` 是一个 Identifier,不是 MemberExpression,漏掉它整条规则就废了。
    const chain = chainOf(node);
    if (chain === undefined) {
      return;
    }
    const hit = forbiddenChainOf(chain);
    if (hit !== undefined) {
      found.push({
        // 非空链的首段一定在;取不到时退回节点自身的位置,不为它单开一条分支。
        start: hit[0]?.start ?? startOf(node),
        chain: hit.map((s) => s.name).join("."),
      });
    }
  });

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
