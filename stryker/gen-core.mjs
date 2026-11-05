// 分片:packages/gen —— 纯函数(快测试集)。
//
// 切这一刀的理由与 engine 那两片相同,但 gen 更极端:干跑 138s 里有 **112s 是单个文件**
// (`pipeline.test.ts`,91 个用例)。而它 import 了 config / contract / generation-policy /
// prompt / archive / compile —— 于是它对这些模块的每个变异体都算「相关」,
// 把 `retry.ts` 这种 7 个用例的小文件也拖到 5.1s/变异体。
//
// 本片圈纯模块,测试集全部在 0.8s 以下(实测:pipeline 112.3s / run 9.6s / failure 6.7s
// 三个慢文件留给 `gen-io`;其余 0.01~0.73s)。
//
// I/O 侧(pipeline / run / trial / model-client / archive / record / compile / validate /
// http / failure)在 `stryker/gen-io.mjs`。两片互补,不要同时改。
//
// @ts-check
import { fragment } from "./base.mjs";

export default fragment({
  name: "gen-core",
  mutate: [
    "packages/gen/src/**/*.ts",
    "!packages/gen/src/**/*.test.ts",
    "!packages/gen/src/**/*.prop.ts",
    "!packages/gen/src/**/*.fixture.ts",
    "!packages/gen/src/**/*.d.ts",
    // ── I/O 侧,归 gen-io ──
    "!packages/gen/src/pipeline.ts",
    "!packages/gen/src/run.ts",
    "!packages/gen/src/trial.ts",
    "!packages/gen/src/model-client.ts",
    "!packages/gen/src/archive.ts",
    "!packages/gen/src/record.ts",
    "!packages/gen/src/compile.ts",
    "!packages/gen/src/validate.ts",
    "!packages/gen/src/failure.ts",
    "!packages/gen/src/http/**",
  ],
  // 白名单枚举(理由见 stryker/engine.mjs:testFiles 不认 `!`)。
  // 刻意不含 pipeline.test.ts / run.test.ts / failure.test.ts —— 三个慢文件。
  testFiles: [
    "packages/gen/src/config.test.ts",
    "packages/gen/src/extract.test.ts",
    "packages/gen/src/generation-policy.test.ts",
    "packages/gen/src/no-match-result-symbols.test.ts",
    "packages/gen/src/observations.test.ts",
    "packages/gen/src/prompt.test.ts",
    "packages/gen/src/protocol-schema.test.ts",
    "packages/gen/src/retry.test.ts",
    "packages/gen/src/stub-client.test.ts",
    "packages/gen/src/terminal-summary.test.ts",
    "packages/gen/src/trial-grid.test.ts",
    "packages/gen/src/trial.test.ts",
    "packages/gen/src/yaml-lite.test.ts",
  ],
});
