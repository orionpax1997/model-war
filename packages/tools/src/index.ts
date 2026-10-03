/**
 * tools 包:仓库自用的静态校验器。
 *
 * 形态与别处不同:本包**不产出运行时代码**,由 Node 的类型擦除直接以源码执行
 * (`node packages/tools/src/gate/run-no-float-gate.ts`,Node ≥ 22.18 默认开启 type stripping)。
 * 代价是全仓库语法必须可擦除——禁 `enum`、`namespace`、参数属性,由基座的 `erasableSyntaxOnly` 兜住。
 *
 * 分层:
 * - `ast.ts` 遍历层的最小公共件(`walk` / 节点形状 / 取名字),规则层共用一份;
 * - `parse-source.ts` 解析层(oxc-parser 之上的一层薄壳);
 * - `rules/` 纯规则层:源码进、带行列的违规出,不碰文件系统。它也是参赛脚本静态校验的
 *   **词汇表之家**(`rules/script-lint.ts`:违规形状、全序比较、一级判定的形状与上下文);
 * - `gate/` 目录薄壳与入口:只做读文件与退出码,规则一概不重复实现;
 * - `validate/` 参赛脚本静态校验器的判定链与入口:形状与 `gate/` 同为「读输入 → 规则 → 退出码」,
 *   但它**不是仓库门禁**(不进 `check`,它服务于生成管线而不是服务于本仓库的提交),所以另起一份;
 *   包内的箭头只有 **`validate/` → `rules/`** 一条,不反向——理由与「为什么不是反过来」见
 *   `rules/script-lint.ts` 的头注;
 * - `allowlist.ts` / `script-surface.ts` 名单的**读取点**;名单真源在 `@model-war/schema`,
 *   经 `generate/` 产出后落在 `generated/` 下,本包内零手写副本
 *   (见这两个文件的头注与 ADR-0003);
 * - `generate/` 生成器(注册表 + 入口 + 排版零件 + 各件的生产函数):本包唯一需要构建前置的一侧。
 *   它不联网——生成器放这里而不放生成管线包,理由是**依赖面**随后者扩张(hld §2.2.6),不是联网。
 *
 * ── 本包**有意**在 dependency-cruiser 的巡航范围之外 ──
 * 不是疏漏,是取舍:depcruise 巡航 `dist`,而本包 `emitDeclarationOnly`、`dist` 里没有 `.js`;
 * 本仓库的 TypeScript 7 没有 JS 编程 API,depcruise 巡航 `src` 只会得到「0 modules」+ exit 0 的假绿。
 * 让本包产 JS 就要让快门禁付一次构建,而快门禁必须零构建(ADR-0003)。
 * 代价里能被补的那一半已经补上:`gate/run-declared-deps-gate.ts`(根脚本 `check:declared-deps`)
 * 兜住**第三方依赖面**,「声明即依赖」在本包里从此有机器保证。另一半(包图方向)仍由 tsc 的 TS2307
 * 兜,「声明了但方向反了」仍靠规范。完整的缺口分析与实测记在 `.dependency-cruiser.js` 的头注里。
 *
 * 消费者有两个(仓库自身的确定性门禁、将来的参赛脚本校验),两者对本包的用法不同:
 * 仓库源码是 ESM module,参赛脚本是单文件 script-mode TS(hld §2.2.2 的入口契约)——
 * 所以每个入口都接受 `SourceKind`,不替调用方猜。
 */

export type { ParseOutcome, ParsedSource, SourceDiagnostic, SourceKind } from "./parse-source.ts";
export { parseSource, parseToAst } from "./parse-source.ts";

export type { AstNode } from "./ast.ts";
export { walk } from "./ast.ts";

export type { NoFloatRule, NoFloatViolation } from "./rules/no-float.ts";
export { noFloatViolations } from "./rules/no-float.ts";

export type { DeclaredDepsRule, DeclaredDepsViolation } from "./rules/declared-deps.ts";
export { packageNameOf, undeclaredDependencyViolations } from "./rules/declared-deps.ts";

export { ALLOWED_MATH_MEMBERS, BUILTIN_GLOBAL_NAMES, isAllowedMathMember } from "./allowlist.ts";

// 参赛脚本可见面的名表读取点:宿主桥前缀 / 禁列全局名 / 沙箱注入 API 符号表。
// 这里只有读取形态的封装,没有任何规则——禁 export/import、禁 `__*`、禁列、脚本体积上限
// 全属 D(体积上限是数值,取值在规则集文件里,不在名单内)。
export {
  FORBIDDEN_GLOBAL_NAMES,
  HOST_BRIDGE_PREFIX,
  SANDBOX_INJECTED_API_SYMBOLS,
  isForbiddenGlobalName,
  isHostBridgeSymbol,
  isSandboxInjectedSymbol,
} from "./script-surface.ts";

// ── 参赛脚本静态校验器(D)─────────────────────────────────────────────
// 判定链与违规形状是对外的那一半:生成管线可以 spawn 入口(退出码 + stdout),
// 也可以直接把这段当库用(结构化违规数组)。规则本身是纯函数,入口那一层薄壳不重复实现它。
export type {
  ScriptLintContext,
  ScriptLintPhase,
  ScriptLintRule,
  ScriptLintStage,
  ScriptViolation,
} from "./rules/script-lint.ts";
export { compareViolations } from "./rules/script-lint.ts";
export { forbiddenGlobalStage, forbiddenGlobalViolations } from "./rules/forbidden-globals.ts";
export { moduleSystemStage, moduleSystemViolations } from "./rules/module-system.ts";
// 体积上限是入参(`maxBytes`)、时机由 `phase` 分两级,所以这里导出的是「字节数 → 违规」的缝。
export type { ScriptSizeOptions } from "./rules/script-size.ts";
export { scriptSizeStage, scriptSizeViolations } from "./rules/script-size.ts";
export type { ValidateScriptOptions } from "./validate/pipeline.ts";
export { SCRIPT_LINT_STAGES, validateScriptSource } from "./validate/pipeline.ts";
export { renderViolations } from "./validate/render-violations.ts";
