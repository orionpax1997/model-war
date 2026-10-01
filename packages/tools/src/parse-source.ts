/**
 * 解析层:oxc-parser 0.152.0 之上的一层薄壳。只做两件事——把源码变成 AST,把 oxc 的诊断
 * 变成带行列的 `SourceDiagnostic`。规则层(`rules/no-float.ts`)建在它之上,不另起一个解析器。
 *
 * **为什么是 oxc-parser 而不是 oxlint 的 JS 插件**:hld §2.2.3 最初把 `no-float-literal`
 * 写成 oxlint 的 JS 插件,而 oxlint 自己的配置 schema 给该字段的说明是「JS plugins are in
 * alpha and not subject to semver」。禁浮点是一票否决级的约束(hld §1 确定性可复算、NFR-1),
 * 不能挂在一条上游声明「不遵循 semver」的扩展通道上——升一次 oxlint 就可能整条门禁消失。
 * oxc-parser 是同一家上游的稳定 API,本包选它作为替代。
 */

import { parseSync, type Program } from "oxc-parser";

/** 源码种类:`module` = 仓库自身源码;`script` = 参赛脚本(单文件、无 import/export)。 */
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
 */
export const parseToAst = (source: string, kind: SourceKind = "module"): ParsedSource => {
  const parsed = parseSync(kind === "script" ? "script.ts" : "source.ts", source, {
    lang: "ts",
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
