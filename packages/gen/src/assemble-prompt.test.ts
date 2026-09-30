import { expect, it } from "vitest";
import { RULESET_VERSION } from "@model-war/schema";
import { assemblePrompt } from "./index.js";

it("钉住规则集版本", () => {
  expect(assemblePrompt({ rules: "机制", api: "签名" }).ruleset).toBe(RULESET_VERSION);
});

it("两份规则文档都进 prompt", () => {
  const text = assemblePrompt({ rules: "机制正文", api: "API 正文" }).text;
  expect(text).toContain("机制正文");
  expect(text).toContain("API 正文");
});

it("空文档也不会产出空串", () => {
  expect(assemblePrompt({ rules: "", api: "" }).text.length).toBeGreaterThan(0);
});
