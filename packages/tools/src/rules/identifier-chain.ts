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
 * ── 括号:纯分组,不是一层「看不见的东西」 ────────────────────────────────────
 * oxc 为 `(Math)` / `((Math))` 产出独立的 `ParenthesizedExpression` 节点,而括号在 JS 里
 * **不改变被引用的是谁**:`(Math).random()` 与 `Math.random()` 指的是同一个 `Math.random`。
 * 所以取链的第一步是把括号剥掉,一层括号不该成为绕开判定链的路——`Math.random` 正是 spec
 * 用来锁判定链顺序的那个名字,放过它等于让确定性污染源可以靠一层括号绕过。
 *
 * 剥括号**只发生在「这个节点表示一个被引用、被调用或被求值的那一项」的那几处**:
 * 取链的入口(`chainOf`)、判全局对象本身的 `isGlobalThisNode`、模块系统取被调用者
 * (`calleeNameOf`)、模块系统取第一个实参(`isStaticEvalArgument`)。不是把树上的括号节点
 * 统统换成内层节点——那会顺手改掉别的判据看得见的形状,等于把一条规则的判据悄悄挪了家。
 * 加上实参那一侧的**理由**与它和常量折叠的分工,是模块系统规则自己的裁决,家在那份文件
 * 的头注(本文件只留指针);这里负责的是那条纪律本身:**括号是纯分组,剥掉它不改变被
 * 引用、被调用或被求值的到底是哪一项**。
 *
 * 剥完之后仍然**只登记一次**:遍历既访问括号节点,也访问它内层的那个表达式,两个节点会给出
 * 同一条链。按 `walk` 的「先访问父后访问子」把内层节点登记掉(与键位登记同一个机制),
 * 否则 `(Math.random)()` 会把同一条链报成两条违规,而模型只看得见一个名字。
 *
 * ── 模块系统消费本文件的哪一部分、为什么不消费其余部分(已落地的事实,不是预测) ──
 * `rules/module-system.ts` 与桥前缀一样判 `require` / `eval` 这两个名字,它来这里取的
 * 是**剥括号**(`withoutParentheses`)与**取成员名**(`memberNameOf`)这两条遍历层判据,
 * 却仍自己走 `walk`、不来这里取链。
 * 原因是它的判据是**「这是什么语法形态」**:它要看的是 `CallExpression` 的被调用者与实参形状,
 * 而本文件的输出一条链里不带这两样——一份链说不了「这是不是一个调用」。换句话说:
 * 三条规则共用的是「哪些位置上的标识符是一次按名字找符号、括号算不算一层东西、成员名
 * 取不取得到」这几个**遍历层判据**,不共用「怎么从链上判违规」。要为了模块系统把调用信息
 * 塞进本文件,反而会让这份公共件承担一条它不该承担的语义(那个语义属于模块系统规则自己)。
 */

import { identifierName, isAstNode, startOf, walk, type AstNode } from "../ast.ts";

/** 全局对象本身。它是「等价写法」而不是「某个对象的属性」(理由见 `withoutGlobalThis`)。 */
const GLOBAL_THIS = "globalThis";

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
 * 剥掉外面套着的括号,给出真正被引用的那个节点;不是节点就返回 undefined。
 *
 * 括号可以套多层(`((Date)).now()`),所以这里剥到不再带括号为止;每剥一层都重新要求
 * `expression` 是一个节点,所以缺了内层的括号形状(解析器换了、或节点形状变了)取到的是
 * undefined 而不是一条空链——**取不到就不出现**,与本文件其余判据同一条纪律。
 */
export const withoutParentheses = (value: unknown): AstNode | undefined => {
  let node = isAstNode(value) ? value : undefined;
  while (node?.type === "ParenthesizedExpression") {
    node = isAstNode(node.expression) ? node.expression : undefined;
  }
  return node;
};

/**
 * 这个节点是不是全局对象本身(`globalThis` / `(globalThis)`)。它供「等价写法」那一支用:
 * 两条规则判名字时都要先把这一层剥掉,理由是它是全局环境本身而不是某个对象的属性。
 */
export const isGlobalThisNode = (value: unknown): boolean =>
  identifierName(withoutParentheses(value)) === GLOBAL_THIS;

/**
 * 剥掉链开头的 `globalThis`,好让判据落在真正要改的那个名字上
 * (`globalThis.Math.random` 指的是 `Math.random`,不是那个等价前缀;带不带它不该改变判定)。
 *
 * 家在这份公共件而不是各规则自带:同一条等价规则被两条规则各写一次,迟早有一份漏掉剥,
 * 而漏掉的那一份不会让任何东西当场变红——它只是让 `globalThis.` 成了一个绕过判定链的前缀。
 */
export const withoutGlobalThis = (chain: readonly ChainSegment[]): readonly ChainSegment[] =>
  chain[0]?.name === GLOBAL_THIS ? chain.slice(1) : chain;

/**
 * 取一个节点上的标识符链;取不到就返回 undefined(理由见头注)。
 * 成员名:非计算属性取 `property.name`;计算属性取字符串字面量的值;动态下标取不到。
 * 括号不是一层东西(理由见头注):`(Math).random()` 与 `Math.random()` 取到同一条链。
 */
const chainOf = (raw: unknown): readonly ChainSegment[] | undefined => {
  const node = withoutParentheses(raw);
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
  const object = chainOf(node.object);
  if (object === undefined) {
    return undefined;
  }
  // 成员那一段的偏移指向 `property`(`.random` 里那个 `random`),它与节点不同源时退回整个成员表达式。
  const memberStart = isAstNode(property) ? startOf(property) : startOf(node);
  return [...object, { name: member, start: memberStart }];
};

/**
 * 取一个成员表达式的成员名:非计算属性取 `property.name`,计算属性取字符串字面量的值,
 * 动态下标(`Math[k]`)取不到返回 undefined。
 *
 * 家在这份公共件而不是各规则自带:「计算属性里那个字符串字面量也是一次按名字取成员」
 * 是**同一条遍历层判据**,而三处规则各自实现一遍(取链、数学成员白名单、模块系统取被调用者)
 * 迟早有一份只认非计算的那一支——`Math["random"]()` 判得出、`globalThis["eval"](s)` 看不见,
 * 而两份代码对**同一种写法**给出相反结论时,没有任何东西会当场变红。
 */
export const memberNameOf = (node: AstNode): string | undefined => {
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
 * 把括号节点的内层表达式登记下来,遍历到它时直接跳过:那条链由括号节点自己给出。
 *
 * 与键位登记同一个机制、同一理由:两处都是「同一个位置上的名字只该给出一条链」。
 * 多层括号一次登记就够——外层括号的 `expression` 是里层那个括号节点,它同样被登记,
 * 于是 `((Math)).random()` 也只给出一次出现。
 */
const markParenthesized = (node: AstNode, names: Set<AstNode>): void => {
  if (node.type === "ParenthesizedExpression" && isAstNode(node.expression)) {
    names.add(node.expression);
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
  // 两类登记共用一个集合:键位上的名字与括号的内层节点都不是一次独立的出现。
  const alreadyReported = new Set<AstNode>();
  const found: ChainReference[] = [];
  walk(program, (node) => {
    // 顺序要紧:`walk` 先访问父后访问子(见 `../ast.ts` 的头注),所以括号/解构在这里登记,
    // 轮到那些被登记的节点被访问时登记已经生效。
    markNonReferences(node, alreadyReported);
    markParenthesized(node, alreadyReported);
    if (alreadyReported.has(node)) {
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
