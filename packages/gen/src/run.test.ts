import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RULESET_VERSION } from "@model-war/schema";
import { afterAll, expect, it } from "vitest";
import type { ModelConfig } from "./config.js";
import type { ModelClient } from "./model-client.js";
import { generateAndFreeze, runGeneration } from "./run.js";
import { fail, reply, stubClient, type StubClient } from "./stub-client.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = mkdtempSync(`${tmpdir()}/modelwar-run-`);
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

const CONTRACT_RULES = "# rules\n\n机制正文:这里是规则契约。\n";
const CONTRACT_API = "# api\n\nAPI 正文:这里是接口契约。\n";
/** 一份能过编译与静态校验的最简参赛脚本(票 02 起,回文本要真的能进存档)。 */
const VALID_SCRIPT = `var ticks = 0;\nfunction loop() {\n  ticks += 1;\n  return ticks;\n}\n`;

/**
 * 把仓库的安装面(编译与校验的依赖)接进临时根:`--root` 在真实使用里就是安装根。
 * 用符号链接而不是拷贝,让 fixture 与仓库同源。
 */
const installRuntime = (root: string): void => {
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repoRoot, "packages"), join(root, "packages"), "dir");
  symlinkSync(join(repoRoot, "tsconfig.scripts.json"), join(root, "tsconfig.scripts.json"));
  mkdirSync(join(root, "rulesets"), { recursive: true });
  writeFileSync(
    join(root, "rulesets", `${RULESET_VERSION}.json`),
    readFileSync(join(repoRoot, "rulesets", `${RULESET_VERSION}.json`)),
  );
};

/** 造一个临时根:契约两份文档 + `prompts/base.md` + `models.yaml` + 安装面。 */
const writeRoot = (modelsYaml: string, baseTemplate = "契约:\n\n{{contract}}\n"): string => {
  const root = mkdtempSync(`${scratch}/root-`);
  installRuntime(root);
  mkdirSync(join(root, "docs", "rules-v1"), { recursive: true });
  writeFileSync(join(root, "docs", "rules-v1", "rules.md"), CONTRACT_RULES);
  writeFileSync(join(root, "docs", "rules-v1", "api.md"), CONTRACT_API);
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(join(root, "prompts", "base.md"), baseTemplate);
  writeFileSync(join(root, "models.yaml"), modelsYaml);
  return root;
};

/** 一条模型条目的 YAML(缩进正确的若干行)。 */
const entry = (slug: string, extra: readonly string[] = []): readonly string[] => [
  `  - slug: ${slug}`,
  "    endpointFamily: chat-completions",
  "    baseUrl: https://example.test/v1",
  `    modelId: provider/${slug}`,
  "    credentialEnvVar: GEN_TEST_KEY",
  ...extra,
];

const configOf = (...entries: readonly (readonly string[])[]): string =>
  ["models:", ...entries.flat()].join("\n") + "\n";

it("顺利路径:经端口发一次请求、回得合法脚本,退出码 0", async () => {
  const root = writeRoot(configOf(entry("alpha")));
  const stub = stubClient([reply(VALID_SCRIPT)]);
  const code = await runGeneration({
    root,
    configPath: "models.yaml",
    createClient: () => stub,
  });
  expect(code).toBe(0);
  expect(stub.calls).toHaveLength(1);
});

it("一次调用发出的 messages 含完整契约与模板渲染结果(user 角色)", async () => {
  const root = writeRoot(configOf(entry("alpha")));
  const stub = stubClient([reply("x")]);
  await runGeneration({ root, configPath: "models.yaml", createClient: () => stub });
  const call = stub.calls[0];
  expect(call?.messages).toHaveLength(1);
  expect(call?.messages[0]?.role).toBe("user");
  const content = call?.messages[0]?.content ?? "";
  expect(content).toContain(CONTRACT_RULES);
  expect(content).toContain(CONTRACT_API);
  expect(content).toContain("契约:");
});

it("配置里的 strategy 进 prompt;params 透传给端口", async () => {
  const root = writeRoot(
    configOf(entry("alpha", ["    strategy: 占点不采集", "    params:", "      temperature: 0.2"])),
    "策略:{{strategy}}\n\n契约:\n\n{{contract}}\n",
  );
  const stub = stubClient([reply("x")]);
  await runGeneration({ root, configPath: "models.yaml", createClient: () => stub });
  expect(stub.calls[0]?.messages[0]?.content).toContain("占点不采集");
  expect(stub.calls[0]?.params).toEqual({ temperature: 0.2 });
});

it("模型没配 strategy 时,发出的 prompt 不留 `{{strategy}}` 也不留空占位", async () => {
  const root = writeRoot(configOf(entry("alpha")), "策略:{{strategy}}\n\n{{contract}}\n");
  const stub = stubClient([reply("x")]);
  await runGeneration({ root, configPath: "models.yaml", createClient: () => stub });
  const content = stub.calls[0]?.messages[0]?.content ?? "";
  expect(content).not.toContain("{{strategy}}");
  expect(content).not.toContain("策略:");
  expect(content).toContain(CONTRACT_RULES);
});

it("`--model` 只跑选中的那一个,其余模型不发请求", async () => {
  const root = writeRoot(configOf(entry("alpha"), entry("beta")));
  const alpha = stubClient([reply(VALID_SCRIPT)]);
  const beta = stubClient([reply(VALID_SCRIPT)]);
  const code = await runGeneration({
    root,
    configPath: "models.yaml",
    modelFilter: "beta",
    createClient: (config: ModelConfig): ModelClient => (config.slug === "beta" ? beta : alpha),
  });
  expect(code).toBe(0);
  expect(beta.calls).toHaveLength(1);
  expect((alpha as StubClient).calls).toHaveLength(0);
});

it("`--model` 指向未登记的 slug 即报错(不静默跑零个)", async () => {
  const root = writeRoot(configOf(entry("alpha")));
  await expect(
    runGeneration({
      root,
      configPath: "models.yaml",
      modelFilter: "nope",
      createClient: () => stubClient([]),
    }),
  ).rejects.toThrow(/没有 slug 为 "nope"/);
});

it("单模型失败不吞:退出码非零", async () => {
  const root = writeRoot(configOf(entry("alpha")));
  const stub = stubClient([fail(new Error("429 rate limited"))]);
  const code = await runGeneration({ root, configPath: "models.yaml", createClient: () => stub });
  expect(code).toBe(1);
});

it("契约目录缺失即报错(不内嵌副本降级)", async () => {
  const root = writeRoot(configOf(entry("alpha")));
  rmSync(join(root, "docs"), { force: true, recursive: true });
  await expect(
    runGeneration({ root, configPath: "models.yaml", createClient: () => stubClient([]) }),
  ).rejects.toThrow(/找不到规则契约目录/);
});

it("`generateAndFreeze` 缺 `--config` 即非零退出", async () => {
  expect(await generateAndFreeze([])).toBe(1);
});

it("`generateAndFreeze` 拿到未知参数即非零退出", async () => {
  expect(await generateAndFreeze(["--bogus", "x"])).toBe(1);
});

it("`generateAndFreeze` 解析出 root 后加载 `<root>/.env`(存在才加载)", async () => {
  const root = writeRoot(configOf(entry("alpha")));
  const key = `MW_GEN_TEST_ENV_${String(Date.now())}`;
  writeFileSync(join(root, ".env"), `${key}=loaded\n`);
  try {
    // 默认客户端未实现(票 08)→ 每个模型失败 → 非零;但 `.env` 已在跑管线之前加载。
    const code = await generateAndFreeze(["--root", root, "--config", "models.yaml"]);
    expect(code).toBe(1);
    expect(process.env[key]).toBe("loaded");
  } finally {
    delete process.env[key];
  }
});
