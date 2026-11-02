/**
 * v2 选拔的真实执行与完整证据校验：**同一张网格的独立子进程全量复算**。
 *
 * ── 为什么「重跑一遍」不是白费力气 ──
 *
 * 确定性引擎里，同一脚本 + 同一计划 + 同一运行时必然产出同一组数字——所以能独立的是**执行**
 * （换一个进程、从头再跑），不能独立的是**测量**：选拔不产生新的判别依据，排序直接用生成阶段
 * 那张网格的分数。复算的作用只有一个：证明「这条链没被换过」。于是比对必须是**逐场逐字**的：
 * 每场的观测行与生成阶段的那一行相同、分数三元组逐位相同。只比总分不够——总分相同但某一场
 * 不同，同样说明这份存档不再能声称「这 32 场是它跑出来的」。
 *
 * ── 计划同源是硬判据 ──
 *
 * 选拔用的计划必须与生成阶段那张网格**逐字相同**（`planSha256` 相等），而计划可读盘的事实
 * （规则集 / 两张图 / 四份陪练脚本字节 + 运行时）在这里**重新装载一遍**：换图、换座位、换种子、
 * 换一份陪练摘要，都会在 `trialPlanMismatch` 里被指到具体位置。不符即整次生成失败，不回喂、
 * 不降级、不换一份计划重跑。
 *
 * ── 复用只省「跑」，不省「查」 ──
 *
 * 三份候选里编译产物字节完全相同的，不重跑（同一计划 + 同一字节 + 同一运行时，跑出来必须
 * 逐场相同）。但**每个阶段的那份证据都必须被验证**：本阶段自己的观测文件与 `.grid.json` 要
 * 逐场、逐位等于来源那一份，才允许把来源的复算结果记到本阶段名下（`reusedFromStage` 落档）。
 *
 * ── 两种模式 ──
 *
 * - 默认（执行）：装载 → 建计划 → 复算 → 逐场比对 → 定版。
 * - `--validate`：不重跑，只把记录与盘上证据对一遍（形状、计划能否重建、逐场摘要、分数、
 *   决胜）。即使 gen 的 probe 是注入的，这一遍也必须由真实 CLI 跑——`probe` 不能自证。
 */

import { readFileSync } from "node:fs";

import {
  TRIAL_GRID_SUMMARY_VERSION,
  type ArchiveGridSelection,
  type JsonValue,
  type SelectionCandidateIdentity,
  type TrialGridScore,
  type TrialObservationLine,
  type TrialPlan,
} from "@model-war/schema";
import {
  buildArchiveGridSelection,
  buildTrialPlan,
  checkTrialPlan,
  compareSelectionGridRecompute,
  same,
  scoreTrialGrid,
  selectionGridMatchEvidence,
  trialGridMatchesOf,
  trialPlanMismatch,
  validateGridSelection,
  verifyGridSelectionEvidence,
  type SelectionGridCandidateEvidence,
} from "@model-war/runner";

import { gridSummaryPathOf, runTrialGrid } from "../trial/grid.js";
import { loadTrialGrid, loadTrialGridInputs, trialPlanFactsOf } from "../trial/load.js";
import { trialObservationLines } from "../trial/observations.js";
import { readSelectionCandidateFiles, type SelectionCandidateFiles } from "./selection.js";

/** 候选身份 + 四条盘上路径：两条产物、生成阶段的观测与它旁挂的网格汇总。 */
export type GridSelectionArtifact = SelectionCandidateFiles & {
  /** 生成阶段该阶段的观测文件（逐场逐字比对的基准）。 */
  readonly observationsPath: string;
  /** 同目录旁挂的网格汇总（`<观测文件>.grid.json`）：分数与计划的来源。 */
  readonly gridSummaryPath: string;
};

/**
 * 复算的执行缝：生产走真引擎（`runTrialGrid`），测试注入同形状的纯数据。
 *
 * 注入的是**执行**，不是判据：比对、计分、定版全在 `@model-war/runner` 的纯函数里，
 * 谁跑出来的读数都一样要过那几关。
 */
export type GridRunner = (options: {
  readonly root: string;
  readonly model: string;
  readonly scriptPath: string;
  readonly plan: TrialPlan;
}) => Promise<readonly TrialObservationLine[]>;

/** 执行与校验共用的一组可注入点（只给测试用；生产路径用默认值）。 */
export type GridSelectionDeps = {
  /** 由安装面重建的计划（缺省 = `planForGridSelection(root, model)`，读盘算摘要）。 */
  readonly plan?: TrialPlan;
  readonly runGrid?: GridRunner;
};

const realRunner: GridRunner = async ({ root, model, scriptPath, plan }) =>
  (await runTrialGrid(loadTrialGrid(root, model, scriptPath), plan)).readings;

/** 由安装面（root + 模型）重建生成阶段那张网格计划；与试跑入口 `--plan` 同一套读盘。 */
export const planForGridSelection = (root: string, model: string): TrialPlan => {
  const plan = buildTrialPlan(trialPlanFactsOf(loadTrialGridInputs(root, model)));
  checkTrialPlan(plan);
  return plan;
};

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("选拔输入形状不合法");
  return value as Record<string, unknown>;
};

const pathOf = (item: Record<string, unknown>, key: string): string => {
  const value = item[key];
  if (typeof value !== "string" || value.length === 0) throw new Error("选拔候选证据路径缺失");
  return value;
};

/**
 * 读候选清单：身份与产物字节（与 v1 同一份判据）+ 生成阶段的两条证据路径。
 *
 * 字节仍现算摘要并比对：复算认编译产物，路径本身不构成身份。
 */
export const readGridSelectionArtifacts = (value: unknown): readonly GridSelectionArtifact[] => {
  const files = readSelectionCandidateFiles(value);
  if (!Array.isArray(value)) throw new Error("选拔缺少三个有效候选");
  return files.map((file, index) => {
    const item = object(value[index]);
    return {
      ...file,
      observationsPath: pathOf(item, "observationsPath"),
      gridSummaryPath: pathOf(item, "gridSummaryPath"),
    };
  });
};

/** 归档里那份证据路径与旁挂汇总的约定（`<观测文件>.grid.json`）落在同一处。 */
const summaryPathOf = (artifact: GridSelectionArtifact): string =>
  artifact.gridSummaryPath === gridSummaryPathOf(artifact.observationsPath)
    ? artifact.gridSummaryPath
    : throwEvidence("网格汇总路径与观测文件的后缀约定不一致");

function throwEvidence(reason: string): never {
  throw new Error(`选拔网格证据不合法：${reason}`);
}

/** 观测文件 → 逐行（解析后的 JSON 值）。空文件与坏行都拒：没有观测就没有证据。 */
const observationRowsOf = (path: string): readonly JsonValue[] => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throwEvidence(`生成阶段的观测文件读不到：${path}`);
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) throwEvidence(`生成阶段的观测文件是空的：${path}`);
  return lines.map((line) => {
    try {
      return JSON.parse(line) as JsonValue;
    } catch {
      throwEvidence(`生成阶段的观测文件不是合法 JSONL：${path}`);
    }
  });
};

/**
 * 生成阶段的网格汇总 → 它的分数（并核对它说的就是这张网格、这份候选）。
 *
 * 生成侧不重算分数，选拔侧也不重算「生成阶段应该得多少分」：这一份分数就是排序依据，
 * 复算只负责证明它与重跑结果逐位相同。
 */
const gridScoreOf = (options: {
  readonly artifact: GridSelectionArtifact;
  readonly plan: TrialPlan;
}): TrialGridScore => {
  const { artifact, plan } = options;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(summaryPathOf(artifact), "utf8")) as unknown;
  } catch {
    throwEvidence(`生成阶段的网格汇总读不到或不是合法 JSON：${artifact.gridSummaryPath}`);
  }
  const summary = object(parsed);
  if (summary["version"] !== TRIAL_GRID_SUMMARY_VERSION)
    throwEvidence(`网格汇总的版本不是 ${String(TRIAL_GRID_SUMMARY_VERSION)}`);
  if (summary["scriptSha256"] !== artifact.scriptSha256)
    throwEvidence(`网格汇总说的是另一份候选脚本（摘要不符）：${artifact.gridSummaryPath}`);
  const planMismatch = trialPlanMismatch(plan, summary["plan"] as TrialPlan);
  if (planMismatch !== null)
    throwEvidence(
      `网格汇总里的计划与本次选拔计划不同源（换图/换座位/换种子/换陪练）：${planMismatch}`,
    );
  if (!same(summary["matches"] as JsonValue, trialGridMatchesOf(plan) as unknown as JsonValue))
    throwEvidence("网格汇总的逐场身份与计划不一致");
  return summary["score"] as TrialGridScore;
};

const identityOf = ({
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

/**
 * 计划同源：安装面重建的那一份必须与生成阶段给的计划**逐字相同**（`planSha256` 相等，
 * 换图 / 换座位 / 换种子 / 换一份陪练摘要都会被指到具体路径）。
 *
 * 先比再校验顺序是有意的：先比能报出「你改的是哪一栏」，而「计划能否由事实重建」由随后的
 * `buildArchiveGridSelection`（内部 `checkTrialPlan`）兜底。
 */
const planOf = (options: {
  readonly root: string;
  readonly model: string;
  readonly expectedPlan: unknown;
  readonly deps?: GridSelectionDeps | undefined;
}): TrialPlan => {
  const actual = options.deps?.plan ?? planForGridSelection(options.root, options.model);
  const mismatch = trialPlanMismatch(actual, options.expectedPlan as TrialPlan);
  if (mismatch !== null) throw new Error(`选拔计划与生成阶段的网格不同源：${mismatch}`);
  return actual;
};

/**
 * 真实执行：三份候选按生成阶段那张网格复算，逐场逐字比对后定版。
 *
 * 任一候选的复算与生成阶段不一致即抛（整次生成失败，`classification: "selection"`）；
 * 不产出部分胜者，也不把「差一场」当成噪声。
 */
export const executeGridSelection = async (options: {
  readonly root: string;
  readonly model: string;
  readonly candidates: unknown;
  readonly expectedPlan: unknown;
  readonly deps?: GridSelectionDeps | undefined;
}): Promise<ArchiveGridSelection> => {
  const artifacts = readGridSelectionArtifacts(options.candidates);
  const plan = planOf(options);
  const runGrid = options.deps?.runGrid ?? realRunner;
  const evidence: SelectionGridCandidateEvidence[] = [];
  for (const artifact of artifacts) {
    const rows = observationRowsOf(artifact.observationsPath);
    const score = gridScoreOf({ artifact, plan });
    const prior = evidence.find((candidate) => candidate.scriptSha256 === artifact.scriptSha256);
    if (prior !== undefined) {
      // 复用：不重跑，但本阶段自己的那份证据必须与来源逐场、逐位相同。
      verifyGridSelectionEvidence({
        plan,
        candidate: {
          ...identityOf(artifact),
          score: prior.score,
          matches: prior.matches,
        },
        rows,
        score,
      });
      evidence.push({
        ...identityOf(artifact),
        score: prior.score,
        matches: prior.matches,
        reusedFromStage: prior.stage,
      });
      continue;
    }
    const readings = await runGrid({
      root: options.root,
      model: options.model,
      scriptPath: artifact.scriptPath,
      plan,
    });
    compareSelectionGridRecompute({
      plan,
      generated: rows,
      // 复算读数经**同一个**渲染器转成观测行再比：比的是「这一场是不是同一场」，
      // 不是两份内存对象的形状。
      recomputed: trialObservationLines(readings).map((line) => JSON.parse(line) as JsonValue),
      generatedScore: score,
      recomputedScore: scoreTrialGrid(plan, readings),
    });
    evidence.push({
      ...identityOf(artifact),
      score,
      matches: selectionGridMatchEvidence({
        plan,
        scriptSha256: artifact.scriptSha256,
        rows,
        score,
      }),
    });
  }
  return validatePreparedGridSelection({
    candidates: options.candidates,
    expectedPlan: options.expectedPlan,
    selection: buildArchiveGridSelection(plan, evidence),
  });
};

/**
 * 完整证据校验（`--validate`）：不重跑，只把记录与盘上证据对一遍。
 *
 * 判据依次是：记录形状与自洽（`validateGridSelection`）→ 计划与本次生成阶段的计划同源
 * （`trialPlanMismatch` 指到具体路径）→ 候选身份与产物字节一致 → 每个候选的逐场摘要与分数
 * 都能从它自己的观测文件与网格汇总里重新算出来。最后一条正是「probe 不能自证」的落点：
 * 注入的 probe 伪造任何一场，都会在这里对不上盘上的字节。
 */
export const validatePreparedGridSelection = (options: {
  readonly candidates: unknown;
  readonly expectedPlan: unknown;
  readonly selection: unknown;
}): ArchiveGridSelection => {
  const artifacts = readGridSelectionArtifacts(options.candidates);
  const record = options.selection;
  const plan =
    typeof record === "object" && record !== null ? Reflect.get(record, "plan") : undefined;
  const mismatch = trialPlanMismatch(options.expectedPlan as TrialPlan, plan as TrialPlan);
  if (mismatch !== null) throw new Error(`选拔计划与生成阶段的网格不同源：${mismatch}`);
  const selection = validateGridSelection(record);
  if (!same(selection.candidates.map(identityOf), artifacts.map(identityOf)))
    throw new Error("选拔结果候选或环境身份不一致");
  selection.candidates.forEach((candidate, index) => {
    const artifact = artifacts[index]!;
    verifyGridSelectionEvidence({
      plan: selection.plan,
      candidate,
      rows: observationRowsOf(artifact.observationsPath),
      score: gridScoreOf({ artifact, plan: selection.plan }),
    });
  });
  return selection;
};
