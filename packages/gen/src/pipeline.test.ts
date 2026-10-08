/**
 * 单模型生成轮(hld §2.2.6;契约 §2 / §4)的对外可观察行为。
 *
 * 断言对象只有**写出的文件与字节、退出码、`meta.json` / `ModelOutcome` 的内容**:三件套、
 * 十一项 meta、协议轮数、日志行、失败分类。不断言内部函数调用或实现步骤。
 *
 * ── 临时根 fixture ──
 *
 * 每个用例造一个临时根,里面物化生成管线装配时真正会去读的东西:契约两份文档、prompt 模板、
 * `models.yaml`、`rulesets/<RULESET_VERSION>.json`,并把 `node_modules` / `packages` /
 * `tsconfig.scripts.json` 以**符号链接**指向本仓库——`--root` 在真实使用里就是安装根,
 * 编译(tsc)与静态校验(tools 源码入口)都从它下面找。符号链接让 fixture 与仓库保持同源,
 * 又不把仓库布局抄一份进测试。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RULESET_VERSION, SANDBOX_RUNTIME_HASH, type ArchiveMeta } from "@model-war/schema";
import { afterAll, expect, it } from "vitest";

import { sha256Hex } from "./archive.js";
import { loadModelsConfig, type ModelConfig } from "./config.js";
import { readRuleDocs } from "./contract.js";
import { generateOneModel, type ModelOutcome } from "./pipeline.js";
import { loadBaseTemplate } from "./prompt.js";
import { runGeneration, type GenerationRequest } from "./run.js";
import { reply, stubClient, type StubClient } from "./stub-client.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = mkdtempSync(`${tmpdir()}/modelwar-gen-pipeline-`);
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

const CONTRACT_RULES = "# rules\n\n机制正文:这里是规则契约。\n";
const CONTRACT_API = "# api\n\nAPI 正文:这里是接口契约。\n";
const VALID_SCRIPT = `var ticks = 0;\nfunction loop() {\n  ticks += 1;\n  return ticks;\n}\n`;
const MODELS_YAML = [
  "models:",
  "  - slug: alpha",
  "    endpointFamily: chat-completions",
  "    baseUrl: https://example.test/v1",
  "    modelId: provider/alpha-1",
  "    credentialEnvVar: GEN_TEST_KEY",
  "",
].join("\n");

const only = (entries: readonly string[]): string => {
  const [first] = entries;
  if (first === undefined || entries.length !== 1) {
    throw new Error(`期望恰好一项,收到 ${JSON.stringify(entries)}`);
  }
  return first;
};

/** 造一个装得上管线的临时根。`scriptSizeLimit` 给了就写一份自定义规则集(体积两档要可控)。 */
const mkRoot = (scriptSizeLimit?: number): string => {
  const root = mkdtempSync(`${scratch}/root-`);
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repoRoot, "packages"), join(root, "packages"), "dir");
  symlinkSync(join(repoRoot, "tsconfig.scripts.json"), join(root, "tsconfig.scripts.json"));

  mkdirSync(join(root, "docs", "rules-v1"), { recursive: true });
  writeFileSync(join(root, "docs", "rules-v1", "rules.md"), CONTRACT_RULES);
  writeFileSync(join(root, "docs", "rules-v1", "api.md"), CONTRACT_API);
  mkdirSync(join(root, "prompts"), { recursive: true });
  writeFileSync(join(root, "prompts", "base.md"), "契约:\n\n{{contract}}\n");
  writeFileSync(join(root, "models.yaml"), MODELS_YAML);

  mkdirSync(join(root, "rulesets"), { recursive: true });
  const ruleset =
    scriptSizeLimit === undefined
      ? readFileSync(join(repoRoot, "rulesets", `${RULESET_VERSION}.json`))
      : Buffer.from(JSON.stringify({ scriptSizeLimit }));
  writeFileSync(join(root, "rulesets", `${RULESET_VERSION}.json`), ruleset);
  return root;
};

const firstModelConfig = (root: string): ModelConfig => {
  const [first] = loadModelsConfig(join(root, "models.yaml")).models;
  if (first === undefined) {
    throw new Error("fixture 缺模型条目");
  }
  return first;
};

/** 直接构造一份 `GenerationRequest`(绕开 `runGeneration` 的 `new Date()`,让 runId 可控)。 */
const requestWith = (root: string, stub: StubClient, runId: string): GenerationRequest => ({
  root,
  runId,
  docs: readRuleDocs(root),
  template: loadBaseTemplate(root),
  createClient: () => stub,
  now: () => new Date("2026-01-01T00:00:00Z"),
});

it("顺利路径:三件套 + 十一项 meta,协议轮数 = prompt 条数 = 1,退出码 0", async () => {
  const root = mkRoot();
  const stub = stubClient([reply(VALID_SCRIPT)]);
  const code = await runGeneration({
    root,
    configPath: "models.yaml",
    createClient: () => stub,
  });
  expect(code).toBe(0);

  const slugDir = join(root, "archive", "alpha");
  const runId = only(readdirSync(slugDir));
  const dir = join(slugDir, runId);

  const scriptTs = readFileSync(join(dir, "script.ts"), "utf8");
  const scriptJs = readFileSync(join(dir, "script.js"));
  expect(scriptTs).toBe(VALID_SCRIPT);
  expect(scriptJs.byteLength).toBeGreaterThan(0);

  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as ArchiveMeta;
  expect(Object.keys(meta)).toEqual([
    "model",
    "modelVersion",
    "generatedAt",
    "protocolRounds",
    "prompts",
    "generationLog",
    "ruleset",
    "validation",
    "tscVersion",
    "scriptSha256",
    "sandboxRuntimeHash",
  ]);
  expect(meta.model).toBe("alpha");
  expect(meta.modelVersion).toBe("provider/alpha-1");
  expect(meta.protocolRounds).toBe(1);
  expect(meta.prompts).toHaveLength(1);
  expect(meta.prompts[0]).toContain(CONTRACT_RULES);
  expect(meta.ruleset).toBe(RULESET_VERSION);
  expect(meta.sandboxRuntimeHash).toBe(SANDBOX_RUNTIME_HASH);
  expect(meta.scriptSha256).toBe(sha256Hex(scriptJs));
  expect(meta.validation).toEqual({ passed: true, errors: [] });
  expect(meta.tscVersion).toMatch(/^\d+\.\d+\.\d+/);

  const generationLog = meta.generationLog;
  expect(generationLog).toHaveLength(1);
  const log = JSON.parse(generationLog[0] ?? "{}") as Record<string, unknown>;
  expect(log.round).toBe(1);
  expect(log.kind).toBe("contract");
  expect(log.errorCodes).toEqual([]);
});

it("冻结期体积超限:不建目标目录、无半截三件套、退出码非零", async () => {
  const root = mkRoot(16);
  const code = await runGeneration({
    root,
    configPath: "models.yaml",
    createClient: () => stubClient([reply(VALID_SCRIPT)]),
  });
  expect(code).toBe(1);

  const slugDir = join(root, "archive", "alpha");
  expect(existsSync(slugDir)).toBe(true);
  // 「目录存在 ⇔ 三件套完整」:失败后连一个 runId 目录、一个 .tmp-* 残留都不该有。
  expect(readdirSync(slugDir)).toEqual([]);
});

it("冻结期体积超限:失败分类 contract,诊断是校验器 stdout", async () => {
  const root = mkRoot(16);
  const outcome: ModelOutcome = await generateOneModel(
    requestWith(root, stubClient([reply(VALID_SCRIPT)]), "2026-01-01T00-00-00-000Z"),
    firstModelConfig(root),
  );
  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") {
    return;
  }
  expect(outcome.failure.classification).toBe("contract");
  expect(outcome.failure.prompts).toHaveLength(1);
  expect(outcome.failure.generationLog).toHaveLength(1);
  expect(outcome.failure.diagnostics.join("\n")).toContain("脚本体积");
  const log = JSON.parse(outcome.failure.generationLog[0] ?? "{}") as Record<string, unknown>;
  expect(log.round).toBe(1);
  expect(log.kind).toBe("contract");
});

it("tsc 编译失败:失败分类 tsc,日志 kind=tsc 并带 TS 错误码,不建存档", async () => {
  const root = mkRoot();
  const outcome = await generateOneModel(
    requestWith(
      root,
      stubClient([reply("function loop() { return missingName; }\n")]),
      "2026-01-01T00-00-00-000Z",
    ),
    firstModelConfig(root),
  );
  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") {
    return;
  }
  expect(outcome.failure.classification).toBe("tsc");
  const log = JSON.parse(outcome.failure.generationLog[0] ?? "{}") as Record<string, unknown>;
  expect(log.kind).toBe("tsc");
  expect(log.errorCodes).toContain("TS2304");
  expect(readdirSync(join(root, "archive", "alpha"))).toEqual([]);
});

it("目标存档目录已存在即拒绝覆盖(runId 撞车),且不留临时目录", async () => {
  const root = mkRoot();
  const config = firstModelConfig(root);
  const runId = "2026-01-01T00-00-00-000Z";

  const first = await generateOneModel(
    requestWith(root, stubClient([reply(VALID_SCRIPT)]), runId),
    config,
  );
  expect(first.kind).toBe("frozen");

  const second = await generateOneModel(
    requestWith(root, stubClient([reply(VALID_SCRIPT)]), runId),
    config,
  );
  expect(second.kind).toBe("failed");
  if (second.kind === "failed") {
    expect(second.failure.message).toContain("已存在");
  }
  expect(readdirSync(join(root, "archive", "alpha"))).toEqual([runId]);
});
