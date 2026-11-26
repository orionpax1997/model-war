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

import {
  completeGridTrial,
  gridPlanFixture,
  runGeneration,
  stubClient,
  toolCall,
} from "@model-war/gen";
import { withRealBash } from "@model-war/gen/testing";
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
  "    channelId: gen-test-channel",
  "    contextLength: 100000",
  "",
].join("\n");

/** 造一个装得上 gen 管线的临时根(与 `packages/gen` 侧 fixture 同一形态:安装面走符号链接)。 */
const mkRoot = (): string => {
  const root = mkdtempSync(`${scratch}/root-`);
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repoRoot, "packages"), join(root, "packages"), "dir");
  symlinkSync(join(repoRoot, "tsconfig.scripts.json"), join(root, "tsconfig.scripts.json"));

  mkdirSync(join(root, "docs", "rules-v2"), { recursive: true });
  writeFileSync(join(root, "docs", "rules-v2", "rules.md"), CONTRACT_RULES);
  writeFileSync(join(root, "docs", "rules-v2", "api.md"), CONTRACT_API);
  mkdirSync(join(root, "prompts"), { recursive: true });
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
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  // agent 形态的一次会话:写脚本 → evaluate → done。三步各一次模型调用。
  //
  // 执行器换成宿主 `bash`(`@model-war/gen/testing` 的 `withRealBash`):`runGeneration` 的第一件事是
  // 启动自证(ADR-0033),它要真跑 bwrap,而**本文件在常跑链(unit)上**——那条链不装 bubblewrap。
  // 不换的后果是「本机装了 bwrap 所以绿、CI 上红」,两种处方混成一条红。真隔离由
  // `apps/cli/src/agent-real-session.test.ts`(`verify:kernel`)与 `agent-session-archive.test.ts`
  // 的同形断言分工覆盖;这条只关心「产出的存档过得了装载校验」。
  const code = await withRealBash(workspaceDir, () =>
    runGeneration({
      root,
      configPath: "models.yaml",
      createClient: () =>
        stubClient([
          toolCall(
            "bash",
            JSON.stringify({ command: `cat > /workspace/script.ts <<'EOF'\n${VALID_SCRIPT}EOF` }),
          ),
          toolCall("evaluate", "{}"),
          toolCall("finish", "{}"),
        ]),
      agentPrompt: { user: "任务:写 script.ts", system: "协议:每一步一个动作块" },
      workspaceDir,
      // 本文件不断言真试跑（真试跑由 `gen-cli.test.ts` 的 sandbox 用例覆盖），这里走
      // 「形状真实」的假网格：32 行观测 + 旁挂汇总。成绩走**缺省**评分（真网格那一支：
      // 从旁挂 `.grid.json` 读），所以这条链上的分数来源与生产同一条。
      trial: completeGridTrial(),
      trialPlan: () => gridPlanFixture(),
    }),
  );
  expect(code).toBe(0);

  const slugDir = join(root, "archive", "alpha");
  const [runId] = readdirSync(slugDir).filter(
    (name) => !name.startsWith("observed-") && !name.startsWith("failed-"),
  );
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
    // v3 的公式不再成立「轮数 == prompt 条数」:轮数等于过程记录条数,prompt 恒为一条
    // (「断言合并成一个公式」的两种形态各一份)。
    expect(validation.meta.protocolRounds).toBe(3);
    expect(validation.meta.prompts).toHaveLength(1);
    expect(validation.meta.steps).toHaveLength(3);
  }
});
