/**
 * 寻路(hld §4.7):确定、绕墙、不可达、固定方向与「不防割角」。
 *
 * 每条用例都配一句「改什么会让它红」,其中最重要的一条是**可采纳性**:启发式倍率放大之后,
 * A* 会把绕远路当成最优,于是 `绕墙的最短路` 那条从 7 项变 8 项,当场红。
 */

import { expect, it } from "vitest";

import { findPath } from "./find-path.js";
import type { Terrain } from "../world/state.js";

/** 行字符串 → 状态的布尔格;与 `createInitialState` 的转换同一条读法。 */
const terrainOf = (rows: readonly string[]): Terrain =>
  rows.map((row) => row.split("").map((cell) => cell === "#"));

/** 把路径折成可读串,断言失败时能直接看出走的是哪条路。 */
const render = (path: readonly { readonly x: number; readonly y: number }[] | null): string =>
  path === null
    ? "不可达"
    : path.map((point) => `(${String(point.x)},${String(point.y)})`).join(" ");

it("同一输入两次得到逐项相同的路径(确定性)", () => {
  // 这张图上「最优」与「绕远」的长度差 1,所以它同时是确定性与可采纳性的载体。
  const rows = ["....#..", "..#..#.", "..#....", ".....#.", ".##...#", ".......", "......."];
  const terrain = terrainOf(rows);
  const first = findPath(terrain, 7, { x: 2, y: 6 }, { x: 3, y: 0 });
  const second = findPath(terrain, 7, { x: 2, y: 6 }, { x: 3, y: 0 });
  expect(second).toEqual(first);
});

it("绕墙走最短路:长度等于最优(A* 不可绕远)", () => {
  const rows = ["....#..", "..#..#.", "..#....", ".....#.", ".##...#", ".......", "......."];
  const path = findPath(terrainOf(rows), 7, { x: 2, y: 6 }, { x: 3, y: 0 });
  expect(path, render(path)).not.toBeNull();
  // 起点与终点都在两端;6 步 = 7 项。
  expect(path?.[0]).toEqual({ x: 2, y: 6 });
  expect(path?.at(-1)).toEqual({ x: 3, y: 0 });
  // 「启发式放大到 ×4」的反例:实测这条会给出一条 8 项的路(绕到左半边再回来),于是这里红。
  expect(path, render(path)).toHaveLength(7);
});

it("直线被墙挡住时改道,且不穿墙", () => {
  const rows = ["..#..", "..#..", ".....", ".....", "....."];
  const terrain = terrainOf(rows);
  const path = findPath(terrain, 5, { x: 0, y: 0 }, { x: 4, y: 0 });
  expect(path, render(path)).not.toBeNull();
  // 不穿墙:路径里的每一格都不是墙。
  for (const point of path ?? []) {
    expect(terrain[point.y]?.[point.x], `路径穿墙于 (${String(point.x)},${String(point.y)})`).toBe(
      false,
    );
  }
  // 绕开 (2,0) 与 (2,1) 那两格需要多走:4 步到不了,最优是 4 步(对角绕角)。
  expect(path, render(path)).toHaveLength(5);
});

it("终点被墙围死 → 不可达(返回 null)", () => {
  const rows = [".....", ".###.", ".#.#.", ".###.", "....."];
  expect(findPath(terrainOf(rows), 5, { x: 0, y: 0 }, { x: 2, y: 2 })).toBeNull();
});

it("斜走只看目标格:两墙夹角的对角格可通行(不防割角)", () => {
  // (1,0) 与 (0,1) 都是墙,但目标 (1,1) 是平原。v1 的 CostMatrix 没有防割角这一条,
  // 故一步斜穿成立。把这条改成「防割角」会是一次规则变更,而不是重构——用这条把它钉住。
  const rows = [".#", "#."];
  const path = findPath(terrainOf(rows), 2, { x: 0, y: 0 }, { x: 1, y: 1 });
  expect(path, render(path)).toEqual([
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ]);
});

it("直走与斜走同为一步:全平原上一段直线逐格前进", () => {
  const rows = ["....", "....", "....", "...."];
  const path = findPath(terrainOf(rows), 4, { x: 0, y: 0 }, { x: 3, y: 0 });
  expect(path, render(path)).toEqual([
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 3, y: 0 },
  ]);
});

it("终点是墙或越界 → 不可达;起点与终点相同 → 只含起点的一项", () => {
  const rows = ["..#", "...", "..."];
  const terrain = terrainOf(rows);
  expect(findPath(terrain, 3, { x: 0, y: 0 }, { x: 2, y: 0 })).toBeNull();
  expect(findPath(terrain, 3, { x: 0, y: 0 }, { x: 9, y: 9 })).toBeNull();
  expect(findPath(terrain, 3, { x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([{ x: 1, y: 1 }]);
});
