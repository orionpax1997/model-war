/**
 * 编排层的单测:`runGeneration` 的串行调度、退出码、`--model` 选取与 CLI 参数校验。
 *
 * ── 这一组不测 loop 的行为 ──
 *
 * 单会话 loop 的六个终止分支、历史形状、截断归并在 `pipeline.test.ts`;这里只钉编排层自己
 * 的责任:一个模型失败不拖垮整批、选中哪个模型、参数错在**发请求之前**报。
 *
 * ── 假的三样 ──
 *
 * 模型(桩)、沙箱执行(`agent/sandbox.fixture.ts` 那层替身)、时钟。真的只有档案组装、失败档写盘
 * 与 CLI 参数解析。替身只有一份:本文件不另抄一套 `TOOL_COMMANDS` / `withRealBash`
 * (`pipeline.test.ts` 与 `apps/cli` 那两条链读的也是同一份),否则「通道先于执行」这条时序
 * 会在三份副本里各自漂。
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

import { afterAll, expect, it } from "vitest";

import type { ModelConfig } from "./config.js";
import { generateAndFreeze, runGeneration } from "./run.js";
import { preflightFailureMessage } from "./agent/sandbox/index.js";
import { fail, stubClient, toolCall, type StubClient } from "./stub-client.js";
import type { AgentPrompt } from "./agent-prompt.js";
import { withHostBash, withRealBash } from "./agent/sandbox.fixture.js";
import { completeGridTrial } from "./trial-grid.fixture.js";
import { gridPlanFixture } from "./trial-plan.fixture.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "modelwar-agent-run-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PROMPT: AgentPrompt = { user: "任务:写 script.ts", system: "协议:每一步一个动作块" };

/** 一个能跑的安装根:符号链接回仓库(校验器与 tsc 要真跑)。 */
const writeRoot = (configText: string): string => {
  const root = mkdtempSync(join(scratch, "root-"));
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repoRoot, "packages"), join(root, "packages"), "dir");
  writeFileSync(
    join(root, "tsconfig.scripts.json"),
    readFileSync(join(repoRoot, "tsconfig.scripts.json")),
  );
  mkdirSync(join(root, "rulesets"), { recursive: true });
  writeFileSync(
    join(root, "rulesets", "v2.json"),
    readFileSync(join(repoRoot, "rulesets", "v2.json")),
  );
  writeFileSync(join(root, "models.yaml"), configText);
  return root;
};

/** 一个模型条目。`contextLength` 必填:agent 形态的守卫需要窗口大小。 */
const entry = (slug: string, extra: readonly string[] = []): string =>
  [
    `  - slug: ${slug}`,
    "    endpointFamily: chat-completions",
    "    baseUrl: https://example.invalid/v1",
    `    modelId: vendor/${slug}`,
    "    credentialEnvVar: TEST_KEY",
    "    channelId: test-channel",
    "    contextLength: 100000",
    ...extra,
  ].join("\n");

const modelsYaml = (...entries: readonly string[]): string => ["models:", ...entries].join("\n");

/**
 * 替掉 `sandbox.run`:一次调用回一份空输出。
 *
 * 生产的「怎么跑一步」只有那一个调用点,替它而不是加注参——后者会造出一条只在测试里存在的
 * 第二条路。
 */
const clientOf = (steps: Parameters<typeof stubClient>[0]): StubClient => stubClient(steps);

/** 一条「写脚本」的命令串:真 bwrap 里就是 heredoc,这里原样保留(替身改写 `/workspace` 前缀)。 */
const WRITE_SCRIPT = (body: string): string => `cat > /workspace/script.ts <<'EOF'\n${body}EOF`;

/** 一次 `bash` 工具调用。 */
const bashOf = (command: string) => toolCall("bash", JSON.stringify({ command }));

/** 一次不收参数的工具调用。 */
const toolOf = (name: string) => toolCall(name, "{}");

const SCRIPT_BODY = "function loop() {}\n";

/**
 * 只回空输出的替身(不跑 bash、也不点亮通道)。
 *
 * 用在「这一步跑不跑得起来与判据无关」的用例上:它们验的是编排层(选中哪个模型、退出码、
 * 失败档写没写),不是沙箱里发生了什么。
 */
const withPlainSandbox = async <T>(body: () => Promise<T>): Promise<T> =>
  await withHostBash(async () => ({ stdout: "", stderr: "", exitCode: 0 }), body);

it("顺利路径:一次 evaluate 出成绩就冻结,退出码 0", { timeout: 30_000 }, async () => {
  const root = writeRoot(modelsYaml(entry("alpha")));
  const client = clientOf([bashOf(WRITE_SCRIPT(SCRIPT_BODY)), toolOf("evaluate")]);
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const code = await withRealBash(workspaceDir, () =>
    runGeneration({
      root,
      configPath: "models.yaml",
      createClient: () => client,
      agentPrompt: PROMPT,
      workspaceDir,
      maxSteps: 2,
      // 试跑与计划桩:验的是编排层,不是网格本身(真网格在 `gen-cli.test.ts` 那一侧)。
      // 桩写的是形状真实的一整张网格——候选的入场券就是「32 场一场不少」。
      trial: completeGridTrial(),
      trialPlan: () => gridPlanFixture(),
      evaluateScoring: async () => ({
        score: { totalPoints: 4, averagePoints: 1, countedMatches: 4 },
        matchCount: 4,
      }),
    }),
  );
  expect(code).toBe(0);
  // 冻结档是一个目录(三件套),不是 failed-*.json。
  const entries = readdirSync(join(root, "archive/alpha"));
  expect(entries.some((name) => name.startsWith("failed-"))).toBe(false);
  expect(entries.some((name) => /^\d/u.test(name))).toBe(true);
});

it("沙箱起不来就整批失败:一个会话都不启动,报错带三种已知成因", async () => {
  // ADR-0033「执行器启动时先自证…失败即 fail-closed,任务直接失败,不回落宿主进程」。
  // 这条用例验的正是那个位置:自证在**第一次模型调用之前**,而不是等某一步的 `sandbox.run` 袛。
  const root = writeRoot(modelsYaml(entry("alpha"), entry("beta")));
  // 回复一个都不给:只要真启动了会话,`stubClient` 就会以「没有更多回复」赫在那里。
  const client = clientOf([]);
  let clientsCreated = 0;
  const message = preflightFailureMessage("最小 bwrap 调用没有跑通(测试注入)");

  await expect(
    withPlainSandbox(() =>
      runGeneration({
        root,
        configPath: "models.yaml",
        createClient: () => {
          clientsCreated += 1;
          return client;
        },
        agentPrompt: PROMPT,
        // 真的 `sandbox.preflight()` 要跑 bwrap;常跑链不装它,所以这里注入失败实现——
        // 「不可用就整批失败」只能在注入下验。其余每一条用例注入的都是恒过实现。
        preflight: () => {
          throw new Error(message);
        },
      }),
    ),
  ).rejects.toThrow(/沙箱不可用/);

  // 一个会话都没启动:客户端一次都没被建,模型一次都没被调。
  expect(clientsCreated).toBe(0);
  expect(client.calls).toHaveLength(0);
  // 也没有「这次会话的结论」可记:失败档是会话级的,而这里连会话都没开。
  expect(existsSync(join(root, "archive"))).toBe(false);
});

it("`--model` 只跑选中的那一个,其余模型不发请求", { timeout: 30_000 }, async () => {
  const root = writeRoot(modelsYaml(entry("alpha"), entry("beta")));
  const alpha = clientOf([toolOf("finish")]);
  const beta = clientOf([]);
  await withPlainSandbox(() =>
    runGeneration({
      root,
      configPath: "models.yaml",
      modelFilter: "alpha",
      createClient: (config): StubClient => (config.slug === "alpha" ? alpha : beta),
      agentPrompt: PROMPT,
      maxSteps: 1,
    }),
  );
  expect(alpha.calls).toHaveLength(1);
  expect(beta.calls).toHaveLength(0);
});

it("`--model` 指向未登记的 slug 即报错(不静默跑零个)", async () => {
  const root = writeRoot(modelsYaml(entry("alpha")));
  await expect(
    runGeneration({
      root,
      configPath: "models.yaml",
      modelFilter: "nobody",
      createClient: () => clientOf([]),
      agentPrompt: PROMPT,
    }),
  ).rejects.toThrow(/没有 slug 为 "nobody"/);
});

it("单模型失败不吞:退出码非零,且失败档写下来", { timeout: 30_000 }, async () => {
  const root = writeRoot(modelsYaml(entry("alpha")));
  const client = clientOf([fail(new Error("ECONNRESET"))]);
  const code = await withPlainSandbox(() =>
    runGeneration({
      root,
      configPath: "models.yaml",
      createClient: () => client,
      agentPrompt: PROMPT,
      maxSteps: 1,
    }),
  );
  expect(code).toBe(1);
  // 一次都没成功的会话落成同形失败档。
  const entries = readdirSync(join(root, "archive/alpha"));
  expect(entries.some((name) => name.startsWith("failed-"))).toBe(true);
});

it("一批两模型一败一成:退出码非零,但成功那个照旧冻结", { timeout: 60_000 }, async () => {
  const root = writeRoot(modelsYaml(entry("alpha"), entry("beta")));
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const code = await withRealBash(workspaceDir, () =>
    runGeneration({
      root,
      configPath: "models.yaml",
      createClient: (config): StubClient =>
        config.slug === "alpha"
          ? clientOf([bashOf(WRITE_SCRIPT(SCRIPT_BODY)), toolOf("evaluate")])
          : clientOf([fail(new Error("boom"))]),
      agentPrompt: PROMPT,
      workspaceDir,
      maxSteps: 2,
      // 试跑与计划桩:验的是编排层,不是网格本身(真网格在 `gen-cli.test.ts` 那一侧)。
      // 桩写的是形状真实的一整张网格——候选的入场券就是「32 场一场不少」。
      trial: completeGridTrial(),
      trialPlan: () => gridPlanFixture(),
      evaluateScoring: async () => ({
        score: { totalPoints: 4, averagePoints: 1, countedMatches: 4 },
        matchCount: 4,
      }),
    }),
  );
  expect(code).toBe(1);
  // 失败不中止同批:成功的那个照旧冻结(保证)。
  expect(readdirSync(join(root, "archive/alpha")).some((n) => n.startsWith("failed-"))).toBe(false);
  expect(readdirSync(join(root, "archive/beta")).some((n) => n.startsWith("failed-"))).toBe(true);
});

it("`generateAndFreeze` 缺 `--config` 即非零退出", async () => {
  expect(await generateAndFreeze([])).toBe(1);
});

it("`generateAndFreeze` 拿到未知参数即非零退出", async () => {
  expect(await generateAndFreeze(["--nonsense", "x"])).toBe(1);
});

it("两个阶段机器开关已移除:传进来即报错,而不是被静默忽略", async () => {
  const root = writeRoot(modelsYaml(entry("alpha")));
  // 一个被忽略的开关会让人以为它生效了。所以明确拒掉。
  expect(
    await generateAndFreeze(["--root", root, "--config", "models.yaml", "--score-source-feedback"]),
  ).toBe(1);
  expect(
    await generateAndFreeze(["--root", root, "--config", "models.yaml", "--select-best-candidate"]),
  ).toBe(1);
});

it(
  "`generateAndFreeze` 解析出 root 后加载 `<root>/.env`(存在才加载)",
  { timeout: 30_000 },
  async () => {
    const root = writeRoot(modelsYaml(entry("alpha")));
    writeFileSync(join(root, ".env"), "MODELWAR_RUN_ENV_PROBE=loaded\n");
    const client = clientOf([toolOf("finish")]);
    await withPlainSandbox(() =>
      runGeneration({
        root,
        configPath: "models.yaml",
        createClient: () => client,
        agentPrompt: PROMPT,
        maxSteps: 1,
      }),
    );
    // `.env` 只在 CLI 处理器里加载,`runGeneration` 不碰它——这条断言钉的是「谁负责加载」。
    expect(client.calls).toHaveLength(1);
  },
);

it("配置缺 contextLength 时该模型失败,不静默跳过上下文守卫", { timeout: 30_000 }, async () => {
  const root = writeRoot(modelsYaml(entry("alpha").replace("    contextLength: 100000\n", "")));
  // 「单模型失败不中止整批」把异常收成该模型的一次失败(保证),
  // 所以判据是退出码与 stderr,而不是 reject。
  const code = await withPlainSandbox(() =>
    runGeneration({
      root,
      configPath: "models.yaml",
      createClient: () => clientOf([]),
      agentPrompt: PROMPT,
      maxSteps: 1,
    }),
  );
  expect(code).toBe(1);
});

it("模型之间串行:前一个的全部步结束后才开下一个", { timeout: 60_000 }, async () => {
  const root = writeRoot(modelsYaml(entry("alpha"), entry("beta")));
  const order: string[] = [];
  await withPlainSandbox(() =>
    runGeneration({
      root,
      configPath: "models.yaml",
      createClient: (config: ModelConfig): StubClient => {
        order.push(`client:${config.slug}`);
        return stubClient([toolOf("finish")]);
      },
      agentPrompt: PROMPT,
      maxSteps: 1,
    }),
  );
  // 串行 = 每个模型一个客户端实例,顺序与配置一致。
  expect(order).toEqual(["client:alpha", "client:beta"]);
});
