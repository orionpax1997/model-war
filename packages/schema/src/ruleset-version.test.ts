import { expect, it } from "vitest";
import { RULESET_VERSION } from "./index.js";

it("规则集版本真源是 v2", () => {
  expect(RULESET_VERSION).toBe("v2");
});

it("版本号形状与 docs/rules-vN、rulesets/vN.json 对齐", () => {
  expect(RULESET_VERSION).toMatch(/^v[0-9]+$/);
});
