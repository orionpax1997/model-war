// 分片:packages/gen —— 生成管线、提示词、协议、HTTP 客户端。
//
// 排除项与理由:
//   - `*.fixture.ts`:测试 import 的样例构造器,不是生产代码。
//   - dry-run 集排除 `compile.test.ts`:它 spawn esbuild/tsc 现打 bundle,
//     沙箱里的产物是原始构建,既看不见变异也要额外几十秒。
//   - dry-run 集排除 `dependency-boundary.test.ts`:spawn `depcruise` 巡航全仓 dist 图,
//     且与 engine 那份并行时会互踩(见该文件头注 21-29 行)。
//
// 沙箱安全性:唯一的网络访问是 `http/client.test.ts` 与 `apps/cli/src/gen-cli.test.ts`
// 各起一个 `node:http` 监听 `127.0.0.1:0` 的假端点 —— 回环 + 随机端口,并发沙箱互不冲突,
// 不触真网、不需凭证。`client.test.ts:159` 会写 `process.env[TEST_KEY_ENV]` 且不复原,
// 但它独占一个 vitest worker(Stryker 强制 `maxWorkers: 1`),污染不外溢。
//
// @ts-check
import { fragment } from "./base.mjs";

export default fragment({
  name: "gen",
  mutate: [
    "packages/gen/src/**/*.ts",
    "!packages/gen/src/**/*.test.ts",
    "!packages/gen/src/**/*.fixture.ts",
    "!packages/gen/src/**/*.d.ts",
  ],
  // 白名单枚举,不用 `!` 取反:`testFiles` 每个 pattern 独立过 FileMatcher
  // (ProjectReader.resolveTestFiles),不认 `!` 前缀;取反只有 `mutate` 支持。
  testFiles: [
    "packages/gen/src/config.test.ts",
    "packages/gen/src/extract.test.ts",
    "packages/gen/src/failure.test.ts",
    "packages/gen/src/generation-policy.test.ts",
    "packages/gen/src/http/client.test.ts",
    "packages/gen/src/http/endpoints.test.ts",
    "packages/gen/src/no-match-result-symbols.test.ts",
    "packages/gen/src/observations.test.ts",
    "packages/gen/src/pipeline.test.ts",
    "packages/gen/src/prompt.test.ts",
    "packages/gen/src/protocol-schema.test.ts",
    "packages/gen/src/retry.test.ts",
    "packages/gen/src/run.test.ts",
    "packages/gen/src/stub-client.test.ts",
    "packages/gen/src/terminal-summary.test.ts",
    "packages/gen/src/trial-grid.test.ts",
    "packages/gen/src/trial.test.ts",
    "packages/gen/src/yaml-lite.test.ts",
  ],
});
