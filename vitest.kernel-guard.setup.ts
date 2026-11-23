/**
 * 常跑链(unit / property)的**内核探针**:把 `bwrap` 换成一个会拒绝的执行体。
 *
 * ── 这条判据要钉的是什么 ──
 *
 * 「常跑链上没有任何用例会执行真 preflight / 真 bwrap」——它不是一句纪律,而是一条**环境事实**:
 * `fast.yml` 不装 bubblewrap,本机装了。所以「本机能跑绿的线上会红」这件事只有在没装 bwrap 的
 * 机器上才显形,而那种红与「提交内容有问题」是同一条红(两种处方混成一种,`verify:kernel` 拆
 * 出去的理由正是这个)。反过来,本机装了 bwrap 时,一条忘了注入替身的用例会**安静地**跑真沙箱
 * ——它绿得刚好把问题盖住。
 *
 * 这里把那个「本机装没装」的自由度去掉:快链上 `PATH` 里的 `bwrap` 永远是这个探针,于是
 *
 * - 忘了注入替身的用例在**任何机器上**都红,而且红得指名(探针的 stderr 会经由
 *   `preflightFailureMessage` / `runStep` 的报错原样带出来);
 * - 装上替身(`packages/gen/src/agent/sandbox.fixture.ts` 换掉 `sandbox.run` / `preflight`)的
 *   用例不受影响——它们根本不到 `PATH` 这一层。
 *
 * ── 为什么用 PATH 而不是打补丁 `sandbox` 对象 ──
 *
 * 同一个包有两个模块实例:`packages/gen` 自己的测试 import `src/`,而 `apps/cli` 的测试 import
 * `@model-war/gen`(`dist/`)。给其中任何一个打补丁都盖不住另一个,而且那种补丁得先能拿到那个
 * 对象——生产 barrel 不导出它(那是对的)。`spawn("bwrap")` 走 PATH,两个实例都绕不过去。
 *
 * ── 判据自己有人看着 ──
 *
 * `packages/tools/src/vitest/kernel-guard.test.ts` 断言:快链上 `bwrap` 解析到的确实是这个探针
 * (`MW_KERNEL_GUARD_DIR` 就是它所在的目录)。接线被删掉时那条用例当场红——不靠这里的注释。
 *
 * 目录固定而不 mkdtemp:每个测试文件都会跑一遍本文件,按文件造目录会在 /tmp 里留一地;内容重写
 * 是幂等的,下一轮覆盖即可。
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 探针目录的环境变量:判据从这里取「快链上的 bwrap 应该解析到哪儿」。 */
export const KERNEL_GUARD_ENV = "MW_KERNEL_GUARD_DIR";

/**
 * 探针拒绝时的那句话。它会经由 preflight / 执行器原样带进测试失败信息里。
 *
 * 刻意写成**一行字面量**:判据(`kernel-guard.test.ts`)拿它跟自己被 spawn 出来的 stderr 逐字比对,
 * 拆成几段拼接就会让那条比对失效。
 */
export const KERNEL_GUARD_MESSAGE =
  "kernel-guard:常跑链(unit / property)上不许起真 bwrap——要跑沙箱的用例必须换上替身(packages/gen/src/agent/sandbox.fixture.ts 的 withHostBash / withRealBash),真隔离由 `pnpm run verify:kernel` 验。";

const guardDir = join(tmpdir(), "model-war-kernel-guard");
const guardBinary = join(guardDir, "bwrap");

mkdirSync(guardDir, { recursive: true });
// `sh` 而不是 node:`spawn("bwrap")` 就走 PATH 解析,脚本越薄越好,出错信息也越直。
writeFileSync(guardBinary, `#!/bin/sh\necho '${KERNEL_GUARD_MESSAGE}' >&2\nexit 1\n`, "utf8");
chmodSync(guardBinary, 0o755);

process.env[KERNEL_GUARD_ENV] = guardDir;
// 前置而不是追加:即使宿主装了真 bwrap,PATH 解析先命中这里。
process.env.PATH = `${guardDir}:${process.env.PATH ?? ""}`;
