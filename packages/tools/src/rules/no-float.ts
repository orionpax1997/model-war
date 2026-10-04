/**
 * 禁浮点规则(纯函数层):一段源码 → 一组带行列的违规。**不碰文件系统**,也不读时钟与环境:
 * 同一段源码永远得到同一组违规,这是门禁能进 CI 的前提。
 *
 * 依据:hld §2.2.3(确定性 Lint 一栏)、§4.6 运算一行、§1 的一票否决;需求侧是
 * FR-2 AC3 与 NFR-1。门禁的作用域(只管引擎包的运行时源码)由上层的目录薄壳决定,不在这里。
 *
 * **判据的边界,先说清**:这是一道**字面量层面的**门禁,不是表达式求值层面的。
 * 它抓的是「源码里写着小数/指数」和「`Math` 上取了白名单外的成员」,因此
 * `1 / 3` 这种「两个整数写在一起、运行时才变成浮点」的表达式它看不见。
 * 这不是漏网,是分工:静态这一层由本门禁兜住,动态那一层由 hld §2.2.4 的属性测试
 * 「NFR-1 整数闭包:`step` 输出全为整数」补上。两层都要,谁也替代不了谁。
 */

import { isAllowedMathMember } from "../allowlist.ts";
import { identifierName, isAstNode, startOf, endOf, walk, type AstNode } from "../ast.ts";
import { memberNameOf } from "./identifier-chain.ts";
import { parseToAst, positionAt, type SourceKind } from "../parse-source.ts";

/** 违规类别。`syntax-error` 不是一条规则,而是「无法判定」的确定结论:解析不过就没有干净可言。 */
export type NoFloatRule = "float-literal" | "math-member" | "syntax-error";

/** 一条违规。行列为 1 起,指向该记号(`Math.sqrt` 指 `Math`,`-1.5` 指 `1.5` 而非负号)。 */
export type NoFloatViolation = {
  readonly rule: NoFloatRule;
  readonly message: string;
  readonly line: number;
  readonly column: number;
};

/** 收集阶段先记偏移,最后统一换算行列——避免每个节点都重算一次行号。 */
type PendingViolation = {
  readonly start: number;
  readonly rule: NoFloatRule;
  readonly message: string;
};

/**
 * 唯一的对外入口:检查一段源码里的字面量与 `Math` 成员。
 *
 * 语法错误是**确定性的拒绝**,并且独占结果:oxc 解析失败时返回的是一棵残缺的树,在残树上
 * 跑规则只会得到不可复现的结论,所以此时只报 `syntax-error`,一条规则违规都不报。
 * 「解析不过的源码」在任何分支下都不会被报成干净。
 */
export const noFloatViolations = (
  source: string,
  kind: SourceKind = "module",
): readonly NoFloatViolation[] => {
  const parsed = parseToAst(source, kind);
  if (!parsed.ok) {
    return parsed.errors.map((error) => ({
      rule: "syntax-error",
      message: `源码无法解析:${error.message}`,
      line: error.line,
      column: error.column,
    }));
  }

  const found: PendingViolation[] = [];
  walk(parsed.program, (node) => {
    const literal = checkNumericLiteral(node, source);
    if (literal !== undefined) {
      found.push(literal);
    }
    const member = checkMathMember(node, source);
    if (member !== undefined) {
      found.push(member);
    }
  });

  // 输出按源码位置排序:遍历是按对象的键序走的,那不保证与源码顺序一致,而门禁的输出
  // 要能直接 diff。同一位置(理论上不该出现)按类别名兜底,保证全序。
  found.sort((left, right) => left.start - right.start || left.rule.localeCompare(right.rule));
  return found.map((violation) => {
    const { line, column } = positionAt(source, violation.start);
    return { rule: violation.rule, message: violation.message, line, column };
  });
};

/* ── 规则一:数值字面量 ─────────────────────────────────────────── */

const NUMERIC_BASE_PREFIX = /^0[xXbBoO]/;
const DECIMAL_POINT_OR_EXPONENT = /[.eE]/;

/**
 * 字面量的书写形式必须落在「十进制、无小数点、无指数」上。
 *
 * 判据是**原始文本**而不是求值结果:`1e3`/`1.0`/`2E2` 求值都是整数,正是因此才危险——
 * 它们绕过的是「整数闭包」这件事在字面审视层面的可见性:人扫一眼 `1e3` 看到整数就放行,
 * 而 `1.5e3` 会被同样放过。把书写形式本身纳入判据,那类写法就再也藏不住。
 *
 * 非十进制进制(0x/0b/0o)与数字分隔符(`1_000`)**放行**:它们求值必为整数,且每一位都可
 * 逐位读出,不带任何「求值后才知道是不是整数」的信息。注意前缀之后的 `e`/`E` 是十六进制
 * 数字而不是指数,`0xE1` 是最容易被误伤成指数的写法,所以带前缀的分支直接放行。
 */
const isIntegerLiteralText = (raw: string, value: number): boolean => {
  if (!Number.isInteger(value)) {
    return false;
  }
  if (NUMERIC_BASE_PREFIX.test(raw)) {
    return true;
  }
  return !DECIMAL_POINT_OR_EXPONENT.test(raw);
};

const checkNumericLiteral = (node: AstNode, source: string): PendingViolation | undefined => {
  if (node.type !== "Literal") {
    return undefined;
  }
  const { value } = node;
  if (typeof value === "bigint") {
    // `10n` 是整数,放行。顺带一提:节点的 `value` 是真的 BigInt,`JSON.stringify` 碰到它会抛,
    // 所以本模块任何地方都不去序列化 AST(违规只带 message/line/column 出去)。
    return undefined;
  }
  if (typeof value !== "number") {
    // 字符串、正则、布尔、null:与本规则无关。
    return undefined;
  }
  const start = startOf(node);
  const raw = typeof node.raw === "string" ? node.raw : source.slice(start, endOf(node));
  if (isIntegerLiteralText(raw, value)) {
    return undefined;
  }
  return {
    start,
    rule: "float-literal",
    message: `字面量 \`${raw}\` 不是整数字面量:小数点或指数写法即便求值为整数也判违规`,
  };
};

/* ── 规则二:`Math` 成员按允许名单区分 ──────────────────────────── */

const MATH_GLOBAL = "Math";

/**
 * 全局对象本身。它是「等价写法」而不是「某个对象的属性」(同一条纪律在
 * `rules/identifier-chain.ts` 的 `withoutGlobalThis` 侧也有一份)。**这里刻意不共用那份**:
 * 那份公共件是参赛脚本静态校验三条规则的遍历层公共件,本文件是本 feature 之前的仓库门禁,
 * 让一条零构建的快门禁依赖本 feature 的新文件会把两个消费者的变更面绑在一起。
 * 代价记在这里:同一条等价规则有两份,改一处必须记得改另一处。
 */
const GLOBAL_THIS = "globalThis";

/**
 * 成员访问的对象是不是全局 `Math`。认 `Math.x`,也认等价的 `globalThis.Math.x`;
 * `x.Math.floor` 里的 `Math` 是某个对象的属性,不是全局对象,故不认。
 *
 * 裸的 `Math`(不经成员访问,如 `const m = Math;` 后再 `m.random()`)不在本规则范围内:
 * 那是「全局引用」一类规则的事,hld §6.2 由白名单/黑名单式的全局检查承担,归属另一个消费者。
 *
 * ── 一处判不到的地方(有记录的缺口,不是遗漏) ──────────────────────────────────
 * 本规则**不剥括号**:`(globalThis.Math).random()` 与 `(globalThis).Math.random()` 都不判
 * (实测 2026-10-03,`oxc-parser` 0.152.0)。参赛脚本那条规则链已经剥了,理由与做法见
 * `rules/identifier-chain.ts` 的头注。
 * **这里不跟**:门禁扫的是本仓库自己的引擎源码(我们自己写的,不存在绕过动机),
 * 而本规则按它自己的定位是**字面量层面**的一道纵深防御,真正的兜底是 hld §2.2.4 那条属性测试。
 * 若将来本门禁的输入变成**不受信任的源码**,这一处必须先补上——那时它就是一条绕开路径了。
 */
const isMathObject = (object: unknown): boolean => {
  if (identifierName(object) === MATH_GLOBAL) {
    return true;
  }
  return (
    isAstNode(object) &&
    object.type === "MemberExpression" &&
    object.computed !== true &&
    identifierName(object.object) === GLOBAL_THIS &&
    identifierName(object.property) === MATH_GLOBAL
  );
};

/** 成员名取法收在 `identifier-chain.ts` 的公共件里(理由见它的头注):同一判据留两份,迟早有一份漏改。 */
const checkMathMember = (node: AstNode, source: string): PendingViolation | undefined => {
  if (node.type !== "MemberExpression" || !isMathObject(node.object)) {
    return undefined;
  }
  const member = memberNameOf(node);
  if (member !== undefined && isAllowedMathMember(member)) {
    return undefined;
  }
  // 动态下标(`Math[k]`)取不到成员名,按「不在名单内」处理:门禁的契约是白名单,不是黑名单。
  const start = startOf(node);
  return {
    start,
    rule: "math-member",
    message: `\`${source.slice(start, endOf(node))}\` 不是允许名单内的 \`Math\` 成员:引擎只允许产出整数的成员`,
  };
};

/* ── AST 遍历 ──────────────────────────────────────────────────── */

/**
 * 节点形状、`walk` 与取名字的小工具都搬到了 `../ast.ts`:遍历器是规则层共享的那一件,
 * 各规则自带一份就等于各有一处「漏一个键 ⇒ 静默跳过整棵子树」的可能,理由见那个文件的头注。
 */
