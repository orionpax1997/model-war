/** 独立选拔的真实执行与复算；不接受部分场次，也不向模型输出反馈。 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runMatch } from "@model-war/engine";
import { createQuickJsRunner } from "@model-war/engine/runner";
import {
  buildArchiveSelection,
  buildSelectionPlan,
  selectionInputSha256,
  validateSelection,
  type SelectionCandidateEvidence,
} from "@model-war/runner";
import {
  RULESET_VERSION,
  type ArchiveSelection,
  type SelectionCandidateIdentity,
  type SelectionPlan,
} from "@model-war/schema";
import { budgetOf, budgetTracksOf, headForMap } from "../match/assemble.js";
import { measureSandboxRuntimeHash } from "../match/sandbox-runtime.js";
import { loadTrial, type LoadedTrial } from "../trial/load.js";
import { TRIAL_MAP, TRIAL_OPPONENTS } from "../trial/trial.js";

const hash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export const planForSelection = (loaded: LoadedTrial): SelectionPlan =>
  buildSelectionPlan({
    ruleset: RULESET_VERSION,
    rulesetSha256: loaded.rulesetSha256,
    sandboxRuntimeHash: measureSandboxRuntimeHash(),
    map: TRIAL_MAP,
    mapSha256: loaded.mapSha256,
    baselines: [
      { id: TRIAL_OPPONENTS[0]!, scriptSha256: hash(loaded.scripts[1]) },
      { id: TRIAL_OPPONENTS[1]!, scriptSha256: hash(loaded.scripts[2]) },
      { id: TRIAL_OPPONENTS[2]!, scriptSha256: hash(loaded.scripts[3]) },
    ],
  });

export type SelectionArtifact = SelectionCandidateIdentity & {
  readonly scriptPath: string;
  readonly sourcePath: string;
};
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("选拔输入形状不合法");
  return value as Record<string, unknown>;
};
/** 私有 JSON 协议仍按 unknown 处理，TS 类型不能证明候选或路径身份。 */
export const readSelectionArtifacts = (value: unknown): readonly SelectionArtifact[] => {
  if (!Array.isArray(value) || value.length !== 3) throw new Error("选拔缺少三个有效候选");
  return value.map((entry: unknown, stage): SelectionArtifact => {
    const item = object(entry);
    if (
      item["stage"] !== stage ||
      !Number.isSafeInteger(item["protocolRound"]) ||
      typeof item["protocolRound"] !== "number" ||
      item["protocolRound"] < 1 ||
      (stage > 0 && item["protocolRound"] <= (object(value[stage - 1])["protocolRound"] as number))
    )
      throw new Error("选拔候选阶段或轮号不合法");
    const strings = ["scriptSha256", "sourceSha256", "scriptPath", "sourcePath"] as const;
    for (const key of strings)
      if (typeof item[key] !== "string" || item[key].length === 0)
        throw new Error("选拔候选身份缺失");
    const scriptSha256 = item["scriptSha256"] as string;
    const sourceSha256 = item["sourceSha256"] as string;
    const scriptPath = item["scriptPath"] as string;
    const sourcePath = item["sourcePath"] as string;
    if (
      !/^[0-9a-f]{64}$/.test(scriptSha256) ||
      !/^[0-9a-f]{64}$/.test(sourceSha256) ||
      hash(readFileSync(scriptPath)) !== scriptSha256 ||
      hash(readFileSync(sourcePath)) !== sourceSha256
    )
      throw new Error("选拔候选 TS/JS 字节不一致");
    return {
      stage: stage as 0 | 1 | 2,
      protocolRound: item["protocolRound"],
      scriptSha256,
      sourceSha256,
      scriptPath,
      sourcePath,
    };
  });
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const identity = ({
  stage,
  protocolRound,
  scriptSha256,
  sourceSha256,
}: SelectionCandidateIdentity): SelectionCandidateIdentity => ({
  stage,
  protocolRound,
  scriptSha256,
  sourceSha256,
});
export const validatePreparedSelection = (options: {
  readonly root: string;
  readonly candidates: unknown;
  readonly expectedPlan: unknown;
  readonly selection: unknown;
}): ArchiveSelection => {
  const artifacts = readSelectionArtifacts(options.candidates);
  const actualPlan = planForSelection(loadTrial(options.root, artifacts[0]!.scriptPath));
  if (!same(actualPlan, options.expectedPlan)) throw new Error("选拔环境与预定输入不一致");
  const selection = validateSelection(options.selection);
  if (selection.reason === "earlier-stage") throw new Error("新选拔结果不能使用历史决胜规则");
  if (
    selection.plan.planSha256 !== actualPlan.planSha256 ||
    !same(selection.candidates.map(identity), artifacts.map(identity))
  )
    throw new Error("选拔结果候选或环境身份不一致");
  return selection;
};

export const executeSelection = async (options: {
  readonly root: string;
  readonly candidates: unknown;
  readonly expectedPlan: unknown;
}): Promise<ArchiveSelection> => {
  const artifacts = readSelectionArtifacts(options.candidates);
  const loaded = loadTrial(options.root, artifacts[0]!.scriptPath);
  const plan = planForSelection(loaded);
  if (!same(plan, options.expectedPlan)) throw new Error("选拔环境与预定输入不一致");
  const wasm = await WebAssembly.compile(loaded.wasmBytes);
  const budget = budgetOf(loaded.ruleset);
  const tracks = budgetTracksOf(budget);
  const evidence: SelectionCandidateEvidence[] = [];
  for (const artifact of artifacts) {
    const prior = evidence.find((candidate) => candidate.scriptSha256 === artifact.scriptSha256);
    if (prior !== undefined) {
      evidence.push({
        ...identity(artifact),
        matches: prior.matches,
        reusedFromStage: prior.stage,
      });
      continue;
    }
    const candidateCode = readFileSync(artifact.scriptPath, "utf8");
    if (hash(candidateCode) !== artifact.scriptSha256)
      throw new Error("选拔执行字节与候选身份不一致");
    const scripts = new Map([
      ["candidate", candidateCode],
      ...plan.baselines.map((entry, index): [string, string] => [
        entry.id,
        loaded.scripts[index + 1]!,
      ]),
    ]);
    const matches: SelectionCandidateEvidence["matches"][number][] = [];
    for (const match of plan.matches) {
      // 顺序创建，任何创建失败也释放已建 VM，不改变沙箱/游戏预算。
      const handles: Awaited<ReturnType<typeof createQuickJsRunner>>[] = [];
      try {
        for (const [seat, id] of match.seats.entries())
          handles.push(
            await createQuickJsRunner({
              wasm,
              runtimeCode: loaded.runtimeCode,
              scriptCode: scripts.get(id)!,
              seat: seat as 0 | 1 | 2 | 3,
              ruleset: loaded.ruleset,
              ...tracks,
            }),
          );
        const outcome = runMatch({
          runners: handles.map((handle) => handle.runner),
          players: match.seats.map((id, seat) => ({
            model: id,
            archiveRef: `selection/${id}`,
            seat: seat as 0 | 1 | 2 | 3,
          })),
          ruleset: loaded.ruleset,
          map: loaded.map,
          seed: match.seed,
          budget,
          head: headForMap(loaded.mapSha256),
          sink: { write: () => {} },
        });
        if (outcome.status !== "completed") throw new Error("选拔对局缺少完整终局");
        matches.push({
          matchIndex: match.matchIndex,
          inputSha256: selectionInputSha256(plan, artifact.scriptSha256, match),
          result: outcome.result,
        });
      } finally {
        for (const handle of handles) handle.dispose();
      }
    }
    evidence.push({ ...identity(artifact), matches });
  }
  return validatePreparedSelection({
    ...options,
    selection: buildArchiveSelection(plan, evidence),
  });
};
