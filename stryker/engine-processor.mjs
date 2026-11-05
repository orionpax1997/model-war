// 分片:packages/engine 的结算管线子集 —— 旧的默认分片,nightly 的 `pnpm run mutate` 走这条。
//
// 字段与 `stryker/engine.mjs` 相同,只是 mutate 范围窄到 processor。
// 保留它是因为 `reports/mutation/mutation.{json,html}` 的路径被 `.github/workflows/nightly.yml`
// 当作 artifact 收走,换路径要同步改 workflow;等 engine 分片的基线跑出来、artifact 路径迁过去之后,
// 这个文件与 `package.json` 的 `mutate` 脚本一起删。
//
// @ts-check
import { fragment } from "./base.mjs";

export default fragment({
  name: "engine-processor",
  // 范围铁律不变:只跑 engine 结算管线。范围扩大到整个 engine 由 `stryker/engine.mjs` 承担。
  mutate: [
    "packages/engine/src/processor/**/*.ts",
    "!packages/engine/src/processor/**/*.test.ts",
  ],
  // dry-run 只跑这批测试——它们是 processor 变异范围的专属测试。
  testFiles: ["packages/engine/src/processor/**/*.test.ts"],
});
