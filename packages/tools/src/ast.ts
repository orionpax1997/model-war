/**
 * AST 遍历的最小公共件:遍历用的节点形状、深度优先 `walk`、以及几个取名字的小工具。
 *
 * 为什么单列一份而不是各规则自带:遍历器有两条**必须**成立的性质——① 不漏子树(漏一个键就静默跳过
 * 一整棵子树),② 遍历得宽而不是窄(宁可多碰到非节点的属性值)。这两条性质一旦每个规则各实现一遍,
 * 就没有一处可以被单独盯着看;而规则层是「源码进、带行列的违规出」的一票否决层(D 的静态校验器
 * 也会建在这一层上),遍历器的疏漏是那种不会报错、只会漏放违规的失效。
 *
 * 形状刻意只取 `type` 与起止偏移,规则判断所需的 `value` / `object` / `property` 由各规则按
 * `Record` 取——oxc 的节点类型联合里 `Literal` 有六个变体,逐个 narrow 只会把类型体操搬进这里,
 * 而这层形状已经够定位与分派。
 */

export type AstNode = { readonly type: string } & Record<string, unknown>;

export const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { type?: unknown }).type === "string";

/** 标识符的名字;不是 `Identifier` 时返回 undefined。 */
export const identifierName = (value: unknown): string | undefined => {
  if (isAstNode(value) && value.type === "Identifier" && typeof value.name === "string") {
    return value.name;
  }
  return undefined;
};

export const startOf = (node: AstNode): number => (typeof node.start === "number" ? node.start : 0);
export const endOf = (node: AstNode): number => (typeof node.end === "number" ? node.end : 0);

/**
 * 深度优先遍历整棵 AST。
 *
 * 刻意**不用** oxc 导出的 `visitorKeys`:它按节点类型给出子节点键名,漏一个键就静默跳过
 * 整棵子树——而这是一条一票否决的门禁,宁可遍历得宽一点。代价是同一份 `Object.entries`
 * 会碰到非节点的属性值(正文的 `value`、正则的 `value` 等),`isAstNode` 会把它们挡掉。
 *
 * `parent` 与 `range` 两个键显式跳过:oxc 0.152.0 返回的 AST 不带 `parent` 回指(实测),
 * 跳过是为了将来上游若改为带回指时不会无限递归;`range` 是 `start`/`end` 的重复。
 */
export const walk = (value: unknown, visit: (node: AstNode) => void): void => {
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visit);
    }
    return;
  }
  if (!isAstNode(value)) {
    return;
  }
  visit(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === "parent" || key === "range") {
      continue;
    }
    walk(child, visit);
  }
};
