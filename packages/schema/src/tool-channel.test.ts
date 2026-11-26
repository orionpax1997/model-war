/**
 * `tool-channel.ts` 收敛到只剩 `EVALUATE_CALL_LIMIT` 之后仍要守住的两条判据。
 *
 * ── 守的是**依赖方向**,不是取值 ──
 *
 * 反过来写过一版(`EVALUATE_CALL_LIMIT = OPTIMIZATION_CANDIDATE_LIMIT`),后果是档案形状一旦
 * 放宽候选数,harness 配额与 `harnessDigest` 就跟着断代——正是 把档案形状排除出清单
 * 要防的耦合。这种翻转在任何取值断言里都看不出来,所以判据只能看那条 import 边。
 *
 * ── 序列化与七条转义的用例整套删掉了(票 03) ──
 *
 * 那些用例钉的是「沙箱里的 `bash` 按分隔串切字段」这条手写协议:键序、转义表、`stderr` 居末。
 * 通道与它的三个薄壳副本已删除,`ToolOutcome` 是一个宿主内的对象,没有字节形态可钉。搬走它们
 * 不是「少测了」,是判据的对象不存在了。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { OPTIMIZATION_CANDIDATE_LIMIT } from "./archive-meta.js";
import { EVALUATE_CALL_LIMIT } from "./tool-channel.js";

it("`EVALUATE_CALL_LIMIT` 是那个数,而档案侧的上限从它派生(不是反过来)", () => {
  // 取值本身也值得钉一次:它进 harness 身份清单,改它是换 harness,不是调参。
  expect(EVALUATE_CALL_LIMIT).toBe(3);
  expect(OPTIMIZATION_CANDIDATE_LIMIT).toBe(EVALUATE_CALL_LIMIT);
});

it("`tool-channel.ts` 不 import 档案形状,`archive-meta.ts` 单向取它", () => {
  const read = (name: string): string =>
    readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
  const channel = read("./tool-channel.ts");
  const archiveMeta = read("./archive-meta.ts");
  expect(channel, "harness 侧的配额真源又开始依赖档案形状了").not.toContain(
    'from "./archive-meta.js"',
  );
  expect(archiveMeta, "档案形状没有从 harness 侧取配额").toContain(
    'import { EVALUATE_CALL_LIMIT } from "./tool-channel.js"',
  );
});
