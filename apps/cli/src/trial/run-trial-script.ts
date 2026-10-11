/**
 * 冻结期试跑的执行入口：gen 以子进程调它（与 `validate.ts` 调校验器同形）。
 *
 * 用法：`node run-trial-script.js <候选产物.js> --root <安装根>`。
 * 读：候选产物 + `<root>/rulesets/<RULESET_VERSION>.json` + `<root>/maps/<TRIAL_MAP>.json`
 * + 三份基准脚本 + wasm 与 runtime bundle；跑 `TRIAL_SEEDS` 的三场；stdout 打面向模型的
 * 反馈文本（逐字回喂），退出码回答结论。
 *
 * ── 退出码是 gen 的私有协议，不是 CLI 全局表 ──
 *
 * `0` 通过；`1` 预算超限（stdout = 回喂文本）；`2` 内部/infra 错误（用法错、读不到文件、
 * 规则集/地图未过校验、作废无法判定、引擎抛错——细节打 stderr）。gen 见 0/1 之外的码
 * 即大声失败，不回喂。不要把 `apps/cli/src/exit-codes.ts` 那张表套到这里：
 * 那张表的 1 是"装载期拒跑"，而这里的 1 是"拦下候选"，两码含义不同。
 *
 * ── 预算与组装复用 `assemble.ts` 的三处 ──
 *
 * 上限（`budgetOf`）、执行器映射（`budgetTracksOf`）、meta 头（`headForMap`）都从
 * `match/assemble.ts` 来：试跑与联赛跑在同一组阈值与同一组计数回调下，节流行为才一致。
 * 唯一不复用的是存档装载——候选此刻还不是存档（`commitArchive` 之前），脚本常驻内存。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  QUICKJS_WASI_WASM_PATH,
  RULESET_VERSION,
  SANDBOX_RUNTIME_ARTIFACT_PATH,
  type JsonValue,
  type MapDefinition,
  type ReplayPlayerRef,
  type Ruleset,
} from "@model-war/schema";
import { createQuickJsRunner } from "@model-war/engine/runner";

import { splitArgs } from "../args.js";
import { budgetOf, budgetTracksOf, headForMap } from "../match/assemble.js";
import { measureSandboxRuntimeHash } from "../match/sandbox-runtime.js";
import { validateMap, validateRuleset } from "../validator.js";
import { runTrialMatch, type TrialMatchOutcome } from "./match-run.js";
import {
  CANDIDATE_SEAT,
  TRIAL_MAP,
  TRIAL_OPPONENTS,
  TRIAL_SEEDS,
  WATCHED_TRACKS,
  renderTrialFeedback,
  verdictOfTrips,
  type RecordedTrip,
} from "./trial.js";

const USAGE = "用法: node run-trial-script.js <候选产物.js> --root <安装根>";

/** 试跑自己的退出码（见文件头：不是 CLI 全局表）。 */
const TRIAL_PASSED = 0;
const TRIAL_BLOCKED = 1;
const TRIAL_INFRA = 2;

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

const readText = (path: string): string => readFileSync(path, "utf8");

type LoadedTrial = {
  readonly ruleset: Ruleset;
  readonly map: MapDefinition;
  readonly mapSha256: string;
  readonly scripts: readonly [string, string, string, string];
  readonly runtimeCode: string;
  readonly wasmBytes: Buffer;
};

/** 读盘 + 校验试跑的全部输入。抛出的都是人话（调用方收成 infra 错误，不回喂）。 */
const loadTrial = (root: string, candidatePath: string): LoadedTrial => {
  let candidate: string;
  try {
    candidate = readText(candidatePath);
  } catch {
    throw new Error(`读不到候选产物 ${candidatePath}`);
  }

  let ruleset: Ruleset;
  try {
    const parsed = JSON.parse(
      readFileSync(join(root, "rulesets", `${RULESET_VERSION}.json`), "utf8"),
    ) as JsonValue;
    const rulesetFileName = basename(join(root, "rulesets", `${RULESET_VERSION}.json`));
    const rulesDocDirName = basename(join(root, "docs", `rules-${RULESET_VERSION}`));
    const validation = validateRuleset(parsed, { rulesetFileName, rulesDocDirName });
    if (!validation.ok) {
      throw new Error("规则集未通过装载期校验");
    }
    ruleset = validation.ruleset;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`规则集装载失败:${reason}`);
  }

  let map: MapDefinition;
  let mapSha256: string;
  try {
    const mapBytes = readFileSync(join(root, "maps", `${TRIAL_MAP}.json`));
    mapSha256 = sha256(mapBytes);
    const validation = validateMap(JSON.parse(mapBytes.toString("utf8")) as JsonValue);
    if (!validation.ok) {
      throw new Error("地图未通过校验");
    }
    map = validation.map;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`地图 ${TRIAL_MAP} 装载失败:${reason}`);
  }

  const opponents = TRIAL_OPPONENTS.map((name) => {
    try {
      return readText(join(root, "benchmarks", name, "script.js"));
    } catch {
      throw new Error(`读不到基准脚本 benchmarks/${name}/script.js`);
    }
  });
  const [benchA, benchB, benchC] = opponents;
  if (benchA === undefined || benchB === undefined || benchC === undefined) {
    throw new Error("基准对手装载不全（与 TRIAL_OPPONENTS 对不上）");
  }

  let runtimeCode: string;
  try {
    runtimeCode = readText(join(root, SANDBOX_RUNTIME_ARTIFACT_PATH));
  } catch {
    throw new Error(`读不了入库 runtime bundle ${SANDBOX_RUNTIME_ARTIFACT_PATH}`);
  }
  let wasmBytes: Buffer;
  try {
    wasmBytes = readFileSync(join(root, QUICKJS_WASI_WASM_PATH));
  } catch {
    throw new Error(`读不了 quickjs wasm ${QUICKJS_WASI_WASM_PATH}`);
  }
  // 常量 == 产物字节：门禁（`check:runtime`）担保它，入口只做一次顺手核对，
  // 对不上即 infra（安装面坏了，不是候选的错）。
  if (sha256(runtimeCode) !== measureSandboxRuntimeHash()) {
    throw new Error("runtime bundle 字节与入库哈希对不上（安装面损坏）");
  }

  return {
    ruleset,
    map,
    mapSha256,
    scripts: [candidate, benchA, benchB, benchC],
    runtimeCode,
    wasmBytes,
  };
};

/** meta 行的四方：候选 0 号位 + 三个基准（只进 meta 行，不进判据）。 */
const trialPlayers = (): readonly ReplayPlayerRef[] => [
  { model: "trial-candidate", archiveRef: "trial/candidate", seat: 0 },
  ...TRIAL_OPPONENTS.map((name, index): ReplayPlayerRef => ({
    model: name,
    archiveRef: `trial/${name}`,
    seat: (index + 1) as ReplayPlayerRef["seat"],
  })),
];

/**
 * 跑三场：预算/执行器映射/meta 头全走 `assemble.ts` 的复用件；每场建四个 VM、跑完即释放。
 *
 * 作废（墙钟硬超时）同一种子重跑一次：仍作废则抛 infra（无法判定，大声失败，不回喂）。
 * 非判定触限（对手座位/非看轨）打到 stderr 留痕，不进 stdout（stdout 是回喂纯文本）。
 */
const runThreeMatches = async (loaded: LoadedTrial): Promise<readonly RecordedTrip[]> => {
  const budget = budgetOf(loaded.ruleset);
  const tracks = budgetTracksOf(budget);
  const head = headForMap(loaded.mapSha256);
  const players = trialPlayers();
  const wasmModule = await WebAssembly.compile(loaded.wasmBytes);
  const trips: RecordedTrip[] = [];

  for (const [matchIndex, seed] of TRIAL_SEEDS.entries()) {
    const attempt = async (): Promise<TrialMatchOutcome> => {
      const handles = await Promise.all(
        ([0, 1, 2, 3] as const).map((seat) =>
          createQuickJsRunner({
            wasm: wasmModule,
            runtimeCode: loaded.runtimeCode,
            scriptCode: loaded.scripts[seat] ?? "",
            seat,
            ruleset: loaded.ruleset,
            ...tracks,
          }),
        ),
      );
      try {
        return runTrialMatch({
          runners: handles.map((handle) => handle.runner),
          players: [...players],
          ruleset: loaded.ruleset,
          map: loaded.map,
          seed,
          budget,
          head,
          matchIndex,
        });
      } finally {
        for (const handle of handles) {
          handle.dispose();
        }
      }
    };

    let outcome = await attempt();
    if (outcome.fault !== null) {
      process.stderr.write(
        `试跑注：第 ${String(matchIndex + 1)} 场在第 ${String(outcome.fault.tick)} tick 作废` +
          `（墙钟硬超时），同一种子重跑一次。\n`,
      );
      outcome = await attempt();
      if (outcome.fault !== null) {
        throw new Error(
          `第 ${String(matchIndex + 1)} 场两次作废（墙钟硬超时），无法判定候选是否超限`,
        );
      }
    }
    trips.push(...outcome.trips);
    // 早停：零容忍下首拦即定——后场的触限不可能把首触挤掉（到场序即数组序），
    // 全跑完只多花两场的 VM 时间，结论与反馈逐字相同。
    if (!verdictOfTrips(trips).passed) {
      break;
    }
  }
  return trips;
};

const main = async (argv: readonly string[]): Promise<number> => {
  const { root: rootArg, positional } = splitArgs(argv);
  const candidateArg = positional[0];
  if (candidateArg === undefined) {
    process.stderr.write(`缺候选产物参数。\n${USAGE}\n`);
    return TRIAL_INFRA;
  }
  const root = resolve(rootArg ?? process.cwd());

  let loaded: LoadedTrial;
  try {
    loaded = loadTrial(root, resolve(candidateArg));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`试跑装载失败:${reason}\n`);
    return TRIAL_INFRA;
  }

  let trips: readonly RecordedTrip[];
  try {
    trips = await runThreeMatches(loaded);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`试跑执行失败:${reason}\n`);
    return TRIAL_INFRA;
  }

  const ignored = trips.filter(
    (trip) => trip.seat !== CANDIDATE_SEAT || !WATCHED_TRACKS.includes(trip.track),
  );
  if (ignored.length > 0) {
    process.stderr.write(
      `试跑注：忽略 ${String(ignored.length)} 条非判定触限（对手座位/非看轨），不计入结论。\n`,
    );
  }

  const verdict = verdictOfTrips(trips);
  process.stdout.write(`${renderTrialFeedback(verdict)}\n`);
  return verdict.passed ? TRIAL_PASSED : TRIAL_BLOCKED;
};

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (cause) {
  const reason = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`试跑未捕获异常:${reason}\n`);
  process.exitCode = TRIAL_INFRA;
}
