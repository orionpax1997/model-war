/**
 * 首条消息渲染的自测(ADR-0030「首条消息只给目录」、ADR-0037「身份落末行」)。
 *
 * ── 最要紧的一条是「不含契约正文」 ──
 *
 * 这条判据不靠注释、也不靠 review:它由用例钉住。理由在 ADR-0030——分步形态的全部意义是让模型
 * **自己去查**它需要的那一小块;正文一旦被内联进首条消息,「先读什么」就不再是模型的策略决策,
 * 而且那些字节会跟着档案冻结(ADR-0031),改契约也改不动它们。
 *
 * 反面钉法有两层:整份文档的全文不得出现(最强、也最不容易误报),以及若干条正文特征串不得出现
 * (它们让失败信息直接指到「哪一段漏进来了」)。目录说明则相反,它是**全量内联**的那一份。
 *
 * ── 身份末行用真常量验,不用假值 ──
 *
 * 末行 `contract: <版本号> tree=sha256:<hex>` 的两半各有一个真源(`RULESET_VERSION` /
 * `CONTRACT_TREE_HASH`)。用例断言它就是那两个值,而不是「长得像 hex」——后者在版本号写成 `v1`
 * 或哈希取错来源时照样绿。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTRACT_TREE_HASH, RULESET_VERSION } from "@model-war/schema";
import { afterAll, expect, it } from "vitest";

import {
  AGENT_SYSTEM_TEMPLATE_NAME,
  AGENT_TEMPLATE_NAME,
  contractIdentityTrailer,
  loadAgentPrompt,
  loadAgentSystemTemplate,
  loadAgentTemplate,
  readContractIndex,
  renderAgentTemplate,
} from "./agent-prompt.js";
import { readRuleDocs } from "./contract.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const scratch = mkdtempSync(`${tmpdir()}/modelwar-agent-prompt-`);
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

/** ADR-0030 的四条挂载路径。写死是对的:它断言的是契约,不是「README 与它自己一致」。 */
const MOUNT_PATHS = [
  "/contract/README.md",
  "/contract/rules.md",
  "/contract/api.md",
  "/contract/examples/minimal.ts",
] as const;

const prompt = (): { readonly user: string; readonly system: string } => loadAgentPrompt(repoRoot);

const lastLine = (text: string): string => text.trimEnd().split("\n").at(-1) ?? "";

// ── 渲染是纯函数 ──────────────────────────────────────────────────────────

it("两个占位符各自替换:目录说明全量内联,身份进末行", () => {
  const rendered = renderAgentTemplate(
    "{{contractIndex}}\n\n---\n\ncontract: {{contractDigest}}",
    "目录说明正文",
    { version: "v1", treeHash: "0".repeat(64) },
  );
  expect(rendered).toBe(`目录说明正文\n\n---\n\ncontract: v1 tree=sha256:${"0".repeat(64)}`);
});

it("身份行的形状是 `contract: <版本号> tree=sha256:<hex>`(口径在 ADR-0037)", () => {
  expect(contractIdentityTrailer({ version: "v2", treeHash: "ab".repeat(32) })).toBe(
    `v2 tree=sha256:${"ab".repeat(32)}`,
  );
});

it("目录说明为空即报错:它是首条消息的全部内容", () => {
  expect(() => renderAgentTemplate("{{contractIndex}}{{contractDigest}}", "  \n")).toThrow(
    /目录说明是空的/,
  );
});

it("模板缺占位符即报错(渲染出的消息会悄悄少掉一段)", () => {
  expect(() => renderAgentTemplate("只有 {{contractIndex}}", "说明")).toThrow(/contractDigest/);
  expect(() => renderAgentTemplate("只有 {{contractDigest}}", "说明")).toThrow(/contractIndex/);
});

it("目录说明逐字内联:正文里出现占位符字样也照原样留下", () => {
  const index = "目录说明里提到 {{contractDigest}} 这个词";
  expect(
    renderAgentTemplate("{{contractIndex}}|{{contractDigest}}", index, {
      version: "v2",
      treeHash: "0".repeat(64),
    }),
  ).toBe(`${index}|v2 tree=sha256:${"0".repeat(64)}`);
});

// ── 读盘:模板与目录说明 ─────────────────────────────────────────────────

it("两份模板各自从 `<root>/prompts/` 读盘", () => {
  const root = mkdtempSync(`${scratch}/root-`);
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(join(root, "prompts", AGENT_TEMPLATE_NAME), "首条消息");
  writeFileSync(join(root, "prompts", AGENT_SYSTEM_TEMPLATE_NAME), "协议");
  expect(loadAgentTemplate(root)).toBe("首条消息");
  expect(loadAgentSystemTemplate(root)).toBe("协议");
});

it("缺模板即报错(不静默降级)", () => {
  expect(() => loadAgentTemplate(join(scratch, "no-such-root"))).toThrow(/首条消息模板/);
  expect(() => loadAgentSystemTemplate(join(scratch, "no-such-root"))).toThrow(/system 模板/);
});

it("目录说明从契约目录读:与两份正文同住一处(版本由 RULESET_VERSION 拼)", () => {
  expect(readContractIndex(repoRoot)).toBe(
    readFileSync(join(repoRoot, "docs", `rules-${RULESET_VERSION}`, "README.md"), "utf8"),
  );
});

// ── 真模板渲染出来的首条消息 ─────────────────────────────────────────────

it("首条消息里四条挂载路径都在", () => {
  // 来源是目录说明的全量内联:模型必须先知道四条各存在,才谈得上「自己去读哪一条」。
  for (const path of MOUNT_PATHS) {
    expect(prompt().user, `首条消息里没有 ${path}`).toContain(path);
  }
  const index = readContractIndex(repoRoot);
  for (const path of MOUNT_PATHS) {
    expect(index, `目录说明没有点名 ${path}`).toContain(path);
  }
});

it("末行是身份:`contract: <版本号> tree=sha256:<hex>`,两半都取真源", () => {
  expect(lastLine(prompt().user)).toBe(
    `contract: ${RULESET_VERSION} tree=sha256:${CONTRACT_TREE_HASH}`,
  );
  expect(lastLine(prompt().user)).toMatch(/^contract: v2 tree=sha256:[0-9a-f]{64}$/);
});

it("目录说明是**全量**内联,不是它的某一节", () => {
  expect(prompt().user).toContain(readContractIndex(repoRoot));
});

it("首条消息里不出现契约正文:rules.md 与 api.md 的全文都不在", () => {
  const docs = readRuleDocs(repoRoot);
  const { user } = prompt();
  expect(user).not.toContain(docs.rules);
  expect(user).not.toContain(docs.api);
});

it("首条消息里不出现契约正文的特征串", () => {
  // 这些串来自正文深处(标题、§6 的骨架辅助函数、错误码、确定性小节),内联任何一段都会命中。
  const judgements = [
    "### 1.2 座位自认",
    "function foeOwnerOf",
    "ERR_NOT_OWNER",
    "## 9. 确定性约束",
    "spawnUnit",
  ];
  for (const text of judgements) {
    expect(prompt().user, `首条消息里漏进了契约正文:${text}`).not.toContain(text);
  }
});

it("首条消息里没有未替换的占位符,也不复制骨架本身", () => {
  const { user } = prompt();
  expect(user).not.toContain("{{");
  // 首条消息只给「骨架在哪、怎么起手」,不给骨架内容——内容在 `/contract/examples/minimal.ts`。
  expect(user).not.toContain("export function");
});

it("`system` 原样用 `prompts/agent-system.md`:不渲染、无占位符", () => {
  const system = prompt().system;
  expect(system).toBe(loadAgentSystemTemplate(repoRoot));
  expect(system).not.toContain("{{");
  // 协议那一半与任务那一半是两条消息(ADR-0032):system 里不写任务,首条消息里不写协议。
  expect(system).not.toContain("你的任务");
});

it("围栏块话术已随协议删除:`system` 与首条消息里都不再提它", () => {
  // 新协议是「一步一次工具调用」,围栏块已经不存在——两份提示词里若还留着「恰好一个 `bash`
  // 代码块」「动作块」这类话术,模型会照着旧形状输出,而那种输出现在只能拿到一条纠正。
  const { system, user } = prompt();
  for (const [what, text] of [
    ["system", system],
    ["首条消息", user],
  ] as const) {
    for (const phrase of ["代码块", "动作块", "围栏"]) {
      expect(text, `${what} 里还留着旧协议的「${phrase}」话术`).not.toContain(phrase);
    }
  }
  // 反过来:协议那一半得把新形状说清楚——「一次调用」与「工具声明」是它的两个落点。
  expect(system).toContain("一次工具调用");
  expect(system).toContain("工具声明");
});
