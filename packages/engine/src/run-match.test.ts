/**
 * `runMatch`:一条命令跑完一整场空转对局(本票的第一道闸门,hld §2.2.6 脊柱)。
 *
 * 读的是**入库的真源**:`rulesets/v1.json` 与 `maps/open-clash.json`。不用手搓夹具的理由:
 * 真源取值与引擎读法一旦分叉(某个键改名、某张图少一个座位的主基地),手搓的夹具照样绿,
 * 而真机跑第一场就红。用真源让「跑得起来」这件事本身带着一次真源↔引擎的对账。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import type { MapDefinition, ReplayLine, Ruleset } from "@model-war/replay";

import { runMatch } from "./index.js";
import { stubRunner, type StubStrategy } from "./runner/stub.js";

/**
 * 本文件在 `packages/engine/src/`,到仓库根是三层:`src` → `engine` → `packages` → 根。
 */
const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), "utf8");

const RULESET = JSON.parse(read("rulesets/v1.json")) as Ruleset;
const MAP = JSON.parse(read("maps/open-clash.json")) as MapDefinition;

/** 空策略:什么都不交回,于是世界空转——本票要的正是这一局。 */
const idle = (): StubStrategy => () => [];

/** 四个座位的空桩执行器。 */
const idleRunners = () => [0, 1, 2, 3].map(() => stubRunner(idle()));

const collect = () => {
  const lines: string[] = [];
  return { lines, sink: { write: (line: string) => void lines.push(line) } };
};

const players = [
  { model: "alpha", archiveRef: "archive/alpha/r1", seat: 0 },
  { model: "beta", archiveRef: "archive/beta/r1", seat: 1 },
  { model: "gamma", archiveRef: "archive/gamma/r1", seat: 2 },
  { model: "delta", archiveRef: "archive/delta/r1", seat: 3 },
] as const;

it("跑完一整场到超时:meta 行在前、600 个 tick 行、result 行收尾", () => {
  const { lines, sink } = collect();
  const outcome = runMatch({
    ruleset: RULESET,
    map: MAP,
    seed: 20260101,
    head: { runner: "stub", timezoneOffset: "+08:00", mapHash: "a".repeat(64) },
    players,
    runners: idleRunners(),
    budget: {},
    sink,
  });

  const parsed = lines.map((line) => JSON.parse(line) as ReplayLine);
  // 1 + tickLimit + 1
  expect(lines).toHaveLength(1 + RULESET.tickLimit + 1);
  expect(parsed[0]?.type).toBe("meta");
  expect(parsed.at(-1)?.type).toBe("result");
  if (outcome.status !== "completed") {
    throw new Error("桩路径不应产生故障位");
  }
  expect(outcome.tickCount).toBe(RULESET.tickLimit);
  // tick 行从 0 到 599,逐个不缺不多(少一格就说明有一 tick 没被结算或没被写出)。
  const tickNumbers = parsed
    .filter((line): line is Extract<ReplayLine, { type: "tick" }> => line.type === "tick")
    .map((line) => line.tick);
  expect(tickNumbers).toHaveLength(RULESET.tickLimit);
  expect(tickNumbers.at(0)).toBe(0);
  expect(tickNumbers.at(-1)).toBe(RULESET.tickLimit - 1);
  // 「步 6 写的是刚结算完的那一 tick,步 6 之后状态才加一」:行号与 tick 差一格,这里只验它连续。
  for (const [index, tick] of tickNumbers.entries()) {
    expect(tick).toBe(index);
  }
});

it("末行 result:空转对局按 gdd 是全部并列的超时(不是空排名的占位)", () => {
  const { lines, sink } = collect();
  const outcome = runMatch({
    ruleset: RULESET,
    map: MAP,
    seed: 1,
    head: { runner: "stub", timezoneOffset: "+00:00", mapHash: "b".repeat(64) },
    players,
    runners: idleRunners(),
    budget: {},
    sink,
  });
  const result = outcome.status === "completed" ? outcome.result : undefined;
  if (result === undefined) {
    throw new Error("桩路径不应产生故障位");
  }
  expect(result.reason).toBe("timeout");
  // 全部并列是空转对局的**诚实答案**(四方领土分相同),而空数组会被叙事战报读成「打完了」。
  expect(result.rankings).toEqual([1, 1, 1, 1]);
  // 领土分不再是占位的 0:每人 1 基地(4) + 1 资源(1) + 2 农民(造价 4×2=8,⌊8/6⌋=1) = 6。
  expect(result.territoryScores).toEqual([6, 6, 6, 6]);
  // 写出的末行与返回的终局一致(两者是同一件事的两条读法)。
  expect(JSON.parse(lines.at(-1) ?? "{}")).toEqual(result);
});

it("meta 行落一次且在第一个 tick 之前;桩执行器的四个沙箱栏是 null", () => {
  const { lines, sink } = collect();
  runMatch({
    ruleset: RULESET,
    map: MAP,
    seed: 20260101,
    head: { runner: "stub", timezoneOffset: "+08:00", mapHash: "c".repeat(64) },
    players,
    runners: idleRunners(),
    budget: {},
    sink,
  });
  const metaLines = lines.filter((line) => JSON.parse(line).type === "meta");
  expect(metaLines).toHaveLength(1);
  const meta = JSON.parse(metaLines[0] ?? "{}") as Record<string, unknown>;
  expect(meta["runner"]).toBe("stub");
  expect(meta["quickjsWasiVersion"]).toBeNull();
  expect(meta["sandboxRuntimeHash"]).toBeNull();
});

it("同种子两次跑,回放逐行相同(复算的前提:确定性)", () => {
  const first = collect();
  const second = collect();
  const params = {
    ruleset: RULESET,
    map: MAP,
    seed: 20260101,
    head: { runner: "stub" as const, timezoneOffset: "+08:00" as const, mapHash: "d".repeat(64) },
    players,
    runners: idleRunners(),
    budget: {},
  };
  runMatch({ ...params, sink: first.sink });
  runMatch({ ...params, sink: second.sink });
  // 逐行逐字相同——不是「结构相同」,是同一份字节。stateHashOf 参与其中。
  expect(first.lines).toEqual(second.lines);
});
