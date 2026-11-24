/**
 * 靶子自己的判据。
 *
 * 它被 `all` / `unit` 两个池子拾取(`packages/tools` 下的 `.test.ts` 都在拾取范围里),所以
 * 它**必须真的能跑**,而且要跑得与机器无关——真探针拿它当靶子(`../related-probe.test.ts`),
 * 它一旦受环境影响,那边就重新变成「测机器」而不是「测探针」。
 */

import { describe, expect, it } from "vitest";
import { probeTarget } from "./probe-target.ts";

describe("真探针的靶子", () => {
  it("是纯函数:同样的输入永远给同样的输出", () => {
    expect(probeTarget(2)).toBe(4);
    expect(probeTarget(0)).toBe(0);
  });
});
