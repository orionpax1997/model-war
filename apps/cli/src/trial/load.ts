/**
 * 优化试跑与独立选拔共享同一安装面、字节读取和装载校验。
 *
 * ── 这里读的正是**计划的事实** ──
 *
 * 计划（`@model-war/schema` 的 `trial-plan.ts`）只收事实：规则集与运行时摘要、对手清单
 * （含各自 `script.js` 字节摘要）、地图清单（含字节摘要）。摘要没法凭空认定，所以由这里
 * 从盘上现算；`--plan` 模式与默认执行模式读的是同一份装载结果，于是计划在两边**同源**。
 *
 * 候选不在事实里：候选是每次调用的输入（产物路径），它的身份是编译产物字节的 sha256，
 * 由执行器现算（不写进计划）。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  QUICKJS_WASI_WASM_PATH,
  RULESET_VERSION,
  SANDBOX_RUNTIME_ARTIFACT_PATH,
  TRIAL_BENCHMARK_IDS,
  TRIAL_MAP_NAME,
  type JsonValue,
  type MapDefinition,
  type Ruleset,
  type TrialPlanScript,
} from "@model-war/schema";
import type { BuildTrialPlanInput } from "@model-war/runner";
import { measureSandboxRuntimeHash } from "../match/sandbox-runtime.js";
import { validateMap, validateRuleset } from "../validator.js";
const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

const readText = (path: string): string => readFileSync(path, "utf8");

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

/**
 * 读盘 + 校验试跑计划依赖的全部输入（不含候选）。
 *
 * 抛出的都是人话（调用方收成 infra 错误，不回喂）。摘要一律**现算字节**，
 * 不信任何记录下来的值——计划里的摘要与这里的值对不上就是「换了一份脚本」。
 */
export const loadTrialPlanInputs = (root: string): TrialPlanInputs => {
  let ruleset: Ruleset;
  let rulesetSha256: string;
  try {
    const rulesetBytes = readFileSync(join(root, "rulesets", `${RULESET_VERSION}.json`));
    rulesetSha256 = sha256(rulesetBytes);
    const parsed = JSON.parse(rulesetBytes.toString("utf8")) as JsonValue;
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

  let map: LoadedTrialMap;
  try {
    const mapBytes = readFileSync(join(root, "maps", `${TRIAL_MAP_NAME}.json`));
    const validation = validateMap(JSON.parse(mapBytes.toString("utf8")) as JsonValue);
    if (!validation.ok) {
      throw new Error("地图未通过校验");
    }
    map = { name: TRIAL_MAP_NAME, definition: validation.map, sha256: sha256(mapBytes) };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`地图 ${TRIAL_MAP_NAME} 装载失败:${reason}`);
  }

  const opponents = TRIAL_BENCHMARK_IDS.map((name): LoadedTrialOpponent => {
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
    rulesetSha256,
    sandboxRuntimeHash: measureSandboxRuntimeHash(),
    maps: [map],
    opponents,
    runtimeCode,
    wasmBytes,
  };
};

/** 事实 + 候选编译产物；候选读不到即抛（调用方收成 infra，不回喂）。 */
export const loadTrial = (root: string, candidatePath: string): LoadedTrial => {
  let candidateCode: string;
  try {
    candidateCode = readText(candidatePath);
  } catch {
    throw new Error(`读不到候选产物 ${candidatePath}`);
  }
  return { ...loadTrialPlanInputs(root), candidateCode };
};
