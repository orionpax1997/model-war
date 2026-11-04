/**
 * 优化试跑与独立选拔共享同一安装面、字节读取和装载校验。
 *
 * ── 这里读的正是**计划的事实** ──
 *
 * 计划（`@model-war/schema` 的 `trial-plan.ts`）只收事实：规则集与运行时摘要、对手清单
 * （含各自 `script.js` 字节摘要）、地图清单（含字节摘要）。摘要没法凭空认定，所以由这里
 * 从盘上现算；`--plan` 模式与默认执行模式读的是同一份装载结果，于是计划在两边**同源**。
 *
 * ── 两张脸，同一套读盘 ──
 *
 * - **评测网格**（`loadTrialGrid`）：两张地图（`TRIAL_GRID_MAP_NAMES`）+ 四份存档陪练
 *   （`@model-war/runner` 的 `loadSparringPool` 读 `archive/<slug>/<runId>/script.js` 并现算摘要）。
 *   在位那份随模型而定，所以这里要 `model`——它就是「正在被生成的那个模型」，不是对手参数。
 * - **选拔**（`loadTrial`）：单图 `corridor-split` + 三份基准脚本，仍是旧口径（选拔换尺子
 *   是另一票的事）。
 *
 * 候选两者都**不在事实里**：候选是每次调用的输入（产物路径），它的身份是编译产物字节的
 * sha256，由执行器现算（不写进计划）。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  QUICKJS_WASI_WASM_PATH,
  RULESET_VERSION,
  SANDBOX_RUNTIME_ARTIFACT_PATH,
  TRIAL_BENCHMARK_IDS,
  TRIAL_GRID_MAP_NAMES,
  TRIAL_MAP_NAME,
  type JsonValue,
  type MapDefinition,
  type Ruleset,
  type TrialPlanScript,
} from "@model-war/schema";
import { loadSparringPool, type BuildTrialPlanInput } from "@model-war/runner";
import { measureSandboxRuntimeHash } from "../match/sandbox-runtime.js";
import { validateMap, validateRuleset } from "../validator.js";
const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

const readText = (path: string): string => readFileSync(path, "utf8");

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** 计划里的一张地图：名字（文件名去后缀）+ 校验后的定义 + 字节摘要。 */
export type LoadedTrialMap = {
  readonly name: string;
  readonly definition: MapDefinition;
  readonly sha256: string;
};

/** 计划里的一份对手：计划条目 + 执行时用的脚本源码（摘要取自同一份字节）。 */
export type LoadedTrialOpponent = {
  readonly script: TrialPlanScript;
  readonly code: string;
};

/** 造计划所需的事实（不含候选）。`--plan` 与默认执行模式读的是同一份。 */
export type TrialPlanInputs = {
  readonly ruleset: Ruleset;
  readonly rulesetSha256: string;
  readonly sandboxRuntimeHash: string;
  readonly maps: readonly LoadedTrialMap[];
  readonly opponents: readonly LoadedTrialOpponent[];
  readonly runtimeCode: string;
  readonly wasmBytes: Buffer;
};

/** 事实 + 本次候选的编译产物源码。 */
export type LoadedTrial = TrialPlanInputs & { readonly candidateCode: string };

/** 事实 → 计划构造输入（`ruleset` 取生效规则集版本名，与存档 meta 同一取值）。 */
export const trialPlanFactsOf = (inputs: TrialPlanInputs): BuildTrialPlanInput => ({
  ruleset: RULESET_VERSION,
  rulesetSha256: inputs.rulesetSha256,
  sandboxRuntimeHash: inputs.sandboxRuntimeHash,
  scripts: inputs.opponents.map((opponent) => opponent.script),
  maps: inputs.maps.map((map) => ({ name: map.name, sha256: map.sha256 })),
});

/** 生效规则集 + 字节摘要；未过装载期校验即抛（调用方收成 infra 错误）。 */
const loadRuleset = (root: string): { ruleset: Ruleset; rulesetSha256: string } => {
  try {
    const bytes = readFileSync(join(root, "rulesets", `${RULESET_VERSION}.json`));
    const parsed = JSON.parse(bytes.toString("utf8")) as JsonValue;
    const validation = validateRuleset(parsed, {
      rulesetFileName: basename(join(root, "rulesets", `${RULESET_VERSION}.json`)),
      rulesDocDirName: basename(join(root, "docs", `rules-${RULESET_VERSION}`)),
    });
    if (!validation.ok) throw new Error("规则集未通过装载期校验");
    return { ruleset: validation.ruleset, rulesetSha256: sha256(bytes) };
  } catch (cause) {
    throw new Error(`规则集装载失败:${reasonOf(cause)}`);
  }
};

/** 一张地图：读盘 → 校验 → 字节摘要（名字与文件名同源）。 */
const loadMap = (root: string, name: string): LoadedTrialMap => {
  try {
    const bytes = readFileSync(join(root, "maps", `${name}.json`));
    const validation = validateMap(JSON.parse(bytes.toString("utf8")) as JsonValue);
    if (!validation.ok) throw new Error("地图未通过校验");
    return { name, definition: validation.map, sha256: sha256(bytes) };
  } catch (cause) {
    throw new Error(`地图 ${name} 装载失败:${reasonOf(cause)}`);
  }
};

/** 入库 runtime bundle + quickjs wasm；常量与字节不符即 infra。 */
const loadSandbox = (
  root: string,
): { runtimeCode: string; wasmBytes: Buffer; sandboxRuntimeHash: string } => {
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
  return { runtimeCode, wasmBytes, sandboxRuntimeHash: measureSandboxRuntimeHash() };
};

/** 三份基准脚本（选拔仍在用）；摘要取自同一份字节。 */
const loadBenchmarkOpponents = (root: string): readonly LoadedTrialOpponent[] =>
  TRIAL_BENCHMARK_IDS.map((name): LoadedTrialOpponent => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(root, "benchmarks", name, "script.js"));
    } catch {
      throw new Error(`读不到基准脚本 benchmarks/${name}/script.js`);
    }
    return {
      script: {
        id: name,
        role: "benchmark",
        source: `benchmark:${name}`,
        scriptSha256: sha256(bytes),
      },
      code: bytes.toString("utf8"),
    };
  });

/**
 * 四份存档陪练（评测网格的对手）：装载失败（缺档 / 摘要不符 / 目录读不了）在这里抛，
 * 理由由 `loadSparringPool` 逐字给出（指名是哪一份、期望与实际的摘要），调用方收成 infra。
 */
const loadSparringOpponents = (root: string, model: string): readonly LoadedTrialOpponent[] => {
  const loaded = loadSparringPool({ root, model });
  if (!loaded.ok) throw new Error(loaded.reason);
  return loaded.pool.scripts.map((entry) => ({ script: entry.script, code: entry.code }));
};

/**
 * 读盘 + 校验**评测网格**计划依赖的全部输入（不含候选）。
 *
 * 抛出的都是人话（调用方收成 infra 错误，不回喂）。摘要一律**现算字节**，
 * 不信任何记录下来的值——计划里的摘要与这里的值对不上就是「换了一份脚本」。
 */
export const loadTrialGridInputs = (root: string, model: string): TrialPlanInputs => {
  const { ruleset, rulesetSha256 } = loadRuleset(root);
  const maps = TRIAL_GRID_MAP_NAMES.map((name) => loadMap(root, name));
  const opponents = loadSparringOpponents(root, model);
  const sandbox = loadSandbox(root);
  return { ruleset, rulesetSha256, maps, opponents, ...sandbox };
};

/** 网格事实 + 候选编译产物；候选读不到即抛（调用方收成 infra，不回喂）。 */
export const loadTrialGrid = (root: string, model: string, candidatePath: string): LoadedTrial => {
  let candidateCode: string;
  try {
    candidateCode = readText(candidatePath);
  } catch {
    throw new Error(`读不到候选产物 ${candidatePath}`);
  }
  return { ...loadTrialGridInputs(root, model), candidateCode };
};

/**
 * 读盘 + 校验**选拔**口径的输入（不含候选）：单图 `corridor-split` + 三份基准脚本。
 *
 * 选拔换尺子是另一票的事；这里只是把同一套读盘复用过来，行为与网格化之前逐字相同。
 */
export const loadTrialPlanInputs = (root: string): TrialPlanInputs => {
  const { ruleset, rulesetSha256 } = loadRuleset(root);
  const maps = [loadMap(root, TRIAL_MAP_NAME)];
  const opponents = loadBenchmarkOpponents(root);
  const sandbox = loadSandbox(root);
  return { ruleset, rulesetSha256, maps, opponents, ...sandbox };
};

/** 选拔口径事实 + 候选编译产物；候选读不到即抛（调用方收成 infra，不回喂）。 */
export const loadTrial = (root: string, candidatePath: string): LoadedTrial => {
  let candidateCode: string;
  try {
    candidateCode = readText(candidatePath);
  } catch {
    throw new Error(`读不到候选产物 ${candidatePath}`);
  }
  return { ...loadTrialPlanInputs(root), candidateCode };
};
