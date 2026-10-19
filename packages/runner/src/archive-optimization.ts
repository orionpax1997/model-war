import { z } from "zod";
import { ARCHIVE_META_JSON_SCHEMA, type ArchiveMeta } from "@model-war/schema";

import { validateSelection } from "./selection.js";

// 新优化档使用共享 schema 派生完整 shape；旧档仍走原读入政策。
const archiveMetaSchema = z.fromJSONSchema(
  JSON.parse(JSON.stringify(ARCHIVE_META_JSON_SCHEMA)) as z.core.JSONSchema.JSONSchema,
);

/** 形状通过之后的共享身份判据；CLI、赛季及报告共用。 */
export const validateArchiveCandidateRelations = (meta: ArchiveMeta): void => {
  const optimization = meta.optimization;
  if (optimization === undefined) {
    if (meta.selection !== undefined) throw new Error("选拔存档必须包含三个优化阶段");
    return;
  }
  const candidates = optimization.candidates;
  if (
    candidates.length !== 3 ||
    meta.prompts.length !== meta.protocolRounds ||
    candidates.some(
      (candidate, index) =>
        candidate.stage !== index ||
        candidate.protocolRound > meta.protocolRounds ||
        candidate.protocolRound <= (candidates[index - 1]?.protocolRound ?? 0) ||
        candidate.scriptFile !== `${candidate.observationsFile}.candidate.js` ||
        !candidate.observationsFile.endsWith(`-round-${String(candidate.protocolRound)}.jsonl`),
    ) ||
    new Set(candidates.flatMap((candidate) => [candidate.scriptFile, candidate.observationsFile]))
      .size !== 6
  )
    throw new Error("优化候选阶段、协议轮或独占文件关系不合法");
  if (meta.selection === undefined) {
    if (candidates[2]?.scriptSha256 !== meta.scriptSha256)
      throw new Error("优化最终 hash 关系不合法");
    return;
  }
  const selection = validateSelection(meta.selection);
  if (
    selection.plan.ruleset !== meta.ruleset ||
    selection.plan.sandboxRuntimeHash !== meta.sandboxRuntimeHash ||
    selection.selected.scriptSha256 !== meta.scriptSha256 ||
    selection.candidates.some((candidate, index) => {
      const generated = candidates[index];
      return (
        generated?.stage !== candidate.stage ||
        generated.protocolRound !== candidate.protocolRound ||
        generated.scriptSha256 !== candidate.scriptSha256
      );
    })
  )
    throw new Error("选拔候选、冻结 hash 或执行环境与优化存档不一致");
};

export const optimizationMetaOf = (value: unknown): ArchiveMeta | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    (!Object.hasOwn(value, "optimization") && !Object.hasOwn(value, "selection"))
  )
    return undefined;
  const parsed = archiveMetaSchema.safeParse(value);
  if (!parsed.success) throw new Error("优化存档元数据形状不合法");
  const meta = parsed.data as ArchiveMeta;
  validateArchiveCandidateRelations(meta);
  return meta;
};
