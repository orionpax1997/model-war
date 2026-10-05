/**
 * 执行器缝与 `StubRunner`(hld §4.5,ADR-0005)。
 *
 * 钉住三件事:桥名由 `HOST_BRIDGE_PREFIX` 拼出(不是手写字面量)、缝只有两次桥调用
 * (没有基类/工厂/生命周期)、`StubRunner` 同样做「拷一份快照、拿到 intent 数组」两件事。
 */

import { HOST_BRIDGE_PREFIX } from "@model-war/replay";
import { expect, it } from "vitest";

import { HOST_BRIDGE_DRAIN_INTENTS, HOST_BRIDGE_SET_SNAPSHOT, type SeatRunner } from "./index.js";
import { stubRunner } from "./stub.js";
import type { Snapshot } from "../world/state.js";

const snapshotOf = (tick: number): Snapshot => ({ tick, players: [], units: [], sites: [] });

it("两个桥名由真源包的宿主桥前缀拼出,与静态校验器那条 `__*` 禁令是同一道纪律", () => {
  // 手写字面量 "__setSnapshot" 的反例:改这里的实现让名字脱离前缀常量,这一条红,
  // 而红的原因是「静态全禁 `__*`」与「宿主注入什么」这两半对不上了。
  expect(HOST_BRIDGE_PREFIX).toBe("__");
  expect(HOST_BRIDGE_SET_SNAPSHOT).toBe("__setSnapshot");
  expect(HOST_BRIDGE_DRAIN_INTENTS).toBe("__drainIntents");
});

it("缝只有两个方法:没有 load / dispose / turn,没有 Runner 基类", () => {
  const runner: SeatRunner = stubRunner(() => []);
  // 「顺手加一个生命周期方法」的反例:这一条红。ADR-0005 逐条裁掉的正是这一类。
  expect(Object.keys(runner).sort()).toEqual(["drainIntents", "setSnapshot"]);
});

it("策略经 setSnapshot 拿到快照、经 drainIntents 交回 intent 数组", () => {
  const seen: Snapshot[] = [];
  const runner = stubRunner((snapshot) => {
    seen.push(snapshot);
    return [{ kind: "move", unitId: 1, dx: 1, dy: 0 }];
  });
  runner.setSnapshot(snapshotOf(4));
  expect(runner.drainIntents()).toEqual([{ kind: "move", unitId: 1, dx: 1, dy: 0 }]);
  // 「抄近路直接读引擎状态」的反例:策略拿到的必须是**快照**,
  // 少掉 nextId 与 outcome 两栏(Snapshot 是逐字列出的,不是 Pick<GameState>)。
  expect(seen).toHaveLength(1);
  expect(seen[0]).not.toHaveProperty("nextId");
  expect(seen[0]).not.toHaveProperty("outcome");
});

it("空数组也是一种合法交回:这一 tick 什么都不做", () => {
  const runner = stubRunner(() => []);
  runner.setSnapshot(snapshotOf(0));
  expect(runner.drainIntents()).toEqual([]);
});

it("协议误用当场抛:setSnapshot 之前 drain、或者一个 tick drain 两次", () => {
  const beforeSet = stubRunner(() => []);
  expect(() => beforeSet.drainIntents()).toThrow();

  const twice = stubRunner(() => []);
  twice.setSnapshot(snapshotOf(0));
  twice.drainIntents();
  // 「drain 可以随便调」的反例:这一条红。一个 tick 一次 `__drainIntents()` 是协议,
  // 调错要在缝上停住,而不是渗进结算。
  expect(() => twice.drainIntents()).toThrow();
  // 下一个 tick 重新武装:「一个 tick 一次」是每 tick 计一次,不是整局只准一次。
  twice.setSnapshot(snapshotOf(1));
  expect(twice.drainIntents()).toEqual([]);
});

it("策略自己抛异常时,这一 tick 仍然算「已经交回过一次」", () => {
  const runner = stubRunner(() => {
    throw new Error("脚本炸了");
  });
  runner.setSnapshot(snapshotOf(0));
  expect(() => runner.drainIntents()).toThrow("脚本炸了");
  // 异常路径把它放行到第二次 drain 的反例:一个异常变成两个,异常计数会翻倍。
  expect(() => runner.drainIntents()).toThrow(/一个 tick/);
});
