/**
 * **测试支持入口**(`@model-war/gen/testing`):只在测试里可达的替身与夹具。
 *
 * ── 为什么它是一个独立入口,而不是生产 barrel 的一条导出 ──
 *
 * 假执行器(`agent/sandbox.fixture.ts`)不是生产 API:它换掉 `sandbox.run` / `sandbox.preflight`,
 * 用途只有一个——让「动作 → 观测 → 候选 → 档案」那条链在**不装 bubblewrap**的常跑链上也能全真,
 * 只有隔离本身是假的。把它摆在 `@model-war/gen` 的生产面上,等于对消费者承诺「这些名字会一直在」,
 * 而它们随时会跟着测试需要改形状;更实际的问题是读代码的人分不清哪个名字是生产入口。
 *
 * ── 为什么不是「各自相对 import」 ──
 *
 * 本包自己的测试确实相对 import(`./agent/sandbox.fixture.js`,同一份模块实例);但
 * `apps/cli` 的两条测试跨包使用它,相对 import 会跨出 `rootDir`、把 gen 的源码拖进 CLI 的
 * program。而让那两个文件各手抄一份替身,正是这一票要拆掉的东西(三份副本里「通道先于执行」
 * 的时序会各自漂)。所以:生产面 `"."`,测试面 `"./testing"`,两边各自分明。
 *
 * ── 这个入口不导出 `TOOL_COMMANDS` ──
 *
 * 它是替身内部的实现细节(哪几个命令要交给通道),`sandbox.fixture.ts` 里已经不 export 了。
 * `run.test.ts` 曾经抄过一份同名同义的副本;现在它直接读同一份 `withHostBash` / `withRealBash`,
 * 那份副本随之消失。
 */

export { withHostBash, withRealBash } from "./agent/sandbox.fixture.js";
