/**
 * 确定性验收(FR-2 AC1)与回放可复算的数据面(票 11 的第一、第二条)。
 *
 * ── 它为什么跑在 `unit` project 里 ──
 *
 * 票面第 1 条 AC 写「这条要挂在门禁里,不只是一次性跑通」。本仓的门禁链 `check`
 * (`package.json:32`)显式跑 `vitest run --project unit --project property`,而 `test`
 * (`package.json:12`)也跑 `unit`。所以放在这里 = **check 链上每次必执行**,不可能静默回退。
 *
 * 为什么**不**新建一个 `check:determinism` 门禁脚本:`.scratch/engine-core/spec.md:271` 与
 * `docs/diagrams/v0-milestone-dag.md:173`(节点 L)把「集成门禁(端到端 + `verify` + 重跑 10 次
 * hash)」整格划给 L,而其中 `verify` 归节点 G、本票不实现。本票交的是**check 链上的可执行
 * 验收**;把它接进 L 的 CI 集成门禁(L 那一格)是后续接线,这里留指针,不抢它的定义。
 *
 * ── 三条用例的关系 ──
 *
 * 1. 十次重跑、每 tick `stateHash` 全等:测「引擎对自己稳定」。
 * 2. 回放可复算:把**已落盘的回放**(字符串)读回来抽出的哈希列,与**重新执行**得到的列相同:
 *    测「回放里记的东西足以复算出同一结论」。两条测的不是一件事(数据够 vs 引擎稳定)。
 * 3. 反向自证:换一个真的不确定源,同一条「十列全等」的断言**变红**——证明它不是空断言。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import type { MapDefinition, ReplayLine, Ruleset } from "@model-war/replay";

import { runMatch } from "./index.js";
import { stateHashesOf } from "./fixtures/harness.js";
import { marchToNearestEnemy } from "./fixtures/strategies.js";
import type { StubStrategy } from "./runner/stub.js";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), "utf8");

const RULESET = JSON.parse(read("rulesets/v1.json")) as Ruleset;
const MAP = JSON.parse(read("maps/open-clash.json")) as MapDefinition;

const players = [
  { model: "proxy-0", archiveRef: "archive/proxy-0/r1", seat: 0 },
  { model: "proxy-1", archiveRef: "archive/proxy-1/r1", seat: 1 },
  { model: "proxy-2", archiveRef: "archive/proxy-2/r1", seat: 2 },
  { model: "proxy-3", archiveRef: "archive/proxy-3/r1", seat: 3 },
] as const;

const head = { runner: "stub", timezoneOffset: "+00:00", mapHash: "e".repeat(64) } as const;

/** 跑一局、交回解析后的行。策略由调用方现造——闭包里可能带记忆,不许跨局共享。 */
const runOnce = (strategies: readonly StubStrategy[]): readonly ReplayLine[] => {
  const lines: string[] = [];
  runMatch({
    ruleset: RULESET,
    map: MAP,
    seed: 20260101,
    head,
    players,
    strategies,
    sink: { write: (line) => void lines.push(line) },
  });
  return lines.map((line) => JSON.parse(line) as ReplayLine);
};

/**
 * 一条与既有 2 次版同源的会动策略:全军朝最近的敌方单位走。取它而不是空转,
 * 是因为它每 tick 都改 `units` 并产出 `first-contact` 事件——十次重跑比的是整条哈希链,
 * 让这条链上有移动、有竞争裁决、有事件,断言才有内容。
 * 十次各造一份新策略闭包(`harvestEconomy` 那份有跨 tick 记忆,本用例用它做副渠道)。
 */
const movingStrategies = (): readonly StubStrategy[] =>
  [0, 1, 2, 3].map((seat) => marchToNearestEnemy(seat as 0 | 1 | 2 | 3));

it("FR-2 AC1:同配置重跑 10 次,每 tick 的 stateHash 十列全等", () => {
  const columns: (readonly string[])[] = [];
  for (let run = 0; run < 10; run++) {
    const parsed = runOnce(movingStrategies());
    // 1 + tickLimit + 1:meta + 每个 tick 一行 + result。少一格就说明某一 tick 没写出来。
    expect(parsed).toHaveLength(1 + RULESET.tickLimit + 1);
    columns.push(stateHashesOf(parsed));
  }
  const first = columns[0];
  expect(first).toHaveLength(RULESET.tickLimit);
  // 逐列比:不是「第一列像」,是每一列都与第一列相等。十列里任何一列与别的列岔开,这里就红。
  for (const [run, column] of columns.entries()) {
    expect(column, `第 ${String(run + 1)} 次重跑的 stateHash 列与第一次不一致`).toEqual(first);
  }
}, 120_000);

it("FR-2 AC1 的材质是有内容的:那十列不是一片常量", () => {
  // 「十列全等」若发生在「每 tick 哈希都一样」的退化回放上,它证明不了什么。
  const column = stateHashesOf(runOnce(movingStrategies()));
  expect(new Set(column).size).toBeGreaterThan(1);
}, 120_000);

it("回放可复算:从已落盘回放读出的哈希列,与重新执行得到的列逐字相同", () => {
  // 第一次跑,把行序列化成「已落盘回放」的那一份字节,再解析回来——这就是读盘端手上有的东西。
  const landed = runOnce(movingStrategies());
  const landedBytes = landed.map((line) => JSON.stringify(line)).join("\n");
  const reparsed = landedBytes.split("\n").map((line) => JSON.parse(line) as ReplayLine);

  // 第二次重新执行(同一份入参、同一批新策略)。
  const rerun = runOnce(movingStrategies());

  // 这两条测的不是一件事:上一条测「引擎对自己稳定」,这一条测「回放里记的足以复算出同一结论」。
  expect(stateHashesOf(reparsed)).toEqual(stateHashesOf(rerun));
  // 数据面还要够:逐 tick 的 payload 也要能读回来(不只是哈希栏)。
  const tickOf = (parsed: readonly ReplayLine[], tick: number) =>
    parsed.find((line) => line.type === "tick" && line.tick === tick);
  expect(tickOf(reparsed, 0)).toEqual(tickOf(rerun, 0));
}, 120_000);

it("反向自证:换一个真不确定源,同一条十列断言会红(它不是空断言)", () => {
  // 真正的例外:策略的输出依赖「这是第几次跑」。同一个配置因此得到不同回放——
  // 这正是 FR-2 AC1 要挡的那类不确定源(按进程内计数器)。
  let run = 0;
  const drifting = (): StubStrategy => {
    const index = run;
    run += 1;
    return (snapshot) => {
      const unit = snapshot.units.find((candidate) => candidate.owner === 0);
      if (unit === undefined) {
        return [];
      }
      const dx = index % 2 === 0 ? -1 : 1;
      return [{ kind: "move", unitId: unit.id, dx, dy: 0 }];
    };
  };
  const idle: StubStrategy = () => [];
  const first = stateHashesOf(runOnce([drifting(), idle, idle, idle]));
  const second = stateHashesOf(runOnce([drifting(), idle, idle, idle]));
  expect(first).not.toEqual(second);
}, 120_000);
