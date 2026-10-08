import { expect, it } from "vitest";
import { parseYamlSubset } from "./yaml-lite.js";

it("解析块映射 + 块序列 + 嵌套映射", () => {
  const source = [
    "models:",
    "  - slug: alpha",
    "    endpointFamily: chat-completions",
    "    baseUrl: https://example.test/provider/v1",
    "    params:",
    "      temperature: 0.2",
    "  - slug: beta",
    "    endpointFamily: messages",
    "",
  ].join("\n");
  expect(parseYamlSubset(source, "x.yaml")).toEqual({
    models: [
      {
        slug: "alpha",
        endpointFamily: "chat-completions",
        baseUrl: "https://example.test/provider/v1",
        params: { temperature: 0.2 },
      },
      { slug: "beta", endpointFamily: "messages" },
    ],
  });
});

it("去掉整行与行尾注释;引号内的 `#` 不算注释", () => {
  const source = ["# 头注释", "a: 1 # 行尾注释", 'b: "x # y"', ""].join("\n");
  expect(parseYamlSubset(source, "x.yaml")).toEqual({ a: 1, b: "x # y" });
});

it("标量:单引号、双引号、布尔、null、整数、小数", () => {
  const source = [
    "s: 'it''s ok'",
    'd: "line\\nbreak"',
    "t: true",
    "f: false",
    "n: null",
    "tilde: ~",
    "i: -3",
    "x: 1.5",
    "",
  ].join("\n");
  expect(parseYamlSubset(source, "x.yaml")).toEqual({
    s: "it's ok",
    d: "line\nbreak",
    t: true,
    f: false,
    n: null,
    tilde: null,
    i: -3,
    x: 1.5,
  });
});

it("空流式字面量 `[]` / `{}`", () => {
  expect(parseYamlSubset("a: []\nb: {}\n", "x.yaml")).toEqual({ a: [], b: {} });
});

it("非空流式数组报错(不猜)", () => {
  expect(() => parseYamlSubset("a: [1, 2]\n", "x.yaml")).toThrow(/流式/);
});

it("制表符缩进报错", () => {
  expect(() => parseYamlSubset("a:\n\tb: 1\n", "x.yaml")).toThrow(/制表符/);
});

it("空文档返回 null", () => {
  expect(parseYamlSubset("\n# 只有注释\n", "x.yaml")).toBeNull();
});
