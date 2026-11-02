/**
 * 归档报告的两版口径：v2（评测网格）与 v1（历史档）。
 *
 * 三条要读得出来的事实，JSON 投影与 markdown 渲染两路都断言：
 * 1. **三类分数不互相替代**：生成阶段（网格平均名次积分，分母 32）／选拔复算（只作校验读数）／
 *    赛季（属赛季报告口径，恒写「不适用」）。
 * 2. **陪练身份与计划指针**：四份陪练（id / role / source / scriptSha256）、计划版本与
 *    `planSha256`、每组合轮空谁 / 坐哪 / 哪张图——计划正文留在档里，报告只给指针，不搬 32 场明文。
 * 3. **同字节复用直读**：每候选一行给 `stage` / `scriptSha256` / `reusedFromStage`。
 *
 * v1 历史档不改写、不迁移：三场单图、无计划、无分数，12 场选拔、种子 401–403、三份基准、
 * `earlier-stage` 决胜——照原形状出报告，且 v2 的判据不许误拒它。
 *
 * 反例（v2 缺 `score` / `sparring` / `plan`）必须**明确拒绝**：报告不伪造摘要，也不补零。
 */

import { createHash } from "node:crypto";
import {
  cpSync,
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
  ACTION_API_NAMES,
  ACTION_EFFECT_NAMES,
  ACTION_ERROR_CODES,
  TRIAL_CANDIDATE_SEAT,
  TRIAL_GRID_MAP_NAMES,
  TRIAL_MATCHES_PER_CANDIDATE,
  TRIAL_PLAYER_IDS,
  TRIAL_SEEDS,
  type ArchiveMeta,
  type ReplayResultLine,
  type SelectionPlan,
  type TrialActionFacts,
  type TrialPlan,
  type TrialTerminalPlayer,
  type TrialTerminalSummary,
} from "@model-war/schema";

import { readArchiveReports, runArchiveReport } from "./archive-report.js";
import { DEFAULT_RANK_POINTS, perMatchScores } from "./ranker.js";
import { buildArchiveSelection, buildSelectionPlan, selectionInputSha256 } from "./selection.js";
import { buildArchiveGridSelection } from "./selection-grid.js";
import { trialGridPlanFixture } from "./trial-grid.fixture.js";
import { trialMatchInputSha256 } from "./trial-plan.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "modelwar-report-v2-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const rootOf = (): string => mkdtempSync(join(scratch, "root-"));
const shaOf = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");

/** 零计数的行动事实（形状完整；计数全零不影响名次或计分）。 */
const actionFactsOf = (options: {
  readonly seed: number;
  readonly seat: number;
  readonly scriptSha256: string;
}): TrialActionFacts => ({
  version: 1,
  scriptSha256: options.scriptSha256,
  seed: options.seed,
  seat: options.seat as TrialActionFacts["seat"],
  complete: true,
  observedTicks: 1,
  missingTicks: 0,
  calls: Object.fromEntries(ACTION_API_NAMES.map((name) => [name, 0])) as TrialActionFacts["calls"],
  errors: Object.fromEntries(
    ACTION_API_NAMES.map((name) => [
      name,
      Object.fromEntries(ACTION_ERROR_CODES.map((code) => [code, 0])),
    ]),
  ) as TrialActionFacts["errors"],
  effects: Object.fromEntries(
    ACTION_EFFECT_NAMES.map((name) => [name, 0]),
  ) as TrialActionFacts["effects"],
});

/**
 * 一场对局的终局事实（四方自洽）：候选名次由 `candidateRank` 给，其余按名次升序补满。
 *
 * 领域分随名次递减且与其组成项自洽（`bases × baseScore`），于是报告侧的名次/计分复核能过——
 * 夹具不造一个「复核过不去」的终局来假装观测可用。
 */
const terminalOf = (options: {
  readonly seed: number;
  readonly seats: readonly [string, string, string, string];
  readonly candidateSeat: number;
  readonly candidateRank: number;
}): TrialTerminalSummary => {
  const rest = [1, 2, 3, 4].filter((rank) => rank !== options.candidateRank);
  const ranks = options.seats.map((_, seat) =>
    seat === options.candidateSeat
      ? options.candidateRank
      : (rest.shift() ?? options.candidateRank),
  );
  const points = perMatchScores(
    `trial-${String(options.seed)}`,
    options.seats.map((player, seat) => ({ player, rank: ranks[seat]! })),
    DEFAULT_RANK_POINTS,
  );
  const playerOf = (seat: 0 | 1 | 2 | 3): TrialTerminalPlayer => {
    const controlledBases = 6 - ranks[seat]!;
    return {
      seat,
      player: options.seats[seat]!,
      controlledBases,
      controlledResources: 0,
      survivingUnits: { worker: 0, melee: 0, ranged: 0, cavalry: 0 },
      survivingUnitCost: 0,
      score: { bases: controlledBases * 4, resources: 0, units: 0 },
      territoryScore: controlledBases * 4,
      rank: ranks[seat]!,
      rankPoints: points[seat]!,
      alive: true,
      eliminatedAtTick: null,
    };
  };
  return {
    version: 1,
    seed: options.seed,
    tick: 400,
    reason: "timeout",
    weights: { baseScore: 4, resourceScore: 1, unitCostDivisor: 6 },
    unitCosts: { worker: 4, melee: 8, ranged: 12, cavalry: 16 },
    rankPoints: [...DEFAULT_RANK_POINTS],
    players: [playerOf(0), playerOf(1), playerOf(2), playerOf(3)],
  };
};

const observationLineOf = (options: {
  readonly matchIndex: number;
  readonly seed: number;
  readonly seats: readonly [string, string, string, string];
  readonly candidateSeat: number;
  readonly candidateRank: number;
  readonly scriptSha256: string;
}): string =>
  JSON.stringify({
    matchIndex: options.matchIndex,
    delivered: 3,
    captures: 1,
    noScoreSource: false,
    terminalSummary: terminalOf(options),
    actionFacts: actionFactsOf({
      seed: options.seed,
      seat: options.candidateSeat,
      scriptSha256: options.scriptSha256,
    }),
  });

const readMarkdown = async (root: string): Promise<string> => {
  const out: string[] = [];
  const code = await runArchiveReport(["--root", root], {
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
  });
  expect(code).toBe(0);
  return out.join("");
};

const readJson = async (root: string): Promise<string> => {
  const out: string[] = [];
  const code = await runArchiveReport(["--root", root, "--json"], {
    stdout: (text) => out.push(text),
    stderr: (text) => out.push(text),
  });
  expect(code).toBe(0);
  return out.join("");
};

/** 一份候选在网格夹具里的身份（三阶段共用写法）。 */
type GridCandidateFixture = {
  readonly stage: 0 | 1 | 2;
  readonly product: string;
  readonly source: string;
  readonly score: number;
  readonly reusedFromStage?: 0 | 1 | 2;
};

/**
 * v2 存档夹具：stage0 / stage1 编译产物字节相同（stage1 复用 stage0），stage2 换脚本。
 *
 * 分数：stage0/stage1 全胜（3 分/场 × 32），stage2 全败（0 分）。字符串排在 stage1 之后，
 * 所以决胜选 stage1（同分较晚阶段），报告里正好读出「胜者复用 stage0」。
 */
const gridCandidatesOf = (): readonly GridCandidateFixture[] => [
  { stage: 0, product: "function loop() {}", source: "// initial\nfunction loop() {}", score: 3 },
  {
    stage: 1,
    product: "function loop() {}",
    source: "// intermediate\nfunction loop() { return []; }",
    score: 3,
    reusedFromStage: 0,
  },
  {
    stage: 2,
    product: "function loop() { return [1]; }",
    source: "// final\nfunction loop() { return [1]; }",
    score: 0,
  },
];

const writeGridArchive = (
  root: string,
  model: string,
  plan: TrialPlan,
  candidates: readonly GridCandidateFixture[],
  meta: ArchiveMeta,
): void => {
  const runId = "r1";
  const directory = join(root, "archive", model);
  mkdirSync(join(directory, runId), { recursive: true });
  for (const candidate of candidates) {
    const protocolRound = candidate.stage + 1;
    const observationsFile = `observed-${runId}-round-${String(protocolRound)}.jsonl`;
    writeFileSync(join(directory, `${observationsFile}.candidate.js`), candidate.product);
    writeFileSync(join(directory, `${observationsFile}.candidate.ts`), candidate.source);
    // 32 场逐场一行：种子/座位/四座身份都由计划给（网格口径）。
    writeFileSync(
      join(directory, observationsFile),
      plan.matches
        .map((match) =>
          observationLineOf({
            matchIndex: match.matchIndex,
            seed: match.seed,
            seats: match.seats,
            candidateSeat: match.candidateSeat,
            candidateRank: candidate.score === 3 ? 1 : 4,
            scriptSha256: shaOf(candidate.product),
          }),
        )
        .join("\n"),
    );
  }
  writeFileSync(join(directory, runId, "meta.json"), JSON.stringify(meta));
};

/** v2 存档 meta（含 v2 选拔：与生成阶段同一张计划、分数逐位相同）。 */
const gridMetaOf = (
  plan: TrialPlan,
  candidates: readonly GridCandidateFixture[],
  options: { readonly omit?: "score" | "sparring" | "plan" } = {},
): ArchiveMeta => {
  const selection = buildArchiveGridSelection(
    plan,
    candidates.map((candidate) => ({
      stage: candidate.stage,
      protocolRound: candidate.stage + 1,
      scriptSha256: shaOf(candidate.product),
      sourceSha256: shaOf(candidate.source),
      score: {
        totalPoints: candidate.score * TRIAL_MATCHES_PER_CANDIDATE,
        averagePoints: candidate.score,
        countedMatches: TRIAL_MATCHES_PER_CANDIDATE,
      },
      matches: plan.matches.map((match) => ({
        matchIndex: match.matchIndex,
        inputSha256: trialMatchInputSha256(plan, shaOf(candidate.product), match),
        observationSha256: "e".repeat(64),
        candidatePoints: candidate.score,
      })),
      ...(candidate.reusedFromStage === undefined
        ? {}
        : { reusedFromStage: candidate.reusedFromStage }),
    })),
  );
  const meta: ArchiveMeta = {
    model: "alpha",
    modelVersion: "snapshot-1",
    generatedAt: "2026-12-01T00:00:00Z",
    protocolRounds: 3,
    prompts: ["初始", "第一轮事实回喂", "第二轮事实回喂"],
    generationLog: ["{}"],
    ruleset: plan.ruleset,
    validation: { passed: true, errors: [] },
    tscVersion: "7.0.2",
    scriptSha256: shaOf(candidates[selection.selected.stage]!.product),
    sandboxRuntimeHash: plan.sandboxRuntimeHash,
    optimization: {
      version: 2,
      feedbackRounds: 2,
      plan,
      sparring: plan.scripts.map(({ id, role, source, scriptSha256 }) => ({
        id,
        role,
        source,
        scriptSha256,
      })),
      candidates: candidates.map((candidate) => ({
        stage: candidate.stage,
        protocolRound: candidate.stage + 1,
        scriptFile: `observed-r1-round-${String(candidate.stage + 1)}.jsonl.candidate.js`,
        observationsFile: `observed-r1-round-${String(candidate.stage + 1)}.jsonl`,
        scriptSha256: shaOf(candidate.product),
        score: {
          totalPoints: candidate.score * TRIAL_MATCHES_PER_CANDIDATE,
          averagePoints: candidate.score,
          countedMatches: TRIAL_MATCHES_PER_CANDIDATE,
        },
        matchCount: TRIAL_MATCHES_PER_CANDIDATE,
        ...(candidate.reusedFromStage === undefined
          ? {}
          : { reusedFromStage: candidate.reusedFromStage }),
      })),
    },
    selection,
  };
  if (options.omit === undefined) return meta;
  // 反例：把该写的键拿掉（不重算任何摘要），读入端必须拒绝而不是补零。
  const forged = JSON.parse(JSON.stringify(meta)) as ArchiveMeta;
  const optimization = forged.optimization as unknown as Record<string, unknown>;
  if (options.omit === "plan") Reflect.deleteProperty(optimization, "plan");
  if (options.omit === "sparring") Reflect.deleteProperty(optimization, "sparring");
  if (options.omit === "score") {
    Reflect.deleteProperty((optimization.candidates as Record<string, unknown>[])[1]!, "score");
  }
  return forged;
};

/** v2 网格档在盘上：返回 root 与计划（三个候选都由同一张计划跑出来）。 */
const writeGridRoot = (
  options: { readonly omit?: "score" | "sparring" | "plan" } = {},
): { readonly root: string; readonly plan: TrialPlan } => {
  const root = rootOf();
  const plan = trialGridPlanFixture();
  const candidates = gridCandidatesOf();
  // 冻结目录里的 script.ts / script.js 认胜者那一阶段（与存档 meta.scriptSha256 一致）。
  const winner = 1;
  writeGridArchive(root, "alpha", plan, candidates, gridMetaOf(plan, candidates, options));
  writeFileSync(join(root, "archive/alpha/r1/script.ts"), candidates[winner]!.source);
  writeFileSync(join(root, "archive/alpha/r1/script.js"), candidates[winner]!.product);
  return { root, plan };
};

/** v1 历史档：三场单图试跑 + 12 场选拔（三份基准、种子 401–403、earlier-stage）。 */
const writeLegacyRoot = (): { readonly root: string; readonly selectionPlan: SelectionPlan } => {
  const root = rootOf();
  const product = "function loop() {}";
  const sources = [
    "// a\nfunction loop() {}",
    "// b\nfunction loop() {}",
    "// c\nfunction loop() {}",
  ];
  const selectionPlan = buildSelectionPlan({
    ruleset: "v2",
    rulesetSha256: "9".repeat(64),
    sandboxRuntimeHash: "8".repeat(64),
    map: "arena",
    mapSha256: "a".repeat(64),
    baselines: [
      { id: "cell-a-melee-pressure", scriptSha256: shaOf("a") },
      { id: "cell-b-expansion-economy", scriptSha256: shaOf("b") },
      { id: "cell-c-claim-no-harvest", scriptSha256: shaOf("c") },
    ],
  });
  // 三个阶段的终局名次完全相同 → 12 场同分 → 历史决胜 `earlier-stage`。
  const result: ReplayResultLine = {
    type: "result",
    rankings: [1, 2, 3, 4],
    reason: "timeout",
    territoryScores: [0, 0, 0, 0],
  };
  const built = buildArchiveSelection(
    selectionPlan,
    ([0, 1, 2] as const).map((stage) => ({
      stage,
      protocolRound: stage + 1,
      scriptSha256: shaOf(product),
      sourceSha256: shaOf(sources[stage]!),
      matches: selectionPlan.matches.map((match) => ({
        matchIndex: match.matchIndex,
        inputSha256: selectionInputSha256(selectionPlan, shaOf(product), match),
        result,
      })),
    })),
  );
  // 历史决胜 `earlier-stage`：三阶段同分时取更早阶段（新生产结果不得再用，读旧档要认）。
  const selection = {
    ...built,
    selected: {
      stage: 0 as const,
      protocolRound: 1,
      scriptSha256: shaOf(product),
      sourceSha256: shaOf(sources[0]!),
    },
    reason: "earlier-stage" as const,
  };
  const meta: ArchiveMeta = {
    model: "legacy",
    modelVersion: "snapshot-0",
    generatedAt: "2026-10-13T00:00:00Z",
    protocolRounds: 3,
    prompts: ["初始", "第一轮事实回喂", "第二轮事实回喂"],
    generationLog: ["{}"],
    ruleset: "v2",
    validation: { passed: true, errors: [] },
    tscVersion: "7.0.2",
    scriptSha256: shaOf(product),
    sandboxRuntimeHash: "8".repeat(64),
    optimization: {
      version: 1,
      feedbackRounds: 2,
      trialSeeds: [101, 202, 303],
      candidates: ([0, 1, 2] as const).map((stage) => ({
        stage,
        protocolRound: stage + 1,
        scriptFile: `observed-r1-round-${String(stage + 1)}.jsonl.candidate.js`,
        observationsFile: `observed-r1-round-${String(stage + 1)}.jsonl`,
        scriptSha256: shaOf(product),
      })),
    },
    selection,
  };
  const directory = join(root, "archive", "legacy");
  mkdirSync(join(directory, "r1"), { recursive: true });
  writeFileSync(join(directory, "r1", "meta.json"), JSON.stringify(meta));
  writeFileSync(join(directory, "r1", "script.js"), product);
  writeFileSync(join(directory, "r1", "script.ts"), sources[0]!);
  for (const stage of [0, 1, 2] as const) {
    const observationsFile = `observed-r1-round-${String(stage + 1)}.jsonl`;
    writeFileSync(join(directory, `${observationsFile}.candidate.js`), product);
    writeFileSync(join(directory, `${observationsFile}.candidate.ts`), sources[stage]!);
    // v1 口径：三场单图、候选恒 0 号位、种子 101/202/303、三份基准。
    writeFileSync(
      join(directory, observationsFile),
      TRIAL_SEEDS.map((seed, matchIndex) =>
        observationLineOf({
          matchIndex,
          seed,
          seats: TRIAL_PLAYER_IDS,
          candidateSeat: TRIAL_CANDIDATE_SEAT,
          candidateRank: 1,
          scriptSha256: shaOf(product),
        }),
      ).join("\n"),
    );
  }
  return { root, selectionPlan };
};

it("v2 网格档：三类分数分列、陪练身份与计划指针、复用来源都可直读", async () => {
  const { root, plan } = writeGridRoot();
  const [report] = readArchiveReports(root);
  // 生成阶段：分母就是计划场数，逐字来自 `optimization.candidates[].score`。
  expect(report?.scores).toMatchObject([
    {
      stage: 0,
      scriptSha256: shaOf(gridCandidatesOf()[0]!.product),
      reusedFromStage: null,
      generation: { state: "recorded", averagePoints: 3, countedMatches: 32 },
      selection: { state: "recorded", averagePoints: 3, countedMatches: 32 },
      season: { state: "not-applicable", averagePoints: null },
      agreement: "identical",
    },
    {
      stage: 1,
      reusedFromStage: 0,
      generation: { state: "recorded", averagePoints: 3 },
      agreement: "identical",
    },
    {
      stage: 2,
      reusedFromStage: null,
      generation: { state: "recorded", averagePoints: 0, totalPoints: 0 },
      agreement: "identical",
    },
  ]);
  // 陪练身份四份、计划版本与摘要、组合轮空谁都在报告里（计划正文留在档里）。
  expect(report?.plan).toMatchObject({
    kind: "grid",
    version: plan.version,
    planSha256: plan.planSha256,
    source: "archive/alpha/r1/meta.json#optimization.plan",
    matchesPerCandidate: TRIAL_MATCHES_PER_CANDIDATE,
    maps: [{ name: TRIAL_GRID_MAP_NAMES[0] }, { name: TRIAL_GRID_MAP_NAMES[1] }],
    scripts: plan.scripts.map(({ id, role, source, scriptSha256 }) => ({
      id,
      role,
      source,
      scriptSha256,
    })),
  });
  expect(report?.plan?.combos).toHaveLength(4);
  for (const combo of report!.plan!.combos) {
    expect(combo.matchCount).toBe(8);
    expect(combo.candidateSeats).toEqual([0, 1, 2, 3]);
    expect(combo.maps).toHaveLength(TRIAL_GRID_MAP_NAMES.length);
    // 每个组合恰好轮空一份陪练，且是计划里那份身份的 id。
    expect(plan.scripts.map((script) => script.id)).toContain(combo.sitOut);
  }
  // 选拔复算与生成阶段是同一张计划：planSha256 相同，但正文指针指向选拔自己那一栏。
  expect(report?.selection).toMatchObject({
    version: 2,
    planSha256: plan.planSha256,
    stage: 1,
    reason: "later-stage",
    reusedFromStage: 0,
    countedMatches: TRIAL_MATCHES_PER_CANDIDATE,
    plan: {
      kind: "grid",
      planSha256: plan.planSha256,
      source: "archive/alpha/r1/meta.json#selection.plan",
    },
  });

  const markdown = await readMarkdown(root);
  expect(markdown).toContain("### 计划、陪练与三类分数");
  expect(markdown).toContain(
    `| 阶段 | 协议轮 | JS hash | TS hash | 复用来源 | 生成阶段分数 | 选拔复算（校验读数） | 赛季分数 |`,
  );
  for (const script of plan.scripts)
    expect(markdown).toContain(
      `${script.id}（role=${script.role}；source=${script.source}；scriptSha256=${script.scriptSha256}）`,
    );
  expect(markdown).toContain(`planSha256=${plan.planSha256}`);
  expect(markdown).toContain(`均分 3（总分 96 / 分母 32）（与生成阶段逐位相同）`);
  expect(markdown).toContain(`| 1 | 2 | ${shaOf(gridCandidatesOf()[1]!.product)} |`);
  expect(markdown).toContain("| stage0 |");
  expect(markdown).toContain("不适用");
  // 32 场明文不进 markdown：计划正文留档，报告只写「场次首号 + 场数」。
  expect(markdown).not.toContain(`matchIndex`);
  expect(markdown).toContain("场次 0–7");
  // JSON 里也不搬 32 场明文：组合摘要有，逐场座位表没有。
  expect(markdown).not.toContain(`"seats"`);
  expect(await readJson(root)).not.toContain(`"seats"`);
});

it.each(["score", "sparring", "plan"] as const)(
  "v2 网格档缺 %s 即被明确拒绝，不出报告也不补零",
  (omit) => {
    const { root } = writeGridRoot({ omit });
    const issues: { readonly source: string; readonly reason: string }[] = [];
    const reports = readArchiveReports(root, { onReadIssue: (issue) => issues.push(issue) });
    expect(reports).toHaveLength(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.source).toBe("archive/alpha/r1/meta.json");
    expect(issues[0]?.reason).toContain("优化/选拔元数据");
    // 不给 onReadIssue 时直接抛：静默跳过等于伪造「这份档不存在」。
    expect(() => readArchiveReports(root)).toThrow(/无法生成摘要/);
  },
);

it("v1 历史档：三场单图与 12 场选拔照原形状出报告，不迁移、不回填", async () => {
  const { root, selectionPlan } = writeLegacyRoot();
  const [report] = readArchiveReports(root);
  expect(report?.selection).toMatchObject({
    version: 1,
    stage: 0,
    reason: "earlier-stage",
    countedMatches: 12,
    plan: {
      kind: "legacy-selection",
      version: 1,
      planSha256: selectionPlan.planSha256,
      source: "archive/legacy/r1/meta.json#selection.plan",
      matchesPerCandidate: 12,
      seeds: [401, 402, 403],
      map: { name: "arena", sha256: "a".repeat(64) },
      baselines: [
        { id: "cell-a-melee-pressure" },
        { id: "cell-b-expansion-economy" },
        { id: "cell-c-claim-no-harvest" },
      ],
    },
  });
  // v1 没有网格：生成阶段与赛季都写「不适用」，选拔读数是它自有的 12 场口径。
  expect(report?.plan).toBeNull();
  expect(report?.scores).toHaveLength(3);
  for (const score of report!.scores) {
    expect(score.generation).toEqual({
      state: "not-applicable",
      totalPoints: null,
      averagePoints: null,
      countedMatches: null,
    });
    expect(score.selection).toMatchObject({ state: "recorded", countedMatches: 12 });
    expect(score.season).toMatchObject({ state: "not-applicable" });
    expect(score.agreement).toBe("unavailable");
  }

  const markdown = await readMarkdown(root);
  expect(markdown).toContain("生成阶段计划：不适用（版本 1 历史档没有计划字段，不迁移、不回填）");
  expect(markdown).toContain("| 阶段 | 协议轮 | JS hash | TS hash | 复用来源 | 生成阶段分数");
  expect(markdown).toContain("均分 1.5（总分 18 / 分母 12）");
  expect(markdown).toContain("选拔计划：v1");
  expect(markdown).toContain("独立 seeds=401–403（3 个种子）");
  expect(markdown).toContain("基准（3 份）：cell-a-melee-pressure=");
  expect(markdown).toContain("理由=earlier-stage");
  expect(markdown).toContain("固定分母=12");
  // v2 的单值栏位不再出现：v1 自己就是一图一栏，不必借道。
  expect(markdown).not.toContain("baselineScriptSha256");
});

it("同一 root 下 v1 与 v2 存档同时出报告（两版分流，互不误拒）", async () => {
  const { root: gridRoot } = writeGridRoot();
  const { root: legacyRoot } = writeLegacyRoot();
  const combined = rootOf();
  mkdirSync(join(combined, "archive"), { recursive: true });
  cpSync(join(gridRoot, "archive"), join(combined, "archive"), { recursive: true });
  cpSync(join(legacyRoot, "archive"), join(combined, "archive"), { recursive: true });
  const reports = readArchiveReports(combined);
  expect(reports.map((report) => [report.model, report.plan?.kind ?? null])).toEqual([
    ["alpha", "grid"],
    ["legacy", null],
  ]);
  const markdown = await readMarkdown(combined);
  expect(markdown).toContain("### 计划、陪练与三类分数");
  expect(markdown).toContain("选拔计划：v1");
});

const realV1 = join(repoRoot, "archive", "claude-opus-5-5", "2026-10-16T08-40-12-578Z");
it.skipIf(!existsSync(join(realV1, "meta.json")))(
  "真实 v1 档（本地有才跑）：照原形状出报告，存档字节不变",
  { timeout: 30_000 },
  () => {
    const metaPath = join(realV1, "meta.json");
    const before = readFileSync(metaPath);
    const reports = readArchiveReports(repoRoot, { model: "claude-opus-5-5" });
    const report = reports.find((entry) => entry.runId === "2026-10-16T08-40-12-578Z");
    expect(report?.plan).toBeNull();
    expect(report?.selection?.version).toBe(1);
    expect(report?.selection?.plan.kind).toBe("legacy-selection");
    expect(report?.scores.map((score) => score.generation.state)).toEqual([
      "not-applicable",
      "not-applicable",
      "not-applicable",
    ]);
    expect(report?.scores.map((score) => score.season.state)).toEqual([
      "not-applicable",
      "not-applicable",
      "not-applicable",
    ]);
    expect(report?.scores.map((score) => score.selection.countedMatches)).toEqual([12, 12, 12]);
    expect(readFileSync(metaPath)).toEqual(before);
  },
);
