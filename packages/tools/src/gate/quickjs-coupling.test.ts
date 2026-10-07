import { QUICKJS_WASI_VERSION } from "@model-war/schema";
import { expect, it } from "vitest";

import { PROBED_QUICKJS_WASI_VERSION } from "../sandbox-probes/constants.ts";
import { findQuickjsMisalignments } from "./run-quickjs-coupling-gate.ts";

/**
 * `quickjs-wasi` 版本耦合断言的自测:配套时为无 findings,三个反例各自能弄红。
 *
 * 断言对象是导出的**纯函数**,不是脚本的退出码——同一判据另有 `gates.test.ts` 从退出码那头看。
 * 反例不碰 `package.json`:它们把假版本号当**形式参数**传进去(与 `toolchain-coupling.ts` 同形)。
 */

it("quickjs-wasi 版本耦合:三者一致时为无 findings", () => {
  expect(findQuickjsMisalignments("3.6.2", "3.6.2", "3.6.2")).toEqual([]);
});

it("quickjs-wasi 版本耦合:根钉版与冻结常量错位即有 findings（反例）", () => {
  const found = findQuickjsMisalignments("3.7.0", "3.6.2", null);
  const checks = found.map((finding) => finding.check);
  expect(checks).toContain("根依赖与冻结常量一致");
  // 报错信息必须告诉人该跑什么、该写回哪一节——否则这条断言红起来只是个谜。
  const detail = found.find((finding) => finding.check === "根依赖与冻结常量一致")?.detail ?? "";
  expect(detail).toContain("pnpm run probes:sandbox");
  expect(detail).toContain("docs/hld.md §5.0");
});

it("quickjs-wasi 版本耦合:范围锁版即有 findings（反例）", () => {
  expect(findQuickjsMisalignments("^3.6.2", "3.6.2", null).map((f) => f.check)).toContain(
    "精确锁版",
  );
});

it("quickjs-wasi 版本耦合:安装与 manifest 不一致即有 findings（反例）", () => {
  expect(findQuickjsMisalignments("3.6.2", "3.6.2", "3.6.1").map((f) => f.check)).toContain(
    "安装与 manifest 一致",
  );
});

it("冻结常量与真源包的 quickjs-wasi 版本同步（两处版本真源不得漂移）", () => {
  expect(PROBED_QUICKJS_WASI_VERSION).toBe(QUICKJS_WASI_VERSION);
});
