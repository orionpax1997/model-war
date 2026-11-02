/**
 * v2 选拔的执行与校验（CLI 侧）：全量复算、逐场逐字比对、复用只省「跑」不省「查」。
 *
 * 真对局由注入的 `runGrid` 替代（整张 32 场 × 三份候选是真引擎几十秒的量级，属于手工冒烟/
 * 慢速测试），注入的是**执行**而不是判据：比对、计分、定版全在 `@model-war/runner` 的纯函数里，
 * 谁跑出来的读数都要过那几关。夹具写的观测行用的是执行器同一个渲染器（`trialObservationLines`），
 * 所以「生成阶段的行」与「复算的行」是同一种东西。
 *
 * 真安装面（`archive/` 四份陪练档）在本机存在时才跑一次真子进程 e2e（`skipIf`）：它跑的是
 * 同一份计划、真实引擎与真实协议，代价是 32 场复算；`archive/` 不入库，别的机器上跳过。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import {
  TRIAL_GRID_MAP_NAMES,
  TRIAL_GRID_SEED_BASE,
  TRIAL_MATCHES_PER_CANDIDATE,
  TRIAL_SPARRING_LADDER,
  TRIAL_SPARRING_SUBSTITUTE,
  type JsonValue,
  type TrialObservationLine,
  type TrialPlan,
  type TrialPlanMatch,
  type TrialPlanScript,
  type TrialTerminalSummary,
} from "@model-war/schema";
import {
  buildTrialPlan,
  scoreTrialGrid,
  trialGridMatchesOf,
  type BuildTrialPlanInput,
} from "@model-war/runner";

import { gridSummaryPathOf, writeTrialGridSummary } from "../trial/grid.js";
import { trialObservationLines, writeTrialObservations } from "../trial/observations.js";
import {
  executeGridSelection,
  planForGridSelection,
  validatePreparedGridSelection,
  type GridSelectionArtifact,
  type GridRunner,
} from "./grid-selection.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "modelwar-grid-selection-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** 四份陪练的事实（与 `loadSparringPool` 交回的形状一致）。 */
const sparringScripts: readonly TrialPlanScript[] = [
  ...TRIAL_SPARRING_LADDER.map((identity) => ({
    id: `${identity.role}:${identity.id}`,
    role: identity.role,
    source: `archive:${identity.id}/${identity.runId}`,
    scriptSha256: identity.scriptSha256,
  })),
  {
    id: `incumbent:${TRIAL_SPARRING_SUBSTITUTE.id}`,
    role: "incumbent" as const,
    source: `archive:${TRIAL_SPARRING_SUBSTITUTE.id}/${TRIAL_SPARRING_SUBSTITUTE.runId}#substitute`,
    scriptSha256: TRIAL_SPARRING_SUBSTITUTE.scriptSha256,
  },
];

const planOf = (): TrialPlan =>
  buildTrialPlan({
    ruleset: "v2",
    rulesetSha256: "9".repeat(64),
    sandboxRuntimeHash: "8".repeat(64),
    scripts: sparringScripts,
    maps: [
      { name: TRIAL_GRID_MAP_NAMES[0], sha256: "f".repeat(64) },
      { name: TRIAL_GRID_MAP_NAMES[1], sha256: "e".repeat(64) },
    ],
  } satisfies BuildTrialPlanInput);

const plan = planOf();

/** 候选在某场拿第 `rank` 名，其余三方按名次升序补满（与座位无关的写法）。 */
const ranksWith = (match: TrialPlanMatch, rank: number): readonly number[] => {
  const rest = [1, 2, 3, 4].filter((value) => value !== rank);
  let cursor = 0;
  return match.seats.map((_, seat) => (seat === match.candidateSeat ? rank : rest[cursor++]!));
};

/**
 * 一张网格的读数（执行器写观测时吃的那一份形状）。
 *
 * 名次与种子取自计划：这一行说的必须是这一格，否则读取端（以及本票的逐场比对）都会拒。
 */
const readingsOf = (
  target: TrialPlan,
  rank: number,
  delivered = 0,
): readonly TrialObservationLine[] =>
  target.matches.map((match) => {
    const ranks = ranksWith(match, rank);
    return {
      matchIndex: match.matchIndex,
      delivered,
      captures: 0,
      noScoreSource: delivered === 0,
      terminalSummary: {
        version: 1,
        seed: match.seed,
        tick: 400,
        reason: "timeout",
        weights: { baseScore: 4, resourceScore: 1, unitCostDivisor: 6 },
        unitCosts: { worker: 4, melee: 8, ranged: 12, cavalry: 16 },
        rankPoints: [3, 2, 1, 0],
        players: match.seats.map((player, seat) => ({
          seat,
          player,
          controlledBases: 1,
          controlledResources: 1,
          survivingUnits: { worker: 2, melee: 0, ranged: 0, cavalry: 0 },
          survivingUnitCost: 8,
          score: { bases: 4, resources: 1, units: 1 },
          territoryScore: 6,
          rank: ranks[seat]!,
          rankPoints: 1.5,
          alive: true,
          eliminatedAtTick: null,
        })) as unknown as TrialTerminalSummary["players"],
      },
    };
  });

/** 写一份候选的阶段证据：观测文件 + 旁挂的网格汇总（分数与计划都在这两份里）。 */
const writeEvidence = (options: {
  readonly root: string;
  readonly target: TrialPlan;
  readonly stage: number;
  readonly scriptSha256: string;
  readonly readings: readonly TrialObservationLine[];
}): { readonly observationsPath: string; readonly gridSummaryPath: string } => {
  const observationsPath = join(options.root, `observed-stage-${String(options.stage)}.jsonl`);
  const written = writeTrialObservations(observationsPath, trialObservationLines(options.readings));
  if (!written.ok) throw new Error(written.reason);
  const summaryPath = gridSummaryPathOf(observationsPath);
  const summarized = writeTrialGridSummary(summaryPath, {
    version: options.target.version,
    plan: options.target,
    scriptSha256: options.scriptSha256,
    score: scoreTrialGrid(options.target, options.readings),
    matches: trialGridMatchesOf(options.target),
  });
  if (!summarized.ok) throw new Error(summarized.reason);
  return { observationsPath, gridSummaryPath: summaryPath };
};

type Fixture = {
  readonly root: string;
  readonly candidates: readonly GridSelectionArtifact[];
  /** 每个候选各自的复算读数（默认与生成阶段相同）。 */
  readonly recomputed: ReadonlyMap<string, readonly TrialObservationLine[]>;
  readonly runs: string[];
};

/**
 * 三阶段夹具：每阶段一个候选（字节与 TS 源都可指定），证据按生成阶段的口径写盘。
 *
 * `ranks` 决定谁的分高（选拔按生成阶段的分数定版），`identical` 让三份候选共用同一份 JS 字节
 * （于是后两个阶段走复用记账）。
 */
const fixture = (
  options: {
    readonly ranks?: readonly [number, number, number];
    readonly identical?: boolean;
    readonly tamperStage?: number;
  } = {},
): Fixture => {
  const root = mkdtempSync(join(scratch, "root-"));
  const ranks = options.ranks ?? [1, 4, 4];
  const candidates: GridSelectionArtifact[] = [];
  const recomputed = new Map<string, readonly TrialObservationLine[]>();
  for (const stage of [0, 1, 2] as const) {
    const code = `function loop() { return ${options.identical === true ? "0" : String(stage)}; }\n`;
    const source = `type Stage${stage} = number;\n${code}`;
    const scriptPath = join(root, `candidate-${String(stage)}.js`);
    const sourcePath = join(root, `candidate-${String(stage)}.ts`);
    writeFileSync(scriptPath, code);
    writeFileSync(sourcePath, source);
    const scriptSha256 = sha256(code);
    // 同字节候选的网格证据本来就该是同一份（生成管线直接复用那一份），fixture 照同一条路走。
    const readings = readingsOf(plan, (options.identical === true ? ranks[0] : ranks[stage])!);
    const evidence = writeEvidence({
      root,
      target: plan,
      stage,
      scriptSha256,
      readings,
    });
    if (options.tamperStage === stage) {
      // 只改生成阶段那一侧的一行观测：复算跑出来的还是原样，于是逐场比对必须拒。
      const lines = readFileSync(evidence.observationsPath, "utf8").trim().split("\n");
      const parsed = JSON.parse(lines[3]!) as Record<string, JsonValue>;
      parsed["delivered"] = 1;
      lines[3] = JSON.stringify(parsed);
      writeFileSync(evidence.observationsPath, `${lines.join("\n")}\n`);
    }
    candidates.push({
      stage,
      protocolRound: stage + 1,
      scriptSha256,
      sourceSha256: sha256(source),
      scriptPath,
      sourcePath,
      ...evidence,
    });
    if (!recomputed.has(scriptSha256)) recomputed.set(scriptSha256, readings);
  }
  return { root, candidates, recomputed, runs: [] };
};

/** 复算的执行缝：按候选字节交回它那一份读数，并数一次「跑了几份」。 */
const runnerOf =
  (f: Fixture): GridRunner =>
  async ({ scriptPath }) => {
    f.runs.push(scriptPath);
    const code = readFileSync(scriptPath, "utf8");
    const readings = f.recomputed.get(sha256(code));
    if (readings === undefined) throw new Error("夹具缺这份候选的读数");
    return readings;
  };

const execute = (f: Fixture, expectedPlan: unknown = plan) =>
  executeGridSelection({
    root: f.root,
    model: "alpha",
    candidates: f.candidates,
    expectedPlan,
    deps: { plan, runGrid: runnerOf(f) },
  });

it("三份候选各跑一份 32 场网格：排序用生成阶段分数，逐场证据与逐场积分入档", async () => {
  const f = fixture();
  const selection = await execute(f);
  expect(selection.version).toBe(2);
  expect(selection.candidates.map((candidate) => candidate.matches)).toHaveLength(3);
  expect(selection.selected.stage).toBe(0);
  expect(selection.reason).toBe("highest-average-points");
  for (const candidate of selection.candidates) {
    expect(candidate.score.countedMatches).toBe(32);
    expect(candidate.matches).toHaveLength(TRIAL_MATCHES_PER_CANDIDATE);
    expect(candidate.matches.map((match) => match.matchIndex)).toEqual(
      Array.from({ length: TRIAL_MATCHES_PER_CANDIDATE }, (_, index) => index),
    );
    expect(candidate.reusedFromStage).toBeUndefined();
  }
  // 第一名每场 3 分、末名 0 分：分数就是生成阶段那张网格的分数。
  expect(selection.candidates.map((candidate) => candidate.score.averagePoints)).toEqual([3, 0, 0]);
  // 三份字节各不相同 → 三份都真的复算了一次。
  expect(f.runs).toHaveLength(3);
  // 结果再验一遍（`--validate` 走同一条路）。
  expect(
    validatePreparedGridSelection({
      candidates: f.candidates,
      expectedPlan: plan,
      selection: JSON.parse(JSON.stringify(selection)) as unknown,
    }),
  ).toEqual(selection);
});

it("字节相同的候选只复算一次，但每个阶段自己的那份证据都被逐场验证", async () => {
  const f = fixture({ identical: true });
  const selection = await execute(f);
  expect(f.runs).toHaveLength(1);
  expect(selection.candidates.map((candidate) => candidate.reusedFromStage)).toEqual([
    undefined,
    0,
    0,
  ]);
  expect(selection.selected.stage).toBe(2);
  expect(selection.reason).toBe("later-stage");

  // 复用来源的证据被改：本阶段那份观测与来源不再逐场相同 → 拒。
  const tampered = fixture({ identical: true });
  const lines = readFileSync(tampered.candidates[1]!.observationsPath, "utf8").trim().split("\n");
  const parsed = JSON.parse(lines[9]!) as Record<string, JsonValue>;
  parsed["delivered"] = 7;
  lines[9] = JSON.stringify(parsed);
  writeFileSync(tampered.candidates[1]!.observationsPath, `${lines.join("\n")}\n`);
  await expect(execute(tampered)).rejects.toThrow(/第 9 场/);
});

it("复算与生成阶段不一致（某一场换了内容）即整次失败，不改分数也不会挑一份好看的", async () => {
  const f = fixture({ tamperStage: 1 });
  await expect(execute(f)).rejects.toThrow(/第 3 场/);
});

it("分数被伪造（汇总总分与逐场观测不符）即拒", async () => {
  const f = fixture();
  const summaryPath = f.candidates[0]!.gridSummaryPath;
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
    score: { totalPoints: number; averagePoints: number; countedMatches: number };
  };
  writeFileSync(
    summaryPath,
    JSON.stringify({
      ...summary,
      score: { ...summary.score, totalPoints: 48, averagePoints: 1.5 },
    }),
  );
  await expect(execute(f)).rejects.toThrow(/分数|逐场/);
});

it.each([
  ["换种子", 0],
  ["换图", 1],
  ["换陪练摘要", 2],
] as const)("计划不符（%s）即拒，并指到具体位置", async (kind, slot) => {
  const f = fixture();
  const mutated = JSON.parse(JSON.stringify(plan)) as {
    matches: { seed: number }[];
    maps: { sha256: string }[];
    scripts: { scriptSha256: string }[];
  };
  if (slot === 0) mutated.matches[5]!.seed = 999;
  if (slot === 1) mutated.maps[1]!.sha256 = "a".repeat(64);
  if (slot === 2) mutated.scripts[3]!.scriptSha256 = "b".repeat(64);
  await expect(execute(f, mutated)).rejects.toThrow(
    slot === 0
      ? /matches\[5\]\.seed/
      : slot === 1
        ? /maps\[1\]\.sha256/
        : /scripts\[3\]\.scriptSha256/,
  );
});

it("候选产物字节被换、观测文件读不到、汇总说的不是这张网格都拒", async () => {
  const bytes = fixture();
  writeFileSync(bytes.candidates[1]!.sourcePath, "tampered");
  await expect(execute(bytes)).rejects.toThrow();

  const missing = fixture();
  rmSync(missing.candidates[2]!.observationsPath);
  await expect(execute(missing)).rejects.toThrow(/观测文件读不到/);

  const wrongPlan = fixture();
  const summaryPath = wrongPlan.candidates[0]!.gridSummaryPath;
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as { plan: { maps: unknown[] } };
  writeFileSync(summaryPath, JSON.stringify({ ...summary, plan: { ...summary.plan, maps: [] } }));
  await expect(execute(wrongPlan)).rejects.toThrow(/不同源/);
});

it("--validate 只校不跑：记录被改（逐场摘要 / 分数 / 胜者）都拒", async () => {
  const f = fixture();
  const selection = await execute(f);
  const validate = (value: unknown) =>
    validatePreparedGridSelection({
      candidates: f.candidates,
      expectedPlan: plan,
      selection: value,
    });

  const mutable = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(selection)) as Record<string, unknown>;
  const tampered = mutable();
  const candidates = tampered["candidates"] as {
    matches: { observationSha256: string }[];
    score: { totalPoints: number };
  }[];
  candidates[0]!.matches[4]!.observationSha256 = "a".repeat(64);
  expect(() => validate(tampered)).toThrow(/第 4 场/);

  const forged = mutable();
  (forged["candidates"] as { score: { averagePoints: number } }[])[0]!.score.averagePoints = 2;
  expect(() => validate(forged)).toThrow(/分数|均分/);

  const wrongWinner = mutable();
  (wrongWinner["selected"] as { stage: number }).stage = 2;
  expect(() => validate(wrongWinner)).toThrow(/胜者/);

  // 预期计划与记录不同源（生成阶段换了图）→ 拒。
  const otherPlan = JSON.parse(JSON.stringify(plan)) as { maps: { sha256: string }[] };
  otherPlan.maps[0]!.sha256 = "b".repeat(64);
  expect(() =>
    validatePreparedGridSelection({ candidates: f.candidates, expectedPlan: otherPlan, selection }),
  ).toThrow(/不同源/);
});

/** 真安装面（`archive/`）在不在：不在就跳过真子进程用例（`archive/` 不入库）。 */
const archivePresent = TRIAL_SPARRING_LADDER.every((identity) =>
  existsSync(join(repoRoot, "archive", identity.id, identity.runId, "script.js")),
);

const MODEL = "gpt-6.1-sol";

/** 真的子进程协议（`--validate` 不重跑、不读安装面，所以夹具根就够）。 */
const runSelectionEntry = (input: unknown, args: readonly string[] = [], root = repoRoot) =>
  spawnSync(
    process.execPath,
    [join(repoRoot, "apps/cli/dist/selection/run-selection.js"), "--root", root, ...args],
    { encoding: "utf8", input: JSON.stringify(input), timeout: 120_000 },
  );

it(
  "真实子进程 --validate：记录与盘上证据对上才通过，改一行观测即退出 2",
  { timeout: 30_000 },
  async () => {
    const f = fixture();
    const selection = await execute(f);
    const payload = { candidates: f.candidates, expectedPlan: plan, selection };
    const valid = runSelectionEntry(payload, ["--validate"], f.root);
    expect(valid.status, valid.stderr).toBe(0);
    expect(JSON.parse(valid.stdout)).toEqual(selection);

    const lines = readFileSync(f.candidates[2]!.observationsPath, "utf8").trim().split("\n");
    const parsed = JSON.parse(lines[11]!) as Record<string, JsonValue>;
    parsed["captures"] = 4;
    lines[11] = JSON.stringify(parsed);
    writeFileSync(f.candidates[2]!.observationsPath, `${lines.join("\n")}\n`);
    const rejected = runSelectionEntry(payload, ["--validate"], f.root);
    expect(rejected.status).toBe(2);
    expect(rejected.stdout).toBe("");
    expect(rejected.stderr).toBe("选拔执行或完整证据校验失败\n");
  },
);

it.skipIf(!archivePresent)(
  "--plan 打印的是生成阶段那张网格（32 场、四份角色限定陪练、两张图、逐格种子）",
  { timeout: 60_000 },
  () => {
    const printed = spawnSync(
      process.execPath,
      [
        join(repoRoot, "apps/cli/dist/selection/run-selection.js"),
        "--root",
        repoRoot,
        "--plan",
        "--model",
        MODEL,
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(printed.status, printed.stderr).toBe(0);
    const printedPlan = JSON.parse(printed.stdout) as TrialPlan;
    expect(printedPlan.matches).toHaveLength(TRIAL_MATCHES_PER_CANDIDATE);
    expect(printedPlan.matches.map((match) => match.seed)).toEqual(
      Array.from(
        { length: TRIAL_MATCHES_PER_CANDIDATE },
        (_, index) => TRIAL_GRID_SEED_BASE + index,
      ),
    );
    expect(printedPlan.maps.map((map) => map.name)).toEqual([...TRIAL_GRID_MAP_NAMES]);
    expect(printedPlan.scripts.map((script) => script.role)).toEqual([
      "top",
      "mid",
      "last",
      "incumbent",
    ]);
    expect(printedPlan.scripts.every((script) => script.id.startsWith(`${script.role}:`))).toBe(
      true,
    );
    // 同一安装面两次构造的计划逐字相同（计划由事实派生，没有随机成分）。
    expect(planForGridSelection(repoRoot, MODEL)).toEqual(printedPlan);
  },
);

it("安装面缺四份陪练档时 --plan --model 退出 2（不猜计划、不静默降级）", () => {
  const root = mkdtempSync(join(scratch, "empty-"));
  mkdirSync(join(root, "rulesets"), { recursive: true });
  copyFileSync(join(repoRoot, "rulesets", "v2.json"), join(root, "rulesets", "v2.json"));
  const printed = spawnSync(
    process.execPath,
    [
      join(repoRoot, "apps/cli/dist/selection/run-selection.js"),
      "--root",
      root,
      "--plan",
      "--model",
      MODEL,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  expect(printed.status).toBe(2);
  expect(printed.stdout).toBe("");
  expect(printed.stderr).toBe("选拔执行或完整证据校验失败\n");
});
