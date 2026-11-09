/**
 * 条件断言扫描(纯函数层):一段测试源码 → 「哪些 `expect` 写在条件分支里 / 哪些用例可能零断言执行」。
 *
 * ── 为什么要有这一层(它和 oxlint 那条规则不是一回事)─────────────────────────────
 *
 * oxlint 的 `vitest/no-conditional-expect` 只报「`expect` 写在 `if` / 三元里」的位置。
 * 它不知道**这件事有多坏**:仓库里绝大多数命中是「有就查」——条件为假时那件事压根没发生,
 * 不查是对的。所以单看命中数(本仓 100 处)既不能判缺陷,也不能判无害。
 *
 * 这一层补的是规则不回答的那一问:**这条断言可能整条不执行吗?**
 * 判据落在用例级:一个用例里的 `expect` **全部**写在条件体内时,条件为假的那条路径上
 * 这条用例就**一条断言都没跑**——它照样绿。而 `vitest/expect-expect` 抓不到这种假绿:
 * 那条规则看的是**静态上有没有** `expect`,不是运行时跑了没有。
 * 于是「测试全绿但什么都没验」就有了一个静态可查、位置精确的落点。
 *
 * 三个判定(互相独立,可叠加):
 *   · `all-conditional`  —— 该用例的全部 `expect` 都在条件体内 → 条件为假时零断言执行(高危)。
 *   · `partly-conditional` —— 部分在条件体内 → 某些分支没有断言(中危:盲区)。
 *   · `dead-condition`   —— 条件是字面量常量 → 那一支永远不执行(断言写了等于没写)。
 *
 * ── 边界:这一层是**诊断**,不是门禁 ──────────────────────────────────────────────
 *
 * 它只报位置与形态,不判「该不该改」。改断言强度是判据决策(要人拍板),
 * 所以这里不做「该不该改」的判断,只把「可能不执行」这件事精确到行列。
 * 处置结论落在上层报告里(`diagnose-vitest-rules.ts`)。
 *
 * 不碰文件系统、不读时钟:同一段源码永远得到同一份结论,这是它能被门禁引用的前提。
 */

import {
  identifierName,
  isAstNode,
  startOf,
  endOf,
  walkWithAncestors,
  type AstNode,
} from "../ast.ts";
import { parseToAst, positionAt, type SourceKind } from "../parse-source.ts";

/** `expect` 所处的条件形态。`plain` = 不在任何条件体内。 */
export type ExpectShape =
  | "plain"
  | "if-guard"
  | "loop-body"
  | "ternary"
  | "logical"
  | "switch-case"
  | "catch-body";

/**
 * 「守卫」形态:命中它意味着这条断言**可能整条不执行**。
 *
 * `loop-body` 不在其中——循环体里的断言是逐元素检查的常规写法(property test 对每个
 * 生成值断言),它的风险是另一种(「循环可能一次都不跑」),单列,不当守卫算。
 */
export const GUARD_SHAPES: readonly ExpectShape[] = [
  "if-guard",
  "ternary",
  "logical",
  "switch-case",
  "catch-body",
];

const isGuardShape = (shape: ExpectShape): boolean => GUARD_SHAPES.includes(shape);

/** 一处 `expect` 的落点与形态。 */
export type ExpectSite = {
  readonly line: number;
  readonly column: number;
  /** 该落点在源码里的起始偏移(用来比较先后)。 */
  readonly start: number;
  readonly shape: ExpectShape;
  /** 条件的源码文本(截断到 120 字符);`shape` 为 `plain` 时为空串。 */
  readonly conditionText: string;
  /** 条件是不是字面量常量(`if (true)` / `if (false)`)。 */
  readonly conditionIsConstant: boolean;
  /** 是否在 `it` / `test` 的回调体内。 */
  readonly inTestBody: boolean;
  /** 所属用例名(在测试体内时才有)。 */
  readonly testName: string | undefined;
};

/** 一个用例的判定。 */
export type TestCaseVerdict = {
  readonly testName: string;
  readonly line: number;
  /** 该用例里的 `expect` 总数。 */
  readonly total: number;
  /** 其中写在守卫体内的个数(可能整条不执行的那些)。 */
  readonly conditional: number;
  /** 其中写在循环体内的个数。 */
  readonly inLoop: number;
  /** 该用例有没有「条件不满足就提前 return」的静默跳过。 */
  readonly silentSkip: boolean;
  /** 判定。`total === 0` 记 `no-expect`(交给 `vitest/expect-expect` 那条规则管)。 */
  readonly verdict: "all-conditional" | "partly-conditional" | "none" | "no-expect" | "loop-only";
};

/**
 * 早退的形态。三类对应三种不同的处置:
 *
 * · `narrowing` —— 断言在前、`if` 在后,只是为了让编译器知道后面能访问窄化后的字段。
 *   **无害**:断言已经跑过了。
 * · `catch-filter` —— 在 `catch` 里按错误类型分流:这类错误不查,别的错误照查。
 *   有盲区(这类错误发生时这条用例什么都没验),但意图明确。
 * · `precondition` —— 「前置条件不满足就不查」:读不到产物、环境没备好就跳过。
 *   **真风险**:环境一变,这条用例就静默变绿,而没人知道它没跑。
 * · `branch-filter` —— 其余的分支过滤(property test 里「只对某些取值断言」是常规写法)。
 */
export type SilentSkipKind = "narrowing" | "catch-filter" | "precondition" | "branch-filter";

/** 一处「条件不满足就提前 return」的静默跳过。 */
export type SilentSkipSite = {
  readonly line: number;
  readonly column: number;
  readonly conditionText: string;
  readonly testName: string | undefined;
  readonly kind: SilentSkipKind;
  /** 早退的作用域:`case` = 整条用例(用例体本身早退);`local` = 局部辅助函数。 */
  readonly scope: "case" | "local";
  /** 早退之后,同一个函数体内还有没有 `expect`。没有 → 早退发生时那部分零断言。 */
  readonly assertsAfter: boolean;
};

/** 一次扫描的全部结论。 */
export type ConditionalExpectScan = {
  readonly sites: readonly ExpectSite[];
  readonly cases: readonly TestCaseVerdict[];
  readonly silentSkips: readonly SilentSkipSite[];
  /** 源码解析不过时的诊断;非空时其余结论为空(残树上的结论不可复现)。 */
  readonly parseErrors: readonly string[];
};

/** 条件文本的截断长度:报告里一行的宽度有限,超长条件只留头。 */
const CONDITION_TEXT_LIMIT = 120;

/** 祖先链里最近的那个「会决定要不要执行」的节点。 */
const conditionalAncestor = (
  ancestors: readonly AstNode[],
): { readonly shape: ExpectShape; readonly node: AstNode } | undefined => {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const node = ancestors[index];
    if (node === undefined) {
      continue;
    }
    switch (node.type) {
      case "IfStatement":
      case "WhileStatement":
      case "DoWhileStatement":
        return { shape: "if-guard", node };
      case "ForStatement":
      case "ForOfStatement":
      case "ForInStatement":
        return { shape: "loop-body", node };
      case "ConditionalExpression":
        return { shape: "ternary", node };
      case "LogicalExpression":
        return { shape: "logical", node };
      case "SwitchCase":
        return { shape: "switch-case", node };
      case "CatchClause":
        return { shape: "catch-body", node };
      default:
        break;
    }
  }
  return undefined;
};

/** 条件节点里取的「条件表达式」:不同节点的字段名不一样。 */
const conditionExpressionOf = (node: AstNode): AstNode | undefined => {
  if (node.type === "IfStatement" || node.type === "WhileStatement") {
    return node.test as AstNode | undefined;
  }
  if (node.type === "DoWhileStatement") {
    return node.test as AstNode | undefined;
  }
  if (node.type === "ForStatement") {
    return node.test as AstNode | undefined;
  }
  if (node.type === "ConditionalExpression" || node.type === "LogicalExpression") {
    return node.test as AstNode | undefined;
  }
  if (node.type === "SwitchCase") {
    return node.test as AstNode | undefined;
  }
  return undefined;
};

/** 条件是不是字面量常量。只有 `true` / `false` 两种写法算数。 */
const isConstantCondition = (expression: AstNode | undefined): boolean =>
  expression !== undefined &&
  expression.type === "Literal" &&
  (expression.value === true || expression.value === false);

/** `it` / `test` 的第一个参数是名字,第二个参数是回调。 */
const testNameOf = (call: AstNode): string | undefined => {
  const first = Array.isArray(call.arguments) ? call.arguments[0] : undefined;
  if (first === undefined) {
    return undefined;
  }
  if (first.type === "Literal" && typeof first.value === "string") {
    return first.value;
  }
  if (first.type === "TemplateLiteral") {
    const quasi = Array.isArray(first.quasis) ? first.quasis[0] : undefined;
    if (quasi !== undefined && typeof quasi.value === "string") {
      return quasi.value;
    }
  }
  return undefined;
};

const isTestCall = (call: AstNode): boolean => {
  const name = identifierName(call.callee);
  return name === "it" || name === "test";
};

/**
 * 扫描一段测试源码,给出条件断言的落点与用例级判定。
 *
 * 解析不过时**只**返回解析诊断,不给任何结论:oxc 解析失败时给的是一棵残缺的树,
 * 在残树上判「这条 expect 在不在条件体内」得到的是不可复现的结论。
 */
export const scanConditionalExpects = (
  source: string,
  kind: SourceKind = "module",
): ConditionalExpectScan => {
  const parsed = parseToAst(source, kind);
  if (!parsed.ok) {
    return {
      sites: [],
      cases: [],
      silentSkips: [],
      parseErrors: parsed.errors.map((error) => `${error.line}:${error.column} ${error.message}`),
    };
  }

  const sites: ExpectSite[] = [];
  /** 每个用例的落点集合:键是用例名,值是落点序号。 */
  const caseSites = new Map<string, number[]>();
  /** 所有 `expect` 的起始偏移:用来判「早退之前有没有断言」。 */
  const expectStarts: number[] = [];

  walkWithAncestors(parsed.program, (node, ancestors) => {
    if (node.type !== "CallExpression") {
      return;
    }
    if (identifierName(node.callee) !== "expect") {
      return;
    }
    // 找所属的测试调用:祖先链里最近的那个 `it` / `test`。
    const testCall = [...ancestors]
      .reverse()
      .find((ancestor) => ancestor.type === "CallExpression" && isTestCall(ancestor));
    const testName = testCall === undefined ? undefined : testNameOf(testCall);
    const inTestBody = testCall !== undefined;

    const conditional = conditionalAncestor(ancestors);
    const expression =
      conditional === undefined ? undefined : conditionExpressionOf(conditional.node);
    const conditionText =
      expression === undefined
        ? ""
        : source.slice(startOf(expression), endOf(expression)).replace(/\s+/gu, " ").trim();

    const { line, column } = positionAt(source, startOf(node));
    const site: ExpectSite = {
      line,
      column,
      start: startOf(node),
      shape: conditional?.shape ?? "plain",
      conditionText:
        conditionText.length > CONDITION_TEXT_LIMIT
          ? `${conditionText.slice(0, CONDITION_TEXT_LIMIT)}…`
          : conditionText,
      conditionIsConstant: isConstantCondition(expression),
      inTestBody,
      testName,
    };
    expectStarts.push(startOf(node));
    const index = sites.push(site) - 1;
    if (testName !== undefined) {
      const bucket = caseSites.get(testName);
      if (bucket === undefined) {
        caseSites.set(testName, [index]);
      } else {
        bucket.push(index);
      }
    }
  });

  // 第二遍:找「条件不满足就提前 return」的静默跳过。
  //
  // 它比条件断言更隐蔽:那条用例在条件不满足时**一条断言都没跑**,却仍然是绿的——
  // 与「`expect` 写在 `if` 里」是同一类假绿,但 oxlint 那条规则看不见它(`if` 体里没有 `expect`)。
  const silentSkips: SilentSkipSite[] = [];
  const silentSkipCases = new Set<string>();

  walkWithAncestors(parsed.program, (node, ancestors) => {
    if (node.type !== "ReturnStatement") {
      return;
    }
    // 用例回调的边界:祖先链里最近的那个函数节点。再往里的函数不算这条用例的早退。
    const functionBoundary = [...ancestors]
      .reverse()
      .find(
        (ancestor) =>
          ancestor.type === "FunctionExpression" || ancestor.type === "ArrowFunctionExpression",
      );
    if (functionBoundary === undefined) {
      return;
    }
    const guard = [...ancestors].reverse().find((ancestor) => ancestor.type === "IfStatement");
    if (guard === undefined) {
      return;
    }
    // 守卫必须与这个函数边界在同一层:嵌套函数里的 `return` 不算这条用例的早退。
    if (startOf(guard) < startOf(functionBoundary) || endOf(guard) > endOf(functionBoundary)) {
      return;
    }
    // 早退必须在 `if` 的 consequent 里(在 alternate 里不算——那是「条件不满足就继续查」)。
    const consequent = guard.consequent as AstNode | undefined;
    if (consequent === undefined) {
      return;
    }
    if (startOf(node) < startOf(consequent) || endOf(node) > endOf(consequent)) {
      return;
    }
    const guardExpression = guard.test as AstNode | undefined;
    const rawText =
      guardExpression === undefined
        ? ""
        : source
            .slice(startOf(guardExpression), endOf(guardExpression))
            .replace(/\s+/gu, " ")
            .trim();
    const testCall = [...ancestors]
      .reverse()
      .find(
        (ancestor) =>
          ancestor.type === "CallExpression" &&
          isTestCall(ancestor) &&
          startOf(ancestor) <= startOf(functionBoundary),
      );
    const testName = testCall === undefined ? undefined : testNameOf(testCall);
    // 「断言在前、`if` 在后」的 TypeScript 收窄惯用法不算静默跳过:
    // 那条 `if` 只是为了让编译器知道后面能访问窄化后的字段,断言已经跑过了。
    //
    // 判据是「同一个函数体内、早退之前有没有 `expect`」——不看用例名:property test 里
    // 的断言不在 `it` 回调内,用用例名去比会漏掉它们,把收窄惯用法误报成跳过。
    const assertedBefore = expectStarts.some(
      (start) => start > startOf(functionBoundary) && start < startOf(node),
    );
    if (assertedBefore) {
      return;
    }
    const inCatch = ancestors.some((ancestor) => ancestor.type === "CatchClause");
    const kind: SilentSkipKind = inCatch
      ? "catch-filter"
      : /^(?:.*\s*)?(?:===|==)\s*(?:undefined|null)\b/u.test(rawText) || rawText.startsWith("!")
        ? "precondition"
        : "branch-filter";
    // 早退之后同一个函数体内还有没有断言:没有的话,早退发生时那部分一条都没验。
    const assertsAfter = expectStarts.some(
      (start) => start > startOf(node) && start <= endOf(functionBoundary),
    );
    // 作用域:早退所在的函数就是用例回调本身 → 整条用例跳过;否则只是局部。
    const callback = testCall === undefined ? undefined : (testCall.arguments as unknown[])[1];
    const scope: "case" | "local" =
      callback !== undefined &&
      isAstNode(callback) &&
      startOf(callback) === startOf(functionBoundary)
        ? "case"
        : "local";
    const { line, column } = positionAt(source, startOf(node));
    silentSkips.push({
      line,
      column,
      kind,
      scope,
      assertsAfter,
      conditionText:
        rawText.length > CONDITION_TEXT_LIMIT
          ? `${rawText.slice(0, CONDITION_TEXT_LIMIT)}…`
          : rawText,
      testName,
    });
    if (testName !== undefined) {
      silentSkipCases.add(testName);
    }
  });

  const cases: TestCaseVerdict[] = [];
  for (const [testName, indexes] of caseSites) {
    const total = indexes.length;
    const conditional = indexes.filter((index) => {
      const site = sites[index];
      return site !== undefined && isGuardShape(site.shape);
    }).length;
    const inLoop = indexes.filter((index) => {
      const site = sites[index];
      return site !== undefined && site.shape === "loop-body";
    }).length;
    const first = sites[indexes[0] ?? -1];
    const verdict: TestCaseVerdict["verdict"] =
      total === 0
        ? "no-expect"
        : conditional === total
          ? "all-conditional"
          : conditional > 0
            ? "partly-conditional"
            : inLoop === total
              ? "loop-only"
              : "none";
    cases.push({
      testName,
      line: first?.line ?? 0,
      total,
      conditional,
      inLoop,
      silentSkip: silentSkipCases.has(testName),
      verdict,
    });
  }
  cases.sort(
    (left, right) => left.line - right.line || left.testName.localeCompare(right.testName),
  );
  sites.sort((left, right) => left.line - right.line || left.column - right.column);
  silentSkips.sort((left, right) => left.line - right.line);

  return { sites, cases, silentSkips, parseErrors: [] };
};
