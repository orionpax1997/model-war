/**
 * 外循环替换后的 `generateOneModel` 单测:**一个文件覆盖 loop 的全部终止分支**。
 *
 * ── 假的三样,真的一样 ──
 *
 * 模型(`stubClient`)、执行器、时钟都是假的;真的只有档案组装与落盘。所以这些用例不启动
 * bwrap、不联网,却能断言「发出去的到底是什么」「落下来的到底是什么」——那些断言都落在
 * `ModelOutcome` 与盘上那几份文件,不需要读实现的私有字段。
 *
 * ── 为什么这一整组都压在 `generateOneModel` 上,而不直接调 `runAgentSession` ──
 *
 * 票面的判据是「外循环被替换」,而那个替换只有站在**入口**这一侧才看得见:step 数等于协议
 * 轮数、`prompts` 只有一条、`steps[i].raw` 是原文、身份字段成套、零候选即失败档。`loop.ts`
 * 自己的单测钉的是它内部的分支;这里钉的是「那些分支接进档里之后长什么样」。
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
import {
  AGENT_ARCHIVE_REQUIRED_KEYS,
  ARCHIVE_SCHEMA_VERSION,
  TRIAL_MATCHES_PER_CANDIDATE,
  type ArchiveMeta,
} from "@model-war/schema";

import { fail, reply, replies, stubClient } from "./stub-client.js";
import { generateOneModel } from "./pipeline.js";
import { runGeneration, type GenerationRequest } from "./run.js";
import type { ModelConfig } from "./config.js";
import type { ChatMessage, ModelParams } from "./model-client.js";
import { HARNESS_DIGEST, HARNESS_VERSION } from "./agent/identity.js";
import { ACTION_REJECT_EXIT_CODE } from "./agent/action.js";
import { withHostBash, withRealBash } from "./agent/sandbox.fixture.js";
import type { AgentExecResult } from "./agent/types.js";
import { TRUNCATED_RESPONSE_FEEDBACK } from "./agent/truncate.js";
import { completeGridTrial } from "./trial-grid.fixture.js";
import { sha256Hex } from "./archive.js";
import { gridPlanFixture } from "./trial-plan.fixture.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "modelwar-agent-pipeline-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const FIRST_USER = "任务:/workspace 里写 script.ts";
const SYSTEM = "协议:每一步一个动作块";
const ACTION = "```bash\nls /contract\n```";

/** 一个合法的参赛脚本(有顶层 loop 入口,体积远小于上限)。 */
const SCRIPT = "function loop() {}\n";
const COMPILED = "function loop() {}\n";

/**
 * 造一个可用的安装根。
 *
 * 只造 `generateOneModel` 真的会读的东西:规则集(体积上限的真源)、契约目录(首条消息的来源,
 * 测试里注入 `agentPrompt` 就不读它,但 `check` 服务会读规则集)。`node_modules` 与 `packages`
 * 符号链接回仓库,因为 `check` / 冻结期校验要跑真 tsc 与真校验器。
 */
const mkRoot = (): string => {
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
  return root;
};

const configOf = (overrides: Partial<ModelConfig> = {}): ModelConfig => ({
  slug: "alpha",
  endpointFamily: "chat-completions",
  baseUrl: "https://example.invalid/v1",
  modelId: "vendor/alpha",
  credentialEnvVar: "TEST_KEY",
  channelId: "test-channel",
  contextLength: 100_000,
  ...overrides,
});

/**
 * 一句请求。
 *
 * `executor` 是假执行器(`pipeline` 正常会用真 bwrap,测试换掉它):这样「动作 → 观测」这一段
 * 可以在毫秒级钉住,而 `check` / `evaluate` 仍然走真的宿主服务(它们只读工作区与规则集)。
 */
/**
 * 一句请求。
 *
 * 时钟取**固定值**,于是档案的 `generatedAt` 可断言、`atMs` 是确定的。但「固定」不是「停在
 * 过去」:它必须是一个**当下**的时刻,否则宿主 dispatcher 的会话墙钟(`deadlineAtMs` =
 * 起点 + 1800s)在第一次工具调用时就已经到点,而那种失败会以「evaluate 被拒」的面目出现,
 * 与被测的行为毫无关系。
 */
const FIXED_NOW = new Date();

const requestWith = (
  root: string,
  input: Partial<GenerationRequest> & Pick<GenerationRequest, "createClient">,
): GenerationRequest => ({
  root,
  runId: "r1",
  now: () => FIXED_NOW,
  agentPrompt: { user: FIRST_USER, system: SYSTEM },
  // 试跑桩与计划桩:这些用例验的是 loop 与落档,不是网格本身(真网格在 `check:gen-grid` 与
  // `agent-real-session` 那一侧)。桩写的是**形状真实**的一整张网格(32 行观测 + 旁挂汇总):
  // 「跑满一场不少」是候选的入场券,写空会把这些用例变成在验一条不存在的路径。
  trial: completeGridTrial(),
  trialPlan: () => gridPlanFixture(),
  ...input,
});

/** 一步的假执行结果。 */
const stepOk = (overrides: Partial<AgentExecResult> = {}): AgentExecResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  ...overrides,
});

const metaOf = (root: string, slug = "alpha", runId = "r1"): ArchiveMeta =>
  JSON.parse(readFileSync(join(root, "archive", slug, runId, "meta.json"), "utf8")) as ArchiveMeta;

it("顺利路径:有候选就是成功档,step 数 = 协议轮数,首条 prompt 只存一份", async () => {
  const root = mkRoot();
  // 两步:第一步写脚本,第二步 evaluate 出成绩。
  const model = stubClient([
    reply("```bash\ncat > /workspace/script.ts <<'EOF'\nfunction loop() {}\nEOF\n```"),
    reply("```bash\nevaluate\n```"),
  ]);
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const outcome = await withRealBash(workspaceDir, () =>
    generateOneModel(
      requestWith(root, {
        createClient: () => model,
        workspaceDir,
        // 成绩走**缺省**评分:真网格那一支从旁挂 `.grid.json` 读，所以这条链上的分数
        // 来源与生产同一条(试跑本身是假网格)。
      }),
      configOf(),
    ),
  );

  expect(outcome.kind).toBe("frozen");
  const meta = metaOf(root);
  expect(meta.archiveSchemaVersion).toBe(ARCHIVE_SCHEMA_VERSION);
  // step = 一次模型调用;协议轮数就是它。
  expect(meta.steps).toHaveLength(2);
  expect(meta.protocolRounds).toBe(2);
  // 首条 prompt 只有一份(不是每步一份)。
  expect(meta.prompts).toEqual([FIRST_USER]);
  // 它装的是首条 `user` 的逐字文本:`system` 是协议,不进档案(归 harnessVersion / harnessDigest),
  // 否则同一份字节就有两个家。
  expect(meta.prompts[0]).not.toContain(SYSTEM);
  // 身份字段成套(ADR-0034「身份从第一份 agent 档起就写」)。
  expect(meta.harnessVersion).toBe(HARNESS_VERSION);
  expect(meta.harnessDigest).toBe(HARNESS_DIGEST);
  expect(meta.contextLength).toBe(100_000);
  for (const key of AGENT_ARCHIVE_REQUIRED_KEYS) {
    expect(meta).toHaveProperty(key);
  }
  // 候选只有一个:evaluate 产出的那一次,步号就是那一步。
  expect(meta.optimization).toMatchObject({ version: 3 });
  const candidates = (meta.optimization as unknown as { candidates: { step: number }[] })
    .candidates;
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.step).toBe(2);
});

it("模型原文落 steps[i].raw,且与发回去的字节同源", async () => {
  const root = mkRoot();
  // 三步:写脚本 → evaluate(出成绩) → done。中间那一步让档落得下来,于是 `steps` 可读。
  const script = "function loop() {}\n";
  const write = `\`\`\`bash\ncat > /workspace/script.ts <<'EOF'\n${script}EOF\n\`\`\``;
  const sent: string[][] = [];
  const stub = stubClient([
    reply(write),
    reply("```bash\nevaluate\n```"),
    reply("```bash\ndone\n```"),
  ]);
  const recording = {
    calls: stub.calls,
    send: async (messages: readonly ChatMessage[], params: ModelParams) => {
      sent.push(messages.map((message) => message.content));
      return stub.send(messages, params);
    },
  };
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  await withRealBash(workspaceDir, () =>
    generateOneModel(
      requestWith(root, {
        createClient: () => recording,
        workspaceDir,
      }),
      configOf(),
    ),
  );

  const meta = metaOf(root);
  // 原文逐字节 = 模型写的那一段,不是解析后的命令。
  expect(meta.steps?.[0]?.raw).toBe(write);
  expect(meta.steps?.[0]?.action).toEqual({
    kind: "bash",
    command: `cat > /workspace/script.ts <<'EOF'\n${script}EOF`,
  });
  // 第二步的历史里,assistant 那一条就是第一步的原文(一个字节都不改写)。
  expect(sent[1]?.[2]).toBe(write);
});

it("零候选即失败档:done 收工但从未 evaluate,档的形状与成功档同键集合", async () => {
  const root = mkRoot();
  const model = stubClient([reply(ACTION), reply("```bash\ndone\n```")]);
  const outcome = await withHostBash(
    () => stepOk(),
    () => generateOneModel(requestWith(root, { createClient: () => model }), configOf()),
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  expect(outcome.failure.classification).toBe("contract");
  expect(outcome.failure.prompts).toEqual([]);
  expect(outcome.agent.termination).toBe("done");
  expect(outcome.agent.atStep).toBe(2);
  expect(outcome.agent.steps).toHaveLength(2);
  // 一个候选都没有:优化段缺席(不是「空的 candidates」)。
  expect(existsSync(join(root, "archive/alpha/r1/meta.json"))).toBe(false);
});

it("步数耗尽:max-steps,步号等于上限,协议轮数等于步数", async () => {
  const root = mkRoot();
  const model = stubClient(replies([ACTION, ACTION, ACTION]));
  const outcome = await withHostBash(
    () => stepOk(),
    () =>
      generateOneModel(requestWith(root, { createClient: () => model, maxSteps: 2 }), configOf()),
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  expect(outcome.agent.termination).toBe("max-steps");
  expect(outcome.agent.atStep).toBe(2);
  expect(outcome.agent.steps).toHaveLength(2);
  expect(model.calls).toHaveLength(2);
});

it("动作解析失败三次即停:每一步都是非零退出码,一条命令都没跑", async () => {
  const root = mkRoot();
  const model = stubClient([reply("只说不动"), reply("```ts\nx\n```"), reply("")]);
  const commands: string[] = [];
  const outcome = await withHostBash(
    (command) => {
      commands.push(command);
      return stepOk();
    },
    () => generateOneModel(requestWith(root, { createClient: () => model }), configOf()),
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  expect(outcome.agent.termination).toBe("action-parse");
  expect(outcome.agent.atStep).toBe(3);
  expect(commands).toHaveLength(0);
  for (const step of outcome.agent.steps) {
    expect(step.action).toEqual({ kind: "none" });
    expect(step.exitCode).toBe(ACTION_REJECT_EXIT_CODE);
  }
});

it("传输耗尽:那次调用不进 steps、不进协议轮数,生成日志留一条传输末行", async () => {
  const root = mkRoot();
  const model = stubClient([reply(ACTION), fail(new Error("ECONNRESET"))]);
  const outcome = await withHostBash(
    () => stepOk(),
    () => generateOneModel(requestWith(root, { createClient: () => model }), configOf()),
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  expect(outcome.failure.classification).toBe("transport");
  expect(outcome.agent.termination).toBe("transport");
  // 已跑完的那一步留着,死掉的那一次不在。
  expect(outcome.agent.steps).toHaveLength(1);
  expect(outcome.agent.atStep).toBe(1);
  // 传输末行仍在日志里,但轮数是已收敛的两条中的一条。
  const kinds = outcome.failure.generationLog.map(
    (line) => (JSON.parse(line) as { kind: string }).kind,
  );
  expect(kinds).toEqual(["converged", "transport"]);
});

it("传输耗尽在第一步:零步会话的 prompts 为空、steps 为空", async () => {
  const root = mkRoot();
  const model = stubClient([fail(new Error("ECONNRESET"))]);
  const outcome = await withHostBash(
    () => stepOk(),
    () => generateOneModel(requestWith(root, { createClient: () => model }), configOf()),
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  expect(outcome.agent.steps).toEqual([]);
  expect(outcome.agent.atStep).toBe(0);
  // 写盘时 prompts 由公式推得:零步 → 空数组。
  expect(outcome.failure.prompts).toEqual([]);
});

it("截断重试并入同一步:第二次成功就照常执行,attempts 记 2,日志仍一行", async () => {
  const root = mkRoot();
  const model = stubClient([
    reply("```bash\nls /contract", { finishReason: "length" }),
    reply(ACTION),
  ]);
  const outcome = await withHostBash(
    () => stepOk({ stdout: "README.md\n" }),
    () =>
      generateOneModel(requestWith(root, { createClient: () => model, maxSteps: 1 }), configOf()),
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  expect(outcome.agent.steps).toHaveLength(1);
  expect(outcome.agent.steps[0]?.stdout).toBe("README.md\n");
  const log = JSON.parse(outcome.failure.generationLog[0]!) as {
    attempts: number;
    round: number;
  };
  expect(log.attempts).toBe(2);
  expect(log.round).toBe(1);
  // 两次调用挂同一步。
  expect(outcome.failure.generationLog).toHaveLength(1);
});

it("截断重试的证据按步聚合:该步日志行装两条 attempts,两枪各就各位", async () => {
  const root = mkRoot();
  // 三步:写脚本 → evaluate(第一枪截断、第二枪成功) → done。
  //
  // 这是「一次 send 的桶 ≠ 一行日志」那条接缝:该步有**两次** send,而日志仍只有一行。
  // 旧写法按下标取,第二行会拿到第一步的证据、第二枪丢掉(ADDR-0032:同一步的第二个 attempt,
  // `generationLog` 一行、`attempts` 两条)。
  const model = stubClient([
    reply(writeScript(SCRIPT)),
    reply("```bash\nls /contract", { finishReason: "length" }),
    reply("```bash\nevaluate\n```"),
    reply("```bash\ndone\n```"),
  ]);
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const outcome = await withRealBash(workspaceDir, () =>
    generateOneModel(
      requestWith(root, { createClient: () => model, workspaceDir, maxSteps: 4 }),
      configOf(),
    ),
  );

  expect(outcome.kind).toBe("frozen");
  if (outcome.kind !== "frozen") return;
  // 重试不占步:三步就是三步,协议轮数也还是三。
  expect(outcome.meta.steps).toHaveLength(3);
  expect(outcome.meta.protocolRounds).toBe(3);
  expect(outcome.meta.generationLog).toHaveLength(3);

  const logs = outcome.meta.generationLog.map(
    (line) =>
      JSON.parse(line) as {
        round: number;
        attempts: number;
        attemptEvidence: { attempt: number; finishReason?: string }[];
      },
  );
  // 行号 = 步号,一行一步。
  expect(logs.map((log) => log.round)).toEqual([1, 2, 3]);
  expect(logs.map((log) => log.attempts)).toEqual([1, 2, 1]);
  // 截断那一步的两枪都在这一行里,且先后到位(读侧按下标校验 1..n)。
  expect(logs[1]?.attemptEvidence.map((item) => item.attempt)).toEqual([1, 2]);
  expect(logs[1]?.attemptEvidence.map((item) => item.finishReason)).toEqual(["length", "stop"]);
  // 另外两步各一枪,不会舋到截断那一步的证据。
  expect(logs[0]?.attemptEvidence.map((item) => item.finishReason)).toEqual(["stop"]);
  expect(logs[2]?.attemptEvidence.map((item) => item.finishReason)).toEqual(["stop"]);
}, 60_000);

it("第二次仍截断:转格式反馈,不执行任何命令", async () => {
  const root = mkRoot();
  const model = stubClient([
    reply("```bash\nls", { finishReason: "length" }),
    reply("```bash\nls", { finishReason: "length" }),
  ]);
  const commands: string[] = [];
  const outcome = await withHostBash(
    (command) => {
      commands.push(command);
      return stepOk();
    },
    () =>
      generateOneModel(requestWith(root, { createClient: () => model, maxSteps: 1 }), configOf()),
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  expect(commands).toHaveLength(0);
  expect(outcome.agent.steps[0]?.stderr).toBe(TRUNCATED_RESPONSE_FEEDBACK);
});

it("上下文守卫:上一轮读数到窗口 80% 就停,下一步不发出", async () => {
  const root = mkRoot();
  const model = stubClient([reply(ACTION, { usage: { prompt_tokens: 80_000 } }), reply(ACTION)]);
  const outcome = await withHostBash(
    () => stepOk(),
    () =>
      generateOneModel(
        requestWith(root, { createClient: () => model }),
        configOf({ contextLength: 100_000 }),
      ),
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  expect(outcome.agent.termination).toBe("context");
  expect(outcome.agent.atStep).toBe(1);
  expect(model.calls).toHaveLength(1);
});

it("总墙钟耗尽:已跑完的步留着,不判失败(终止与落档正交)", async () => {
  const root = mkRoot();
  let elapsed = 0;
  const model = stubClient(replies([ACTION, ACTION, ACTION, ACTION]));
  const outcome = await withHostBash(
    () => {
      elapsed += 600;
      return stepOk();
    },
    () =>
      generateOneModel(
        requestWith(root, {
          createClient: () => model,
          totalWallClockMs: 1_000,
          now: () => {
            elapsed += 10;
            return new Date(1_000 + elapsed);
          },
        }),
        configOf(),
      ),
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  expect(outcome.agent.termination).toBe("wall-clock");
  // 走完的那几步仍在过程记录里。
  expect(outcome.agent.steps.length).toBeGreaterThan(0);
});

it("配额拒绝模型看得见:第 4 次 evaluate 被 dispatcher 拒掉,stderr 进观测", async () => {
  const root = mkRoot();
  const model = stubClient(replies([ACTION, ACTION, ACTION, ACTION, "```bash\ndone\n```"]));
  const seen: string[] = [];
  const outcome = await withHostBash(
    () => {
      // 真宿主服务跑真配额:前三次拒绝(脚本还没写出来),第四次必须被配额挡。
      return stepOk();
    },
    () =>
      generateOneModel(requestWith(root, { createClient: () => model, maxSteps: 5 }), configOf()),
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  void seen;
  // 五次调用全发生(dispatcher 的拒绝不是 loop 的终止原因)。
  expect(model.calls).toHaveLength(5);
});

it("步骤的 atMs 是相对偏移,harnessMs 覆盖沙箱执行", async () => {
  const root = mkRoot();
  let clock = 0;
  const model = stubClient([reply(ACTION), reply(ACTION)]);
  const outcome = await withHostBash(
    () => {
      clock += 50;
      return stepOk();
    },
    () =>
      generateOneModel(
        requestWith(root, {
          createClient: () => model,
          maxSteps: 2,
          now: () => new Date(1_000_000 + clock),
        }),
        configOf(),
      ),
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  const [first, second] = outcome.agent.steps;
  expect(first?.atMs).toBe(0);
  expect(second?.atMs).toBeGreaterThan(0);
  // 沙箱执行 50ms:harnessMs 至少覆盖它。
  expect(first?.harnessMs).toBeGreaterThanOrEqual(50);
});

it("候选序的条数就是真评出成绩的 evaluate 次数(一到三条)", async () => {
  const root = mkRoot();
  const script = "function loop() {}\n";
  const write = `\`\`\`bash\ncat > /workspace/script.ts <<'EOF'\n${script}EOF\n\`\`\``;
  const model = stubClient([
    reply(write),
    reply("```bash\nevaluate\n```"),
    reply("```bash\nevaluate\n```"),
  ]);
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const outcome = await withRealBash(workspaceDir, () =>
    generateOneModel(
      requestWith(root, {
        createClient: () => model,
        workspaceDir,
        maxSteps: 3,
        evaluateScoring: async (submission) => ({
          score: {
            totalPoints: submission.call,
            averagePoints: 0.25,
            countedMatches: TRIAL_MATCHES_PER_CANDIDATE,
          },
          matchCount: TRIAL_MATCHES_PER_CANDIDATE,
        }),
      }),
      configOf(),
    ),
  );

  expect(outcome.kind).toBe("frozen");
  if (outcome.kind !== "frozen") return;
  const candidates = (outcome.meta.optimization as unknown as { candidates: unknown[] }).candidates;
  // 三次调用里有两次是 evaluate:候选序两条,下标即第几次评测。
  expect(candidates).toHaveLength(2);
});

it("唯一入口与调用计数:步数为 N 时模型被调 N 次、沙箱执行 N 次", async () => {
  const root = mkRoot();
  const model = stubClient(replies([ACTION, ACTION, ACTION]));
  let sandboxCalls = 0;
  await withHostBash(
    () => {
      sandboxCalls += 1;
      return stepOk();
    },
    () =>
      generateOneModel(requestWith(root, { createClient: () => model, maxSteps: 3 }), configOf()),
  );

  expect(sandboxCalls).toBe(3);
  expect(model.calls).toHaveLength(3);
});

it("配置缺 contextLength 就在请求前拒绝(守卫不能静默跳过)", async () => {
  const root = mkRoot();
  let calls = 0;
  const model = {
    send: async () => {
      calls += 1;
      return { text: ACTION, finishReason: "stop", usage: {} };
    },
  };
  await expect(
    generateOneModel(
      requestWith(root, { createClient: () => model }),
      // 刻意造一个缺 contextLength 的配置(而不是改类型:那条判据就是「配置可能缺它」)。
      { ...configOf(), contextLength: undefined } as unknown as ModelConfig,
    ),
  ).rejects.toThrow(/缺 contextLength/);
  expect(calls).toBe(0);
});

it("没有引用的候选条目不写(候选序只装真评出成绩的)", async () => {
  const root = mkRoot();
  const model = stubClient([reply("```bash\nevaluate\n```")]);
  const outcome = await withHostBash(
    () => stepOk(),
    () =>
      generateOneModel(
        requestWith(root, {
          createClient: () => model,
          maxSteps: 1,
          // 一次 `evaluate` 都没写脚本:提交被服务当场拒掉(不是「评了但零分」)。
        }),
        configOf(),
      ),
  );
  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  expect(outcome.agent.termination).toBe("max-steps");
});

it("一条 `done` 在块中:`done` 之前的命令照跑,action 记 done", async () => {
  const root = mkRoot();
  const model = stubClient([reply("```bash\nls /contract\ndone\necho 不该跑\n```")]);
  const commands: string[] = [];
  const outcome = await withHostBash(
    (command) => {
      commands.push(command);
      // 这一块真跑了一个命令:它自己的退出码要原样落进过程记录(不是被 done 改成 0)。
      return stepOk({ done: true, exitCode: 3 });
    },
    () => generateOneModel(requestWith(root, { createClient: () => model }), configOf()),
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  expect(outcome.agent.termination).toBe("done");
  // 块被切开:执行的是 done 之前那半段。
  expect(commands[0]).toBe("ls /contract");
  expect(outcome.agent.steps[0]?.action).toEqual({ kind: "done" });
  // 有前置命令就是一次真的执行:退出码是命令自己的那个。
  expect(outcome.agent.steps[0]?.exitCode).toBe(3);
});

it("`done` 独占一块:不起 shell,退出码记 0(不是「起了一次空 bash」)", async () => {
  // 切完 body 为空就不该起进程:那一步什么都没执行,过程记录里那格就该是 0。
  // 反面证据由替身给:它一律报 7——真的把空命令交给它跑,这个 0 就变不成。
  const root = mkRoot();
  const model = stubClient([reply("```bash\ndone\n```")]);
  let ran = 0;
  const outcome = await withHostBash(
    () => {
      ran += 1;
      return stepOk({ exitCode: 7, stdout: "不该跑到\n" });
    },
    () =>
      generateOneModel(requestWith(root, { createClient: () => model, maxSteps: 1 }), configOf()),
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  expect(ran).toBe(0);
  expect(outcome.agent.steps[0]?.action).toEqual({ kind: "done" });
  expect(outcome.agent.steps[0]?.exitCode).toBe(0);
  expect(outcome.agent.steps[0]?.stdout).toBe("");
});

it("runGeneration 写失败档:agent 字段与 steps 一起落盘", async () => {
  const root = mkRoot();
  const model = stubClient([reply(ACTION), fail(new Error("ECONNRESET"))]);
  writeFileSync(
    join(root, "models.yaml"),
    [
      "models:",
      "  - slug: alpha",
      "    endpointFamily: chat-completions",
      "    baseUrl: https://example.invalid/v1",
      "    modelId: vendor/alpha",
      "    credentialEnvVar: TEST_KEY",
      "    channelId: test-channel",
      "    contextLength: 100000",
    ].join("\n"),
  );
  const code = await withHostBash(
    () => stepOk(),
    () =>
      runGeneration({
        root,
        configPath: "models.yaml",
        createClient: () => model,
        agentPrompt: { user: FIRST_USER, system: SYSTEM },
        maxSteps: 3,
      }),
  );

  expect(code).toBe(1);
  // `runGeneration` 的 runId 取自当下时刻(时间戳形态),所以按前缀找那份失败档。
  const failureName = readdirSync(join(root, "archive/alpha")).find((name) =>
    name.startsWith("failed-"),
  );
  expect(failureName).toBeDefined();
  const failurePath = join(root, "archive/alpha", failureName!);
  const record = JSON.parse(readFileSync(failurePath, "utf8")) as {
    archiveSchemaVersion: number;
    steps: unknown[];
    protocolRounds: number;
    prompts: string[];
    termination: string;
    harnessDigest: string;
  };
  expect(record.archiveSchemaVersion).toBe(ARCHIVE_SCHEMA_VERSION);
  expect(record.steps).toHaveLength(1);
  expect(record.protocolRounds).toBe(1);
  expect(record.prompts).toEqual([FIRST_USER]);
  expect(record.termination).toBe("transport");
  expect(record.harnessDigest).toBe(HARNESS_DIGEST);
  void COMPILED;
  void SCRIPT;
});

/** 一条「把脚本写进 /workspace」的动作块（heredoc：模型在沙箱里写文件的自然写法）。 */
const writeScript = (body: string): string =>
  `\`\`\`bash\ncat > /workspace/script.ts <<'EOF'\n${body}EOF\n\`\`\``;

/** 候选序里的三条候选（档案里唯一允许的 1..3 区间）。 */
const candidatesOf = (meta: ArchiveMeta) =>
  (meta.optimization as unknown as { candidates: readonly Record<string, unknown>[] }).candidates;

/** 一次会话：写脚本 N 次、每次之后 evaluate，最后 done；`scripts[i]` 是第 i 次评测时的字节。 */
const sessionOf = (scripts: readonly string[]): readonly string[] =>
  scripts
    .flatMap((script) => [writeScript(script), "```bash\nevaluate\n```"])
    .concat(["```bash\ndone\n```"]);

it("freeze 失败也清干净:`archive/<slug>/` 里只剩那一份 failed-<runId>.json", async () => {
  const root = mkRoot();
  // 把冻结期的体积上限压到 8 字节:评测能过(编译与网格都不看这个上限),静态校验必拦。
  // 这就是一条真会发生的 freeze 失败:候选快照已经落盘,三件套却拼不出来。
  const ruleset = JSON.parse(readFileSync(join(root, "rulesets", "v2.json"), "utf8")) as Record<
    string,
    unknown
  >;
  writeFileSync(
    join(root, "rulesets", "v2.json"),
    `${JSON.stringify({ ...ruleset, scriptSizeLimit: 8 })}\n`,
  );
  writeFileSync(
    join(root, "models.yaml"),
    [
      "models:",
      "  - slug: alpha",
      "    endpointFamily: chat-completions",
      "    baseUrl: https://example.invalid/v1",
      "    modelId: vendor/alpha",
      "    credentialEnvVar: TEST_KEY",
      "    channelId: test-channel",
      "    contextLength: 100000",
    ].join("\n"),
  );
  const model = stubClient([reply(writeScript(SCRIPT)), reply("```bash\nevaluate\n```")]);
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const code = await withRealBash(workspaceDir, () =>
    runGeneration({
      root,
      configPath: "models.yaml",
      createClient: () => model,
      agentPrompt: { user: FIRST_USER, system: SYSTEM },
      workspaceDir,
      maxSteps: 2,
      trial: completeGridTrial(),
      trialPlan: () => gridPlanFixture(),
    }),
  );

  expect(code).toBe(1);
  // 发布不变量:「失败只写 failed-<runId>.json」。候选快照、观测原料、网格汇总一个不留,
  // 临时组装目录也不留(它是 `.tmp-*`)。
  const entries = readdirSync(join(root, "archive/alpha"));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatch(/^failed-.+\.json$/u);
}, 60_000);

it("候选一到三条:1 次 / 2 次 / 3 次评测各产出同等条数,下标即第几次评测", async () => {
  for (const count of [1, 2, 3] as const) {
    const root = mkRoot();
    const scripts = Array.from(
      { length: count },
      (_, index) => `var ticks = ${String(index)};\nfunction loop() {}\n`,
    );
    const model = stubClient(sessionOf(scripts).map((text) => reply(text)));
    const workspaceDir = join(root, "ws");
    mkdirSync(workspaceDir, { recursive: true });
    const outcome = await withRealBash(workspaceDir, () =>
      generateOneModel(
        requestWith(root, { createClient: () => model, workspaceDir, maxSteps: count * 2 + 1 }),
        configOf(),
      ),
    );

    expect(outcome.kind, `${String(count)} 次评测应有候选`).toBe("frozen");
    if (outcome.kind !== "frozen") return;
    const candidates = candidatesOf(outcome.meta);
    expect(candidates).toHaveLength(count);
    // 有候选即成功档:优化段 version 3、一条 `stage` 都没有(ADR-0031)。
    expect(outcome.meta.optimization).toMatchObject({ version: 3 });
    for (const [index, candidate] of candidates.entries()) {
      expect(candidate.stage).toBeUndefined();
      // 步号 = 那次 evaluate 的那一步(写脚本一步 + 评测一步,所以是 2,4,6)。
      expect(candidate.step).toBe((index + 1) * 2);
      expect(candidate.scriptFile).toBe(`${String(candidate.observationsFile)}.candidate.js`);
      expect(String(candidate.observationsFile)).toBe(
        `observed-r1-round-${String((index + 1) * 2)}.jsonl`,
      );
      expect(candidate.matchCount).toBe(TRIAL_MATCHES_PER_CANDIDATE);
    }
    // 快照三件套都在档案目录里。
    for (const candidate of candidates) {
      for (const name of [
        String(candidate.observationsFile),
        `${String(candidate.observationsFile)}.grid.json`,
        String(candidate.scriptFile),
        `${String(candidate.observationsFile)}.candidate.ts`,
      ])
        expect(existsSync(join(root, "archive/alpha", name)), name).toBe(true);
    }
  }
}, 60_000);

it("第 4 次 evaluate 被宿主配额拒掉、不执行:候选仍是三条", async () => {
  const root = mkRoot();
  const scripts = [
    "var a = 0;\nfunction loop() {}\n",
    "var b = 0;\nfunction loop() {}\n",
    "var c = 0;\nfunction loop() {}\n",
    "var d = 0;\nfunction loop() {}\n",
  ];
  const model = stubClient(sessionOf(scripts).map((text) => reply(text)));
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const outcome = await withRealBash(workspaceDir, () =>
    generateOneModel(
      requestWith(root, { createClient: () => model, workspaceDir, maxSteps: 10 }),
      configOf(),
    ),
  );

  expect(outcome.kind).toBe("frozen");
  if (outcome.kind !== "frozen") return;
  // 三次评测是**上限**:第四次被拒,所以候选仍是三条(不是四条)。
  expect(candidatesOf(outcome.meta)).toHaveLength(3);
  // 被拒的那一步记成 evaluate(动作种类归解析层,配额拒绝是宿主侧的结论),且模型看得见原因。
  const rejected = outcome.meta.steps?.filter((step) => step.action.kind === "evaluate") ?? [];
  expect(rejected).toHaveLength(4);
  expect(rejected[3]?.exitCode).not.toBe(0);
  expect(rejected[3]?.stderr).toContain("评测额度已用完");
  // 被拒那一步没有产出任何证据族文件(不执行 = 不落盘)。
  expect(existsSync(join(root, "archive/alpha", "observed-r1-round-8.jsonl"))).toBe(false);
}, 60_000);

it("观测不完整不产候选:缺场的那一次不产出成绩,档落成失败档", async () => {
  const root = mkRoot();
  const model = stubClient(sessionOf(["function loop() {}\n"]).map((text) => reply(text)));
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const outcome = await withRealBash(workspaceDir, () =>
    generateOneModel(
      requestWith(root, {
        createClient: () => model,
        workspaceDir,
        maxSteps: 3,
        // 只写 28 行:缺的 4 场不许补零,也不许产出候选。
        trial: completeGridTrial({ matches: 28 }),
      }),
      configOf(),
    ),
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  // 零候选 = 失败档,但会话本身跑完了(终止原因与落档正交)。
  expect(outcome.agent.termination).toBe("done");
  expect(outcome.failure.message).toContain("没有产出任何候选");
  // 「为什么没成绩」写得出来:缺场那一句在诊断里(取自那次 evaluate 的 stderr)。
  expect(outcome.failure.diagnostics.join("\n")).toContain("不完整");
  expect(existsSync(join(root, "archive/alpha/r1/meta.json"))).toBe(false);
  // 失败会话不留旁挂产物:那一跑写过一整套候选证据族(先编译、先落快照、跑网格),全部撤掉。
  expect(readdirSync(join(root, "archive/alpha"))).toEqual([]);
}, 60_000);

it("快照字节 == 评估时的工作区字节:评完之后改文件不影响成绩", async () => {
  const root = mkRoot();
  const first = "var first = 1;\nfunction loop() {}\n";
  const second = "var second = 2;\nfunction loop() {}\n";
  // 两次评测之后**再改一次文件**,然后 done:那次改动不进任何候选。
  const model = stubClient([
    reply(writeScript(first)),
    reply("```bash\nevaluate\n```"),
    reply(writeScript(second)),
    reply("```bash\nevaluate\n```"),
    reply(writeScript("var broken = ;\n")),
    reply("```bash\ndone\n```"),
  ]);
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const outcome = await withRealBash(workspaceDir, () =>
    generateOneModel(
      requestWith(root, { createClient: () => model, workspaceDir, maxSteps: 6 }),
      configOf(),
    ),
  );

  expect(outcome.kind).toBe("frozen");
  if (outcome.kind !== "frozen") return;
  const candidates = candidatesOf(outcome.meta);
  expect(candidates).toHaveLength(2);
  const archiveDir = join(root, "archive/alpha");
  const sourceOf = (index: number): string =>
    readFileSync(
      join(archiveDir, `${String(candidates[index]!.observationsFile)}.candidate.ts`),
      "utf8",
    );
  // 第一条快照是第一次评测时那份字节,第二条是第二次的——会话末尾那次改动没有进它们。
  expect(sourceOf(0)).toBe(first);
  expect(sourceOf(1)).toBe(second);
  // 胜者取末位候选:冻结的三件套就是第二条那份字节(有测试钉住「评完之后又改过不影响成绩」)。
  expect(readFileSync(join(archiveDir, "r1/script.ts"), "utf8")).toBe(second);
  expect(
    readFileSync(join(archiveDir, "r1/script.js")).equals(
      readFileSync(join(archiveDir, String(candidates[1]!.scriptFile))),
    ),
  ).toBe(true);
}, 60_000);

it("meta.scriptSha256 等于末位候选的产物哈希(胜者取末位,不是某一版的源哈希)", async () => {
  const root = mkRoot();
  const model = stubClient(
    sessionOf(["var a = 1;\nfunction loop() {}\n", "var b = 2;\nfunction loop() {}\n"]).map(
      (text) => reply(text),
    ),
  );
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  const outcome = await withRealBash(workspaceDir, () =>
    generateOneModel(
      requestWith(root, { createClient: () => model, workspaceDir, maxSteps: 5 }),
      configOf(),
    ),
  );

  expect(outcome.kind).toBe("frozen");
  if (outcome.kind !== "frozen") return;
  const candidates = candidatesOf(outcome.meta);
  expect(candidates).toHaveLength(2);
  const final = candidates[candidates.length - 1]!;
  expect(outcome.meta.scriptSha256).toBe(final.scriptSha256);
  // 冻结的 script.js 字节就是那份产物(复算认编译产物,不认 script.ts)。
  expect(sha256Hex(readFileSync(join(root, "archive/alpha/r1/script.js")))).toBe(
    final.scriptSha256,
  );
  // 且与首条候选不同(否则这条断言证明不了「取末位」)。
  expect(final.scriptSha256).not.toBe(candidates[0]?.scriptSha256);
}, 60_000);

it("计划与现场事实不符即 infra:会话大声失败,不把环境故障解释成模型手滑", async () => {
  const root = mkRoot();
  const model = stubClient([
    reply(writeScript(SCRIPT)),
    reply("```bash\nevaluate\n```"),
    reply("```bash\ndone\n```"),
  ]);
  const workspaceDir = join(root, "ws");
  mkdirSync(workspaceDir, { recursive: true });
  // 试跑入口在 infra 上抛错(计划重建不符 / 子进程异常):那是环境的事,不是候选的错。
  await expect(
    withRealBash(workspaceDir, () =>
      generateOneModel(
        requestWith(root, {
          createClient: () => model,
          workspaceDir,
          maxSteps: 3,
          trial: () => {
            throw new Error("试跑子进程异常退出（码 2）：预期试跑计划与现场事实不符");
          },
        }),
        configOf(),
      ),
    ),
    // 消息里带着那一步与原因:infra 不能变成一条「模型写错了」的观测。
  ).rejects.toThrow(/第 2 步的评测基础设施失败.*计划与现场事实不符/su);
  // 没有落成功档,也没有落失败档:这一场会话的结论由 orchestration 记为 infra。
  expect(existsSync(join(root, "archive/alpha/r1/meta.json"))).toBe(false);
}, 60_000);

it("一次 evaluate 都不做的会话不搬计划:网格不是入场费", async () => {
  const root = mkRoot();
  const model = stubClient([reply("```bash\nls /contract\n```"), reply("```bash\ndone\n```")]);
  let planned = 0;
  const outcome = await withHostBash(
    () => stepOk(),
    () =>
      generateOneModel(
        requestWith(root, {
          createClient: () => model,
          // 计划装载会 spawn 一次试跑入口;没有 evaluate 的会话不该付这笔钱,
          // 也不该因为「搬不动计划」而整场失败(那会把一次没用到网格的会话也赔进去)。
          trialPlan: () => {
            planned += 1;
            return gridPlanFixture();
          },
        }),
        configOf(),
      ),
  );

  expect(planned).toBe(0);
  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  expect(outcome.agent.termination).toBe("done");
});
