/**
 * 生成物注册表:整件事的骨架。**新增生成物是往 `GENERATED_ARTIFACTS` 里加一行**,
 * 不是改这个文件之外的任何东西——漂移检查(挂在全量门禁末尾的那道)按这张表逐件检查,
 * E 接入文档生成(规则文档的数值表、API 表)时同样只需注册,骨架不动。
 *
 * 「加一行」这条纪律不是口号,本文件在两件生成物之后仍然是这三十来行:第二件
 * (参赛脚本可见面的三张名单)只新增了一份生产函数与下面这一行,骨架一行没改。
 *
 * 本表**不为「第几件」预留分支**:逐件遍历覆盖任意件,而预留出来的开关在真需要之前
 * 只会变成没人走过的死代码(第二件真到时,遍历那一行没动)。
 *
 * ── 混合传输:分界线是「能不能 afford 构建」 ──
 *
 * - **生成器 import 真源包**:`generate/builtin-globals.ts` 就是这么拿到白名单的。生成器是
 *   **低频入口**(跑一次、产物入库),前置一次 `tsc -b` 无所谓,根脚本 `generate` 自己带。
 *   为此工具包正式声明真源包为依赖并加了 project reference(hld §3.2:工具包只允许 import
 *   真源包这一个根包)——这条边指向依赖图的根,方向合法。反方向不合法:真源包是无运行时代码的
 *   根包,谁都不依赖它。相对路径 import 真源包已被排除:工具包 tsconfig 的 `rootDir` 写死,
 *   引进来会 TS6059 越界(ADR-0002 已实测记录)。
 *
 * - **规则层读生成出来的源文件**:`rules/no-float.ts` → `allowlist.ts` / `script-surface.ts`
 *   → `src/generated/`。
 *   工具包以源码形态由 Node 的类型擦除执行、不产 JS,而快门禁今天是**零构建**。
 *   让规则层 import 真源包等于给 `check:quick` 挂上一个 `tsc -b` 前置(实测 +31%),
 *   更关键的是让新克隆在第一次跑门禁时可能失败——而门禁的第一印象必须是「clone 完直接能跑」。
 *
 * 换句话说:同一条依赖边,在一侧是「每次提交都跑」,在另一侧是「偶尔跑一次」,
 * 所以它只在能 afford 构建的那一侧成立。
 */

import { apiOutcomeTable, apiSurfaceTables } from "./api-surface.ts";
import { builtinGlobalsAllowlist } from "./builtin-globals.ts";
import type { GeneratedArtifact } from "./artifact.ts";
import { apiValueTable, rulesValueTable } from "./rules-value-table.ts";
import { scriptSurfaceNames } from "./script-surface.ts";

/**
 * 注册表。**新增生成物是往这个数组里加一行**,外加一份生产函数——骨架(本文件 + `artifact.ts`
 * + `run-generate.ts`)不用动。表里已有三件分属三个域:内置全局白名单(禁浮点规则那一半)、
 * 参赛脚本可见面的三张名单(静态校验器那一半)、规则文档的数值表(面向模型的那份契约)。
 * 漂移检查逐件覆盖,报告按 `id` 指认。
 *
 * 第三、四行是同一份内容的两处落点(机制文档与 API 文档各挂一份),不是一个键名的两个版本:
 * 内容由一个生产函数产出,两处逐字节相同,改真源时两处一起变。
 *
 * 最后两行挂在 API 文档的不同小节、读两个不同的真源(注入面符号表 / 后果行),分成两件而不是
 * 合成一整块:漂移的报告要能指认是哪一句判据下的那一段漂了,合成一块就分不出来了。
 */
export const GENERATED_ARTIFACTS: readonly GeneratedArtifact[] = [
  builtinGlobalsAllowlist,
  scriptSurfaceNames,
  rulesValueTable,
  apiValueTable,
  apiSurfaceTables,
  apiOutcomeTable,
];
