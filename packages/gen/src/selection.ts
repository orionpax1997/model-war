/** 最小选拔端口只传 schema 数据；评分与完整校验经 CLI 子进程。 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type {
  ArchiveSelection,
  SelectionCandidateIdentity,
  SelectionPlan,
} from "@model-war/schema";

export type SelectionArtifact = SelectionCandidateIdentity & {
  readonly scriptPath: string;
  readonly sourcePath: string;
};
export type SelectionProbe = (options: {
  readonly root: string;
  readonly candidates: readonly SelectionArtifact[];
  readonly expectedPlan: SelectionPlan;
}) => unknown | Promise<unknown>;
const invoke = (root: string, mode: readonly string[], input?: unknown): unknown => {
  const ran = spawnSync(
    process.execPath,
    [join(root, "apps/cli/dist/selection/run-selection.js"), "--root", root, ...mode],
    {
      encoding: "utf8",
      input: input === undefined ? undefined : JSON.stringify(input),
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (ran.error !== undefined || ran.status !== 0) throw new Error("选拔执行或完整证据校验失败");
  try {
    return JSON.parse(ran.stdout) as unknown;
  } catch {
    throw new Error("选拔协议输出不完整");
  }
};
/** 此返回值只来自受控本地 CLI 的装载校验与计划构造。 */
export const prepareSelection = (root: string): SelectionPlan =>
  invoke(root, ["--plan"]) as SelectionPlan;
export const runSelection: SelectionProbe = (options) => invoke(options.root, [], options);
/** 即使 probe 是注入的，也必须由真实 CLI 完整复算，而不能靠类型或 probe 自证。 */
export const verifySelection = (options: {
  readonly root: string;
  readonly candidates: readonly SelectionArtifact[];
  readonly expectedPlan: SelectionPlan;
  readonly selection: unknown;
}): ArchiveSelection => invoke(options.root, ["--validate"], options) as ArchiveSelection;
