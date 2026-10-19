/**
 * 试跑单场的 trip 记录：经真实 `runMatch`、用"会报触限的桩执行器"覆盖。
 *
 * 不起 VM：桩执行器在第 N 次交回时带一条 canned `tripped` 观测，断言记录器记下的
 * 座位/tick/轨名/读数/上限对不对、作废故障透不透得出来。真 VM 那一侧（计数准不准）
 * 由手工冒烟与 `gen-cli` e2e 覆盖——这里只钉"记录"这一层。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { MapDefinition, ReplayPlayerRef, Ruleset } from "@model-war/schema";
import { expect, it } from "vitest";

import { runTrialMatch } from "./match-run.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const ruleset = JSON.parse(readFileSync(join(repoRoot, "rulesets", "v2.json"), "utf8")) as Ruleset;
const map = JSON.parse(
  readFileSync(join(repoRoot, "maps", "corridor-split.json"), "utf8"),
) as MapDefinition;

const players = (["candidate", "bench-a", "bench-b", "bench-c"] as const).map(
  (model, seat): ReplayPlayerRef => ({
    model,
    archiveRef: `trial/${model}`,
    seat: seat as ReplayPlayerRef["seat"],
  }),
);

/**
 * 会报触限的桩：`trips` 按"第几次交回"排期，每条 `{ at, observation }` 在第 at 次
 * `drainIntents` 时带出；`faultAt` 给定时在第 faultAt 次交回作废故障位。
 * 其余每次都交回空意图（原地待命），与真沙箱"超限作废本 tick 意图"同形。
 */
const recordingStub = (options: {
  readonly trips?: readonly {
    readonly at: number;
    readonly track: string;
    readonly value: number;
    readonly limit: number;
  }[];
  readonly faultAt?: number;
}) => {
  let calls = 0;
  return {
    setSnapshot: (_snapshot: unknown): void => {},
    drainIntents: () => {
      calls += 1;
      if (options.faultAt !== undefined && calls === options.faultAt) {
        return { intents: [], observations: [], fault: "uncertain-timeout" as const };
      }
      const observations = (options.trips ?? [])
        .filter((trip) => trip.at === calls)
        .map((trip) => ({
          kind: "tripped" as const,
          track: trip.track,
          value: trip.value,
          limit: trip.limit,
        }));
      return { intents: [], observations };
    },
  };
};

const quiet = [recordingStub({}), recordingStub({}), recordingStub({}), recordingStub({})] as const;

it("候选座的触限被记下：座位/tick/轨名/读数/上限逐字对", { timeout: 30_000 }, async () => {
  const runners = [
    recordingStub({
      trips: [{ at: 3, track: "eventTickLimit", value: 55000, limit: 50000 }],
    }),
    recordingStub({}),
    recordingStub({}),
    recordingStub({}),
  ] as const;
  const outcome = await runTrialMatch({
    runners: [...runners],
    players: [...players],
    ruleset,
    map,
    seed: 101,
    budget: { exceptionTickLimit: 3, eventTickLimit: 50000, apiCallTickLimit: 800 },
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "test" },
    matchIndex: 1,
  });
  expect(outcome.fault).toBeNull();
  expect(outcome.trips).toHaveLength(1);
  expect(outcome.trips[0]).toEqual({
    matchIndex: 1,
    tick: 2,
    seat: 0,
    track: "eventTickLimit",
    value: 55000,
    limit: 50000,
  });
});

it("全场干净 → 无记录、无作废", { timeout: 30_000 }, async () => {
  const outcome = await runTrialMatch({
    runners: [...quiet],
    players: [...players],
    ruleset,
    map,
    seed: 101,
    budget: { exceptionTickLimit: 3, eventTickLimit: 50000, apiCallTickLimit: 800 },
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "test" },
    matchIndex: 0,
  });
  expect(outcome.fault).toBeNull();
  expect(outcome.trips).toEqual([]);
});

it("tick 归因按交回序：两次触限的 tick 差等于交回次数差", { timeout: 30_000 }, async () => {
  const runners = [
    recordingStub({
      trips: [
        { at: 3, track: "eventTickLimit", value: 55000, limit: 50000 },
        { at: 8, track: "apiCallTickLimit", value: 812, limit: 800 },
      ],
    }),
    recordingStub({}),
    recordingStub({}),
    recordingStub({}),
  ] as const;
  const outcome = await runTrialMatch({
    runners: [...runners],
    players: [...players],
    ruleset,
    map,
    seed: 101,
    budget: { exceptionTickLimit: 3, eventTickLimit: 50000, apiCallTickLimit: 800 },
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "test" },
    matchIndex: 0,
  });
  expect(outcome.trips).toHaveLength(2);
  expect(outcome.trips[1]?.tick).toBe((outcome.trips[0]?.tick ?? 0) + 5);
  expect(outcome.trips[1]?.track).toBe("apiCallTickLimit");
});

it(
  "对手座位的触限也记下（记不记与判不判是两件事：判由 verdict 定）",
  { timeout: 30_000 },
  async () => {
    const runners = [
      recordingStub({}),
      recordingStub({}),
      recordingStub({
        trips: [{ at: 2, track: "eventTickLimit", value: 60000, limit: 50000 }],
      }),
      recordingStub({}),
    ] as const;
    const outcome = await runTrialMatch({
      runners: [...runners],
      players: [...players],
      ruleset,
      map,
      seed: 101,
      budget: { exceptionTickLimit: 3, eventTickLimit: 50000, apiCallTickLimit: 800 },
      head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "test" },
      matchIndex: 0,
    });
    expect(outcome.trips).toHaveLength(1);
    expect(outcome.trips[0]?.seat).toBe(2);
  },
);

it("作废故障透出来（墙钟硬超时那条轨：整场作废而非判罚）", { timeout: 30_000 }, async () => {
  const runners = [
    recordingStub({}),
    recordingStub({ faultAt: 2 }),
    recordingStub({}),
    recordingStub({}),
  ] as const;
  const outcome = await runTrialMatch({
    runners: [...runners],
    players: [...players],
    ruleset,
    map,
    seed: 101,
    budget: { exceptionTickLimit: 3, eventTickLimit: 50000, apiCallTickLimit: 800 },
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "test" },
    matchIndex: 0,
  });
  expect(outcome.fault).not.toBeNull();
});

it(
  "空转的一局：候选座位的无得分来源读数随局返回（只观测，不带判定）",
  { timeout: 30_000 },
  async () => {
    const outcome = await runTrialMatch({
      runners: [...quiet],
      players: [...players],
      ruleset,
      map,
      seed: 101,
      budget: { exceptionTickLimit: 3, eventTickLimit: 50000, apiCallTickLimit: 800 },
      head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "test" },
      matchIndex: 0,
    });
    expect(outcome.scoreSource.noScoreSource).toBe(true);
    expect(outcome.trips).toHaveLength(0);
  },
);

/* ───────────────────── 无得分来源的**接线**（上面那条空转用例证明不了） ─────────────────────
 *
 * 空转一局里所有座位都没产出，于是「只观测候选座位」与「一个座位都不观测」在读数上完全一样——
 * 那条用例钉不住接线。真正钉得住的是把产出**按座位分开**：候选动 → 读数变；候选不动而别人动
 * → 读数不变。合成地图把两边都摆在一张 16×16 空场上，四方各一工人，产出只可能来自
 * `capturingStub` 让谁站上中立点位。
 */

const openTerrain = Array.from({ length: 16 }, () => ".".repeat(16));

/** 四方各一个主基地；4 号中立点贴着 0 号基地，5 号贴着 1 号基地。 */
const wiringMap: MapDefinition = {
  name: "trial-wiring",
  size: 16,
  rulesetMin: "v1",
  terrain: openTerrain,
  sites: [
    { id: 0, kind: "base", x: 1, y: 1, initialOwner: 0 },
    { id: 1, kind: "base", x: 14, y: 1, initialOwner: 1 },
    { id: 2, kind: "base", x: 14, y: 14, initialOwner: 2 },
    { id: 3, kind: "base", x: 1, y: 14, initialOwner: 3 },
    { id: 4, kind: "resource", x: 3, y: 1, initialOwner: null },
    { id: 5, kind: "resource", x: 12, y: 1, initialOwner: null },
  ],
  spawnUnits: [0, 1, 2, 3].map((owner) => ({ owner, type: "worker", offset: [1, 0] })),
  variantSlots: [],
};

/** 快照里这个桩要读的两栏（引擎的 `Snapshot` 不导出，桩只声明自己用到的那部分）。 */
type WireSnapshot = {
  readonly units: readonly { readonly id: number; readonly owner: number; readonly type: string }[];
  readonly sites: readonly {
    readonly id: number;
    readonly owner: number;
    readonly x: number;
    readonly y: number;
  }[];
};

/**
 * 会占点的桩：把自己的工人开到 `siteId` 那一格并站到易主为止，除此之外什么也不做。
 * 到达之前每 tick 重发 `moveTo`（已经在格上时它落空，工人不动），所以不需要路径规划。
 */
const capturingStub = (seat: number, siteId: number) => {
  let snapshot: WireSnapshot | null = null;
  return {
    setSnapshot: (latest: WireSnapshot): void => {
      snapshot = latest;
    },
    drainIntents: () => {
      const site = snapshot?.sites.find((candidate) => candidate.id === siteId);
      const worker = snapshot?.units.find((unit) => unit.owner === seat && unit.type === "worker");
      if (site === undefined || worker === undefined || site.owner === seat) {
        return { intents: [], observations: [] };
      }
      return {
        intents: [{ kind: "moveTo" as const, unitId: worker.id, x: site.x, y: site.y }],
        observations: [],
      };
    },
  };
};

it("接线：候选座位占下中立点位 → 读数记下这 1 次占点，不命中", { timeout: 30_000 }, async () => {
  const outcome = await runTrialMatch({
    runners: [capturingStub(0, 4), recordingStub({}), recordingStub({}), recordingStub({})],
    players: [...players],
    ruleset,
    map: wiringMap,
    seed: 101,
    budget: { exceptionTickLimit: 3, eventTickLimit: 50000, apiCallTickLimit: 800 },
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "test" },
    matchIndex: 0,
  });
  expect(outcome.scoreSource).toEqual({ delivered: 0, captures: 1, noScoreSource: false });
});

it("接线：他座位占下中立点位不算候选的得分来源 → 候选仍判命中", { timeout: 30_000 }, async () => {
  const outcome = await runTrialMatch({
    runners: [recordingStub({}), capturingStub(1, 5), recordingStub({}), recordingStub({})],
    players: [...players],
    ruleset,
    map: wiringMap,
    seed: 101,
    budget: { exceptionTickLimit: 3, eventTickLimit: 50000, apiCallTickLimit: 800 },
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "test" },
    matchIndex: 0,
  });
  expect(outcome.scoreSource).toEqual({ delivered: 0, captures: 0, noScoreSource: true });
});

it("行动事实只聚合候选：正常/API 超限载荷计 observed，截停/异常无载荷计 missing，effects 独立", () => {
  const errors = () => ({
    ERR_NOT_ENOUGH_RESOURCES: 0,
    ERR_INVALID_UNIT: 0,
    ERR_NOT_OWNER: 0,
    ERR_OUT_OF_RANGE: 0,
    ERR_INVALID_TARGET: 0,
    ERR_INVALID_SITE: 0,
    ERR_BAD_ARGS: 0,
  });
  const facts = {
    calls: { move: 2, moveTo: 0, attack: 0, harvest: 0, transfer: 0, spawnUnit: 0 },
    errors: {
      move: { ...errors(), ERR_BAD_ARGS: 1 },
      moveTo: errors(),
      attack: errors(),
      harvest: errors(),
      transfer: errors(),
      spawnUnit: errors(),
    },
  };
  const scripted = (seat: number) => {
    let tick = 0;
    let unitId = -1;
    return {
      setSnapshot: (snapshot: {
        readonly tick: number;
        readonly units: readonly { readonly id: number; readonly owner: number }[];
      }) => {
        tick = snapshot.tick;
        unitId = snapshot.units.find((unit) => unit.owner === seat)?.id ?? -1;
      },
      drainIntents: () => ({
        intents:
          tick === 0 ? [{ kind: "move" as const, unitId, dx: -1 as const, dy: 0 as const }] : [],
        observations:
          tick === 1 || tick === 2 || tick === 3
            ? [
                {
                  kind: "tripped" as const,
                  track:
                    tick === 1
                      ? "apiCallTickLimit"
                      : tick === 2
                        ? "eventTickLimit"
                        : "uncaughtException",
                  value: 2,
                  limit: 1,
                },
              ]
            : [],
        ...(tick === 2 || tick === 3 ? {} : { actionFacts: facts }),
      }),
    };
  };
  const outcome = runTrialMatch({
    runners: [scripted(0), scripted(1), recordingStub({}), recordingStub({})],
    players,
    ruleset: { ...ruleset, tickLimit: 5 },
    map: wiringMap,
    seed: 101,
    budget: {},
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "test" },
    matchIndex: 0,
  });
  expect(outcome).toMatchObject({
    actionFacts: {
      complete: false,
      observedTicks: 3,
      missingTicks: 2,
      calls: { move: 6, moveTo: 0, attack: 0, harvest: 0, transfer: 0, spawnUnit: 0 },
      errors: { ...facts.errors, move: { ...errors(), ERR_BAD_ARGS: 3 } },
      effects: {
        movedSteps: 1,
        harvestedAmount: 0,
        deliveredAmount: 0,
        captureEvents: 0,
        productionOrdersStarted: 0,
      },
    },
  });
  expect(outcome.scoreSource).toEqual({ delivered: 0, captures: 0, noScoreSource: true });
});

it("末 tick 宿主效果独立于旧快照 tracker，交付/采集/订单/易主只归候选，缺 payload 不抹 effects", () => {
  const world: MapDefinition = {
    ...wiringMap,
    sites: [
      ...wiringMap.sites.map((site) => ({
        ...site,
        initialOwner: site.id === 4 ? 0 : site.id === 5 ? 1 : site.initialOwner,
      })),
      { id: 6, kind: "resource", x: 4, y: 1, initialOwner: null },
    ],
    spawnUnits: [
      { owner: 0, type: "worker", offset: [1, 0] },
      { owner: 0, type: "worker", offset: [3, 0] },
      { owner: 1, type: "worker", offset: [-1, 0] },
    ],
  };
  const economicRunner = (seat: number, siteId: number) => {
    let tick = 0;
    let unitId = -1;
    return {
      setSnapshot: (snapshot: {
        readonly tick: number;
        readonly units: readonly { readonly owner: number; readonly id: number }[];
      }) => {
        tick = snapshot.tick;
        unitId = snapshot.units.find((unit) => unit.owner === seat)?.id ?? -1;
      },
      drainIntents: () => ({
        intents:
          tick === 0
            ? [{ kind: "harvest" as const, unitId, siteId }]
            : [
                { kind: "transfer" as const, unitId },
                { kind: "spawnUnit" as const, baseId: seat, unitType: "worker" as const },
              ],
        observations: [],
      }),
    };
  };
  const outcome = runTrialMatch({
    runners: [economicRunner(0, 4), economicRunner(1, 5), recordingStub({}), recordingStub({})],
    players,
    ruleset: { ...ruleset, tickLimit: 2, captureTicks: 2, harvestRate: 3 },
    map: world,
    seed: 101,
    matchIndex: 0,
    budget: {},
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "test" },
  });
  expect(outcome.scoreSource).toEqual({ delivered: 0, captures: 0, noScoreSource: true });
  expect(outcome.actionFacts).toMatchObject({
    complete: false,
    observedTicks: 0,
    missingTicks: 2,
    effects: {
      movedSteps: 0,
      harvestedAmount: 3,
      deliveredAmount: 3,
      captureEvents: 1,
      productionOrdersStarted: 1,
    },
  });
});

it("终局采用末 tick 真实控制权和四兵种存活造价，权重与造价来自当局 ruleset", () => {
  const outcome = runTrialMatch({
    runners: [capturingStub(0, 4), recordingStub({}), recordingStub({}), recordingStub({})],
    players,
    ruleset: {
      ...ruleset,
      tickLimit: 1,
      captureTicks: 1,
      baseScore: 10,
      resourceScore: 3,
      unitCostDivisor: 7,
      worker: { ...ruleset.worker, cost: 6 },
      melee: { ...ruleset.melee, cost: 10 },
      ranged: { ...ruleset.ranged, cost: 14 },
      cavalry: { ...ruleset.cavalry, cost: 18 },
    },
    map: {
      ...wiringMap,
      spawnUnits: [
        { owner: 0, type: "worker", offset: [1, 0] },
        { owner: 0, type: "melee", offset: [0, 1] },
        { owner: 0, type: "ranged", offset: [1, 1] },
        { owner: 0, type: "cavalry", offset: [0, 2] },
        { owner: 1, type: "worker", offset: [-1, 0] },
      ],
    },
    seed: 101,
    matchIndex: 0,
    budget: {},
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "test" },
  });
  // 旧 tracker 没有下一帧，仍无占点读数；终局已在 tick0 结算易主。
  expect(outcome.scoreSource.captures).toBe(0);
  expect(outcome.terminalSummary).toMatchObject({
    tick: 1,
    reason: "timeout",
    weights: { baseScore: 10, resourceScore: 3, unitCostDivisor: 7 },
    unitCosts: { worker: 6, melee: 10, ranged: 14, cavalry: 18 },
  });
  expect(outcome.terminalSummary?.players[0]).toEqual({
    seat: 0,
    player: "candidate",
    controlledBases: 1,
    controlledResources: 1,
    survivingUnits: { worker: 1, melee: 1, ranged: 1, cavalry: 1 },
    survivingUnitCost: 48,
    score: { bases: 10, resources: 3, units: 6 },
    territoryScore: 19,
    rank: 1,
    rankPoints: 3,
    alive: true,
    eliminatedAtTick: null,
  });
});

it("全部点位控制提前胜利：终局 tick 计已执行数，获胜与自然淘汰如实保存", () => {
  const outcome = runTrialMatch({
    runners: [recordingStub({}), recordingStub({}), recordingStub({}), recordingStub({})],
    players,
    ruleset,
    map: {
      ...wiringMap,
      sites: wiringMap.sites.map((site) => ({ ...site, initialOwner: 0 })),
      spawnUnits: [{ owner: 0, type: "worker", offset: [1, 0] }],
    },
    seed: 202,
    matchIndex: 1,
    budget: {},
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "test" },
  });
  expect(outcome.terminalSummary).toMatchObject({ seed: 202, tick: 1, reason: "victory" });
  expect(
    outcome.terminalSummary?.players.map(({ rank, rankPoints, alive, eliminatedAtTick }) => ({
      rank,
      rankPoints,
      alive,
      eliminatedAtTick,
    })),
  ).toEqual([
    { rank: 1, rankPoints: 3, alive: true, eliminatedAtTick: null },
    { rank: 2, rankPoints: 1, alive: false, eliminatedAtTick: 0 },
    { rank: 2, rankPoints: 1, alive: false, eliminatedAtTick: 0 },
    { rank: 2, rankPoints: 1, alive: false, eliminatedAtTick: 0 },
  ]);
  expect(outcome.terminalSummary?.players[0].score).toEqual({ bases: 16, resources: 2, units: 0 });
});

it("异常淘汰后的捷径获胜：存活优先、后出局优先、并列占用名次并均分积分", () => {
  const trip = (at: number) =>
    recordingStub({ trips: [{ at, track: "uncaughtException", value: 1, limit: 0 }] });
  const outcome = runTrialMatch({
    runners: [trip(1), trip(2), trip(2), recordingStub({})],
    players,
    ruleset,
    map: wiringMap,
    seed: 303,
    matchIndex: 2,
    budget: { exceptionTickLimit: 1 },
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "test" },
  });
  expect(outcome.terminalSummary).toMatchObject({ tick: 2, reason: "shortcut" });
  expect(
    outcome.terminalSummary?.players.map(
      ({ territoryScore, rank, rankPoints, alive, eliminatedAtTick }) => ({
        territoryScore,
        rank,
        rankPoints,
        alive,
        eliminatedAtTick,
      }),
    ),
  ).toEqual([
    { territoryScore: 0, rank: 4, rankPoints: 0, alive: false, eliminatedAtTick: 0 },
    { territoryScore: 0, rank: 2, rankPoints: 1.5, alive: false, eliminatedAtTick: 1 },
    { territoryScore: 0, rank: 2, rankPoints: 1.5, alive: false, eliminatedAtTick: 1 },
    { territoryScore: 4, rank: 1, rankPoints: 3, alive: true, eliminatedAtTick: null },
  ]);
});

it("四方同 tick 淘汰仍保存真实 all-eliminated 并列结果，墙钟作废没有终局摘要", () => {
  const trip = () =>
    recordingStub({ trips: [{ at: 3, track: "uncaughtException", value: 1, limit: 0 }] });
  const options = {
    players,
    ruleset,
    map: wiringMap,
    seed: 101,
    matchIndex: 0,
    budget: { exceptionTickLimit: 1 },
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "test" },
  } satisfies Omit<Parameters<typeof runTrialMatch>[0], "runners">;
  const completed = runTrialMatch({ ...options, runners: [trip(), trip(), trip(), trip()] });
  expect(completed.terminalSummary).toMatchObject({ tick: 3, reason: "all-eliminated" });
  for (const player of completed.terminalSummary?.players ?? []) {
    expect(player).toMatchObject({
      territoryScore: 0,
      rank: 1,
      rankPoints: 1.5,
      alive: false,
      eliminatedAtTick: 2,
      // 异常淘汰清点位但保留场上单位；必须如实计造价，不以 alive=false 补零。
      controlledBases: 0,
      controlledResources: 0,
      survivingUnitCost: 4,
    });
  }
  const uncertain = runTrialMatch({
    ...options,
    runners: [
      recordingStub({ faultAt: 2 }),
      recordingStub({}),
      recordingStub({}),
      recordingStub({}),
    ],
  });
  expect(uncertain.fault).toEqual({ tick: 1 });
  expect(uncertain).not.toHaveProperty("terminalSummary");
});

it("timeout 存活优先于已淘汰高分方，异常留下的真实兵力和正领土分不补零", () => {
  const outcome = runTrialMatch({
    runners: [
      recordingStub({ trips: [{ at: 1, track: "uncaughtException", value: 1, limit: 0 }] }),
      recordingStub({}),
      recordingStub({}),
      recordingStub({}),
    ],
    players,
    ruleset: { ...ruleset, tickLimit: 2 },
    map: {
      ...wiringMap,
      spawnUnits: [
        { owner: 0, type: "cavalry", offset: [1, 0] },
        { owner: 0, type: "cavalry", offset: [0, 1] },
      ],
    },
    seed: 101,
    matchIndex: 0,
    budget: { exceptionTickLimit: 1 },
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "test" },
  });
  expect(outcome.terminalSummary).toMatchObject({ tick: 2, reason: "timeout" });
  expect(outcome.terminalSummary?.players[0]).toMatchObject({
    survivingUnits: { worker: 0, melee: 0, ranged: 0, cavalry: 2 },
    survivingUnitCost: 32,
    score: { bases: 0, resources: 0, units: 5 },
    territoryScore: 5,
    rank: 4,
    rankPoints: 0,
    alive: false,
    eliminatedAtTick: 0,
  });
  expect(
    outcome.terminalSummary?.players
      .slice(1)
      .map(({ territoryScore, rank, rankPoints }) => ({ territoryScore, rank, rankPoints })),
  ).toEqual([
    { territoryScore: 4, rank: 1, rankPoints: 2 },
    { territoryScore: 4, rank: 1, rankPoints: 2 },
    { territoryScore: 4, rank: 1, rankPoints: 2 },
  ]);
});
