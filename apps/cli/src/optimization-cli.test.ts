import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";

const scratch = mkdtempSync(join(tmpdir(), "modelwar-optimization-cli-"));
const bundle = join(scratch, "modelwar.mjs");
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

beforeAll(async () => {
  await build({
    entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: bundle,
  });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const run = (root: string, command: string, args: readonly string[] = []) =>
  spawnSync(process.execPath, [bundle, command, "--root", root, ...args], { encoding: "utf8" });

// 完全隔离的临时存档；优化 seed 固定，正式 seed 只在拒绝用例中有意重叠。
const fixture = (evaluationSeeds: readonly number[], resume = false) => {
  const root = mkdtempSync(join(scratch, "root-"));
  const roster = ["alpha", "beta", "delta", "gamma"];
  const candidates = [0, 1, 2].map((stage) => ({
    stage,
    protocolRound: stage + 1,
    scriptFile: `observed-r1-round-${stage + 1}.jsonl.candidate.js`,
    observationsFile: `observed-r1-round-${stage + 1}.jsonl`,
    scriptSha256: hash(`function loop(){ return ${stage}; }\n`),
  }));
  const scripts = roster.map(() => "function loop(){ return 2; }\n");
  const metas = roster.map((model, index) =>
    JSON.stringify({
      model,
      modelVersion: "fixture",
      generatedAt: "2026-10-12T00:00:00Z",
      ruleset: "v2",
      protocolRounds: 3,
      prompts: ["initial", "first feedback", "second feedback"],
      generationLog: [],
      validation: { passed: true, errors: [] },
      tscVersion: "7.0.2",
      scriptSha256: hash(scripts[index]!),
      sandboxRuntimeHash: "b".repeat(64),
      ...(model === "alpha"
        ? {
            optimization: {
              version: 1,
              feedbackRounds: 2,
              trialSeeds: [101, 202, 303],
              candidates,
            },
          }
        : {}),
    }),
  );
  for (const [index, model] of roster.entries()) {
    const directory = join(root, "archive", model, "r1");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "script.js"), scripts[index]!);
    writeFileSync(join(directory, "meta.json"), metas[index]!);
  }
  for (const candidate of candidates) {
    writeFileSync(
      join(root, "archive/alpha", candidate.scriptFile),
      `function loop(){ return ${candidate.stage}; }\n`,
    );
    writeFileSync(
      join(root, "archive/alpha", candidate.observationsFile),
      [0, 1, 2]
        .map((matchIndex) =>
          JSON.stringify({
            matchIndex,
            delivered: candidate.stage * 10,
            captures: 0,
            noScoreSource: candidate.stage === 0,
          }),
        )
        .join("\n") + "\n",
    );
  }
  mkdirSync(join(root, "maps"));
  const map = JSON.stringify({ name: "arena" });
  writeFileSync(join(root, "maps/arena.json"), map);
  writeFileSync(
    join(root, "season.yaml"),
    [
      "masterSeed: fixture-independent",
      "ruleset: v2",
      "seeds: 4",
      "outputDir: runs/fixture",
      "maps:",
      "  - arena",
      "participants:",
      ...roster.map((model) => `  - archive/${model}/r1`),
      "evaluationSeeds:",
      ...evaluationSeeds.map((seed) => `  - ${seed}`),
      "",
    ].join("\n"),
  );
  if (resume)
    for (const [index, seed] of evaluationSeeds.entries()) {
      const directory = join(root, `runs/fixture/matches/c0-arena-s${index}`);
      mkdirSync(directory, { recursive: true });
      const seats = [...roster.slice(index), ...roster.slice(0, index)];
      const input = {
        archives: seats.map((model) => {
          const seat = roster.indexOf(model);
          return {
            archivePath: `archive/${model}/r1`,
            scriptSha256: hash(scripts[seat]!),
            metaSha256: hash(metas[seat]!),
          };
        }),
        map: "arena",
        mapSha256: hash(map),
        seed,
        ruleset: "v2",
      };
      writeFileSync(join(directory, "input.json"), JSON.stringify(input, null, 2) + "\n");
      writeFileSync(
        join(directory, "replay.jsonl"),
        [
          { type: "meta", schemaVersion: 1, ruleset: "v2" },
          {
            type: "result",
            rankings: [1, 2, 3, 4],
            reason: "timeout",
            territoryScores: [0, 0, 0, 0],
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n") + "\n",
      );
    }
  return { root, candidates };
};

it("report CLI 离线输出独立初末描述符，旧四栏优化观测保持兼容", () => {
  const { root, candidates } = fixture([404, 505, 606, 707]);
  const result = run(root, "report", ["--model", "alpha", "--json"]);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject([
    {
      initialCandidate: {
        stage: 0,
        scriptSha256: candidates[0]!.scriptSha256,
        scriptState: "verified",
        observations: { observedMatches: 3, noScoreSource: 3 },
      },
      finalCandidate: {
        stage: 2,
        scriptSha256: candidates[2]!.scriptSha256,
        scriptState: "verified",
        observations: { observedMatches: 3, noScoreSource: 0 },
      },
    },
  ]);
});

it.each([
  [[101, 404, 505, 606], false],
  [[101, 202, 303, 404], false],
  [[101, 202, 303, 404], true],
] as const)("run CLI 拒绝重叠 seed %j（resume=%s），不静默换 seed", (seeds, resume) => {
  const { root } = fixture(seeds, resume);
  const result = run(root, "run", ["--config", "season.yaml"]);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("优化/选拔 seeds 重叠");
  expect(result.stderr).toContain("c0-arena-s0");
  expect(result.stderr).toContain("masterSeed");
  for (const seed of seeds.filter((seed) => [101, 202, 303].includes(seed)))
    expect(result.stderr).toContain(String(seed));
  expect(existsSync(join(root, "runs/fixture/report.json"))).toBe(false);
  if (!resume) expect(existsSync(join(root, "runs/fixture"))).toBe(false);
});

it("run CLI 在独立 seed 上离线续跑，只保留最终档四人四局规模", () => {
  const { root } = fixture([404, 505, 606, 707], true);
  const result = run(root, "run", ["--config", "season.yaml"]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(existsSync(join(root, "runs/fixture/report.json"))).toBe(true);
});

it.each([
  [404, 505],
  [101 + 2 ** 32, 404, 505, 606],
  [-1, 404, 505, 606],
  [0.5, 404, 505, 606],
])("run CLI 拒绝规模不符或非 uint32 的显式 seed %j，并点名 evaluationSeeds", (...seeds) => {
  const { root } = fixture(seeds);
  const result = run(root, "run", ["--config", "season.yaml"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("evaluationSeeds");
  expect(existsSync(join(root, "runs/fixture"))).toBe(false);
});
