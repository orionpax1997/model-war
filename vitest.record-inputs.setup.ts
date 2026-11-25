/**
 * 把观测器装进**测试进程**,并给它的记录贴「这段 I/O 属于哪个测试文件」的标签(ADR-0038)。
 *
 * 为什么住在仓库根、不放在 `packages/tools/src` 下:它 import `vitest`,而那个包不是 tools 的
 * 运行期依赖——住在 `src/` 下就会让「声明即依赖」门禁红。根目录的 setup 文件不入任何一个包的
 * 依赖面(`vitest.kernel-guard.setup.ts` 同理),这条判据对它们不适用。
 *
 * 为什么由 setup 文件装、而不是 `NODE_OPTIONS=--import`:vitest 给 worker 的 env 里会剔掉
 * `NODE_OPTIONS`(它自己要用),所以 `--import` 只落到主进程。实测过一次:标签写进了 worker
 * 的 env,`fs` 的补丁却在别的 pid 上,两边对不上,一条记录都没落下来。setup 文件在测试进程
 * 里执行,由它调用 `installRecorder()` 就没有这个错位。
 *
 * ── 两级标签,先是**文件**,再是**用例** ──
 *
 * 1. **模块作用域**贴文件级。这一行必须在**测试模块被 import 之前**执行,而 setup 文件的
 *    模块作用域正好是那个时刻:`expect.getState().testPath` 到这里已经有值(实测,vitest 5)。
 *    为什么非要在这么早:模块**加载期**的读盘(顶层 `readFileSync("rulesets/v1.json")`、
 *    顶层读夹具)发生在任何 hook 之前。旧写法把文件级标签贴在 `beforeAll` 里,于是那段读盘
 *    发生时标签还是空的,`record()` 直接丢掉——`packages/engine/src/sandbox.test.ts` 与
 *    `packages/engine/src/runner/quickjs.test.ts` 在模块顶层读 `rulesets/v1.json` 与
 *    `fixtures/guest/*.js`,而观测 map 里**根本没有这两个文件**。少记 = 少跑 = 绿,所以这条
 *    不是精益求精,是修一个静默失效。
 * 2. `beforeEach` 再细化到**用例级**。聚合按 `::` 前半段归并;细的那部分留着,是因为事后想
 *    拆就拆不出来了。
 *
 * 标签只覆盖"哪个测试文件"这一档,不覆盖"哪些框架 I/O 该被记":后者归 `recorder.ts`
 * (它只认仓库内的路径,且在没有标签时丢弃——框架自己的配置读盘没有归属)。
 */

import { beforeEach, expect } from "vitest";
import { installRecorder } from "./packages/tools/src/scope/recorder.ts";

/** 只有录制时才动手:平时的运行不该多一次环境变量写入。 */
const recording = process.env["MODELWAR_TEST_INPUTS_FILE"] !== undefined;

if (recording) {
  // 文件级标签。位置是判据的一部分:**必须在测试模块 import 之前**(见头注第 1 条)。
  // 这也是唯一能覆盖「模块加载期读盘」的位置——`beforeAll` 太晚,`beforeEach` 更晚。
  process.env["MODELWAR_TEST_ID"] = expect.getState().testPath ?? "";
  installRecorder();
}

beforeEach(() => {
  if (!recording) return;
  const state = expect.getState();
  process.env["MODELWAR_TEST_ID"] = `${state.testPath ?? ""}::${state.currentTestName ?? ""}`;
});
