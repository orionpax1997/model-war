/**
 * tools 包:仓库自用的静态校验器。
 *
 * 形态与别处不同:本包**不产出 dist**,由 Node 的类型擦除直接以源码执行
 * (`node packages/tools/src/index.ts`,Node ≥ 22.18 默认开启 type stripping)。
 * 代价是全仓库语法必须可擦除——禁 `enum`、`namespace`、参数属性,由基座的 `erasableSyntaxOnly` 兜住。
 *
 * 消费者有两个(仓库自身的确定性门禁、将来的参赛脚本校验),两者对本包的用法不同:
 * 仓库源码是 ESM module,参赛脚本是单文件 script-mode TS(hld §2.2.2 的入口契约)。
 * 规则本身(禁浮点、白名单符号表)随门禁 ticket 落地;本包当前只落解析这一层。
 */

import { parseSync } from "oxc-parser";

/** 源码种类:`module` = 仓库自身源码;`script` = 参赛脚本(单文件、无 import/export)。 */
export type SourceKind = "module" | "script";

/** 一条诊断。行列为 1 起。 */
export type SourceDiagnostic = {
  message: string;
  line: number;
  column: number;
};

export type ParseOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly SourceDiagnostic[] };

/**
 * 解析一段源码。语法错误是**确定性的拒绝**而非静默通过:返回带行列的错误列表。
 * 纯函数,不碰文件系统——目录遍历是它上面的一层薄壳。
 */
export const parseSource = (source: string, kind: SourceKind = "module"): ParseOutcome => {
  const parsed = parseSync(kind === "script" ? "script.ts" : "source.ts", source, {
    lang: "ts",
    sourceType: kind,
  });
  if (parsed.errors.length === 0) {
    return { ok: true };
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
 * 不是 UTF-8 字节偏移——实测:`const s = "中";\nconst n = 1.5;` 里字面量 `start` 为 25,
 * 与字符下标一致,而同一位置的字节偏移是 27。`parse-source.test.ts` 里的非 ASCII 用例
 * 把这条钉住,改坏了会红。
 */
const positionAt = (source: string, offset: number): { line: number; column: number } => {
  const head = source.slice(0, Math.max(0, Math.min(offset, source.length)));
  const lines = head.split("\n");
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
};
