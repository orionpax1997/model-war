import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import type { RuleDocs } from "./contract.js";
import { assemblePrompt, loadBaseTemplate, renderBaseTemplate } from "./prompt.js";

const scratch = mkdtempSync(`${tmpdir()}/modelwar-prompt-`);
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

const docs: RuleDocs = { rules: "机制正文", api: "API 正文" };

it("`{{contract}}` 注入两份契约文档,rules 与 api 以空行拼接", () => {
  const text = renderBaseTemplate("头\n\n{{contract}}\n\n尾", docs);
  expect(text).contains("机制正文\n\nAPI 正文");
  expect(text.startsWith("头\n\n")).toBe(true);
  expect(text.endsWith("\n\n尾")).toBe(true);
});

it("给了 strategy 就替换 `{{strategy}}`", () => {
  const text = renderBaseTemplate("取向:{{strategy}}。", docs, "爆兵压制");
  expect(text).toBe("取向:爆兵压制。");
});

it("缺省 strategy:整行去掉,不留 `{{strategy}}` 字面量、不留空占位", () => {
  const template = "A\n\n策略取向:{{strategy}}\n\nB";
  const text = renderBaseTemplate(template, docs);
  expect(text).toBe("A\n\nB");
  expect(text).not.toContain("{{strategy}}");
  expect(text).not.toContain("策略取向");
});

it("模板里没有 `{{strategy}}` 也不会出错", () => {
  expect(renderBaseTemplate("只有 {{contract}}", docs)).toBe("只有 机制正文\n\nAPI 正文");
});

it("`assemblePrompt` 与 `renderBaseTemplate` 同一实现", () => {
  expect(assemblePrompt).toBe(renderBaseTemplate);
});

it("`loadBaseTemplate` 从 `<root>/prompts/base.md` 读盘", () => {
  const root = mkdtempSync(`${scratch}/root-`);
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(join(root, "prompts", "base.md"), "");
  expect(loadBaseTemplate(root)).toBe("");
});

it("`loadBaseTemplate` 缺模板即报错(不静默降级)", () => {
  expect(() => loadBaseTemplate(join(scratch, "no-such-root"))).toThrow(/读不到 prompt 模板/);
});

// ── 真源数据文件 `prompts/base.md`:薄壳 + 指针清单,不复制判据文本 ──────────────────

const baseTemplate = loadBaseTemplate(fileURLToPath(new URL("../../../", import.meta.url)));

it("`prompts/base.md` 是带两个占位符的薄壳", () => {
  expect(baseTemplate).toContain("{{contract}}");
  expect(baseTemplate).toContain("{{strategy}}");
});

it("`prompts/base.md` 的硬约束只给指针(`rules.md` / `api.md` §X)", () => {
  expect(baseTemplate).toMatch(/`rules\.md` §/);
  expect(baseTemplate).toMatch(/`api\.md` §/);
});

it("`prompts/base.md` 不复制契约判据原文", () => {
  // 这些串是契约文档里判据正文的特征串;模板复述任何一条都等于把真源分叉出第二份。
  for (const judgementText of [
    "Math.random",
    "queueMicrotask",
    "ERR_NOT_OWNER",
    "isError",
    "exceptionTickLimit",
    "getMyIndex",
    "spawnUnit",
  ]) {
    expect(baseTemplate, `模板不该出现判据正文特征串:${judgementText}`).not.toContain(
      judgementText,
    );
  }
});

it("缺省 strategy 时,真源模板渲染后不留 `{{strategy}}`、不留判据正文", () => {
  const text = renderBaseTemplate(baseTemplate, docs);
  expect(text).not.toContain("{{strategy}}");
  expect(text).not.toContain("{{contract}}");
  expect(text).toContain("机制正文");
  expect(text).toContain("API 正文");
});
