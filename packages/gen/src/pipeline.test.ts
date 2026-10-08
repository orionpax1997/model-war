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
import { afterAll, expect, it, vi } from "vitest";

import { sha256Hex } from "./archive.js";
import { compileScript } from "./compile.js";
import { loadModelsConfig, type ModelConfig } from "./config.js";
import { readRuleDocs } from "./contract.js";
import { generateOneModel, type ModelOutcome } from "./pipeline.js";
import { loadBaseTemplate } from "./prompt.js";
import { RETRY } from "./retry.js";
import { runGeneration, type GenerationRequest } from "./run.js";
import { fail, replies, reply, stubClient, type StubCall, type StubClient } from "./stub-client.js";
import { TransportError } from "./transport-error.js";
import { scriptSizeLimit, validateScript } from "./validate.js";

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
  expect(readdirSync(slugDir)).toEqual([]);
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

// ───────────────────────── 票 06:传输韧性(退避重试不消耗协议轮数) ─────────────────────────
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
    // 失败只返回结构,不建存档(写盘归票 05),也不留半截 / 临时目录。
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
