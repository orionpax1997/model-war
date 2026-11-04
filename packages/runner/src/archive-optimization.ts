/**
 * 存档 `meta.json` 里优化旁证的读入端：形状 + 跨字段关系，按 `optimization.version` 分派。
 *
 * ── 两版并行，判据分开写 ──
 *
 * - **v1**（三场单图试跑，历史档）：候选三阶段、协议轮递增、旁挂文件命名与互异、最终 hash
 *   与 `meta.scriptSha256` 的关系。这几个判据与 v1 一起冻结在 `archive/` 里，别就地改。
 * - **v2**（评测网格）：在上面的候选关系之上，还要核 `plan`（形状 + 能否由事实重建，见
 *   `readTrialPlan`）、`plan` 的规则集/运行时摘要与档一致、`sparring[]` 与 `plan.scripts`
 *   逐项一致、每个候选的 `score` / `matchCount` 与计划场数对齐、均分与总分自洽、
 *   以及**同字节必须复用**：字节与更早阶段相同时必须写 `reusedFromStage`，且来源必须是
 *   更早的**最早**那份同字节阶段、分数必须逐位相同。
 *
 * 两版之后共用的那一截（与 `selection` 的关系）只有一处：选拔是 v1 语义（12 场、seeds 401–403），
 * 07 才改语义，所以这里既不重算网格分数，也不按网格重解释选拔。
 */

import { z } from "zod";
import {
  ARCHIVE_META_JSON_SCHEMA,
  OPTIMIZATION_GRID_VERSION,
  SELECTION_GRID_VERSION,
  type ArchiveMeta,
  type ArchiveOptimization,
  type ArchiveOptimizationCandidate,
  type ArchiveOptimizationGrid,
  type ArchiveSelection,
} from "@model-war/schema";

import { validateSelection } from "./selection.js";
import { readTrialPlan } from "./trial-plan.js";

// 新优化档使用共享 schema 派生完整 shape；旧档仍走原读入政策。
const archiveMetaSchema = z.fromJSONSchema(
  JSON.parse(JSON.stringify(ARCHIVE_META_JSON_SCHEMA)) as z.core.JSONSchema.JSONSchema,
);

/**
 * 两版共用的候选关系：三阶段、协议轮严格递增且不越过总轮数、旁挂文件同源且六个名字互异。
 *
 * 「六」是两个文件名 × 三阶段；它保证每个阶段有自己独占的观测与候选产物，谁也不能借用别人的证据。
 */
const checkCandidateRelations = (
  meta: ArchiveMeta,
  candidates: readonly ArchiveOptimizationCandidate[],
): void => {
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
};

/**
 * v2 的网格判据：计划 ↔ 候选 ↔ 冻结身份 ↔ 陪练。
 *
 * `score` 与 `matchCount` 由 schema 保证必填（v2 的候选形状把这两栏放进 `required`），
 * 所以这里只核它们之间以及与计划的关系。**不重算分数**：生成阶段落的是选拔与报告的同源值，
 * 真复算在选拔（07）。
 */
const checkGridRelations = (meta: ArchiveMeta, optimization: ArchiveOptimizationGrid): void => {
  const plan = readTrialPlan(optimization.plan);
  if (plan.ruleset !== meta.ruleset || plan.sandboxRuntimeHash !== meta.sandboxRuntimeHash)
    throw new Error("网格计划与存档的规则集或运行时摘要不一致");
  if (
    optimization.sparring.length !== plan.scripts.length ||
    optimization.sparring.some((identity, index) => {
      const script = plan.scripts[index];
      return (
        script === undefined ||
        identity.id !== script.id ||
        identity.role !== script.role ||
        identity.source !== script.source ||
        identity.scriptSha256 !== script.scriptSha256
      );
    })
  )
    throw new Error("陪练身份与网格计划不一致");
  for (const [index, candidate] of optimization.candidates.entries()) {
    const score = candidate.score;
    if (score === undefined) throw new Error("网格候选缺少分数");
    if (
      candidate.matchCount !== plan.matchesPerCandidate ||
      score.countedMatches !== plan.matchesPerCandidate
    )
      throw new Error("候考场次与网格计划不一致（不许缩分母）");
    if (score.averagePoints !== score.totalPoints / score.countedMatches)
      throw new Error("候选网格均分与总分不一致");
    // 同字节必须复用：字节与更早阶段相同的候选不许写成「自己又跑了一遍」。
    const earliestSame = optimization.candidates
      .slice(0, index)
      .findIndex((earlier) => earlier.scriptSha256 === candidate.scriptSha256);
    if (candidate.reusedFromStage === undefined) {
      if (earliestSame >= 0) throw new Error("同字节候选必须复用更早阶段的网格结果");
      continue;
    }
    const source = optimization.candidates[candidate.reusedFromStage];
    const sourceScore = source?.score;
    if (
      candidate.reusedFromStage >= index ||
      source === undefined ||
      sourceScore === undefined ||
      source.scriptSha256 !== candidate.scriptSha256
    )
      throw new Error("复用来源必须指向更早的同字节候选");
    if (candidate.reusedFromStage !== earliestSame)
      throw new Error("复用来源必须是更早的同字节阶段里最早的那一份");
    if (
      sourceScore.totalPoints !== score.totalPoints ||
      sourceScore.averagePoints !== score.averagePoints ||
      sourceScore.countedMatches !== score.countedMatches
    )
      throw new Error("复用候选的网格分数必须与来源逐位相同");
  }
};

/**
 * v2 选拔与生成阶段网格是同一件事：计划必须逐字相同（`planSha256`），每个候选的分数必须
 * 与它自己那一阶段的网格分数逐位相同。选拔的复算只校不对——所以报告侧看到的「那个分数」
 * 只能有一个值，两处一旦分叉，存档就不能再声称「这 32 场是它跑出来的」。
 */
const checkGridSelection = (
  optimization: ArchiveOptimization,
  selection: Extract<ArchiveSelection, { version: typeof SELECTION_GRID_VERSION }>,
): void => {
  if (optimization.version !== OPTIMIZATION_GRID_VERSION)
    throw new Error("网格选拔存档必须包含网格形态的优化阶段");
  if (selection.plan.planSha256 !== optimization.plan.planSha256)
    throw new Error("选拔计划与生成阶段的网格计划不同源");
  selection.candidates.forEach((candidate, index) => {
    const generated = optimization.candidates[index];
    if (generated?.score === undefined) throw new Error("网格候选缺少分数");
    if (
      generated.score.totalPoints !== candidate.score.totalPoints ||
      generated.score.averagePoints !== candidate.score.averagePoints ||
      generated.score.countedMatches !== candidate.score.countedMatches
    )
      throw new Error("选拔候选分数与生成阶段的网格分数不一致");
    if (candidate.matches.length !== selection.plan.matchesPerCandidate)
      throw new Error("选拔候选的逐场证据条数与计划场数不一致（不许缩分母）");
  });
};

/** 形状通过之后的共享身份判据；CLI、赛季及报告共用。 */
export const validateArchiveCandidateRelations = (meta: ArchiveMeta): void => {
  const optimization = meta.optimization;
  if (optimization === undefined) {
    if (meta.selection !== undefined) throw new Error("选拔存档必须包含三个优化阶段");
    return;
  }
  checkCandidateRelations(meta, optimization.candidates);
  // v1 没有额外关系要判：三个固定试跑种子由 schema 的 v1 分支钉住，与赛季种子的隔离
  // 由调度器负责（`scheduler.ts`）。不为了「对称」给历史档加新判据——那会让旧档读不进来。
  if (optimization.version === OPTIMIZATION_GRID_VERSION) checkGridRelations(meta, optimization);
  if (meta.selection === undefined) {
    if (optimization.candidates[2]?.scriptSha256 !== meta.scriptSha256)
      throw new Error("优化最终 hash 关系不合法");
    return;
  }
  const selection = validateSelection(meta.selection);
  if (selection.version === SELECTION_GRID_VERSION) checkGridSelection(optimization, selection);
  if (
    selection.plan.ruleset !== meta.ruleset ||
    selection.plan.sandboxRuntimeHash !== meta.sandboxRuntimeHash ||
    selection.selected.scriptSha256 !== meta.scriptSha256 ||
    selection.candidates.some((candidate, index) => {
      const generated = optimization.candidates[index];
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
