/**
 * 验收:入库的 runtime bundle 产物**真的能被真 VM 载入**(票 04)。
 *
 * ── 这条与 `run-runtime-drift-gate.ts` 的分工 ──
 * 门禁判的是**字节**:现打一次 == 入库产物、入库 sha256 == 常量、产物不含模块语法。它不建 VM。
 * 本条判的是**行为**:把入库产物喂进一个真 QuickJS VM,API 面取得到、两个宿主桥已从全局删掉。
 * 两条合起来才答完「产物既没分叉、又能真的跑」。
 *
 * ── 为什么探针把结论编码成一条意图,而不是抛异常 ──
 * `createQuickJsRunner` 的 `drainIntents` 只把 `loop()` 收集的意图交回;`loop()` 抛出的异常在
 * 这条会话面上没有可靠的宿主侧观察点。所以探针把每一项自检映射进 `move` 的实参:通过时交回
 * `unitId=7` 的意图,任一检查失败时交回 `unitId=0`。断言对象是**交回的意图**,与引擎其余
 * 集成测试同口径(只看外部行为,不看内部回调)。
 *
 * 引擎的运行时代码不做磁盘 I/O,但测试可以:这里读入库产物、读 wasm,都是测试自己的账。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, it } from "vitest";
import { SANDBOX_RUNTIME_ARTIFACT_PATH, SANDBOX_RUNTIME_HASH } from "@model-war/replay";

import { createQuickJsRunner } from "../runner/quickjs.js";
import type { Snapshot } from "../world/state.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** 入库的 runtime bundle 产物(相对仓库根的路径真源在 `@model-war/schema`)。 */
const artifactPath = `${repoRoot}${SANDBOX_RUNTIME_ARTIFACT_PATH}`;

/**
 * 自检探针:把「API 面在不在 + 两个桥删没删 + 快照读得到吗」编码成 `move` 的实参。
 *
 * 通过:`move(7, 5, 9)`(7 = 通过标记,5 = 快照 tick)。失败:`move(0, 0, 0)`。
 * `getTick` / `getObjectsByType` / `move` 与 `__*` 桥都按 guest 全局名访问——桥若没删,
 * `typeof` 就不是 `"undefined"`。
 */
const PROBE_SCRIPT = `
function loop() {
  var apiOk =
    typeof getTick === "function" &&
    typeof getObjectsByType === "function" &&
    typeof move === "function";
  var bridgesGone =
    typeof globalThis["__setSnapshot"] === "undefined" &&
    typeof globalThis["__drainIntents"] === "undefined";
  if (!apiOk || !bridgesGone) {
    move(0, 0, 0);
    return;
  }
  move(7, getTick(), 9);
}
`;

/** 最小快照:只要 `tick` 是探针要读的那一栏,其余为空。 */
const SNAPSHOT = {
  tick: 5,
  size: 4,
  terrain: [],
  players: [],
  units: [],
  sites: [],
} as unknown as Snapshot;

let wasmModule: WebAssembly.Module;

beforeAll(async () => {
  wasmModule = await WebAssembly.compile(
    readFileSync(fileURLToPath(import.meta.resolve("quickjs-wasi/quickjs.wasm"))),
  );
});

const handles: (() => void)[] = [];

afterAll(() => {
  for (const dispose of handles.splice(0)) {
    dispose();
  }
});

it("入库产物的 sha256 就是常量(与门禁②同口径,这里再钉一次)", () => {
  const digest = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
  expect(digest).toBe(SANDBOX_RUNTIME_HASH);
});

it("真 VM 载入入库产物:API 面取得到、两个宿主桥已从全局删掉、快照读得到", async () => {
  const runtimeCode = readFileSync(artifactPath, "utf8");
  const handle = await createQuickJsRunner({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: PROBE_SCRIPT,
    seat: 0,
  });
  handles.push(handle.dispose);

  handle.runner.setSnapshot(SNAPSHOT);
  const output = handle.runner.drainIntents();

  // 交回 `unitId=7` 的那条意图 = 探针的每一项自检都通过;否则是 `unitId=0`。
  expect(output.intents).toEqual([{ kind: "move", unitId: 7, dx: 5, dy: 9 }]);
});
