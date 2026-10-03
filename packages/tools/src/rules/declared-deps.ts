/**
 * 「声明即依赖」规则(纯函数层):一段源码 + 本包已声明的依赖集合 → 一组带行列的违规。
 * **不碰文件系统**,也不读时钟与环境:同一段源码永远得到同一组违规,这是门禁能进 CI 的前提。
 *
 * 这条规则补的是 `.dependency-cruiser.js` 头注里记着的那个缺口的**另一半**:工具包以源码形态执行,
 * `dist` 里没有 `.js`,所以 depcruise 巡航不到它(详见 `.dependency-cruiser.js` 与
 * `packages/tools/src/gate/declared-deps-gate.ts` 的头注)。实测过的偷跑形态是:
 * `packages/tools/src` 里 import `oxc-parser` / `fast-check` / `vitest` / `ajv` / `esbuild`,
 * 而 `packages/tools/package.json` 一个都没声明——Node 与 TypeScript 的模块解析一路向上找
 * `node_modules`,workspace 根把所有 devDependency 摆平了,于是 `tsc -b` 退出 0。
 * 那条边能编过只是因为根目录装了它,不等于本包声明了它:换一次安装(只装生产依赖)、或者把这个包
 * 挪到另一个工作区,本包就断了,而断点在运行那一刻才暴露。
 *
 * 判据只有一条:**运行时源码里出现的每一个裸包说明符,包名都必须在 `dependencies` 里**。
 * 三类说明符不在此列,且各有理由:
 * - 相对与绝对路径(`./x.ts`、`/abs/x`):本包内部引用,不存在「声明」这件事;
 * - 内建模块(`node:fs`,以及不带前缀的 `fs`):Node 提供的,不是包。前缀形式是仓库里的一处自洽写法,
 *   但强制它是 lint 的职责,本门禁两种写法都放行,不把风格纪律混进依赖纪律;
 * - 测试与属性测试文件:它们需要 vitest / fast-check,而这两个是**根** devDependency。
 *   这条豁免与 dependency-cruiser 的测试豁免同源(门禁约束的是运行时代码),由上层的目录薄壳执行。
 *
 * 为什么 `devDependencies` 不算数:本包没有构建步骤,整份源码由 Node 直接执行,所以它在运行时
 * 需要的东西全是运行时依赖。把 `oxc-parser` 写进 `devDependencies` 却从 `parse-source.ts` 里 import,
 * 是一句关于「本包需要什么」的假话——而这句话正是这条规则要守的东西。
 */

import { builtinModules } from "node:module";

import { identifierName, isAstNode, startOf, walk, type AstNode } from "../ast.ts";
import { parseToAst, positionAt } from "../parse-source.ts";

/** 违规类别。`syntax-error` 不是一条规则,而是「无法判定」的确定结论:解析不过就没有干净可言。 */
export type DeclaredDepsRule = "undeclared-dependency" | "syntax-error";

/** 一条违规。行列为 1 起,指向那个 import 说明符本身。 */
export type DeclaredDepsViolation = {
  readonly rule: DeclaredDepsRule;
  /** 违规涉及的说明符原文(包名取自它);语法错误时为空串。 */
  readonly specifier: string;
  readonly message: string;
  readonly line: number;
  readonly column: number;
};

/** 收集阶段先记偏移,最后统一换算行列——避免每个节点都重算一次行号。 */
type PendingViolation = {
  readonly start: number;
  readonly rule: DeclaredDepsRule;
  readonly specifier: string;
  readonly message: string;
};

/**
 * Node 内建模块名(不含 `node:` 前缀)。取自 `node:module` 而不是硬编码一张表:
 * 硬编码的那张表会随 Node 版本过期,而过期的表在这里表现为**假红**(新内建模块被判成未声明的包)。
 */
const CORE_MODULES: ReadonlySet<string> = new Set(builtinModules);

/** 说明符是否指向本包内部(相对 / 绝对路径)。`#` 形如 Node 的 imports 字段,也算包内解析,同样放行。 */
const isInternalSpecifier = (specifier: string): boolean =>
  specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#");

/**
 * 说明符 → 它所属的**包名**:`pkg/sub` ⇒ `pkg`,`@scope/pkg/sub` ⇒ `@scope/pkg`。
 *
 * 包名而不是说明符本身才是声明的粒度:声明 `oxc-parser` 就等于声明它的所有子路径导出。
 * 非包说明符(内建模块、相对路径)返回 undefined。
 */
export const packageNameOf = (specifier: string): string | undefined => {
  if (isInternalSpecifier(specifier) || specifier.startsWith("node:")) {
    return undefined;
  }
  if (CORE_MODULES.has(specifier)) {
    return undefined;
  }
  const segments = specifier.split("/");
  const scoped = specifier.startsWith("@");
  if (scoped) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : specifier;
  }
  return segments[0];
};

/** 节点上的字符串字面量说明符;非字面量(变量、模板串)返回 undefined。 */
const literalSpecifierOf = (value: unknown): string | undefined => {
  if (isAstNode(value) && value.type === "Literal" && typeof value.value === "string") {
    return value.value;
  }
  return undefined;
};

/**
 * 一个节点带出来的依赖说明符。静态 import、`export … from`、动态 `import()`、`require()`
 * 四种形态都要收:它们在运行时同样会去解析那个包,而 `require`/`import()` 这两种还能绕过
 * 「只有 import 声明才算依赖」的读法。只在 AST 里看 `ImportDeclaration` 是不够的。
 */
const specifiersOf = (node: AstNode): readonly string[] => {
  switch (node.type) {
    case "ImportDeclaration":
    case "ExportNamedDeclaration":
    case "ExportAllDeclaration":
    case "ImportExpression": {
      const specifier = literalSpecifierOf(node.source);
      return specifier === undefined ? [] : [specifier];
    }
    case "CallExpression": {
      if (identifierName(node.callee) !== "require") {
        return [];
      }
      const specifier = Array.isArray(node.arguments)
        ? literalSpecifierOf(node.arguments[0])
        : undefined;
      return specifier === undefined ? [] : [specifier];
    }
    default:
      return [];
  }
};

/**
 * 唯一的对外入口:检查一段源码里的每一个依赖说明符是否已在 `declared` 里。
 *
 * 语法错误是**确定性的拒绝**,并且独占结果(与禁浮点规则同一条纪律):oxc 解析失败时返回的是一棵
 * 残缺的树,在残树上跑规则只会得到不可复现的结论,所以此时只报 `syntax-error`。
 * 「解析不过的源码」在任何分支下都不会被报成干净——不然这道门禁就成了一个输入侧的旁路。
 *
 * 说明符取不到名字的情况(动态 `import(someVariable)`)按**不报**处理:门禁断言的是「声明即依赖」,
 * 而取不到名字时能给出的判断是「我看不见」而不是「它没声明」。这个洞的代价有限且已知:
 * 本包的运行时代码里没有任何一处动态 import,且 D 的静态校验器本就禁动态 import(hld §6.2 模块系统一栏)。
 *
 * ── 一处刻意划在范围外的形态:`require.resolve("pkg")` ──
 * 它只解析不加载,而本包里唯一的用法(`toolchain-coupling.ts` 读根 devDependency 的 package.json)
 * 要的并不是「本包运行时依赖它」——按字面把它追成本包的运行时依赖,等于在 manifest 里把
 * `typescript` / `oxlint-tsgolint` 各抄一份版本范围,而它们的配套关系已经由
 * `toolchain-coupling.ts` 那道断言在根 manifest 上盯着(hld §2.2.8:devDependencies 全仓库共享)。
 * 抄一份只会新增一处会漂移的版本串,所以这里明确不收:这是划在范围外,不是没看见。
 * 真正的取舍是:用 `require.resolve` 绕过本门禁去按名取一个包是可行的,代价是它在本仓库里没有正当理由。
 */
export const undeclaredDependencyViolations = (
  source: string,
  declared: ReadonlySet<string>,
): readonly DeclaredDepsViolation[] => {
  const parsed = parseToAst(source);
  if (!parsed.ok) {
    return parsed.errors.map((error) => ({
      rule: "syntax-error",
      specifier: "",
      message: `源码无法解析:${error.message}`,
      line: error.line,
      column: error.column,
    }));
  }

  const found: PendingViolation[] = [];
  walk(parsed.program, (node) => {
    for (const specifier of specifiersOf(node)) {
      const packageName = packageNameOf(specifier);
      if (packageName === undefined || declared.has(packageName)) {
        continue;
      }
      found.push({
        start: startOf(node),
        rule: "undeclared-dependency",
        specifier,
        message: `import 了未声明的依赖 \`${packageName}\`:本包运行时用到的包必须在 packages/tools/package.json 的 dependencies 里声明(它现在能编过只是因为 workspace 根装了它)`,
      });
    }
  });

  // 输出按源码位置排序:遍历是按对象的键序走的,那不保证与源码顺序一致,而门禁的输出
  // 要能直接 diff。同一位置按包名兜底,保证全序。
  found.sort(
    (left, right) => left.start - right.start || left.specifier.localeCompare(right.specifier),
  );
  return found.map((violation) => {
    const { line, column } = positionAt(source, violation.start);
    return { ...violation, line, column };
  });
};
