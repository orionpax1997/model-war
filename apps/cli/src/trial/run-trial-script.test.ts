/** 既有 trial 子进程 seam：真实 QuickJS/安装面，直接观察退出码与 JSONL，无网络调用。 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import {
  RULESET_VERSION,
  TRIAL_BENCHMARK_IDS,
  type JsonValue,
  type Ruleset,
  type TrialObservationLine,
  type TrialPlan,
} from "@model-war/schema";
import { hashOf } from "@model-war/runner";
import { validateTrialObservation } from "../validator.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "modelwar-trial-action-facts-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const install = (script: string, rules: Partial<Ruleset> = {}) => {
  const root = mkdtempSync(join(scratch, "root-"));
  for (const name of ["packages", "node_modules", "maps", "benchmarks"]) {
    symlinkSync(join(repoRoot, name), join(root, name), "dir");
  }
  mkdirSync(join(root, "rulesets"));
  const original = JSON.parse(
    readFileSync(join(repoRoot, "rulesets", `${RULESET_VERSION}.json`), "utf8"),
  ) as Ruleset;
  writeFileSync(
    join(root, "rulesets", `${RULESET_VERSION}.json`),
    JSON.stringify({ ...original, ...rules }),
  );
  const candidate = join(root, "candidate.js");
  const observations = join(root, "observations.jsonl");
  writeFileSync(candidate, script);
  const invoke = (args: readonly string[], nodeArgs: readonly string[] = []) =>
    spawnSync(
      process.execPath,
      [...nodeArgs, join(repoRoot, "apps/cli/dist/trial/run-trial-script.js"), ...args],
      { encoding: "utf8", timeout: 30_000 },
    );
  const run = (path = observations, nodeArgs: readonly string[] = []) =>
    invoke([candidate, "--root", root, "--observations", path], nodeArgs);
  /** `--plan`：只造计划并打印（不读候选、不跑对局）。 */
  const plan = (nodeArgs: readonly string[] = []) => invoke(["--plan", "--root", root], nodeArgs);
  const rows = () =>
    readFileSync(observations, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as TrialObservationLine);
  return { root, candidate, observations, run, plan, invoke, rows };
};

it("真实候选 JS 在试跑入口绑定 hash/seed/seat，每场独立写入原 JSONL", { timeout: 30_000 }, () => {
  const script =
    "// 实际加载的候选字节\nfunction loop() { move(999999, 1, 0); spawnUnit(999999, 'worker'); }\n";
  const fixture = install(script);
  const result = fixture.run();
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const rows = fixture.rows();
  expect(rows).toHaveLength(3);
  expect(rows.map((row) => row.actionFacts)).toEqual([
    expect.objectContaining({
      version: 1,
      scriptSha256: createHash("sha256").update(script).digest("hex"),
      seed: 101,
      seat: 0,
    }),
    expect.objectContaining({
      version: 1,
      scriptSha256: createHash("sha256").update(script).digest("hex"),
      seed: 202,
      seat: 0,
    }),
    expect.objectContaining({
      version: 1,
      scriptSha256: createHash("sha256").update(script).digest("hex"),
      seed: 303,
      seat: 0,
    }),
  ]);
  for (const [matchIndex, row] of rows.entries()) {
    const facts = row.actionFacts;
    if (facts === undefined) throw new Error("缺行动事实");
    expect(row.matchIndex).toBe(matchIndex);
    expect(facts.complete).toBe(true);
    expect(facts.missingTicks).toBe(0);
    expect(facts.observedTicks).toBeGreaterThan(0);
    expect(facts.calls).toEqual({
      move: facts.observedTicks,
      moveTo: 0,
      attack: 0,
      harvest: 0,
      transfer: 0,
      spawnUnit: facts.observedTicks,
    });
    expect(facts.errors.move.ERR_INVALID_UNIT).toBe(facts.observedTicks);
    expect(facts.errors.spawnUnit.ERR_INVALID_SITE).toBe(facts.observedTicks);
    expect(facts.effects).toEqual({
      movedSteps: 0,
      harvestedAmount: 0,
      deliveredAmount: 0,
      captureEvents: 0,
      productionOrdersStarted: 0,
    });
  }
});

it(
  "真实 API 超限早停只写已完成的第一场，有 payload 的触限 tick 仍计 observed",
  { timeout: 30_000 },
  () => {
    const fixture = install(
      "function loop() { for (var i = 0; i < 801; i++) move(999999, 1, 0); }\n",
    );
    const result = fixture.run();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const rows = fixture.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      matchIndex: 0,
      actionFacts: {
        seed: 101,
        seat: 0,
        complete: true,
        observedTicks: 3,
        missingTicks: 0,
        calls: { move: 2403 },
        errors: { move: { ERR_INVALID_UNIT: 2403 } },
        effects: { movedSteps: 0 },
      },
    });
  },
);

it("JSONL 写盘失败仍按原预算结论退出并留 stderr，不把旁证失败判给候选", { timeout: 30_000 }, () => {
  const fixture = install("function loop() {}\n", { tickLimit: 4 });
  const result = fixture.run(join(fixture.root, "missing-directory", "observations.jsonl"));
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("观测文件写盘失败");
});

it(
  "timeout attempt 的已采事实丢弃，同种子重跑的 JSONL 与有效单次完全相等",
  { timeout: 30_000 },
  () => {
    const script =
      "function loop() { move(999999, 1, 0); if (getTick() === 1) { for (var i = 0; i < 120000; i++) { var x = i % 7; } } }\n";
    // 只对测试安装面调高事件阈值以抵达墙钟抽样点，生产规则/赛季完全不变。
    const fixture = install(script, { tickLimit: 4, eventTickLimit: 500000 });
    const baseline = fixture.run();
    expect(baseline.status, baseline.stderr).toBe(0);
    const validRows = fixture.rows();
    const clock = join(fixture.root, "one-time-timeout.mjs");
    // tick0 四席各读一次 tickStart；tick1 候选在第六次读钟抽样时跨过硬超时。
    // 仅替换宿主时钟边界，仍执行真实 QuickJS/runner/引擎与正式 CLI 重跑逻辑。
    writeFileSync(
      clock,
      "let calls = 0; Object.defineProperty(performance, 'now', { value: () => ++calls < 6 ? 0 : 2000 });\n",
    );
    const reran = fixture.run(fixture.observations, ["--import", clock]);
    expect(reran.status, reran.stderr).toBe(0);
    expect(reran.stderr.match(/同一种子重跑一次/g)).toHaveLength(1);
    expect(fixture.rows()).toEqual(validRows);
  },
);

it(
  "两次 timeout 仍是 infra，当前 invocation 不发布行动事实，也不覆盖旧完整文件",
  { timeout: 30_000 },
  () => {
    const script =
      "function loop() { move(999999, 1, 0); if (getTick() === 1) { for (var i = 0; i < 120000; i++) { var x = i % 7; } } }\n";
    const fixture = install(script, { tickLimit: 4, eventTickLimit: 500000 });
    const baseline = fixture.run();
    expect(baseline.status, baseline.stderr).toBe(0);
    const previous = readFileSync(fixture.observations, "utf8");
    const clock = join(fixture.root, "repeated-timeout.mjs");
    writeFileSync(
      clock,
      "let calls = 0; Object.defineProperty(performance, 'now', { value: () => ++calls * 2000 });\n",
    );
    const failed = fixture.run(fixture.observations, ["--import", clock]);
    expect(failed.status, failed.stderr).toBe(2);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain("两次作废");
    expect(readFileSync(fixture.observations, "utf8")).toBe(previous);
    const fresh = join(fixture.root, "never-published.jsonl");
    expect(fixture.run(fresh, ["--import", clock]).status).toBe(2);
    expect(existsSync(fresh)).toBe(false);
  },
);

it.each([
  {
    kind: "未吞异常",
    script: "function loop() { move(999999, 1, 0); throw new Error('guest'); }\n",
    status: 0,
    rows: 3,
  },
  {
    kind: "事件截停",
    script: "function loop() { move(999999, 1, 0); while (true) {} }\n",
    status: 1,
    rows: 1,
  },
])(
  "真实 $kind 没有 drain payload：missing 如实计数，不补已尝试动作零值为完整事实",
  { timeout: 30_000 },
  ({ script, status, rows }) => {
    const fixture = install(script, { tickLimit: 4 });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(status);
    const observed = fixture.rows();
    expect(observed).toHaveLength(rows);
    for (const row of observed) {
      expect(validateTrialObservation(row).ok).toBe(true);
      expect(row.terminalSummary?.players[0]).toMatchObject({
        controlledBases: 0,
        controlledResources: 0,
        survivingUnits: { worker: 2, melee: 0, ranged: 0, cavalry: 0 },
        survivingUnitCost: 8,
        territoryScore: 1,
        rank: 4,
        rankPoints: 0,
        alive: false,
        eliminatedAtTick: 2,
      });
      expect(row.actionFacts).toMatchObject({
        complete: false,
        observedTicks: 0,
        missingTicks: 3,
        calls: { move: 0 },
        errors: { move: { ERR_INVALID_UNIT: 0 } },
      });
    }
  },
);

it("真实固定 seed 试跑将 completed 四方终局计分贯通 readings 和 JSONL", { timeout: 30_000 }, () => {
  const fixture = install("function loop() {}\n", { tickLimit: 1 });
  const result = fixture.run();
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const rows = fixture.rows();
  for (const row of rows) expect(validateTrialObservation(row).ok).toBe(true);
  expect(rows.map((row) => row.terminalSummary)).toEqual(
    [101, 202, 303].map((seed) => ({
      version: 1,
      seed,
      tick: 1,
      reason: "timeout",
      weights: { baseScore: 4, resourceScore: 1, unitCostDivisor: 6 },
      unitCosts: { worker: 4, melee: 8, ranged: 12, cavalry: 16 },
      rankPoints: [3, 2, 1, 0],
      players: [
        "candidate",
        "cell-a-melee-pressure",
        "cell-b-expansion-economy",
        "cell-c-claim-no-harvest",
      ].map((player, seat) => ({
        seat,
        player,
        controlledBases: 1,
        controlledResources: 1,
        survivingUnits: { worker: 2, melee: 0, ranged: 0, cavalry: 0 },
        survivingUnitCost: 8,
        score: { bases: 4, resources: 1, units: 1 },
        territoryScore: 6,
        rank: 1,
        rankPoints: 1.5,
        alive: true,
        eliminatedAtTick: null,
      })),
    })),
  );
});

it("宿主执行异常保持 infra，不发布未知终局也不覆盖旧完整 JSONL", { timeout: 30_000 }, () => {
  const fixture = install("function loop() {}\n", { tickLimit: 1 });
  expect(fixture.run().status).toBe(0);
  const previous = readFileSync(fixture.observations, "utf8");
  const brokenWasm = join(fixture.root, "broken-wasm.mjs");
  writeFileSync(
    brokenWasm,
    "WebAssembly.compile = async () => { throw new Error('host-wasm-failure'); };\n",
  );
  const failed = fixture.run(fixture.observations, ["--import", brokenWasm]);
  expect(failed.status).toBe(2);
  expect(failed.stdout).toBe("");
  expect(failed.stderr).toContain("试跑执行失败:host-wasm-failure");
  expect(readFileSync(fixture.observations, "utf8")).toBe(previous);
  const fresh = join(fixture.root, "host-failure-unknown.jsonl");
  expect(fixture.run(fresh, ["--import", brokenWasm]).status).toBe(2);
  expect(existsSync(fresh)).toBe(false);
});

it(
  "--plan 打印计划：单图三场、种子与摘要取自盘上字节，摘要可由正文复算，两次逐字相同",
  { timeout: 30_000 },
  () => {
    const fixture = install("function loop() {}\n");
    const first = fixture.plan();
    expect(first.error).toBeUndefined();
    expect(first.status, first.stderr).toBe(0);
    const plan = JSON.parse(first.stdout) as TrialPlan;
    expect(plan.version).toBe(1);
    expect(plan.matchesPerCandidate).toBe(3);
    expect(plan.matches.map((match) => match.seed)).toEqual([101, 202, 303]);
    expect(plan.maps).toEqual([
      {
        name: "corridor-split",
        sha256: createHash("sha256")
          .update(readFileSync(join(repoRoot, "maps", "corridor-split.json")))
          .digest("hex"),
      },
    ]);
    expect(plan.scripts.map((script) => script.id)).toEqual([...TRIAL_BENCHMARK_IDS]);
    expect(plan.scripts.map((script) => script.source)).toEqual(
      TRIAL_BENCHMARK_IDS.map((name) => `benchmark:${name}`),
    );
    expect(plan.scripts.map((script) => script.scriptSha256)).toEqual(
      TRIAL_BENCHMARK_IDS.map((name) =>
        createHash("sha256")
          .update(readFileSync(join(repoRoot, "benchmarks", name, "script.js")))
          .digest("hex"),
      ),
    );
    for (const match of plan.matches) {
      expect(match.seats).toEqual(["candidate", ...TRIAL_BENCHMARK_IDS]);
      expect(match.candidateSeat).toBe(0);
      expect(match.map).toBe("corridor-split");
    }
    // 摘要只覆盖正文：把它剥掉再复算必须逐字相等。
    const { planSha256, ...body } = plan;
    expect(planSha256).toBe(hashOf(JSON.parse(JSON.stringify(body)) as JsonValue));
    // 同一安装面两次打印逐字相同（计划是纯数据，不含时间戳或路径）。
    expect(fixture.plan().stdout).toBe(first.stdout);
  },
);

it(
  "--expected-plan 与 --plan 输出逐字相等即照跑，观测与不带该参数完全一致",
  { timeout: 60_000 },
  () => {
    // 只跑 4 个 tick：这条断言的是「计划相等就照跑、观测不变」，不是对局长度。
    const fixture = install("function loop() {}\n", { tickLimit: 4 });
    const printed = fixture.plan();
    expect(printed.status, printed.stderr).toBe(0);
    const planPath = join(fixture.root, "expected-plan.json");
    writeFileSync(planPath, printed.stdout);
    const baseline = fixture.run(join(fixture.root, "baseline.jsonl"));
    expect(baseline.status, baseline.stderr).toBe(0);
    const planned = fixture.invoke([
      fixture.candidate,
      "--root",
      fixture.root,
      "--observations",
      join(fixture.root, "planned.jsonl"),
      "--expected-plan",
      planPath,
    ]);
    expect(planned.status, planned.stderr).toBe(0);
    expect(planned.stdout).toBe(baseline.stdout);
    expect(readFileSync(join(fixture.root, "planned.jsonl"), "utf8")).toBe(
      readFileSync(join(fixture.root, "baseline.jsonl"), "utf8"),
    );
  },
);

/** 按「正文改了、摘要没重算」或「连摘要一起重算」两种手法重写计划文件。 */
const rewritePlan = (plan: TrialPlan, patch: Partial<TrialPlan>, rehash: boolean): string => {
  const merged = { ...plan, ...patch };
  if (!rehash) return JSON.stringify(merged);
  const { planSha256, ...body } = merged;
  void planSha256;
  return JSON.stringify({ ...body, planSha256: hashOf(body as unknown as JsonValue) });
};

it.each([
  {
    kind: "改种子（摘要没重算）",
    patch: (plan: TrialPlan): Partial<TrialPlan> => ({
      matches: plan.matches.map((match, index) => (index === 1 ? { ...match, seed: 999 } : match)),
    }),
    rehash: false,
    reported: /matches\[1\]\.seed/,
  },
  {
    kind: "改座位（摘要一起重算）",
    patch: (plan: TrialPlan): Partial<TrialPlan> => ({
      matches: plan.matches.map((match, index) =>
        index === 0
          ? {
              ...match,
              seats: [...match.seats].reverse() as unknown as TrialPlan["matches"][number]["seats"],
            }
          : match,
      ),
    }),
    rehash: true,
    reported: /matches\[0\]\.seats/,
  },
  {
    kind: "换一份对手摘要（摘要一起重算）",
    patch: (plan: TrialPlan): Partial<TrialPlan> => ({
      scripts: plan.scripts.map((script, index) =>
        index === 1 ? { ...script, scriptSha256: "e".repeat(64) } : script,
      ),
    }),
    rehash: true,
    reported: /scripts\[1\]\.scriptSha256/,
  },
])(
  "计划被篡改（$kind）→ 退出 2、指名哪一处不符、不写观测",
  { timeout: 30_000 },
  ({ patch, rehash, reported }) => {
    const fixture = install("function loop() {}\n");
    const printed = fixture.plan();
    expect(printed.status, printed.stderr).toBe(0);
    const planPath = join(fixture.root, "tampered-plan.json");
    writeFileSync(
      planPath,
      rewritePlan(
        JSON.parse(printed.stdout) as TrialPlan,
        patch(JSON.parse(printed.stdout) as TrialPlan),
        rehash,
      ),
    );
    const observations = join(fixture.root, "tampered.jsonl");
    const ran = fixture.invoke([
      fixture.candidate,
      "--root",
      fixture.root,
      "--observations",
      observations,
      "--expected-plan",
      planPath,
    ]);
    expect(ran.status, ran.stderr).toBe(2);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toMatch(reported);
    expect(existsSync(observations)).toBe(false);
  },
);

it("计划与观测对齐：观测行里的 seed / 候选座位就是计划里那几场", { timeout: 60_000 }, () => {
  const fixture = install("function loop() {}\n", { tickLimit: 4 });
  const plan = JSON.parse(fixture.plan().stdout) as TrialPlan;
  expect(fixture.run().status).toBe(0);
  const rows = fixture.rows();
  expect(rows).toHaveLength(plan.matches.length);
  for (const [index, row] of rows.entries()) {
    expect(row.matchIndex).toBe(plan.matches[index]!.matchIndex);
    expect(row.actionFacts?.seed).toBe(plan.matches[index]!.seed);
    expect(row.actionFacts?.seat).toBe(plan.matches[index]!.candidateSeat);
    expect(row.terminalSummary?.seed).toBe(plan.matches[index]!.seed);
  }
});
