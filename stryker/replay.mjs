// 分片:packages/replay —— 回放行解析与渲染。体积最小的包(493 行),适合当分片模板与耗时标定样本。
//
// `state-hash.prop.ts` 一并进 dry-run 集:fast-check 属性测试对 parse/render 的往返律是
// 最便宜的 mutant 杀手,漏掉它等于丢掉本分片一半的杀伤力。
// `.prop.ts` 必须显式写进 testFiles —— Stryker 把 testFiles 当作 dry-run 的测试文件白名单,
// 不匹配的 project(这里是 `property`)不会自己补进来。
//
// @ts-check
import { fragment } from "./base.mjs";

export default fragment({
  name: "replay",
  mutate: [
    "packages/replay/src/**/*.ts",
    "!packages/replay/src/**/*.test.ts",
    "!packages/replay/src/**/*.d.ts",
  ],
  testFiles: [
    "packages/replay/src/**/*.test.ts",
    "packages/replay/src/**/*.prop.ts",
  ],
});
