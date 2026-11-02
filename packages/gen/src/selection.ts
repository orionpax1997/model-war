/**
 * 最小选拔端口只传 schema 数据；排序、评分的复算与完整校验经 CLI 子进程。
 *
 * ── 这条缝搬什么 ──
 *
 * v2 的选拔是「同一张网格计划的独立子进程全量复算」。本包只把三样东西交下去：
 * 生成阶段那张计划（`expectedPlan`）、正在被生成的模型（在位陪练随它而定）、以及三份候选的
 * **阶段证据位置**（编译产物、原始 TS、该阶段的观测文件与旁挂的 `.grid.json`）。
 * 分数、复算、逐场比对与定版都在 `apps/cli` 那一侧：本包不自己算分，也不读观测——
 * 那两条边会把执行链并进生成管线的 program（`dependency-boundary` 门禁禁止）。
 *
 * ── 两种模式都由真实 CLI 跑 ──
 *
 * - 默认（执行）：装载 → 建计划 → 三份候选全量复算 → 逐场逐字比对 → 定版。
 * - `--validate`：不重跑，只把记录与盘上证据（观测行 + `.grid.json`）对一遍。
 *
 * **即使 probe 是注入的，`--validate` 也必须由真实 CLI 跑**，而不能靠类型或 probe 自证：
 * 注入的 probe 伪造任何一场，都会在那一遍里与盘上的字节对不上。
 *
 * ── `--plan` 为什么不在这个端口里 ──
 *
 * 生成管线已经用试跑入口的 `--plan` 拿到过同一张网格（事实同源、摘要同源），选拔直接复用它，
 * 少起一个子进程、也少一个「两份计划之间有时间窗」的坑。`--plan` 模式本身仍留在 CLI 入口
 * （`apps/cli/src/selection/run-selection.ts`，带 `--model` 时打印网格计划）。
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type {
  ArchiveGridSelection,
  SelectionCandidateIdentity,
  TrialPlan,
} from "@model-war/schema";

/** 一份候选：阶段身份 + 四条路径（产物 / 源码 / 该阶段观测 / 该阶段网格汇总）。 */
export type SelectionArtifact = SelectionCandidateIdentity & {
  readonly scriptPath: string;
  readonly sourcePath: string;
  /** 生成阶段该阶段的观测文件（复算逐场逐字比对的基准）。 */
  readonly observationsPath: string;
  /** 同目录旁挂的网格汇总（`<观测文件>.grid.json`）：分数与计划的来源。 */
  readonly gridSummaryPath: string;
};
export type SelectionProbe = (options: {
  readonly root: string;
  /** 正在被生成的模型 slug（在位陪练 = 它自己最近一次冻结存档）。 */
  readonly model: string;
  readonly candidates: readonly SelectionArtifact[];
  expectedPlan: TrialPlan;
}) => unknown | Promise<unknown>;

const ENTRY = join("apps", "cli", "dist", "selection", "run-selection.js");

const invoke = (root: string, mode: readonly string[], input?: unknown): unknown => {
  const ran = spawnSync(process.execPath, [join(root, ENTRY), "--root", root, ...mode], {
    encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (ran.error !== undefined || ran.status !== 0) throw new Error("选拔执行或完整证据校验失败");
  try {
    return JSON.parse(ran.stdout) as unknown;
  } catch {
    throw new Error("选拔协议输出不完整");
  }
};

export const runSelection: SelectionProbe = (options) => invoke(options.root, [], options);

/** 即使 probe 是注入的，也必须由真实 CLI 完整复算，而不能靠类型或 probe 自证。 */
export const verifySelection = (options: {
  readonly root: string;
  readonly candidates: readonly SelectionArtifact[];
  readonly expectedPlan: TrialPlan;
  readonly selection: unknown;
}): ArchiveGridSelection =>
  invoke(options.root, ["--validate"], {
    candidates: options.candidates,
    expectedPlan: options.expectedPlan,
    selection: options.selection,
  }) as ArchiveGridSelection;
