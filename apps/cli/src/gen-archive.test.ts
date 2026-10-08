/**
 * 生成管线的下游装载断言:gen 写出的存档能不能被 `modelwar match` 那套装载判据收下。
 *
 * ── 为什么这条挂在 apps/cli 侧 ──
 *
 * 「存档可装载」是**消费方**的判据:装载期校验器(`./validator.ts` 的 `validateArchiveMeta`)
 * 住在 CLI 应用里,gen 不能 import 它(依赖方向 gen → schema)。所以这条测试用 `@model-war/gen`
 * 的 `runGeneration` + 注入桩在临时根里真产出一份存档,再拿 CLI 侧那份校验器**现场量到的事实**
 * (三件套在不在、`script.js` 实测 sha256、本仓 runtime hash、实际装载的 ruleset 版本)去判它
 * `ok: true`。这正是 `match` 装载每个座位时做的事,只是座位换成了刚生成的那一份。
 *
 * 形状缺口由 `validateArchiveMeta` 里的 ajv 判,跨字段缺口(哈希、轮数、版本三处一致)由同一
 * 函数的诊断判——本文件只负责把两样事实摆齐,不复述任何判据。
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { reply, runGeneration, stubClient } from "@model-war/gen";
import { RULESET_VERSION, SANDBOX_RUNTIME_HASH, type JsonValue } from "@model-war/schema";
import { afterAll, expect, it } from "vitest";

import { validateArchiveMeta } from "./validator.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = mkdtempSync(`${tmpdir()}/modelwar-gen-archive-`);
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

/** 造一个装得上 gen 管线的临时根(与 `packages/gen` 侧 fixture 同一形态:安装面走符号链接)。 */
const mkRoot = (): string => {
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
  writeFileSync(
    join(root, "rulesets", `${RULESET_VERSION}.json`),
    readFileSync(join(repoRoot, "rulesets", `${RULESET_VERSION}.json`)),
  );
  return root;
};

it("gen 产出的存档过 `validateArchiveMeta`:三件套齐、哈希与版本三处一致", async () => {
  const root = mkRoot();
  const code = await runGeneration({
    root,
    configPath: "models.yaml",
    createClient: () => stubClient([reply(VALID_SCRIPT)]),
  });
  expect(code).toBe(0);

  const slugDir = join(root, "archive", "alpha");
  const [runId] = readdirSync(slugDir);
  if (runId === undefined) {
    throw new Error("gen 没有产出存档目录");
  }
  const dir = join(slugDir, runId);

  // 三件套都在位。
  expect(existsSync(join(dir, "script.ts"))).toBe(true);
  expect(existsSync(join(dir, "script.js"))).toBe(true);
  expect(existsSync(join(dir, "meta.json"))).toBe(true);

  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as JsonValue;
  const scriptJs = readFileSync(join(dir, "script.js"));

  const validation = validateArchiveMeta(meta, {
    filesPresent: {
      scriptTs: existsSync(join(dir, "script.ts")),
      scriptJs: true,
      metaJson: true,
    },
    measuredScriptSha256: createHash("sha256").update(scriptJs).digest("hex"),
    measuredSandboxRuntimeHash: SANDBOX_RUNTIME_HASH,
    loadedRulesetVersion: RULESET_VERSION,
  });

  expect(validation.ok, JSON.stringify(validation)).toBe(true);
  if (validation.ok) {
    expect(validation.meta.model).toBe("alpha");
    expect(validation.meta.ruleset).toBe(RULESET_VERSION);
    expect(validation.meta.protocolRounds).toBe(validation.meta.prompts.length);
    expect(validation.meta.protocolRounds).toBe(1);
  }
});
