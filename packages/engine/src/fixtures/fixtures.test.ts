/**
 * 票 11 §2.5:三条桩结论(§8 #7 / #9 / #10)的**可跑夹具**在 check 链上的出口,
 * 外加首触探针(§2.3)的形状自检与 §2.4 的两条读数探针。
 *
 * ── 这一层做与不做的事 ──
 *
 * 做:让夹具**真的在真引擎上跑起来**、产出一个形状良好的读数、并钉住读数的基本不变量
 * (阈值单调、原因落在四个取值里、两臂的生产差异真的发生了)。
 *
 * **不做**:不写「应该落在某个区间」这类结论式断言——那会把复验结论提前塞进夹具,越界成结论。
 * 复验(在真引擎上以属性测试 / 基准门禁的形式对着 §8 那批桩读数判过/不过)归节点 L,
 * 见 `.scratch/engine-core/spec.md:207`、`docs/diagrams/v0-milestone-dag.md:227`(边 `F ⇢ L`)。
 *
 * ── 规模:默认小,读数按 env 放大 ──
 *
 * check 链上每跑一次都要便宜,所以每个探针的默认样本很小(每个夹具几场)。要复现
 * `.scratch/engine-core/readings.md` 里那批读数,把样本按 env 放大即可(命令写在读数文件里):
 *
 *     MW_FC_N=64 MW_DEP_N=8 MW_EG_N=4 MW_CAV_N=4 \
 *       MW_READINGS_DIR=runs/t11-readings \
 *       pnpm vitest run --project unit packages/engine/src/fixtures/fixtures.test.ts
 *
 * `MW_READINGS_DIR` 一设,探针就把读数落成 JSON 落到那个目录(`runs/**` 被 gitignore,
 * 所以读数文件里连着这条命令一起写)。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import type { MapDefinition, Ruleset } from "@model-war/replay";

import type { GameState, PlayerIndex } from "../world/state.js";
import { buildSnapshot } from "../snapshot/snapshot.js";
import { armOfSeat, cavalryPresenceOf, spawnTypeOfArm, type CavalryArm } from "./cavalry.js";
import { depletionOf } from "./depletion.js";
import { endgameFormOf } from "./endgame.js";
import { finalStateFirstContactOf, firstContactTickOf } from "./first-contact.js";
import { distributionOf, playMatch, runBatch, seedsFrom, tickLinesOf } from "./harness.js";
import { harvestEconomy, marchToNearestEnemy } from "./strategies.js";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${relative}`, import.meta.url)), "utf8");
const root = fileURLToPath(new URL("../../../../", import.meta.url));

const RULESET = JSON.parse(read("rulesets/v1.json")) as Ruleset;
const mapOf = (name: string): MapDefinition =>
  JSON.parse(read(`maps/${name}.json`)) as MapDefinition;

const SEATS: readonly PlayerIndex[] = [0, 1, 2, 3];
const MAPS = ["open-clash", "corridor-split", "fortress-core"] as const;

/** 样本规模:默认小,读数时按 env 放大。非法值退回默认,不静默取 0。 */
const envN = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** 读数落盘目录。**只有设了才写**——check 链上不该有文件副作用。 */
const readingsDir = process.env["MW_READINGS_DIR"];

const writeReading = (name: string, value: unknown): void => {
  if (readingsDir === undefined) {
    return;
  }
  mkdirSync(`${root}${readingsDir}`, { recursive: true });
  writeFileSync(
    `${root}${readingsDir}/${name}.json`,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
};

/** `buildSnapshot` 的入参形状,与 `snapshot/snapshot.ts` 的 `snapshotShapeOf` 逐栏一致。 */
const shapeOf = (state: GameState) => ({
  tick: state.tick,
  size: state.size,
  terrain: state.terrain,
  players: state.players,
  units: state.units,
  sites: state.sites,
});

it("首触探针(§2.3):路② 扫回放与路① 引擎记账同值,且首触落在 [0, tickLimit)", () => {
  const n = envN("MW_FC_N", 1);
  const readings: Record<string, unknown> = {};
  for (const name of MAPS) {
    const matches = runBatch({
      ruleset: RULESET,
      map: mapOf(name),
      seeds: seedsFrom(n),
      strategyOf: ({ seat }) => marchToNearestEnemy(seat),
    });
    for (const match of matches) {
      const fromReplay = firstContactTickOf(match.parsed);
      // 两条路是同一件事的两条读法:一条吃回放字节、一条吃引擎返回值。分叉即夹具或引擎有一处错。
      expect(fromReplay, `${name} 的首触:回放扫描与引擎记账分叉`).toBe(
        finalStateFirstContactOf(match),
      );
      expect(fromReplay).not.toBeNull();
      expect(fromReplay ?? -1).toBeGreaterThanOrEqual(0);
      expect(fromReplay ?? -1).toBeLessThan(RULESET.tickLimit);
    }
    const ticks = matches
      .map((match) => firstContactTickOf(match.parsed))
      .filter((tick): tick is number => tick !== null);
    readings[name] = {
      matches: matches.length,
      never: matches.length - ticks.length,
      ...distributionOf(ticks),
    };
  }
  writeReading("first-contact", readings);
}, 900_000);

it("夹具 #7(枯竭时点):25/50/75/100% 四个阈值从回放里量得出来,且次序不乱", () => {
  const matches = runBatch({
    ruleset: RULESET,
    map: mapOf("open-clash"),
    seeds: seedsFrom(envN("MW_DEP_N", 2)),
    strategyOf: ({ seat }) =>
      harvestEconomy(seat, RULESET, { spawnType: "worker", reinforce: true, maxUnits: 12 }),
  });
  const readings: unknown[] = [];
  for (const match of matches) {
    const reading = depletionOf(match, RULESET);
    // 全图总储量 = 资源点数量 × resourcePerSite(与桩 computeDepletion 同一分母)。
    expect(reading.total).toBeGreaterThan(0);
    expect(reading.remainingEndPct).toBeGreaterThanOrEqual(0);
    expect(reading.remainingEndPct).toBeLessThanOrEqual(100);
    const { p25, p50, p75, p100 } = reading.ticks;
    // 次序不乱:更深的阈值不可能先到。前一个未到(null)时后一个必须也未到。
    if (p50 !== null) {
      expect(p25).not.toBeNull();
      expect(p25 ?? Infinity).toBeLessThanOrEqual(p50);
    }
    if (p75 !== null) {
      expect(p50).not.toBeNull();
      expect(p50 ?? Infinity).toBeLessThanOrEqual(p75);
    }
    if (p100 !== null) {
      expect(p75).not.toBeNull();
      expect(p75 ?? Infinity).toBeLessThanOrEqual(p100);
    }
    readings.push(reading);
  }
  writeReading("depletion", readings);
}, 900_000);

it("夹具 #9(终局形态):收口原因落在四个取值里,结局 tick / 首淘汰 / 领先易手量得出来", () => {
  // 两条代理打法各跑几个种子:只追单位(多为超时)与推基地(能把对局推到淘汰那一档),
  // 与桩聚合器「跨矩阵聚合」的口径同形——夹具要的是形态分布,不是单一形态。
  const n = envN("MW_EG_N", 2);
  const matches = [
    ...runBatch({
      ruleset: RULESET,
      map: mapOf("open-clash"),
      seeds: seedsFrom(n),
      strategyOf: ({ seat }) =>
        harvestEconomy(seat, RULESET, {
          spawnType: "melee",
          reinforce: true,
          maxUnits: 6,
          objective: "units",
        }),
    }),
    ...runBatch({
      ruleset: RULESET,
      map: mapOf("open-clash"),
      seeds: seedsFrom(n, 101),
      strategyOf: ({ seat }) =>
        harvestEconomy(seat, RULESET, {
          spawnType: "melee",
          reinforce: true,
          maxUnits: 6,
          objective: "bases",
        }),
    }),
  ];
  const reasons: Record<string, number> = {};
  const readings: unknown[] = [];
  for (const match of matches) {
    const form = endgameFormOf(match, RULESET);
    reasons[form.reason] = (reasons[form.reason] ?? 0) + 1;
    expect(["victory", "shortcut", "timeout", "all-eliminated"]).toContain(form.reason);
    expect(form.outcomeTick).toBeGreaterThan(0);
    expect(form.outcomeTick).toBeLessThanOrEqual(RULESET.tickLimit);
    expect(form.before400).toBe(form.outcomeTick < 400);
    if (form.firstEliminationTick !== null) {
      expect(form.firstEliminationTick).toBeGreaterThanOrEqual(0);
      expect(form.firstEliminationTick).toBeLessThanOrEqual(form.outcomeTick);
    }
    expect(form.leaderChanges).toBeGreaterThanOrEqual(0);
    expect(typeof form.comeback).toBe("boolean");
    readings.push(form);
  }
  expect(reasons).not.toEqual({});
  writeReading("endgame", { reasons, forms: readings });
}, 900_000);

it("夹具 #10(骑兵开关):两臂只差生产序列,骑兵臂真的造了骑兵、对照臂一支未造", () => {
  const n = envN("MW_CAV_N", 1);
  const rows: {
    readonly arm: CavalryArm;
    readonly produced: boolean;
    readonly rank: number;
    readonly score: number;
    readonly outcomeTick: number;
    readonly timeout: boolean;
  }[] = [];
  for (const seed of seedsFrom(n)) {
    for (let rotation = 0; rotation < 4; rotation++) {
      const matches = runBatch({
        ruleset: RULESET,
        map: mapOf("open-clash"),
        seeds: [seed + rotation],
        strategyOf: ({ seat, ruleset }) =>
          harvestEconomy(seat, ruleset, {
            spawnType: spawnTypeOfArm(armOfSeat(seat, rotation)),
            reinforce: true,
            maxUnits: 8,
          }),
      });
      const match = matches[0];
      if (match === undefined) {
        continue;
      }
      const presence = cavalryPresenceOf(match);
      for (const seat of SEATS) {
        rows.push({
          arm: armOfSeat(seat, rotation),
          produced: presence[seat]?.everProduced ?? false,
          rank: match.result.rankings[seat] ?? 0,
          score: match.result.territoryScores[seat] ?? -1,
          outcomeTick: match.tickCount,
          timeout: match.result.reason === "timeout",
        });
      }
    }
  }
  const cavalryArm = rows.filter((row) => row.arm === "cavalry");
  const meleeArm = rows.filter((row) => row.arm === "melee");
  expect(cavalryArm.length).toBeGreaterThan(0);
  expect(meleeArm.length).toBe(cavalryArm.length);
  // 臂差真的落在生产序列上:骑兵臂每一席都出过骑兵,对照臂一支都没有。
  expect(cavalryArm.every((row) => row.produced)).toBe(true);
  expect(meleeArm.some((row) => row.produced)).toBe(false);
  for (const row of rows) {
    expect(row.rank).toBeGreaterThanOrEqual(1);
    expect(row.rank).toBeLessThanOrEqual(4);
    expect(row.score).toBeGreaterThanOrEqual(0);
  }
  writeReading("cavalry", rows);
}, 900_000);

it("读数探针(§2.4):回放体量与快照拷贝耗时都量得出来", () => {
  // ① 每 tick 的回放体量:600 tick 那一份的字节数 + 每 tick 平均。行数由回放自己报。
  const march = playMatch({
    ruleset: RULESET,
    map: mapOf("open-clash"),
    seed: 11,
    strategies: SEATS.map((seat) => marchToNearestEnemy(seat)),
  });
  const tickLines = tickLinesOf(march.parsed);
  const replayBytes = march.lines.reduce(
    (sum, line) => sum + Buffer.byteLength(line, "utf8") + 1,
    0,
  );
  expect(tickLines).toHaveLength(RULESET.tickLimit);
  expect(replayBytes).toBeGreaterThan(0);
  // 让 r"wc -c" 能对着同一份字节核对(readings.md 里连着这条命令一起写)。
  if (readingsDir !== undefined) {
    mkdirSync(`${root}${readingsDir}`, { recursive: true });
    writeFileSync(`${root}${readingsDir}/replay.jsonl`, `${march.lines.join("\n")}\n`, "utf8");
  }

  // ② 快照拷贝耗时:在一份**重状态**(把经济拉满的终局)上各连续 5 次取墙钟,
  //    「整体(buildSnapshot = 深拷贝 + 深 freeze)」与「只深拷贝」分开记。
  const heavy = playMatch({
    ruleset: RULESET,
    map: mapOf("open-clash"),
    seed: 11,
    strategies: SEATS.map((seat) =>
      harvestEconomy(seat, RULESET, { spawnType: "worker", reinforce: true, maxUnits: 12 }),
    ),
  });
  const snapshotSamples: number[] = [];
  const cloneSamples: number[] = [];
  for (let sample = 0; sample < 5; sample++) {
    let start = performance.now();
    buildSnapshot(heavy.finalState);
    snapshotSamples.push(performance.now() - start);
    start = performance.now();
    structuredClone(shapeOf(heavy.finalState));
    cloneSamples.push(performance.now() - start);
  }
  expect(distributionOf(snapshotSamples).p50).toBeGreaterThan(0);
  expect(distributionOf(cloneSamples).p50).toBeGreaterThan(0);

  writeReading("replay-volume", {
    tickLines: tickLines.length,
    bytes: replayBytes,
    bytesPerTick: replayBytes / tickLines.length,
  });
  writeReading("snapshot-copy", {
    units: heavy.finalState.units.length,
    sites: heavy.finalState.sites.length,
    buildSnapshotMs: snapshotSamples,
    structuredCloneMs: cloneSamples,
    buildSnapshotMedianMs: distributionOf(snapshotSamples).p50,
    structuredCloneMedianMs: distributionOf(cloneSamples).p50,
  });
}, 900_000);
