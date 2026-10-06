/**
 * **顺序即规范**(hld §4.3:「以上顺序与 §4.4 的裁决细则写入 `docs/rules-v1`(FR-10 AC3)。
 * 任何顺序调整都是规则变更」)。
 *
 * 步号落在 `STEPS` 这张表的**下标**上,所以「顺序」是一件能被直接断言的数据,而不是一件
 * 只能靠整体行为去反推的事。本文件把三处顺序都钉住:
 * 1. `STEPS` 的步序(0–7);
 * 2. 步 5 内部四段判定的顺序(gdd《胜利与淘汰》的「判定即规范」);
 * 3. 「把第七步提到第六步前面」这件事**确实会改变可观察结果**——否则第 1 条只是一句断言,
 *    证明不了那张表真的参与计算。
 *
 * 外加两条管线级的不变量:事件流现在是空的但**定序规则立住了**(七步各只调收集器的具名方法),
 * 以及状态里的一切对象数组**每 tick 结束时**按数值 id 升序维护。
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import type { Ruleset } from "@model-war/replay";

import { apply } from "../driver/apply.js";
import { loadRuleset } from "../ruleset-loader/index.js";
import { stubRunner } from "../runner/stub.js";
import { STEPS, processTick } from "./index.js";
import { initialContext } from "./context.js";
import { createEventCollector } from "./events.js";
import { EVALUATE_STAGE_NAMES, EVALUATE_STAGES } from "./steps/step5-evaluate.js";
import { step6Emit } from "./steps/step6-emit.js";
import { step7LoopGuard } from "./steps/step7-loop-guard.js";
import type { GameState, Owner, PlayerIndex, Site, Unit } from "../world/state.js";

const RULESET: Ruleset = {
  tickLimit: 600,
  captureTicks: 10,
  initialResources: 16,
  harvestRate: 1,
  carryLimit: 20,
  resourcePerSite: 200,
  worker: { cost: 4, hp: 2, damage: 0, range: 1, speed: 1, spawnTicks: 2 },
  melee: { cost: 8, hp: 12, damage: 3, range: 1, speed: 1, spawnTicks: 4 },
  ranged: { cost: 12, hp: 4, damage: 2, range: 2, speed: 1, spawnTicks: 6 },
  cavalry: { cost: 16, hp: 6, damage: 2, range: 1, speed: 2, spawnTicks: 8 },
  baseScore: 4,
  resourceScore: 1,
  unitCostDivisor: 6,
  exceptionTickLimit: 0,
  eventTickLimit: 0,
  apiCallTickLimit: 0,
  memoryLimit: 0,
  memoryTickCeiling: 0,
  wallClockSoftLimit: 0,
  wallClockHardTimeout: 0,
  scriptSizeLimit: 0,
};

const unit = (id: number): Unit => ({
  id,
  owner: 0,
  type: "worker",
  x: id,
  y: 0,
  hp: 2,
  carrying: 0,
});

const site = (id: number, owner: Owner): Site => ({
  id,
  kind: "base",
  x: id,
  y: 0,
  owner,
  progressOwner: -1,
  progress: 0,
  producing: null,
});

const makeState = (tick = 0): GameState => ({
  tick,
  size: 8,
  // 全平原:这些用例不碰移动裁决,地形只要合法即可。
  terrain: Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => false)),
  players: [0, 1, 2, 3].map((index) => ({
    index: index as PlayerIndex,
    resources: 16,
    alive: true,
    exceptionTicks: 0,
  })),
  units: [unit(1), unit(2)],
  // 四席各持一个主基地:本文件测的是步序,需要一个「无淘汰、无全点位胜、可跑满到超时」的状态。
  sites: [site(3, 0), site(4, 1), site(5, 2), site(6, 3)],
  nextId: 7,
  outcome: null,
  // 本用例四席都在,无人被淘汰。
  eliminatedAtTick: [null, null, null, null],
  firstContactTick: null,
  economyDeadAtTick: [null, null, null, null],
});

const idleRunners = () => [
  stubRunner(() => []),
  stubRunner(() => []),
  stubRunner(() => []),
  stubRunner(() => []),
];

const collectingSink = () => {
  const lines: string[] = [];
  return { sink: { write: (line: string) => lines.push(line) }, lines };
};

it("八步按 hld §4.3 的 0–7 排,下标即步号", () => {
  expect(STEPS).toHaveLength(8);
  expect(STEPS.map((step) => step.name)).toEqual([
    "step0Dispatch",
    "step1Validate",
    "step2Movement",
    "step3Combat",
    "step4ObjectTick",
    "step5Evaluate",
    "step6Emit",
    "step7LoopGuard",
  ]);
});

it("把第七步提到第六步前面 → 变红(它确实参与计算,不是装饰)", () => {
  const { sink, lines } = collectingSink();
  const ruleset = loadRuleset(RULESET);
  // 正常顺序:最后一个被结算的 tick 是 tickLimit-1,步 6 加一,步 7 看到 tickLimit → 写超时 outcome。
  const correct = processTick(makeState(599), idleRunners(), ruleset, sink);
  expect(correct.state.outcome?.reason).toBe("timeout");
  expect(correct.state.tick).toBe(600);
  // 换序之后:步 7 先跑,它看到的是 599,于是判不出超时、写不下 outcome,收官晚一 tick。
  const swapped = [step7LoopGuard, step6Emit].reduce(
    (now, step) => step(now),
    initialContext(ruleset, idleRunners(), sink, createEventCollector(), makeState(599)),
  );
  expect(swapped.state.outcome).toBeNull();
  // 写出的那一行也跟着错位:tick 栏从 599 变成 600。
  expect(JSON.parse(lines[0] ?? "{}")["tick"]).toBe(599);
});

it("步 5 的四段判定按 gdd《胜利与淘汰》的顺序排:先淘汰、再回归中立、再全点位、最后捷径兜底", () => {
  expect(EVALUATE_STAGES).toHaveLength(EVALUATE_STAGE_NAMES.length);
  expect(EVALUATE_STAGES).toHaveLength(4);
  // 顺序即规范:gdd 写死的是「先判淘汰 → 点位回归中立 → 再判全点位归属 → 最后判捷径条款」。
  expect(EVALUATE_STAGE_NAMES[0]).toMatch(/淘汰/);
  expect(EVALUATE_STAGE_NAMES[1]).toMatch(/回归中立/);
  expect(EVALUATE_STAGE_NAMES[2]).toMatch(/全点位归属/);
  // 「把捷径条款提到全点位之前」的反例:段序被改时这两条一起红。
  expect(EVALUATE_STAGE_NAMES[3]).toMatch(/捷径条款/);
  expect(EVALUATE_STAGE_NAMES[3]).toMatch(/兜底/);
});

it("七步各只调收集器的具名方法:没有任何一步往事件数组里 push", () => {
  const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
  const stepsDir = here("./steps");
  const files = readdirSync(stepsDir).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
  expect(files).toHaveLength(8);
  for (const name of files) {
    const code = readFileSync(`${stepsDir}/${name}`, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // 事件流的唯一出口是收集器;谁往数组里 push,定序规则就有一条旁路。
    expect(code, `${name} 不许往事件数组里 push`).not.toMatch(/\.push\(/);
  }
});

it("事件流现在就是空的,但「同一构造两次得到逐项相同的事件序列」立住了", () => {
  const ruleset = loadRuleset(RULESET);
  const { sink } = collectingSink();
  const first = processTick(makeState(3), idleRunners(), ruleset, sink);
  const second = processTick(makeState(3), idleRunners(), ruleset, sink);
  expect(first.events).toEqual([]);
  // 这条在事件流有内容之后才是它本来的那条断言;现在它是**回归基**:
  // 哪天某一步开始往数组里 push 或绕过收集器,两次构造就不再逐项相同。
  expect(second.events).toEqual(first.events);
});

it("对象数组每 tick 结束时按数值 id 升序维护——断言的对象是状态本身,不是写出的行", () => {
  // 点位的号来自地图,引擎不重编号,所以乱序插入是真实可能发生的。
  const built = apply(makeState(), RULESET, {
    kind: "create-site",
    id: 2,
    siteKind: "base",
    x: 9,
    y: 9,
    owner: -1,
  });
  const ascending = (items: readonly { readonly id: number }[]): number[] =>
    items.map(({ id }) => id);
  expect(ascending(built.sites)).toEqual([...ascending(built.sites)].sort((l, r) => l - r));
  expect(ascending(built.units)).toEqual([...ascending(built.units)].sort((l, r) => l - r));
  // 「只在写出前排一次」的反例:写出路径上排一遍会让这一条红,因为写出的行排好了,状态没排。
  const result = processTick(built, idleRunners(), loadRuleset(RULESET), collectingSink().sink);
  expect(ascending(result.state.sites)).toEqual(
    [...ascending(result.state.sites)].sort((l, r) => l - r),
  );
});

it("步 6 写出的那一行带的是刚结算完的这一 tick,步 6 之后状态才加一", () => {
  const { sink, lines } = collectingSink();
  const result = processTick(makeState(11), idleRunners(), loadRuleset(RULESET), sink);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? "{}")["tick"]).toBe(11);
  expect(result.state.tick).toBe(12);
});
