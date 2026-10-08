import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { loadModelsConfig } from "./config.js";

const scratch = mkdtempSync(`${tmpdir()}/modelwar-config-`);
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

let seq = 0;
const writeConfig = (text: string): string => {
  seq += 1;
  const path = join(scratch, `models-${String(seq)}.yaml`);
  writeFileSync(path, text, "utf8");
  return path;
};

const fullEntry = [
  "  - slug: alpha",
  "    endpointFamily: chat-completions",
  "    baseUrl: https://example.test/provider/v1",
  "    modelId: provider/alpha",
  "    credentialEnvVar: ALPHA_KEY",
].join("\n");

it("读入一条含全部可选字段的模型", () => {
  const path = writeConfig(
    [
      "models:",
      fullEntry,
      "    contextLength: 128000",
      "    protocolRounds: 3",
      '    strategy: "稳"',
      "    params:",
      "      temperature: 0.2",
      "",
    ].join("\n"),
  );
  const { models } = loadModelsConfig(path);
  expect(models).toHaveLength(1);
  expect(models[0]).toMatchObject({
    slug: "alpha",
    endpointFamily: "chat-completions",
    baseUrl: "https://example.test/provider/v1",
    modelId: "provider/alpha",
    credentialEnvVar: "ALPHA_KEY",
    contextLength: 128000,
    protocolRounds: 3,
    strategy: "稳",
  });
  expect(models[0]?.params).toEqual({ temperature: 0.2 });
});

it("只写必填五项也合法,可选字段缺席(不是 undefined 键)", () => {
  const { models } = loadModelsConfig(writeConfig(`models:\n${fullEntry}\n`));
  const model = models[0];
  expect(model).toBeDefined();
  expect(Object.hasOwn(model as object, "strategy")).toBe(false);
  expect(Object.hasOwn(model as object, "protocolRounds")).toBe(false);
  expect(Object.hasOwn(model as object, "params")).toBe(false);
});

it("三条端点族都认", () => {
  const families = ["chat-completions", "messages", "responses"] as const;
  const text = [
    "models:",
    ...families.map((family, index) =>
      [
        `  - slug: m${String(index)}`,
        `    endpointFamily: ${family}`,
        "    baseUrl: https://example.test/v1",
        `    modelId: provider/m${String(index)}`,
        "    credentialEnvVar: KEY",
      ].join("\n"),
    ),
  ].join("\n");
  const { models } = loadModelsConfig(writeConfig(`${text}\n`));
  expect(models.map((model) => model.endpointFamily)).toEqual([...families]);
});

it("缺必填字段:逐字段点名 `models[序号]` 与字段名", () => {
  const path = writeConfig(
    [
      "models:",
      "  - slug: alpha",
      "    baseUrl: https://example.test/v1",
      "    modelId: provider/alpha",
      "    credentialEnvVar: ALPHA_KEY",
      "",
    ].join("\n"),
  );
  expect(() => loadModelsConfig(path)).toThrow(/models\[0\].*endpointFamily/s);
});

it("缺 credentialEnvVar 明确报错", () => {
  const path = writeConfig(
    [
      "models:",
      "  - slug: alpha",
      "    endpointFamily: messages",
      "    baseUrl: https://x/v1",
      "    modelId: p/a",
      "",
    ].join("\n"),
  );
  expect(() => loadModelsConfig(path)).toThrow(/models\[0\].*credentialEnvVar/s);
});

it("未知 endpointFamily 明确报错", () => {
  const path = writeConfig(
    [
      "models:",
      "  - slug: alpha",
      "    endpointFamily: grpc",
      "    baseUrl: https://example.test/v1",
      "    modelId: provider/alpha",
      "    credentialEnvVar: ALPHA_KEY",
      "",
    ].join("\n"),
  );
  expect(() => loadModelsConfig(path)).toThrow(/endpointFamily.*grpc/s);
});

it("多条目时把每条的问题一次看完", () => {
  const path = writeConfig(["models:", "  - slug: a", "  - slug: b", ""].join("\n"));
  expect(() => loadModelsConfig(path)).toThrow(/models\[0\][\s\S]*models\[1\]/);
});

it("protocolRounds 必须是 ≥1 的整数", () => {
  const path = writeConfig(`models:\n${fullEntry}\n    protocolRounds: 0\n`);
  expect(() => loadModelsConfig(path)).toThrow(/protocolRounds/);
});

it("空 models 清单报错(不静默返回成功)", () => {
  expect(() => loadModelsConfig(writeConfig("models: []\n"))).toThrow(/至少要有 1 条/);
});

it("slug 重复报错(存档目录以 slug 分家)", () => {
  const path = writeConfig(`models:\n${fullEntry}\n${fullEntry}\n`);
  expect(() => loadModelsConfig(path)).toThrow(/slug.*重复/);
});

it("顶层不是映射时报错", () => {
  expect(() => loadModelsConfig(writeConfig("- a\n- b\n"))).toThrow(/顶层/);
});

it("YAML 语法错误报错(带文件路径)", () => {
  expect(() => loadModelsConfig(writeConfig("models: [\n"))).toThrow(/YAML 解析失败/);
});

it("读不到文件即报错", () => {
  expect(() => loadModelsConfig(join(scratch, "no-such.yaml"))).toThrow(/读不到模型配置/);
});
