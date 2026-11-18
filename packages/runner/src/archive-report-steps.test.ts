/**
 * 档案 v3 的报告读侧：过程记录、步级度量与受污染分层（ADR-0035 / ADR-0036）。
 *
 * ── 为什么这些用例住在 runner，而不是 CLI 的 v3 往返测试里 ──
 *
 * `apps/cli/src/archive-v3.test.ts` 判的是「写 → 装载 → 读出」这条链**通不通**（它要同时碰
 * gen、cli 与 runner，只能在 CLI）。本文件判的是报告**读出来的数对不对**：分位、增长、左连接
 * 的不匹配计数、受污染分层，全是 runner 自己的判据，所以由合成 v3 档喂 `readArchiveReports`
 * 起手——runner 不得 import gen（hld §3.2），合成档因此是**手写的 JSON**，不是生成管线产物。
 *
 * ── 旧档（v1 / v2）用入库 fixture，不碰 `archive/` ──
 *
 * `packages/runner/src/fixtures/archive/` 是从真实档案抽出来的副本（来源与改写清单见那里的
 * README）。`archive/` 被 `.gitignore` 忽略，测试不能依赖它。
 */

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { TRIAL_MATCHES_PER_CANDIDATE } from "@model-war/schema";
import { afterAll, expect, it } from "vitest";

import { readArchiveReports, runArchiveReport } from "./archive-report.js";
import { CONTAMINATION_THRESHOLDS, stepGroupsOf } from "./archive-report-steps.js";

const scratch = mkdtempSync(join(tmpdir(), "modelwar-archive-steps-"));
afterAll(() => rmSync(scratch, { force: true, recursive: true }));
const rootOf = (): string => mkdtempSync(join(scratch, "root-"));

const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/archive", import.meta.url));

const sha256Of = (text: string): string => createHash("sha256").update(text).digest("hex");

const SCRIPT = (tag: string): string => `function loop() {\n  return "${tag}";\n}\nloop();\n`;

/**
 * 用量读数：chat 族形状（`prompt_tokens` + `prompt_tokens_details.cached_tokens`）。
 *
 * 不用 messages 族的三项（`input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`）：
 * 那一族的「完整输入」要求三项齐全（`normalizeUsage` 的口径），只给两项会被读成未知——
 * 本文件要测的是步级度量，不是用量口径。
 */
const usageOf = (promptTokens: number, cachedTokens: number): Record<string, unknown> => ({
  prompt_tokens: promptTokens,
  completion_tokens: 10,
  prompt_tokens_details: { cached_tokens: cachedTokens },
});

type StepInput = {
  readonly action: "bash" | "evaluate" | "done" | "none";
  readonly atMs: number;
  readonly harnessMs: number;
  readonly result?: { readonly kind: "tsc" | "contract"; readonly errorCodes: readonly string[] };
  readonly exitCode?: number;
};

type V3Input = {
  readonly slug: string;
  readonly runId: string;
  /** 步号 = 下标 + 1；要给「步号不连续」的档就传 `stepNumbers` 覆盖。 */
  readonly steps: readonly StepInput[];
  readonly stepNumbers?: readonly number[];
  readonly logs: readonly Record<string, unknown>[];
  readonly evaluateSteps?: readonly number[];
  readonly modelVersion?: string;
  readonly harnessVersion?: string;
  readonly harnessDigest?: string;
  readonly contextLength?: number;
  readonly termination?: string;
  readonly atStep?: number;
  /** `false` = 造一个「声明了 v3、却没有过程记录」的档（读侧必须拒读，不许静默当旧档）。 */
  readonly withSteps?: boolean;
};

/**
 * 一份合成 v3 成功档：`steps` 与 `generationLog` 各按输入写，`evaluate` 那几步各产一个候选。
 *
 * 侧车（`.candidate.js` / `.candidate.ts`）与冻结的 `script.js` / `script.ts` 都真写，所以报告
 * 的 `scriptState` 是 `verified`——那是「候选按位置可读」里最要紧的一半。
 */
const writeV3 = (root: string, input: V3Input): void => {
  const slugDir = join(root, "archive", input.slug);
  const runDir = join(slugDir, input.runId);
  mkdirSync(runDir, { recursive: true });
  const stepNumbers = input.stepNumbers ?? input.steps.map((_, index) => index + 1);
  const steps = input.steps.map((step, index) => ({
    step: stepNumbers[index]!,
    action:
      step.action === "bash"
        ? { kind: "bash", command: "cat /contract/README.md" }
        : { kind: step.action },
    stdout: step.action === "evaluate" ? "[evaluate] ok\n" : "",
    stderr: "",
    exitCode: step.exitCode ?? 0,
    atMs: step.atMs,
    harnessMs: step.harnessMs,
    ...(step.result === undefined ? {} : { result: step.result }),
  }));
  const candidates = (input.evaluateSteps ?? []).map((step, index) => {
    const observationsFile = `observed-${input.runId}-round-${String(step)}.jsonl`;
    const product = SCRIPT(`candidate-${String(index)}`);
    writeFileSync(join(slugDir, `${observationsFile}.candidate.js`), product);
    writeFileSync(join(slugDir, `${observationsFile}.candidate.ts`), product);
    return {
      step,
      scriptFile: `${observationsFile}.candidate.js`,
      observationsFile,
      scriptSha256: sha256Of(product),
      score: {
        totalPoints: TRIAL_MATCHES_PER_CANDIDATE / 4 + index,
        averagePoints: (TRIAL_MATCHES_PER_CANDIDATE / 4 + index) / TRIAL_MATCHES_PER_CANDIDATE,
        countedMatches: TRIAL_MATCHES_PER_CANDIDATE,
      },
      matchCount: TRIAL_MATCHES_PER_CANDIDATE,
    };
  });
  const last = candidates[candidates.length - 1];
  const frozen = SCRIPT(`candidate-${String(Math.max(0, candidates.length - 1))}`);
  writeFileSync(join(runDir, "script.js"), frozen);
  writeFileSync(join(runDir, "script.ts"), frozen);
  const record = {
    archiveSchemaVersion: 3,
    model: input.slug,
    modelVersion: input.modelVersion ?? "fixture/v3-model",
    generatedAt: "2026-01-02T00:00:00.000Z",
    protocolRounds: input.steps.length,
    prompts: input.steps.length === 0 ? [] : ["你是策略作者。契约在 /contract。"],
    ...(input.withSteps === false ? {} : { steps }),
    generationLog: input.logs.map((log) => JSON.stringify(log)),
    contextLength: input.contextLength ?? 262144,
    harnessVersion: input.harnessVersion ?? "bash-mini/0.1",
    harnessDigest: input.harnessDigest ?? "3".repeat(64),
    termination: input.termination ?? "done",
    atStep: input.atStep ?? input.steps.length,
    ruleset: "v2",
    validation: { passed: true, errors: [] },
    tscVersion: "7.0.2",
    scriptSha256: last?.scriptSha256 ?? "0".repeat(64),
    sandboxRuntimeHash: "b".repeat(64),
    ...(candidates.length === 0 ? {} : { optimization: { version: 3, candidates } }),
  };
  writeFileSync(join(runDir, "meta.json"), `${JSON.stringify(record, null, 2)}\n`);
};

/** 零步失败档：过程记录为空、协议轮数为零、无优化段（ADR-0031 的合法形状）。 */
const writeZeroStepFailure = (
  root: string,
  input: { readonly slug: string; readonly logs: readonly unknown[] },
): void => {
  const slugDir = join(root, "archive", input.slug);
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(
    join(slugDir, "failed-2026-01-03T00-00-00-001Z.json"),
    `${JSON.stringify(
      {
        archiveSchemaVersion: 3,
        model: input.slug,
        modelVersion: "fixture/v3-model",
        generatedAt: "2026-01-03T00:00:00.000Z",
        runId: "2026-01-03T00-00-00-001Z",
        protocolRounds: 0,
        prompts: [],
        steps: [],
        generationLog: input.logs.map((log) => JSON.stringify(log)),
        contextLength: 262144,
        harnessVersion: "bash-mini/0.1",
        harnessDigest: "3".repeat(64),
        termination: "transport",
        atStep: 0,
        ruleset: "v2",
        validation: { passed: false, errors: ["一次模型调用都没有成功"] },
        tscVersion: "7.0.2",
        scriptSha256: "0".repeat(64),
        sandboxRuntimeHash: "b".repeat(64),
        classification: "transport",
        diagnostics: ["传输重试耗尽（第一次调用）"],
        message: "零步退出",
      },
      null,
      2,
    )}\n`,
  );
};

const markdownOf = async (root: string): Promise<string> => {
  const out: string[] = [];
  const code = await runArchiveReport(["--root", root], {
    stdout: (text) => out.push(text),
    stderr: () => {},
  });
  expect(code).toBe(0);
  return out.join("");
};

const copyFixture = (name: string): string => {
  const root = mkdtempSync(join(scratch, `${name}-`));
  cpSync(join(FIXTURE_ROOT, name), root, { recursive: true });
  return root;
};

// ── 步级度量 ──────────────────────────────────────────────────────────────────

it("v3 三候选：步级 stepMs/sendMs 分位、prompt 大小与增长、命中率按轮=步左连接读出", async () => {
  const root = rootOf();
  writeV3(root, {
    slug: "steps-three",
    runId: "2026-01-04T00-00-00-001Z",
    steps: [
      { action: "bash", atMs: 0, harnessMs: 10, result: { kind: "contract", errorCodes: [] } },
      { action: "evaluate", atMs: 1_000, harnessMs: 20 },
      {
        action: "evaluate",
        atMs: 2_000,
        harnessMs: 30,
        result: { kind: "tsc", errorCodes: ["TS2322"] },
      },
      { action: "done", atMs: 3_000, harnessMs: 1 },
    ],
    logs: [
      {
        round: 1,
        kind: "converged",
        responseConverged: true,
        sendMs: 100,
        usage: usageOf(1_000, 250),
      },
      {
        round: 2,
        kind: "converged",
        responseConverged: true,
        sendMs: 200,
        usage: usageOf(1_500, 300),
      },
      {
        round: 3,
        kind: "converged",
        responseConverged: true,
        sendMs: 300,
        usage: usageOf(1_600, 0),
      },
      {
        round: 4,
        kind: "converged",
        responseConverged: true,
        sendMs: 400,
        usage: usageOf(1_700, 850),
      },
    ],
    evaluateSteps: [2, 3],
  });
  const [report] = readArchiveReports(root);
  expect(report?.shape).toEqual({
    archiveSchemaVersion: 3,
    harnessVersion: "bash-mini/0.1",
    harnessDigest: "3".repeat(64),
    contextLength: 262144,
    termination: "done",
    atStep: 4,
  });
  expect(report?.modelVersion).toBe("fixture/v3-model");
  const steps = report?.steps;
  expect(steps?.entries.map((entry) => entry.step)).toEqual([1, 2, 3, 4]);
  // stepMs = sendMs + harnessMs（模型慢还是沙箱慢由两列分开回答）。
  expect(steps?.entries.map((entry) => entry.stepMs)).toEqual([110, 220, 330, 401]);
  // 增长 = input[i] − input[i−1]，**首步 null 而不是 0**。
  expect(steps?.entries.map((entry) => entry.inputGrowth)).toEqual([null, 500, 100, 100]);
  expect(steps?.entries.map((entry) => entry.inputTokens)).toEqual([1_000, 1_500, 1_600, 1_700]);
  // 命中率 = 缓存读 / 总输入，按步读。
  expect(steps?.entries.map((entry) => entry.cacheHitRate)).toEqual([0.25, 0.2, 0, 0.5]);
  expect(steps?.entries[0]?.action).toBe("bash");
  expect(steps?.entries[0]?.result).toEqual({ kind: "contract", errorCodes: [] });
  // 没有 result 的步是 null（不是空数组）：缺席与「跑过了没错误」是两件事。
  expect(steps?.entries[1]?.result).toBeNull();
  expect(steps?.join).toEqual({
    state: "complete",
    matched: 4,
    stepsWithoutRound: [],
    roundsWithoutStep: [],
  });
  expect(steps?.stats).toEqual({
    steps: 4,
    stepMs: { p50: 220, p95: 401, max: 401, count: 4 },
    sendMs: { p50: 200, p95: 400, max: 400, count: 4 },
    sessionMedianStepMs: 220,
    // 会话总墙钟 = max(atMs + sendMs + harnessMs)，跨步聚合。
    sessionWallClockMs: 3_401,
    inputTokens: { p50: 1_500, p95: 1_700, max: 1_700, count: 4 },
    maxInputGrowth: 500,
  });

  const md = await markdownOf(root);
  for (const expected of [
    "### 步级度量（轮号 = 步号）",
    "步级耗时 p50/p95/max：stepMs=220 / 401 / 401（n=4）",
    "会话中位数 stepMs=220",
    "prompt 大小 p50/p95/max：1500 / 1700 / 1700（n=4）",
    "| 步 | 动作 | stepMs | sendMs | harnessMs | atMs | 输入 token | 增长 | 缓存命中率 | 结果 | 关联 |",
    "| 2 | evaluate | 220 | 200 | 20 | 1000 | 1500 | 500 | 20.0% | null | round==step |",
    "结果侧证据（真源在过程记录）：",
    "第 1 步：kind=contract；errorCodes=（空）",
    "第 3 步：kind=tsc；errorCodes=TS2322",
    "缓存命中率是**回归哨兵**，不是效率指标",
  ])
    expect(md).toContain(expected);
  // 候选序（`evaluate` 即提交）：两次提交的步号与字节、以及之间经过的步，全由已有字段合成。
  expect(md).toContain("候选序（`evaluate` 即提交）：");
  expect(md).toContain("与上一次提交（第 2 步）字节不同；之间经过 0 步（无）");
});

it("候选序从 --json 可读：两次 evaluate 之间改了同一份 script.ts，字节随步号可查", () => {
  const root = rootOf();
  writeV3(root, {
    slug: "steps-sequence",
    runId: "2026-01-04T00-00-00-008Z",
    steps: [
      { action: "bash", atMs: 0, harnessMs: 5 },
      { action: "evaluate", atMs: 1_000, harnessMs: 30 },
      {
        action: "bash",
        atMs: 2_000,
        harnessMs: 40,
        result: { kind: "tsc", errorCodes: ["TS2322"] },
      },
      { action: "evaluate", atMs: 3_000, harnessMs: 50 },
      { action: "done", atMs: 4_000, harnessMs: 1 },
    ],
    logs: [1, 2, 3, 4, 5].map((round) => ({
      round,
      kind: "converged",
      responseConverged: true,
      sendMs: 100,
      usage: usageOf(1_000 + round * 100, 0),
    })),
    evaluateSteps: [2, 4],
    termination: "done",
  });
  const [report] = readArchiveReports(root);
  // 步列给出「哪几步是 evaluate」（`evaluate` 就是提交，ADR-0030）。
  const evaluateSteps = (report?.steps?.entries ?? [])
    .filter((entry) => entry.action === "evaluate")
    .map((entry) => entry.step);
  expect(evaluateSteps).toEqual([2, 4]);
  // 候选序给出每一次提交的步号与字节：两次之间字节不同 = 那段时间里 `script.ts` 被改过。
  expect(report?.scores.map((score) => score.protocolRound)).toEqual([2, 4]);
  expect(report?.scores[0]?.scriptSha256).not.toBe(report?.scores[1]?.scriptSha256);
  // 两次提交之间的步（第 3 步）在步列里各带自己的动作与结果侧证据。
  expect(report?.steps?.entries[2]?.action).toBe("bash");
  expect(report?.steps?.entries[2]?.result).toEqual({ kind: "tsc", errorCodes: ["TS2322"] });
});

it("v3 单候选：候选只有一位时步列照旧，末位即最终候选", () => {
  const root = rootOf();
  writeV3(root, {
    slug: "steps-one",
    runId: "2026-01-04T00-00-00-002Z",
    steps: [
      { action: "evaluate", atMs: 0, harnessMs: 40 },
      { action: "done", atMs: 500, harnessMs: 1 },
    ],
    logs: [
      { round: 1, kind: "converged", responseConverged: true, sendMs: 60, usage: usageOf(800, 0) },
      { round: 2, kind: "converged", responseConverged: true, sendMs: 70, usage: usageOf(900, 0) },
    ],
    evaluateSteps: [1],
    termination: "done",
  });
  const [report] = readArchiveReports(root);
  expect(report?.candidateStages).toBe(1);
  expect(report?.steps?.entries).toHaveLength(2);
  expect(report?.steps?.entries[0]?.inputGrowth).toBeNull();
  // 最近秩：两值时 p50 取较低的那个中位数（71 = 70 + 1）。
  expect(report?.steps?.stats.stepMs).toEqual({ p50: 71, p95: 100, max: 100, count: 2 });
  expect(report?.contamination?.state).toBe("clean");
});

// ── 左连接的体检 ───────────────────────────────────────────────────────────────

it("轮号 = 步号的左连接：缺一条日志行就显式计数，不静默通过", async () => {
  const root = rootOf();
  writeV3(root, {
    slug: "steps-gap",
    runId: "2026-01-04T00-00-00-003Z",
    steps: [
      { action: "bash", atMs: 0, harnessMs: 5 },
      { action: "bash", atMs: 100, harnessMs: 5 },
      { action: "done", atMs: 200, harnessMs: 5 },
    ],
    // 第 2 轮那一行缺失：步 2 找不到它的发送侧证据。
    logs: [
      { round: 1, kind: "converged", responseConverged: true, sendMs: 10, usage: usageOf(100, 0) },
      { round: 3, kind: "converged", responseConverged: true, sendMs: 30, usage: usageOf(120, 0) },
    ],
    termination: "max-steps",
    atStep: 3,
  });
  const [report] = readArchiveReports(root);
  expect(report?.steps?.join).toEqual({
    state: "mismatched",
    matched: 2,
    stepsWithoutRound: [2],
    roundsWithoutStep: [],
  });
  // 缺那一轮的发送侧证据 → 步 2 的 sendMs / stepMs 是 null，不拿 0 顶上。
  expect(report?.steps?.entries[1]?.sendMs).toBeNull();
  expect(report?.steps?.entries[1]?.stepMs).toBeNull();
  expect(report?.steps?.stats.stepMs).toEqual({ p50: 15, p95: 35, max: 35, count: 2 });

  const md = await markdownOf(root);
  expect(md).toContain("轮 × 步关联：2/3 匹配（缺日志行的步=2；缺过程记录的轮=无");
  expect(md).toContain(
    "| 2 | bash | null | null | 5 | 100 | null | null | null | null | 缺日志行 |",
  );
});

it("传输末行不占步：它不进过程记录，也不算左连接的不匹配", () => {
  const root = rootOf();
  const slug = "steps-transport";
  const slugDir = join(root, "archive", slug);
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(
    join(slugDir, "failed-2026-01-05T00-00-00-001Z.json"),
    `${JSON.stringify({
      archiveSchemaVersion: 3,
      model: slug,
      modelVersion: "fixture/v3-model",
      generatedAt: "2026-01-05T00:00:00.000Z",
      runId: "2026-01-05T00-00-00-001Z",
      protocolRounds: 1,
      prompts: ["你是策略作者。"],
      steps: [
        {
          step: 1,
          action: { kind: "bash" },
          stdout: "",
          stderr: "",
          exitCode: 0,
          atMs: 0,
          harnessMs: 7,
        },
      ],
      generationLog: [
        JSON.stringify({ round: 1, kind: "converged", responseConverged: true, sendMs: 50 }),
        JSON.stringify({ round: 2, kind: "transport", responseConverged: false, sendMs: 0 }),
      ],
      contextLength: 262144,
      harnessVersion: "bash-mini/0.1",
      harnessDigest: "3".repeat(64),
      termination: "transport",
      atStep: 2,
      ruleset: "v2",
      validation: { passed: false, errors: [] },
      tscVersion: "7.0.2",
      scriptSha256: "0".repeat(64),
      sandboxRuntimeHash: "b".repeat(64),
      classification: "transport",
      diagnostics: ["传输重试耗尽"],
      message: "第二步之前传输耗尽",
    })}\n`,
  );
  const [report] = readArchiveReports(root);
  expect(report?.steps?.entries).toHaveLength(1);
  expect(report?.steps?.join).toEqual({
    state: "complete",
    matched: 1,
    stepsWithoutRound: [],
    roundsWithoutStep: [],
  });
  expect(report?.rounds.map((round) => round.responseConverged)).toEqual([true, false]);
});

// ── 版本分派：缺 steps / 旧档 ─────────────────────────────────────────────────

it("v1 旧档（入库 fixture）：没有步列，日志行里的结果侧 kind/errorCodes 照旧读", async () => {
  const root = copyFixture("legacy-plain");
  const [report] = readArchiveReports(root);
  expect(report?.shape.archiveSchemaVersion).toBe("legacy");
  expect(report?.steps).toBeNull();
  expect(report?.contamination).toBeNull();
  // 旧档的行里带 `kind: "tsc"|"contract"` 与 `errorCodes`——v3 才禁这两个键，旧档照旧读。
  expect(report?.rounds.length).toBe(report?.protocolRounds);
  expect(report?.log.issues).toEqual([]);

  const md = await markdownOf(root);
  expect(md).not.toContain("### 步级度量");
  expect(md).not.toContain("| 步 | 动作 |");
  expect(md).toContain("受污染：不适用（one-shot 档该列恒 null");
  expect(md).toContain("分组键：modelVersion=");
  // 没有步的档不进分位分组。
  expect(stepGroupsOf(readArchiveReports(root))).toEqual([]);
  expect(md).not.toContain("## 步级分位");
});

it("v2 旧档（入库 fixture）：照旧读出，且渲染格式与非 v3 档一致", () => {
  const root = copyFixture("legacy-v2-grid-selection");
  const [report] = readArchiveReports(root);
  expect(report?.shape.archiveSchemaVersion).toBe("legacy");
  expect(report?.steps).toBeNull();
  expect(report?.shape.termination).toBeNull();
  expect(report?.contamination).toBeNull();
});

it("零步失败档（steps: []）：不渲染步列，也不把零步读成「缺数据」", async () => {
  const root = rootOf();
  writeZeroStepFailure(root, {
    slug: "steps-zero",
    logs: [{ round: 1, kind: "transport", responseConverged: false, sendMs: 0 }],
  });
  const [report] = readArchiveReports(root);
  expect(report?.kind).toBe("failure");
  expect(report?.protocolRounds).toBe(0);
  // 在场但为空 = 零步会话；`null` 才是「这一档没有过程记录」。两者不混用。
  expect(report?.steps?.entries).toEqual([]);
  expect(report?.steps?.stats.steps).toBe(0);
  expect(report?.steps?.stats.stepMs).toEqual({ p50: null, p95: null, max: null, count: 0 });
  expect(report?.steps?.join.state).toBe("complete");

  const md = await markdownOf(root);
  expect(md).toContain("步级度量：不适用（本档过程记录为空——零步会话，不是「没记」）");
  expect(md).not.toContain("| 步 | 动作 |");
});

it("声明了 v3 却缺 steps 的档拒读，不静默当旧档", () => {
  const root = rootOf();
  writeV3(root, {
    slug: "steps-missing",
    runId: "2026-01-04T00-00-00-004Z",
    steps: [{ action: "done", atMs: 0, harnessMs: 1 }],
    logs: [{ round: 1, kind: "converged", responseConverged: true, sendMs: 10 }],
    withSteps: false,
  });
  const issues: { source: string; reason: string }[] = [];
  const reports = readArchiveReports(root, { onReadIssue: (issue) => issues.push(issue) });
  expect(reports).toEqual([]);
  expect(issues).toHaveLength(1);
  expect(issues[0]?.source).toBe("archive/steps-missing/2026-01-04T00-00-00-004Z/meta.json");
});

it("步号不是 1..协议轮数 的连续序列：拒读（按号数的左连接不再成立）", () => {
  const root = rootOf();
  writeV3(root, {
    slug: "steps-renumbered",
    runId: "2026-01-04T00-00-00-005Z",
    steps: [
      { action: "bash", atMs: 0, harnessMs: 1 },
      { action: "done", atMs: 10, harnessMs: 1 },
    ],
    stepNumbers: [1, 3],
    logs: [
      { round: 1, kind: "converged", responseConverged: true, sendMs: 10 },
      { round: 2, kind: "converged", responseConverged: true, sendMs: 10 },
      { round: 3, kind: "converged", responseConverged: true, sendMs: 10 },
    ],
  });
  const issues: { source: string; reason: string }[] = [];
  const reports = readArchiveReports(root, { onReadIssue: (issue) => issues.push(issue) });
  expect(reports).toEqual([]);
  expect(issues).toHaveLength(1);
});

// ── 日志行的证据分家（ADR-0031） ───────────────────────────────────────────────

it("v3 日志行带结果侧 errorCodes：显式拒读那一行，不静默忽略", () => {
  const root = rootOf();
  writeV3(root, {
    slug: "steps-duplicated-evidence",
    runId: "2026-01-04T00-00-00-006Z",
    steps: [
      { action: "bash", atMs: 0, harnessMs: 1 },
      { action: "done", atMs: 10, harnessMs: 1 },
    ],
    logs: [
      {
        round: 1,
        kind: "converged",
        responseConverged: true,
        sendMs: 10,
        errorCodes: ["TS2322"],
        usage: usageOf(100, 0),
      },
      { round: 2, kind: "converged", responseConverged: true, sendMs: 20, usage: usageOf(200, 0) },
    ],
  });
  const [report] = readArchiveReports(root);
  expect(report?.log.issues).toEqual([{ line: 1, reason: "v3 日志行不带结果侧 errorCodes 字段" }]);
  expect(report?.log.state).toBe("partial");
  // 那一行被剔掉之后，左连接把缺口显式数出来（不是「这一步没有失败原因」）。
  expect(report?.steps?.join.stepsWithoutRound).toEqual([1]);
});

it("v3 日志行的 kind 只能是行类型标记：写成结果侧驱动来源即拒读", () => {
  const root = rootOf();
  writeV3(root, {
    slug: "steps-driver-kind",
    runId: "2026-01-04T00-00-00-007Z",
    steps: [{ action: "done", atMs: 0, harnessMs: 1 }],
    logs: [{ round: 1, kind: "tsc", responseConverged: true, sendMs: 10 }],
  });
  const [report] = readArchiveReports(root);
  expect(report?.log.issues).toEqual([{ line: 1, reason: "v3 日志行的 kind 只能是行类型标记" }]);
});

// ── 受污染分层（ADR-0036） ────────────────────────────────────────────────────

const rateLimitAttempts = (count: number): readonly Record<string, unknown>[] =>
  Array.from({ length: count }, (_, index) => ({
    attempt: index + 1,
    outcome: "transport-error",
    failureKind: "rate-limited",
  }));

it("受污染会话：429 次数达到阈值即单列，成绩与步数保留", async () => {
  const root = rootOf();
  writeV3(root, {
    slug: "contaminated",
    runId: "2026-01-06T00-00-00-001Z",
    steps: [
      { action: "evaluate", atMs: 0, harnessMs: 10 },
      { action: "done", atMs: 600, harnessMs: 1 },
    ],
    logs: [
      {
        round: 1,
        kind: "converged",
        responseConverged: true,
        sendMs: 500,
        usage: usageOf(100, 0),
        attemptEvidence: [
          ...rateLimitAttempts(CONTAMINATION_THRESHOLDS.rateLimitedAttempts),
          { attempt: CONTAMINATION_THRESHOLDS.rateLimitedAttempts + 1, outcome: "response" },
        ],
      },
      { round: 2, kind: "converged", responseConverged: true, sendMs: 100, usage: usageOf(200, 0) },
    ],
    evaluateSteps: [1],
    termination: "max-steps",
  });
  const [report] = readArchiveReports(root);
  expect(report?.contamination).toEqual({
    state: "contaminated",
    rateLimitedAttempts: CONTAMINATION_THRESHOLDS.rateLimitedAttempts,
    // 累计退避今天没有落点：缺数据不补零。
    backoffMs: null,
    reasons: ["rate-limited>=3"],
  });
  // 成绩不作废：候选与步数照旧可读。
  expect(report?.candidateStages).toBe(1);
  expect(report?.steps?.entries).toHaveLength(2);
  // 尝试细分进了报告（ADR-0036「失败必须可读」）。
  expect(report?.rounds[0]?.attempts.map((attempt) => attempt.failureKind)).toEqual([
    "rate-limited",
    "rate-limited",
    "rate-limited",
    null,
  ]);

  const md = await markdownOf(root);
  expect(md).toContain("## 受污染会话（单列，成绩保留）");
  expect(md).toContain(
    `累计退避 > ${CONTAMINATION_THRESHOLDS.backoffMs} ms 或 429 次数 ≥ ${CONTAMINATION_THRESHOLDS.rateLimitedAttempts}`,
  );
  expect(md).toContain("| contaminated | 2026-01-06T00-00-00-001Z |");
  // 受污染会话不参与干净会话的分位。
  const groups = stepGroupsOf(readArchiveReports(root));
  expect(groups).toEqual([
    {
      modelVersion: "fixture/v3-model",
      harnessDigest: "3".repeat(64),
      sessions: 0,
      steps: 0,
      stepMs: { p50: null, p95: null, max: null, count: 0 },
      sendMs: { p50: null, p95: null, max: null, count: 0 },
      sessionMedianStepMs: null,
      contaminatedSessions: 1,
    },
  ]);
  expect(md).toContain(
    "| fixture/v3-model | " + "3".repeat(64) + " | 0 | 0 | 不适用 | 不适用 | null | 1 |",
  );
});

it("受污染会话：累计退避超过阈值同样单列（日志行记了 backoffMs 时）", () => {
  const root = rootOf();
  writeV3(root, {
    slug: "backoff-heavy",
    runId: "2026-01-06T00-00-00-002Z",
    steps: [{ action: "done", atMs: 0, harnessMs: 1 }],
    logs: [
      {
        round: 1,
        kind: "converged",
        responseConverged: true,
        sendMs: 90_000,
        backoffMs: CONTAMINATION_THRESHOLDS.backoffMs + 1,
      },
    ],
  });
  const [report] = readArchiveReports(root);
  expect(report?.rounds[0]?.backoffMs).toBe(CONTAMINATION_THRESHOLDS.backoffMs + 1);
  expect(report?.contamination).toEqual({
    state: "contaminated",
    rateLimitedAttempts: 0,
    backoffMs: CONTAMINATION_THRESHOLDS.backoffMs + 1,
    reasons: ["backoff>60s"],
  });
});

it("干净会话：429 次数不到阈值、退避未记录 → clean，退避读成 null", async () => {
  const root = rootOf();
  writeV3(root, {
    slug: "clean",
    runId: "2026-01-06T00-00-00-003Z",
    steps: [{ action: "done", atMs: 0, harnessMs: 1 }],
    logs: [
      {
        round: 1,
        kind: "converged",
        responseConverged: true,
        sendMs: 10,
        usage: usageOf(100, 0),
        attemptEvidence: [
          { attempt: 1, outcome: "transport-error", failureKind: "rate-limited" },
          { attempt: 2, outcome: "response" },
        ],
      },
    ],
  });
  const [report] = readArchiveReports(root);
  expect(report?.contamination).toEqual({
    state: "clean",
    rateLimitedAttempts: 1,
    backoffMs: null,
    reasons: [],
  });
  const md = await markdownOf(root);
  expect(md).toContain(
    "受污染：clean（429 尝试 1 次；累计退避 null（生成侧日志行还不记退避时延）；命中判据=无）",
  );
  expect(md).toContain("- 本次报告里没有受污染会话（one-shot 档该列恒 null，不代表干净）。");
});

// ── 分组维度 ──────────────────────────────────────────────────────────────────

it("步级分位按 modelVersion + harnessDigest 分组，会话中位数取各会话中位数的中位数", () => {
  const root = rootOf();
  writeV3(root, {
    slug: "group-a",
    runId: "2026-01-07T00-00-00-001Z",
    steps: [
      { action: "bash", atMs: 0, harnessMs: 10 },
      { action: "done", atMs: 100, harnessMs: 10 },
    ],
    logs: [
      { round: 1, kind: "converged", responseConverged: true, sendMs: 100, usage: usageOf(100, 0) },
      { round: 2, kind: "converged", responseConverged: true, sendMs: 200, usage: usageOf(200, 0) },
    ],
    modelVersion: "fixture/version-x",
    harnessDigest: "a".repeat(64),
  });
  writeV3(root, {
    slug: "group-b",
    runId: "2026-01-07T00-00-00-002Z",
    steps: [
      { action: "bash", atMs: 0, harnessMs: 20 },
      { action: "done", atMs: 100, harnessMs: 20 },
    ],
    logs: [
      { round: 1, kind: "converged", responseConverged: true, sendMs: 300, usage: usageOf(100, 0) },
      { round: 2, kind: "converged", responseConverged: true, sendMs: 400, usage: usageOf(200, 0) },
    ],
    modelVersion: "fixture/version-x",
    harnessDigest: "a".repeat(64),
  });
  writeV3(root, {
    slug: "group-c",
    runId: "2026-01-07T00-00-00-003Z",
    steps: [{ action: "done", atMs: 0, harnessMs: 1 }],
    logs: [
      { round: 1, kind: "converged", responseConverged: true, sendMs: 1, usage: usageOf(100, 0) },
    ],
    modelVersion: "fixture/version-y",
    harnessDigest: "b".repeat(64),
  });
  const groups = stepGroupsOf(readArchiveReports(root));
  expect(groups).toHaveLength(2);
  expect(groups[0]).toMatchObject({
    modelVersion: "fixture/version-x",
    harnessDigest: "a".repeat(64),
    sessions: 2,
    steps: 4,
    // 各步 stepMs：110 / 210 / 320 / 420。
    stepMs: { p50: 210, p95: 420, max: 420, count: 4 },
    // 会话中位数：110（较低中位数）与 320 → 再取中位数 110。
    sessionMedianStepMs: 110,
    contaminatedSessions: 0,
  });
  expect(groups[1]).toMatchObject({
    modelVersion: "fixture/version-y",
    harnessDigest: "b".repeat(64),
    sessions: 1,
    steps: 1,
  });
});
