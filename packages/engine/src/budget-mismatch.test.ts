/**
 * 动态失配断言(票 05):**同一组终值预算下**,计数轨的探针必被正确的那条轨截停,而三份基准脚本
 * 必不被截停。它是「终值仍自洽」的常驻守卫——引擎或契约变了而终值没重标,它会红。
 *
 * ── 为什么是双向,以及为什么必须指定轨名 ──
 *
 * 单向断言(只证明探针被截停)在任何阈值下都能满足:把阈值设成 1 当然抓得住,那是一条空断言。
 * 反向的那一半(基准脚本不被截停)才是「贴边但安全」的证明。而「被抓住」**必须指定是哪条轨**:
 * 硬超时会作废整场却看起来像「抓住了」,所以每条「抓住」的断言都落在 `observation.track` 与截停
 * 读数上,并显式断言硬超时(`fault`)缺席。
 *
 * ── 预算怎么来 ──
 *
 * 与组装层同一条判据:逐键读 `RULESET_KEY_CATALOG[键].calibration.state`,只有 `final` 才进预算。
 * 票 05 落定的是计数与异常三键,所以当前 v1 组装出来的预算**只含**这三项;其余五键仍是未定值,
 * 对应的轨不启用(字段缺席即不启用,不是「值为 0 即不启用」)。
 *
 * ── 票 06 的扩展缝 ──
 *
 * 内存腿(判罚线 / 分配上限)在票 06 落定后,在这里追加:①`memoryTickCeiling` 探针必须被内存轨
 * 截停(同样带轨名与读数);②基准脚本的存活堆峰值必须低于判罚线(不被截停)。`runBenchmarkMatch`
 * 已经能带任何 `BudgetConfig` 跑,不为内存腿改装。
 *
 * ── 为什么用真执行器,而不是复用 `createProbeSeat` ──
 *
 * 探针的截停轨由 `runBudgetProbeTick`(内部走 `createQuickJsRunner`)给出,那件事的唯一权威是引擎
 * 自己的判定路径。基准脚本那一侧也用 `createQuickJsRunner`,只在外层包一层记录 `tripped` 观测。
 * 探针阈值全是**有限上限**(不是建议值),所以截停者一定是一条计数轨,而不是墙钟硬超时。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, expect, it } from "vitest";
import {
  QUICKJS_WASI_VERSION,
  RULESET_KEY_CATALOG,
  SANDBOX_RUNTIME_ARTIFACT_PATH,
  SANDBOX_RUNTIME_HASH,
  type MapDefinition,
  type Ruleset,
} from "@model-war/replay";

import type { BudgetConfig } from "./budget.js";
import { runMatch } from "./index.js";
import type { Observation, SeatRunner } from "./runner/index.js";
import {
  EVENT_SPIN_PROBE_SCRIPT,
  apiBombProbeScript,
  runBudgetProbeTick,
} from "./runner/probe-harness.js";
import {
  API_CALL_TRACK,
  EVENT_TRACK,
  INTERRUPT_EVENT_GRANULARITY,
  WASI_CLOCK_MS,
  WASI_RANDOM_FILL,
  WASI_TIMEZONE_OFFSET_MINUTES,
  createQuickJsRunner,
} from "./runner/quickjs.js";
import type { GameState, PlayerIndex } from "./world/state.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const wasmPath = fileURLToPath(import.meta.resolve("quickjs-wasi/quickjs.wasm"));
/** 被测运行时字节 = **入库产物**(不是现打的 bundle),这样对局走的就是契约承诺的那份字节。 */
const artifactPath = `${root}${SANDBOX_RUNTIME_ARTIFACT_PATH}`;

const RULESET = JSON.parse(readFileSync(`${root}rulesets/v1.json`, "utf8")) as Ruleset;
const SEED = 20260101;

/** meta 行的执行器读数:真哈希 + 三件套(与 `probe-harness.test.ts` / `sandbox.test.ts` 同形)。 */
const head = {
  runner: "quickjs",
  timezoneOffset: "+00:00",
  mapHash: "e".repeat(64),
  quickjsWasiVersion: QUICKJS_WASI_VERSION,
  sandboxRuntimeHash: SANDBOX_RUNTIME_HASH,
  wasiClock: String(WASI_CLOCK_MS),
  wasiRandomFill: WASI_RANDOM_FILL,
  wasiTimezoneOffset: String(WASI_TIMEZONE_OFFSET_MINUTES),
} as const;

/** 组装层那份预算字段清单(与 `apps/cli/src/match/assemble.ts` 同源;`scriptSizeLimit` 不在其中)。 */
const BUDGET_FIELDS = [
  "exceptionTickLimit",
  "eventTickLimit",
  "apiCallTickLimit",
  "memoryLimit",
  "memoryTickCeiling",
  "wallClockSoftLimit",
  "wallClockHardTimeout",
] as const;

/** 从规则集与键清单解析**已启用**的预算轨。判据是 `calibration.state`,不是「值是不是 0」。 */
const budgetOf = (ruleset: Ruleset): BudgetConfig => {
  const assembled: Record<string, number> = {};
  for (const field of BUDGET_FIELDS) {
    if (RULESET_KEY_CATALOG[field].calibration.state === "undetermined") {
      continue;
    }
    assembled[field] = ruleset[field];
  }
  return assembled as BudgetConfig;
};

const BUDGET = budgetOf(RULESET);

/** 三份基准脚本的目录名。 */
const CELLS = [
  "cell-a-melee-pressure",
  "cell-b-expansion-economy",
  "cell-c-claim-no-harvest",
] as const;

/** 一场覆盖三份基准脚本的混编对局(a/b/c/a):一次真对局就把三条腿都跑到。 */
const MIXED_SCENARIO = {
  id: "mixed-a-b-c-a-open-clash",
  map: "open-clash",
  cells: [CELLS[0], CELLS[1], CELLS[2], CELLS[0]],
} as const;

let wasmModule: WebAssembly.Module;
let runtimeCode: string;

beforeAll(async () => {
  wasmModule = await WebAssembly.compile(readFileSync(wasmPath));
  runtimeCode = readFileSync(artifactPath, "utf8");
});

/** 取一个必须存在的终值:缺了就是组装层判据与这里分叉了,当场抛而不是让比较去红。 */
const required = (value: number | undefined, name: string): number => {
  if (value === undefined) {
    throw new Error(`预算里缺 ${name}——组装层判据与动态失配断言分叉了`);
  }
  return value;
};

type BenchmarkOutcome = {
  readonly status: string;
  /** 本场里执行器报出的全部 `tripped` 观测(**带轨名与截停读数**)。 */
  readonly trips: readonly Observation[];
  readonly finalState?: GameState;
};

/**
 * 用真执行器跑一场混编基准对局。四个座位各一个 `createQuickJsRunner`,阈值取自传入的预算;
 * 外层包一层,把每条 `tripped` 观测收下来(它们不走 `runMatch` 的可选观测出口——`tripped` 是唯一
 * 写入口 `apply()` 的输入,不是披露行)。
 */
const runBenchmarkMatch = async (
  scenario: { readonly id: string; readonly map: string; readonly cells: readonly string[] },
  budget: BudgetConfig,
): Promise<BenchmarkOutcome> => {
  const map = JSON.parse(readFileSync(`${root}maps/${scenario.map}.json`, "utf8")) as MapDefinition;
  const scripts = scenario.cells.map((cell) =>
    readFileSync(`${root}benchmarks/${cell}/script.js`, "utf8"),
  );
  const handles = await Promise.all(
    scripts.map((scriptCode, seat) =>
      createQuickJsRunner({
        wasm: wasmModule,
        runtimeCode,
        scriptCode,
        seat: seat as PlayerIndex,
        ...(budget.eventTickLimit === undefined ? {} : { eventTickLimit: budget.eventTickLimit }),
        ...(budget.apiCallTickLimit === undefined
          ? {}
          : { apiCallTickLimit: budget.apiCallTickLimit }),
      }),
    ),
  );
  const trips: Observation[] = [];
  const runners: SeatRunner[] = handles.map((handle) => ({
    setSnapshot: handle.runner.setSnapshot,
    drainIntents: () => {
      const output = handle.runner.drainIntents();
      for (const observation of output.observations) {
        if (observation.kind === "tripped") {
          trips.push(observation);
        }
      }
      return output;
    },
  }));
  try {
    const players = scenario.cells.map((cell, seat) => ({
      model: cell,
      archiveRef: `bench/${scenario.id}/${String(seat)}`,
      seat: seat as PlayerIndex,
    }));
    const result = runMatch({
      ruleset: RULESET,
      map,
      seed: SEED,
      head,
      players,
      runners,
      budget,
      sink: { write: () => {} },
    });
    return result.status === "completed"
      ? { status: result.status, trips, finalState: result.finalState }
      : { status: result.status, trips };
  } finally {
    for (const handle of handles) {
      handle.dispose();
    }
  }
};

// ── 组装:当前 v1 只启用三个已定稿键的轨 ─────────────────────────────────────

it("当前 v1 组装出的预算只含三个已定稿键,未定键的轨不启用", () => {
  expect(Object.keys(BUDGET).sort()).toEqual([
    "apiCallTickLimit",
    "eventTickLimit",
    "exceptionTickLimit",
  ]);
  expect(BUDGET.eventTickLimit).toBe(10_000);
  expect(BUDGET.apiCallTickLimit).toBe(300);
  expect(BUDGET.exceptionTickLimit).toBe(3);
  // 其余五键仍是未定值:字段缺席 = 该轨不启用(不是「值为 0 即不启用」)。
  for (const field of [
    "memoryLimit",
    "memoryTickCeiling",
    "wallClockSoftLimit",
    "wallClockHardTimeout",
  ] as const) {
    expect(BUDGET[field], `${field} 仍是未定值,不该进预算`).toBeUndefined();
  }
});

// ── 正向:计数两轨各抓住一个探针(带轨名与截停读数)───────────────────────────

it("计数两轨:终值下死循环探针被事件计数轨截停、API 轰炸探针被 API 计数轨截停", async () => {
  const eventLimit = required(BUDGET.eventTickLimit, "eventTickLimit");
  const event = await runBudgetProbeTick({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: EVENT_SPIN_PROBE_SCRIPT,
    eventTickLimit: eventLimit,
  });
  // 硬超时会作废整场却看起来像「抓住了」:它必须缺席。
  expect(event.timedOut, "死循环探针被硬超时截停,不是被计数轨截停").toBe(false);
  const eventTrips = event.trips.filter((trip) => trip.track === EVENT_TRACK);
  expect(eventTrips.length, `事件轨没有截停死循环探针:${JSON.stringify(event.trips)}`).toBe(1);
  expect(eventTrips[0]?.value).toBeGreaterThanOrEqual(eventLimit);
  // 只被事件轨截停,没有被别的轨连带截停。
  expect(event.trips.map((trip) => trip.track)).toEqual([EVENT_TRACK]);

  const apiLimit = required(BUDGET.apiCallTickLimit, "apiCallTickLimit");
  const api = await runBudgetProbeTick({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: apiBombProbeScript(2_000),
    apiCallTickLimit: apiLimit,
  });
  expect(api.timedOut, "API 轰炸探针被硬超时截停,不是被 API 计数轨截停").toBe(false);
  const apiTrips = api.trips.filter((trip) => trip.track === API_CALL_TRACK);
  expect(apiTrips.length, `API 轨没有截停轰炸探针:${JSON.stringify(api.trips)}`).toBe(1);
  expect(apiTrips[0]?.value).toBeGreaterThanOrEqual(apiLimit);
  expect(api.trips.map((trip) => trip.track)).toEqual([API_CALL_TRACK]);
}, 120_000);

// ── 反向:同一组终值下,三份基准脚本一条轨都不截停 ─────────────────────────

it("反向:三份基准脚本在终值下不被任何轨截停(贴边但安全)", async () => {
  const outcome = await runBenchmarkMatch(MIXED_SCENARIO, BUDGET);
  expect(outcome.status, "基准脚本在终值预算下必须跑出正常终局,不是硬超时作废").toBe("completed");
  // 「被抓住」必须指定轨名:终值下一条 tripped 都不该有。
  expect(outcome.trips, `基准脚本被截停:${JSON.stringify(outcome.trips)}`).toEqual([]);
  const finalState = outcome.finalState;
  if (finalState === undefined) {
    throw new Error("completed 的对局必须带 finalState");
  }
  for (const [seat, player] of finalState.players.entries()) {
    expect(player.exceptionTicks, `座位 ${seat} 在终值下累计了异常`).toBe(0);
  }
}, 180_000);

// ── 反向用例:把判据参数化,证明上面两条能弄红 ────────────────────────────────

it("反向用例:抬高上限放探针过去、压低上限截停基准脚本(证明判据能弄红)", async () => {
  const apiLimit = required(BUDGET.apiCallTickLimit, "apiCallTickLimit");

  // ① 抬高 API 上限:有界轰炸探针(400 次)不再被截停,交回载荷里一条 tripped 都没有。
  const raised = await runBudgetProbeTick({
    wasm: wasmModule,
    runtimeCode,
    scriptCode: apiBombProbeScript(400),
    apiCallTickLimit: apiLimit * 100,
  });
  expect(raised.timedOut).toBe(false);
  expect(raised.trips, `抬高上限后探针仍被截停:${JSON.stringify(raised.trips)}`).toEqual([]);

  // ② 把事件计数上限压到一格:同一场基准对局立刻被事件轨截停——「基准脚本不被截停」那条
  // 因此不是空断言。一格的取值也被 spec 点名为「会误杀正常脚本」的那个数。
  const lowered: BudgetConfig = { ...BUDGET, eventTickLimit: INTERRUPT_EVENT_GRANULARITY };
  const outcome = await runBenchmarkMatch(MIXED_SCENARIO, lowered);
  const eventTrips = outcome.trips.filter((trip) => trip.track === EVENT_TRACK);
  expect(
    eventTrips.length,
    `压低事件计数上限后基准脚本竟没被事件轨截停:${JSON.stringify(outcome.trips)}`,
  ).toBeGreaterThan(0);
  expect(eventTrips[0]?.limit).toBe(INTERRUPT_EVENT_GRANULARITY);
  expect(eventTrips[0]?.value).toBeGreaterThanOrEqual(INTERRUPT_EVENT_GRANULARITY);
  // 截停者仍是计数轨本人,不是硬超时(硬超时那条走 `uncertain-timeout` 故障位)。
  expect(outcome.status).toBe("completed");
}, 180_000);
