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
