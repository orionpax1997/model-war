#!/usr/bin/env node
// PROTOTYPE(throwaway)——不是交付物,不进任何门禁。
//
// 它回答**一个问题**:K 要标定的 8 个预算键,输入是「真实脚本在真沙箱里的每 tick 读数」,
// 而仓库里目前没有任何逐 tick 的测量探针(`observations.jsonl` 只在观测轨启用时才生成,
// 而全部预算键仍是未定值)。所以先造一个一次性的仪表化执行器,把诚实脚本的分布与对抗
// 脚本的增长速率量出来,作为 grilling 的事实输入。
//
// 用法:`node .scratch/budget-calibration/prototype/readings-probe.mjs [--only=<id>]`
//   产物:同级 `readings.json`(证据,可入库复核)。
//
// 口径:
// - 事件计数以 5000 为一格(INTERRUPT_EVENT_GRANULARITY),故它是 5000 的整数倍。
// - `mallocSize` 取每 tick 末 `runGC()` 之后的存活堆读数(与 memoryTickCeiling 同口径)。
// - 仪表化执行器**镜像** `createQuickJsRunner` 的每 tick 次序(beginTick → loop → pumpJobs
//   → endTick → runGC → memoryUsage → drainIntents),只在中间多记一笔;不改任何判定。
// - 诚实局:4 席同脚本、种子 20260101、跑满 600 tick。对抗局:4 席同脚本、硬超时 1000ms 封顶。

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const load = async (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const schema = await load("packages/schema/dist/index.js");
const { runMatch } = await load("packages/engine/dist/index.js");
const {
  openSandbox,
  WASI_CLOCK_MS,
  WASI_RANDOM_FILL,
  WASI_TIMEZONE_OFFSET_MINUTES,
  INTERRUPT_EVENT_GRANULARITY,
} = await load("packages/engine/dist/runner/quickjs.js");

const NEVER = Number.MAX_SAFE_INTEGER;
const SEED = 20260101;
const CELLS = {
  a: "cell-a-melee-pressure",
  b: "cell-b-expansion-economy",
  c: "cell-c-claim-no-harvest",
};

const ruleset = JSON.parse(readFileSync(join(ROOT, "rulesets", "v1.json"), "utf8"));
const runtimeCode = readFileSync(join(ROOT, schema.SANDBOX_RUNTIME_ARTIFACT_PATH), "utf8");
const wasmBytes = readFileSync(join(ROOT, schema.QUICKJS_WASI_WASM_PATH));
const wasmModule = await WebAssembly.compile(wasmBytes);

const cellScript = (key) => readFileSync(join(ROOT, "benchmarks", CELLS[key], "script.js"), "utf8");

// 对抗探针(仓库里不存在;这里是**一次性**版本,只用于量速率。K 要造的正式探针另说)。
const ADVERSARIAL = {
  empty: "function loop() {}\n",
  spin: "function loop() { var x = 0; for (;;) { x = (x + 1) | 0; } }\n",
  apiBomb: "function loop() { for (var i = 0; i < 1000000000; i += 1) { getTick(); } }\n",
};

const head = (mapHash) => ({
  runner: "quickjs",
  timezoneOffset: "+00:00",
  mapHash,
  quickjsWasiVersion: schema.QUICKJS_WASI_VERSION,
  sandboxRuntimeHash: "prototype-not-a-real-hash",
  wasiClock: String(WASI_CLOCK_MS),
  wasiRandomFill: WASI_RANDOM_FILL,
  wasiTimezoneOffset: String(WASI_TIMEZONE_OFFSET_MINUTES),
});

/**
 * 仪表化执行器:与 `createQuickJsRunner` 逐条同序,只在中间记一笔每 tick 读数。
 * `eventTickLimit: NEVER` 只为**装上有计数回调**——否则闭包计数器根本不建,eventCount 恒 0。
 */
const instrumentedSeat = async (scriptCode, seat, map, bucket, { hardTimeoutMs }) => {
  const session = await openSandbox({
    wasm: wasmModule,
    runtimeCode,
    scriptCode,
    seat,
    ruleset,
    eventTickLimit: NEVER,
    wallClockHardTimeout: hardTimeoutMs,
  });
  let currentTick = -1;
  return {
    dispose: session.dispose,
    runner: {
      setSnapshot: (snapshot) => {
        currentTick = snapshot.tick;
        session.setSnapshot(snapshot);
      },
      drainIntents: () => {
        session.beginTick();
        const t0 = performance.now();
        let readings;
        let error = null;
        try {
          session.runLoop();
          session.pumpJobs();
          readings = session.endTick();
        } catch (thrown) {
          readings = session.endTick();
          if (!readings.eventTripped && !readings.hardTimedOut) {
            throw thrown;
          }
          error = String(thrown?.message ?? thrown);
        }
        const loopMs = performance.now() - t0;
        session.runGC();
        const mallocSize = session.memoryUsage().mallocSize;
        const drained = session.drainIntents();
        bucket.push({
          tick: currentTick,
          eventCount: readings.eventCount,
          apiCalls: drained.apiCalls,
          mallocSize,
          loopMs,
          hardTimedOut: readings.hardTimedOut,
          error,
        });
        if (readings.hardTimedOut) {
          return { intents: [], observations: [], fault: "uncertain-timeout" };
        }
        if (readings.eventTripped) {
          return { intents: [], observations: [] };
        }
        return { intents: drained.intents, observations: [] };
      },
    },
  };
};

const runScenario = async ({ id, seats, map, hardTimeoutMs }) => {
  const mapJson = JSON.parse(readFileSync(join(ROOT, "maps", `${map}.json`), "utf8"));
  const buckets = [[], [], [], []];
  const seatsBuilt = await Promise.all(
    seats.map((script, seat) =>
      instrumentedSeat(script, seat, mapJson, buckets[seat], { hardTimeoutMs }),
    ),
  );
  const t0 = performance.now();
  let outcome;
  try {
    outcome = runMatch({
      ruleset,
      map: mapJson,
      seed: SEED,
      head: head(`prototype-${map}`),
      players: seats.map((_, seat) => ({ model: `prototype-${id}`, archiveRef: `proto/${seat}`, seat })),
      runners: seatsBuilt.map((s) => s.runner),
      budget: {},
      sink: { write: () => {} },
    });
  } finally {
    for (const s of seatsBuilt) s.dispose();
  }
  const wallMs = performance.now() - t0;
  const readings = buckets.flat();
  return {
    id,
    map,
    hardTimeoutMs: hardTimeoutMs ?? null,
    status: outcome.status,
    tickCount: outcome.status === "completed" ? outcome.tickCount : outcome.tick,
    seatTicks: buckets.map((b) => b.length),
    wallMs: Math.round(wallMs),
    readings,
  };
};

// ── 统计:只报分布,不报建议值(取值是 grilling 的事) ──
const quantile = (sorted, q) => {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[idx];
};
const statsOf = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? null,
    sum: sorted.reduce((a, b) => a + b, 0),
  };
};
const summarize = (readings) => ({
  eventCount: statsOf(readings.map((r) => r.eventCount)),
  apiCalls: statsOf(readings.map((r) => r.apiCalls)),
  mallocSize: statsOf(readings.map((r) => r.mallocSize)),
  loopMs: statsOf(readings.map((r) => r.loopMs)),
  errors: readings.filter((r) => r.error !== null).length,
  hardTimeouts: readings.filter((r) => r.hardTimedOut).length,
});

const SCENARIOS = [
  ...Object.keys(CELLS).map((key) => ({
    id: `honest-${key}-open-clash`,
    seats: Array(4).fill(cellScript(key)),
    map: "open-clash",
  })),
  ...Object.keys(CELLS).map((key) => ({
    id: `honest-${key}-corridor-split`,
    seats: Array(4).fill(cellScript(key)),
    map: "corridor-split",
  })),
  ...Object.keys(CELLS).map((key) => ({
    id: `honest-${key}-fortress-core`,
    seats: Array(4).fill(cellScript(key)),
    map: "fortress-core",
  })),
  {
    id: "honest-mixed-a-b-c-a",
    seats: [cellScript("a"), cellScript("b"), cellScript("c"), cellScript("a")],
    map: "open-clash",
  },
  { id: "adversarial-empty", seats: Array(4).fill(ADVERSARIAL.empty), map: "open-clash", hardTimeoutMs: 1000 },
  { id: "adversarial-spin", seats: Array(4).fill(ADVERSARIAL.spin), map: "open-clash", hardTimeoutMs: 1000 },
  {
    id: "adversarial-api-bomb",
    seats: Array(4).fill(ADVERSARIAL.apiBomb),
    map: "open-clash",
    hardTimeoutMs: 1000,
  },
];

const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const chosen = only === undefined ? SCENARIOS : SCENARIOS.filter((s) => s.id === only);

const report = { meta: { seed: SEED, granularity: INTERRUPT_EVENT_GRANULARITY, root: ROOT }, scenarios: [] };
for (const scenario of chosen) {
  process.stderr.write(`▶ ${scenario.id} … `);
  const result = await runScenario(scenario);
  report.scenarios.push({ ...result, summary: summarize(result.readings) });
  process.stderr.write(`${result.status} ${result.tickCount} ticks ${result.wallMs}ms\n`);
}

writeFileSync(join(HERE, "readings.json"), `${JSON.stringify(report, null, 1)}\n`);
writeFileSync(
  join(HERE, "readings.md"),
  [
    "# PROTOTYPE 读数(一次性)",
    "",
    `种子 ${SEED};事件计数粒度 ${INTERRUPT_EVENT_GRANULARITY};每 tick 末 runGC 后读 mallocSize。`,
    "",
    "| 场景 | 状态 | tick | 墙钟 ms | event p50/p95/max | api p50/p95/max | malloc p50/p95/max | loopMs p50/p95/max | error | hardTO |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...report.scenarios.map((s) => {
      const q = (o, round = false) => {
        const f = (v) => (v === null ? "-" : String(round ? Math.round(v) : v));
        return `${f(o.p50)}/${f(o.p95)}/${f(o.max)}`;
      };
      return `| ${s.id} | ${s.status} | ${s.tickCount} | ${s.wallMs} | ${q(s.summary.eventCount)} | ${q(s.summary.apiCalls)} | ${q(s.summary.mallocSize)} | ${q(s.summary.loopMs, true)} | ${s.summary.errors} | ${s.summary.hardTimeouts} |`;
    }),
    "",
  ].join("\n"),
);
process.stderr.write(`\n落盘:readings.json / readings.md\n`);
