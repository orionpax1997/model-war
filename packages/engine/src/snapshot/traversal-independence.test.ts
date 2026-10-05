/**
 * 深 freeze 与 `stateHash` 的规范化序列化**是两次遍历,不许合并**(hld §4.5)。
 *
 * 合并看起来省一半开销,代价是「这一 tick 冻没冻」开始依赖「这一 tick 算没算 hash」:
 * 某条路径算了 hash 没冻快照,某条路径冻了快照没算 hash,而这两条路径的差异只会在**脏写**
 * 真正发生时显形。规则层要的是「冻没冻」这件事与别的事情无关。
 *
 * ── 这个文件怎么把它钉住 ──
 *
 * 「两次遍历」不是一个能在返回值上看见的事实,所以这里用**两个可数的外部观察**把它钉住:
 * 1. **冻结次数**:`Object.freeze` 是一次可数的外部观察。`buildSnapshot` 对树里**每一个**
 *    对象/数组冻一次(这本身就是「深」的判据);而 `stateHashOf` 冻 0 次——哈希路径与冻结
 *    路径若共用一次遍历的实现,必然在这两个数里露出来。
 * 2. **源码不共用**:快照模块里不许**调用**哈希原语,哈希模块里不许**调用**冻结。
 *    合并成一次遍历最省事的写法正是把其中一个函数搬进另一个。
 * 这两条各自能红,且红的时机不同:第 1 条在有人把两趟塞进同一个递归时红,
 * 第 2 条在有人「为了少跑一趟」把规范化搬进 `freezeDeep` 时红。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stateHashOf, type JsonValue } from "@model-war/replay";
import { afterEach, expect, it, vi } from "vitest";

import { buildSnapshot } from "./snapshot.js";
import type { GameState, PlayerIndex, Site, Unit } from "../world/state.js";

const unit = (id: number): Unit => ({
  id,
  owner: 0,
  type: "worker",
  x: id,
  y: 0,
  hp: 2,
  carrying: 0,
});

const site = (id: number): Site => ({
  id,
  kind: "base",
  x: id,
  y: 0,
  owner: -1,
  progressOwner: -1,
  progress: 0,
  producing: null,
});

const makeState = (): GameState => ({
  tick: 3,
  players: [0, 1, 2, 3].map((index) => ({
    index: index as PlayerIndex,
    resources: 16,
    alive: true,
    exceptionTicks: 0,
  })),
  units: [unit(1), unit(2)],
  sites: [site(3), site(4)],
  nextId: 5,
  outcome: null,
});

/**
 * 树里对象/数组节点的个数:顶层 1 + players 数组 1 + 4 个玩家 + units 数组 1 + 2 个单位
 * + sites 数组 1 + 2 个点位 = 12。标量(`tick` 与各个字段)不是节点,`freezeDeep` 直接返回。
 */
const NODES = 12;

/** 注释里本来就会提到 `stateHash` 与「规范化」——**要判的是代码有没有共用,不是文字有没有提到**。 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

afterEach(() => {
  vi.restoreAllMocks();
});

it("深 freeze 对树里每一个节点冻一次(浅了就是这里红)", () => {
  const freeze = vi.spyOn(Object, "freeze");
  buildSnapshot(makeState());
  expect(freeze.mock.calls.length).toBe(NODES);
});

it("stateHashOf 一个节点也不冻:哈希路径与冻结路径不是同一次遍历", () => {
  const freeze = vi.spyOn(Object, "freeze");
  const payload: JsonValue = { tick: 3, units: [{ id: 1, hp: 2 }], sites: [] };
  stateHashOf(payload);
  // 合并成一次遍历的实现必然在这里冻出一串调用(或反过来一次都不冻),于是这个 0 会红。
  expect(freeze.mock.calls.length).toBe(0);
  // 另一半:冻结那一趟确实冻了整棵树(12 个节点),所以「0」不是「freeze 根本没被调过」。
  buildSnapshot(makeState());
  expect(freeze.mock.calls.length).toBe(NODES);
});

it("快照模块不调用哈希原语,哈希模块不调用冻结", () => {
  const sourceOf = (relative: string): string =>
    stripComments(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"));
  const snapshotCode = sourceOf("./snapshot.ts");
  const replayCode = sourceOf("../../../replay/src/index.ts");
  // 「为了少跑一趟」把规范化搬进 freezeDeep:这里红。
  expect(snapshotCode).not.toMatch(/stateHashOf|canonicalJson/);
  // 反向同理,把 freeze 搬进 canonicalJsonOf:这里红。
  expect(replayCode).not.toMatch(/freeze/i);
});
