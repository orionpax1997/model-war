/** gen 私有子进程协议：--plan 固定环境，默认执行，--validate 完整复算。 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadTrial } from "../trial/load.js";
import { TRIAL_OPPONENTS } from "../trial/trial.js";
import { executeSelection, planForSelection, validatePreparedSelection } from "./selection.js";

try {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  if (rootIndex < 0 || args[rootIndex + 1] === undefined) throw new Error("缺 root");
  const root = resolve(args[rootIndex + 1]!);
  let output: unknown;
  if (args.includes("--plan")) {
    output = planForSelection(
      loadTrial(root, join(root, "benchmarks", TRIAL_OPPONENTS[0]!, "script.js")),
    );
  } else {
    const input: unknown = JSON.parse(readFileSync(0, "utf8"));
    if (input === null || typeof input !== "object" || Array.isArray(input))
      throw new Error("协议形状错误");
    const candidates: unknown = Reflect.get(input, "candidates");
    const expectedPlan: unknown = Reflect.get(input, "expectedPlan");
    output = args.includes("--validate")
      ? validatePreparedSelection({
          root,
          candidates,
          expectedPlan,
          selection: Reflect.get(input, "selection"),
        })
      : await executeSelection({ root, candidates, expectedPlan });
  }
  process.stdout.write(JSON.stringify(output));
} catch {
  // 候选 guest 异常、路径和外部输入永不进入诊断出口。
  process.stderr.write("选拔执行或完整证据校验失败\n");
  process.exitCode = 2;
}
