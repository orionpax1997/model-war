/**
 * 一个全局 id 空间(本修的核心不变量,hld §4.1)。
 *
 * 契约要求 `getObjectById(id: number): Unit | Site | null`(`docs/rules-v1/api.md`,
 * 类型面真源同在),一个 id 查出来要么是单位要么是点位。而点位号来自地图、单位号来自
 * `nextId`,所以 `createInitialState` 必须把 `nextId` 抬到所有地图号之上。这条不变量活了
 * 四张票没人发现,后果却是真对局里开局 8 个单位一个都打不到(同号点位把它们遮住)。
 *
 * 读的是**入库真源**:`rulesets/v1.json` 与三张 `maps/*.json`。手搓夹具会在真源取值分叉时照样绿。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import type { MapDefinition, Ruleset } from "@model-war/replay";

import { createInitialState } from "./initial-state.js";
import { apply } from "../driver/apply.js";
import { loadRuleset } from "../ruleset-loader/index.js";
import { checkAttack } from "../processor/combat.js";
import type { PlayerIndex } from "./state.js";

/** 本文件在 `packages/engine/src/world/`,到仓库根是四层:`world` → `src` → `engine` → `packages` → 根。 */
const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${relative}`, import.meta.url)), "utf8");

const RULESET = JSON.parse(read("rulesets/v1.json")) as Ruleset;
const RULESET_VIEW = loadRuleset(RULESET);
const MAPS = ["open-clash", "corridor-split", "fortress-core"].map(
  (name) => JSON.parse(read(`maps/${name}.json`)) as MapDefinition,
);

const idSet = (items: readonly { readonly id: number }[]): Set<number> =>
  new Set(items.map((item) => item.id));

const highestId = (items: readonly { readonly id: number }[]): number =>
  items.reduce((highest, item) => Math.max(highest, item.id), 0);

it.each(MAPS)("$name:开局 units ∪ sites 的 id 两两不同,单位号不与点位号重叠", (map) => {
  const state = createInitialState(RULESET, map);
  // 两两不同 ⇔ 并集里没有重复号(把两边拼起来再数一遍)。反例:把 `nextId` 改回 `ID_START` →
  // 开局单位拿 1..8,与点位号 1..8 撞,并集去重后少 8 个 → 这里变红。
  const ids = [...state.units, ...state.sites].map((object) => object.id);
  expect(new Set(ids).size).toBe(ids.length);
});

it.each(MAPS)("$name:开局单位真的打得着(拿初始单位的 id 当 targetId 通过)", (map) => {
  const state = createInitialState(RULESET, map);
  const target = state.units[0]!;
  // 造一个敌方近战单位贴着目标(切比雪夫距离 1 ≤ melee range 1),走对局中同一条 create-unit。
  const attackerOwner = ((target.owner + 1) % 4) as PlayerIndex;
  const withAttacker = apply(state, RULESET, {
    kind: "create-unit",
    owner: attackerOwner,
    unitType: "melee",
    x: target.x + 1,
    y: target.y,
  });
  const attacker = withAttacker.units.find((unit) => unit.id > highestId(state.units))!;
  // 拿**初始单位**的 id 当 `targetId`。反例:把 `nextId` 改回 `ID_START` → 该 id 落在点位号
  // 区间里,被同号点位遮住,`checkAttack` 返回 false → 这里红。这条钉住「开局 8 个单位一个都
  // 打不到」那个事故。
  expect(
    checkAttack(withAttacker, attackerOwner, RULESET_VIEW, {
      kind: "attack",
      unitId: attacker.id,
      targetId: target.id,
    }),
  ).toBe(true);
});

it.each(MAPS)("$name:对局中新建单位的号不与任何点位号相撞", (map) => {
  let state = createInitialState(RULESET, map);
  const siteIds = idSet(state.sites);
  for (let i = 0; i < 8; i += 1) {
    state = apply(state, RULESET, {
      kind: "create-unit",
      owner: 0,
      unitType: "worker",
      x: 0,
      y: 0,
    });
  }
  const created = state.units.slice(-8);
  expect(created).toHaveLength(8);
  for (const unit of created) {
    expect(siteIds.has(unit.id)).toBe(false);
  }
});

it.each(MAPS)("$name:点位号自身两两不同(地图数据的自洽性)", (map) => {
  expect(idSet(map.sites).size).toBe(map.sites.length);
});

/**
 * 一条哨兵:三张真图的点位号确实占据低端且含 0——`ID_START` 那句「0 留空」的旧说法据此作废。
 */
it("三张真图的点位号占据低端并含 0 号(ID_START 不是号空间下界)", () => {
  for (const map of MAPS) {
    const ids = [...idSet(map.sites)].sort((left, right) => left - right);
    expect(ids[0]).toBe(0);
    expect(ids.at(-1)).toBe(map.sites.length - 1);
  }
});
