/**
 * 档案形状 v3（ADR-0031）的**写 → 装载 → 报告读出**往返，外加对旧档（v1 / v2）的读兼容。
 *
 * ── 为什么这个往返测试住在 `apps/cli` ──
 *
 * 它同时要碰三样东西：生成侧的写入口（`@model-war/gen` 的 `buildArchiveMeta` /
 * `buildFailureRecord`）、装载校验（本包的 `validateArchiveMeta`）与报告（`@model-war/runner`
 * 的 `readArchiveReports`）。`runner` 不得 import `gen`（hld §3.2 的依赖边），所以这条往返
 * 只能挂在唯一的交汇处——CLI。
 *
 * ── 旧档 fixture 从真实 `archive/` 抽出来 ──
 *
 * `archive/` 不在版本控制里（`.gitignore`），而 ADR-0031 要求「删生成侧、留读侧」之后那些
 * 分支仍有人跑。所以四份真实记录被抽进 `packages/runner/src/fixtures/archive/`（改写了模型名、
 * runId 与 prompt 正文，形状与哈希关系逐字保留，改写清单见该目录的 README.md）。
 *
 * ── 判据 ──
 *
 * 1. v3 的 1 个候选与 3 个候选都能被装载、被报告读出，且**同一份候选只列一次**；
 * 2. v3 的零步失败档与成功档同形（过程记录为空、起始 prompt 为空、协议轮数为零）；
 * 3. v1 / v2 旧档照旧装载、照旧出报告（不迁移、不回填）；
 * 4. 每个版本的落盘键集按**自己那一版**的契约断言（ADR-0031：不能用一个数字代表所有档案）。
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_ARCHIVE_REQUIRED_KEYS,
  ARCHIVE_SCHEMA_VERSION,
  OPTIMIZATION_AGENT_VERSION,
  OPTIMIZATION_CANDIDATE_LIMIT,
  TRIAL_MATCHES_PER_CANDIDATE,
  type ArchiveMeta,
  type ArchiveStep,
  type JsonValue,
} from "@model-war/schema";
import { afterAll, expect, it } from "vitest";

import {
  buildArchiveMeta,
  buildFailureRecord,
  commitArchive,
  openStagingDir,
  sha256Hex,
} from "@model-war/gen";
import {
  optimizationMetaOf,
  readArchiveReports,
  runArchiveReport,
  type ArchiveReport,
} from "@model-war/runner";

import { validateArchiveMeta, type ArchiveMetaProvenance } from "./validator.js";

const scratch = mkdtempSync(join(tmpdir(), "modelwar-archive-v3-"));
afterAll(() => rmSync(scratch, { force: true, recursive: true }));

const FIXTURE_ROOT = fileURLToPath(
  new URL("../../../packages/runner/src/fixtures/archive", import.meta.url),
);

/** 把一份抽出来的旧档 fixture 复制成临时根（报告按 `<root>/archive/...` 扫）。 */
const copyFixture = (name: string): string => {
  const root = mkdtempSync(join(scratch, `${name}-`));
  cpSync(join(FIXTURE_ROOT, name), root, { recursive: true });
  return root;
};

const provenanceOf = (root: string, slug: string, runId: string, meta: ArchiveMeta) => {
  const dir = join(root, "archive", slug, runId);
  const measuredScriptSha256 = sha256Hex(readFileSync(join(dir, "script.js")));
  return {
    filesPresent: { scriptTs: true, scriptJs: true, metaJson: true },
    measuredScriptSha256,
    measuredSourceSha256: sha256Hex(readFileSync(join(dir, "script.ts"))),
    // 装载期比的是「本仓实测的 runtime」与「档里记的那个」——这里要判的是**形状**，
    // 所以喂档里自己的那份；哈希不符的判据另有用例（`validator.test.ts`）。
    measuredSandboxRuntimeHash: meta.sandboxRuntimeHash,
    loadedRulesetVersion: meta.ruleset,
  } satisfies ArchiveMetaProvenance;
};

// ── v3 合成档：写入 ────────────────────────────────────────────────────────────

const STEP_SCRIPT = (tag: string): string => `function loop() {\n  return "${tag}";\n}\nloop();\n`;

type V3ArchiveInput = {
  readonly slug: string;
  readonly runId: string;
  readonly candidates: number;
  readonly termination: "done" | "max-steps";
};

/**
 * 造一份 v3 成功档：`steps` 里每次 `evaluate` 产出一个候选，末位候选即冻结的那份。
 *
 * 侧车（候选的 `.candidate.js` / `.candidate.ts`）都真写，因此报告的 `scriptState` 是
 * `verified`——那是「候选按位置可读」里最要紧的一半（字节与身份对得上）。
 */
const writeV3Archive = (root: string, input: V3ArchiveInput): ArchiveMeta => {
  const slugDir = join(root, "archive", input.slug);
  mkdirSync(slugDir, { recursive: true });
  const observationsFileOf = (step: number): string =>
    `observed-${input.runId}-round-${String(step)}.jsonl`;
  const steps: ArchiveStep[] = [
    {
      step: 1,
      action: { kind: "bash", command: "cat /contract/README.md" },
      stdout: "# contract\n",
      stderr: "",
      exitCode: 0,
      raw: "读契约。\n```bash\ncat /contract/README.md\n```",
      atMs: 0,
      harnessMs: 3,
      result: { kind: "contract", errorCodes: [] },
    },
  ];
  const candidates: {
    step: number;
    scriptFile: string;
    observationsFile: string;
    scriptSha256: string;
    score: { totalPoints: number; averagePoints: number; countedMatches: number };
    matchCount: number;
  }[] = [];
  for (let index = 0; index < input.candidates; index += 1) {
    const step = steps.length + 1;
    const observationsFile = observationsFileOf(step);
    const product = STEP_SCRIPT(`candidate-${String(index)}`);
    writeFileSync(join(slugDir, `${observationsFile}.candidate.js`), product);
    writeFileSync(join(slugDir, `${observationsFile}.candidate.ts`), product);
    candidates.push({
      step,
      scriptFile: `${observationsFile}.candidate.js`,
      observationsFile,
      scriptSha256: sha256Hex(product),
      score: {
        totalPoints: TRIAL_MATCHES_PER_CANDIDATE / 4 + index,
        averagePoints: (TRIAL_MATCHES_PER_CANDIDATE / 4 + index) / TRIAL_MATCHES_PER_CANDIDATE,
        countedMatches: TRIAL_MATCHES_PER_CANDIDATE,
      },
      matchCount: TRIAL_MATCHES_PER_CANDIDATE,
    });
    steps.push({
      step,
      action: { kind: "evaluate" },
      stdout: `[evaluate] matches=${String(TRIAL_MATCHES_PER_CANDIDATE)}\n`,
      stderr: "",
      exitCode: 0,
      atMs: step * 1000,
      harnessMs: 4200,
    });
  }
  const doneStep = steps.length + 1;
  steps.push({
    step: doneStep,
    action: { kind: "done" },
    stdout: "",
    stderr: "",
    exitCode: 0,
    atMs: doneStep * 1000,
    harnessMs: 1,
  });
  const final = candidates[candidates.length - 1]!;
  const generationLog = steps.map((step) =>
    JSON.stringify({ round: step.step, model: input.slug, sendMs: 120 }),
  );
  const meta = buildArchiveMeta({
    model: input.slug,
    modelVersion: "fixture/v3-model",
    channelId: "fixture-channel",
    generatedAt: "2026-01-02T00:00:00.000Z",
    generationLog,
    validation: { passed: true, errors: [] },
    tscVersion: "7.0.2",
    scriptSha256: final.scriptSha256,
    optimization: { version: OPTIMIZATION_AGENT_VERSION, candidates },
    steps,
    firstPrompt: "你是策略作者。契约在 /contract。",
    contextLength: 262144,
    harnessVersion: "bash-mini/0.1",
    harnessDigest: "3".repeat(64),
    termination: input.termination,
    atStep: doneStep,
  });
  const staging = openStagingDir(root, input.slug);
  writeFileSync(
    join(staging, "script.ts"),
    STEP_SCRIPT(`candidate-${String(input.candidates - 1)}`),
  );
  writeFileSync(
    join(staging, "script.js"),
    STEP_SCRIPT(`candidate-${String(input.candidates - 1)}`),
  );
  const committed = commitArchive({
    root,
    slug: input.slug,
    runId: input.runId,
    stagingDir: staging,
    meta,
  });
  expect(committed.ok).toBe(true);
  return meta;
};

/** 报告里逐候选的字节核实状态（同一份候选可能同时占「初次」与「最终」两格，按身份去重）。 */
const scriptStatesOf = (report: ArchiveReport): readonly string[] => [
  ...new Set(
    [report.initialCandidate, ...report.intermediateCandidates, report.finalCandidate].flatMap(
      (candidate) => (candidate === null ? [] : [candidate.scriptState]),
    ),
  ),
];

const storedMetaOf = (root: string, slug: string, runId: string): JsonValue =>
  JSON.parse(readFileSync(join(root, "archive", slug, runId, "meta.json"), "utf8")) as JsonValue;

// ── v3：写入 → 装载 → 报告 ──────────────────────────────────────────────────────

const V3_SUCCESS_KEYS = [
  "archiveSchemaVersion",
  "model",
  "modelVersion",
  "channelId",
  "generatedAt",
  "protocolRounds",
  "prompts",
  "steps",
  "generationLog",
  "contextLength",
  "harnessVersion",
  "harnessDigest",
  "termination",
  "atStep",
  "ruleset",
  "validation",
  "tscVersion",
  "scriptSha256",
  "sandboxRuntimeHash",
  "optimization",
] as const;

it("v3 成功档（3 候选）：键集、装载、报告读出，且报告不重复列同一份候选", async () => {
  const root = mkdtempSync(join(scratch, "v3-three-"));
  const meta = writeV3Archive(root, {
    slug: "v3three",
    runId: "2026-01-02T00-00-00-001Z",
    candidates: 3,
    termination: "max-steps",
  });

  // 1. 落盘键集是**这一版**的契约（ADR-0031：不能拿一个数字代表所有档案）。
  const stored = storedMetaOf(root, "v3three", "2026-01-02T00-00-00-001Z");
  expect(Object.keys(stored as Record<string, unknown>)).toEqual([...V3_SUCCESS_KEYS]);

  // 2. 装载：形状（ajv）与跨字段关系（轮数 = 过程记录条数、末位候选 = 冻结字节）。
  const loaded = validateArchiveMeta(
    stored,
    provenanceOf(root, "v3three", "2026-01-02T00-00-00-001Z", meta),
  );
  expect(loaded.ok).toBe(true);
  const read = optimizationMetaOf(stored) as ArchiveMeta;
  expect(read.archiveSchemaVersion).toBe(ARCHIVE_SCHEMA_VERSION);
  expect(read.protocolRounds).toBe(meta.steps?.length);
  expect(read.prompts).toHaveLength(1);

  // 3. 报告：候选按位置可读，末位即最终候选，中间候选只列未被两头覆盖的那几个。
  const reports = readArchiveReports(root);
  expect(reports).toHaveLength(1);
  const report = reports[0]!;
  expect(report.kind).toBe("success");
  expect(report.candidateStages).toBe(3);
  expect(report.initialCandidate?.stage).toBe(0);
  expect(report.intermediateCandidates.map((candidate) => candidate.stage)).toEqual([1]);
  expect(report.finalCandidate?.stage).toBe(2);
  expect(report.frozenCandidate?.stage).toBe(2);
  expect(report.scores.map((score) => score.stage)).toEqual([0, 1, 2]);
  expect(scriptStatesOf(report)).toEqual(["verified"]);

  // 4. markdown：三份候选各一列（不重复），且各节标题只用一次。
  const out: string[] = [];
  const code = await runArchiveReport(["--root", root], {
    stdout: (text) => out.push(text),
    stderr: () => {},
  });
  expect(code).toBe(0);
  const markdown = out.join("");
  for (const candidate of meta.optimization?.candidates ?? []) {
    expect(markdown.split(candidate.scriptFile).length - 1).toBeGreaterThan(0);
  }
  expect(markdown.split("### 初次候选").length - 1).toBe(1);
  expect(markdown.split("### 中间候选").length - 1).toBe(1);
  expect(markdown.split("### 最终候选").length - 1).toBe(1);
});

it("v3 成功档（1 候选）：末位即最终候选，报告只列它一次（初次兼最终）", async () => {
  const root = mkdtempSync(join(scratch, "v3-one-"));
  const meta = writeV3Archive(root, {
    slug: "v3one",
    runId: "2026-01-02T00-00-00-002Z",
    candidates: 1,
    termination: "done",
  });
  const stored = storedMetaOf(root, "v3one", "2026-01-02T00-00-00-002Z");
  expect(
    validateArchiveMeta(stored, provenanceOf(root, "v3one", "2026-01-02T00-00-00-002Z", meta)).ok,
  ).toBe(true);
  const report = readArchiveReports(root)[0]!;
  expect(report.candidateStages).toBe(1);
  expect(report.initialCandidate?.stage).toBe(0);
  expect(report.intermediateCandidates).toEqual([]);
  // 末位即最终候选：只有一份候选时「初次」与「最终」是同一位，字段仍各自可读。
  expect(report.finalCandidate?.stage).toBe(0);
  expect(report.frozenCandidate?.stage).toBe(0);

  const out: string[] = [];
  await runArchiveReport(["--root", root], {
    stdout: (text) => out.push(text),
    stderr: () => {},
  });
  const markdown = out.join("");
  // 同一份候选只列一次：合并成「初次兼最终」那一节，不出现两个同名小节。
  expect(markdown.split("### 初次候选兼最终候选").length - 1).toBe(1);
  expect(markdown.includes("### 初次候选（")).toBe(false);
  expect(markdown.includes("### 最终候选（")).toBe(false);
});

it("v3 零步失败档：过程记录为空、起始 prompt 为空、协议轮数为零，报告照旧读得出来", async () => {
  const root = mkdtempSync(join(scratch, "v3-zero-"));
  const slug = "v3zero";
  const runId = "2026-01-02T00-00-00-003Z";
  const steps: ArchiveStep[] = [];
  const meta = buildArchiveMeta({
    model: slug,
    modelVersion: "fixture/v3-model",
    channelId: "fixture-channel",
    generatedAt: "2026-01-02T00:00:00.000Z",
    generationLog: [],
    validation: { passed: false, errors: ["一次模型调用都没有成功"] },
    tscVersion: "7.0.2",
    scriptSha256: "0".repeat(64),
    steps,
    firstPrompt: "你是策略作者。契约在 /contract。",
    contextLength: 262144,
    harnessVersion: "bash-mini/0.1",
    harnessDigest: "3".repeat(64),
    termination: "transport",
    atStep: 0,
  });
  const record = buildFailureRecord({
    model: slug,
    modelVersion: meta.modelVersion,
    channelId: "fixture-channel",
    generatedAt: "2026-01-02T00:00:00.000Z",
    runId,
    failure: {
      classification: "transport",
      prompts: [],
      generationLog: [],
      diagnostics: ["传输重试耗尽（第一次调用）"],
      message: "模型 v3zero 零步退出",
    },
    agent: {
      steps,
      firstPrompt: "你是策略作者。契约在 /contract。",
      contextLength: 262144,
      harnessVersion: "bash-mini/0.1",
      harnessDigest: "3".repeat(64),
      termination: "transport",
      atStep: 0,
    },
  });
  // 失败档与成功档**同一套公式**：零步 → 轮数为零、起始 prompt 为空。
  expect(record.protocolRounds).toBe(0);
  expect(record.prompts).toEqual([]);
  // 七个 agent 字段成组出现（与成功档同键集合的那一半）。
  for (const key of AGENT_ARCHIVE_REQUIRED_KEYS) expect(Object.hasOwn(record, key)).toBe(true);

  mkdirSync(join(root, "archive", slug), { recursive: true });
  writeFileSync(
    join(root, "archive", slug, `failed-${runId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  const reports = readArchiveReports(root);
  expect(reports).toHaveLength(1);
  expect(reports[0]!.kind).toBe("failure");
  expect(reports[0]!.protocolRounds).toBe(0);
  expect(reports[0]!.candidateStages).toBe(0);
  expect(reports[0]!.failure?.classification).toBe("transport");

  const out: string[] = [];
  const code = await runArchiveReport(["--root", root], {
    stdout: (text) => out.push(text),
    stderr: () => {},
  });
  expect(code).toBe(0);
});

it("v3 失败档带 1..3 个候选：候选上限跟着版本变成 1..3，报告按位置读出", () => {
  const root = mkdtempSync(join(scratch, "v3-failure-candidates-"));
  const slug = "v3failcand";
  const runId = "2026-01-02T00-00-00-007Z";
  const steps: ArchiveStep[] = [1, 2].map((step) => ({
    step,
    action: { kind: "evaluate" as const },
    stdout: "",
    stderr: "",
    exitCode: 0,
    atMs: step * 1000,
    harnessMs: 4200,
  }));
  const candidates = steps.map((step) => ({
    step: step.step,
    scriptFile: `observed-${runId}-round-${String(step.step)}.jsonl.candidate.js`,
    observationsFile: `observed-${runId}-round-${String(step.step)}.jsonl`,
    scriptSha256: sha256Hex(STEP_SCRIPT(`failed-${String(step.step)}`)),
    score: {
      totalPoints: TRIAL_MATCHES_PER_CANDIDATE / 4,
      averagePoints: 0.25,
      countedMatches: TRIAL_MATCHES_PER_CANDIDATE,
    },
    matchCount: TRIAL_MATCHES_PER_CANDIDATE,
  }));
  const record = buildFailureRecord({
    model: slug,
    modelVersion: "fixture/v3-model",
    channelId: "fixture-channel",
    generatedAt: "2026-01-02T00:00:00.000Z",
    runId,
    failure: {
      classification: "transport",
      prompts: [],
      generationLog: [],
      diagnostics: ["传输重试耗尽"],
      message: "模型 v3failcand 两次评测后传输失败",
      candidates,
    },
    agent: {
      steps,
      firstPrompt: "你是策略作者。契约在 /contract。",
      contextLength: 262144,
      harnessVersion: "bash-mini/0.1",
      harnessDigest: "3".repeat(64),
      termination: "transport",
      atStep: 2,
    },
  });
  expect(record.protocolRounds).toBe(2);
  mkdirSync(join(root, "archive", slug), { recursive: true });
  writeFileSync(
    join(root, "archive", slug, `failed-${runId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  const report = readArchiveReports(root)[0]!;
  expect(report.kind).toBe("failure");
  // v3 失败档的候选上限是 1..3（three 是配额不是下限），按位置读出。
  expect(report.candidateStages).toBe(2);
  expect(report.initialCandidate?.stage).toBe(0);
  expect(report.intermediateCandidates).toEqual([]);
  expect(report.finalCandidate?.stage).toBe(1);

  // 旧的「非选拔失败最多两个候选」那条判据不适用于 v3：第三个候选一样读得出来。
  const three = {
    ...record,
    candidates: [
      ...candidates,
      {
        ...candidates[1]!,
        step: 3,
        scriptFile: `observed-${runId}-round-3.jsonl.candidate.js`,
        observationsFile: `observed-${runId}-round-3.jsonl`,
      },
    ],
  };
  const threeRoot = mkdtempSync(join(scratch, "v3-failure-three-"));
  mkdirSync(join(threeRoot, "archive", slug), { recursive: true });
  writeFileSync(
    join(threeRoot, "archive", slug, `failed-${runId}.json`),
    `${JSON.stringify(three, null, 2)}\n`,
  );
  const threeReport = readArchiveReports(threeRoot)[0]!;
  expect(threeReport.candidateStages).toBe(3);
  expect(threeReport.finalCandidate?.stage).toBe(2);
});

// ── v3：装载期拒读的分支 ───────────────────────────────────────────────────────

it("v3 候选条数超配额、或带 `stage`、或末位不是冻结字节，装载期即拒", () => {
  const root = mkdtempSync(join(scratch, "v3-reject-"));
  const meta = writeV3Archive(root, {
    slug: "v3reject",
    runId: "2026-01-02T00-00-00-004Z",
    candidates: 3,
    termination: "done",
  });
  const stored = storedMetaOf(root, "v3reject", "2026-01-02T00-00-00-004Z") as Record<
    string,
    unknown
  >;
  const provenance = provenanceOf(root, "v3reject", "2026-01-02T00-00-00-004Z", meta);

  const clone = (): Record<string, JsonValue> =>
    JSON.parse(JSON.stringify(stored)) as Record<string, JsonValue>;
  const optimizationOf = (value: Record<string, JsonValue>) =>
    value["optimization"] as { candidates: Record<string, JsonValue>[] } & Record<
      string,
      JsonValue
    >;

  // 超配额：三次评测是上限，第四次就不是一份合法档案。
  const tooMany = clone();
  const many = optimizationOf(tooMany);
  many.candidates.push({ ...many.candidates[2]!, step: many.candidates[2]!["step"] as number });
  expect(validateArchiveMeta(tooMany, provenance).ok).toBe(false);
  expect(OPTIMIZATION_CANDIDATE_LIMIT).toBe(3);

  // `stage` 这个字段在 v3 里写不出来（`additionalProperties: false`）。
  const withStage = clone();
  optimizationOf(withStage).candidates[0]!["stage"] = 0;
  expect(validateArchiveMeta(withStage, provenance).ok).toBe(false);

  // 末位即最终候选：把最后一格换成另一份字节，冻结 hash 关系即断。
  const wrongFinal = clone();
  optimizationOf(wrongFinal).candidates[2]!["scriptSha256"] = "4".repeat(64);
  const rejected = validateArchiveMeta(wrongFinal, provenance);
  expect(rejected.ok).toBe(false);
  if (!rejected.ok)
    expect(
      rejected.machineDiagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    ).toContain("优化最终 hash");
});

it("v3 的优化段版本与档案形状版本必须同进同出：互不一致两个方向都拒", () => {
  const root = mkdtempSync(join(scratch, "v3-pair-"));
  const meta = writeV3Archive(root, {
    slug: "v3pair",
    runId: "2026-01-02T00-00-00-005Z",
    candidates: 1,
    termination: "done",
  });
  const stored = storedMetaOf(root, "v3pair", "2026-01-02T00-00-00-005Z") as Record<
    string,
    unknown
  >;
  const provenance = provenanceOf(root, "v3pair", "2026-01-02T00-00-00-005Z", meta);

  // v3 形状 + v1 优化段：形状版本说「按 v3 读」，优化段却说自己是 v1。
  // 两个分支各自的形状都合 schema（`oneOf` 是**并列**的，条件关系不在 schema 里），
  // 所以拒它的是装载期那条关系断言，不是 ajv。
  const v1Optimization = JSON.parse(JSON.stringify(stored)) as Record<string, JsonValue>;
  v1Optimization["optimization"] = {
    version: 1,
    feedbackRounds: 2,
    trialSeeds: [101, 202, 303],
    candidates: [0, 1, 2].map((stage) => ({
      stage,
      protocolRound: stage + 1,
      scriptFile: `observed-run-round-${String(stage + 1)}.jsonl.candidate.js`,
      observationsFile: `observed-run-round-${String(stage + 1)}.jsonl`,
      scriptSha256: meta.scriptSha256,
    })),
  };
  expect(validateArchiveMeta(v1Optimization, provenance).ok).toBe(false);
  expect(() => optimizationMetaOf(v1Optimization)).toThrow(/优化段版本为 3/);

  // 没有形状版本的档里出现 v3 的优化段：新形状必须显式声明（否则旧读法会当成额外属性）。
  const undeclared = JSON.parse(JSON.stringify(stored)) as Record<string, JsonValue>;
  Reflect.deleteProperty(undeclared, "archiveSchemaVersion");
  expect(validateArchiveMeta(undeclared, provenance).ok).toBe(false);
  expect(() => optimizationMetaOf(undeclared)).toThrow(/archiveSchemaVersion/);
});

it("未知的档案形状版本拒读，不猜", () => {
  const root = mkdtempSync(join(scratch, "v3-unknown-"));
  const meta = writeV3Archive(root, {
    slug: "v3unknown",
    runId: "2026-01-02T00-00-00-006Z",
    candidates: 1,
    termination: "done",
  });
  const stored = storedMetaOf(root, "v3unknown", "2026-01-02T00-00-00-006Z") as Record<
    string,
    unknown
  >;
  // 还**没**认得的版本号:读侧认 3 与 4,其余拒读(不猜、不降级)。
  const future = { ...JSON.parse(JSON.stringify(stored)), archiveSchemaVersion: 99 } as JsonValue;
  expect(
    validateArchiveMeta(future, provenanceOf(root, "v3unknown", "2026-01-02T00-00-00-006Z", meta))
      .ok,
  ).toBe(false);
  expect(() => optimizationMetaOf(future)).toThrow(/不认识的档案形状版本/);

  // 报告侧同样拒读：它把整条记录记成 read issue，而不是把 v4 读成「差不多对」。
  const futureRoot = mkdtempSync(join(scratch, "v3-future-"));
  cpSync(join(root, "archive"), join(futureRoot, "archive"), { recursive: true });
  writeFileSync(
    join(futureRoot, "archive", "v3unknown", "2026-01-02T00-00-00-006Z", "meta.json"),
    `${JSON.stringify(future, null, 2)}\n`,
  );
  const issues: string[] = [];
  const reports = readArchiveReports(futureRoot, {
    onReadIssue: (issue) => issues.push(issue.reason),
  });
  expect(reports).toEqual([]);
  // 报告的拒绝理由统一成一句固定文案（不回显载荷，见 `readRecord` 的兜底）：这里只断言
  // 「整条记录不可读」，不把具体措辞钉进公共面。
  expect(issues).toHaveLength(1);
});

// ── 旧档：从真实 `archive/` 抽出来的 v1 / v2 fixture ─────────────────────────────

it("v1 成功档（优化 v1 + 选拔 v1）：照旧装载，照旧出报告", () => {
  const root = copyFixture("legacy-v1-selection");
  const slug = "fixture-v1-selection";
  const runId = "2026-01-01T00-00-00-001Z";
  const stored = storedMetaOf(root, slug, runId);
  const meta = stored as unknown as ArchiveMeta;
  expect(meta.archiveSchemaVersion).toBeUndefined();
  const loaded = validateArchiveMeta(stored, provenanceOf(root, slug, runId, meta));
  expect(loaded.ok).toBe(true);
  const read = optimizationMetaOf(stored) as ArchiveMeta;
  expect(read.optimization?.version).toBe(1);
  expect(read.selection?.version).toBe(1);

  const reports = readArchiveReports(root);
  expect(reports).toHaveLength(1);
  const report = reports[0]!;
  expect(report.kind).toBe("success");
  expect(report.candidateStages).toBe(3);
  expect(report.initialCandidate?.stage).toBe(0);
  expect(report.finalCandidate?.stage).toBe(2);
  expect(report.selection?.version).toBe(1);
  // 逐候选字节与身份都真写进了 fixture：三份都该被核实过。
  expect(scriptStatesOf(report)).toEqual(["verified"]);
});

it("v2 成功档（网格 + 网格选拔）：照旧装载，照旧出报告", () => {
  const root = copyFixture("legacy-v2-grid-selection");
  const slug = "fixture-v2-grid";
  const runId = "2026-01-01T00-00-00-002Z";
  const stored = storedMetaOf(root, slug, runId);
  const meta = stored as unknown as ArchiveMeta;
  const loaded = validateArchiveMeta(stored, provenanceOf(root, slug, runId, meta));
  expect(loaded.ok).toBe(true);
  const read = optimizationMetaOf(stored) as ArchiveMeta;
  expect(read.optimization?.version).toBe(2);
  expect(read.selection?.version).toBe(2);

  const reports = readArchiveReports(root);
  const report = reports[0]!;
  expect(report.kind).toBe("success");
  expect(report.plan?.kind).toBe("grid");
  expect(report.selection?.version).toBe(2);
  expect(report.scores).toHaveLength(3);
  expect(scriptStatesOf(report)).toEqual(["verified"]);
});

it("最早的 11 键纯 one-shot 档（无优化段、无选拔段）：照旧装载，照旧出报告", () => {
  const root = copyFixture("legacy-plain");
  const slug = "fixture-plain";
  const runId = "2026-01-01T00-00-00-003Z";
  const stored = storedMetaOf(root, slug, runId);
  const meta = stored as unknown as ArchiveMeta;
  expect(Object.keys(meta)).toHaveLength(11);
  expect(meta.optimization).toBeUndefined();
  expect(validateArchiveMeta(stored, provenanceOf(root, slug, runId, meta)).ok).toBe(true);
  // 没有优化段也没有选拔段 → 读入端给 `undefined`，不是抛。
  expect(optimizationMetaOf(stored)).toBeUndefined();

  const reports = readArchiveReports(root);
  expect(reports).toHaveLength(1);
  expect(reports[0]!.candidateStages).toBe(0);
  expect(reports[0]!.scores).toEqual([]);
});

it("旧失败档（零 prompt 的传输失败 / 带一个候选的传输失败）：照旧出报告", () => {
  const transport = copyFixture("legacy-failure-transport");
  const transportReports = readArchiveReports(transport);
  expect(transportReports).toHaveLength(1);
  expect(transportReports[0]!.kind).toBe("failure");
  expect(transportReports[0]!.failure?.classification).toBe("transport");
  expect(transportReports[0]!.protocolRounds).toBe(0);

  const withCandidates = copyFixture("legacy-failure-candidates");
  const reports = readArchiveReports(withCandidates);
  expect(reports).toHaveLength(1);
  const report = reports[0]!;
  expect(report.failure?.classification).toBe("transport");
  // 旧失败档的候选带 `stage`：one-shot 的分支照旧按 stage 读位置。
  expect(report.initialCandidate?.stage).toBe(0);
  expect(report.finalCandidate).toBeNull();
});
