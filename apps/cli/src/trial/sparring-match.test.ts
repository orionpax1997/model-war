/**
 * 端到端：四份**冻结存档脚本**当陪练，在真实引擎上跑通网格里的第一场，产出观测行与完整终局事实。
 *
 * ── 这一例要证明什么 ──
 *
 * 「对手 = 存档脚本」这条路走得通：装载交回的四份身份能造出计划（`planSha256` 覆盖四份摘要），
 * 计划里的座位能直接建四个真 VM（QuickJS + 入库 runtime + wasm），一局跑完能交出
 * ①一条形状合法的观测行（`validateTrialObservation` 过 ajv）②完整的终局事实（四方名次、
 * 领土分、结算依据、结束原因）。不跑整张网格，只跑计划里的第一场。
 *
 * ── 为什么用夹具根而不是仓库真存档 ──
 *
 * `archive/` 不入库，测试不能把「本地有那几份存档」当硬前提。这里用临时根落三份榜单档
 * + 一份代位档，脚本内容取自仓库里的真基准（真策略，不是空壳），摘要按盘上字节现算，
 * 于是装载、摘要校验、计划身份、执行四段都能在无 archive 的机器上跑到。
 * 真存档那一路的核对在 `packages/runner/src/sparring-pool.test.ts`（存在才断言）。
 *
 * ── 为什么把 tick 上限压到 6 ──
 *
 * 这条断言的是「观测与终局事实齐全」，不是对局长度；短局让这条 e2e 稳定在秒级。
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it } from "vitest";
import {
  QUICKJS_WASI_WASM_PATH,
  RULESET_VERSION,
  SANDBOX_RUNTIME_ARTIFACT_PATH,
  TRIAL_BENCHMARK_IDS,
  TRIAL_CANDIDATE_ID,
  type JsonValue,
  type MapDefinition,
  type ReplayPlayerRef,
  type ReplaySeat,
  type Ruleset,
  type TrialObservationLine,
  type TrialSparringIdentity,
} from "@model-war/schema";
import { buildTrialPlan, loadSparringPool, sparringPoolScriptsOf } from "@model-war/runner";
import { createQuickJsRunner } from "@model-war/engine/runner";

import { budgetOf, budgetTracksOf, headForMap } from "../match/assemble.js";
import { validateTrialObservation } from "../validator.js";
import { runTrialMatch } from "./match-run.js";
import { trialObservationLines } from "./observations.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "modelwar-sparring-match-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/** 夹具根里落一份存档：三件套只写 `script.js` 与 `meta.json`（装载只认前者字节）。 */
const writeArchive = (root: string, slug: string, runId: string, code: string): string => {
  const dir = join(root, "archive", slug, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "script.js"), code);
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ model: slug, generatedAt: runId }));
  return sha256(code);
};

it("候选 vs 存档脚本：真实引擎跑通一场，观测行与终局事实齐全", { timeout: 60_000 }, async () => {
  // ── 夹具根：三份榜单档（真基准脚本）+ 一份代位档 ──
  const root = mkdtempSync(join(scratch, "root-"));
  const ladderCodes = TRIAL_BENCHMARK_IDS.map((name) =>
    readFileSync(join(repoRoot, "benchmarks", name, "script.js"), "utf8"),
  );
  const ladder: readonly TrialSparringIdentity[] = (
    [
      ["top", "ladder-top", "2026-10-01T00-00-00-001Z"],
      ["mid", "ladder-mid", "2026-10-02T00-00-00-002Z"],
      ["last", "ladder-last", "2026-10-03T00-00-00-003Z"],
    ] as const
  ).map(([role, id, runId], index) => ({
    role,
    id,
    runId,
    scriptSha256: writeArchive(root, id, runId, ladderCodes[index]!),
  }));
  const substitute = {
    id: "stand-in",
    runId: "2026-09-01T00-00-00-000Z",
    scriptSha256: writeArchive(root, "stand-in", "2026-09-01T00-00-00-000Z", ladderCodes[2]!),
  };

  const loaded = loadSparringPool({ root, model: "brand-new-model", ladder, substitute });
  expect(loaded.ok, loaded.ok ? "" : loaded.reason).toBe(true);
  if (!loaded.ok) return;
  const { pool } = loaded;
  // 首次生成没有存档：在位以代位档顶替，来源标注可见。
  expect(pool.scripts[3]!.script.source).toBe(
    `archive:${substitute.id}/${substitute.runId}#substitute`,
  );

  // ── 装载面：规则集 / 地图 / runtime / wasm（真安装根的同几份字节）──
  const rulesetPath = join(repoRoot, "rulesets", `${RULESET_VERSION}.json`);
  const mapPath = join(repoRoot, "maps", "corridor-split.json");
  // 短局：这条断言的是观测与终局事实，不是对局长度。
  const ruleset: Ruleset = { ...readJson<Ruleset>(rulesetPath), tickLimit: 6 };
  const map = readJson<MapDefinition>(mapPath);
  const mapSha256 = sha256(readFileSync(mapPath));
  const runtimeCode = readFileSync(join(repoRoot, SANDBOX_RUNTIME_ARTIFACT_PATH), "utf8");
  const wasmBytes = readFileSync(join(repoRoot, QUICKJS_WASI_WASM_PATH));

  // ── 四份陪练身份直接进计划 ──
  const plan = buildTrialPlan({
    ruleset: RULESET_VERSION,
    rulesetSha256: sha256(readFileSync(rulesetPath)),
    sandboxRuntimeHash: sha256(runtimeCode),
    scripts: sparringPoolScriptsOf(pool),
    // 计划要求两张图（网格的两维之一）；这里只跑第一场，第二张图只进身份。
    maps: [
      { name: "corridor-split", sha256: mapSha256 },
      {
        name: "open-clash",
        sha256: sha256(readFileSync(join(repoRoot, "maps", "open-clash.json"))),
      },
    ],
  });
  const match = plan.matches[0]!;
  // 组合 0 轮空榜首那份：座位上是候选 + 中位 + 末位 + 在位（轮空谁由组合下标说）。
  expect(match.seats).toEqual([
    TRIAL_CANDIDATE_ID,
    pool.scripts[1]!.script.id,
    pool.scripts[2]!.script.id,
    pool.scripts[3]!.script.id,
  ]);

  // ── 一场真对局：候选用仓库里另一份真基准脚本，三个对手是存档脚本 ──
  const candidateCode = readFileSync(
    join(repoRoot, "benchmarks", "cell-b-expansion-economy", "script.js"),
    "utf8",
  );
  const codes = new Map<string, string>([
    [TRIAL_CANDIDATE_ID, candidateCode],
    ...pool.scripts.map((entry): [string, string] => [entry.script.id, entry.code]),
  ]);
  const players = match.seats.map((id, seat): ReplayPlayerRef => ({
    model: id === TRIAL_CANDIDATE_ID ? "trial-candidate" : id,
    archiveRef: `trial/${id}`,
    seat: seat as ReplaySeat,
  }));
  const budget = budgetOf(ruleset);
  const wasmModule = await WebAssembly.compile(wasmBytes);
  const handles: Awaited<ReturnType<typeof createQuickJsRunner>>[] = [];
  let outcome: Awaited<ReturnType<typeof runTrialMatch>>;
  try {
    for (const [seat, id] of match.seats.entries()) {
      const code = codes.get(id);
      if (code === undefined) throw new Error(`计划里的对手 ${id} 不在装载面上`);
      handles.push(
        await createQuickJsRunner({
          wasm: wasmModule,
          runtimeCode,
          scriptCode: code,
          seat: seat as ReplaySeat,
          ruleset,
          ...budgetTracksOf(budget),
        }),
      );
    }
    outcome = runTrialMatch({
      runners: handles.map((handle) => handle.runner),
      players,
      ruleset,
      map,
      seed: match.seed,
      budget,
      head: headForMap(mapSha256),
      matchIndex: match.matchIndex,
      candidateSeat: match.candidateSeat,
    });
  } finally {
    for (const handle of handles) handle.dispose();
  }

  // ── 终局事实：四方都在、名次与领土分齐全、结束原因在枚举里 ──
  expect(outcome.fault).toBeNull();
  const terminal = outcome.terminalSummary;
  if (terminal === undefined) throw new Error("真实对局没有交出终局事实");
  expect(terminal.version).toBe(1);
  expect(terminal.seed).toBe(match.seed);
  expect(terminal.tick).toBeGreaterThan(0);
  expect(["victory", "shortcut", "timeout", "all-eliminated"]).toContain(terminal.reason);
  expect(terminal.players.map((player) => player.seat)).toEqual([0, 1, 2, 3]);
  expect(terminal.players.map((player) => player.player)).toEqual([
    "candidate",
    ...match.seats.slice(1),
  ]);
  for (const player of terminal.players) {
    expect(Number.isInteger(player.territoryScore)).toBe(true);
    expect(player.rank).toBeGreaterThanOrEqual(1);
    expect(player.rank).toBeLessThanOrEqual(4);
    // 结算依据与引擎 result 一致：分项之和 == 领土分（`terminalSummaryOf` 自己也会核一遍）。
    expect(player.score.bases + player.score.resources + player.score.units).toBe(
      player.territoryScore,
    );
  }
  // 名次是引擎给的 1..4（同分并列合法，因此不断言四座互异）。
  expect(terminal.players.every((player) => Number.isInteger(player.rank))).toBe(true);
  expect(terminal.rankPoints).toHaveLength(4);

  // ── 观测行：与执行器写盘同一条渲染路径，形状过 ajv ──
  const reading: TrialObservationLine = {
    matchIndex: match.matchIndex,
    ...outcome.scoreSource,
    terminalSummary: terminal,
    actionFacts: {
      version: 1,
      scriptSha256: sha256(candidateCode),
      seed: match.seed,
      seat: match.candidateSeat,
      ...outcome.actionFacts,
    },
  };
  const lines = trialObservationLines([reading]);
  expect(lines).toHaveLength(1);
  const line = JSON.parse(lines[0]!) as JsonValue;
  const validated = validateTrialObservation(line);
  expect(validated.ok, validated.ok ? "" : validated.modelDiagnostics.join(" / ")).toBe(true);
  if (!validated.ok) return;
  expect(validated.observation.matchIndex).toBe(match.matchIndex);
  expect(validated.observation.actionFacts?.scriptSha256).toBe(sha256(candidateCode));
  expect(validated.observation.actionFacts?.seed).toBe(match.seed);
  expect(validated.observation.actionFacts?.complete).toBe(true);
  expect(validated.observation.actionFacts?.missingTicks).toBe(0);
  expect(validated.observation.terminalSummary?.reason).toBe(terminal.reason);
  expect(validated.observation.terminalSummary?.players.map((player) => player.rank)).toEqual(
    terminal.players.map((player) => player.rank),
  );
});
