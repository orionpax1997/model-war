/**
 * gen 的私有子进程协议：`--plan` 造计划，默认执行，`--validate` 完整复算。
 *
 * ── 两版按 `expectedPlan` / `--model` 分派 ──
 *
 * - **v2（评测网格）**：`--plan --model` 打印生成阶段那张 `TrialPlan`（32 场网格）；执行与
 *   `--validate` 走 `grid-selection.ts`（计划同源、全量复算、逐场逐字比对）。
 * - **v1（历史口径，12 场 / 三基准）**：`--plan` 不带 `--model` 时仍打印 12 场计划；执行与
 *   `--validate` 走 `selection.ts` 的冻结路径。历史档不迁移，所以这条路必须继续可用。
 *
 * 分派判据是**数据**而不是开关：`--plan` 看有没有 `--model`（v2 的在位陪练随模型而定），
 * 执行与校验看 `expectedPlan` 是不是网格计划（有 `scripts` / `maps`）。
 *
 * ── 退出码与 stderr 是私有协议 ──
 *
 * 0 + stdout JSON 是成功；任何异常 → stderr 固定一行 + 退出码 2（不泄露路径与外部输入）。
 * gen 见 2 即整次生成失败（`classification: "selection"`），不把失败当成「候选不合格」。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TRIAL_BENCHMARK_IDS } from "@model-war/schema";
import { loadTrial } from "../trial/load.js";
import {
  executeGridSelection,
  planForGridSelection,
  validatePreparedGridSelection,
} from "./grid-selection.js";
import { executeSelection, planForSelection, validatePreparedSelection } from "./selection.js";

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("协议形状错误");
  return value as Record<string, unknown>;
};

/** 网格计划有 `scripts` 与 `maps`（v1 的选拔计划有 `seeds` / `baselines`）。 */
const isGridPlan = (value: unknown): boolean =>
  value !== null && typeof value === "object" && Object.hasOwn(value, "scripts");

try {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  if (rootIndex < 0 || args[rootIndex + 1] === undefined) throw new Error("缺 root");
  const root = resolve(args[rootIndex + 1]!);
  const modelIndex = args.indexOf("--model");
  const model = modelIndex < 0 ? undefined : args[modelIndex + 1];
  let output: unknown;
  if (args.includes("--plan")) {
    output =
      model === undefined
        ? planForSelection(
            loadTrial(root, join(root, "benchmarks", TRIAL_BENCHMARK_IDS[0], "script.js")),
          )
        : planForGridSelection(root, model);
  } else {
    const input = object(JSON.parse(readFileSync(0, "utf8")) as unknown);
    const candidates = input["candidates"];
    const expectedPlan = input["expectedPlan"];
    if (args.includes("--validate")) {
      const selection = input["selection"];
      output = isGridPlan(expectedPlan)
        ? validatePreparedGridSelection({ candidates, expectedPlan, selection })
        : validatePreparedSelection({ root, candidates, expectedPlan, selection });
    } else if (isGridPlan(expectedPlan)) {
      const generating = input["model"];
      if (typeof generating !== "string" || generating.length === 0)
        throw new Error("网格选拔的执行模式缺 model");
      output = await executeGridSelection({
        root,
        model: generating,
        candidates,
        expectedPlan,
      });
    } else {
      output = await executeSelection({ root, candidates, expectedPlan });
    }
  }
  process.stdout.write(JSON.stringify(output));
} catch {
  // 候选 guest 异常、路径和外部输入永不进入诊断出口。
  process.stderr.write("选拔执行或完整证据校验失败\n");
  process.exitCode = 2;
}
