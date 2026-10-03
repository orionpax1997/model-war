/**
 * tools 包:仓库自用的静态校验器。
 *
 * 形态与别处不同:本包**不产出运行时代码**,由 Node 的类型擦除直接以源码执行
 * (`node packages/tools/src/gate/run-no-float-gate.ts`,Node ≥ 22.18 默认开启 type stripping)。
 * 代价是全仓库语法必须可擦除——禁 `enum`、`namespace`、参数属性,由基座的 `erasableSyntaxOnly` 兜住。
 *
 * 分层:
 * - `parse-source.ts` 解析层(oxc-parser 之上的一层薄壳);
 * - `rules/` 纯规则层:源码进、带行列的违规出,不碰文件系统;
 * - `gate/` 目录薄壳与入口:只做读文件与退出码,规则一概不重复实现;
 * - `allowlist.ts` 允许名单的**读取点**;名单真源在 `@model-war/schema`,经 `generate/` 产出后
 *   落在 `generated/` 下,本包内零手写副本(见该文件头注与 ADR-0003);
 * - `generate/` 生成器(注册表 + 入口 + 各件的生产函数):本包唯一需要构建前置的一侧。
 *   它不联网——生成器放这里而不放生成管线包,理由是**依赖面**随后者扩张(hld §2.2.6),不是联网。
 *
 * 消费者有两个(仓库自身的确定性门禁、将来的参赛脚本校验),两者对本包的用法不同:
 * 仓库源码是 ESM module,参赛脚本是单文件 script-mode TS(hld §2.2.2 的入口契约)——
 * 所以每个入口都接受 `SourceKind`,不替调用方猜。
 */

export type { ParseOutcome, ParsedSource, SourceDiagnostic, SourceKind } from "./parse-source.ts";
export { parseSource, parseToAst } from "./parse-source.ts";

export type { NoFloatRule, NoFloatViolation } from "./rules/no-float.ts";
export { noFloatViolations } from "./rules/no-float.ts";

export { ALLOWED_MATH_MEMBERS, BUILTIN_GLOBAL_NAMES, isAllowedMathMember } from "./allowlist.ts";
