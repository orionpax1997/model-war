import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  RULESET_VERSION,
  SANDBOX_RUNTIME_HASH,
  QUICKJS_WASI_WASM_PATH,
  SANDBOX_RUNTIME_ARTIFACT_PATH,
  type MatchInput,
  type ArchiveMeta,
  type ReplayResultLine,
} from "@model-war/schema";
import {
  buildSelectionPlan,
  buildArchiveSelection,
  selectionInputSha256,
  optimizationMetaOf,
  readArchiveReports,
  runArchiveReport,
  scheduleSeason,
} from "@model-war/runner";
import {
  buildArchiveMeta,
  commitArchive,
  openStagingDir,
  discardStagingDir,
  sha256Hex,
} from "@model-war/gen";
import { validateArchiveMeta } from "./validator.js";
import { assemble } from "./match/assemble.js";

const scratch = mkdtempSync(join(tmpdir(), "selection-archive-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const cliBundle = join(scratch, "modelwar.mjs");
beforeAll(async () => {
  await build({
    entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: cliBundle,
  });
});
const reportCli = (root: string, json: boolean) =>
  spawnSync(process.execPath, [cliBundle, "report", "--root", root, ...(json ? ["--json"] : [])], {
    encoding: "utf8",
  });
const source = [
  "// initial\nfunction loop() {}",
  "// intermediate\nfunction loop() { return []; }",
  "// final\nfunction loop() { return [1]; }",
];
const products = [
  "function loop() {}",
  "function loop() { return []; }",
  "function loop() { return [1]; }",
];
const metaOf = (winner: 0 | 1 | 2, scripts = products): ArchiveMeta => {
  const plan = buildSelectionPlan({
    ruleset: RULESET_VERSION,
    rulesetSha256: "9".repeat(64),
    sandboxRuntimeHash: SANDBOX_RUNTIME_HASH,
    map: "arena",
    mapSha256: "a".repeat(64),
    baselines: [
      { id: "idle", scriptSha256: "b".repeat(64) },
      { id: "rush", scriptSha256: "c".repeat(64) },
      { id: "gather", scriptSha256: "d".repeat(64) },
    ],
  });
  const selection = buildArchiveSelection(
    plan,
    ([0, 1, 2] as const).map((stage) => ({
      stage,
      protocolRound: stage + 1,
      sourceSha256: sha256Hex(source[stage]!),
      scriptSha256: sha256Hex(scripts[stage]!),
      matches: plan.matches.map((match) => {
        const candidateRank = scripts[stage] === scripts[winner] ? 1 : 4;
        const others = candidateRank === 1 ? [2, 3, 4] : [1, 2, 3];
        let index = 0;
        const rankings = match.seats.map((id) =>
          id === "candidate" ? candidateRank : others[index++]!,
        );
        const result: ReplayResultLine = {
          type: "result",
          rankings: [rankings[0]!, rankings[1]!, rankings[2]!, rankings[3]!],
          reason: "timeout",
          territoryScores: [0, 0, 0, 0],
        };
        return {
          matchIndex: match.matchIndex,
          inputSha256: selectionInputSha256(plan, sha256Hex(scripts[stage]!), match),
          result,
        };
      }),
    })),
  );
  return buildArchiveMeta({
    model: "alpha",
    modelVersion: "test",
    generatedAt: "2026-10-13T00:00:00Z",
    prompts: ["initial", "feedback1", "feedback2"],
    generationLog: [],
    validation: { passed: true, errors: [] },
    tscVersion: "7.0.2",
    scriptSha256: sha256Hex(scripts[winner]!),
    optimization: {
      version: 1,
      feedbackRounds: 2,
      trialSeeds: [101, 202, 303],
      candidates: ([0, 1, 2] as const).map((stage) => ({
        stage,
        protocolRound: stage + 1,
        scriptFile: `observed-r1-round-${stage + 1}.jsonl.candidate.js`,
        observationsFile: `observed-r1-round-${stage + 1}.jsonl`,
        scriptSha256: sha256Hex(scripts[stage]!),
      })),
    },
    selection,
  });
};
const provenance = (meta: ArchiveMeta) => ({
  filesPresent: { scriptTs: true, scriptJs: true, metaJson: true },
  measuredScriptSha256: meta.scriptSha256,
  measuredSourceSha256: meta.selection!.selected.sourceSha256,
  measuredSandboxRuntimeHash: SANDBOX_RUNTIME_HASH,
  loadedRulesetVersion: RULESET_VERSION,
});

it.each([0, 1, 2] as const)(
  "选中阶段 %i 原子发布原始 TS/JS，并通过 CLI、共享读取和报告消费者",
  (winner) => {
    const root = mkdtempSync(join(scratch, "root-"));
    const meta = metaOf(winner);
    const stage = openStagingDir(root, "alpha");
    writeFileSync(join(stage, "script.ts"), source[winner]!);
    writeFileSync(join(stage, "script.js"), products[winner]!);
    expect(commitArchive({ root, slug: "alpha", runId: "r1", stagingDir: stage, meta }).ok).toBe(
      true,
    );
    const directory = join(root, "archive/alpha");
    for (const candidate of meta.optimization!.candidates) {
      writeFileSync(join(directory, candidate.scriptFile), products[candidate.stage]!);
      writeFileSync(
        join(directory, candidate.scriptFile.replace(/\.js$/, ".ts")),
        source[candidate.stage]!,
      );
    }
    const bytes = readFileSync(join(directory, "r1/meta.json"));
    const stored = JSON.parse(bytes.toString("utf8"));
    expect(validateArchiveMeta(stored, provenance(meta)).ok).toBe(true);
    expect(optimizationMetaOf(stored)).toEqual(meta);
    expect(readFileSync(join(directory, "r1/script.ts"), "utf8")).toBe(source[winner]);
    expect(readFileSync(join(directory, "r1/script.js"), "utf8")).toBe(products[winner]);
    const [report] = readArchiveReports(root);
    expect(report?.finalCandidate).toMatchObject({
      stage: 2,
      scriptSha256: sha256Hex(products[2]!),
      scriptState: "verified",
    });
    expect(report?.frozenCandidate).toMatchObject({ stage: winner, scriptState: "verified" });
    expect(report?.selection).toMatchObject({
      stage: winner,
      averagePoints: 3,
      countedMatches: 12,
      distinctScripts: 3,
    });
    expect(readFileSync(join(directory, "r1/meta.json"))).toEqual(bytes);
    writeFileSync(join(directory, "r1/script.ts"), source[(winner + 1) % 3]!);
    expect(() => readArchiveReports(root)).toThrow(/候选身份不合法/);
  },
);

it("未启用选拔的优化旧档仍要求第三阶段冻结；不能删除 selection 来允许早期冻结", () => {
  for (const winner of [0, 1, 2] as const) {
    const legacy = { ...metaOf(winner) };
    delete legacy.selection;
    expect(validateArchiveMeta(legacy, provenance(metaOf(winner))).ok).toBe(winner === 2);
    if (winner === 2) expect(optimizationMetaOf(legacy)).toEqual(legacy);
    else expect(() => optimizationMetaOf(legacy)).toThrow(/最终 hash/);
  }
});

it("选拔身份/hash/计分被改、缺优化阶段、实际 TS 错配或未测量都拒绝", () => {
  const meta = metaOf(1);
  expect(validateArchiveMeta(meta, { ...provenance(meta), measuredScriptSha256: null }).ok).toBe(
    false,
  );
  expect(validateArchiveMeta(meta, { ...provenance(meta), measuredSourceSha256: null }).ok).toBe(
    false,
  );
  expect(
    validateArchiveMeta(meta, { ...provenance(meta), measuredSourceSha256: sha256Hex(source[2]!) })
      .ok,
  ).toBe(false);
  const changes = [
    { ...meta, scriptSha256: sha256Hex(products[2]!) },
    {
      ...meta,
      selection: {
        ...meta.selection!,
        selected: { ...meta.selection!.selected, sourceSha256: sha256Hex(source[2]!) },
      },
    },
    {
      ...meta,
      selection: { ...meta.selection!, candidates: meta.selection!.candidates.slice(0, 2) },
    },
    {
      ...meta,
      optimization: {
        ...meta.optimization!,
        candidates: meta.optimization!.candidates.map((candidate) => ({
          ...candidate,
          scriptSha256: "f".repeat(64),
        })),
      },
    },
  ];
  for (const changed of changes) {
    expect(validateArchiveMeta(changed, provenance(meta)).ok).toBe(false);
    expect(() => optimizationMetaOf(changed)).toThrow();
  }
  const missing = { ...meta };
  delete missing.optimization;
  expect(validateArchiveMeta(missing, provenance(meta)).ok).toBe(false);
  expect(() => optimizationMetaOf(missing)).toThrow(/三个优化阶段/);
});

it("发布时冻结文件身份错配拒绝 rename，候选旁挂不变", () => {
  const root = mkdtempSync(join(scratch, "root-"));
  const stage = openStagingDir(root, "alpha");
  const sidecar = join(root, "archive/alpha/initial.candidate.ts");
  writeFileSync(sidecar, source[0]!);
  writeFileSync(join(stage, "script.ts"), source[2]!);
  writeFileSync(join(stage, "script.js"), products[1]!);
  expect(
    commitArchive({ root, slug: "alpha", runId: "r1", stagingDir: stage, meta: metaOf(1) }),
  ).toMatchObject({ ok: false });
  expect(existsSync(join(root, "archive/alpha/r1"))).toBe(false);
  expect(readFileSync(sidecar, "utf8")).toBe(source[0]);
  discardStagingDir(stage);
});

const writeCandidateSidecars = (root: string, meta: ArchiveMeta, scripts = products): void => {
  const directory = join(root, "archive/alpha");
  mkdirSync(directory, { recursive: true });
  for (const candidate of meta.optimization!.candidates) {
    writeFileSync(join(directory, candidate.scriptFile), scripts[candidate.stage]!);
    writeFileSync(
      join(directory, candidate.scriptFile.replace(/\.js$/, ".ts")),
      source[candidate.stage]!,
    );
    writeFileSync(
      join(directory, candidate.observationsFile),
      [0, 1, 2]
        .map((matchIndex) =>
          JSON.stringify({ matchIndex, delivered: 0, captures: 0, noScoreSource: true }),
        )
        .join("\n"),
    );
  }
};

it("重复 JS 的三个阶段/不同 TS、全部十二场分母、较晚胜者/理由/复用和预算经公开 JSON/Markdown 可审查", async () => {
  const root = mkdtempSync(join(scratch, "report-"));
  const scripts = [products[0]!, products[0]!, products[2]!];
  const meta = metaOf(0, scripts);
  // JS 相同阶段的完整证据一致；各自 TS 身份保留，stage1 复用 stage0。
  const selection = meta.selection!;
  const plan = selection.plan;
  const rebuilt = buildArchiveSelection(
    plan,
    selection.candidates.map((candidate) => ({
      stage: candidate.stage,
      protocolRound: candidate.protocolRound,
      scriptSha256: candidate.scriptSha256,
      sourceSha256: candidate.sourceSha256,
      matches: selection.candidates[candidate.stage === 1 ? 0 : candidate.stage]!.matches,
      ...(candidate.stage === 1 ? { reusedFromStage: 0 as const } : {}),
    })),
  );
  const published = { ...meta, selection: rebuilt };
  const staging = openStagingDir(root, "alpha");
  writeFileSync(join(staging, "script.ts"), source[1]!);
  writeFileSync(join(staging, "script.js"), scripts[1]!);
  expect(
    commitArchive({ root, slug: "alpha", runId: "r1", stagingDir: staging, meta: published }).ok,
  ).toBe(true);
  writeCandidateSidecars(root, published, scripts);
  const [report] = readArchiveReports(root);
  expect(report).toMatchObject({
    candidateStages: 3,
    distinctScripts: 2,
    finalCandidate: { stage: 2 },
    frozenCandidate: { stage: 1, scriptState: "verified" },
    selection: {
      reason: "later-stage",
      countedMatches: 12,
      distinctScripts: 2,
      executedMatches: 24,
      reusedMatches: 12,
      candidates: [
        {
          stage: 0,
          sourceSha256: sha256Hex(source[0]!),
          averagePoints: 3,
          countedMatches: 12,
          reusedFromStage: null,
        },
        {
          stage: 1,
          sourceSha256: sha256Hex(source[1]!),
          averagePoints: 3,
          countedMatches: 12,
          reusedFromStage: 0,
        },
        { stage: 2, sourceSha256: sha256Hex(source[2]!), averagePoints: 0, countedMatches: 12 },
      ],
    },
    budget: {
      model: { maximumConvergedResponses: 15, maximumResponsesPerStage: 5 },
      local: {
        optimizationObservedMatches: 9,
        selectionMaximumMatches: 36,
        selectionExecutedMatches: 24,
        selectionReusedMatches: 12,
      },
    },
  });
  for (const format of [[], ["--json"]]) {
    const output: string[] = [];
    expect(
      await runArchiveReport(["--root", root, ...format], {
        stdout: (text) => output.push(text),
        stderr: () => {},
      }),
    ).toBe(0);
    for (const expected of [
      "later-stage",
      rebuilt.plan.planSha256,
      sha256Hex(source[1]!),
      sha256Hex(scripts[0]!),
    ])
      expect(output.join("")).toContain(expected);
    if (format.length === 0) {
      expect(output.join("")).toContain("不同 JS 数：2");
      expect(output.join("")).toContain("固定分母=12");
      expect(output.join("")).toContain("实际冻结 stage=1");
      expect(output.join("")).toContain("最后生成阶段仍是 stage2");
    }
  }
});

it("历史 earlier-stage 同分档经公共 meta 与真实 report CLI 读取，不改存档字节", () => {
  const root = mkdtempSync(join(scratch, "legacy-selection-"));
  const scripts = [products[0]!, products[0]!, products[0]!];
  const current = metaOf(0, scripts);
  const candidate = current.selection!.candidates[0]!;
  const meta: ArchiveMeta = {
    ...current,
    selection: {
      ...current.selection!,
      selected: {
        stage: candidate.stage,
        protocolRound: candidate.protocolRound,
        scriptSha256: candidate.scriptSha256,
        sourceSha256: candidate.sourceSha256,
      },
      reason: "earlier-stage",
    },
  };
  const directory = join(root, "archive/alpha/r1");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "script.ts"), source[0]!);
  writeFileSync(join(directory, "script.js"), scripts[0]!);
  writeFileSync(join(directory, "meta.json"), JSON.stringify(meta));
  writeCandidateSidecars(root, meta, scripts);
  const bytes = readFileSync(join(directory, "meta.json"));
  expect(validateArchiveMeta(meta, provenance(meta)).ok).toBe(true);
  expect(optimizationMetaOf(meta)).toEqual(meta);
  expect(readArchiveReports(root)[0]?.selection).toMatchObject({
    stage: 0,
    reason: "earlier-stage",
  });
  for (const json of [false, true]) {
    const ran = reportCli(root, json);
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout).toContain("earlier-stage");
  }
  expect(readFileSync(join(directory, "meta.json"))).toEqual(bytes);
  const wrongReason = { ...meta, selection: { ...meta.selection!, reason: "later-stage" } };
  expect(validateArchiveMeta(wrongReason, provenance(meta)).ok).toBe(false);
  expect(() => optimizationMetaOf(wrongReason)).toThrow();
});

it("selection 失败报告保留三个合法候选及 TS/JS 证据，stage2 是最后阶段但无冻结胜者", async () => {
  const root = mkdtempSync(join(scratch, "failure-"));
  const meta = metaOf(1);
  writeCandidateSidecars(root, meta);
  const secret = "PROBE_PRIVATE_DIAGNOSTICS_BODY";
  writeFileSync(
    join(root, "archive/alpha/failed-r1.json"),
    JSON.stringify({
      model: meta.model,
      runId: "r1",
      ruleset: meta.ruleset,
      protocolRounds: meta.protocolRounds,
      prompts: [secret, secret, secret],
      generationLog: [1, 2, 3].map((round) => JSON.stringify({ round })),
      classification: "selection",
      diagnostics: [secret],
      message: secret,
      candidates: meta.optimization!.candidates,
      selectionFailure: {
        plan: meta.selection!.plan,
        candidates: meta.selection!.candidates.map(
          ({ stage, protocolRound, scriptSha256, sourceSha256 }) => ({
            stage,
            protocolRound,
            scriptSha256,
            sourceSha256,
          }),
        ),
      },
    }),
  );
  const [report] = readArchiveReports(root);
  expect(report).toMatchObject({
    kind: "failure",
    candidateStages: 3,
    distinctScripts: 3,
    selection: null,
    frozenCandidate: null,
    initialCandidate: { stage: 0, scriptState: "verified" },
    intermediateCandidates: [{ stage: 1, scriptState: "verified" }],
    finalCandidate: { stage: 2, scriptState: "verified" },
    selectionFailure: {
      matchesPerCandidate: 12,
      candidates: [{ stage: 0 }, { stage: 1 }, { stage: 2 }],
    },
    budget: {
      local: {
        selectionMaximumMatches: 36,
        selectionExecutedMatches: null,
        selectionReusedMatches: null,
      },
    },
  });
  expect(JSON.stringify(report)).not.toContain(secret);
  for (const format of [[], ["--json"]]) {
    const output: string[] = [];
    expect(
      await runArchiveReport(["--root", root, ...format], {
        stdout: (text) => output.push(text),
        stderr: (text) => output.push(text),
      }),
    ).toBe(0);
    expect(output.join("")).not.toContain(secret);
    expect(output.join("")).toContain(meta.selection!.candidates[2]!.sourceSha256);
    if (format.length === 0) expect(output.join("")).toContain("无胜者、无冻结脚本");
  }
  writeFileSync(
    join(
      root,
      "archive/alpha",
      meta.optimization!.candidates[2]!.scriptFile.replace(/\.js$/, ".ts"),
    ),
    "tampered",
  );
  expect(readArchiveReports(root)[0]?.finalCandidate?.scriptState).toBe("mismatch");
});

it("同一较早胜者贯通正式赛季物化输入、CLI 真实装载及生成报告；篡改共用消费者拒绝", async () => {
  const root = mkdtempSync(join(scratch, "consumers-"));
  for (const relative of [
    "maps/open-clash.json",
    `rulesets/${RULESET_VERSION}.json`,
    SANDBOX_RUNTIME_ARTIFACT_PATH,
    QUICKJS_WASI_WASM_PATH,
  ]) {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    copyFileSync(join(process.cwd(), relative), join(root, relative));
  }
  const meta = metaOf(1);
  const staging = openStagingDir(root, "alpha");
  writeFileSync(join(staging, "script.ts"), source[1]!);
  writeFileSync(join(staging, "script.js"), products[1]!);
  expect(commitArchive({ root, slug: "alpha", runId: "r1", stagingDir: staging, meta }).ok).toBe(
    true,
  );
  writeCandidateSidecars(root, meta);
  for (const model of ["beta", "gamma", "delta"]) {
    const dir = join(root, `archive/${model}/r1`);
    mkdirSync(dir, { recursive: true });
    const legacy = { ...meta };
    delete legacy.optimization;
    delete legacy.selection;
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ ...legacy, model, scriptSha256: sha256Hex(products[2]!) }),
    );
    writeFileSync(join(dir, "script.ts"), source[2]!);
    writeFileSync(join(dir, "script.js"), products[2]!);
  }
  writeFileSync(
    join(root, "season.yaml"),
    [
      "masterSeed: ticket04",
      `ruleset: ${RULESET_VERSION}`,
      "seeds: 4",
      "outputDir: runs/fixture",
      "maps:",
      "  - open-clash",
      "evaluationSeeds:",
      ...[404, 505, 606, 707].map((seed) => `  - ${seed}`),
      "participants:",
      ...["alpha", "beta", "gamma", "delta"].map((model) => `  - archive/${model}/r1`),
      "",
    ].join("\n"),
  );
  const inputs: MatchInput[] = [];
  const recordedMeta = readFileSync(join(root, "archive/alpha/r1/meta.json"));
  expect(
    await scheduleSeason(
      { root, configPath: "season.yaml" },
      {
        spawnMatch: async (inputPath) => {
          const input: MatchInput = JSON.parse(readFileSync(inputPath, "utf8"));
          inputs.push(input);
          const loaded = assemble(inputPath, root);
          expect(loaded.ok).toBe(true);
          if (loaded.ok)
            expect(
              loaded.run.scripts[
                input.archives.findIndex((archive) => archive.archivePath === "archive/alpha/r1")
              ],
            ).toBe(products[1]);
          writeFileSync(
            join(dirname(inputPath), "replay.jsonl"),
            `${JSON.stringify({ type: "meta", schemaVersion: 1, ruleset: RULESET_VERSION })}\n${JSON.stringify({ type: "result", rankings: [1, 1, 1, 1], reason: "timeout", territoryScores: [0, 0, 0, 0] })}\n`,
          );
          return { code: 0 };
        },
      },
    ),
  ).toBe(0);
  expect(inputs).toHaveLength(4);
  const refs = inputs
    .flatMap((input) => input.archives)
    .filter((archive) => archive.archivePath === "archive/alpha/r1");
  expect(refs).toHaveLength(4);
  for (const ref of refs)
    expect(ref).toEqual({
      archivePath: "archive/alpha/r1",
      scriptSha256: sha256Hex(products[1]!),
      metaSha256: sha256Hex(recordedMeta),
    });
  expect(
    readArchiveReports(root).find((report) => report.model === "alpha")?.frozenCandidate,
  ).toMatchObject({ stage: 1, scriptState: "verified" });
  expect(readFileSync(join(root, "archive/alpha/r1/meta.json"))).toEqual(recordedMeta);
  // 完整形状中的伪造计分：共享关系校验在 input 物化之前拒绝。
  const tampered = {
    ...meta,
    selection: {
      ...meta.selection!,
      candidates: meta.selection!.candidates.map((candidate) => ({
        ...candidate,
        averagePoints: 2,
      })),
    },
  };
  writeFileSync(join(root, "archive/alpha/r1/meta.json"), JSON.stringify(tampered));
  expect(validateArchiveMeta(tampered, provenance(meta)).ok).toBe(false);
  expect(() => optimizationMetaOf(tampered)).toThrow();
  expect(() => readArchiveReports(root)).toThrow();
  let spawned = 0;
  await expect(
    scheduleSeason(
      { root, configPath: "season.yaml" },
      {
        spawnMatch: async () => {
          spawned += 1;
          return { code: 0 };
        },
      },
    ),
  ).rejects.toThrow();
  expect(spawned).toBe(0);
});

const selectionScriptPaths = [
  "r1/script.ts",
  "r1/script.js",
  ...[1, 2, 3].flatMap((round) => [
    `observed-r1-round-${round}.jsonl.candidate.ts`,
    `observed-r1-round-${round}.jsonl.candidate.js`,
  ]),
];
it.each(selectionScriptPaths)(
  "真实 report CLI 拒绝选拔档 %s 的篡改、缺失或不可读，安全错误且不计成功",
  (relative) => {
    const root = mkdtempSync(join(scratch, "tamper-"));
    const meta = metaOf(1);
    const staging = openStagingDir(root, "alpha");
    writeFileSync(join(staging, "script.ts"), source[1]!);
    writeFileSync(join(staging, "script.js"), products[1]!);
    expect(commitArchive({ root, slug: "alpha", runId: "r1", stagingDir: staging, meta }).ok).toBe(
      true,
    );
    writeCandidateSidecars(root, meta);
    const path = join(root, "archive/alpha", relative);
    const original = readFileSync(path);
    const metaBytes = readFileSync(join(root, "archive/alpha/r1/meta.json"));
    const secret = "PRIVATE_TAMPER_PROMPT_PROVIDER_BODY";
    for (const mode of ["tampered", "missing", "unreadable"]) {
      rmSync(path, { recursive: true, force: true });
      if (mode === "tampered") writeFileSync(path, secret);
      if (mode === "unreadable") mkdirSync(path);
      const issues: { source: string; reason: string }[] = [];
      expect(readArchiveReports(root, { onReadIssue: (issue) => issues.push(issue) })).toEqual([]);
      expect(issues).toEqual([
        {
          source: "archive/alpha/r1/meta.json",
          reason: "记录 JSON、优化/选拔元数据或候选身份不合法，无法生成摘要",
        },
      ]);
      expect(() => readArchiveReports(root)).toThrow(/候选身份不合法/);
      for (const json of [true, false]) {
        const result = reportCli(root, json);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("读取记录失败 archive/alpha/r1/meta.json");
        expect(result.stderr).toContain("候选身份不合法");
        expect(result.stdout + result.stderr).not.toContain(secret);
        if (json) expect(JSON.parse(result.stdout)).toEqual([]);
        else {
          expect(result.stdout).toContain("成功记录 0");
          expect(result.stdout).not.toContain("## alpha · success");
        }
      }
    }
    rmSync(path, { recursive: true, force: true });
    writeFileSync(path, original);
    expect(reportCli(root, true).status).toBe(0);
    expect(readFileSync(join(root, "archive/alpha/r1/meta.json"))).toEqual(metaBytes);
  },
);

it("旧优化档字节错配仍作兼容诊断；不把缺选拔记录的旧档套入新档严格规则", () => {
  const root = mkdtempSync(join(scratch, "legacy-diagnostic-"));
  const meta = { ...metaOf(2) };
  delete meta.selection;
  const staging = openStagingDir(root, "alpha");
  writeFileSync(join(staging, "script.ts"), source[2]!);
  writeFileSync(join(staging, "script.js"), products[2]!);
  expect(commitArchive({ root, slug: "alpha", runId: "r1", stagingDir: staging, meta }).ok).toBe(
    true,
  );
  writeCandidateSidecars(root, meta);
  writeFileSync(join(root, "archive/alpha/r1/script.js"), "tampered legacy frozen");
  writeFileSync(
    join(root, "archive/alpha", meta.optimization!.candidates[0]!.scriptFile),
    "tampered legacy candidate",
  );
  const [report] = readArchiveReports(root);
  expect(report).toMatchObject({
    kind: "success",
    selection: null,
    initialCandidate: { scriptState: "mismatch" },
    frozenCandidate: { scriptState: "mismatch" },
  });
  const result = reportCli(root, true);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)[0]).toMatchObject({
    selection: null,
    frozenCandidate: { scriptState: "mismatch" },
  });
});
