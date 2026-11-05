// 分片:packages/gen —— pipeline.ts 单文件。
//
// 为什么单独成片:`pipeline.ts`(973 行)是 gen 最重的模块,而它的唯一覆盖源
// `pipeline.test.ts` 单文件 **112s / 91 个用例**。把它和别的 I/O 模块放一片,
// 那 91 个用例会对整片每个变异体都算「相关」——实测 validate.ts(71 个变异体)
// 在那种排布下是 17.0s/个。摘出来之后,这笔钱只由 pipeline.ts 自己的变异体承担。
//
// 也就是说本片是**已知最贵的一片**。它值不值得跑是个单独的判断:
// pipeline.ts 的变异体数 ≈ 全包的五分之一,但耗时 ≈ 全包的七成。
// 如果只想要全仓的观测基线,跑 gen-core + gen-io,本片留到有明确的「管线逻辑不可信」疑问时再跑。
//
// @ts-check
import { fragment } from "./base.mjs";

export default fragment({
  name: "gen-pipeline",
  mutate: ["packages/gen/src/pipeline.ts"],
  testFiles: ["packages/gen/src/pipeline.test.ts"],
});
