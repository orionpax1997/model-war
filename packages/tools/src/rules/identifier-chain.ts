/**
 * 「标识符链」这份公共件:一棵已解析的树 → 若干处「按名字找到符号」的写法,每处一条链。
 * 纯遍历,**不碰文件系统**,也不读时钟与环境。
 *
 * ── 为什么单列一份而不是各规则自带 ──────────────────────────────────────────
 * 禁列全局名(`rules/forbidden-globals.ts`)与宿主桥前缀(`rules/host-bridge.ts`)两条规则的判据
 * 都作用在**标识符链**上(前者比整条、后者比根),而「哪些位置上的标识符是一次按名字找符号、
 * 哪些只是一次取值」这件事是**最容易写错**的一处:写宽了会把 `obj.Date`、`{ Date: 1 }`、
 * `obj.__foo` 这些「读一个恰好重名的属性」全误伤成违规,而误报在五轮迭代预算里是
 * **不对称地致命的**(spec《承载的重新划分》)——模型收到一条它改不掉的违规,五轮耗尽,这一轮作废。
 * 两份遍历各写一次这个判据,迟早有一份放宽了,而那时没有任何东西会红。
 *
 * ── 取不到就**不出现**,不猜 ──────────────────────────────────────────────────
 * 三种情况一律取不到一条链:不是标识符也不是成员表达式(字面量、调用表达式……)、成员名是动态下标、
 * 链的中途断了(`foo().bar`)。**绝不「猜它是全局的」**——两条规则要的恰恰是猜都不猜:
 * 判据是「这个名字出现在链上」,不是「这个名字是一次全局查找」。
 *
 * ── 一次出现会以多段链的形式出现(调用方要知道的契约) ──────────────────────────
 * `__host.x = 1` 这一次出现给出**两条**:遍历既访问 `__host` 这个标识符,也访问整条链
 * `__host.x`。本模块不替调用方合并——一条链可能被多条判据以不同方式命中(禁列比整条、
 * 桥前缀比根),合并的形态属于各自的规则。**判据只看某一段的规则(桥前缀)必须按那一段
 * 的偏移去重**,否则同一次出现会被报成「2 处」。
 *
 * ── 键位上的名字不算「按名字找符号」 ──────────────────────────────────────────
 * 非计算的「键」是一次取值:`obj.Date`、`{ Date: 1 }`、`class A { Date() {} }` 里的那个 `Date`
 * 一律不在输出里,与判据宽窄无关。
 *
 * 解构简写 `{ performance }` 里的那个标识符是**被绑定的名字**,同样不是引用,一并登记掉。
 * 要判出来需要知道父节点是不是解构模式,而本模块不查作用域、拿不到父节点,于是走 `walk` 的
 * 「先访问父后访问子」这条性质(见 `../ast.ts` 的头注):访问到 `ObjectPattern` 时先把它的简写属性
 * 登记掉,轮到那些属性被访问时登记已经生效。
 * 键与值要**按对象身份**而不是按名字登记:实测解构简写的 key 与 value 是两个独立节点
 * (不是同一个对象),而对象字面量的简写 `{ performance }` 里 value 是真的引用——按名字登记会把那个漏掉。
 *
 * 动态下标成员(`Math[k]`)不登记:它的成员名取不到,而它的下标表达式里那个 `k` **是**一次引用,
 * 少登记一次会让它按引用去判(这正是要的)。同理计算属性里的成员名(`Math["random"]`)取得到,
 * 它进链,而取不到名字的动态下标整条链取不到。
 *
 * ── 下一张要动这里的人 ────────────────────────────────────────────────────────
 * 模块系统那一票问的是「这是什么语法形态」而不是「这个名字是什么」,多半不需要本文件;
 * 但只要它要判一个裸标识符(`require` 这类),就该来这里取链,而不是自己再拼一遍。
 */

import { identifierName, isAstNode, startOf, walk, type AstNode } from "../ast.ts";

/** 标识符链的一段:名字 + 该段的起始偏移。违规的位置指到链的**头**一段。 */
export type ChainSegment = {
  readonly name: string;
  readonly start: number;
};

/** 一处链的出现。按源码里出现的次序给出——遍历顺序即源码顺序,而排序是判定链的事。 */
export type ChainReference = {
  readonly chain: readonly ChainSegment[];
};

/**
 * 取一个节点上的标识符链;取不到就返回 undefined(理由见头注)。
 * 成员名:非计算属性取 `property.name`;计算属性取字符串字面量的值;动态下标取不到。
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
 * 把「键位」上的名字登记下来,遍历到它们时直接跳过(判据与理由见头注)。
 *
 * 解构简写要把键与值**都**登记:那个位置上的标识符是被绑定的名字,不是引用。
 */
const markNonReferences = (node: AstNode, names: Set<AstNode>): void => {
  if (node.type === "ObjectPattern" && Array.isArray(node.properties)) {
    for (const property of node.properties) {
      if (isAstNode(property) && property.shorthand === true) {
        if (isAstNode(property.key)) {
          names.add(property.key);
        }
        if (isAstNode(property.value)) {
          names.add(property.value);
        }
      }
    }
    return;
  }
  if (node.computed === true) {
    return;
  }
  if (isAstNode(node.key)) {
    names.add(node.key);
  }
  if (node.type === "MemberExpression" && isAstNode(node.property)) {
    names.add(node.property);
  }
};

/**
 * 遍历一棵已解析成功的树,收出其中每一处标识符链的引用。
 *
 * 规则层与判定链两个入口共用这一份扫描(各自只写「什么样的链算违规」),所以两个入口
 * 对同一份源码永远给出一致的结论。输入是 `unknown`:解析层交来的是 `Program`,
 * 而遍历只需要能按键宽地走下去(见 `../ast.ts` 的头注)。
 */
export const referenceChainsOf = (program: unknown): readonly ChainReference[] => {
  const nonReferences = new Set<AstNode>();
  const found: ChainReference[] = [];
  walk(program, (node) => {
    markNonReferences(node, nonReferences);
    if (nonReferences.has(node)) {
      return;
    }
    // 标识符节点也进来查:裸的 `Date` 是一个 Identifier,不是 MemberExpression,漏掉它整条规则就废了。
    const chain = chainOf(node);
    if (chain !== undefined) {
      found.push({ chain });
    }
  });
  return found;
};
