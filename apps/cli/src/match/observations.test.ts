/**
 * 观测行的投影与去重(票 09):引擎载荷 → `observations.jsonl` 的行。
 *
 * 纯函数,不碰磁盘、不碰 VM——所以「每玩家每类只记首条」这条写出侧承诺不必拉起真沙箱就能钉住。
 */

import { expect, it } from "vitest";

import { observationLinesOf, type ObservationInput } from "./observations.js";

it("每玩家每类只记首条:同类第二条丢弃,另一类与另一座位各记各的", () => {
  const records: ObservationInput[] = [
    { tick: 3, seat: 0, kind: "wall-clock-soft", value: 5, limit: 4 },
    // 同座位同类第二条:丢弃(首触 tick 足够回答「有没有触发」)。
    { tick: 9, seat: 0, kind: "wall-clock-soft", value: 8, limit: 4 },
    // 同座位另一类:记(键是「座位 + 种类」,不是座位)。
    { tick: 9, seat: 0, kind: "memory-pressure", value: 10, limit: 9 },
    // 另一座位同类:记。
    { tick: 4, seat: 1, kind: "wall-clock-soft", value: 6, limit: 4 },
  ];
  expect(observationLinesOf(records)).toEqual([
    { type: "observation", tick: 3, seat: 0, kind: "wall-clock-soft", value: 5, limit: 4 },
    { type: "observation", tick: 9, seat: 0, kind: "memory-pressure", value: 10, limit: 9 },
    { type: "observation", tick: 4, seat: 1, kind: "wall-clock-soft", value: 6, limit: 4 },
  ]);
});

it("空输入交回空数组(「有没有观测」由调用方决定写不写盘)", () => {
  expect(observationLinesOf([])).toEqual([]);
});
