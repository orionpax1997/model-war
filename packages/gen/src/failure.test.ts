/**
 * 失败路径的对外可观察行为(契约 §3;CONTEXT.md《校验失败记录》)。
 *
 * 断言对象只有**写出的文件与字节、退出码、失败记录的内容**:`failed-<runId>.json` 的形状、
 * 不建存档目录、多模型串行、`--model` 单跑。桩(`stubClient`)是唯一注入缝,离线可跑。
 *
 * ── v3 失败档与 one-shot 那条的根本差别 ──
 *
 * 轮数与起始 prompt 不再由 `prompts` 数出来:它们由**过程记录**与首条消息推得(ADR-0031 的
 * 同一个公式)。所以这里的判据是「`steps.length === protocolRounds`、`prompts` 至多一条」,
 * 而不是「每轮一条 prompt」。
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
import { AGENT_ARCHIVE_REQUIRED_KEYS, RULESET_VERSION } from "@model-war/schema";
import { afterAll, expect, it } from "vitest";
import type { ChatMessage, ModelClient, ModelParams, ModelResponse } from "./model-client.js";
import { buildFailureRecord } from "./failure.js";
import { runGeneration } from "./run.js";
import { fail, replies, stubClient } from "./stub-client.js";
import type { AgentPrompt } from "./agent-prompt.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "modelwar-failure-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PROMPT: AgentPrompt = { user: "任务:写 script.ts", system: "协议:每一步一个动作块" };
const ACTION = "```bash\nls /contract\n```";

/** 把仓库的安装面(编译与校验的依赖)接进临时根(`--root` 在真实使用里就是安装根)。 */
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

/** 造一个临时根:安装面 + `models.yaml`(契约正文不进首条消息,所以不需要 docs/)。 */
const writeRoot = (modelsYaml: string): string => {
  const root = mkdtempSync(join(scratch, "root-"));
  installRuntime(root);
  writeFileSync(join(root, "models.yaml"), modelsYaml);
  return root;
};

/** 一条模型条目。`contextLength` 必填(agent 形态的守卫需要窗口大小)。 */
const entry = (slug: string, extra: readonly string[] = []): readonly string[] => [
  `  - slug: ${slug}`,
  "    endpointFamily: chat-completions",
  "    baseUrl: https://example.test/v1",
  `    modelId: provider/${slug}`,
  "    credentialEnvVar: GEN_TEST_KEY",
  "    channelId: gen-test-channel",
  "    contextLength: 100000",
  ...extra,
];

const configOf = (...entries: readonly (readonly string[])[]): string =>
  ["models:", ...entries.flat()].join("\n") + "\n";

/** 只读目录里的唯一那条文件名(多于 / 少于一条即抛,避免测试里写非空断言)。 */
const onlyEntry = (dir: string): string => {
  const entries = readdirSync(dir);
  if (entries.length !== 1) {
    throw new Error(`期望 ${dir} 下恰好一项,收到 ${JSON.stringify(entries)}`);
  }
  return entries[0] as string;
};

/** 读一条失败记录(路径由文件名给全)。 */
const readRecord = (dir: string, name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;

/** 只回空输出的沙箱替身:这些用例验的是编排层落盘,不是沙箱里发生了什么。 */
const withPlainSandbox = async <T>(run: () => Promise<T>): Promise<T> => {
  const mod = await import("./agent/sandbox/index.js");
  const original = mod.sandbox.run;
  Object.defineProperty(mod.sandbox, "run", {
    configurable: true,
    writable: true,
    value: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(mod.sandbox, "run", {
      configurable: true,
      writable: true,
      value: original,
    });
  }
};

it("用尽步数:写失败记录(过程记录 + 逐步日志 + 诊断 + 分类),不建存档目录", async () => {
  const root = writeRoot(configOf(entry("alpha")));
  const stub = stubClient(replies([ACTION, ACTION, ACTION]));
  const code = await withPlainSandbox(() =>
    runGeneration({
      root,
      configPath: "models.yaml",
      createClient: () => stub,
      agentPrompt: PROMPT,
      maxSteps: 2,
    }),
  );
  expect(code).toBe(1);
  expect(stub.calls).toHaveLength(2);

  const slugDir = join(root, "archive", "alpha");
  // 「只有失败记录」:没有 <runId>/ 目录,也没有 .tmp- 残留。
  const name = onlyEntry(slugDir);
  expect(name).toMatch(/^failed-.*\.json$/);

  const record = readRecord(slugDir, name);
  // 形状家契约:v3 的键序即书写序。
  expect(Object.keys(record)).toEqual([
    "archiveSchemaVersion",
    "model",
    "modelVersion",
    "channelId",
    "generatedAt",
    "runId",
    "ruleset",
    "classification",
    "protocolRounds",
    "prompts",
    "steps",
    "generationLog",
    "contextLength",
    "harnessVersion",
    "harnessDigest",
    "termination",
    "atStep",
    "diagnostics",
    "message",
  ]);
  // 轮数 = 过程记录条数;prompts 只有一条(不是每步一份)。
  expect(record.protocolRounds).toBe(2);
  expect((record.steps as unknown[]).length).toBe(2);
  expect(record.prompts).toEqual([PROMPT.user]);
  expect(record.termination).toBe("max-steps");
  expect(record.classification).toBe("contract");
  // v3 的必写键一个不少(ADR-0034:身份从第一份 agent 档起就写)。
  for (const key of AGENT_ARCHIVE_REQUIRED_KEYS) {
    expect(record).toHaveProperty(key);
  }
  expect(existsSync(join(slugDir, "r"))).toBe(false);
});

it("buildFailureRecord 中途失败携带已有候选描述,无候选时不新增键", () => {
  const identity = {
    model: "alpha",
    modelVersion: "provider/alpha",
    channelId: "gen-test-channel",
    generatedAt: "2026-01-01T00:00:00.000Z",
    runId: "r1",
  };
  const agent = {
    steps: [],
    firstPrompt: PROMPT.user,
    contextLength: 100_000,
    harnessVersion: "bash-mini/0.1",
    harnessDigest: "0".repeat(64),
    termination: "max-steps" as const,
    atStep: 0,
  };
  const failure = {
    classification: "contract" as const,
    prompts: [],
    generationLog: [],
    diagnostics: [],
    message: "没跑出候选",
  };
  const bare = buildFailureRecord({ ...identity, failure, agent });
  expect(bare.candidates).toBeUndefined();
  // v3 形态下 `prompts` 由公式推得:零步 → 空数组。
  expect(bare.prompts).toEqual([]);
  expect(bare.protocolRounds).toBe(0);

  // 有候选：candidates 落 message 之后。v3 候选没有 `stage`/`protocolRound`，只有步号、分数与场数。
  const candidates = [
    {
      step: 1,
      scriptFile: "observed-r1-round-1.candidate.js",
      observationsFile: "observed-r1-round-1",
      scriptSha256: "c".repeat(64),
      score: { totalPoints: 1, averagePoints: 0.25, countedMatches: 4 },
      matchCount: 4,
    },
  ];
  const record = buildFailureRecord({ ...identity, failure: { ...failure, candidates }, agent });
  expect(record.candidates).toEqual(candidates);
});

it("一批两模型一败一成:失败记录与成功三件套并存,退出码非零", async () => {
  const root = writeRoot(configOf(entry("alpha"), entry("beta")));
  const code = await withPlainSandbox(() =>
    runGeneration({
      root,
      configPath: "models.yaml",
      createClient: (config) =>
        config.slug === "alpha"
          ? stubClient(replies([ACTION]))
          : stubClient([fail(new Error("boom"))]),
      agentPrompt: PROMPT,
      maxSteps: 2,
    }),
  );
  expect(code).toBe(1);
  // 两个都失败(alpha 没产出候选、beta 传输耗尽):但都在同一个批次里跑完了。
  for (const slug of ["alpha", "beta"]) {
    const names = readdirSync(join(root, "archive", slug));
    expect(names.some((name) => name.startsWith("failed-"))).toBe(true);
  }
});

it("`--model` 只跑一个:未选中的模型既不冻结也不写失败记录", async () => {
  const root = writeRoot(configOf(entry("alpha"), entry("beta")));
  const betaStub = stubClient([]);
  await withPlainSandbox(() =>
    runGeneration({
      root,
      configPath: "models.yaml",
      modelFilter: "alpha",
      createClient: (config) =>
        config.slug === "alpha" ? stubClient(replies([ACTION])) : betaStub,
      agentPrompt: PROMPT,
      maxSteps: 1,
    }),
  );
  expect(betaStub.calls).toHaveLength(0);
  expect(existsSync(join(root, "archive", "beta"))).toBe(false);
});

it("`--model` 指向未登记的 slug 即报错(不静默跑零个)", async () => {
  const root = writeRoot(configOf(entry("alpha")));
  await expect(
    runGeneration({
      root,
      configPath: "models.yaml",
      modelFilter: "nobody",
      createClient: () => stubClient([]),
      agentPrompt: PROMPT,
    }),
  ).rejects.toThrow(/没有 slug 为 "nobody"/);
});

it("多模型串行:一个模型的全部步结束之后才开另一个", async () => {
  const root = writeRoot(configOf(entry("alpha"), entry("beta")));
  const order: string[] = [];
  const tracing = (slug: string): ModelClient => {
    const inner = stubClient(replies([ACTION, ACTION]));
    return {
      send: async (
        messages: readonly ChatMessage[],
        params: ModelParams,
      ): Promise<ModelResponse> => {
        order.push(`send:${slug}`);
        return inner.send(messages, params);
      },
    };
  };
  await withPlainSandbox(() =>
    runGeneration({
      root,
      configPath: "models.yaml",
      createClient: (config) => tracing(config.slug),
      agentPrompt: PROMPT,
      maxSteps: 2,
    }),
  );
  // 串行 = 前一个模型的两步都在后一个模型之前。
  expect(order).toEqual(["send:alpha", "send:alpha", "send:beta", "send:beta"]);
});
