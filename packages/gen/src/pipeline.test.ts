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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RULESET_VERSION,
  SANDBOX_RUNTIME_HASH,
  TRIAL_GRID_SUMMARY_SUFFIX,
  type ActionErrorCounts,
  type ArchiveMeta,
  type TrialObservationLine,
  type TrialPlan,
  type TrialPlanMatch,
  type TrialTerminalSummary,
} from "@model-war/schema";
import { afterAll, expect, it, vi } from "vitest";

import { sha256Hex } from "./archive.js";
import { compileScript } from "./compile.js";
import { loadModelsConfig, type ModelConfig } from "./config.js";
import { generationParams } from "./generation-policy.js";
import { policyFixture } from "./generation-policy.fixture.js";
import { readRuleDocs } from "./contract.js";
import { generateOneModel, type ModelOutcome } from "./pipeline.js";
import { loadBaseTemplate } from "./prompt.js";
import { RETRY } from "./retry.js";
import { runGeneration, type GenerationRequest } from "./run.js";
import { fail, replies, reply, stubClient, type StubCall, type StubClient } from "./stub-client.js";
import { TransportError } from "./transport-error.js";
import { scriptSizeLimit, validateScript } from "./validate.js";
import { terminalSummaryFixture } from "./terminal-summary.fixture.js";
import { gridPlanFixture } from "./trial-plan.fixture.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = mkdtempSync(`${tmpdir()}/modelwar-gen-pipeline-`);
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

const CONTRACT_RULES = "# rules\n\n机制正文:这里是规则契约。\n";
const CONTRACT_API = "# api\n\nAPI 正文:这里是接口契约。\n";
const VALID_SCRIPT = `var ticks = 0;\nfunction loop() {\n  ticks += 1;\n  return ticks;\n}\n`;
/** 过得了 tsc 编译、但撞上 blocking 违规(禁列全局名 `Date`)的脚本——第 1 轮就会被校验拦住。 */
const BLOCKING_SCRIPT = `function loop() {\n  return Date.now();\n}\nloop();\n`;
/** 过不了 tsc(引用未定义名 `missingName` → TS2304)的脚本——驱动 `kind: "tsc"` 那一栏。 */
const TSC_FAIL_SCRIPT = `function loop() {\n  return missingName;\n}\n`;
/**
 * N 份**字节各不相同**的合法候选。
 *
 * 拿它替掉「每次都回同一个 `VALID_SCRIPT`」的用法：同字节候选会走网格复用（不重跑、不调用
 * 试跑桩），而那些用例要的恰恰是「每份候选都真的跑一次网格」。复用本身另有专门的用例。
 */
const distinctScripts = (count: number, from = 2): readonly string[] =>
  Array.from(
    { length: count },
    // 从 2 起数：`VALID_SCRIPT` 用的就是 `ticks += 1`，不能与它撞字节（撞了就走复用）。
    (_, index) =>
      `var ticks = 0;\nfunction loop() {\n  ticks += ${String(from + index)};\n  return ticks;\n}\n`,
  );
/** `models.yaml` 文本;`protocolRounds` 给了才写那一行(缺省 = gen 内部默认 5)。 */
const modelsYaml = (protocolRounds?: number): string =>
  [
    "models:",
    "  - slug: alpha",
    "    endpointFamily: chat-completions",
    "    baseUrl: https://example.test/v1",
    "    modelId: provider/alpha-1",
    "    credentialEnvVar: GEN_TEST_KEY",
    ...(protocolRounds === undefined ? [] : [`    protocolRounds: ${String(protocolRounds)}`]),
    "",
  ].join("\n");
const MODELS_YAML = modelsYaml();

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

  mkdirSync(join(root, "docs", "rules-v2"), { recursive: true });
  writeFileSync(join(root, "docs", "rules-v2", "rules.md"), CONTRACT_RULES);
  writeFileSync(join(root, "docs", "rules-v2", "api.md"), CONTRACT_API);
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

/** 取桩的第 `index` 次调用(下标越界即抛,避免测试里写非空断言)。 */
const callAt = (stub: StubClient, index: number): StubCall => {
  const call = stub.calls[index];
  if (call === undefined) {
    throw new Error(`桩没有第 ${String(index)} 次调用`);
  }
  return call;
};

/**
 * 独立算一遍「校验器会喂给模型的文本」:把同一段源码编译成产物、跑迭代期校验,取 stdout。
 * 回喂探针用它做**逐字**相等断言(严格相等,不是 `includes`)。
 */
const iterationFeedback = (root: string, source: string): string =>
  validateCompiled(root, source, "iteration").stdout;

/** 独立算一遍编译 + 指定相位的校验结果(纯子进程缝,不经管线,用作逐字比对的基准)。 */
const validateCompiled = (
  root: string,
  source: string,
  phase: "iteration" | "freeze",
): ReturnType<typeof validateScript> => {
  const stagingDir = mkdtempSync(join(root, ".probe-"));
  try {
    const compiled = compileScript({ root, stagingDir, source });
    return validateScript({
      root,
      artifactPath: compiled.jsPath,
      maxBytes: scriptSizeLimit(root),
      phase,
    });
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
};

/** 独立算一遍第 1 轮编译失败时管线会回喂的 tsc 诊断(与 `compile.diagnostics` 同源)。 */
const tscFeedback = (root: string, source: string): string => {
  const stagingDir = mkdtempSync(join(root, ".probe-"));
  try {
    return compileScript({ root, stagingDir, source }).diagnostics;
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
};

/**
 * 直接构造一份 `GenerationRequest`(绕开 `runGeneration` 的 `new Date()`,让 runId 可控)。
 *
 * 试跑默认注入通过桩：真试跑跑三场完整对局（约十秒），只属于 e2e 与手工冒烟；
 * 单测只关心管线与试跑的接缝（拦/放行两种结论的走向），不断言真试跑本身。
 */
const requestWith = (
  root: string,
  stub: StubClient,
  runId: string,
  trial: GenerationRequest["trial"] = () => ({ passed: true, stdout: "" }),
): GenerationRequest => ({
  root,
  runId,
  docs: readRuleDocs(root),
  template: loadBaseTemplate(root),
  createClient: () => stub,
  now: () => new Date("2026-01-01T00:00:00Z"),
  trial,
  // 网格计划在这里是**纯数据夹具**：真子进程要读盘算摘要、还依赖本地冻结档案
  // （`archive/` 不入库），由 `apps/cli` 的 `--plan` 用例与手工冒烟覆盖。
  trialPlan: () => gridPlanFixture(),
});

it("顺利路径:三件套 + 十一项 meta,协议轮数 = prompt 条数 = 1,退出码 0", async () => {
  const root = mkRoot();
  const stub = stubClient([reply(VALID_SCRIPT)]);
  const code = await runGeneration({
    root,
    configPath: "models.yaml",
    createClient: () => stub,
    trial: () => ({ passed: true, stdout: "" }),
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
  // 逐轮耗时(模型调用段的墙钟毫秒,整数):每轮一个,供报告侧算模型延迟。
  expect(log.sendMs).toEqual(expect.any(Number));
  expect(Number.isInteger(log.sendMs)).toBe(true);
  expect(log.sendMs as number).toBeGreaterThanOrEqual(0);
});

it("冻结期体积超限:不建目标目录、无半截三件套、退出码非零", async () => {
  const root = mkRoot(16);
  // 本用例只关心失败清理,单轮即可;多轮会因桩脚本用尽而抛错,掩盖真正的失败分类。
  writeFileSync(join(root, "models.yaml"), modelsYaml(1));
  const code = await runGeneration({
    root,
    configPath: "models.yaml",
    createClient: () => stubClient([reply(VALID_SCRIPT)]),
  });
  expect(code).toBe(1);

  const slugDir = join(root, "archive", "alpha");
  expect(existsSync(slugDir)).toBe(true);
  // 「目录存在 ⇔ 三件套完整」:失败后连一个 runId 目录、一个 .tmp-* 残留都不该有。
  // 编排层还会在这里落一条 `failed-<runId>.json` 失败记录(旁证,写盘见
  // `packages/gen/src/failure.ts`),所以只断言「除失败记录外再无他物」,而不是空目录。
  expect(readdirSync(slugDir)).toEqual([expect.stringMatching(/^failed-.*\.json$/)]);
});

it("冻结期体积超限:失败分类 contract,诊断是校验器 stdout", async () => {
  const root = mkRoot(16);
  const outcome: ModelOutcome = await generateOneModel(
    requestWith(root, stubClient([reply(VALID_SCRIPT)]), "2026-01-01T00-00-00-000Z"),
    { ...firstModelConfig(root), protocolRounds: 1 },
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

it("空产物(空围栏)也算 contract 失败:没有顶层 loop 入口就不冻结、不建存档", async () => {
  // 回归:模型只回一个空代码围栏时,提取结果是空串;tsc 把空源码编译成 `"use strict";` 照样
  // 成功,静态校验与试跑都放行,于是空产物被冻进赛季。判据是产物里得有顶层 loop 入口。
  const root = mkRoot();
  const runId = "2026-01-01T00-00-00-000Z";
  const outcome = await generateOneModel(
    requestWith(root, stubClient([reply("```typescript\n```")]), runId),
    { ...firstModelConfig(root), protocolRounds: 1 },
  );
  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") {
    return;
  }
  expect(outcome.failure.classification).toBe("contract");
  expect(outcome.failure.diagnostics.join("\n")).toContain("脚本入口");
  expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
  expect(readdirSync(join(root, "archive", "alpha"))).toEqual([]);
});

it("空产物回喂后第 2 轮补上入口 → 冻结,轮数 = prompt 条数 = 2", async () => {
  const root = mkRoot();
  const stub = stubClient([reply("```typescript\n```"), reply(VALID_SCRIPT)]);
  const outcome = await generateOneModel(requestWith(root, stub, "2026-01-01T00-00-00-000Z"), {
    ...firstModelConfig(root),
    protocolRounds: 2,
  });
  expect(outcome.kind).toBe("frozen");
  if (outcome.kind !== "frozen") {
    return;
  }
  expect(outcome.meta.protocolRounds).toBe(2);
  expect(outcome.meta.prompts).toHaveLength(2);
  // 第 2 轮新增的那条 user 消息是第 1 轮校验器 stdout 逐字,点名脚本入口。
  const round2 = callAt(stub, 1);
  expect(round2.messages[2]?.content).toContain("脚本入口");
});

it("tsc 编译失败:失败分类 tsc,日志 kind=tsc 并带 TS 错误码,不建存档", async () => {
  const root = mkRoot();
  const outcome = await generateOneModel(
    requestWith(
      root,
      stubClient([reply("function loop() { return missingName; }\n")]),
      "2026-01-01T00-00-00-000Z",
    ),
    { ...firstModelConfig(root), protocolRounds: 1 },
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

it("回喂探针:第 1 轮 blocking 违规、第 2 轮合法 → 恰好回喂一次,轮数 = prompt 条数 = 2", async () => {
  const root = mkRoot();
  // 第 1 轮会喂回的那段文本 = 校验器 stdout(独立复算,拿来做逐字相等)。
  const expected = iterationFeedback(root, BLOCKING_SCRIPT);
  const stub = stubClient([reply(BLOCKING_SCRIPT), reply(VALID_SCRIPT)]);
  const outcome = await generateOneModel(requestWith(root, stub, "2026-01-01T00-00-00-000Z"), {
    ...firstModelConfig(root),
    protocolRounds: 2,
  });

  // 恰好发生一次回喂:桩只被调 2 次。
  expect(stub.calls).toHaveLength(2);
  const round2 = callAt(stub, 1);
  expect(round2.messages).toHaveLength(3);
  expect(round2.messages[1]?.role).toBe("assistant");
  expect(round2.messages[1]?.content).toBe(BLOCKING_SCRIPT);
  // 严格相等(不是 includes):新增的那条 user 消息逐字等于上一轮的诊断文本,不含任何非校验文本。
  expect(round2.messages[2]?.role).toBe("user");
  expect(round2.messages[2]?.content).toBe(expected);

  expect(outcome.kind).toBe("frozen");
  if (outcome.kind !== "frozen") {
    return;
  }
  expect(outcome.meta.protocolRounds).toBe(2);
  expect(outcome.meta.prompts).toHaveLength(2);
  expect(outcome.meta.prompts[0]).toContain(CONTRACT_RULES);
  expect(outcome.meta.prompts[1]).toContain(expected);
  expect(outcome.meta.generationLog).toHaveLength(2);
});

it("用尽轮数:每轮都违规 → 桩被调 3 次,failure 覆盖 3 轮,不建存档目录", async () => {
  const root = mkRoot();
  const runId = "2026-01-01T00-00-00-000Z";
  const stub = stubClient(replies([BLOCKING_SCRIPT, BLOCKING_SCRIPT, BLOCKING_SCRIPT]));
  const outcome = await generateOneModel(requestWith(root, stub, runId), {
    ...firstModelConfig(root),
    protocolRounds: 3,
  });

  expect(stub.calls).toHaveLength(3);
  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") {
    return;
  }
  expect(outcome.failure.classification).toBe("contract");
  expect(outcome.failure.prompts).toHaveLength(3);
  expect(outcome.failure.generationLog).toHaveLength(3);
  expect(outcome.failure.diagnostics.join("\n")).toContain("禁列全局名");
  // 失败不建 archive/<slug>/<runId>/,也不留任何半截 / 临时目录。
  expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
  expect(readdirSync(join(root, "archive", "alpha"))).toEqual([]);
});

it("无状态:每轮 messages 前缀增长,只见 role/content 两键,不含 provider 会话 id / 隐藏状态", async () => {
  const root = mkRoot();
  const stub = stubClient(replies([BLOCKING_SCRIPT, BLOCKING_SCRIPT, BLOCKING_SCRIPT]));
  const outcome = await generateOneModel(requestWith(root, stub, "2026-01-01T00-00-00-000Z"), {
    ...firstModelConfig(root),
    protocolRounds: 3,
  });
  expect(outcome.kind).toBe("failed");

  const round1 = callAt(stub, 0);
  const round2 = callAt(stub, 1);
  const round3 = callAt(stub, 2);

  // 前缀增长:第 r 轮 messages = 上一轮 messages 原样 + 2 条(assistant + user),全量重发。
  expect(round2.messages.slice(0, round1.messages.length)).toEqual(round1.messages);
  expect(round3.messages.slice(0, round2.messages.length)).toEqual(round2.messages);
  expect(round2.messages).toHaveLength(round1.messages.length + 2);
  expect(round3.messages).toHaveLength(round2.messages.length + 2);

  // 每条消息只有 role / content:没有 provider 会话 id 字段,也没有隐藏状态。
  for (const call of stub.calls) {
    for (const message of call.messages) {
      expect(Object.keys(message).sort()).toEqual(["content", "role"]);
    }
  }
  // 每次调用的模型参数逐次相同(不靠跨轮隐藏状态)。
  expect(round2.params).toEqual(round1.params);
  expect(round3.params).toEqual(round1.params);
});

it("protocolRounds 缺省 = 5:每轮失败 → 桩恰好被调 5 次,失败链覆盖 5 轮", async () => {
  const root = mkRoot();
  const stub = stubClient(replies(Array.from({ length: 5 }, () => BLOCKING_SCRIPT)));
  const outcome = await generateOneModel(
    requestWith(root, stub, "2026-01-01T00-00-00-000Z"),
    firstModelConfig(root), // 配置里没有 protocolRounds → gen 内部默认 5
  );

  expect(stub.calls).toHaveLength(5);
  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") {
    return;
  }
  expect(outcome.failure.prompts).toHaveLength(5);
  expect(outcome.failure.generationLog).toHaveLength(5);
});

// ───────────────────────── 传输韧性(退避重试不消耗协议轮数) ─────────────────────────
//
// 传输失败(429 / 5xx / 超时)与截断(`finishReason=length`)都退避重发**同一轮**:桩多被调几次,
// 但 `protocolRounds` / `prompts` / `generationLog` 只数**已收敛的轮次**。退避用假定时器推进,不真等。

it("传输韧性:429 后成功——只调 2 次、退避一次后冻结,协议轮数仍 1", async () => {
  const root = mkRoot();
  const stub = stubClient([
    fail(new TransportError("被限流", { retryable: true, status: 429 })),
    reply(VALID_SCRIPT),
  ]);

  vi.useFakeTimers();
  let settled = false;
  try {
    const outcomePromise = generateOneModel(
      requestWith(root, stub, "2026-01-01T00-00-00-000Z"),
      firstModelConfig(root),
    ).then((outcome) => {
      settled = true;
      return outcome;
    });

    // 首次调用同步发生;第 2 次必须等满初始退避间隔才会发生(证明两次调用之间确有一次等待)。
    expect(stub.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RETRY.initialDelayMs - 1);
    expect(settled).toBe(false);
    expect(stub.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    const outcome = await outcomePromise;
    expect(stub.calls).toHaveLength(2);
    expect(outcome.kind).toBe("frozen");
    if (outcome.kind !== "frozen") {
      return;
    }
    // 重试不消耗协议轮数:一次生成、一份 prompt、一行日志。
    expect(outcome.meta.protocolRounds).toBe(1);
    expect(outcome.meta.prompts).toHaveLength(1);
    expect(outcome.meta.generationLog).toHaveLength(1);
    expect(readFileSync(join(outcome.dir, "script.ts"), "utf8")).toBe(VALID_SCRIPT);
  } finally {
    vi.useRealTimers();
  }
});

it("传输韧性:5xx 直到耗尽——重试 maxRetries 次后 transport 失败,不涨轮数、不建存档", async () => {
  const root = mkRoot();
  const runId = "2026-01-01T00-00-00-000Z";
  const stub = stubClient(
    Array.from({ length: RETRY.maxRetries + 1 }, () =>
      fail(new TransportError("服务不可用", { retryable: true, status: 503 })),
    ),
  );

  vi.useFakeTimers();
  try {
    const outcomePromise = generateOneModel(requestWith(root, stub, runId), firstModelConfig(root));
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;

    // 首次 + maxRetries 次重发。
    expect(stub.calls).toHaveLength(RETRY.maxRetries + 1);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") {
      return;
    }
    expect(outcome.failure.classification).toBe("transport");
    // 一次都未收敛 → 没有 prompt、没有日志,协议轮数一点没动。
    expect(outcome.failure.prompts).toEqual([]);
    expect(outcome.failure.generationLog).toEqual([]);
    expect(outcome.failure.diagnostics.join("\n")).toContain("503");
    expect(outcome.failure.message).toContain("传输失败");
    // 失败只返回结构,不建存档(写盘归 `packages/gen/src/failure.ts`),也不留半截 / 临时目录。
    expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
    expect(readdirSync(join(root, "archive", "alpha"))).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("传输韧性:截断后成功——重发同一轮,半截文本不入任何后续 messages", async () => {
  const root = mkRoot();
  const HALF_SCRIPT = "function loop() {\n  return 1;\n";
  const stub = stubClient([reply(HALF_SCRIPT, { finishReason: "length" }), reply(VALID_SCRIPT)]);

  vi.useFakeTimers();
  try {
    const outcomePromise = generateOneModel(
      requestWith(root, stub, "2026-01-01T00-00-00-000Z"),
      firstModelConfig(root),
    );
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;

    expect(stub.calls).toHaveLength(2);
    // 重发的是**同一轮**的 messages(半截文本既不当产物,也不回喂成新消息)。
    expect(callAt(stub, 1).messages).toEqual(callAt(stub, 0).messages);
    for (const call of stub.calls) {
      for (const message of call.messages) {
        expect(message.content).not.toContain(HALF_SCRIPT);
      }
    }

    expect(outcome.kind).toBe("frozen");
    if (outcome.kind !== "frozen") {
      return;
    }
    expect(outcome.meta.protocolRounds).toBe(1);
    expect(outcome.meta.prompts).toHaveLength(1);
    expect(readFileSync(join(outcome.dir, "script.ts"), "utf8")).toBe(VALID_SCRIPT);
  } finally {
    vi.useRealTimers();
  }
});

it("传输韧性:400(retryable:false)不重试,直接 transport 失败", async () => {
  const root = mkRoot();
  const stub = stubClient([fail(new TransportError("坏请求", { retryable: false, status: 400 }))]);

  const outcome = await generateOneModel(
    requestWith(root, stub, "2026-01-01T00-00-00-000Z"),
    firstModelConfig(root),
  );

  expect(stub.calls).toHaveLength(1);
  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") {
    return;
  }
  expect(outcome.failure.classification).toBe("transport");
  expect(outcome.failure.prompts).toEqual([]);
  expect(outcome.failure.generationLog).toEqual([]);
  expect(outcome.failure.diagnostics.join("\n")).toContain("400");
  expect(readdirSync(join(root, "archive", "alpha"))).toEqual([]);
});

it("传输韧性:第 1 轮收敛、第 2 轮传输耗尽——失败链只含已收敛的轮次", async () => {
  const root = mkRoot();
  const stub = stubClient([
    reply(BLOCKING_SCRIPT),
    ...Array.from({ length: RETRY.maxRetries + 1 }, () =>
      fail(new TransportError("请求超时", { retryable: true })),
    ),
  ]);

  vi.useFakeTimers();
  try {
    const outcomePromise = generateOneModel(requestWith(root, stub, "2026-01-01T00-00-00-000Z"), {
      ...firstModelConfig(root),
      protocolRounds: 3,
    });
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;

    // 第 1 轮 1 次 + 第 2 轮 1 次首发 + maxRetries 次重发。
    expect(stub.calls).toHaveLength(1 + RETRY.maxRetries + 1);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") {
      return;
    }
    expect(outcome.failure.classification).toBe("transport");
    // 只有第 1 轮收敛过:prompt 链与日志各 1 条,第 2 轮(死在传输上)不进账。
    expect(outcome.failure.prompts).toHaveLength(1);
    expect(outcome.failure.generationLog).toHaveLength(1);
    expect(outcome.failure.diagnostics.join("\n")).toContain("超时");
  } finally {
    vi.useRealTimers();
  }
});

/** 解析 `meta.generationLog` 的每行 JSON(便于框 `kind` / `errorCodes`)。 */
const parsedLog = (meta: {
  readonly generationLog: readonly string[];
}): readonly Record<string, unknown>[] =>
  meta.generationLog.map((line) => JSON.parse(line) as Record<string, unknown>);

it("体积两档:迭代期只提示(放行、errors 带提示条目),冻结期硬拦(拦)", () => {
  // 真实 `VALID_SCRIPT` 的字节数 > 16 → 触发体积规则。同一份源码、同一上限,只换相位。
  const root = mkRoot(16);
  const iteration = validateCompiled(root, VALID_SCRIPT, "iteration");
  const freeze = validateCompiled(root, VALID_SCRIPT, "freeze");

  // 迭代期:放行,但 `errors` 必须带上**提示条目**(不是空数组)——「通过」不抹掉「有哪些提示」。
  expect(iteration.passed).toBe(true);
  expect(iteration.errors).toHaveLength(1);
  expect(iteration.errors[0]).toContain("[提示]");
  expect(iteration.errors[0]).toContain("脚本体积");

  // 冻结期:同一份判据、同一句诊断,只有 blocking 那一维不同 → 硬拦。
  expect(freeze.passed).toBe(false);
  expect(freeze.errors.join("\n")).toContain("[拦截]");
});

it("干净通过时 errors 为空数组(总结句不是条目),提示只随违规出现", () => {
  const root = mkRoot(16);
  // 把上限放在源码字节数之上 → 一条违规都没有,渲染成「通过:没有违规。」
  const clean = mkRoot(1_000_000);
  expect(validateCompiled(root, VALID_SCRIPT, "iteration").errors).toHaveLength(1);
  expect(validateCompiled(clean, VALID_SCRIPT, "iteration").errors).toEqual([]);
});

it("编译诊断回喂:第 1 轮 tsc 不过、第 2 轮合法 → 回喂内容 = tsc 诊断,轮数 = 2,kind 记 tsc", async () => {
  const root = mkRoot();
  const expected = tscFeedback(root, TSC_FAIL_SCRIPT);
  const stub = stubClient([reply(TSC_FAIL_SCRIPT), reply(VALID_SCRIPT)]);
  const outcome = await generateOneModel(requestWith(root, stub, "2026-01-01T00-00-00-000Z"), {
    ...firstModelConfig(root),
    protocolRounds: 2,
  });

  // 编译失败也照常回喂一次、计入轮数池:桩恰好被调 2 次。
  expect(stub.calls).toHaveLength(2);
  const round2 = callAt(stub, 1);
  expect(round2.messages[1]?.role).toBe("assistant");
  expect(round2.messages[1]?.content).toBe(TSC_FAIL_SCRIPT);
  // 逐字等于第 1 轮的 tsc 诊断文本(不加前后缀、不含任何非校验文本)。
  expect(round2.messages[2]?.role).toBe("user");
  expect(round2.messages[2]?.content).toBe(expected);

  expect(outcome.kind).toBe("frozen");
  if (outcome.kind !== "frozen") {
    return;
  }
  expect(outcome.meta.protocolRounds).toBe(2);
  expect(outcome.meta.prompts).toHaveLength(2);
  const log = parsedLog(outcome.meta);
  expect(log.map((entry) => entry.kind)).toEqual(["tsc", "contract"]);
  // `errorCodes` 只在编译失败那一轮有机器码;合约轮留空,靠 `kind` 分栏。
  expect(log[0]?.errorCodes).toEqual(["TS2304"]);
  expect(log[1]?.errorCodes).toEqual([]);
});

it("编译诊断与契约诊断同池:tsc 失败 → 契约失败 → 合法,轮数 = 3,kind 逐轮标注", async () => {
  const root = mkRoot();
  const tscText = tscFeedback(root, TSC_FAIL_SCRIPT);
  const contractText = iterationFeedback(root, BLOCKING_SCRIPT);
  const stub = stubClient([reply(TSC_FAIL_SCRIPT), reply(BLOCKING_SCRIPT), reply(VALID_SCRIPT)]);
  const outcome = await generateOneModel(requestWith(root, stub, "2026-01-01T00-00-00-000Z"), {
    ...firstModelConfig(root),
    protocolRounds: 3,
  });

  // 两栏共用同一个轮数池:第 1 轮 tsc、第 2 轮契约、第 3 轮通过 —— 桩恰好 3 次(上限含第 1 轮)。
  expect(stub.calls).toHaveLength(3);
  expect(callAt(stub, 1).messages[2]?.content).toBe(tscText);
  expect(callAt(stub, 2).messages[4]?.content).toBe(contractText);

  expect(outcome.kind).toBe("frozen");
  if (outcome.kind !== "frozen") {
    return;
  }
  expect(outcome.meta.protocolRounds).toBe(3);
  expect(outcome.meta.prompts).toHaveLength(3);
  const log = parsedLog(outcome.meta);
  expect(log.map((entry) => entry.round)).toEqual([1, 2, 3]);
  expect(log.map((entry) => entry.kind)).toEqual(["tsc", "contract", "contract"]);
  expect(log[0]?.errorCodes).toEqual(["TS2304"]);
  expect(log[1]?.errorCodes).toEqual([]);
});

it("试跑拦下:失败分类 contract，诊断与回喂都是试跑文本逐字，不建存档", async () => {
  const root = mkRoot();
  const runId = "2026-01-01T00-00-00-000Z";
  const feedback = "试跑未通过：第 1 场第 0 tick 触发预算超限。\n";
  const seen: { readonly root: string; readonly artifactPath: string }[] = [];
  const outcome = await generateOneModel(
    requestWith(root, stubClient([reply(VALID_SCRIPT)]), runId, (options) => {
      seen.push(options);
      return { passed: false, stdout: feedback };
    }),
    { ...firstModelConfig(root), protocolRounds: 1 },
  );

  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") {
    return;
  }
  expect(outcome.failure.classification).toBe("contract");
  expect(outcome.failure.message).toContain("试跑");
  // 回喂与诊断都是试跑 stdout 逐字：诊断取非空行，回喂取整段。
  expect(outcome.failure.diagnostics).toEqual([feedback.trim()]);
  expect(outcome.failure.prompts).toHaveLength(1);
  expect(outcome.failure.generationLog).toHaveLength(1);
  const log = JSON.parse(outcome.failure.generationLog[0] ?? "{}") as Record<string, unknown>;
  expect(log.round).toBe(1);
  expect(log.kind).toBe("contract");
  expect(log.errorCodes).toEqual([]);
  // 探针收到的产物是本轮编译产物：根一致、文件名是 script.js。
  expect(seen).toHaveLength(1);
  expect(seen[0]?.root).toBe(root);
  expect(seen[0]?.artifactPath.endsWith("script.js")).toBe(true);
  // 失败不建存档目录，也不留半截。
  expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
  expect(readdirSync(join(root, "archive", "alpha"))).toEqual([]);
});

it("试跑探针收到观测文件路径:旁挂 archive/<slug>/observed-<runId>.jsonl，不进三件套", async () => {
  const root = mkRoot();
  const runId = "2026-01-01T00-00-00-000Z";
  const seen: { readonly observationsPath: string }[] = [];
  const outcome = await generateOneModel(
    requestWith(root, stubClient([reply(VALID_SCRIPT)]), runId, (options) => {
      seen.push(options);
      return { passed: true, stdout: "" };
    }),
    { ...firstModelConfig(root), protocolRounds: 1 },
  );

  expect(outcome.kind).toBe("frozen");
  // 路径由 gen 算（见 observations.ts）并交给入口，入口照它落盘；桩只负责收下。
  expect(seen).toHaveLength(1);
  expect(seen[0]?.observationsPath).toBe(join(root, "archive", "alpha", `observed-${runId}.jsonl`));
});

it("试跑回喂:首轮被拦、次轮通过 → 恰好回喂一次，反馈逐字，轮数 = 2", async () => {
  const root = mkRoot();
  const feedback = "试跑未通过：第 1 场第 0 tick 触发预算超限。\n";
  let calls = 0;
  const stub = stubClient([reply(VALID_SCRIPT), reply(VALID_SCRIPT)]);
  const outcome = await generateOneModel(
    requestWith(root, stub, "2026-01-01T00-00-00-000Z", () => {
      calls += 1;
      return calls === 1 ? { passed: false, stdout: feedback } : { passed: true, stdout: "" };
    }),
    { ...firstModelConfig(root), protocolRounds: 2 },
  );

  // 恰好发生一次回喂：桩只被调 2 次。
  expect(stub.calls).toHaveLength(2);
  const round2 = callAt(stub, 1);
  expect(round2.messages[1]?.role).toBe("assistant");
  expect(round2.messages[1]?.content).toBe(VALID_SCRIPT);
  // 严格相等：新增的 user 消息逐字等于试跑的回喂文本，不含任何非试跑文本。
  expect(round2.messages[2]?.role).toBe("user");
  expect(round2.messages[2]?.content).toBe(feedback);

  expect(outcome.kind).toBe("frozen");
  if (outcome.kind !== "frozen") {
    return;
  }
  expect(outcome.meta.protocolRounds).toBe(2);
  expect(outcome.meta.prompts).toHaveLength(2);
  expect(outcome.meta.prompts[1]).toContain(feedback);
  const log = parsedLog(outcome.meta);
  expect(log.map((entry) => entry.kind)).toEqual(["contract", "contract"]);
});

it("剥围栏接线:围栏包裹的合法脚本首轮直接冻结,落盘字节是剥后文本", async () => {
  const root = mkRoot();
  // 首行围栏 + 尾行围栏:不剥就是 TS2349@(1,1)(本案 opus 的挂法);剥后即 VALID_SCRIPT 本体。
  const fenced = `\`\`\`typescript\n${VALID_SCRIPT}\`\`\``;
  const stub = stubClient([reply(fenced)]);
  const outcome = await generateOneModel(requestWith(root, stub, "2026-01-01T00-00-00-000Z"), {
    ...firstModelConfig(root),
    protocolRounds: 1,
  });

  expect(outcome.kind).toBe("frozen");
  if (outcome.kind !== "frozen") {
    return;
  }
  expect(outcome.meta.protocolRounds).toBe(1);
  expect(readFileSync(join(outcome.dir, "script.ts"), "utf8")).toBe(VALID_SCRIPT);
});

const observationJsonl = (readings: readonly unknown[]): string =>
  readings.map((reading) => JSON.stringify(reading)).join("\n") + "\n";

/** 试跑桩收到的入参（含本次生成共用的评测网格计划）。 */
type TrialStubOptions = Parameters<NonNullable<GenerationRequest["trial"]>>[0];

/**
 * 桩要写的逐场读数：**每格一条**（场序、种子、候选座位与四方身份都来自计划）。
 *
 * 网格下观测行数 = 计划场数：桩如果只写三行，读入端会以「缺场」拒绝，所以这里按计划铺满。
 */
const gridReadings = (
  plan: TrialPlan,
  payload: (
    match: TrialPlanMatch,
    index: number,
  ) => { readonly delivered?: number; readonly captures?: number } = () => ({}),
): TrialObservationLine[] =>
  plan.matches.map((match, index) => {
    const { delivered = 0, captures = 0 } = payload(match, index);
    return {
      matchIndex: match.matchIndex,
      delivered,
      captures,
      noScoreSource: delivered === 0 && captures === 0,
      terminalSummary: terminalSummaryFixture(match.seed, "timeout", match.seats),
    };
  });

/**
 * 名次 → 每座位的名次积分（并列占名次区间均分）。
 *
 * 这是**夹具**的算术，只为让桩写下的汇总分数与它自己那 32 行观测自洽：真正计分的唯一真源在
 * runner（选拔子进程会把它重算一遍，与这里不一致就会被逐场比对拒掉）。
 */
const pointsOfRanks = (ranks: readonly number[]): readonly number[] => {
  const table = [3, 2, 1, 0] as const;
  const points = Array.from<number>({ length: ranks.length }).fill(0);
  const sorted = [...ranks].sort((left, right) => left - right);
  for (let cursor = 0; cursor < sorted.length; cursor += 1) {
    const rank = sorted[cursor]!;
    let last = cursor;
    while (last + 1 < sorted.length && sorted[last + 1] === rank) last += 1;
    const tied = last - cursor + 1;
    let sum = 0;
    for (let offset = 0; offset < tied; offset += 1) sum += table[rank - 1 + offset] ?? 0;
    for (const [seat, value] of ranks.entries()) if (value === rank) points[seat] = sum / tied;
    cursor = last;
  }
  return points;
};

/**
 * 一份**自洽**的终局：名次由领土分高低决定，名次积分按并列区间均分。
 *
 * gen 的观测读入端会自己按「层 → 领土分」推出名次并核对 `rankPoints`（`terminal-summary.ts`），
 * 所以夹具不能只改 `rank` 一栏——领土分与积分必须跟着名次一起造，否则那份观测根本不是引擎能
 * 产出的东西。`resourceBump` 用来在阶段之间抬同一位资源（回喂文本的「同格变化」靠它区分）。
 */
const terminalSummaryWithRanks = (
  match: TrialPlanMatch,
  ranks: readonly number[],
  resourceBump = 0,
): TrialTerminalSummary => {
  const summary = terminalSummaryFixture(match.seed, "timeout", match.seats);
  const table = [3, 2, 1, 0] as const;
  const players = summary.players.map((player, seat) => {
    const rank = ranks[seat] ?? 1;
    const tied = ranks.filter((value) => value === rank).length;
    let total = 0;
    for (let offset = 0; offset < tied; offset += 1) total += table[rank - 1 + offset] ?? 0;
    // 名次越高资源越多 → 领土分越高（基地 4 + 资源 + 单位 1）。
    const controlledResources = 4 - rank + resourceBump;
    return {
      ...player,
      controlledResources,
      territoryScore: 4 + controlledResources + 1,
      score: { ...player.score, resources: controlledResources * summary.weights.resourceScore },
      rank,
      rankPoints: total / tied,
    };
  });
  return { ...summary, players: players as unknown as TrialTerminalSummary["players"] };
};

/** 一张网格的读数（四方名次按座位序给定）：候选在每场拿第 `rank` 名，其余按名次补满。 */
const gridReadingsAtRank = (
  plan: TrialPlan,
  rank: number,
  resourceBump = 0,
): TrialObservationLine[] =>
  plan.matches.map((match) => {
    const rest = [1, 2, 3, 4].filter((value) => value !== rank);
    const ranks = match.seats.map((_, seat) =>
      seat === match.candidateSeat ? rank : (rest.shift() ?? rank),
    );
    return {
      matchIndex: match.matchIndex,
      delivered: 0,
      captures: 0,
      noScoreSource: true,
      terminalSummary: terminalSummaryWithRanks(match, ranks, resourceBump),
    };
  });

/** 一张网格的分数（夹具口径：逐场名次积分之和 / 计划场数，分母不缩）。 */
const scoreOfReadings = (
  plan: TrialPlan,
  readings: readonly TrialObservationLine[],
): { totalPoints: number; averagePoints: number; countedMatches: number } => {
  let total = 0;
  for (const reading of readings) {
    // 缺终局的那一场不补零：这份汇总只服务于「形状能读进去」，缺场会在读入端先被拒。
    if (reading.terminalSummary === undefined) continue;
    const match = plan.matches[reading.matchIndex]!;
    const ranks = reading.terminalSummary.players
      .toSorted((left, right) => left.seat - right.seat)
      .map((player) => player.rank);
    total += pointsOfRanks(ranks)[match.candidateSeat]!;
  }
  return {
    totalPoints: total,
    averagePoints: total / plan.matchesPerCandidate,
    countedMatches: plan.matchesPerCandidate,
  };
};

/**
 * 观测文件旁的网格汇总：执行器写的那一份形状（计划 + 候选摘要 + 网格分数 + 逐场身份）。
 *
 * 分数由**这一批读数**算出来（夹具口径）：生成侧不重算分数（那是 runner 与选拔的事），
 * 但桩写的这一份必须与它自己那 32 行观测自洽，否则选拔的逐场比对会（正确）拒掉它。
 */
const gridSummaryOf = (
  options: TrialStubOptions,
  readings: readonly TrialObservationLine[],
): unknown => {
  const plan = options.plan;
  if (plan === undefined) throw new Error("试跑桩需要计划才能写网格汇总");
  return {
    version: plan.version,
    plan,
    scriptSha256: sha256Hex(readFileSync(options.artifactPath)),
    score: scoreOfReadings(plan, readings),
    matches: plan.matches.map((match) => ({
      matchIndex: match.matchIndex,
      seed: match.seed,
      candidateSeat: match.candidateSeat,
      map: match.map,
      mapSha256: match.mapSha256,
    })),
  };
};

/** 写观测 + 汇总（桩的常规出口：一次 invocation 的证据一次写完）。 */
const writeGridEvidence = (
  options: TrialStubOptions,
  readings?: readonly TrialObservationLine[],
): void => {
  if (options.plan === undefined) throw new Error("试跑桩需要计划才能写网格证据");
  const rows = readings ?? gridReadings(options.plan);
  writeFileSync(options.observationsPath, observationJsonl(rows));
  writeFileSync(
    `${options.observationsPath}${TRIAL_GRID_SUMMARY_SUFFIX}`,
    JSON.stringify(gridSummaryOf(options, rows)),
  );
};

it(
  "所有有效候选固定两次事实回喂，编译修复不占优化轮，三候选可追溯",
  { timeout: 30_000 },
  async () => {
    const root = mkRoot();
    const runId = "production-action-facts";
    const revised = "function loop() { return 9; }\n";
    const final = "function loop() { return 10; }\n";
    const stub = stubClient([
      reply(VALID_SCRIPT),
      reply(TSC_FAIL_SCRIPT),
      reply(revised),
      reply(final),
    ]);
    const candidateBytes: Buffer[] = [];
    const outcome = await generateOneModel(
      {
        ...requestWith(root, stub, runId, (options) => {
          const bytes = readFileSync(options.artifactPath);
          candidateBytes.push(bytes);
          if (options.plan === undefined) throw new Error("试跑桩需要计划");
          // 每格一条：种子与候选座位都取自计划（网格里候选四个座位各坐一次）。
          writeGridEvidence(
            options,
            gridReadings(options.plan, () => ({
              delivered: candidateBytes.length === 1 ? 0 : 7,
              captures: candidateBytes.length === 1 ? 0 : 1,
            })).map((reading) => ({
              ...reading,
              actionFacts: {
                version: 1,
                scriptSha256: sha256Hex(bytes),
                seed: reading.terminalSummary!.seed,
                seat: reading.terminalSummary!.players.findIndex(
                  (player) => player.player === "candidate",
                ) as 0 | 1 | 2 | 3,
                complete: true,
                observedTicks: 12,
                missingTicks: 0,
                calls: {
                  move: 0,
                  moveTo: 6,
                  attack: 0,
                  harvest: candidateBytes.length === 1 ? 2 : 8,
                  transfer: 0,
                  spawnUnit: 5,
                },
                errors: Object.fromEntries(
                  ["move", "moveTo", "attack", "harvest", "transfer", "spawnUnit"].map((name) => [
                    name,
                    {
                      ERR_NOT_OWNER: 0,
                      ERR_INVALID_UNIT: 0,
                      ERR_OUT_OF_RANGE: 0,
                      ERR_NOT_ENOUGH_RESOURCES: name === "spawnUnit" ? 4 : 0,
                      ERR_INVALID_TARGET: 0,
                      ERR_INVALID_SITE: 0,
                      ERR_BAD_ARGS: 0,
                    },
                  ]),
                ) as ActionErrorCounts,
                effects: {
                  movedSteps: 3,
                  harvestedAmount: 2,
                  deliveredAmount: 0,
                  captureEvents: 0,
                  productionOrdersStarted: 1,
                },
              },
            })),
          );
          return { passed: true, stdout: "" };
        }),
        scoreSourceFeedback: true,
      },
      {
        ...firstModelConfig(root),
        protocolRounds: 5,
        generationPolicy: policyFixture("chat-completions"),
      },
    );
    expect(outcome.kind).toBe("frozen");
    expect(stub.calls).toHaveLength(4);
    for (const call of stub.calls) {
      expect(call.params).toEqual({ reasoning_effort: "high", max_completion_tokens: 8192 });
    }
    if (outcome.kind === "frozen") {
      for (const log of parsedLog(outcome.meta)) {
        expect(log.params).toEqual(stub.calls[0]?.params);
        expect(log.requestEvidence).toMatchObject({
          configId: "alpha",
          backendIdentity: "unverified",
        });
      }
    }
    const feedback = callAt(stub, 1).messages[2]?.content ?? "";
    // 三层结构：对差表按座位 × 地图聚合（8 格）、逐场一行 = 计划场数（32 行）、只展开最差三场。
    expect(feedback).toContain("试跑观测：本候选实际完成的 32 个对局。");
    expect(feedback.match(/^  座位\d \/ .+：4 局，/gm)).toHaveLength(8);
    expect(feedback.match(/^  #\d{2} \| .+ \| timeout$/gm)).toHaveLength(32);
    expect(feedback.match(/^- 第 \d+ 个对局：/gm)).toHaveLength(3);
    // 首轮没有上一阶段：八格都写明，而不是留空或按 0 算。
    expect(feedback.match(/无上一阶段/g)).toHaveLength(8);
    // 最差三场的明细仍是原来的三栏（四方全并列时按场次定序）。
    expect(feedback).toContain("终局事实：seed=5000");
    expect(feedback).toContain("harvest：调用=2");
    expect(feedback).toContain("spawnUnit：调用=5");
    expect(feedback).toContain("ERR_NOT_ENOUGH_RESOURCES=4");
    expect(feedback).toContain("harvestedAmount=2");
    expect(feedback).toContain("productionOrdersStarted=1");
    expect(feedback).not.toContain(sha256Hex(candidateBytes[0] ?? Buffer.alloc(0)));
    expect(feedback).not.toMatch(/请检查|阈值|坐标|目标切换|成功次数/);
    expect(callAt(stub, 2).messages[4]?.content).toContain("TS2304");
    expect(
      readFileSync(join(root, "archive", "alpha", `observed-${runId}-round-1.jsonl.candidate.js`)),
    ).toEqual(candidateBytes[0]);
    expect(
      readFileSync(join(root, "archive", "alpha", `observed-${runId}-round-3.jsonl.candidate.js`)),
    ).toEqual(candidateBytes[1]);
    expect(
      existsSync(join(root, "archive", "alpha", `observed-${runId}-round-2.jsonl.candidate.js`)),
    ).toBe(false);
    if (outcome.kind === "frozen") {
      expect(callAt(stub, 3).messages[6]?.content).toContain("harvest：调用=8");
      expect(callAt(stub, 3).messages[6]?.content).toContain("delivered=7，captures=1");
      expect(callAt(stub, 3).messages[6]?.content).not.toContain("均为零");
      expect(outcome.meta.protocolRounds).toBe(4);
      // v2：计划整份入档、四份陪练身份入档、每个候选带网格分数与场数（分数逐字来自 `.grid.json`）。
      const plan = gridPlanFixture();
      expect(outcome.meta).toHaveProperty("optimization", {
        version: 2,
        feedbackRounds: 2,
        plan,
        sparring: plan.scripts.map(({ id, role, source, scriptSha256 }) => ({
          id,
          role,
          source,
          scriptSha256,
        })),
        candidates: [1, 3, 4].map((protocolRound, stage) => ({
          stage,
          protocolRound,
          scriptFile: `observed-${runId}-round-${String(protocolRound)}.jsonl.candidate.js`,
          observationsFile: `observed-${runId}-round-${String(protocolRound)}.jsonl`,
          scriptSha256: sha256Hex(candidateBytes[stage] ?? Buffer.alloc(0)),
          params: { max_completion_tokens: 8192, reasoning_effort: "high" },
          // 桩把这三份写得字节各异，所以三次都真正跑了网格：没有复用来源，也没有 `trialSeeds`。
          score: { totalPoints: 48, averagePoints: 1.5, countedMatches: plan.matchesPerCandidate },
          matchCount: plan.matchesPerCandidate,
        })),
      });
      expect(outcome.meta.optimization).not.toHaveProperty("trialSeeds");
      expect(candidateBytes).toHaveLength(3);
      expect(outcome.meta.scriptSha256).toBe(sha256Hex(candidateBytes[2] ?? Buffer.alloc(0)));
      expect(readFileSync(join(outcome.dir, "script.js"))).toEqual(candidateBytes[2]);
      expect(readFileSync(join(outcome.dir, "script.ts"), "utf8")).toBe(final);
      expect(
        readFileSync(
          join(root, "archive", "alpha", `observed-${runId}-round-1.jsonl.candidate.ts`),
          "utf8",
        ),
      ).toBe(VALID_SCRIPT);
      expect(
        readFileSync(
          join(root, "archive", "alpha", `observed-${runId}-round-3.jsonl.candidate.ts`),
          "utf8",
        ),
      ).toBe(revised);
      expect(
        readFileSync(
          join(root, "archive", "alpha", `observed-${runId}-round-4.jsonl.candidate.ts`),
          "utf8",
        ),
      ).toBe(final);
    }
  },
);

it("初次候选少跑一场时停止，不请求第一次优化并保留本轮证据", async () => {
  const root = mkRoot();
  const runId = "terminal-initial-missing";
  const stub = stubClient([reply(VALID_SCRIPT), reply(VALID_SCRIPT), reply(VALID_SCRIPT)]);
  let written = "";
  await expect(
    generateOneModel(
      {
        ...requestWith(root, stub, runId, (options) => {
          if (options.plan === undefined) throw new Error("试跑桩需要计划");
          // 计划里 32 格，桩只写前 31 格：缺的那一场必须被读入端拒绝（不补零、不缩分母）。
          const readings = gridReadings(options.plan).slice(0, 31);
          written = observationJsonl(readings);
          writeGridEvidence(options, readings);
          return { passed: true, stdout: "" };
        }),
        scoreSourceFeedback: true,
      },
      firstModelConfig(root),
    ),
  ).rejects.toThrow(/缺少完整评测网格的有效终局摘要（计划 32 场，缺 matchIndex 31）/);
  expect(stub.calls).toHaveLength(1);
  expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
  expect(existsSync(join(root, "archive", "alpha", `observed-${runId}.jsonl`))).toBe(false);
  expect(
    readFileSync(join(root, "archive", "alpha", `observed-${runId}-round-1.jsonl`), "utf8"),
  ).toBe(written);
});

it(
  "三份候选都在整张网格上被评测：每个候选 32 行观测 + 一份网格汇总",
  { timeout: 30_000 },
  async () => {
    const root = mkRoot();
    const runId = "grid-three-candidates";
    // 三份字节各异的候选：同字节会走复用，那就不是「三份都跑」了（复用另有专门用例）。
    const stub = stubClient(distinctScripts(3).map((source) => reply(source)));
    const seen: { readonly rows: number; readonly planSha256: string }[] = [];
    const outcome = await generateOneModel(
      {
        ...requestWith(root, stub, runId, (options) => {
          if (options.plan === undefined) throw new Error("试跑桩需要计划");
          writeGridEvidence(options);
          seen.push({ rows: options.plan.matches.length, planSha256: options.plan.planSha256 });
          return { passed: true, stdout: "" };
        }),
        scoreSourceFeedback: true,
      },
      firstModelConfig(root),
    );
    expect(outcome.kind).toBe("frozen");
    // 三次有效候选各跑一次整张网格，且三次用的是**同一张**网格（计划摘要恒定）。
    expect(seen).toHaveLength(3);
    expect(seen.map((entry) => entry.rows)).toEqual([32, 32, 32]);
    expect(new Set(seen.map((entry) => entry.planSha256)).size).toBe(1);
    for (const round of [1, 2, 3]) {
      const base = join(root, "archive", "alpha", `observed-${runId}-round-${round}.jsonl`);
      expect(readFileSync(base, "utf8").trim().split("\n")).toHaveLength(32);
      expect(existsSync(`${base}${TRIAL_GRID_SUMMARY_SUFFIX}`)).toBe(true);
    }
    // 成绩与反馈同源：每个候选记录里的分数就是它那一轮 `.grid.json` 里的分数。
    if (outcome.kind !== "frozen") return;
    const optimization = outcome.meta.optimization;
    expect(optimization?.version).toBe(2);
    for (const [stage, candidate] of (optimization?.candidates ?? []).entries()) {
      const summary = JSON.parse(
        readFileSync(
          join(
            root,
            "archive",
            "alpha",
            `observed-${runId}-round-${String(stage + 1)}.jsonl${TRIAL_GRID_SUMMARY_SUFFIX}`,
          ),
          "utf8",
        ),
      ) as { score: unknown };
      expect(candidate.score).toEqual(summary.score);
      expect(candidate.matchCount).toBe(32);
      expect(candidate).not.toHaveProperty("reusedFromStage");
    }
  },
);

it(
  "同字节候选复用先前网格：不重跑、逐场逐字节一致、复用来源落档",
  { timeout: 30_000 },
  async () => {
    const root = mkRoot();
    const runId = "grid-reuse-same-bytes";
    const stub = stubClient([reply(VALID_SCRIPT), reply(VALID_SCRIPT), reply(VALID_SCRIPT)]);
    const invocations: string[] = [];
    const outcome = await generateOneModel(
      {
        ...requestWith(root, stub, runId, (options) => {
          invocations.push(options.observationsPath);
          writeGridEvidence(options);
          return { passed: true, stdout: "" };
        }),
        scoreSourceFeedback: true,
      },
      firstModelConfig(root),
    );
    expect(outcome.kind).toBe("frozen");
    // 三份候选字节完全相同 → 网格只跑了一次（后两阶段复用第 0 阶段的那一份）。
    expect(invocations).toHaveLength(1);
    if (outcome.kind !== "frozen") return;
    const candidates = outcome.meta.optimization?.candidates ?? [];
    expect(candidates.map((candidate) => candidate.stage)).toEqual([0, 1, 2]);
    expect(candidates.map((candidate) => candidate.reusedFromStage)).toEqual([undefined, 0, 0]);
    // 成绩与反馈同源：复用阶段的分数不是另算的，而是与来源逐位相同。
    expect(new Set(candidates.map((candidate) => JSON.stringify(candidate.score))).size).toBe(1);
    const roundOf = (round: number): string =>
      join(root, "archive", "alpha", `observed-${runId}-round-${String(round)}.jsonl`);
    const source = readFileSync(roundOf(1), "utf8");
    const sourceSummary = readFileSync(`${roundOf(1)}${TRIAL_GRID_SUMMARY_SUFFIX}`, "utf8");
    for (const round of [2, 3]) {
      // 每个阶段仍独占自己的观测与汇总，内容与来源逐字节相同（复用结果必须与来源完全一致）。
      expect(readFileSync(roundOf(round), "utf8")).toBe(source);
      expect(readFileSync(`${roundOf(round)}${TRIAL_GRID_SUMMARY_SUFFIX}`, "utf8")).toBe(
        sourceSummary,
      );
      expect(existsSync(`${roundOf(round)}.candidate.js`)).toBe(true);
      expect(existsSync(`${roundOf(round)}.candidate.ts`)).toBe(true);
    }
  },
);

it.each(["观测", "汇总"])(
  "复用前来源%s被改动即整批失败，不留半份存档",
  { timeout: 30_000 },
  async (target) => {
    const root = mkRoot();
    const runId = `grid-reuse-tampered-${target}`;
    const stub = stubClient([reply(VALID_SCRIPT), reply(VALID_SCRIPT), reply(VALID_SCRIPT)]);
    const sourcePath = join(root, "archive", "alpha", `observed-${runId}-round-1.jsonl`);
    let clients = 0;
    await expect(
      generateOneModel(
        {
          ...requestWith(root, stub, runId, (options) => {
            writeGridEvidence(options);
            return { passed: true, stdout: "" };
          }),
          scoreSourceFeedback: true,
          // 第二轮开始前改掉第 0 阶段的来源证据：复用只认「收录时的字节」。
          createClient: () => {
            clients += 1;
            if (clients === 2)
              writeFileSync(
                target === "观测" ? sourcePath : `${sourcePath}${TRIAL_GRID_SUMMARY_SUFFIX}`,
                target === "观测" ? "{}\n" : JSON.stringify({ tampered: true }),
              );
            return stub;
          },
        },
        firstModelConfig(root),
      ),
    ).rejects.toThrow(new RegExp(`复用来源的网格${target}已被改动`));
    expect(clients).toBe(2);
    expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
    expect(existsSync(join(root, "archive", "alpha", `observed-${runId}.jsonl`))).toBe(false);
  },
);

it(
  "最终候选在生成阶段即持有网格分数，最终观测连同网格汇总一起发布",
  { timeout: 30_000 },
  async () => {
    const root = mkRoot();
    const runId = "grid-final-scored";
    const stub = stubClient(distinctScripts(3).map((source) => reply(source)));
    const outcome = await generateOneModel(
      {
        ...requestWith(root, stub, runId, (options) => {
          writeGridEvidence(options);
          return { passed: true, stdout: "" };
        }),
        scoreSourceFeedback: true,
      },
      firstModelConfig(root),
    );
    expect(outcome.kind).toBe("frozen");
    if (outcome.kind !== "frozen") return;
    const final = outcome.meta.optimization?.candidates[2];
    const roundThree = join(root, "archive", "alpha", `observed-${runId}-round-3.jsonl`);
    const summary = JSON.parse(
      readFileSync(`${roundThree}${TRIAL_GRID_SUMMARY_SUFFIX}`, "utf8"),
    ) as {
      score: unknown;
    };
    // 生成阶段就有分数：不靠选拔从零开始测，也不靠报告侧补算。
    expect(final?.score).toEqual(summary.score);
    expect(final?.matchCount).toBe(32);
    // 最终发布的是「观测 + 汇总」一对：只发观测会让兼容路径上丢了这张网格的身份与分数。
    const published = join(root, "archive", "alpha", `observed-${runId}.jsonl`);
    expect(readFileSync(published, "utf8")).toBe(readFileSync(roundThree, "utf8"));
    expect(readFileSync(`${published}${TRIAL_GRID_SUMMARY_SUFFIX}`, "utf8")).toBe(
      readFileSync(`${roundThree}${TRIAL_GRID_SUMMARY_SUFFIX}`, "utf8"),
    );
  },
);

it.each(["换种子", "换图"])(
  "网格汇总与 expected plan 不同源（%s）即整批失败，不回喂也不冻结",
  { timeout: 30_000 },
  async (kind) => {
    const root = mkRoot();
    const runId = `grid-plan-mismatch-${kind}`;
    const stub = stubClient([reply(VALID_SCRIPT), reply(VALID_SCRIPT), reply(VALID_SCRIPT)]);
    await expect(
      generateOneModel(
        {
          ...requestWith(root, stub, runId, (options) => {
            if (options.plan === undefined) throw new Error("试跑桩需要计划");
            writeGridEvidence(options);
            // 汇总里的计划被换掉：换一个种子 / 换一张图（正文与 planSha256 一起换，形状仍合法）。
            const summary = gridSummaryOf(options, gridReadings(options.plan)) as {
              plan: TrialPlan;
              matches: readonly unknown[];
            };
            writeFileSync(
              `${options.observationsPath}${TRIAL_GRID_SUMMARY_SUFFIX}`,
              JSON.stringify({
                ...summary,
                plan:
                  kind === "换种子"
                    ? {
                        ...summary.plan,
                        matches: summary.plan.matches.map((match, index) =>
                          index === 0 ? { ...match, seed: 999 } : match,
                        ),
                      }
                    : {
                        ...summary.plan,
                        maps: [
                          { ...summary.plan.maps[0]!, name: "fortress-core" },
                          summary.plan.maps[1]!,
                        ],
                      },
              }),
            );
            return { passed: true, stdout: "" };
          }),
          scoreSourceFeedback: true,
        },
        firstModelConfig(root),
      ),
    ).rejects.toThrow(/expected plan 不同源/);
    expect(stub.calls).toHaveLength(1);
    expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
  },
);

it("中间候选三行中缺终局摘要时停止，不请求第二次优化", { timeout: 30_000 }, async () => {
  const root = mkRoot();
  const runId = "terminal-middle-partial";
  // 字节各异：同字节会复用上一阶段的网格，那就不会有「第二次调用」。
  const stub = stubClient(distinctScripts(3).map((source) => reply(source)));
  let invocation = 0;
  const observedPaths: string[] = [];
  await expect(
    generateOneModel(
      {
        ...requestWith(root, stub, runId, (options) => {
          invocation += 1;
          observedPaths.push(options.observationsPath);
          if (options.plan === undefined) throw new Error("试跑桩需要计划");
          const readings = gridReadings(options.plan);
          // 第二次调用少一格终局：整张网格不完整即停止推进。
          if (invocation === 2) Reflect.deleteProperty(readings[7]!, "terminalSummary");
          writeGridEvidence(options, readings);
          return { passed: true, stdout: "" };
        }),
        scoreSourceFeedback: true,
      },
      firstModelConfig(root),
    ),
  ).rejects.toThrow(/缺少完整评测网格的有效终局摘要.*优化阶段 1 未完成/);
  expect(stub.calls).toHaveLength(2);
  expect(callAt(stub, 1).messages[2]?.content).toContain("终局事实：seed=5000");
  expect(observedPaths).toHaveLength(2);
  for (const path of observedPaths) {
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.candidate.js`)).toBe(true);
  }
  expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
  expect(existsSync(join(root, "archive", "alpha", `observed-${runId}.jsonl`))).toBe(false);
});

it("最终候选仅保存两场终局时拒绝冻结，不追加请求或执行选拔", { timeout: 30_000 }, async () => {
  const root = selectionRoot();
  const runId = "terminal-final-partial";
  // 字节各异：同字节会复用上一阶段的网格，第三次就不会真的跑网格。
  const stub = stubClient(distinctScripts(3).map((source) => reply(source)));
  let invocation = 0;
  const selection = vi.fn();
  await expect(
    generateOneModel(
      {
        ...requestWith(root, stub, runId, (options) => {
          invocation += 1;
          if (options.plan === undefined) throw new Error("试跑桩需要计划");
          const readings = gridReadings(options.plan);
          if (invocation === 3) readings.pop();
          writeGridEvidence(options, readings);
          return { passed: true, stdout: "" };
        }),
        scoreSourceFeedback: true,
        selectBestCandidate: true,
        selection,
      },
      firstModelConfig(root),
    ),
  ).rejects.toThrow(/缺少完整评测网格的有效终局摘要.*优化阶段 2 未完成/);
  expect(stub.calls).toHaveLength(3);
  expect(invocation).toBe(3);
  expect(selection).not.toHaveBeenCalled();
  expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
  expect(existsSync(join(root, "archive", "alpha", `observed-${runId}.jsonl`))).toBe(false);
  for (const round of [1, 2, 3]) {
    const path = join(root, "archive", "alpha", `observed-${runId}-round-${round}.jsonl`);
    expect(existsSync(`${path}.candidate.js`)).toBe(true);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(round === 3 ? 31 : 32);
  }
});

it.each([undefined, "", " \n\n"])(
  "opt-in 缺失或零行观测 %j 必须 infra 失败，保留本轮候选而不冻结",
  async (observed) => {
    const root = mkRoot();
    const runId = "feedback-missing";
    const stub = stubClient([reply(VALID_SCRIPT)]);
    await expect(
      generateOneModel(
        {
          ...requestWith(root, stub, runId, (options) => {
            if (observed !== undefined) writeFileSync(options.observationsPath, observed);
            return { passed: true, stdout: "" };
          }),
          scoreSourceFeedback: true,
        },
        { ...firstModelConfig(root), protocolRounds: 1 },
      ),
    ).rejects.toThrow(/缺少完整评测网格的有效终局摘要/);
    expect(stub.calls).toHaveLength(1);
    expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
    expect(
      existsSync(join(root, "archive", "alpha", `observed-${runId}-round-1.jsonl.candidate.js`)),
    ).toBe(true);
  },
);

it.each([
  { stage: 0, sources: [TSC_FAIL_SCRIPT], classification: "tsc", configuredRounds: 1 },
  { stage: 1, sources: [BLOCKING_SCRIPT], classification: "contract", configuredRounds: 2 },
  // 阶段 2 的修复响应要**字节各异**：同字节会被网格复用判为「已经跑过」，就不会再触限。
  { stage: 2, sources: distinctScripts(5, 100), classification: "contract", configuredRounds: 9 },
])(
  "优化阶段 $stage 不受逐模型上限 $configuredRounds 影响，统一用尽五次响应即失败",
  { timeout: 15_000 },
  async ({ stage, sources, classification, configuredRounds }) => {
    const root = mkRoot();
    const runId = `repair-exhausted-${String(stage)}`;
    const stub = stubClient([
      // 前 stage 个阶段的候选也**字节各异**：同字节会被网格复用（不调用试跑桩），
      // 那样 `trialCount <= 2` 这条「前两阶段通过」的判据就不再成立。
      ...distinctScripts(stage).map((source) => reply(source)),
      ...Array.from({ length: 5 }, (_, index) => reply(sources[index] ?? sources[0]!)),
    ]);
    let trialCount = 0;
    const outcome = await generateOneModel(
      {
        ...requestWith(root, stub, runId, (options) => {
          trialCount += 1;
          writeGridEvidence(
            options,
            gridReadings(options.plan!, () => ({ delivered: 1, captures: 0 })),
          );
          return { passed: stage !== 2 || trialCount <= 2, stdout: "预算诊断\n" };
        }),
        scoreSourceFeedback: true,
      },
      { ...firstModelConfig(root), protocolRounds: configuredRounds },
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(stub.calls).toHaveLength(stage + 5);
    expect(outcome.failure.classification).toBe(classification);
    expect(outcome.failure.prompts).toHaveLength(stage + 5);
    expect(outcome.failure.generationLog).toHaveLength(stage + 5);
    expect(outcome.failure.message).toContain(`优化阶段 ${String(stage)}`);
    expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
    for (let round = 1; round <= stage; round += 1) {
      expect(
        existsSync(
          join(
            root,
            "archive",
            "alpha",
            `observed-${runId}-round-${String(round)}.jsonl.candidate.js`,
          ),
        ),
      ).toBe(true);
    }
    if (stage === 2) expect(callAt(stub, 3).messages[6]?.content).toBe("预算诊断\n");
  },
);

it.each(["当前", "前阶段"])(
  "试跑更换%s独占旁挂JS时 infra 失败，不能冻结错配历史",
  async (target) => {
    const root = mkRoot();
    const runId = "feedback-sidecar-mutation";
    // 字节各异：本轮要真的走到第二次网格执行（复用会跳过它，桩就不会被调用）。
    const stub = stubClient(distinctScripts(3).map((source) => reply(source)));
    let invocation = 0;
    await expect(
      generateOneModel(
        {
          ...requestWith(root, stub, runId, (options) => {
            invocation += 1;
            const observationsPath = options.observationsPath;
            writeGridEvidence(
              options,
              gridReadings(options.plan!, () => ({ delivered: 2, captures: 0 })),
            );
            if (target === "当前" || invocation === 2) {
              const saved =
                target === "当前"
                  ? `${observationsPath}.candidate.js`
                  : join(root, "archive", "alpha", `observed-${runId}-round-1.jsonl.candidate.js`);
              writeFileSync(saved, "function loop() { return 123; }\n");
            }
            return { passed: true, stdout: "" };
          }),
          scoreSourceFeedback: true,
        },
        { ...firstModelConfig(root), protocolRounds: 1 },
      ),
    ).rejects.toThrow("旁挂候选 JS 字节改变");
    expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
    expect(existsSync(join(root, "archive", "alpha", `observed-${runId}.jsonl`))).toBe(false);
  },
);

it("后阶段传输失败标明阶段，重试耗尽不产生新有效候选或协议日志", async () => {
  const root = mkRoot();
  const runId = "optimization-transport";
  const stub = stubClient([
    reply(VALID_SCRIPT),
    ...Array.from({ length: RETRY.maxRetries + 1 }, () =>
      fail(new TransportError("服务不可用", { retryable: true, status: 503 })),
    ),
  ]);
  vi.useFakeTimers();
  try {
    const pending = generateOneModel(
      {
        ...requestWith(root, stub, runId, (options) => {
          writeGridEvidence(
            options,
            gridReadings(options.plan!, () => ({ delivered: 1, captures: 0 })),
          );
          return { passed: true, stdout: "" };
        }),
        scoreSourceFeedback: true,
      },
      { ...firstModelConfig(root), protocolRounds: 1 },
    );
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(stub.calls).toHaveLength(RETRY.maxRetries + 2);
    expect(outcome.failure.classification).toBe("transport");
    expect(outcome.failure.message).toContain("优化阶段 1");
    expect(outcome.failure.prompts).toHaveLength(1);
    expect(outcome.failure.generationLog).toHaveLength(1);
    for (let index = 2; index < stub.calls.length; index += 1) {
      expect(callAt(stub, index).messages).toEqual(callAt(stub, 1).messages);
    }
    expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
    expect(
      existsSync(join(root, "archive", "alpha", `observed-${runId}-round-1.jsonl.candidate.js`)),
    ).toBe(true);
    expect(
      existsSync(join(root, "archive", "alpha", `observed-${runId}-round-2.jsonl.candidate.js`)),
    ).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["候选JS", "观测JSONL", "网格汇总"])(
  "本轮%s已有证据时拒绝复用或覆盖，保留原证据",
  async (kind) => {
    const root = mkRoot();
    const runId = "feedback-evidence-collision";
    const path = join(
      root,
      "archive",
      "alpha",
      `observed-${runId}-round-1.jsonl${kind === "候选JS" ? ".candidate.js" : kind === "网格汇总" ? TRIAL_GRID_SUMMARY_SUFFIX : ""}`,
    );
    mkdirSync(join(root, "archive", "alpha"), { recursive: true });
    writeFileSync(path, "previous-evidence");
    const stub = stubClient([reply(VALID_SCRIPT)]);
    let trialInvoked = false;
    await expect(
      generateOneModel(
        {
          ...requestWith(root, stub, runId, () => {
            trialInvoked = true;
            return { passed: true, stdout: "" };
          }),
          scoreSourceFeedback: true,
        },
        { ...firstModelConfig(root), protocolRounds: 3 },
      ),
    ).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("previous-evidence");
    expect(trialInvoked).toBe(false);
    expect(stub.calls).toHaveLength(1);
    expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
  },
);

it("试跑期间编译产物被更换时不能回喂错配事实或冻结", async () => {
  const root = mkRoot();
  const runId = "feedback-candidate-mutation";
  const stub = stubClient([reply(VALID_SCRIPT)]);
  await expect(
    generateOneModel(
      {
        ...requestWith(root, stub, runId, ({ artifactPath }) => {
          writeFileSync(artifactPath, "function loop() { return 99; }\n");
          return { passed: true, stdout: "" };
        }),
        scoreSourceFeedback: true,
      },
      { ...firstModelConfig(root), protocolRounds: 3 },
    ),
  ).rejects.toThrow("编译 JS 字节改变");
  expect(stub.calls).toHaveLength(1);
  expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
});

it("旧四栏观测在新优化流程失败安全，不回喂或冻结，原始证据保留", async () => {
  const root = mkRoot();
  const runId = "feedback-legacy-safe";
  const observed = observationJsonl(
    [0, 1, 2].map((matchIndex) => ({
      matchIndex,
      delivered: 0,
      captures: 0,
      noScoreSource: true,
    })),
  );
  const stub = stubClient([reply(VALID_SCRIPT), reply(VALID_SCRIPT), reply(VALID_SCRIPT)]);
  await expect(
    generateOneModel(
      {
        ...requestWith(root, stub, runId, (options) => {
          writeFileSync(options.observationsPath, observed);
          return { passed: true, stdout: "试跑通过" };
        }),
        scoreSourceFeedback: true,
      },
      firstModelConfig(root),
    ),
  ).rejects.toThrow(/缺少完整评测网格的有效终局摘要.*优化阶段 0 未完成/);
  expect(stub.calls).toHaveLength(1);
  expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
  expect(existsSync(join(root, "archive", "alpha", `observed-${runId}.jsonl`))).toBe(false);
  const candidatePath = join(root, "archive", "alpha", `observed-${runId}-round-1.jsonl`);
  expect(readFileSync(candidatePath, "utf8")).toBe(observed);
  expect(existsSync(`${candidatePath}.candidate.js`)).toBe(true);
});

it.each([
  {
    name: "默认关闭",
    enabled: undefined,
    observed: '{"matchIndex":0,"delivered":0,"captures":0,"noScoreSource":true}\n',
  },
  {
    name: "显式 false",
    enabled: false,
    observed: '{"matchIndex":0,"delivered":0,"captures":0,"noScoreSource":true}\n',
  },
])("观测回喂边界 $name：正常首轮冻结，不追加反馈", async ({ enabled, observed }) => {
  const root = mkRoot();
  const stub = stubClient([reply(VALID_SCRIPT)]);
  const request = {
    ...requestWith(root, stub, "feedback-gating", ({ observationsPath }) => {
      if (observed !== undefined) writeFileSync(observationsPath, observed);
      return { passed: true, stdout: "" };
    }),
    ...(enabled === undefined ? {} : { scoreSourceFeedback: enabled }),
  };
  const outcome = await generateOneModel(request, { ...firstModelConfig(root), protocolRounds: 3 });
  expect(outcome.kind).toBe("frozen");
  if (outcome.kind !== "frozen") return;
  expect(outcome.meta.protocolRounds).toBe(1);
  expect(stub.calls).toHaveLength(1);
});

it(
  "每阶段独立两次总尝试，诊断修复不侵占有效候选，协议轮号全局递增",
  { timeout: 15_000 },
  async () => {
    const root = mkRoot();
    const sources = [
      TSC_FAIL_SCRIPT,
      VALID_SCRIPT,
      BLOCKING_SCRIPT,
      "function loop() { return 4; }\n",
      "function loop() { return 5; }\n",
      "function loop() { return 6; }\n",
    ];
    const stub = stubClient(sources.map((source) => reply(source)));
    const runId = "feedback-cap";
    let trialCount = 0;
    const outcome = await generateOneModel(
      {
        ...requestWith(root, stub, runId, (options) => {
          trialCount += 1;
          writeGridEvidence(
            options,
            gridReadings(options.plan!, () => ({ delivered: 3, captures: 0 })),
          );
          return { passed: trialCount !== 3, stdout: "预算诊断\n" };
        }),
        scoreSourceFeedback: true,
      },
      { ...firstModelConfig(root), protocolRounds: 2 },
    );
    expect(outcome.kind).toBe("frozen");
    if (outcome.kind !== "frozen") return;
    expect(stub.calls).toHaveLength(6);
    expect(trialCount).toBe(4);
    expect(outcome.meta.protocolRounds).toBe(6);
    expect(
      outcome.meta.optimization?.candidates.map(({ stage, protocolRound }) => [
        stage,
        protocolRound,
      ]),
    ).toEqual([
      [0, 2],
      [1, 4],
      [2, 6],
    ]);
    expect(callAt(stub, 5).messages[10]?.content).toBe("预算诊断\n");
    expect(readFileSync(join(outcome.dir, "script.ts"), "utf8")).toBe(sources[5]);
  },
);

it("预算和编译修复不消费优化机会，三个全零有效候选后正常收口", async () => {
  const root = mkRoot();
  const runId = "feedback-budget-history";
  const budgetFeedback = "试跑未通过：候选脚本 API 预算超限。\n";
  const sources = [
    TSC_FAIL_SCRIPT,
    VALID_SCRIPT,
    "function loop() { return 3; }\n",
    "function loop() { return 4; }\n",
    "function loop() { return 5; }\n",
  ];
  const stub = stubClient(sources.map((source) => reply(source)));
  let trialInvocation = 0;
  const outcome = await generateOneModel(
    {
      ...requestWith(root, stub, runId, (options) => {
        trialInvocation += 1;
        writeGridEvidence(options, gridReadings(options.plan!));
        return trialInvocation === 1
          ? { passed: false, stdout: budgetFeedback }
          : { passed: true, stdout: "" };
      }),
      scoreSourceFeedback: true,
    },
    { ...firstModelConfig(root), protocolRounds: 5 },
  );
  expect(outcome.kind).toBe("frozen");
  if (outcome.kind !== "frozen") return;
  expect(outcome.meta.protocolRounds).toBe(5);
  expect(callAt(stub, 2).messages[4]?.content).toBe(budgetFeedback);
  expect(callAt(stub, 3).messages.slice(0, 5)).toEqual(callAt(stub, 2).messages);
  expect(callAt(stub, 3).messages[5]).toEqual({ role: "assistant", content: sources[2] });
  expect(callAt(stub, 3).messages[6]?.content).toContain("delivered=0，captures=0");
  expect(outcome.meta.prompts).toHaveLength(5);
  expect(outcome.meta.generationLog).toHaveLength(5);
});

it("事实回喂后的预算失败用尽阶段独立额度，不以全零替代预算反馈", { timeout: 30_000 }, async () => {
  const root = mkRoot();
  const runId = "feedback-budget-after";
  // 字节各异：同字节会复用第 0 阶段的网格（判为已通过），就轮不到「本阶段预算再次触限」。
  const stub = stubClient(distinctScripts(6).map((source) => reply(source)));
  const feedback = "试跑未通过：预算超限。\n";
  let invocation = 0;
  const outcome = await generateOneModel(
    {
      ...requestWith(root, stub, runId, (options) => {
        invocation += 1;
        writeGridEvidence(options, gridReadings(options.plan!));
        return { passed: invocation === 1, stdout: invocation === 1 ? "" : feedback };
      }),
      scoreSourceFeedback: true,
    },
    { ...firstModelConfig(root), protocolRounds: 3 },
  );
  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") return;
  expect(stub.calls).toHaveLength(6);
  expect(outcome.failure.classification).toBe("contract");
  expect(outcome.failure.diagnostics).toEqual([feedback.trim()]);
  expect(callAt(stub, 2).messages[4]?.content).toBe(feedback);
  expect(existsSync(join(root, "archive", "alpha", `observed-${runId}.jsonl`))).toBe(false);
  // 中途失败携带已验证候选描述（报告的已有候选披露）。
  const candidateJs = readFileSync(
    join(root, "archive", "alpha", `observed-${runId}-round-1.jsonl.candidate.js`),
  );
  expect(outcome.failure.candidates).toEqual([
    {
      stage: 0,
      protocolRound: 1,
      scriptFile: `observed-${runId}-round-1.jsonl.candidate.js`,
      observationsFile: `observed-${runId}-round-1.jsonl`,
      scriptSha256: sha256Hex(candidateJs),
      params: {},
      // v2：中途失败也带着这个候选的网格分数与场数（报告侧据此披露已有阶段）。
      score: { totalPoints: 48, averagePoints: 1.5, countedMatches: 32 },
      matchCount: 32,
    },
  ]);
});

it.each(["trial 抛错", "观测 JSON 损坏", "读盘失败"])(
  "基础设施异常 %s 大声抛出，不作为观测反馈",
  async (kind) => {
    const root = mkRoot();
    const runId = "feedback-infra";
    const stub = stubClient([reply(VALID_SCRIPT)]);
    const request = {
      ...requestWith(root, stub, runId, (options) => {
        if (kind === "trial 抛错") throw new Error("试跑基础设施不可用");
        if (kind === "观测 JSON 损坏") writeFileSync(options.observationsPath, "not-json\n");
        else mkdirSync(options.observationsPath);
        return { passed: true, stdout: "" };
      }),
      scoreSourceFeedback: true,
    };
    await expect(
      generateOneModel(request, { ...firstModelConfig(root), protocolRounds: 3 }),
    ).rejects.toThrow();
    expect(stub.calls).toHaveLength(1);
    expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
  },
);

it("观测协议拒绝重复 matchIndex：抛出异常，不回喂、不冻结候选", async () => {
  const root = mkRoot();
  const runId = "feedback-duplicate-index";
  const stub = stubClient([reply(VALID_SCRIPT)]);
  const request = {
    ...requestWith(root, stub, runId, (options) => {
      writeFileSync(
        options.observationsPath,
        '{"matchIndex":0,"delivered":0,"captures":0,"noScoreSource":true}\n' +
          '{"matchIndex":0,"delivered":2,"captures":0,"noScoreSource":false}\n',
      );
      return { passed: true, stdout: "" };
    }),
    scoreSourceFeedback: true,
  };
  await expect(
    generateOneModel(request, { ...firstModelConfig(root), protocolRounds: 3 }),
  ).rejects.toThrow("试跑观测协议违约");
  expect(stub.calls).toHaveLength(1);
  expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
  expect(existsSync(join(root, "archive", "alpha", `observed-${runId}.jsonl`))).toBe(false);
  expect(readdirSync(join(root, "archive", "alpha"))).toEqual([
    `observed-${runId}-round-1.jsonl`,
    `observed-${runId}-round-1.jsonl.candidate.js`,
    `observed-${runId}-round-1.jsonl.candidate.ts`,
  ]);
});

it("观测协议拒绝额外键：抛出异常，不回喂、不冻结候选", async () => {
  const root = mkRoot();
  const runId = "feedback-extra-key";
  const stub = stubClient([reply(VALID_SCRIPT)]);
  const request = {
    ...requestWith(root, stub, runId, (options) => {
      writeFileSync(
        options.observationsPath,
        '{"matchIndex":0,"delivered":2,"captures":0,"noScoreSource":false,"verdict":"passed"}\n',
      );
      return { passed: true, stdout: "" };
    }),
    scoreSourceFeedback: true,
  };
  await expect(
    generateOneModel(request, { ...firstModelConfig(root), protocolRounds: 3 }),
  ).rejects.toThrow("试跑观测协议违约");
  expect(stub.calls).toHaveLength(1);
  expect(existsSync(join(root, "archive", "alpha", runId))).toBe(false);
  expect(existsSync(join(root, "archive", "alpha", `observed-${runId}.jsonl`))).toBe(false);
  expect(readdirSync(join(root, "archive", "alpha"))).toEqual([
    `observed-${runId}-round-1.jsonl`,
    `observed-${runId}-round-1.jsonl.candidate.js`,
    `observed-${runId}-round-1.jsonl.candidate.ts`,
  ]);
});

it("最终观测旁挂复制失败只警告，已通过候选仍返回 frozen 并保留三件套", async () => {
  const root = mkRoot();
  const runId = "feedback-copy-failure";
  const finalPath = join(root, "archive", "alpha", `observed-${runId}.jsonl`);
  mkdirSync(finalPath, { recursive: true });
  const stub = stubClient([reply(VALID_SCRIPT), reply(VALID_SCRIPT), reply(VALID_SCRIPT)]);
  let observed = "";
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const outcome = await generateOneModel(
      {
        ...requestWith(root, stub, runId, (options) => {
          const readings = gridReadings(options.plan!, () => ({ delivered: 2, captures: 0 }));
          observed = observationJsonl(readings);
          writeGridEvidence(options, readings);
          return { passed: true, stdout: "" };
        }),
        scoreSourceFeedback: true,
      },
      { ...firstModelConfig(root), protocolRounds: 3 },
    );
    expect(outcome.kind).toBe("frozen");
    if (outcome.kind !== "frozen") return;
    expect(outcome.meta.validation.passed).toBe(true);
    expect(outcome.meta.protocolRounds).toBe(3);
    expect(readFileSync(join(outcome.dir, "script.ts"), "utf8")).toBe(VALID_SCRIPT);
    expect(readFileSync(join(outcome.dir, "script.js"), "utf8").length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(outcome.dir, "meta.json"), "utf8"))).toEqual(outcome.meta);
    expect(
      readFileSync(join(root, "archive", "alpha", `observed-${runId}-round-1.jsonl`), "utf8"),
    ).toBe(observed);
    // 成对发布：观测那份没发出去，旁挂汇总也不许单独出现。
    expect(existsSync(`${finalPath}${TRIAL_GRID_SUMMARY_SUFFIX}`)).toBe(false);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0]?.[0]).toContain("警告");
    expect(stderr.mock.calls[0]?.[0]).toContain(finalPath);
  } finally {
    stderr.mockRestore();
  }
});

it("成对发布：汇总那份失败时观测那份也不留，且不留临时文件", { timeout: 30_000 }, async () => {
  const root = mkRoot();
  const runId = "feedback-pair-failure";
  const finalPath = join(root, "archive", "alpha", `observed-${runId}.jsonl`);
  const finalSummaryPath = `${finalPath}${TRIAL_GRID_SUMMARY_SUFFIX}`;
  // 汇总的落点被一个目录占着 → 复制到临时名没问题，rename 成真名必失败；
  // 这时观测那份已经被 rename 成真名了，必须被撤回（否则就是半套）。
  mkdirSync(finalSummaryPath, { recursive: true });
  const stub = stubClient([reply(VALID_SCRIPT), reply(VALID_SCRIPT), reply(VALID_SCRIPT)]);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const outcome = await generateOneModel(
      {
        ...requestWith(root, stub, runId, (options) => {
          writeGridEvidence(options, gridReadings(options.plan!));
          return { passed: true, stdout: "" };
        }),
        scoreSourceFeedback: true,
      },
      { ...firstModelConfig(root), protocolRounds: 3 },
    );
    // 发布只属旁证：失败不翻转已通过候选的结论。
    expect(outcome.kind).toBe("frozen");
    // 两份都不在：观测那份没有留下来，汇总那份仍是原来那个目录。
    expect(existsSync(finalPath)).toBe(false);
    expect(statSync(finalSummaryPath).isDirectory()).toBe(true);
    // 临时文件也清干净（下一次生成不会在归档目录里捡到半截旁证）。
    expect(
      readdirSync(join(root, "archive", "alpha")).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0]?.[0]).toContain("警告");
    expect(stderr.mock.calls[0]?.[0]).toContain(finalSummaryPath);
  } finally {
    stderr.mockRestore();
  }
});

it("opt-in 存档拒绝撞名时不发布最终观测，既有最终候选旁证不被覆盖", async () => {
  const root = mkRoot();
  const runId = "feedback-collision";
  const finalPath = join(root, "archive", "alpha", `observed-${runId}.jsonl`);
  mkdirSync(join(root, "archive", "alpha", runId), { recursive: true });
  const previous = '{"matchIndex":0,"delivered":9,"captures":0,"noScoreSource":false}\n';
  writeFileSync(finalPath, previous);
  const outcome = await generateOneModel(
    {
      ...requestWith(
        root,
        stubClient([reply(VALID_SCRIPT), reply(VALID_SCRIPT), reply(VALID_SCRIPT)]),
        runId,
        (options) => {
          writeGridEvidence(options, gridReadings(options.plan!));
          return { passed: true, stdout: "" };
        },
      ),
      scoreSourceFeedback: true,
    },
    { ...firstModelConfig(root), protocolRounds: 1 },
  );
  expect(outcome.kind).toBe("failed");
  if (outcome.kind === "failed") {
    expect(outcome.failure.candidates?.map((candidate) => candidate.stage)).toEqual([0, 1]);
  }
  expect(readFileSync(finalPath, "utf8")).toBe(previous);
});

it.each(["chat-completions", "messages", "responses", "generate-content"] as const)(
  "规范参数从配置到生成调用及归档保持一致，默认无额外探测：%s",
  async (family) => {
    const root = mkRoot();
    const policy = policyFixture(family, "unverified");
    const model: ModelConfig = {
      ...firstModelConfig(root),
      endpointFamily: family,
      generationPolicy: {
        ...policy,
        output:
          family === "messages"
            ? { ...policy.output, maxTokens: 32768 }
            : {
                field: "server-default",
                includesReasoning: "unknown",
                official: policy.output.official,
                channel: policy.output.channel,
              },
      },
    };
    const stub = stubClient([
      reply(VALID_SCRIPT, { usage: { input_tokens: 12, provider_error: "PRIVATE" } }),
    ]);
    const outcome = await generateOneModel(requestWith(root, stub, "canonical-policy"), model);
    expect(stub.calls).toHaveLength(1);
    expect(callAt(stub, 0).params).toEqual(family === "messages" ? { max_tokens: 32768 } : {});
    expect(callAt(stub, 0).messages[0]?.content).toContain(CONTRACT_RULES.trim());
    expect(callAt(stub, 0).messages[0]?.content).toContain(CONTRACT_API.trim());
    expect(outcome.kind).toBe("frozen");
    if (outcome.kind !== "frozen") throw new Error("规范 fixture 未冻结");
    expect(parsedLog(outcome.meta)[0]).toMatchObject({
      params: callAt(stub, 0).params,
      usage: { input_tokens: 12 },
      responseConverged: true,
      requestEvidence: {
        configId: model.slug,
        endpointFamily: model.endpointFamily,
        backendIdentity: "unverified",
        policy: { reasoning: { intent: "high", control: "unverified" } },
        diagnostics: expect.arrayContaining(["high 未发送：渠道推理控制未验证"]),
      },
      attemptEvidence: [{ attempt: 1, outcome: "response", usage: { input_tokens: 12 } }],
    });
    expect(outcome.meta.generationLog.join()).not.toContain("PRIVATE");
  },
);

it.each(["chat-completions", "messages", "responses", "generate-content"] as const)(
  "规范参数在截断、传输重试和编译修复中保持不变，用量分开记录：%s",
  async (family) => {
    const root = mkRoot();
    const model = {
      ...firstModelConfig(root),
      endpointFamily: family,
      generationPolicy: policyFixture(family),
    };
    const stub = stubClient([
      reply("PRIVATE truncated response", {
        finishReason: "length",
        usage: { output_tokens: 8192, total_tokens: 8200, provider_error: "PRIVATE" },
      }),
      fail(new TransportError("PRIVATE provider error body", { retryable: true, status: 503 })),
      reply(TSC_FAIL_SCRIPT, { usage: { input_tokens: 10, output_tokens: 4 } }),
      reply(VALID_SCRIPT),
    ]);
    vi.useFakeTimers();
    try {
      const pending = generateOneModel(requestWith(root, stub, "retry-policy"), model);
      await vi.runAllTimersAsync();
      const outcome = await pending;
      expect(outcome.kind).toBe("frozen");
      if (outcome.kind !== "frozen") throw new Error("重试 fixture 未冻结");
      expect(stub.calls).toHaveLength(4);
      for (const call of stub.calls) expect(call.params).toEqual(generationParams(model));
      expect(callAt(stub, 1).messages).toEqual(callAt(stub, 0).messages);
      expect(callAt(stub, 2).messages).toEqual(callAt(stub, 0).messages);
      expect(callAt(stub, 3).messages[2]?.content).toContain("TS2304");
      expect(outcome.meta.protocolRounds).toBe(2);
      const logs = parsedLog(outcome.meta);
      expect(logs[0]?.usage).toEqual({ input_tokens: 10, output_tokens: 4 });
      expect(logs[0]?.attemptEvidence).toEqual([
        {
          attempt: 1,
          outcome: "response",
          finishReason: "length",
          usage: { output_tokens: 8192, total_tokens: 8200 },
        },
        { attempt: 2, outcome: "transport-error" },
        {
          attempt: 3,
          outcome: "response",
          finishReason: "stop",
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      ]);
      expect(logs[1]).not.toHaveProperty("usage");
      expect(outcome.meta.generationLog.join()).not.toContain("PRIVATE");
    } finally {
      vi.useRealTimers();
    }
  },
);

it("规范传输耗尽保留全部尝试的白名单证据，不增加已收敛轮数或伪造零用量", async () => {
  const root = mkRoot();
  const model = { ...firstModelConfig(root), generationPolicy: policyFixture("chat-completions") };
  const stub = stubClient(
    Array.from({ length: RETRY.maxRetries + 1 }, () =>
      reply("PRIVATE", {
        finishReason: "length",
        usage: { output_tokens: 8192, provider_error: "PRIVATE" },
      }),
    ),
  );
  vi.useFakeTimers();
  try {
    const pending = generateOneModel(requestWith(root, stub, "failed-policy"), model);
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("耗尽 fixture 不应冻结");
    expect(outcome.failure.prompts).toEqual([]);
    expect(outcome.failure.classification).toBe("transport");
    expect(outcome.failure.generationLog).toHaveLength(1);
    const [log] = parsedLog(outcome.failure);
    expect(log).toMatchObject({
      round: 1,
      kind: "transport",
      responseConverged: false,
      params: generationParams(model),
      requestEvidence: { configId: model.slug },
      attemptEvidence: Array.from({ length: RETRY.maxRetries + 1 }, (_, index) => ({
        attempt: index + 1,
        outcome: "response",
        finishReason: "length",
        usage: { output_tokens: 8192 },
      })),
    });
    expect(log).not.toHaveProperty("usage");
    expect(outcome.failure.generationLog.join()).not.toContain("PRIVATE");
    expect(existsSync(join(root, "archive", model.slug, "failed-policy"))).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("直接编排非法政策在建客户端及产物前拒绝", async () => {
  const root = mkRoot();
  const stub = stubClient([reply(VALID_SCRIPT)]);
  const createClient = vi.fn(() => stub);
  await expect(
    generateOneModel(
      { ...requestWith(root, stub, "invalid-policy"), createClient },
      {
        ...firstModelConfig(root),
        params: { temperature: 0 },
        generationPolicy: policyFixture("chat-completions"),
      },
    ),
  ).rejects.toThrow("不可与 params 混用");
  expect(createClient).not.toHaveBeenCalled();
  expect(existsSync(join(root, "archive"))).toBe(false);
});

/** 注入只提供外部 JSON；生产 CLI 对完整证据重算，不信任这里给的分数。 */
const canonicalSelectionFixture = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalSelectionFixture).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSelectionFixture(Reflect.get(value, key))}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
/** 选拔 probe 的入参（注入桩拿到的就是这一份：计划 + 三份候选的阶段证据路径）。 */
type SelectionStubOptions = Parameters<import("./selection.js").SelectionProbe>[0];

type StubGridRow = {
  readonly matchIndex: number;
  readonly terminalSummary: {
    readonly players: readonly { readonly seat: number; readonly rank: number }[];
  };
};
type StubGridSummary = {
  readonly plan: TrialPlan;
  readonly scriptSha256: string;
  readonly score: {
    readonly totalPoints: number;
    readonly averagePoints: number;
    readonly countedMatches: number;
  };
};

/**
 * 选拔记录（v2）：**从桩写下的证据**读出来，而不是凭空造一份。
 *
 * 生成管线的选拔记录必须与盘上的观测行、`.grid.json` 对得上——`--validate` 那一遍由真实 CLI
 * 跑，它会把这份记录重新解释一遍再比。所以夹具照同一条路走：读候选的观测与汇总、按计划算逐场
 * 摘要与积分、按均分定胜者。谁分高由**桩写下的名次**决定，fixture 不自己指定胜者。
 */
const gridSelectionFixture = (options: SelectionStubOptions) => {
  const plan = options.expectedPlan;
  const candidates = options.candidates.map(
    ({ stage, protocolRound, scriptSha256, sourceSha256, observationsPath, gridSummaryPath }) => {
      const rows = readFileSync(observationsPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as StubGridRow);
      const summary = JSON.parse(readFileSync(gridSummaryPath, "utf8")) as StubGridSummary;
      const prior = options.candidates.find((entry) => entry.scriptSha256 === scriptSha256)!;
      const matches = plan.matches.map((match) => {
        const row = rows.find((entry) => entry.matchIndex === match.matchIndex)!;
        const ranks = [...row.terminalSummary.players]
          .sort((left, right) => left.seat - right.seat)
          .map((player) => player.rank);
        return {
          matchIndex: match.matchIndex,
          inputSha256: sha256Hex(
            canonicalSelectionFixture({
              planSha256: plan.planSha256,
              scriptSha256,
              match,
            }),
          ),
          observationSha256: sha256Hex(canonicalSelectionFixture(row)),
          candidatePoints: pointsOfRanks(ranks)[match.candidateSeat]!,
        };
      });
      return {
        stage,
        protocolRound,
        scriptSha256,
        sourceSha256,
        score: summary.score,
        matches,
        ...(prior.stage < stage ? { reusedFromStage: prior.stage } : {}),
      };
    },
  );
  const ranked = [...candidates].sort(
    (left, right) =>
      right.score.averagePoints - left.score.averagePoints || right.stage - left.stage,
  );
  const chosen = ranked[0]!;
  const { stage, protocolRound, scriptSha256, sourceSha256 } = chosen;
  return {
    version: 2,
    plan,
    candidates,
    selected: { stage, protocolRound, scriptSha256, sourceSha256 },
    reason:
      chosen.score.averagePoints !== ranked[1]!.score.averagePoints
        ? "highest-average-points"
        : "later-stage",
  };
};
const selectionRoot = (): string => {
  const root = mkRoot();
  for (const name of ["apps", "maps", "benchmarks"])
    symlinkSync(join(repoRoot, name), join(root, name), "dir");
  return root;
};
const selectionTrial: NonNullable<GenerationRequest["trial"]> = (options) => {
  writeGridEvidence(options);
  return { passed: true, stdout: "" };
};

it.each([false, true])(
  "两次回喂各带本阶段 32 场三层事实与同格变化，最终保存且选拔开关%s不回喂",
  async (selectBestCandidate) => {
    const root = selectionRoot();
    const runId = "terminal-two-feedback";
    const stub = stubClient([
      reply(VALID_SCRIPT),
      reply("function loop() { return 9; }\n"),
      reply("function loop() { return 10; }\n"),
    ]);
    let stage = 0;
    const outcome = await generateOneModel(
      {
        ...requestWith(root, stub, runId, (options) => {
          if (options.plan === undefined) throw new Error("试跑桩需要计划");
          // 前两个阶段四方并列（两次回喂的对差表因此稳定）；第三阶段候选全败，于是选拔按
          // 「平均分 → 较晚阶段」选中 stage1——选拔不产生新判别依据，胜者由生成阶段的分数决定。
          // 每阶段把「资源点」抬一格：两次回喂的文本因此可区分，第二次的对差表还带着与上一阶段的同格变化。
          // 前两个阶段四方并列（领土 6 → 7）；第三个阶段候选全败（名次由领土分决定）。
          const readings =
            stage === 2
              ? gridReadingsAtRank(options.plan, 4, stage)
              : gridReadings(options.plan).map((reading) => ({
                  ...reading,
                  terminalSummary: (() => {
                    const summary = terminalSummaryFixture(
                      reading.terminalSummary!.seed,
                      "timeout",
                      reading.terminalSummary!.players.map(
                        (player) => player.player,
                      ) as unknown as readonly [string, string, string, string],
                    );
                    for (const player of summary.players) {
                      player.controlledResources += stage;
                      player.score.resources += stage;
                      player.territoryScore += stage;
                    }
                    return summary;
                  })(),
                }));
          writeGridEvidence(options, readings);
          stage += 1;
          return { passed: true, stdout: "" };
        }),
        scoreSourceFeedback: true,
        selectBestCandidate,
        selection: (options) => {
          expect(stub.calls).toHaveLength(3);
          // 选拔用的计划就是生成阶段那张网格：32 场、每格一个种子、候选四个座位各坐一次。
          expect(options.expectedPlan.matches).toHaveLength(32);
          expect(options.expectedPlan.matches.map((match) => match.seed).slice(0, 3)).toEqual([
            5000, 5001, 5002,
          ]);
          expect(
            [...new Set(options.expectedPlan.matches.map((match) => match.candidateSeat))].sort(),
          ).toEqual([0, 1, 2, 3]);
          return gridSelectionFixture(options);
        },
      },
      firstModelConfig(root),
    );
    expect(outcome.kind).toBe("frozen");
    expect(stub.calls).toHaveLength(3);
    expect(stage).toBe(3);
    const first = callAt(stub, 1).messages[2]?.content ?? "";
    const second = callAt(stub, 2).messages[4]?.content ?? "";
    for (const feedback of [first, second]) {
      expect(feedback).toContain("试跑观测：本候选实际完成的 32 个对局。");
      // 逐场一行 = 计划场数；每行三列事实齐全（名次 / 四方领土分 / 结束原因）。
      expect(feedback.match(/^  #\d{2} \| .+ \| timeout$/gm)).toHaveLength(32);
      // 只展开最差三场：三块明细，不是 32 块。
      expect(feedback.match(/^- 第 \d+ 个对局：/gm)).toHaveLength(3);
      expect(feedback).toContain("名次=1，名次积分=1.5");
      expect(feedback).not.toMatch(
        /请检查|建议|应该|坐标|987654|401|402|403|highest-average-points|candidatePoints/,
      );
    }
    // 第一阶段没有对照：八格都写「无上一阶段」。
    expect(first.match(/无上一阶段/g)).toHaveLength(8);
    expect(first).toContain("平均领土分 6.00（第一名 6.00，分差 0.00）");
    // 第二阶段给出同一格的变化：本测试只抬领土分，四方同抬，所以名次积分与分差都不变。
    expect(second).not.toContain("无上一阶段");
    expect(second.match(/与上一阶段同一格：Δ平均名次积分 \+0\.00，Δ分差 \+0\.00/g)).toHaveLength(8);
    expect(second).toContain("平均领土分 7.00（第一名 7.00，分差 0.00）");
    // 领土分从 6 抬到 7：逐场行与最差三场明细都跟着变，前一轮的数字不再出现。
    expect(first).toContain("| 1 | 6/6/6/6 | timeout");
    expect(second).toContain("| 1 | 7/7/7/7 | timeout");
    expect(second).not.toContain("6/6/6/6");
    expect(second).not.toContain("领土分=6，");
    // 每阶段 3 场明细 × 四方 = 12 行领土分（逐场行里是 `a/b/c/d`，不是这套逐方明细）。
    expect(first.match(/领土分=6，/g)).toHaveLength(12);
    expect(first).not.toContain("领土分=7，");
    expect(second.match(/领土分=7，/g)).toHaveLength(12);
    expect(second).not.toContain("领土分=6，");
    expect(
      stub.calls
        .flatMap((call) => call.messages)
        .map((message) => message.content)
        .join("\n"),
    ).not.toContain("领土分=8，");
    const finalPath = join(root, "archive", "alpha", `observed-${runId}-round-3.jsonl`);
    const finalReadings = readFileSync(finalPath, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            terminalSummary: { seed: number; players: { rank: number; territoryScore: number }[] };
          },
      );
    expect(finalReadings.map((reading) => reading.terminalSummary.seed)).toEqual(
      Array.from({ length: 32 }, (_, index) => 5000 + index),
    );
    // 第三阶段候选全败：四方名次是 1/2/3/4 各一，领土分随名次递减（不是四方并列）。
    for (const reading of finalReadings)
      expect(reading.terminalSummary.players.map((player) => player.rank).sort()).toEqual([
        1, 2, 3, 4,
      ]);
    if (outcome.kind !== "frozen") throw new Error("终局反馈未完成定版");
    expect(outcome.meta.optimization?.feedbackRounds).toBe(2);
    expect(outcome.meta.optimization?.candidates).toHaveLength(3);
    expect(outcome.meta.selection?.selected.stage).toBe(selectBestCandidate ? 1 : undefined);
  },
);

it.each([0, 1, 2])(
  "独立选拔 stage %i 胜者：主编排冻结其原始 TS/JS 字节，模型仍为三次",
  async (winner) => {
    const root = selectionRoot();
    const sources = [
      VALID_SCRIPT,
      "// 中间源码原字节\nfunction loop() { return 9; }\n",
      "function loop() { return 10; }\n",
    ];
    const stub = stubClient(sources.map((source) => reply(source)));
    const runId = `select-stage-${winner}`;
    // 每阶段的名次不同：只有 `winner` 那一阶段候选全胜（其余全败）。选拔按生成阶段的分数定版，
    // 所以「谁赢」由试跑证据决定，probe 只是把证据解释成记录。
    let invocation = 0;
    const outcome = await generateOneModel(
      {
        ...requestWith(root, stub, runId, (options) => {
          if (options.plan === undefined) throw new Error("试跑桩需要计划");
          writeGridEvidence(
            options,
            gridReadingsAtRank(options.plan, invocation === winner ? 1 : 4),
          );
          invocation += 1;
          return { passed: true, stdout: "" };
        }),
        scoreSourceFeedback: true,
        selectBestCandidate: true,
        selection: (options) => {
          expect(stub.calls).toHaveLength(3);
          return gridSelectionFixture(options);
        },
      },
      firstModelConfig(root),
    );
    expect(outcome.kind).toBe("frozen");
    expect(stub.calls).toHaveLength(3);
    if (outcome.kind !== "frozen") throw new Error(outcome.failure.message);
    expect(outcome.meta.selection?.selected.stage).toBe(winner);
    expect(outcome.meta.selection?.reason).toBe("highest-average-points");
    expect(outcome.meta.optimization?.candidates[2]?.stage).toBe(2);
    expect(readFileSync(join(outcome.dir, "script.ts"))).toEqual(Buffer.from(sources[winner]!));
    for (const ext of ["ts", "js"])
      expect(readFileSync(join(outcome.dir, `script.${ext}`))).toEqual(
        readFileSync(
          join(
            root,
            "archive",
            "alpha",
            `observed-${runId}-round-${winner + 1}.jsonl.candidate.${ext}`,
          ),
        ),
      );
    expect(
      stub.calls
        .flatMap((call) => call.messages)
        .map((message) => message.content)
        .join("\n"),
    ).not.toMatch(/highest-average-points|candidatePoints|rankings/);
  },
);

it.each([
  "missing-match",
  "missing-terminal",
  "forged-score",
  "wrong-candidate",
  "wrong-environment",
  "throw",
  "legacy-stage-rule",
  "mutate-plan",
  "mutate-ts",
])("选拔 %s 整次失败：安全分类、三阶段留证、零追加请求、零发布", async (failure) => {
  const root = selectionRoot();
  const stub = stubClient([
    reply(VALID_SCRIPT),
    reply("function loop() { return 9; }\n"),
    reply("function loop() { return 10; }\n"),
  ]);
  const outcome = await generateOneModel(
    {
      ...requestWith(root, stub, "select-failed", selectionTrial),
      scoreSourceFeedback: true,
      selectBestCandidate: true,
      selection: (options) => {
        const selection = gridSelectionFixture(options);
        if (failure === "legacy-stage-rule") {
          // 新选拔结果不得使用历史决胜规则：v2 的形状里就没有这一栏。
          Reflect.set(selection, "reason", "earlier-stage");
        }
        if (failure === "throw") throw new Error("credential provider-body PROMPT-SECRET");
        if (failure === "missing-match") selection.candidates[0]!.matches.pop();
        if (failure === "missing-terminal")
          Reflect.deleteProperty(selection.candidates[0]!.matches[0]!, "observationSha256");
        if (failure === "forged-score")
          Reflect.set(selection.candidates[0]!.score, "averagePoints", 3);
        if (failure === "wrong-candidate") selection.candidates[0]!.sourceSha256 = "a".repeat(64);
        if (failure === "wrong-environment") {
          // 记录里的计划与生成阶段的计划不同源（换一张图，摘要一起换；形状仍合法）。
          const body = {
            ...selection.plan,
            maps: [{ ...selection.plan.maps[0]!, sha256: "c".repeat(64) }, selection.plan.maps[1]!],
          };
          Reflect.deleteProperty(body, "planSha256");
          selection.plan = { ...body, planSha256: sha256Hex(canonicalSelectionFixture(body)) };
          for (const candidate of selection.candidates)
            for (const match of candidate.matches)
              match.inputSha256 = sha256Hex(
                canonicalSelectionFixture({
                  planSha256: selection.plan.planSha256,
                  scriptSha256: candidate.scriptSha256,
                  match: selection.plan.matches[match.matchIndex],
                }),
              );
        }
        if (failure === "mutate-plan") Reflect.set(options.expectedPlan.matches[0]!, "seed", 999);
        if (failure === "mutate-ts") writeFileSync(options.candidates[1]!.sourcePath, "tampered");
        return selection;
      },
    },
    firstModelConfig(root),
  );
  expect(outcome.kind).toBe("failed");
  expect(stub.calls).toHaveLength(3);
  expect(existsSync(join(root, "archive", "alpha", "select-failed"))).toBe(false);
  if (outcome.kind !== "failed") throw new Error("意外发布");
  expect(outcome.failure.classification).toBe("selection");
  expect(outcome.failure.candidates?.map((candidate) => candidate.stage)).toEqual([0, 1, 2]);
  expect(outcome.failure.selectionFailure?.candidates).toHaveLength(3);
  expect(JSON.stringify([outcome.failure.message, outcome.failure.diagnostics])).not.toMatch(
    /credential|provider-body|PROMPT-SECRET/,
  );
  expect(
    readdirSync(join(root, "archive", "alpha")).filter((name) => name.endsWith(".candidate.js")),
  ).toHaveLength(3);
});

it("重复 JS 不合并三个 TS/阶段身份，同分冻结最终阶段的确切源码", async () => {
  const root = selectionRoot();
  const sources = [
    "type First = number;\nfunction loop() {}\n",
    "type Middle = number;\nfunction loop() {}\n",
    "type Final = number;\nfunction loop() {}\n",
  ];
  const stub = stubClient(sources.map((source) => reply(source)));
  const outcome = await generateOneModel(
    {
      ...requestWith(root, stub, "select-duplicate", selectionTrial),
      scoreSourceFeedback: true,
      selectBestCandidate: true,
      selection: (options) => gridSelectionFixture(options),
    },
    firstModelConfig(root),
  );
  expect(outcome.kind).toBe("frozen");
  if (outcome.kind !== "frozen") throw new Error(outcome.failure.message);
  expect(outcome.meta.selection?.selected.stage).toBe(2);
  expect(outcome.meta.selection?.reason).toBe("later-stage");
  expect(
    new Set(outcome.meta.selection?.candidates.map((candidate) => candidate.scriptSha256)).size,
  ).toBe(1);
  expect(
    new Set(outcome.meta.selection?.candidates.map((candidate) => candidate.sourceSha256)).size,
  ).toBe(3);
  expect(readFileSync(join(outcome.dir, "script.ts"), "utf8")).toBe(sources[2]);
});

it("非法选拔开关组合在任何客户端请求前拒绝", async () => {
  const root = mkRoot();
  const stub = stubClient([reply(VALID_SCRIPT)]);
  await expect(
    generateOneModel(
      { ...requestWith(root, stub, "invalid-selection"), selectBestCandidate: true },
      firstModelConfig(root),
    ),
  ).rejects.toThrow("要求 --score-source-feedback");
  await expect(
    runGeneration({
      root,
      configPath: "models.yaml",
      selectBestCandidate: true,
      createClient: () => stub,
    }),
  ).rejects.toThrow("要求 --score-source-feedback");
  expect(stub.calls).toHaveLength(0);
});

it("批次编排把选拔失败安全落盘，三个阶段与 TS 身份均保留", async () => {
  const root = selectionRoot();
  const stub = stubClient([
    reply(VALID_SCRIPT),
    reply("function loop() { return 9; }\n"),
    reply("function loop() { return 10; }\n"),
  ]);
  const code = await runGeneration({
    root,
    configPath: "models.yaml",
    createClient: () => stub,
    trial: selectionTrial,
    trialPlan: () => gridPlanFixture(),
    scoreSourceFeedback: true,
    selectBestCandidate: true,
    selection: () => {
      throw new Error("SECRET-provider");
    },
  });
  expect(code).toBe(1);
  expect(stub.calls).toHaveLength(3);
  const files = readdirSync(join(root, "archive", "alpha"));
  const failed = files.find((file) => file.startsWith("failed-"));
  expect(failed).toBeDefined();
  const record: import("@model-war/schema").FailureRecord = JSON.parse(
    readFileSync(join(root, "archive", "alpha", failed!), "utf8"),
  );
  expect(record.classification).toBe("selection");
  expect(record.protocolRounds).toBe(3);
  expect(record.candidates?.map((candidate) => candidate.stage)).toEqual([0, 1, 2]);
  expect(
    record.selectionFailure?.candidates.map((candidate) => candidate.sourceSha256),
  ).toHaveLength(3);
  // v2：失败旁证里带的是生成阶段那张网格计划（32 场），不是另一套 12 场的选拔计划。
  expect(record.selectionFailure?.plan.matches).toHaveLength(32);
  expect(JSON.stringify(record)).not.toContain("SECRET-provider");
  expect(files.every((file) => !file.startsWith(".tmp-"))).toBe(true);
});

it(
  "真实选拔子进程拒绝与安装面不同源的网格计划：整次失败、零发布、三阶段留证",
  { timeout: 30_000 },
  async () => {
    // 安装面里没有四份陪练的冻结存档（`archive/` 不入库），选拔子进程无法把计划从 root + model
    // 重建出来——这正是「计划同源」这条硬判据的失败路径：整次生成失败，不是候选不合格。
    const root = selectionRoot();
    const sources = [
      "type First = number;\nfunction loop() {}\n",
      "type Middle = number;\nfunction loop() {}\n",
      "type Final = number;\nfunction loop() {}\n",
    ];
    const stub = stubClient(sources.map((source) => reply(source)));
    const outcome = await generateOneModel(
      {
        ...requestWith(root, stub, "real-selection", selectionTrial),
        scoreSourceFeedback: true,
        selectBestCandidate: true,
      },
      firstModelConfig(root),
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("安装面缺陪练档时不得发布");
    expect(stub.calls).toHaveLength(3);
    expect(outcome.failure.classification).toBe("selection");
    expect(outcome.failure.candidates?.map((candidate) => candidate.stage)).toEqual([0, 1, 2]);
    expect(existsSync(join(root, "archive", "alpha", "real-selection"))).toBe(false);
    // 三阶段证据仍在（选拔失败不改写候选旁挂），消息里不出现路径与陪练档细节。
    expect(
      readdirSync(join(root, "archive", "alpha")).filter((name) => name.endsWith(".candidate.js")),
    ).toHaveLength(3);
    expect(JSON.stringify(outcome.failure.message)).not.toContain("/");
  },
);

it("未完成第三阶段的传输失败不调用选拔救回旧候选，保留 01 未收敛末行", async () => {
  const root = selectionRoot();
  const stub = stubClient([
    reply(VALID_SCRIPT),
    reply("function loop() { return 9; }\n"),
    fail(new TransportError("local-rejected", { retryable: false, status: 400 })),
  ]);
  const probe = vi.fn(() => {
    throw new Error("不应调用选拔");
  });
  const outcome = await generateOneModel(
    {
      ...requestWith(root, stub, "select-incomplete", selectionTrial),
      scoreSourceFeedback: true,
      selectBestCandidate: true,
      selection: probe,
    },
    { ...firstModelConfig(root), generationPolicy: policyFixture("chat-completions") },
  );
  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") throw new Error("意外冻结");
  expect(probe).not.toHaveBeenCalled();
  expect(stub.calls).toHaveLength(3);
  expect(outcome.failure.classification).toBe("transport");
  expect(outcome.failure.candidates?.map((candidate) => candidate.stage)).toEqual([0, 1]);
  expect(outcome.failure.prompts).toHaveLength(2);
  expect(outcome.failure.generationLog).toHaveLength(3);
  expect(JSON.parse(outcome.failure.generationLog[2]!)).toMatchObject({
    round: 3,
    kind: "transport",
    responseConverged: false,
  });
  expect(existsSync(join(root, "archive", "alpha", "select-incomplete"))).toBe(false);
});
