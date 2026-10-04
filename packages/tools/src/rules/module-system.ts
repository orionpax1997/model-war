/**
 * 模块系统规则(纯规则层):一段源码 → 一组带行列的违规。**不碰文件系统**,也不读时钟与环境:
 * 同一段源码永远得到同一组违规,这是生成管线每轮迭代都跑它、能 diff 两轮结果的前提。
 *
 * 形状与 `rules/forbidden-globals.ts` 同形(纯规则 → 阶段 → 判定链),判据与那条规则正交:
 * 禁列判的是「这个**名字**能不能查得到全局」,本规则判的是「这段代码是不是从自己之外取来的」。
 *
 * ── 判据:五种形态,命中即违规,一律 blocking ──────────────────────────────────
 * hld §2.2.2 的入口契约定稿是「单文件 script-mode,不写 `export` / `import`」,而实测结论是:
 * 带 `export` 的产物在沙箱载入期取 `SyntaxError: unsupported keyword: export`,静态 `import` 同理
 * (VM 内以 `evalCode` 载入、`moduleLoader` 不配置)。那是**编译期即可判定**的事实,
 * 不该留到运行时装载失败才发现——那时模型已经烧掉了一整轮迭代预算。
 * 五种形态:静态 `import` 声明、静态 `export` 声明、动态 `import()`、`require()`、动态 `eval()`。
 *
 * ── 边界:为什么源形态本身**不**保证「单文件自包含」 ──────────────────────────
 * 这一条与本规则的存在理由是同一件事,从里往外说:本规则跑在 script 源形态上,而
 * **oxc-parser 0.152.0 在 `sourceType: "script"` 下照样为模块语法生成节点**,不报解析错误
 * (实测:`export const a = 1` / `import x from "std"` / `import("std")` 三种都解析成立,
 * 分别是 `ExportNamedDeclaration` / `ImportDeclaration` / `ImportExpression`)。
 * 所以「载入期会取 SyntaxError」这个事实**不会**由解析层挡下来——解析层放它们过去,
 * 本规则才是把这条契约变成一条编译期结论的地方。把这条写在头注里,是为了让后来者
 * 不至于以为「源形态选对了,单文件自包含就自动成立」而去删掉这一级。
 * 顺带一条实测:同一形态下 `import.meta` 由 oxc 直接判**解析失败**,归判定链独占的那条
 * `syntax-error`,本规则见不到它(也不需要见)。
 *
 * ── 裁决:动态 `eval` 拦、静态 `eval` 不拦 ────────────────────────────────────
 * 判据落在**实参的形状**上:直接调用 `eval` / `globalThis.eval` 且**剥掉括号后的第一个实参
 * 是字符串字面量**算静态(不拦);其余一切算动态(拦)。括号在 JS 里是纯分组,**不改变被引用的是谁**
 * ——`eval(("1+1"))` 与 `eval("1+1")` 求值的是同一段编译期就写定的常量,没有理由一个放行一个拦,
 * 误伤一份本来能跑的脚本在五轮预算里是纯亏损。
 * 括号那一层与下面「不做常量折叠」**不是一回事**:折叠要一层求值器(另一个成本层级),
 * 剥括号不要——它与 `(Math).random()` 那侧是同一条遍历层纪律。在**这条 eval 裁决里**剥括号
 * 只落在实参这一侧(被调用者那一侧的剥括号是既有判据,见下面 `calleeNameOf`),纪律本身与
 * 它和常量折叠的分工见 `identifier-chain.ts` 头注与本段下文。
 * 为什么不拦静态的那一种:
 * - 它是本规则五形态里唯一「拦了没有收益」的一种。静态 `eval` 被求值的文本是**编译期就完全写定
 *   的一段常量**,它能做到的最坏结果与「把这几行直接写进脚本」完全等价;而拦住它的代价是模型
 *   必须把同样的代码换个写法重来一轮——五轮迭代预算花在这上面是纯亏损(user story 3/4 的反面)。
 * - 动态的那一种才是越权口子:被求值的文本在运行期才确定,静态这一层对它无能为力,
 *   而它做到的事与 `import()` 同级(hld §5.2:越权的防线是静态禁令,不是运行时容错)。
 * 判据整体**偏向拦截**:除「首个实参是字符串字面量」外的每一种形态(变量、模板串含插值、
 * 字符串拼接、无参、经别的路径中转)都按动态判并拦下。**不做常量折叠**——`"a" + "b"` 与
 * 无插值的模板串一律算动态:折叠是另一个成本层级,而静态那一侧误伤一份本来能跑的脚本,
 * 在五轮预算里是不对称地致命的(spec《承载的重新划分》)。
 * 这条裁决同时写进了动态 `eval` 的诊断文本里:模型若打算改用静态 `eval` 绕过去,
 * 它在编译期就会读到为什么不受理。
 *
 * ── 边界:判不到的两处(有记录的缺口,不是遗漏) ───────────────────────────────
 * ① **中转与间接调用**:本规则判的是**被调用者**,不是标识符。所以 `const f = eval; f(s)` 与
 *    `(0, eval)(s)` 都看不见——判到标识符层就必须查作用域才能不误伤同名局部变量,而
 *    `oxc-parser` 0.152 不暴露任何作用域(spec《承载的重新划分》)。
 *    这一处的承载方是**编译器的名字解析**:`eval` / `require` 都不在内置全局白名单里,
 *    而白名单反转由 `tsc` 执行(归 E 的编译步骤)。两处判据同向,不冲突。
 * ② **静态 `eval` 的字符串内容**:那需要把字面量当源码再解析一遍(再开一条规则的成本与一处
 *    误报面),本规则不扫。写进来的模块语法要到运行期才成形,而载入期已经没有这一步了。
 * 另有一处**刻意不拦**:`new Function(...)`。它与 `eval` 同级,但它**不是模块语法**——
 * 本规则的判据是「这段代码是不是从自己之外取来的」,而 `new Function` 取得的是构造点的闭包,
 * 两者不同类。契约没点名它只是旁证,不是理由(`import x = require(...)` 契约同样没点名,
 * 仍然拦,见下面 `MODULE_FORMS` 的说明——**分界线是判据本身,不是契约的措辞**)。
 * 它的名字由编译器那一层拒:`Function` 明确不在内置全局白名单里(spec《全局白名单反转》
 * 把它与 `eval` / `AsyncFunction` 并列写在「明确不收」那栏,理由是求值器与构造器把构造点的
 * 闭包变成输入),白名单反转由 `tsc` 执行,于是 `new Function` 在编译那一步就拿不到这个名字。
 *
 * ── 为什么它在判定链的第三级 ─────────────────────────────────────────────────
 * 顺序是裁决不是实现细节(spec《规则清单与判定链》):语法失败 → 禁列 → 桥前缀 → **模块系统** → 体积。
 * 本规则与前两级互不相遮:禁列判名字能否解析到全局,模块语法里的名字根本不解析到任何全局,
 * 所以谁先判都不改变结论;顺序按裁决插位即可,见 `validate/pipeline.ts`。
 */

import { identifierName, startOf, walk, type AstNode } from "../ast.ts";
import { parseToAst, positionAt } from "../parse-source.ts";
import { isGlobalThisNode, memberNameOf, withoutParentheses } from "./identifier-chain.ts";
import type { ScriptLintContext, ScriptLintStage, ScriptViolation } from "./script-lint.ts";

/** 收集阶段先记偏移,最后统一换算行列——避免每个节点都重算一次行号(与 `rules/no-float.ts` 同做法)。 */
type PendingViolation = {
  readonly start: number;
  readonly message: string;
};

/** `import` / `export` 声明那一族:同一个道理,差别只在形态名,所以共用一句。 */
function declarationMessage(form: string): string {
  return (
    `${form}:参赛脚本是单文件自包含的 script-mode 模块,带它的产物在沙箱载入期就取 ` +
    `SyntaxError,连执行都进不去;请把需要的东西直接写在这个文件里,` +
    `顶层入口直接写 \`function loop() { … }\`,不需要导出。`
  );
}

function importCallMessage(): string {
  return (
    "动态 `import()`:它在运行期才去取另一段代码,而沙箱载入时没有配置模块加载器," +
    "这一句必然失败;请把那段代码直接写进这个文件。"
  );
}

function requireMessage(): string {
  return (
    "`require()`:它向这个文件之外索取代码,单文件自包含的脚本里没有可取的对象;" +
    "请把需要的逻辑直接写进来。"
  );
}

function evalMessage(): string {
  return (
    "动态 `eval()`:被求值的代码在运行期才确定,静态校验拿它没有办法," +
    "而它能做的事与 `import()` 同级;请把那段代码直接写出来。" +
    '(`eval("一段字面量")` 那种静态形式不拦:那段代码编译期就写定了,等价于直接写出来。)'
  );
}

/**
 * 模块声明/表达式节点 → 面向模型的一句话。键是 ESTree/oxc 的节点类型,值里**点名那个形态**
 * (「诊断里点名形态」是这张票的验收项之一),所以这张表同时是判据与文案的一处收敛点:
 * 遍历侧不认识任何一条具体规则,规则侧也只有这一处写模块文案。
 *
 * TS 特有的两种(`import x = require(...)` / `export = x`)一并收在这里:源形态是**编译产物**
 * (spec《规则跑在编译产物上》),它们通常在编译期就化了形,但产物里若仍出现(例如编译目标
 * 是 CommonJS),它**仍然是模块语法**,仍在本规则的判据之内——不因为 hld §6.2 那一行没逐字
 * 写出它就变成判据之外的东西。契约措辞决定不了判据的边界,判据自己决定;契约漏写一个形态
 * 是一条待修的文档缺口,不是一条可以顺手放过的口子。
 */
const MODULE_FORMS: Readonly<Record<string, string>> = {
  ImportDeclaration: declarationMessage("`import` 声明"),
  ImportExpression: importCallMessage(),
  ExportNamedDeclaration: declarationMessage("`export` 声明"),
  ExportDefaultDeclaration: declarationMessage("`export default` 声明"),
  ExportAllDeclaration: declarationMessage("`export *` 声明"),
  TSImportEqualsDeclaration: declarationMessage("TS 的 `import x = require(...)` 声明"),
  TSExportAssignment: declarationMessage("TS 的 `export = ...` 赋值"),
};

/**
 * 被调用者是哪个名字。取不到就返回 undefined——本规则**不猜**。
 *
 * 取得到的三种写法:裸标识符(`eval(s)`)、带括号的同一写法(`(eval)(s)`——括号在 JS 里是纯分组,
 * 剥掉它就是上面那一种,判据与遍历层共用同一句,理由见 `identifier-chain.ts` 的头注)、
 * `globalThis` 的等价写法(`globalThis.eval(s)`,以及成员名走字符串下标的同一写法
 * `globalThis["eval"](s)`——**同一种成员名取法**,所以判据取自那份公共件的 `memberNameOf`
 * 而不在这里再写一遍「只认非计算」那一支;否则本包会对 `Math["random"]()` 认、对
 * `globalThis["eval"](s)` 不认,而两份代码对同一种写法给出相反结论时没有任何东西会变红)。
 * `a.eval(s)` 与 `a["eval"](s)` 都取不到:那是一次对象上的方法调用,不是全局 `eval`。
 * `globalThis` 那一支与 `forbidden-globals.ts` 的处理同一条纪律(它是全局对象本身,不是某个对象的
 * 属性),判据取自那份公共件而不是在这里再写一遍字面量。
 */
const calleeNameOf = (
  node: AstNode,
): { readonly name: string; readonly start: number } | undefined => {
  const callee = withoutParentheses(node.callee);
  if (callee === undefined) {
    return undefined;
  }
  const direct = identifierName(callee);
  if (direct !== undefined) {
    return { name: direct, start: startOf(callee) };
  }
  if (callee.type === "MemberExpression") {
    const member = memberNameOf(callee);
    return member !== undefined && isGlobalThisNode(callee.object)
      ? { name: member, start: startOf(callee) }
      : undefined;
  }
  return undefined;
};

/**
 * 动态 eval 的判据:剥掉括号后的第一个实参是字符串字面量就算静态(不拦),其余一律动态(拦)。
 *
 * 括号在 JS 里是纯分组,剥掉它**不改变实参是什么**,所以 `eval((s))` 仍然算动态、
 * `eval(("1+1"))` 与 `eval("1+1")` 属同一类;而**不做常量折叠**仍然成立:
 * `eval(("1" + "1"))` 的内层不是字面量,照拦(理由见头注的裁决段)。
 */
const isStaticEvalArgument = (node: AstNode): boolean => {
  const [first] = Array.isArray(node.arguments) ? node.arguments : [];
  const argument = withoutParentheses(first);
  return (
    argument !== undefined && argument.type === "Literal" && typeof argument.value === "string"
  );
};

/** 遍历一棵已解析成功的树,收出本级的违规。规则层与判定链两个入口共用这一份扫描。 */
const scanParsed = (program: unknown, source: string): readonly ScriptViolation[] => {
  const found: PendingViolation[] = [];
  walk(program, (node) => {
    const message = MODULE_FORMS[node.type];
    if (message !== undefined) {
      found.push({ start: startOf(node), message });
      return;
    }
    if (node.type !== "CallExpression") {
      return;
    }
    const callee = calleeNameOf(node);
    if (callee === undefined) {
      return;
    }
    if (callee.name === "require") {
      found.push({ start: callee.start, message: requireMessage() });
      return;
    }
    if (callee.name === "eval" && !isStaticEvalArgument(node)) {
      found.push({ start: callee.start, message: evalMessage() });
    }
  });

  return found.map(({ start, message }) => {
    const { line, column } = positionAt(source, start);
    return { rule: "module-system", message, line, column, blocking: true } as const;
  });
};

/**
 * 判定链上的第三级。上下文里已经带着解析结果,所以这里**不重复解析**——判定链把
 * 「解析失败独占」这件事挡在前面(见 `validate/pipeline.ts`),上下文里没有可用解析结果时
 * 本级返回空数组:那条路径的结论属于解析层,不由规则层重复产出。
 */
export const moduleSystemStage: ScriptLintStage = (context: ScriptLintContext) => {
  const { parsed } = context;
  return parsed === undefined || !parsed.ok ? [] : scanParsed(parsed.program, context.source);
};

/**
 * 规则层的对外缝:一段源码 → 一组带行列的违规(形状与 `forbiddenGlobalViolations` 同形)。
 * 判据与上面那条完全同一份扫描,所以两个入口永远给出一致的结论;共同纪律见 `script-lint.ts`。
 */
export const moduleSystemViolations = (source: string): readonly ScriptViolation[] => {
  const parsed = parseToAst(source, "script");
  return parsed.ok ? scanParsed(parsed.program, source) : [];
};
