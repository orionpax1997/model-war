/**
 * gen 包:脚本生成管线(hld §2.1 离线侧、§2.2.6)。
 * 唯一允许联网的包,**永不进对局进程**(NFR-4 AC2);禁 import 任何 result 类型(FR-5 AC1)。
 * 依赖方向单向:gen → schema。
 * 空壳阶段只落 prompt 组装的第一步:钉住规则集版本并把两份规则文档接起来。
 * prompt 模板本身是 `prompts/` 下的数据文件(改提示词不必改代码,hld §2.2.6),其渲染随管线落地。
 */

import { RULESET_VERSION, type RulesetVersion } from "@model-war/schema";

/** 面向模型的两份文档(hld §6.1):`docs/rules-vN/` 下的 rules.md 与 api.md。 */
export type RuleDocs = {
  rules: string;
  api: string;
};

export type GenerationPrompt = {
  /** 本次生成钉住的规则集版本,随 meta.json 入档(hld §7.4) */
  ruleset: RulesetVersion;
  text: string;
};

/** 把两份规则文档组装成一次生成请求的输入,并钉住规则集版本。 */
export const assemblePrompt = (docs: RuleDocs): GenerationPrompt => ({
  ruleset: RULESET_VERSION,
  text: [docs.rules, docs.api].join("\n\n"),
});
