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
 * 两级标签:
 *
 * - `beforeAll` 贴**文件级**。选中的单位是文件(vitest 的并行单位也是文件),而且 `beforeAll`
 *   里的读盘(夹具造目录、打 bundle)本来就属于这个文件,漏掉它们等于漏掉"这些用例依赖哪些
 *   产物"。
 * - `beforeEach` 再细化到**用例级**。聚合按 `::` 前半段归并;细的那部分留着,是因为事后想
 *   拆就拆不出来了。
 */

import { beforeAll, beforeEach, expect } from "vitest";
import { installRecorder } from "./packages/tools/src/scope/recorder.ts";

/** 只有录制时才动手:平时的运行不该多一次环境变量写入。 */
const recording = process.env["MODELWAR_TEST_INPUTS_FILE"] !== undefined;

if (recording) installRecorder();

beforeAll(() => {
  if (!recording) return;
  process.env["MODELWAR_TEST_ID"] = expect.getState().testPath ?? "";
});

beforeEach(() => {
  if (!recording) return;
  const state = expect.getState();
  process.env["MODELWAR_TEST_ID"] = `${state.testPath ?? ""}::${state.currentTestName ?? ""}`;
});
