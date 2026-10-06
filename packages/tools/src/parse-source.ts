/**
 * 解析层:oxc-parser 0.152.0 之上的一层薄壳。只做两件事——把源码变成 AST,把 oxc 的诊断
 * 变成带行列的 `SourceDiagnostic`。规则层(`rules/no-float.ts`)建在它之上,不另起一个解析器。
 *
 * **为什么是 oxc-parser 而不是 oxlint 的 JS 插件**:hld §2.2.3 最初把 `no-float-literal`
 * 写成 oxlint 的 JS 插件,而 oxlint 自己的配置 schema 给该字段的说明是「JS plugins are in
 * alpha and not subject to semver」。禁浮点是一票否决级的约束(hld §1 确定性可复算、NFR-1),
 * 不能挂在一条上游声明「不遵循 semver」的扩展通道上——升一次 oxlint 就可能整条门禁消失。
 * oxc-parser 是同一家上游的稳定 API,本包选它作为替代。
 *
 * ── 源形态是**这里**的事,收口也在这里 ─────────────────────────────────────────
 * 两种源形态由 `SourceKind` 命名,由本文件这一处解释,别处不许自己挑解析配置:
 * `module` = 仓库自身源码(TS),`script` = 参赛脚本的**编译产物**(JS)。
 *
 * 收紧的落点选在这里而不是校验入口(实测与理由见 `docs/hld.md` §6.2):规则层的
 * `forbidden-globals` / `host-bridge` / `module-system` 三条各自独立调 `parseToAst(source, "script")`,
 * 入口声明源形态的话要在四处各传一次,任何一处漏传就静默回到「判据更宽」——而更宽正是本层
 * 要消除的方向。改这一处,四个调用点一起受益且绕不开。
 *
 * **收紧不等于模块系统那一级可以删**(实测,2026-10-04,oxc-parser 0.152.0):
 * `lang: "js"` 只让解析层不再接受 **TS 注解**,对模块语法毫无作用——`export const` / `import x` /
 * `import("x")` / `require("x")` 四种在 `sourceType: "script"` 下**照样解析成立**
 * (静态 `import` / `export` 另置 `module.hasModuleSyntax`,动态 `import()` / `require()` 不置——但规则层
 * 读的是 AST 节点不是那个标志),所以「载入期会取 SyntaxError」这条事实仍然挡不住。
 * 同形态下 `import.meta` 才由 oxc 直接判解析失败(那一类归判定链独占的 `syntax-error`)。
 * 详见 `rules/module-system.ts` 头注里同一份实测。
 */

import { parseSync, type Program } from "oxc-parser";

/**
 * 源码种类:`module` = 仓库自身源码(TS);`script` = 参赛脚本的**编译产物**(JS,单文件、无模块语法)。
 *
 * 两者不是「宽松 / 严格」两档,而是**两种源形态**:解析配置逐项不同(`lang`、`filename`),
 * 所以这一项由本文件这一处解释,别处不许自己挑解析配置。
 */
export type SourceKind = "module" | "script";

/** 一条诊断。行列为 1 起。 */
export type SourceDiagnostic = {
  message: string;
  line: number;
  column: number;
};

/** 解析成立时,`program` 是 ESTree 形状的 AST;解析不成立时,`errors` 至少有一条。 */
export type ParsedSource =
  | { readonly ok: true; readonly program: Program }
  | { readonly ok: false; readonly errors: readonly SourceDiagnostic[] };

export type ParseOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly SourceDiagnostic[] };

/**
 * 只要「这段源码解析得过吗」的答案。语法错误是**确定性的拒绝**而非静默通过。
 * 纯函数,不碰文件系统——目录遍历是它上面的一层薄壳。
 */
export const parseSource = (source: string, kind: SourceKind = "module"): ParseOutcome => {
  const parsed = parseToAst(source, kind);
  return parsed.ok ? { ok: true } : parsed;
};

/**
 * 解析并把 AST 一并交出来。规则层要的是节点本身(字面量的 `raw`、`MemberExpression` 的
 * object/property),只有 ok/errors 的那层包装对规则没有用。
 *
 * script 形态走 `lang: "js"` 与 `.js` 文件名:校验器唯一的源形态是**编译产物**,一份还带着
 * 类型标注的 TS 源码此刻根本无法判定(未编译不是「判据更宽」,是「这份东西不该由本工具判」),
 * 它落进 `syntax-error` 那一支而不是被几条规则放过。
 *
 * 文件名那半是**自述**不是行为开关:实测(2026-10-04,oxc-parser 0.152.0)文件名给 `.ts` 或 `.js`
 * 配 `lang: "js"` 时逐条行为相同——oxc 只在**缺** `lang` 时才看扩展名。两处一起改是为了让
 * 传给解析器的名字不再与实际形态说反话;真要只改 `lang` 就把 `script.ts` 留着,下一个人读到
 * 会以为 script 形态确实是 TS。
 */
export const parseToAst = (source: string, kind: SourceKind = "module"): ParsedSource => {
  const parsed = parseSync(kind === "script" ? "script.js" : "source.ts", source, {
    lang: kind === "script" ? "js" : "ts",
    sourceType: kind,
  });
  if (parsed.errors.length === 0) {
    return { ok: true, program: parsed.program };
  }
  return {
    ok: false,
    errors: parsed.errors.map((error) => {
      const offset = error.labels[0]?.start ?? 0;
      const { line, column } = positionAt(source, offset);
      return { message: error.message, line, column };
    }),
  };
};

/**
 * 字符偏移 → 1 起的行列。
 *
 * oxc-parser 0.152.0 的 `start`/`end` 是**字符偏移**(JS 字符串下标,UTF-16 code unit),
 * 不是 UTF-8 字节偏移——实测 `const 名 = "中"; let b = ;` 的错误偏移为 23,等于该行前缀
 * `const 名 = "中"; let b = ` 的 UTF-16 长度,而它的 UTF-8 字节长度是 27。
 * 这一点由两个「非 ASCII 与出错处同行」的用例钉住(`parse-source.test.ts` 与
 * `rules/no-float.test.ts` 各一条):字节口径下它们的列号会各差 5 与 8,改坏了会红。
 * 反过来,只断言行号、或让出错处另起一行的用例钉不住——那两种口径下结果完全一样。
 */
export const positionAt = (source: string, offset: number): { line: number; column: number } => {
  const head = source.slice(0, Math.max(0, Math.min(offset, source.length)));
  const lines = head.split("\n");
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
};
