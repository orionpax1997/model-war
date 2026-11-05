// 分片:packages/runner —— 赛程、选人、排名、报表。
//
// 排除 `*.fixture.ts`:它们是被测试直接 import 的样例数据构造器,不是生产代码。
//
// 沙箱安全性:`scheduler.test.ts` 把 `outputDir: runs/fixture` 写进**临时 root**,
// 不碰仓库的 `runs/`;runner 的测试不 spawn 子进程、不开端口、不读环境变量分支。
// 这是全仓最干净的一个分片。
//
// 已知盲区:`apps/cli` 经 `@model-war/runner` 引它,读的是 dist —— 那部分覆盖在本分片里看不见。
//
// @ts-check
import { fragment } from "./base.mjs";

export default fragment({
  name: "runner",
  mutate: [
    "packages/runner/src/**/*.ts",
    "!packages/runner/src/**/*.test.ts",
    "!packages/runner/src/**/*.prop.ts",
    "!packages/runner/src/**/*.fixture.ts",
    "!packages/runner/src/**/*.d.ts",
  ],
  testFiles: [
    "packages/runner/src/**/*.test.ts",
    "packages/runner/src/**/*.prop.ts",
  ],
});
