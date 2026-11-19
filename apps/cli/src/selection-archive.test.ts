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
  OPTIMIZATION_AGENT_VERSION,
  SANDBOX_RUNTIME_ARTIFACT_PATH,
  SELECTION_AGENT_VERSION,
  TRIAL_GRID_MAP_NAMES,
  TRIAL_MATCHES_PER_CANDIDATE,
  type MatchInput,
  type ArchiveMeta,
  type ArchiveSelectionV1,
  type ReplayResultLine,
  type TrialPlan,
  type TrialPlanScript,
} from "@model-war/schema";
import {
  buildArchiveGridSelection,
  buildSelectionPlan,
  buildTrialPlan,
  buildArchiveSelection,
  selectionInputSha256,
  optimizationMetaOf,
  readArchiveReports,
  runArchiveReport,
  scheduleSeason,
  trialMatchInputSha256,
  validateSelection,
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

/**
 * 这个文件造的**全是 one-shot 形态**的档（v1 / v2：候选带 `stage`、选拔带 `stage` 与
 * `protocolRound`）。v3 的候选没有 `stage`，所以读这些栏之前先按版本收窄——顺便把
 * 「这个用例造的不是 v3」也钉成一条判据。
 */
const legacyCandidatesOf = (meta: ArchiveMeta) => {
  const optimization = meta.optimization;
  if (optimization === undefined || optimization.version === OPTIMIZATION_AGENT_VERSION)
    throw new Error("这个用例只造 one-shot 形态的优化段");
  return optimization.candidates;
};
const legacySelectionCandidatesOf = (meta: ArchiveMeta) => {
  const selection = meta.selection;
  if (selection === undefined || selection.version === SELECTION_AGENT_VERSION)
    throw new Error("这个用例只造 one-shot 形态的选拔段");
  return selection.candidates;
};

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
/** 这一档的选拔段：v1 形状（本文件的 fixture 全是历史口径，v2 另有用例）。 */
const selectionOf = (meta: ArchiveMeta): ArchiveSelectionV1 => meta.selection as ArchiveSelectionV1;
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
    channelId: "test-channel",
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
    for (const candidate of legacyCandidatesOf(meta)) {
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
  // 每条篡改都要落在**它该落在的那一关**:候选/冻结 hash 关系、胜者身份、形状(少一个候选)、
  // 优化阶段与选拔的逐位一致。消息取自 `archive-optimization.ts` 与 v1 校验的抛点。
  const expected = [
    "选拔候选、冻结 hash 或执行环境与优化存档不一致",
    "选拔胜者身份或选择理由不一致",
    "优化存档元数据形状不合法",
    "选拔候选、冻结 hash 或执行环境与优化存档不一致",
  ] as const;
  expect(changes).toHaveLength(expected.length);
  for (const [index, changed] of changes.entries()) {
    expect(validateArchiveMeta(changed, provenance(meta)).ok).toBe(false);
    expect(() => optimizationMetaOf(changed), `changed ${String(index)}`).toThrow(expected[index]);
  }
  const missing = { ...meta };
  delete missing.optimization;
  expect(validateArchiveMeta(missing, provenance(meta)).ok).toBe(false);
  // 措辞不再假设「恰好三个阶段」：判据仍是「选拔档必须带优化段」。
  expect(() => optimizationMetaOf(missing)).toThrow(/必须包含优化段/);
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

const writeCandidateSidecars = (
  root: string,
  meta: ArchiveMeta,
  scripts = products,
  slug = "alpha",
): void => {
  const directory = join(root, "archive", slug);
  mkdirSync(directory, { recursive: true });
  for (const candidate of legacyCandidatesOf(meta)) {
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
  const selection = selectionOf(meta);
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
      expect(output.join("")).toContain("实际冻结候选位置=1");
      expect(output.join("")).toContain("末位候选位置=2");
    }
  }
});

it("历史 earlier-stage 同分档经公共 meta 与真实 report CLI 读取，不改存档字节", () => {
  const root = mkdtempSync(join(scratch, "legacy-selection-"));
  const scripts = [products[0]!, products[0]!, products[0]!];
  const current = metaOf(0, scripts);
  const currentSelection = selectionOf(current);
  const candidate = currentSelection.candidates[0]!;
  const meta: ArchiveMeta = {
    ...current,
    selection: {
      ...currentSelection,
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
  expect(() => optimizationMetaOf(wrongReason)).toThrow("选拔胜者身份或选择理由不一致");
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
      candidates: legacyCandidatesOf(meta),
      selectionFailure: {
        plan: meta.selection!.plan,
        candidates: legacySelectionCandidatesOf(meta).map(
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
  expect(() => optimizationMetaOf(tampered)).toThrow("选拔候选计分或结果顺序不一致");
  expect(() => readArchiveReports(root)).toThrow("无法生成摘要");
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
  ).rejects.toThrow("选拔候选计分或结果顺序不一致");
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

/** 篡改时铺进去的哨兵字节：它出现在任何输出里都算泄漏。 */
const tamperSecret = "PRIVATE_TAMPER_PROMPT_PROVIDER_BODY";

/** 三种损坏的造法。调用前目标路径已被清掉，这里只铺上对应形状。 */
const corruptions: readonly { mode: string; damage: (path: string) => void }[] = [
  { mode: "tampered", damage: (path) => writeFileSync(path, tamperSecret) },
  { mode: "missing", damage: () => undefined },
  { mode: "unreadable", damage: (path) => mkdirSync(path) },
];

/** 记录读不出来时读侧只给一句总说法——它不对外分解「是缺、是坏、还是不可读」。 */
const unreadableReason = "记录 JSON、优化/选拔元数据或候选身份不合法，无法生成摘要";

/** slug 既是目录名也是 `meta.model`：让它自己说明坏的是哪个文件、哪一种坏法。 */
const tamperSlugOf = (mode: string, relative: string): string =>
  `corrupt-${mode}-${relative.replaceAll(/[^a-z0-9]+/g, "-")}`;

/**
 * 真实 report CLI 拒绝选拔档：篡改、缺失、不可读，逐个文件、逐条断言。
 *
 * **进程启动账**——下一次改这里的人先读这一段。改之前是 8 个 `it.each` 路径、每条 7 次
 * spawn，合计 56 次（3 种损坏 × 2 种格式 = 6，加收尾 `status === 0` 一次），单实例空载
 * 3.4–4.0 s，而它挂在 `unit` project 的 vitest 默认 5 s 上：本次合并期间它两次因超时红，
 * 两次都是超时，不是断言失败。压在它身上的是**进程启动**，不是那几条断言：一次 spawn
 * 按 ~0.18 s 起步（`node -e ""` 约 0.05 s，余下是载那个 ~1.9 MB 的 CLI 包），7 次就是
 * 一整条用例的耗时。
 *
 * 现在**这条用例只剩 1 次 spawn**（+0.07 s 读这 24 份坏档），加上造 24 份档与两趟读取
 * 各一下，单例空载实测 0.6–0.8 s。JSON 走真进程（进程边界 + argv 解析 + 退出码），
 * Markdown 走**同一个处理器** `runArchiveReport`（CLI 就是把子命令路由到它）并注入 io。
 * 两种格式的判据一条没少，少的只是第二次进程启动——退出码映射由 JSON 那一趟证明，
 * 渲染差异本来就在处理器里、不在进程边界上。收尾那次 `status === 0` 的进程也不再单独起：
 * 它验的是「损坏修回去之后档案又能读、`meta.json` 字节没被动过」，前半由同一函数的共享
 * 读取（`readArchiveReports`）在末尾断言，后半逐档按字节比。
 *
 * **超时预算**（与上头那笔启动账配套）：这条用例自己的进程只有 1 次，其余都是同一进程里的
 * 造档与两趟读取，所以它不该再跟 `unit` project 的默认 5 s 赛跑。本机实测：空载 0.7 s；
 * `--maxWorkers=8` 全量并发 1.8–2.6 s，差的那一截是 1 次 spawn 被 CPU 争用拖慢（`node -e ""`
 * 空载 0.05 s，可见不是用例自己加的活）。预算是最坏并发读数的 ~5.8 倍，常量写在这条用例上，
 * 与 `apps/cli/src/cli.test.ts` 给真 spawn 用例 `{ timeout: 30_000 }` / `120_000` 同一种做法：
 * 看得见，不藏在 project 默认值里，也不替结构问题打掩护。
 *
 * **为什么三种损坏要各占一份档**：`meta.model` 必须等于目录 slug（`archive-report.ts` 的
 * `readRecord` 会拒），而 tampered / missing / unreadable 是同一个路径的三个互斥状态，
 * 所以「一次造齐」只能是「每个 (文件 × 损坏形状) 一份档」= 8 × 3 = 24 份，同一个 root、
 * 两趟读取跑完。断言因此从「每次一种损坏、一条 issue」变成「一次 24 条 issue、逐条对上
 * 来源」——判据只多不少，少的是重复的进程启动。共享读取那一层只抽一份留一条
 * `onReadIssue` 形状的断言，是因为它与上面两趟读的是同一份档、走的是同一个
 * `readArchiveReports`，再读一遍 24 份只是重跑同一件事。
 */
it(
  "真实 report CLI 在同一个 root 里逐条拒绝选拔档的篡改、缺失或不可读，安全错误且不计成功",
  { timeout: 15_000 },
  async () => {
    const root = mkdtempSync(join(scratch, "tamper-"));
    const cases = selectionScriptPaths.flatMap((relative) =>
      corruptions.map(({ mode, damage }) => ({
        relative,
        mode,
        damage,
        slug: tamperSlugOf(mode, relative),
      })),
    );
    const originals = new Map<string, Buffer>();
    const metaBytes = new Map<string, Buffer>();
    const at = (slug: string, relative: string): string => join(root, "archive", slug, relative);

    // 24 份档只差 `model`（= 目录 slug），其余逐位相同：造一次，按 slug 换 `model` 复制。
    const baseMeta = metaOf(1);
    for (const { slug } of cases) {
      const meta = { ...baseMeta, model: slug };
      const staging = openStagingDir(root, slug);
      writeFileSync(join(staging, "script.ts"), source[1]!);
      writeFileSync(join(staging, "script.js"), products[1]!);
      expect(commitArchive({ root, slug, runId: "r1", stagingDir: staging, meta }).ok, slug).toBe(
        true,
      );
      writeCandidateSidecars(root, meta, products, slug);
      metaBytes.set(slug, readFileSync(join(root, "archive", slug, "r1/meta.json")));
    }

    for (const { relative, damage, slug } of cases) {
      const path = at(slug, relative);
      originals.set(`${slug}/${relative}`, readFileSync(path));
      rmSync(path, { recursive: true, force: true });
      damage(path);
    }

    const expectedSources = cases.map(({ slug }) => `archive/${slug}/r1/meta.json`);
    // 共享读取这一层（其它消费者用的就是它）：坏档一条都不许当作报告返回，且逐条说得出出处。
    // 逐条枚举走下面两趟格式，这里只钉「不给 `onReadIssue` 就抛」与「给了也不伪造报告」。
    expect(() => readArchiveReports(root)).toThrow(/候选身份不合法/);
    const sample = cases[0]!.slug;
    const sampledIssues: { source: string; reason: string }[] = [];
    expect(
      readArchiveReports(root, {
        model: sample,
        onReadIssue: (issue) => sampledIssues.push(issue),
      }),
    ).toEqual([]);
    expect(sampledIssues).toEqual([
      { source: `archive/${sample}/r1/meta.json`, reason: unreadableReason },
    ]);

    // 格式一：真进程、`--json`。
    const json = reportCli(root, true);
    expect(json.status, json.stderr).toBe(1);
    for (const source of expectedSources)
      expect(json.stderr, source).toContain(`读取记录失败 ${source}`);
    expect(json.stderr.match(/读取记录失败/g)).toHaveLength(cases.length);
    expect(json.stderr).toContain("候选身份不合法");
    expect(json.stdout + json.stderr).not.toContain(tamperSecret);
    expect(JSON.parse(json.stdout)).toEqual([]);

    // 格式二：同一个处理器、Markdown 渲染（不另起进程，见头注的启动账）。
    const stdout: string[] = [];
    const stderr: string[] = [];
    const markdownCode = await runArchiveReport(["--root", root], {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });
    const markdown = { stdout: stdout.join(""), stderr: stderr.join("") };
    expect(markdownCode, markdown.stderr).toBe(1);
    for (const source of expectedSources)
      expect(markdown.stderr, source).toContain(`读取记录失败 ${source}`);
    expect(markdown.stderr.match(/读取记录失败/g)).toHaveLength(cases.length);
    expect(markdown.stdout + markdown.stderr).not.toContain(tamperSecret);
    // 「不计成功」：坏档案不进成功记录，也不渲染成成功档的一节。
    expect(markdown.stdout).toContain("成功记录 0");
    expect(markdown.stdout).not.toContain("· success");

    // 损坏修回去：字节没被动过，档案重新可读。
    for (const { relative, slug } of cases) {
      const path = at(slug, relative);
      rmSync(path, { recursive: true, force: true });
      writeFileSync(path, originals.get(`${slug}/${relative}`)!);
    }
    for (const { slug } of cases)
      expect(
        readFileSync(join(root, "archive", slug, "r1/meta.json")).equals(metaBytes.get(slug)!),
        slug,
      ).toBe(true);
    // 「又能读」每种损坏抽一份：一次成功读档要按候选 × 整张网格重算，24 份全读会把这条
    // 用例的耗时重新推回它要压的那个量级，而 24 份档的修复本身已由上面的字节比对钉住。
    for (const { mode } of corruptions) {
      const slug = tamperSlugOf(mode, selectionScriptPaths[0]!);
      expect(
        readArchiveReports(root, { model: slug }).map((report) => report.model),
        slug,
      ).toEqual([slug]);
    }
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

/**
 * v2（评测网格）存档：计划与生成阶段同一份、选拔分数与存档分数逐位相同。
 *
 * 这一档只断言「读得进来、校验得过去、篡改被拒」——报告口径归 08。
 */
const gridSparring: readonly TrialPlanScript[] = [
  { role: "top", id: "top:alpha", source: "archive:alpha/r1", scriptSha256: "1".repeat(64) },
  { role: "mid", id: "mid:beta", source: "archive:beta/r2", scriptSha256: "2".repeat(64) },
  { role: "last", id: "last:gamma", source: "archive:gamma/r3", scriptSha256: "3".repeat(64) },
  {
    role: "incumbent",
    id: "incumbent:delta",
    source: "archive:delta/r4#substitute",
    scriptSha256: "4".repeat(64),
  },
];

const gridPlanOf = (): TrialPlan =>
  buildTrialPlan({
    ruleset: RULESET_VERSION,
    rulesetSha256: "9".repeat(64),
    sandboxRuntimeHash: SANDBOX_RUNTIME_HASH,
    scripts: gridSparring,
    maps: [
      { name: TRIAL_GRID_MAP_NAMES[0], sha256: "a".repeat(64) },
      { name: TRIAL_GRID_MAP_NAMES[1], sha256: "b".repeat(64) },
    ],
  });

/** v2 存档：三份候选各 32 场证据，stage0 全胜、其余全败（于是胜者是 stage0）。 */
const gridMetaOf = (options: { readonly mutateSelection?: boolean } = {}): ArchiveMeta => {
  const plan = gridPlanOf();
  const points = [3, 0, 0] as const;
  const selection = buildArchiveGridSelection(
    plan,
    ([0, 1, 2] as const).map((stage) => {
      const scriptSha256 = sha256Hex(products[stage]!);
      return {
        stage,
        protocolRound: stage + 1,
        scriptSha256,
        sourceSha256: sha256Hex(source[stage]!),
        score: {
          totalPoints: points[stage]! * TRIAL_MATCHES_PER_CANDIDATE,
          averagePoints: points[stage]!,
          countedMatches: TRIAL_MATCHES_PER_CANDIDATE,
        },
        matches: plan.matches.map((match) => ({
          matchIndex: match.matchIndex,
          inputSha256: trialMatchInputSha256(plan, scriptSha256, match),
          observationSha256: "e".repeat(64),
          candidatePoints: points[stage]!,
        })),
      };
    }),
  );
  const meta = buildArchiveMeta({
    model: "alpha",
    modelVersion: "test",
    channelId: "test-channel",
    generatedAt: "2026-10-13T00:00:00Z",
    prompts: ["initial", "feedback1", "feedback2"],
    generationLog: [],
    validation: { passed: true, errors: [] },
    tscVersion: "7.0.2",
    scriptSha256: sha256Hex(products[0]!),
    optimization: {
      version: 2,
      feedbackRounds: 2,
      plan,
      sparring: gridSparring.map(({ id, role, source: from, scriptSha256 }) => ({
        id,
        role,
        source: from,
        scriptSha256,
      })),
      candidates: ([0, 1, 2] as const).map((stage) => ({
        stage,
        protocolRound: stage + 1,
        scriptFile: `observed-r1-round-${stage + 1}.jsonl.candidate.js`,
        observationsFile: `observed-r1-round-${stage + 1}.jsonl`,
        scriptSha256: sha256Hex(products[stage]!),
        score: {
          totalPoints: points[stage]! * TRIAL_MATCHES_PER_CANDIDATE,
          averagePoints: points[stage]!,
          countedMatches: TRIAL_MATCHES_PER_CANDIDATE,
        },
        matchCount: TRIAL_MATCHES_PER_CANDIDATE,
      })),
    },
    selection,
  });
  return options.mutateSelection === true
    ? (() => {
        const forged = JSON.parse(JSON.stringify(meta)) as ArchiveMeta;
        const grid = forged.selection as import("@model-war/schema").ArchiveGridSelection;
        Reflect.set(grid.candidates[0]!, "score", {
          totalPoints: 0,
          averagePoints: 0,
          countedMatches: TRIAL_MATCHES_PER_CANDIDATE,
        });
        return forged;
      })()
    : meta;
};

it("v2 网格存档经公共 meta 校验与报告读入：计划同源、分数逐位一致；改任一处即拒", () => {
  const root = mkdtempSync(join(scratch, "grid-archive-"));
  const meta = gridMetaOf();
  const directory = join(root, "archive/alpha/r1");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "script.ts"), source[0]!);
  writeFileSync(join(directory, "script.js"), products[0]!);
  writeFileSync(join(directory, "meta.json"), JSON.stringify(meta));
  writeCandidateSidecars(root, meta);
  expect(validateArchiveMeta(meta, provenance(meta)).ok).toBe(true);
  expect(optimizationMetaOf(meta)).toEqual(meta);
  expect(validateSelection(meta.selection)!.version).toBe(2);
  expect(readArchiveReports(root)[0]?.selection).toMatchObject({
    version: 2,
    stage: 0,
    averagePoints: 3,
    countedMatches: TRIAL_MATCHES_PER_CANDIDATE,
    reason: "highest-average-points",
  });

  // 选拔分数与生成阶段的网格分数逐位不同 → 存档不成立。
  const forged = gridMetaOf({ mutateSelection: true });
  expect(() => optimizationMetaOf(forged)).toThrow(/分数/);
  expect(validateArchiveMeta(forged, provenance(forged)).ok).toBe(false);

  // 选拔计划与生成阶段的计划不同源（换一张图）→ 存档不成立。
  const otherPlan = gridMetaOf();
  const grid = otherPlan.selection as import("@model-war/schema").ArchiveGridSelection;
  const rebuilt = buildTrialPlan({
    ruleset: RULESET_VERSION,
    rulesetSha256: "9".repeat(64),
    sandboxRuntimeHash: SANDBOX_RUNTIME_HASH,
    scripts: gridSparring,
    maps: [
      { name: TRIAL_GRID_MAP_NAMES[0], sha256: "c".repeat(64) },
      { name: TRIAL_GRID_MAP_NAMES[1], sha256: "b".repeat(64) },
    ],
  });
  expect(() =>
    optimizationMetaOf({
      ...otherPlan,
      selection: buildArchiveGridSelection(
        rebuilt,
        grid.candidates.map((candidate) => ({
          ...candidate,
          matches: candidate.matches.map((match, index) => ({
            ...match,
            inputSha256: trialMatchInputSha256(
              rebuilt,
              candidate.scriptSha256,
              rebuilt.matches[index]!,
            ),
          })),
        })),
      ),
    }),
  ).toThrow(/不同源/);
});
