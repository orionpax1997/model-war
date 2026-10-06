/**
 * `driver/random.ts` 的用例。
 *
 * 这个文件本身就是一次复查的产物:票 04 之前本模块**零测试**,于是一个真 bug 一路活到复查
 * ——`nextBelow` 拿 LCG 状态的**最低位**取模,而模 `2^31` 的 LCG(乘数与增量都是奇数)的
 * 最低位**每步必然翻转**:`bit0(state_{n+1}) = bit0(a·state_n + c) = bit0(state_n) XOR 1`。
 * `bound = 2` 时 `value % 2` 取的就是它,于是抽签恒是 `01010101`(或它的补),全仓种子只产得出
 * **两张**地图,由种子的奇偶决定,与取值无关。
 *
 * 用例分四层,每层针对一个具体的退化:
 * - **同种子同图 + 纯函数**:确定性是复算(NFR-1)的前提,而填充的入参不得被就地改写。
 * - **同奇偶种子不同图 / N 个种子里至少 3 张图**:上面那个 bug 的**反例**。改回
 *   `drawn.value % bound`,这两条当场红(实测读数见票 04 的 `## Answer`)。
 * - **消费顺序 = 槽位声明顺序**:同一种子下重排槽位必须换一张图,否则「顺序」就成了实现自由度,
 *   而 hld §4.6 把它定死为「变体槽位 id 升序」。
 * - **取值面与写入面**:抽签值域 `[0, bound)`、槽位只覆盖平原格、一条轨道四条坐标全填或全不填。
 *
 * 地形读**真源** `maps/open-clash.json`,与 `run-match.test.ts` 同一条理由:手搓夹具会在真源
 * 改名 / 改槽位数时照样绿,而真机跑第一场就红。本文件在 `packages/engine/src/driver/`,到仓库根四层。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import type { MapDefinition, MapVariantSlot } from "@model-war/replay";
import { RULESET_VERSION } from "@model-war/replay";

import { createRandom, fillVariantWalls, nextBelow, nextInt } from "./random.js";

const REAL_MAP = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../maps/open-clash.json", import.meta.url)), "utf8"),
) as MapDefinition;

/** 真源图的 8 条槽位——「消费顺序」那一条用它才有意义(一条槽位的图重排等于没重排)。 */
const SEEDS = [20260101, 20260102, 1, 2, 7, 8, 99, 100] as const;

/**
 * 手搓一张小图:本组用例要的「某格**开局就是墙**」与「坐标越界」两件事实,
 * 在真源图里既不好摆也不好读,而这两件事是写入面判据的全部内容。
 */
const synthetic = (
  terrain: readonly string[],
  variantSlots: readonly MapVariantSlot[],
): MapDefinition => ({
  name: "synthetic",
  size: terrain.length,
  rulesetMin: RULESET_VERSION,
  terrain,
  sites: [],
  spawnUnits: [],
  variantSlots,
});

/** 前 `count` 次槽位抽签的读数:与 `fillVariantWalls` 内部走同一条调用路径。 */
const drawsOf = (seed: number, count: number): number[] => {
  const draws: number[] = [];
  let state = createRandom(seed);
  for (let index = 0; index < count; index += 1) {
    const drawn = nextBelow(state, 2);
    draws.push(drawn.value);
    state = drawn.random;
  }
  return draws;
};

const terrainOf = (seed: number, map: MapDefinition = REAL_MAP): string =>
  fillVariantWalls(createRandom(seed), map).map.terrain.join("\n");

it("同一种子两次填充逐字节相同,且中间插入别的种子也不影响", () => {
  const first = terrainOf(20260101);
  terrainOf(2);
  expect(terrainOf(20260101)).toBe(first);
});

it("纯函数:填充不改写入参地图,填出来的是新对象", () => {
  const before = JSON.stringify(REAL_MAP);
  const filled = fillVariantWalls(createRandom(20260101), REAL_MAP);
  expect(filled.map).not.toBe(REAL_MAP);
  expect(filled.map.terrain).not.toBe(REAL_MAP.terrain);
  expect(JSON.stringify(REAL_MAP)).toBe(before);
});

it("地形由种子的取值驱动,不是只由奇偶驱动(本模块那个 bug 的反例)", () => {
  // 三对**同奇偶**的种子:低位取模下它们必然同图,必须分叉才说明取值真的进了映射。
  for (const [left, right] of [
    [1, 3],
    [2, 4],
    [20260101, 20260103],
  ] as const) {
    expect(left % 2, `种子 ${left}/${right} 必须同奇偶,否则钉不住奇偶这条退化`).toBe(right % 2);
    expect(drawsOf(left, 8)).not.toEqual(drawsOf(right, 8));
    expect(terrainOf(left)).not.toBe(terrainOf(right));
  }
});

it("8 个种子产出至少 3 张不同的地形(低位取模只产得出 2 张)", () => {
  const terrains = new Set(SEEDS.map((seed) => terrainOf(seed)));
  expect(terrains.size).toBeGreaterThanOrEqual(3);
});

it("消费顺序 = 槽位声明顺序:同一种子下重排槽位就换一张图", () => {
  const reversed: MapDefinition = {
    ...REAL_MAP,
    variantSlots: [...REAL_MAP.variantSlots].reverse(),
  };
  for (const seed of [1, 20260101, 99] as const) {
    expect(terrainOf(seed, reversed), `seed=${seed} 重排槽位后地图没变`).not.toBe(
      terrainOf(seed, REAL_MAP),
    );
  }
});

it("nextBelow 恒返回 [0, bound) 内的整数,bound = 1 时恒为 0", () => {
  for (const bound of [1, 2, 3, 5, 7, 1000]) {
    const values: number[] = [];
    let state = createRandom(20260101);
    for (let index = 0; index < 2000; index += 1) {
      const drawn = nextBelow(state, bound);
      values.push(drawn.value);
      state = drawn.random;
    }
    expect(
      values.every((value) => Number.isInteger(value)),
      `bound=${bound} 取到了非整数`,
    ).toBe(true);
    expect(Math.min(...values), `bound=${bound} 取到了负数`).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values), `bound=${bound} 取到了越界值`).toBeLessThan(bound);
    if (bound === 1) {
      // 值域只有一个数,但「只取一个数」和「抛了 / 取到负」是两回事,后者在上面的 min 里另有断言。
      expect(new Set(values)).toEqual(new Set([0]));
    }
  }
});

it("nextBelow 只消费一次 nextInt:取高位不额外走状态", () => {
  const random = createRandom(7);
  expect(nextBelow(random, 3).random).toEqual(nextInt(random).random);
});

it("一条槽位的四条坐标全填或全不填(一次抽签管一条完整旋转轨道)", () => {
  const slot = [
    [0, 0],
    [3, 0],
    [3, 3],
    [0, 3],
  ] as const;
  const map = synthetic(["....", "....", "....", "...."], [slot]);
  let filledSomewhere = false;
  for (let seed = 0; seed < 16; seed += 1) {
    const terrain = fillVariantWalls(createRandom(seed), map).map.terrain;
    const cells = slot.map(([x, y]) => terrain[y]?.[x]);
    expect(new Set(cells).size, `seed=${seed} 的四格不齐:${cells.join("")}`).toBe(1);
    filledSomewhere = filledSomewhere || cells[0] === "#";
  }
  // 反面证据:16 个种子一个都没填时,上面的断言是空转而不是真绿。
  expect(filledSomewhere, "没有任何种子填过墙,上面的断言空转").toBe(true);
});

it("槽位落在墙格或地图外的坐标:不抛、不越界写、不造出新格", () => {
  // (0,1) 开局就是墙——抽签只决定「填不填」,不决定「填成什么」;(5,0)/(0,5) 在地图外;
  // 只有 (0,3) 是本条槽位里真正的可填平原格。
  const slot = [
    [0, 1],
    [5, 0],
    [0, 3],
    [0, 5],
  ] as const;
  const rows = ["....", "#...", "....", "...."] as const;
  const map = synthetic(rows, [slot]);
  for (let seed = 0; seed < 16; seed += 1) {
    const filled = fillVariantWalls(createRandom(seed), map);
    const drawn = nextBelow(createRandom(seed), 2).value;
    expect(filled.map.terrain[1]?.[0]).toBe("#");
    expect(filled.map.terrain[3]?.[0]).toBe(drawn === 0 ? "#" : ".");
    // 越界那一格既没抛,也没把行撑长、把行数撑多。
    expect(filled.map.terrain.map((row) => row.length)).toEqual(rows.map((row) => row.length));
  }

  // 一条槽位四格全在地图外:地形与种子无关地一字不改。
  const offMap = synthetic(rows, [
    [
      [9, 9],
      [5, 5],
      [7, 0],
      [0, 7],
    ] as const,
  ]);
  for (let seed = 0; seed < 8; seed += 1) {
    expect(fillVariantWalls(createRandom(seed), offMap).map.terrain).toEqual([...rows]);
  }
});
