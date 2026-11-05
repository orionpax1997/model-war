// 分片:packages/gen —— I/O(不含 pipeline.ts)。
//
// 与 `gen-core` 互补。`pipeline.ts` 单独在 `stryker/gen-pipeline.mjs`:
// `pipeline.test.ts` 单文件 112s(91 个用例),它 import 了 validate / compile / archive /
// config / contract / generation-policy / prompt,于是本片每个变异体都被它判成「相关」。
// 实测:把 validate.ts(71 个变异体)放进本片是 **17.0s/个**;
// 把 pipeline.test.ts 摘出去之后本片才付得起。
//
// 取反表达互补,避免与 `gen-core` 的 scope 之间漏出缝。
// `dependency-boundary.test.ts` 不进测试集:spawn depcruise 巡航全仓 dist 图。
//
// @ts-check
import { fragment } from "./base.mjs";

export default fragment({
  name: "gen-io",
  mutate: [
    "packages/gen/src/**/*.ts",
    "!packages/gen/src/**/*.test.ts",
    "!packages/gen/src/**/*.prop.ts",
    "!packages/gen/src/**/*.fixture.ts",
    "!packages/gen/src/**/*.d.ts",
    // ── pipeline.ts 单独成片(见 stryker/gen-pipeline.mjs)──
    "!packages/gen/src/pipeline.ts",
    // ── 以下归 gen-core,两边不要同时改 ──
    "!packages/gen/src/config.ts",
    "!packages/gen/src/contract.ts",
    "!packages/gen/src/extract.ts",
    "!packages/gen/src/generation-evidence.ts",
    "!packages/gen/src/generation-policy.ts",
    "!packages/gen/src/index.ts",
    "!packages/gen/src/observations.ts",
    "!packages/gen/src/prompt.ts",
    "!packages/gen/src/protocol-schema.ts",
    "!packages/gen/src/retry.ts",
    "!packages/gen/src/selection.ts",
    "!packages/gen/src/stub-client.ts",
    "!packages/gen/src/terminal-summary.ts",
    "!packages/gen/src/transport-error.ts",
    "!packages/gen/src/trial-grid.ts",
    "!packages/gen/src/trial-reuse.ts",
    "!packages/gen/src/yaml-lite.ts",
  ],
  testFiles: [
    "packages/gen/src/run.test.ts",
    "packages/gen/src/failure.test.ts",
    "packages/gen/src/compile.test.ts",
    "packages/gen/src/stub-client.test.ts",
    "packages/gen/src/trial.test.ts",
    "packages/gen/src/trial-grid.test.ts",
    "packages/gen/src/http/client.test.ts",
    "packages/gen/src/http/endpoints.test.ts",
  ],
});
