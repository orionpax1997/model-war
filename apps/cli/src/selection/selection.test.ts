import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import {
  RULESET_VERSION,
  type ArchiveSelection,
  type Ruleset,
  type SelectionPlan,
} from "@model-war/schema";
import { perMatchScores, validateSelection } from "@model-war/runner";
import { TRIAL_OPPONENTS } from "../trial/trial.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "modelwar-selection-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const hash = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
const fixture = (scripts: readonly string[], extra: Partial<Ruleset> = {}) => {
  const root = mkdtempSync(join(scratch, "root-"));
  for (const name of ["packages", "node_modules", "maps"])
    symlinkSync(join(repoRoot, name), join(root, name), "dir");
  const rules: Ruleset = JSON.parse(
    readFileSync(join(repoRoot, "rulesets", `${RULESET_VERSION}.json`), "utf8"),
  );
  mkdirSync(join(root, "rulesets"));
  writeFileSync(
    join(root, "rulesets", `${RULESET_VERSION}.json`),
    JSON.stringify({ ...rules, tickLimit: 4, ...extra }),
  );
  for (const opponent of TRIAL_OPPONENTS) {
    mkdirSync(join(root, "benchmarks", opponent), { recursive: true });
    writeFileSync(join(root, "benchmarks", opponent, "script.js"), "function loop() {}\n");
  }
  const candidates = scripts.map((script, stage) => {
    const scriptPath = join(root, `candidate-${stage}.js`);
    const sourcePath = join(root, `candidate-${stage}.ts`);
    const source = `type Stage${stage} = number;\n${script}`;
    writeFileSync(scriptPath, script);
    writeFileSync(sourcePath, source);
    return {
      stage,
      protocolRound: stage + 1,
      scriptSha256: hash(script),
      sourceSha256: hash(source),
      scriptPath,
      sourcePath,
    };
  });
  const run = (mode: readonly string[], input?: unknown, nodeArgs: readonly string[] = []) =>
    spawnSync(
      process.execPath,
      [
        ...nodeArgs,
        join(repoRoot, "apps/cli/dist/selection/run-selection.js"),
        "--root",
        root,
        ...mode,
      ],
      {
        encoding: "utf8",
        input: input === undefined ? undefined : JSON.stringify(input),
        timeout: 30000,
      },
    );
  const prepared = run(["--plan"]);
  expect(prepared.status, prepared.stderr).toBe(0);
  const expectedPlan: SelectionPlan = JSON.parse(prepared.stdout);
  return { root, candidates, expectedPlan, run };
};

it(
  "真实 CLI/QuickJS 十二场覆盖四座、固定三种子，正常 timeout 全零并列仍按完整终局计分并复用 JS",
  { timeout: 30000 },
  () => {
    const f = fixture(["function loop() {}\n", "function loop() {}\n", "function loop() {}\n"]);
    const ran = f.run([], f);
    expect(ran.status, ran.stderr).toBe(0);
    const selection: ArchiveSelection = JSON.parse(ran.stdout);
    expect(selection.plan.matches.map((match) => match.candidateSeat)).toEqual([
      0, 3, 2, 1, 0, 3, 2, 1, 0, 3, 2, 1,
    ]);
    expect(selection.plan.matches.map((match) => match.seed)).toEqual([
      401, 401, 401, 401, 402, 402, 402, 402, 403, 403, 403, 403,
    ]);
    expect(selection.selected.stage).toBe(2);
    expect(selection.reason).toBe("later-stage");
    expect(selection.selected.sourceSha256).toBe(f.candidates[2]!.sourceSha256);
    expect(selection.candidates.map((candidate) => candidate.stage)).toEqual([0, 1, 2]);
    expect(selection.candidates.map((candidate) => candidate.reusedFromStage)).toEqual([
      undefined,
      0,
      0,
    ]);
    for (const candidate of selection.candidates) {
      expect(candidate.matches).toHaveLength(12);
      expect(candidate.countedMatches).toBe(12);
      expect(candidate.averagePoints).toBe(1.5);
      for (const [index, match] of candidate.matches.entries()) {
        expect(match.result).toMatchObject({
          type: "result",
          reason: "timeout",
          rankings: [1, 1, 1, 1],
        });
        const seats = selection.plan.matches[index]!.seats;
        expect(match.candidatePoints).toBe(
          perMatchScores(
            String(index),
            seats.map((player, seat) => ({ player, rank: match.result.rankings[seat]! })),
          )[selection.plan.matches[index]!.candidateSeat],
        );
      }
    }
    const valid = f.run(["--validate"], { ...f, selection });
    expect(valid.status, valid.stderr).toBe(0);
    const { stage, protocolRound, scriptSha256, sourceSha256 } = selection.candidates[0]!;
    const legacy: ArchiveSelection = {
      ...selection,
      selected: { stage, protocolRound, scriptSha256, sourceSha256 },
      reason: "earlier-stage",
    };
    expect(validateSelection(legacy)).toEqual(legacy);
    const rejectedLegacy = f.run(["--validate"], { ...f, selection: legacy });
    expect(rejectedLegacy.status).toBe(2);
    expect(rejectedLegacy.stdout).toBe("");
    expect(rejectedLegacy.stderr).toBe("选拔执行或完整证据校验失败\n");
    Reflect.set(selection.candidates[0]!, "matches", selection.candidates[0]!.matches.slice(0, 11));
    const invalid = f.run(["--validate"], { ...f, selection });
    expect(invalid.status).toBe(2);
    expect(invalid.stdout).toBe("");
  },
);

it("真实候选正常三振淘汰保留十二场终局，四座积分均为零，不缩小分母", { timeout: 30000 }, () => {
  const f = fixture([
    "function loop() { throw new Error('guest-private'); }\n",
    "function loop() {}\n",
    "function loop() {}\n",
  ]);
  const ran = f.run([], f);
  expect(ran.status, ran.stderr).toBe(0);
  const selection: ArchiveSelection = JSON.parse(ran.stdout);
  const candidate = selection.candidates[0]!;
  expect(candidate.matches).toHaveLength(12);
  expect(candidate.totalPoints).toBe(0);
  for (const [index, match] of candidate.matches.entries())
    expect(match.result.rankings[selection.plan.matches[index]!.candidateSeat]).toBe(4);
  expect(selection.selected.stage).toBe(2);
  expect(selection.reason).toBe("later-stage");
  expect(ran.stderr).not.toContain("guest-private");
});

it(
  "真实沙箱 uncertain-timeout 缺终局整次失败，stdout 无部分胜者且诊断不泄漏输入",
  { timeout: 30000 },
  () => {
    const f = fixture(
      [
        "function loop() { for(var i=0;i<120000;i++){var x=i%7;} }\n",
        "function loop() {}\n",
        "function loop() {}\n",
      ],
      { eventTickLimit: 500000 },
    );
    const clock = join(f.root, "timeout.mjs");
    writeFileSync(
      clock,
      "let calls=0; Object.defineProperty(performance,'now',{value:()=>++calls*2000});\n",
    );
    const ran = f.run([], f, ["--import", clock]);
    expect(ran.status).toBe(2);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toBe("选拔执行或完整证据校验失败\n");
  },
);

it("预定环境或外部候选身份错配在真实对局之前拒绝", () => {
  const f = fixture(["function loop() {}\n", "function loop() {}\n", "function loop() {}\n"]);
  writeFileSync(f.candidates[1]!.sourcePath, "provider-private");
  const ran = f.run([], f);
  expect(ran.status).toBe(2);
  expect(ran.stdout).toBe("");
  expect(ran.stderr).not.toContain("provider-private");
});
