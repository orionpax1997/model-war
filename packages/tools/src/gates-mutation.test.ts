/**
 * 变异棘轮的**真跑**那一半:跑完 `mutate:replay` 之后,`stryker/baseline/replay.json` 的字节不变。
 *
 * ticket 08 的字面要求是「跑完**变异入口**后基线文件字节不变」。这件事有两半,分在两个文件里:
 *
 * - **入口的后半段**(棘轮门禁)跑遍全部分片、喂夹具报告——不跑真实变异,零成本,留在
 *   `gates.test.ts`(`test:gates`);
 * - **入口的全部**(`stryker run` + 棘轮门禁)真跑最小的 `replay` 分片——就是这一条。
 *
 * 只有前半段会留一道缝:`stryker run` 那一半到底会不会碰基线,没人验。这一条把缝堵上。
 *
 * ── 为什么它单独一个 project ──
 *
 * 它是 `test:gates` 里最贵的一条(本机约 50s:338 个变异体),而改 `packages/tools` 任何文件
 * 都会整族跑门禁自测——于是每条门禁自测平均要多付这 50s,换来的信息只在 `stryker/**` 或
 * 变异入口自己变了的时候才更新。所以它有了自己的 project(`mutation`)与自己的脚本
 * (`test:mutation`),由 `change-radius.ts` 的半径指名:改 `stryker/**` 或
 * `packages/tools/src/mutation/**` 才会选中它。
 *
 * 这不是把它降级成"按需想起来就跑":`stryker/**` 的半径、nightly 的 `test:mutation` 腿、
 * 以及 `test-layers.test.ts` 的池子对账(它带 `GRAPH_BLIND_TESTS`)各自盯着一头。
 *
 * 断言只落在外部可观察量上:命名脚本的退出码、输出里的痕迹、入库文件的字节。
 */

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { repoRoot, script } from "./gates-harness.ts";

const BASELINE = "stryker/baseline/replay.json";

it("真实跑一次 mutate:replay 之后,入库基线的字节逐字不变", () => {
  const before = readFileSync(`${repoRoot}${BASELINE}`);

  const mutation = script("mutate:replay");

  // 0 = 不低于基线,1 = 退化(棘轮红了)——两个退出码都说明变异跑完了、比较也跑了。
  // spawn 失败(没有 stryker、进程起不来)会由 `script` 直接抛出,不会落在下面的 allowlist 里。
  // 分数高低不是这条用例的断言对象:那一半由 `gates.test.ts` 的夹具报告负责。
  expect(
    [0, 1],
    `mutate:replay 的退出码不是棘轮的两种判决(0/1):${String(mutation.status)}\n${mutation.output}`,
  ).toContain(mutation.status);
  // 「跑完了」这件事得在输出里有痕迹:没有它,一个什么都没跑的命令也能退 0。
  expect(mutation.output, `mutate:replay 没有跑完棘轮比较:\n${mutation.output}`).toContain(
    "变异棘轮 [replay]",
  );

  expect(
    readFileSync(`${repoRoot}${BASELINE}`).equals(before),
    `真实跑完 mutate:replay 之后入库基线被改写了:${BASELINE}`,
  ).toBe(true);
}, 180_000);
