/**
 * prompt 模板的读取与渲染(hld §2.2.6 的「prompt 模板」行)。
 *
 * ── 为什么模板是数据文件、渲染是纯函数 ──
 *
 * 改提示词只改 `prompts/base.md`,不改 gen 代码;渲染是「模板 + 契约文档 + 可选策略」到一段
 * 文本的纯映射,可被单测直接钉住(变量注入、缺省策略、指针清单)。
 *
 * ── 两个占位符的语义 ──
 *
 * - `{{contract}}` = `rules.md` 与 `api.md` 的全文,以空行拼接(照抄 spec:`rules + "\n\n" + api`)。
 * - `{{strategy}}` = **可选**。给了就替换;没给就把**含该占位符的整行**去掉,不留下空占位、
 *   也不留 `{{strategy}}` 字面量。模板把策略取向写成它自己的一行,正是为了让"整行去掉"恰好
 *   等于"整段去掉"。
 *
 * 渲染顺序:先处理策略(在**模板**上做,行级正则),再注入契约(契约正文可能含任意换行,
 * 不能被行级正则波及)。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuleDocs } from "./contract.js";

/** 读 `<root>/prompts/base.md`。读不到即抛错(提示词是管线的输入,缺了不能静默降级)。 */
export const loadBaseTemplate = (root: string): string => {
  const path = join(root, "prompts", "base.md");
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`读不到 prompt 模板 ${path}:${reason}`);
  }
};

/** 去掉含 `{{strategy}}` 的整行,并把因此产生的连续空行收紧回段落间的单空行。 */
const dropStrategyLine = (template: string): string =>
  template.replace(/^.*\{\{strategy\}\}.*(?:\n|$)/gm, "").replace(/\n{3,}/g, "\n\n");

/**
 * 渲染模板:`{{contract}}` 注入两份契约文档,`{{strategy}}` 在缺省时整行去掉。
 *
 * 纯函数——不读盘、不碰环境;读盘由 `loadBaseTemplate` / `readRuleDocs` 负责。
 */
export const renderBaseTemplate = (template: string, docs: RuleDocs, strategy?: string): string => {
  const withStrategy =
    strategy === undefined
      ? dropStrategyLine(template)
      : template.replaceAll("{{strategy}}", strategy);
  const contract = [docs.rules, docs.api].join("\n\n");
  return withStrategy.replaceAll("{{contract}}", contract);
};

/** 兼容名:与 `renderBaseTemplate` 同一实现(旧 `assemblePrompt(docs)` 形态已由模板数据文件取代)。 */
export const assemblePrompt = renderBaseTemplate;
