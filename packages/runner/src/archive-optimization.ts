/**
 * 存档 `meta.json` 里优化旁证的读入端：形状 + 跨字段关系，分两层分派。
 *
 * ── 分派的第一层是**档案形状版本**，不是优化段版本 ──
 *
 * `archiveSchemaVersion`（ADR-0031 的第一件版本号）回答「这份文件按哪种形状读」。它缺席 =
 * 历史（one-shot）档，按 `optimization.version` 判 v1 / v2；它是 `3` = agent 形态，优化段
 * 只能是 v3（或整个缺席——零候选的失败档就是那个形状）。两条混淆路径都拒读：
 *
 * - 不认识的版本号：拒读，**不猜**（猜会把它读成「差不多对」）；
 * - 带 agent 顶层字段却缺 `archiveSchemaVersion: 3`：拒读。
 *
 * ── 第二层：两版 legacy 优化段并行，判据分开写 ──
 *
 * - **v1**（三场单图试跑，历史档）：候选三阶段、协议轮递增、旁挂文件命名与互异、最终 hash
 *   与 `meta.scriptSha256` 的关系。这几个判据与 v1 一起冻结在 `archive/` 里，别就地改。
 * - **v2**（评测网格）：在上面的候选关系之上，还要核 `plan`（形状 + 能否由事实重建，见
 *   `readTrialPlan`）、`plan` 的规则集/运行时摘要与档一致、`sparring[]` 与 `plan.scripts`
 *   逐项一致、每个候选的 `score` / `matchCount` 与计划场数对齐、均分与总分自洽、
 *   以及**同字节必须复用**：字节与更早阶段相同时必须写 `reusedFromStage`，且来源必须是
 *   更早的**最早**那份同字节阶段、分数必须逐位相同。
 *
 * 两版 legacy 与 `selection` 的关系共用一截：选拔是 v1 语义（12 场、seeds 401–403），
 * 07 才改语义，所以这里既不重算网格分数，也不按网格重解释选拔。v3 的候选关系单独一截：
 * 条数 1..3、**无 `stage`**、步号递增、**末位即最终候选**。
 */

import { z } from "zod";
import {
  AGENT_ARCHIVE_FIELD_KEYS,
  AGENT_ARCHIVE_REQUIRED_KEYS,
  ARCHIVE_META_JSON_SCHEMA,
  ARCHIVE_SCHEMA_VERSIONS,
  V4_ONLY_STEP_ACTION_KINDS,
  OPTIMIZATION_AGENT_VERSION,
  OPTIMIZATION_CANDIDATE_LIMIT,
  OPTIMIZATION_GRID_VERSION,
  OPTIMIZATION_VERSION,
  SELECTION_AGENT_VERSION,
  SELECTION_GRID_VERSION,
  SELECTION_VERSION,
  type ArchiveAgentSelection,
  type ArchiveMeta,
  type ArchiveOptimization,
  type ArchiveOptimizationAgent,
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
 * 档案形状版本的分派结果：`"legacy"` = 没有 `archiveSchemaVersion`（v1/v2 历史档），其余是
 * **读侧认得的**那些版本号（`ARCHIVE_SCHEMA_VERSIONS`：v3 与 v4 并认）。
 *
 * 返回类型从 schema 包派生、不另写一份：两个数组一旦分叉，会出现「形状那层认得、分派这层不认」
 * 这种只有某一条路径红的组合。
 */
export type ArchiveShapeVersion = import("@model-war/schema").ArchiveShapeVersion;

/**
 * 按 `archiveSchemaVersion` 分派（ADR-0031）：旧档、v3 / v4、其余拒读。
 *
 * ── 读侧 3 与 4 都认，写侧只写 4 ──
 *
 * v3 档不迁移：`archive/` 下的真档是校准 harness 的证据，改写形状等于改证据。两个版本的差别
 * 只有一处（v3 的步里不许有 `check` / `probe` / `toolCall`），而那条判据在
 * `archiveShapeIssueOf` 里——分派这一层只回答「按哪一版读」。
 *
 * 第二个拒读分支防的是一件真会发生的事：**只写了一半升级的档**。那些 agent 字段在旧读法里
 * 全是额外属性，`additionalProperties: false` 会拒它，但拒的理由是「多了几个键」，而真正的事实
 * 是「形状版本没跟上」。先把事实说出来。
 *
 * 它读 `unknown` 而不是 `ArchiveMeta`：报告侧先拿到的是未校验的 JSON 行，分派必须在那之前发生。
 */
export const archiveShapeVersionOf = (record: unknown): ArchiveShapeVersion => {
  if (typeof record !== "object" || record === null) throw new Error("档案不是 JSON 对象");
  const declared: unknown = Reflect.get(record, "archiveSchemaVersion");
  if (declared !== undefined) {
    const known = (ARCHIVE_SCHEMA_VERSIONS as readonly unknown[]).includes(declared);
    if (!known) throw new Error(`不认识的档案形状版本 ${JSON.stringify(declared)}：拒读，不猜`);
    return declared as ArchiveShapeVersion;
  }
  const stray = AGENT_ARCHIVE_FIELD_KEYS.find((key) => Object.hasOwn(record, key));
  if (stray !== undefined)
    throw new Error(
      `档案带 agent 字段 ${stray} 却缺 archiveSchemaVersion: ${ARCHIVE_SCHEMA_VERSIONS.join(" 或 ")}：新形状必须显式声明`,
    );
  return "legacy";
};

/**
 * 这个形状版本是不是 agent 形态（分步会话）。
 *
 * 判据是「不是 `legacy`」而不是「等于某两个数」：`archiveShapeVersionOf` 已经把不认识的版本拒掉，
 * 所以到这里非 `legacy` 就一定是某一个认得的 agent 版本。写成等号就得在每一处并列 `3` 与
 * `ARCHIVE_SCHEMA_VERSION`，而下一个版本落地时那些并列点会各自漏一处。
 */
export const isAgentShape = (
  shape: ArchiveShapeVersion,
): shape is Exclude<ArchiveShapeVersion, "legacy"> => shape !== "legacy";

/**
 * 形状版本与协议轮数的那几条判据（ADR-0031「断言合并成一个公式」）。
 *
 * v3：轮数 = 过程记录条数，起始 prompt 零步为零条、否则一条；历史档：轮数 = 逐轮 prompt 条数。
 * 写入侧的同一条公式在 `packages/gen/src/archive.ts` 的 `archiveRoundFieldsOf`，两处同源。
 *
 * 返回值而不是抛异常，是因为它有两个读者：`apps/cli` 要把它逐条渲染成面向模型的诊断，
 * runner 这一侧要把它抛成拒读。判据只有这一份，措辞也只在 `message` 里写一遍。
 */
export type ArchiveShapeIssue = {
  readonly kind:
    | "archive-schema-version"
    | "archive-agent-fields"
    | "archive-protocol-rounds"
    | "archive-step-shape";
  readonly pointer: string;
  readonly message: string;
};

/**
 * 按形状版本排除步里不许出现的东西（v3 与 v4 的**唯一**差别）。
 *
 * ── 为什么这条判据住在装载期，不住在 JSON Schema ──
 *
 * `check` / `probe` 两档动作与 `toolCall` 在 v4 才存在。要用 schema 表达「v3 档不许有它们」得
 * 写 `if/then`，而读入端有两条（`apps/cli` 的 ajv 与 runner 的 `z.fromJSONSchema`），后者不支持
 * 条件 schema；并排两套进 `oneOf` 也不行（v4 的 `bash` 分支是 v3 的超集，两分支会同时命中）。
 * 所以形状层收并集，版本的排除写在这里一处。
 *
 * 还有一条理由：`oneOf` 失败给不出**名字**，而这条验收要的正是点名——「v3 档塞了 `check`」
 * 必须读到 `check` 这两个字，否则修的人只能看到一句「形状不合法」。
 */
export const archiveStepShapeIssuesOf = (
  meta: ArchiveMeta,
  shape: ArchiveShapeVersion,
): readonly ArchiveShapeIssue[] => {
  const steps = meta.steps ?? [];
  return steps.flatMap((step, index) => {
    const pointer = `/steps/${String(index)}`;
    const pointerOf = (field: string): string => `${pointer}/${field}`;
    const onV3 = shape === ARCHIVE_SCHEMA_VERSIONS[0];
    const kind: unknown = step.action.kind;
    const v4Only = (V4_ONLY_STEP_ACTION_KINDS as readonly unknown[]).includes(kind);
    if (onV3 && v4Only)
      return [
        {
          kind: "archive-step-shape" as const,
          pointer: pointerOf("action/kind"),
          message: `v3 档案的步里有 ${String(kind)} 动作：v3 的世界里没有这个工具，拒读`,
        },
      ];
    if (onV3 && step.toolCall !== undefined)
      return [
        {
          kind: "archive-step-shape" as const,
          pointer: pointerOf("toolCall"),
          message: "v3 档案的步里带 toolCall：工具调用信封是 v4 的形状，拒读",
        },
      ];
    return [];
  });
};

export const archiveShapeIssuesOf = (meta: ArchiveMeta): readonly ArchiveShapeIssue[] => {
  let shape: ArchiveShapeVersion;
  try {
    shape = archiveShapeVersionOf(meta);
  } catch (cause) {
    return [
      {
        kind: "archive-schema-version",
        pointer: "/archiveSchemaVersion",
        message: cause instanceof Error ? cause.message : String(cause),
      },
    ];
  }
  if (isAgentShape(shape)) {
    const missing = AGENT_ARCHIVE_REQUIRED_KEYS.filter((key) => !Object.hasOwn(meta, key));
    if (missing.length > 0)
      return [
        {
          kind: "archive-agent-fields",
          pointer: "/steps",
          message: `v${String(shape)} 档案缺 agent 字段：${missing.join("、")}`,
        },
      ];
    const steps = meta.steps ?? [];
    if (meta.protocolRounds !== steps.length)
      return [
        {
          kind: "archive-protocol-rounds",
          pointer: "/steps",
          message: `协议轮数写了 ${String(meta.protocolRounds)}，而过程记录有 ${String(steps.length)} 条`,
        },
      ];
    if (meta.prompts.length !== (steps.length > 0 ? 1 : 0))
      return [
        {
          kind: "archive-protocol-rounds",
          pointer: "/prompts",
          message: `起始 prompt 应恰为 ${steps.length > 0 ? "一条" : "零条"}，实际 ${String(meta.prompts.length)} 条`,
        },
      ];
    return archiveStepShapeIssuesOf(meta, shape);
  }
  return meta.prompts.length === meta.protocolRounds
    ? []
    : [
        {
          kind: "archive-protocol-rounds",
          pointer: "/prompts",
          message: `协议轮数写了 ${String(meta.protocolRounds)}，而逐轮 prompt 有 ${String(meta.prompts.length)} 条`,
        },
      ];
};

/**
 * v3 的候选关系：条数 1..3（三次评测是配额，不是下限）、**无 `stage`**、步号严格递增且不越过
 * 总步数、旁挂文件同源且两两互异、末位即最终候选。
 *
 * 「末位即最终候选」是 ADR-0030「`evaluate` 即提交」的直接推论：成绩取最后一次 `evaluate`
 * 评的那个版本，所以冻结的 `script.js` 必须等于末位候选的字节。它不是「第三阶段」——
 * 候选可能只有一个，那时它就是末位。
 */
const checkAgentCandidateRelations = (
  meta: ArchiveMeta,
  optimization: ArchiveOptimizationAgent,
): void => {
  const { candidates } = optimization;
  if (candidates.length < 1 || candidates.length > OPTIMIZATION_CANDIDATE_LIMIT)
    throw new Error(
      `v3 候选数必须在 1..${String(OPTIMIZATION_CANDIDATE_LIMIT)} 之间，实际 ${String(candidates.length)} 条`,
    );
  for (const [index, candidate] of candidates.entries()) {
    if (
      candidate.step > meta.protocolRounds ||
      candidate.step <= (candidates[index - 1]?.step ?? 0) ||
      candidate.scriptFile !== `${candidate.observationsFile}.candidate.js` ||
      !candidate.observationsFile.endsWith(`-round-${String(candidate.step)}.jsonl`)
    )
      throw new Error("v3 候选步号或独占文件关系不合法");
  }
  if (
    new Set(candidates.flatMap((candidate) => [candidate.scriptFile, candidate.observationsFile]))
      .size !==
    candidates.length * 2
  )
    throw new Error("v3 候选的旁挂文件必须两两互异");
  const last = candidates[candidates.length - 1]!;
  if (last.scriptSha256 !== meta.scriptSha256) throw new Error("优化最终 hash 关系不合法");
};

/**
 * v3 选拔与候选序的关系：胜者指向候选序里的某一位（不是阶段），它的 hash 就是冻结 hash。
 *
 * 胜负的复算归 `validateSelection`（`selection-grid.ts` 的 v3 分支）；这里只核两层对位：
 * 选拔里的候选与优化段逐位同源（步号 + 编译产物摘要 + 分数），胜者就在这些候选里且就是
 * 冻结的那份字节。
 */
const checkAgentSelection = (
  meta: ArchiveMeta,
  optimization: ArchiveOptimizationAgent,
  selection: ArchiveAgentSelection,
): void => {
  if (
    selection.plan.ruleset !== meta.ruleset ||
    selection.plan.sandboxRuntimeHash !== meta.sandboxRuntimeHash
  )
    throw new Error("选拔计划与存档的规则集或运行时摘要不一致");
  if (selection.candidates.length !== optimization.candidates.length)
    throw new Error("选拔候选条数与优化段候选条数不一致");
  selection.candidates.forEach((candidate, index) => {
    const generated = optimization.candidates[index];
    if (
      generated === undefined ||
      generated.step !== candidate.step ||
      generated.scriptSha256 !== candidate.scriptSha256 ||
      generated.score.totalPoints !== candidate.score.totalPoints ||
      generated.score.averagePoints !== candidate.score.averagePoints ||
      generated.score.countedMatches !== candidate.score.countedMatches
    )
      throw new Error("选拔候选与优化段候选不同源或分数不一致");
  });
  if (selection.selected.scriptSha256 !== meta.scriptSha256)
    throw new Error("选拔胜者与冻结 hash 不一致");
  if (!selection.candidates.some((candidate) => candidate.step === selection.selected.step))
    throw new Error("选拔胜者不在候选序里");
};

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

/**
 * 形状通过之后的共享身份判据；CLI、赛季及报告共用。
 *
 * 分派顺序：先看档案形状版本（旧档 / v3 / 拒读），再看优化段版本。两者各管一件事，
 * 而「档案形状版本为 3 时优化段版本必须是 3 或优化段缺席」这条关系就坐在这里——它是关系，
 * 不是形状，JSON Schema 的条件分支表达不了（runner 的 `z.fromJSONSchema` 不支持 `if/then`）。
 */
export const validateArchiveCandidateRelations = (meta: ArchiveMeta): void => {
  // 形状版本与轮数公式归 `archiveShapeIssuesOf`（CLI 把它渲染成诊断，runner 把它抛成拒读）；
  // 这里只按版本分派候选关系，不重复报同一件事。
  const shape = archiveShapeVersionOf(meta);
  const optimization = meta.optimization;
  if (optimization === undefined) {
    if (meta.selection !== undefined) throw new Error("选拔存档必须包含优化段");
    return;
  }
  // 两条 agent 形状（v3 与 v4）在这一层是同一条规则：优化段必须是 agent 版、选拔段必须是 v3 版。
  // 两个版本号不同源（形状版本管「这份文件按哪种形状读」，优化段版本管「优化段内部是哪种变体」），
  // 所以文案里各自点名，不拿一个数字代另一个。
  if (isAgentShape(shape)) {
    if (optimization.version !== OPTIMIZATION_AGENT_VERSION)
      throw new Error(
        `档案形状版本 ${String(shape)} 要求优化段版本为 ${String(OPTIMIZATION_AGENT_VERSION)}`,
      );
    checkAgentCandidateRelations(meta, optimization);
    const selection = meta.selection;
    if (selection !== undefined) {
      // 形状上三种选拔记录都合 schema；agent 形状只接受 v3 那一种。
      if (selection.version !== SELECTION_AGENT_VERSION)
        throw new Error(
          `档案形状版本 ${String(shape)} 要求选拔段版本为 ${String(SELECTION_AGENT_VERSION)}`,
        );
      checkAgentSelection(meta, optimization, selection);
    }
    return;
  }
  if (optimization.version === OPTIMIZATION_AGENT_VERSION)
    throw new Error(
      `优化段版本 ${String(OPTIMIZATION_AGENT_VERSION)} 必须同时声明 archiveSchemaVersion: ${ARCHIVE_SCHEMA_VERSIONS.join(" 或 ")}`,
    );
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
  // v3 的选拔已在上面分派出去：能走到这里的只有 v1 / v2，而两者都有 `stage` 与 `protocolRound`。
  // 先拒 v3 再分派读法，顺序是**判据**而不是排版：拒读那一条说的是「这份档案自相矛盾」，
  // 它比「网格关系不合法」更靠近成因。
  if (selection.version === SELECTION_AGENT_VERSION)
    throw new Error(`档案形状版本不到 ${String(ARCHIVE_SCHEMA_VERSIONS[0])} 时不得带 v3 选拔记录`);
  if (!isLegacySelection(selection)) checkGridSelection(optimization, selection);
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

/**
 * 选拔段是 **v1**（12 场单图）还是**网格**（v2 / v3）。
 *
 * ── 为什么单独成判据而不是各写一处比较 ──
 *
 * 同一个问题有三处要回答：报告的候选分数读法、报告的计划读法、以及装载期的关系校验。三份
 * `selection.version === SELECTION_VERSION` 在将来出第四版（比如 v4 也走网格）时会各自漂成
 * 不同的答案，而它们读的是同一件事——「这份选拔记录按 12 场单图读，还是按网格读」。
 *
 * 类型守卫而不是返回字符串：调用点的两侧各自拿到**收窄后的**类型（v1 的 `plan.seeds` 与
 * 网格的 `plan.matches` 是两个形状，用一句 `??` 合成一个就会在版本之间静默切换语义）。
 */
export const isLegacySelection = (
  selection: ArchiveSelection,
): selection is Extract<ArchiveSelection, { version: typeof SELECTION_VERSION }> =>
  selection.version === SELECTION_VERSION;

/**
 * 优化段是 **v1**(三场单图)还是至少进入了网格(v2 / v3)。
 *
 * 与 `isLegacySelection` 同族、同一个理由:调用点要问的是「这一段按旧读法读吗」,而
 * `optimization.version !== OPTIMIZATION_VERSION` 读起来像「不是当前版本」——那个常量恰好是
 * **最老一版**,于是这行代码的字面意思与它的实际意思正好相反,而它是对的。将来出 v4(也带网格
 * 分数)时,散落各处的 `!== OPTIMIZATION_VERSION` 会各自漂成不同答案;收成一个守卫,答案只有一处。
 */
export const isLegacyOptimization = (
  optimization: ArchiveOptimization,
): optimization is Extract<ArchiveOptimization, { version: typeof OPTIMIZATION_VERSION }> =>
  optimization.version === OPTIMIZATION_VERSION;

/**
 * 优化旁证的读入端：按**档案形状版本**分派之后再过 zod 形状与跨字段关系。
 *
 * 没有 `optimization` 也没有 `selection` 的记录（纯历史逐轮档、零步失败档）返回 `undefined`——
 * 但分派本身仍要先跑：带 agent 字段却缺 `archiveSchemaVersion: 3` 的档不能因为「没有优化段」
 * 就跟着放行。
 */
export const optimizationMetaOf = (value: unknown): ArchiveMeta | undefined => {
  const shape = archiveShapeVersionOf(value);
  // 形状判据在**早退之前**跑:一份没有优化段、也没有选拔段的 agent 档案（零候选失败档、或
  // 一份只带过程记录的档）照样可能带着「它那一版不该有的步形状」，而那条判据不能因为
  // 「这份档没有优化段」就被跳过——那样 v3 档塞一条 `check` 会静默读成合法。
  if (isAgentShape(shape)) {
    // 只跑**步形状**那一条（含 `check` / `probe` / `toolCall` 的版本排除），不跑轮数公式：
    // 后者归 `archiveShapeIssuesOf`（CLI 渲染成诊断、赛季与装载期抛成拒读），而报告这一侧
    // 对**失败档**的轮数口径本来就是另一条（`prompts` 在旧失败档里是逐轮一份）。
    const [stepIssue] = archiveStepShapeIssuesOf(value as ArchiveMeta, shape);
    if (stepIssue !== undefined) throw new Error(stepIssue.message);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (!Object.hasOwn(value, "optimization") && !Object.hasOwn(value, "selection"))
  )
    return undefined;
  const parsed = archiveMetaSchema.safeParse(value);
  if (!parsed.success) throw new Error("优化存档元数据形状不合法");
  const meta = parsed.data as ArchiveMeta;
  const [issue] = archiveShapeIssuesOf(meta);
  if (issue !== undefined) throw new Error(issue.message);
  validateArchiveCandidateRelations(meta);
  return meta;
};
