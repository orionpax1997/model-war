/**
 * 规则契约的读入(hld §2.2.6 的「契约读入」行)。
 *
 * ── 为什么不把契约内嵌进 gen 代码 ──
 *
 * 契约的真源是 `<root>/docs/rules-<RULESET_VERSION>/{rules.md,api.md}`。每次运行**从盘上读**,
 * 于是「改规则文档 → 下一次生成自动用上新契约」不必改代码、不必重建任何产物。
 * 内嵌副本会让"文档改了、生成还在用旧判据"这种漂移无声发生。
 *
 * ── 为什么目录名由 `RULESET_VERSION` 拼,而不是扫目录 ──
 *
 * 「目录名必须与版本常量一致」这条判据,用拼路径 + 存在性检查表达最直接:扫目录再挑一个
 * 会引入"挑哪个"的歧义,而版本三处一致(常量 / 目录名 / rulesets 文件名)是既定不变量
 * (hld §7.1)。拼不出来即报错退出,不静默降级。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RULESET_VERSION } from "@model-war/schema";

/** 面向模型的两份契约文档:`docs/rules-vN/` 下的 rules.md 与 api.md。 */
export type RuleDocs = {
  readonly rules: string;
  readonly api: string;
};

const readFile = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`读不到契约文档 ${path}:${reason}`);
  }
};

/**
 * 契约目录 `<root>/docs/rules-<RULESET_VERSION>` 的绝对路径。
 *
 * 目录名由版本常量拼出、不扫目录(理由见文件头注的「三处一致」)。它单独有名字,是因为目录里
 * 除了 `rules.md` / `api.md` 还有**目录说明**(`README.md`)——首条消息全量内联的是后者,它由
 * `agent-prompt.ts` 读,但也必须与两份文档同住一处,不得各拼一遍。
 */
export const ruleDocsDir = (root: string): string => join(root, "docs", `rules-${RULESET_VERSION}`);

/**
 * 从 `<root>/docs/rules-<RULESET_VERSION>/{rules.md,api.md}` 读盘。
 *
 * 目录不存在、或两份文档缺任一份 → 抛错(由 CLI 处理器转成非零退出),不内嵌副本。
 */
export const readRuleDocs = (root: string): RuleDocs => {
  const dir = ruleDocsDir(root);
  if (!existsSync(dir)) {
    throw new Error(
      `找不到规则契约目录 ${dir}(当前 RULESET_VERSION = ${RULESET_VERSION};目录名须与版本常量一致)`,
    );
  }
  return {
    rules: readFile(join(dir, "rules.md")),
    api: readFile(join(dir, "api.md")),
  };
};
