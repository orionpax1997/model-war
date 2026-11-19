/**
 * 首条消息与 system 的渲染(ADR-0030「首条消息只给目录」、ADR-0037「契约包的身份」)。
 *
 * ── 两份模板,两种待遇 ──
 *
 * - `prompts/agent.md` = 首条 `user` 消息:**带两个占位符**。`{{contractIndex}}` 全量内联目录说明
 *   (`docs/rules-<版本>/README.md`),`{{contractDigest}}` 落在末行,给出契约包的身份。
 * - `prompts/agent-system.md` = `system` 消息:**原样**用,没有占位符、也没有任何加工。
 *
 * 分界的理由在 ADR-0032:`system` 说协议(每一步一个动作块),首条 `user` 说这次会话的任务与硬约束。
 * 混成一体的代价是两者只能一起改。
 *
 * ── 为什么内联的是整整一份 README,不是它的某一节 ──
 *
 * 只内联一节会引入一条「内联的这段 == 文件的那一节」的同源判据,那是不划算的:目录说明只有二十来行,
 * 全量内联让「重复但不一致」在物理上不可能(ADR-0030 的原话)。而**契约正文不进首条消息**——
 * 读契约要花几步,这是设计的一部分:把「先读什么」变成模型的策略决策。
 *
 * ── 末行的形状是 ADR-0037 写死的那一句 ──
 *
 * `contract: <版本号> tree=sha256:<hex>`。两个前缀回答两个不同的问题:版本号「哪一套取值」(它只锚
 * 规则集取值,ADR-0008),整树哈希「哪一份字节」。所以版本号取自 `RULESET_VERSION`(真源包常量,
 * 不新造第二个真源),哈希取自 `CONTRACT_TREE_HASH`(入库常量,由 `check:contract` 证明现算一致)。
 *
 * ── 渲染是纯函数,读盘另有其人 ──
 *
 * 照 `prompt.ts` 的形状:纯映射可被单测直接钉住(占位符、身份行、正文缺席),读盘由 `load*` / `read*`
 * 负责。**渲染器不读盘、不碰 `CONTRACT_TREE_HASH` 之外的常量**——身份是入参,注入缝就是单测缝。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONTRACT_TREE_HASH, RULESET_VERSION, type RulesetVersion } from "@model-war/schema";

import { ruleDocsDir } from "./contract.js";

/**
 * 首条消息的模板(仓库相对 `prompts/`)。
 *
 * 路径字面量(`prompts/agent.md`)在仓库里共三份:本文件的 `AGENT_TEMPLATE_NAME`、
 * 门禁包的 `AGENT_TEMPLATE_PATH`、`gates.test.ts` 的探针路径。**这是被迫重复**:零构建的门禁
 * 不得 import `@model-war/gen`(hld §2.2.8、ADR-0003),而本文件住在那里。它靠「读不到即抛」
 * 兜底:任一处写错就是读一个不存在的文件,当场红,不会静默放过。
 */
export const AGENT_TEMPLATE_NAME = "agent.md";

/** `system` 消息的模板(仓库相对 `prompts/`)。原样使用,不渲染。 */
export const AGENT_SYSTEM_TEMPLATE_NAME = "agent-system.md";

/** 目录说明的文件名。它与 `rules.md` / `api.md` 同住契约目录。 */
export const CONTRACT_INDEX_NAME = "README.md";

const PLACEHOLDER_INDEX = "{{contractIndex}}";
const PLACEHOLDER_DIGEST = "{{contractDigest}}";

/**
 * 契约包的身份,两半各回答一个问题。
 *
 * 类型上不做 branded 之类:它是个注入参数,单测要能随手造一个反例(`version: "v1"`);
 * 形状由 `contractIdentityTrailer` 一处承担。
 */
export type ContractIdentity = {
  /** 规则集版本(`RULESET_VERSION`):「哪一套取值」。 */
  readonly version: RulesetVersion;
  /** 整树 sha256(`CONTRACT_TREE_HASH`):「哪一份字节」。 */
  readonly treeHash: string;
};

/** 首条消息与 system 的成品,尚未分工到 message 角色。 */
export type AgentPrompt = {
  readonly user: string;
  readonly system: string;
};

/** 默认身份:两个半边都取真源包常量(版本 = 规则集版本,哈希 = 入库 pin)。 */
export const DEFAULT_CONTRACT_IDENTITY: ContractIdentity = {
  version: RULESET_VERSION,
  treeHash: CONTRACT_TREE_HASH,
};

const readText = (path: string, what: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`读不到 ${what} ${path}:${reason}`);
  }
};

/** 读 `<root>/prompts/agent.md`。读不到即抛错(提示词是管线的输入,缺了不能静默降级)。 */
export const loadAgentTemplate = (root: string): string =>
  readText(join(root, "prompts", AGENT_TEMPLATE_NAME), "首条消息模板");

/** 读 `<root>/prompts/agent-system.md`。读不到即抛错,同上。 */
export const loadAgentSystemTemplate = (root: string): string =>
  readText(join(root, "prompts", AGENT_SYSTEM_TEMPLATE_NAME), "system 模板");

/**
 * 读 `<root>/docs/rules-<版本>/README.md`——首条消息要全量内联的那一份。
 *
 * 它与契约正文同住一个目录(清单与非空判据归 `check:contract`),所以这里只拼路径、只读字节。
 */
export const readContractIndex = (root: string): string =>
  readText(join(ruleDocsDir(root), CONTRACT_INDEX_NAME), "契约目录说明");

/**
 * 身份行:ADR-0037 写死的 `contract: <版本号> tree=sha256:<hex>` 的后半段。
 *
 * 模板里写的是 `contract: {{contractDigest}}`,所以这里出去的是「版本号 + 整树哈希」两段,
 * 而 `contract:` 这个前缀留在模板里(它是固定文本,不该由两处各写一遍)。
 */
export const contractIdentityTrailer = (identity: ContractIdentity): string =>
  `${identity.version} tree=sha256:${identity.treeHash}`;

/**
 * 渲染首条消息。
 *
 * 纯函数——不读盘、不碰环境。两处抛错都是「这条消息不再是它该是的那个样子」:
 * - 目录说明是空的:首条消息的全部内容就是它(ADR-0030),空的那条等于什么都没说;
 * - 模板缺任一占位符:说明模板被改过而渲染器没跟上,渲染出的消息会悄悄少掉目录或身份。
 *
 * 替换顺序:先身份、后目录说明。反过来则目录说明正文里若出现 `{{contractDigest}}` 字样也会被替换,
 * 而「全量内联」的意思是**逐字**那一份。
 */
export const renderAgentTemplate = (
  template: string,
  index: string,
  identity: ContractIdentity = DEFAULT_CONTRACT_IDENTITY,
): string => {
  if (index.trim() === "") {
    throw new Error("契约目录说明是空的:首条消息的全部内容就是它,空的那条等于什么都没说");
  }
  for (const placeholder of [PLACEHOLDER_INDEX, PLACEHOLDER_DIGEST]) {
    if (!template.includes(placeholder)) {
      throw new Error(`首条消息模板缺占位符 ${placeholder}:渲染出的消息会悄悄少掉一段内容`);
    }
  }
  return template
    .replaceAll(PLACEHOLDER_DIGEST, contractIdentityTrailer(identity))
    .replaceAll(PLACEHOLDER_INDEX, index);
};

/**
 * 组装首条消息与 system:模板与目录说明读盘,身份缺省取真源包常量。
 *
 * 返回的是两段**文本**而不是 `ChatMessage[]`:角色分工是传输层(与 ADR-0032 的 system / user 分界)
 * 的事,本函数只负责「那两段字节长什么样」。接线(把这两段塞进 loop 的第一轮)归 A1。
 */
export const loadAgentPrompt = (
  root: string,
  identity: ContractIdentity = DEFAULT_CONTRACT_IDENTITY,
): AgentPrompt => ({
  user: renderAgentTemplate(loadAgentTemplate(root), readContractIndex(root), identity),
  system: loadAgentSystemTemplate(root),
});
