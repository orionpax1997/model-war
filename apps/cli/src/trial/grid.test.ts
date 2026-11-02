/**
 * 评测网格的执行器（真引擎，**缩小网格**）：1 组合 × 2 座位 × 1 图 = 2 场。
 *
 * ── 为什么这里只跑 2 场 ──
 *
 * 整张网格是 32 场（3 份候选 × 32 = 96 场，实测约 90 秒/32 场），那是门禁/慢速测试的量级。
 * 单元测试要钉的是**执行器形状**：按计划逐格建四个真 VM、每格一行观测、种子/座位/摘要取自
 * 计划、作废重跑、不早停、汇总与计划逐字一致。2 场足够覆盖这些，且耗时可忽略。
 *
 * ── 为什么手写计划而不是 `buildTrialPlan` ──
 *
 * `buildTrialPlan` 只会造 32 场的整张网格（那是生产语义）。缩小网格是测试用的夹具，所以这里
 * 直接给一份 2 场的计划；执行器不重建计划（重建归入口的 `--expected-plan`）。
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it } from "vitest";
import {
  QUICKJS_WASI_WASM_PATH,
  RULESET_VERSION,
  SANDBOX_RUNTIME_ARTIFACT_PATH,
  TRIAL_CANDIDATE_ID,
  TRIAL_GRID_MAP_NAMES,
  TRIAL_GRID_SEED_BASE,
  TRIAL_PLAN_VERSION,
  type JsonValue,
  type MapDefinition,
  type Ruleset,
  type TrialPlan,
  type TrialPlanMatch,
  type TrialPlanScript,
} from "@model-war/schema";
import { rotateSeats } from "@model-war/runner";

import { validateTrialObservation } from "../validator.js";
import {
  gridSummaryPathOf,
  runTrialGrid,
  summaryOfGrid,
  trialScriptSha256,
  writeTrialGridSummary,
} from "./grid.js";
import type { LoadedTrial, LoadedTrialMap, LoadedTrialOpponent } from "./load.js";
import { trialObservationLines, writeTrialObservations } from "./observations.js";
import { verdictOfTrips } from "./trial.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "modelwar-trial-grid-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/** 四份夹具陪练：id 是角色限定写法，脚本取自仓库里的真基准（真策略，不是空壳）。 */
const fixtureOpponents = (): readonly LoadedTrialOpponent[] => {
  const roles = ["top", "mid", "last", "incumbent"] as const;
  const benchmarks = [
    "cell-a-melee-pressure",
    "cell-b-expansion-economy",
    "cell-c-claim-no-harvest",
    "cell-a-melee-pressure",
  ] as const;
  return roles.map((role, index) => {
    const name = benchmarks[index]!;
    const bytes = readFileSync(join(repoRoot, "benchmarks", name, "script.js"));
    return {
      script: {
        id: `${role}:fixture-${name}`,
        role,
        source: `archive:fixture-${name}/r${String(index)}${role === "incumbent" ? "#substitute" : ""}`,
        scriptSha256: sha256(bytes),
      },
      code: bytes.toString("utf8"),
    };
  });
};

/** 缩小网格的装载面：单图 corridor-split + 四份陪练 + 真 runtime/wasm。 */
const fixtureLoaded = (options: {
  readonly candidateCode: string;
  readonly ruleset?: Partial<Ruleset>;
}): LoadedTrial => {
  const rulesetPath = join(repoRoot, "rulesets", `${RULESET_VERSION}.json`);
  const ruleset: Ruleset = { ...readJson<Ruleset>(rulesetPath), ...options.ruleset };
  const mapPath = join(repoRoot, "maps", `${TRIAL_GRID_MAP_NAMES[0]}.json`);
  const mapBytes = readFileSync(mapPath);
  const map: LoadedTrialMap = {
    name: TRIAL_GRID_MAP_NAMES[0],
    definition: readJson<MapDefinition>(mapPath),
    sha256: sha256(mapBytes),
  };
  const runtimeCode = readFileSync(join(repoRoot, SANDBOX_RUNTIME_ARTIFACT_PATH), "utf8");
  return {
    ruleset,
    rulesetSha256: sha256(readFileSync(rulesetPath)),
    sandboxRuntimeHash: sha256(runtimeCode),
    maps: [map],
    opponents: fixtureOpponents(),
    runtimeCode,
    wasmBytes: readFileSync(join(repoRoot, QUICKJS_WASI_WASM_PATH)),
    candidateCode: options.candidateCode,
  };
};

/** 缩小网格（1 组合 × 2 座位 × 1 图）：组合 0 轮空第四份陪练，候选坐 0 与 3 号位。 */
const reducedPlan = (loaded: LoadedTrial): TrialPlan => {
  const scripts: readonly TrialPlanScript[] = loaded.opponents.map((entry) => entry.script);
  const present = scripts.slice(0, 3);
  const base = [TRIAL_CANDIDATE_ID, present[0]!.id, present[1]!.id, present[2]!.id] as const;
  const map = loaded.maps[0]!;
  const matches: TrialPlanMatch[] = [0, 1].map((rotation) => {
    const seats = rotateSeats(base, rotation);
    return {
      matchIndex: rotation,
      comboIndex: 0,
      seed: TRIAL_GRID_SEED_BASE + rotation,
      seats,
      candidateSeat: seats.indexOf(TRIAL_CANDIDATE_ID) as 0 | 1 | 2 | 3,
      map: map.name,
      mapSha256: map.sha256,
    };
  });
  return {
    version: TRIAL_PLAN_VERSION,
    ruleset: RULESET_VERSION,
    rulesetSha256: loaded.rulesetSha256,
    sandboxRuntimeHash: loaded.sandboxRuntimeHash,
    scripts,
    maps: [{ name: map.name, sha256: map.sha256 }],
    matchesPerCandidate: matches.length,
    matches,
    // 夹具不重建计划：摘要只需是形状合法的十六进制串（重建归入口的 `--expected-plan`）。
    planSha256: "0".repeat(64),
  };
};

const candidateSeatOf =
  (plan: TrialPlan) =>
  (matchIndex: number): 0 | 1 | 2 | 3 =>
    plan.matches[matchIndex]?.candidateSeat ?? 0;

it(
  "缩小网格跑满：每格一行观测（种子/座位/摘要取自计划），终局事实齐全，汇总与计划逐字一致",
  { timeout: 60_000 },
  async () => {
    const candidateCode = "function loop() { move(999999, 1, 0); }\n";
    // 只跑 4 个 tick：断言的是证据形状，不是对局长度。
    const loaded = fixtureLoaded({ candidateCode, ruleset: { tickLimit: 4 } });
    const plan = reducedPlan(loaded);
    expect(plan.matches.map((match) => match.candidateSeat)).toEqual([0, 3]);

    const { readings, trips } = await runTrialGrid(loaded, plan);
    expect(trips).toHaveLength(0);
    expect(readings.map((reading) => reading.matchIndex)).toEqual([0, 1]);
    const scriptSha256 = trialScriptSha256(loaded);
    for (const [index, reading] of readings.entries()) {
      const match = plan.matches[index]!;
      expect(reading.actionFacts?.seed).toBe(match.seed);
      expect(reading.actionFacts?.seat).toBe(match.candidateSeat);
      expect(reading.actionFacts?.scriptSha256).toBe(scriptSha256);
      expect(reading.actionFacts?.complete).toBe(true);
      // 终局四方身份 = 本场座位表（候选在哪一格由计划说）。
      expect(reading.terminalSummary?.seed).toBe(match.seed);
      expect(reading.terminalSummary?.players.map((player) => player.player)).toEqual([
        ...match.seats,
      ]);
      // 观测行过 CLI 的 ajv 校验（含 `seat: 0..3` 的放宽）。
      const lines = trialObservationLines([reading]);
      const validated = validateTrialObservation(JSON.parse(lines[0]!) as JsonValue);
      expect(validated.ok, validated.ok ? "" : validated.modelDiagnostics.join(" / ")).toBe(true);
    }

    // 汇总 = 计划的投影：形状、逐场身份、候选摘要都对得上。
    const summary = summaryOfGrid(plan, scriptSha256, readings);
    expect(summary.version).toBe(TRIAL_PLAN_VERSION);
    expect(summary.plan).toBe(plan);
    expect(summary.scriptSha256).toBe(scriptSha256);
    expect(summary.matches).toEqual(
      plan.matches.map((match) => ({
        matchIndex: match.matchIndex,
        seed: match.seed,
        candidateSeat: match.candidateSeat,
        map: match.map,
        mapSha256: match.mapSha256,
      })),
    );

    // 分数由 runner 的同一套算术填（本文件不重算）：分母恒等于计划声明的场数。
    expect(summary.score.countedMatches).toBe(plan.matchesPerCandidate);
    expect(summary.score.totalPoints).toBeGreaterThanOrEqual(0);
    expect(summary.score.totalPoints).toBeLessThanOrEqual(3 * plan.matchesPerCandidate);
    expect(summary.score.averagePoints).toBe(summary.score.totalPoints / plan.matchesPerCandidate);

    // 落盘：观测一行一场、汇总就在观测文件旁边，读回来与写出去逐字一致。
    const observationsPath = join(scratch, "reduced", "observed-r1.jsonl");
    mkdirSync(join(scratch, "reduced"), { recursive: true });
    expect(writeTrialObservations(observationsPath, trialObservationLines(readings)).ok).toBe(true);
    expect(writeTrialGridSummary(gridSummaryPathOf(observationsPath), summary).ok).toBe(true);
    const written = readFileSync(observationsPath, "utf8").trim().split("\n");
    expect(written).toHaveLength(2);
    expect(JSON.parse(readFileSync(gridSummaryPathOf(observationsPath), "utf8"))).toEqual(
      JSON.parse(JSON.stringify(summary)),
    );
  },
);

it("预算触限也跑满：不早停，后场照样有观测，判定仍按零容忍给拦", { timeout: 60_000 }, async () => {
  // 每 tick 801 次 API 调用 → 候选座位在看轨上触限。
  const loaded = fixtureLoaded({
    candidateCode: "function loop() { for (var i = 0; i < 801; i++) move(999999, 1, 0); }\n",
    ruleset: { tickLimit: 4 },
  });
  const plan = reducedPlan(loaded);
  const { readings, trips } = await runTrialGrid(loaded, plan);
  expect(readings).toHaveLength(2);
  expect(trips.length).toBeGreaterThan(0);
  expect(verdictOfTrips(trips, candidateSeatOf(plan)).passed).toBe(false);
  // 两场的读数都在（早停会让后一场没有读数，那在网格里等于丢样本）。
  expect(readings.map((reading) => reading.matchIndex)).toEqual([0, 1]);
  for (const reading of readings) {
    expect(reading.terminalSummary).toBeDefined();
    expect(reading.actionFacts?.complete).toBe(true);
  }
});

it("宿主执行异常（wasm 编译失败）大声抛出：不写半截证据", { timeout: 60_000 }, async () => {
  const loaded = fixtureLoaded({
    candidateCode: "function loop() {}\n",
    ruleset: { tickLimit: 1 },
  });
  const plan = reducedPlan(loaded);
  const original = WebAssembly.compile;
  Object.defineProperty(WebAssembly, "compile", {
    value: async () => {
      throw new Error("host-wasm-failure");
    },
    configurable: true,
  });
  try {
    await expect(runTrialGrid(loaded, plan)).rejects.toThrow("host-wasm-failure");
  } finally {
    Object.defineProperty(WebAssembly, "compile", { value: original, configurable: true });
  }
});

it("汇总拒绝缺场与多场：不缩分母、不补零", async () => {
  const loaded = fixtureLoaded({
    candidateCode: "function loop() {}\n",
    ruleset: { tickLimit: 1 },
  });
  const plan = reducedPlan(loaded);
  const { readings } = await runTrialGrid(loaded, plan);
  const scriptSha256 = trialScriptSha256(loaded);
  expect(() => summaryOfGrid(plan, scriptSha256, readings.slice(1))).toThrow(/缺少计划里的第 0 场/);
  expect(() => summaryOfGrid(plan, scriptSha256, [...readings, readings[0]!])).toThrow(
    /多出计划之外|同一场出现了多条读数/,
  );
});

it("观测写盘失败只交回原因，不改判定也不写半截文件", () => {
  const path = join(scratch, "missing-directory", "observed-r1.jsonl");
  const written = writeTrialObservations(path, ['{"matchIndex":0}']);
  expect(written.ok).toBe(false);
  if (written.ok) return;
  expect(written.reason.length).toBeGreaterThan(0);
});
