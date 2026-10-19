/** 优化试跑与独立选拔共享同一安装面、字节读取和装载校验。 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  QUICKJS_WASI_WASM_PATH,
  RULESET_VERSION,
  SANDBOX_RUNTIME_ARTIFACT_PATH,
  type JsonValue,
  type MapDefinition,
  type Ruleset,
} from "@model-war/schema";
import { measureSandboxRuntimeHash } from "../match/sandbox-runtime.js";
import { validateMap, validateRuleset } from "../validator.js";
import { TRIAL_MAP, TRIAL_OPPONENTS } from "./trial.js";
const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

const readText = (path: string): string => readFileSync(path, "utf8");

export type LoadedTrial = {
  readonly ruleset: Ruleset;
  readonly map: MapDefinition;
  readonly mapSha256: string;
  readonly rulesetSha256: string;
  readonly scripts: readonly [string, string, string, string];
  readonly runtimeCode: string;
  readonly wasmBytes: Buffer;
};

/** 读盘 + 校验试跑的全部输入。抛出的都是人话（调用方收成 infra 错误，不回喂）。 */
export const loadTrial = (root: string, candidatePath: string): LoadedTrial => {
  let candidate: string;
  try {
    candidate = readText(candidatePath);
  } catch {
    throw new Error(`读不到候选产物 ${candidatePath}`);
  }

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
    rulesetSha256,
    map,
    mapSha256,
    scripts: [candidate, benchA, benchB, benchC],
    runtimeCode,
    wasmBytes,
  };
};
