/**
 * 「无得分来源」追踪器的纯判定：不经引擎、不起 VM。
 *
 * 快照用最小结构手工造：交付、占点、死亡、开局归属、他座位忽略，各一组。
 */

import { expect, it } from "vitest";

import { createScoreSourceTracker, type ScoreSourceSnapshot } from "./score-source.js";

const frame = (
  units: readonly [id: number, owner: number, carrying: number][],
  sites: readonly [id: number, owner: number][] = [],
): ScoreSourceSnapshot => ({
  units: units.map(([id, owner, carrying]) => ({ id, owner, carrying })),
  sites: sites.map(([id, owner]) => ({ id, owner })),
});

it("只采集、从不交付也不占点：命中无得分来源", () => {
  const tracker = createScoreSourceTracker(0);
  tracker.observe(frame([[1, 0, 0]], [[9, 0]]));
  tracker.observe(frame([[1, 0, 20]], [[9, 0]]));
  tracker.observe(frame([[1, 0, 20]], [[9, 0]]));
  expect(tracker.reading()).toEqual({ delivered: 0, captures: 0, noScoreSource: true });
});

it("载量下降即交付：采 20、交付 20，不命中", () => {
  const tracker = createScoreSourceTracker(0);
  tracker.observe(frame([[1, 0, 0]]));
  tracker.observe(frame([[1, 0, 20]]));
  tracker.observe(frame([[1, 0, 0]]));
  expect(tracker.reading()).toEqual({ delivered: 20, captures: 0, noScoreSource: false });
});

it("资源净变化不算交付：同 tick 的载量下降被计入，与花费无关", () => {
  const tracker = createScoreSourceTracker(0);
  tracker.observe(frame([[1, 0, 20]]));
  tracker.observe(frame([[1, 0, 5]]));
  expect(tracker.reading().delivered).toBe(15);
});

it("占点：中立点位变为本座位即计 1 次；开局已属本座位的基地不计", () => {
  const tracker = createScoreSourceTracker(2);
  tracker.observe(
    frame(
      [],
      [
        [0, 2],
        [5, -1],
      ],
    ),
  );
  tracker.observe(
    frame(
      [],
      [
        [0, 2],
        [5, 2],
      ],
    ),
  );
  expect(tracker.reading()).toEqual({ delivered: 0, captures: 1, noScoreSource: false });
});

it("敌方点位夺回也计占点；被夺走不计", () => {
  const tracker = createScoreSourceTracker(0);
  tracker.observe(frame([], [[3, 1]]));
  tracker.observe(frame([], [[3, 0]]));
  tracker.observe(frame([], [[3, 2]]));
  expect(tracker.reading().captures).toBe(1);
});

it("工人死亡时载量消失，不计交付", () => {
  const tracker = createScoreSourceTracker(0);
  tracker.observe(frame([[1, 0, 20]]));
  tracker.observe(frame([]));
  expect(tracker.reading()).toEqual({ delivered: 0, captures: 0, noScoreSource: true });
});

it("只看本座位：他座位的载量与占点一律忽略", () => {
  const tracker = createScoreSourceTracker(0);
  tracker.observe(
    frame(
      [
        [7, 1, 20],
        [8, 2, 0],
      ],
      [[4, 3]],
    ),
  );
  tracker.observe(
    frame(
      [
        [7, 1, 0],
        [8, 2, 0],
      ],
      [[4, 2]],
    ),
  );
  expect(tracker.reading()).toEqual({ delivered: 0, captures: 0, noScoreSource: true });
});
