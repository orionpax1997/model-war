/**
 * 「宿主工具」一节 + `system` 里点的名 ⇄ 工具声明(纯函数层)的自测。
 *
 * ── 为什么先测假世界 ──
 *
 * 真世界的反例(往 `AGENT_TOOLS` 里加一个工具、看门禁红)在 `gates.test.ts` 里,它证明的是
 * 「接线对」;这里证明的是**判据本身**:两个方向、分界(`bash` 归二进制那一节)、
 * `system` 里那个反引号单词的三条路(是工具 / 登记过 / 都没有)。喂假源码与假模板能把这几种
 * 各打一次,而不必真改仓库。
 *
 * ── 断言的形状 ──
 *
 * 只断言「红/绿」与「点名了谁」。断言整句文案会让每次改措辞都动测试,而它守的是集合关系,
 * 不是措辞。
 */

import { expect, it } from "vitest";

import { BINARY_GROUP_HEADING, HOST_TOOL_GROUP_HEADING } from "./prompt-commands.ts";
import {
  NON_TOOL_TOKENS,
  declaredToolNamesFrom,
  hostToolFindings,
  mentionedToolWords,
  probeCountFindings,
  probeMatchLimitFrom,
  systemMentionFindings,
} from "./prompt-tools.ts";

/** 与真模板同形:两节齐备、每项一句用途、缺项说明在场。 */
const TEMPLATE = [
  "## 沙箱里有什么",
  "",
  BINARY_GROUP_HEADING,
  "",
  "- `bash` — 命令串的执行者。",
  "",
  HOST_TOOL_GROUP_HEADING,
  "",
  "- `check` — 检查当前脚本。",
  "- `evaluate` — 跑一次完整评测。",
  "- `probe` — 跑前 8 场回预算读数。",
  "- `finish` — 收工。",
].join("\n");

const DECLARED = ["bash", "check", "probe", "evaluate", "finish"];
const SANDBOX = ["bash"];

const SYSTEM = [
  "# 协议:每一步一次工具调用",
  "",
  "有哪几个工具以**工具声明**为准。",
  "",
  "- **收工是调用 `finish`。** 它就是声明里的一个工具。",
  "- 多条命令写进 `bash` 的同一条 `command` 里。",
].join("\n");

/** 一份最小可用的 `AGENT_TOOLS` 源码:形态与真文件一致(`name: "…"` 逐条列出)。 */
const TOOLS_SOURCE = [
  '/** 头注里提到的 `name: "__from-doc"` 不该被当成工具 */',
  "export const AGENT_TOOLS = [",
  "  {",
  '    name: "bash",',
  '    description: "名字在描述里也能出现:name: \\"__in-description\\"",',
  "    parameters: {},",
  "  },",
  '  { name: "check", parameters: {} },',
  '  { name: "probe", parameters: {} },',
  "] as const;",
  "export const TOOL_NAMES = AGENT_TOOLS.map((tool) => tool.name);",
  'const NOT_A_TOOL = { name: "__after-array" };',
].join("\n");

const red = (findings: readonly { where: string; detail: string }[]): string =>
  findings.map((finding) => `${finding.where}:${finding.detail}`).join("\n");

it("声明的工具名从源码文本取:只认 `AGENT_TOOLS` 数组里那些,且保留声明顺序", () => {
  const parsed = declaredToolNamesFrom(TOOLS_SOURCE);
  expect(parsed.ok).toBe(true);
  // 头注里的、描述字符串里的、数组之后的 —— 三种都不算工具:「切整段」是这条取法的全部意义。
  expect(parsed.ok && parsed.names).toEqual(["bash", "check", "probe"]);
});

it("抽不出声明时按失败处理并说明原因,不返回空集合", () => {
  const renamed = declaredToolNamesFrom("export const TOOLS = [] as const;");
  expect(renamed.ok).toBe(false);
  expect(renamed.ok ? "" : renamed.reason).toContain("AGENT_TOOLS");

  const empty = declaredToolNamesFrom("export const AGENT_TOOLS = [\n] as const;");
  expect(empty.ok).toBe(false);
  // 抽不到名字时「集合相等」会退化成空 == 空,那是这条判据最容易假绿的形状。
  expect(empty.ok ? "" : empty.reason).toContain("name");
});

it("分界从两个真源推:与 `bin/` 同名的工具归二进制那一节,其余是宿主工具", () => {
  expect(hostToolFindings(TEMPLATE, DECLARED, SANDBOX)).toEqual([]);
  // `bash` 写在宿主工具那一节 = 放错了节:它是模型敲沙箱命令的入口,不在宿主侧。
  const misplaced = TEMPLATE.replace(
    "- `finish` — 收工。",
    "- `bash` — 混进来了。\n- `finish` — 收工。",
  );
  expect(red(hostToolFindings(misplaced, DECLARED, SANDBOX))).toContain("bin/bash");
});

it("声明里加了工具、文案没加:红并点名那个工具", () => {
  const findings = hostToolFindings(TEMPLATE, [...DECLARED, "__newtool"], SANDBOX);
  expect(findings).toHaveLength(1);
  expect(red(findings)).toContain("__newtool");
});

it("文案点名了声明里没有的工具:红并点名", () => {
  const findings = hostToolFindings(
    TEMPLATE.replace("- `finish` — 收工。", "- `finish` — 收工。\n- `__ghost` — 不存在。"),
    DECLARED,
    SANDBOX,
  );
  expect(findings).toHaveLength(1);
  expect(red(findings)).toContain("__ghost");
});

it("标题换词 / 只点名不说用途 / 同一工具写两遍:各报一条", () => {
  const renamed = hostToolFindings(
    TEMPLATE.replace(HOST_TOOL_GROUP_HEADING, "### 宿主工具:换个词"),
    DECLARED,
    SANDBOX,
  );
  // 标题换词后整组都不算数,所以「声明里有而文案没写」也会跟着报——第一条仍是标题那条。
  expect(renamed[0]?.detail).toContain("没有那条分组标题");

  const noPurpose = hostToolFindings(TEMPLATE.replace("— 检查当前脚本。", "—"), DECLARED, SANDBOX);
  expect(noPurpose).toHaveLength(1);
  expect(red(noPurpose)).toContain("check");

  const twice = hostToolFindings(
    TEMPLATE.replace("- `finish` — 收工。", "- `check` — 又一遍。\n- `finish` — 收工。"),
    DECLARED,
    SANDBOX,
  );
  expect(red(twice)).toContain("不止一次");
});

it("`system` 里反引号括起来的单词:是工具就放行,登记过的非工具词也放行", () => {
  expect(mentionedToolWords(SYSTEM)).toEqual(["bash", "command", "finish"]);
  // `command` 不是工具,但它是 `bash` 的参数名——登记过,所以不红。
  expect(NON_TOOL_TOKENS.map((entry) => entry.token)).toContain("command");
  expect(systemMentionFindings(SYSTEM, DECLARED)).toEqual([]);
});

it("`system` 里点了一个既不是工具、也没登记的词:红并点名", () => {
  const findings = systemMentionFindings(`${SYSTEM}\n- 用 \`shell\` 也能跑。\n`, DECLARED);
  expect(findings).toHaveLength(1);
  expect(red(findings)).toContain("shell");
  // 免登记清单不是白名单:把同一个词放进声明,它就该放行。
  const declared = [...DECLARED, "shell"];
  expect(systemMentionFindings(`${SYSTEM}\n- 用 \`shell\` 也能跑。\n`, declared)).toEqual([]);
});

// ── 探针场数:散文里的那个数 == `PROBE_MATCH_LIMIT` ─────────────────────────────
//
// 这两条守的是一条**手写的重复**:工具声明的描述是模板字符串(从常量派生),而
// `prompts/agent.md` 那一句是散文。只改常量时,散文不会自己跟上,而模型读到的正是散文。

/** 一份最小可用的 schema 源码:形态与真文件一致(`8 as const`)。 */
const PROBE_LIMITS_SOURCE = [
  "/** 头注里的 `PROBE_MATCH_LIMIT = 4` 不该被当成真值 */",
  "export const PROBE_MATCH_LIMIT = 8 as const;",
  "export const PROBE_CALL_LIMIT = 5 as const;",
].join("\n");

it("场数从 schema 源码文本取:取第一个 `export const` 声明的那个数", () => {
  const parsed = probeMatchLimitFrom(PROBE_LIMITS_SOURCE);
  expect(parsed.ok && parsed.limit).toBe(8);
});

it("抽不出 `PROBE_MATCH_LIMIT` 时按失败处理并说明原因,不退化成 0", () => {
  const missing = probeMatchLimitFrom("export const PROBE_CALL_LIMIT = 5 as const;");
  expect(missing.ok).toBe(false);
  expect(missing.ok ? "" : missing.reason).toContain("PROBE_MATCH_LIMIT");

  // 写法变了(从别处引用、不是整数)——同样抽不到,而不是读成一个"差不多"的数。
  const computed = probeMatchLimitFrom(
    "export const PROBE_MATCH_LIMIT = TRIAL_GRID_SEAT_COUNT * 2 as const;",
  );
  expect(computed.ok).toBe(false);
});

it("散文里的场数与常量相等时放行,不等时红并同时说出两个数", () => {
  // `TEMPLATE` 里那句是「跑前 8 场回预算读数」。
  expect(probeCountFindings(TEMPLATE, 8)).toEqual([]);

  const mismatched = probeCountFindings(TEMPLATE, 4);
  expect(mismatched).toHaveLength(1);
  expect(red(mismatched)).toContain("前 8 场");
  expect(red(mismatched)).toContain("是 4");
});

it("散文里读不到「前 N 场」时按失败处理:判据失明不能安静放行", () => {
  const rewritten = probeCountFindings(
    TEMPLATE.replace("跑前 8 场回预算读数", "跑一段回预算读数"),
    8,
  );
  expect(rewritten).toHaveLength(1);
  expect(red(rewritten)).toContain("前 N 场");
});

it("散文里没有 `probe` 那一项时不在这里报:缺项归集合判据(不重复计一条)", () => {
  const withoutProbe = TEMPLATE.replace("- `probe` — 跑前 8 场回预算读数。\n", "");
  expect(probeCountFindings(withoutProbe, 8)).toEqual([]);
});
