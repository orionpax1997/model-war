/**
 * 脚本入口规则(纯规则层):一段**编译后产物** → 一组违规(没有位置)。**不碰文件系统**,
 * 也不读时钟与环境:同一段产物永远得到同一组违规,这是生成管线每轮迭代都跑它的前提。
 *
 * ── 判据:产物顶层有没有一个能被引擎取到的 `loop` 入口 ────────────────────────────
 * hld §6.2 的「脚本入口」那一行定下的事:`tsc` 编译通过之外,产物顶层还得声明一个引擎取得到的
 * `loop`。前半句在生成管线的编译步骤里(gen 跑 tsc);这一半是**编译产物的一条静态性质**,
 * 落在本规则(裁定与为什么不在 gen 的编译步骤,见 `docs/adr/0014-...` 那份 ADR)。
 *
 * 判据按**顶层声明**判,因为引擎载入产物后走的是 `vm.global.getProp(SCRIPT_ENTRY)`
 * (见 `packages/engine/src/runner/quickjs.ts`),取到的东西必须 `typeof === "function"`。
 * 顶层 `let` / `const` 声明的名字落在**全局词法环境**里,不是全局对象自己的属性——实测
 * (`quickjs-wasi` 3.6.2 / 2026-10-11,完整记录在 hld §6.2):顶层函数声明与顶层 `var` 绑定
 * 都能被 `getProp` 取到,顶层 `let` / `const` 取到的是 `undefined`。所以判据是:
 * - `function loop(...) {}`(顶层函数声明)→ 放行(契约 §1.1 的写法);
 * - `var loop = function ... / () => ...`(顶层 `var` + 函数值)→ 放行(引擎同样取得到);
 * - 没有 `loop`、`let` / `const loop`、`var loop = 非函数`、以及写在块里的 `loop` → 违规。
 *
 * ── 判据的边界:保守的静态闸门,不是运行时数据流的完整镜像 ────────────────────────
 * 它只看顶层声明的**语法形态**,不跟踪后来的重新赋值(`var loop = function () {}; loop = 1;`
 * 这种先声明后覆盖的写法会漏),也不求值 `var loop = 某个标识符`(未知初值按「不是函数」判,
 * 宁可漏报不误伤——契约 §1.1 规定的写法是顶层函数声明,这种形态实践中不出现)。产物恒带
 * `"use strict";` 前导(`tsconfig.scripts.json` 的 `strict` 开启 `alwaysStrict`),所以块里的
 * 函数声明是块作用域、不成为全局属性,一并按违规判。
 *
 * ── 它封的是什么:一个一路绿灯的空产物 ────────────────────────────────────────
 * 模型回一个空代码围栏时,提取结果是空串,`tsc` 把空源码编译成 `"use strict";` 照样**成功**,
 * 体积、禁列、桥前缀、模块系统四级都无事可查,试跑也不看未吞异常那一轨——于是空产物被冻进赛季,
 * 每 tick 调 `loop()` 抛异常,靠 `exceptionTickLimit` 出局。这条规则是那道缺失的闸门:
 * 没有入口的产物在**冻结前**就被拦下、回喂,模型拿到的是「补上入口」而不是一局都跑不了的脚本。
 *
 * ── 为什么没有位置 ────────────────────────────────────────────────────────────
 * 判的是「某个声明**不存在**」,它没有可指向的源码位置;硬给一个 `1:1` 只会让「这个位置是猜的」
 * 消失在数据里(与 `script-size` 同一条纪律,见 `script-lint.ts` 的 `compareViolations`)。
 * 全序比较把无位置的违规落在末尾。
 *
 * ── 为什么一律 blocking ───────────────────────────────────────────────────────
 * 两份时机只对**体积**分两档(迭代期提示、冻结期拦):体积超标常要到功能写完才成为决定因素。
 * 没有入口不是「还会继续涨」,是这份产物**根本跑不起来**,早一轮告诉模型就少烧一轮预算,
 * 所以它在两相都拦。`script-lint.ts` 里「只有脚本体积分两档」这句话仍然成立。
 */

import { identifierName, isAstNode, type AstNode } from "../ast.ts";
import { parseToAst } from "../parse-source.ts";
import type { ScriptLintContext, ScriptLintStage, ScriptViolation } from "./script-lint.ts";

/**
 * 入口名。契约 §1.1 把入口名固定为 `loop`,引擎侧的同名字面量是
 * `packages/engine/src/runner/quickjs.ts` 的 `SCRIPT_ENTRY`。**这里刻意不 import 那个常量**:
 * `packages/tools` 只允许依赖真源包(hld §3.2 的依赖图),引擎那一侧进不来。同一条纪律在
 * `benchmarks/compile.ts` 的 `context["loop"]` 上已经有一份先例——入口名是契约事实,
 * 两处各自必须能独立判。
 */
const ENTRY_NAME = "loop";

/** 产物源码里写成这样就是入口:顶层函数声明,名字是 `loop`。 */
const isLoopFunctionDeclaration = (statement: AstNode): boolean =>
  statement.type === "FunctionDeclaration" && identifierName(statement["id"]) === ENTRY_NAME;

/** 函数表达式(含箭头函数):`var loop = function () {}` / `var loop = () => {}` 的初值形态。 */
const isFunctionValue = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  return node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";
};

/** 顶层 `var loop = <函数>`:引擎的 `getProp("loop")` 同样取得到。 */
const isLoopVarBinding = (statement: AstNode): boolean => {
  if (statement.type !== "VariableDeclaration" || statement["kind"] !== "var") {
    return false;
  }
  const declarations = statement["declarations"];
  if (!Array.isArray(declarations)) {
    return false;
  }
  return declarations.some(
    (declarator) =>
      isAstNode(declarator) &&
      declarator.type === "VariableDeclarator" &&
      identifierName(declarator["id"]) === ENTRY_NAME &&
      isFunctionValue(declarator["init"]),
  );
};

/** 顶层语句里有没有一个引擎取得到、且是函数的 `loop`。 */
const hasLoadableEntry = (program: unknown): boolean => {
  if (!isAstNode(program)) {
    return false;
  }
  const body = program["body"];
  if (!Array.isArray(body)) {
    return false;
  }
  return body.some((statement) => {
    if (!isAstNode(statement)) {
      return false;
    }
    return isLoopFunctionDeclaration(statement) || isLoopVarBinding(statement);
  });
};

/**
 * 那句面向模型的话。要说清三件事:引擎**怎么**取这个入口(按名字取、要函数)、
 * 当前为什么判定没有(取不到)、以及**该写成什么样**(顶层函数声明)。最后一句
 * 还点名了 `let` / `const` 为什么不行——模型最可能写的另一形态正是 `const loop = () => {}`。
 */
const ENTRY_MESSAGE =
  "找不到入口函数 `loop`:引擎载入产物后按名字取 `loop`,每个 tick 调它一次,取不到整份脚本就跑不起来。" +
  "请在文件顶层声明 `function loop() { … }`——入口必须是顶层 `function` 声明(" +
  "`let` / `const` 声明的 `loop` 引擎取不到;`var loop = function () { … }` 也可以)。";

const entryViolation = (): ScriptViolation => ({
  rule: "script-entry",
  message: ENTRY_MESSAGE,
  // 判的是「某个声明不存在」,没有可指向的位置。
  line: null,
  column: null,
  // 没有入口的产物跑不起来,两相都拦。
  blocking: true,
});

/**
 * 只看顶层 `program.body`(入口必须声明在顶层,不递归整棵树),收出本级的违规。
 * 规则层与判定链两个入口共用这一份,结论因此逐项相同(同 `script-lint.ts` 的共用纪律)。
 */
const scanParsed = (program: unknown): readonly ScriptViolation[] =>
  hasLoadableEntry(program) ? [] : [entryViolation()];

/**
 * 判定链上的这一级。上下文里已带着解析结果,所以这里**不重复解析**——判定链把「解析失败独占」
 * 挡在前面(见 `validate/pipeline.ts`);那条路径上本级返回空数组,结论归解析层。
 */
export const scriptEntryStage: ScriptLintStage = (context: ScriptLintContext) => {
  const { parsed } = context;
  return parsed === undefined || !parsed.ok ? [] : scanParsed(parsed.program);
};

/**
 * 规则层的对外缝:一段源码 → 一组违规(形状与另外几条规则同形)。判据与上面那条完全同一份扫描,
 * 所以两个入口永远给出一致的结论;共同纪律见 `script-lint.ts`。
 */
export const scriptEntryViolations = (source: string): readonly ScriptViolation[] => {
  const parsed = parseToAst(source, "script");
  return parsed.ok ? scanParsed(parsed.program) : [];
};
