/**
 * 步 1 的前半:按单位分组 + 定序(hld §4.3 第 1 步)。
 *
 * 钉住的那条**座位序是第一排序键**:单位级与玩家级混在同一个序列里排,
 * 「单位级整段在前、玩家级整段在后」会把跨座位的相对序排错。
 */

import { expect, it } from "vitest";

import { groupIntents, type DrainedIntents, type Intent } from "./intents.js";

const move = (unitId: number): Intent => ({ kind: "move", unitId, dx: 1, dy: 0 });
const spawn = (baseId: number): Intent => ({ kind: "spawnUnit", baseId, unitType: "melee" });

it("座位序是第一排序键:高座位的玩家级 intent 排在低座位的单位级之前", () => {
  const drained: readonly DrainedIntents[] = [
    { seat: 0, intents: [move(1)] },
    { seat: 1, intents: [] },
    { seat: 2, intents: [] },
    { seat: 3, intents: [spawn(3)] },
  ];
  // 「单位级整段在前、玩家级整段在后」的反例:那种排法会得到 [move(1), spawn(3)],
  // 于是座位 3 的生产单排在座位 0 的移动之前——而 hld §4.3 的第一排序键是 playerIndex。
  expect(groupIntents(drained)).toEqual([move(1), spawn(3)]);
});

it("同一座位内按对象数值 id 升序:单位级与玩家级混在**同一个序列**里排", () => {
  const drained: readonly DrainedIntents[] = [
    { seat: 0, intents: [move(9), spawn(7), move(2), spawn(4)] },
    { seat: 1, intents: [] },
    { seat: 2, intents: [] },
    { seat: 3, intents: [] },
  ];
  // 「单位级整段在前、玩家级整段在后」的反例:那种排法给的是 [move(2), move(9), spawn(4), spawn(7)]。
  // hld §4.3 的第二排序键是**对象数值 id**,与 intent 属于哪一级无关。
  expect(groupIntents(drained)).toEqual([move(2), spawn(4), spawn(7), move(9)]);
});

it("每单位只留最后一个,静默丢弃前几条(重复下单不计异常、不发事件)", () => {
  const drained: readonly DrainedIntents[] = [
    {
      seat: 0,
      intents: [
        move(1),
        { kind: "attack", unitId: 1, targetId: 5 },
        { kind: "harvest", unitId: 1, siteId: 3 },
      ],
    },
    { seat: 1, intents: [] },
    { seat: 2, intents: [] },
    { seat: 3, intents: [] },
  ];
  // 「取第一个」的反例:这一条红;而取错的后果是「哪一个有效」会挤掉「留哪一个」。
  expect(groupIntents(drained)).toEqual([{ kind: "harvest", unitId: 1, siteId: 3 }]);
});

it("分组是每座位各自的:两个座位的同号单位不互相顶替", () => {
  const drained: readonly DrainedIntents[] = [
    { seat: 0, intents: [move(1)] },
    { seat: 1, intents: [{ kind: "attack", unitId: 1, targetId: 5 }] },
    { seat: 2, intents: [] },
    { seat: 3, intents: [] },
  ];
  expect(groupIntents(drained)).toEqual([move(1), { kind: "attack", unitId: 1, targetId: 5 }]);
});

it("同一玩家对多个基地各下一单是合法的,它们之间不互相顶替", () => {
  const drained: readonly DrainedIntents[] = [
    { seat: 0, intents: [spawn(4), spawn(7)] },
    { seat: 1, intents: [] },
    { seat: 2, intents: [] },
    { seat: 3, intents: [] },
  ];
  expect(groupIntents(drained)).toEqual([spawn(4), spawn(7)]);
});
