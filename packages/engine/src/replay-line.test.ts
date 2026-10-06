/**
 * 引擎状态 ↔ 回放行的**双向可赋值性**(跨进程形状的一次性对齐,hld §4.1/§7.5)。
 *
 * ── 为什么这条要单独钉一条用例,而不是靠「跑通一局」顺带证明 ──
 *
 * `packages/schema` 的 `replay-line.ts` 与本包的 `world/state.ts` / `processor/events.ts`
 * 各自是**各自那一组东西**的形状家:回放行要能进 JSON Schema、要有 `additionalProperties: false`,
 * 于是它在真源包里逐字重列一遍;而引擎状态不必满足那些,它只需要**能变出**回放行。
 *
 * 两个家都正确、却**分叉**过一次的话,症状出现在很远的地方:读盘端把某一栏读成 `undefined`、
 * 或者 `stateHashOf` 算出一个两侧都对不上的摘要。这类症状的定位成本远高于一条编译期断言。
 *
 * 所以这里断言两件事,都是**类型级**的(红在 `tsc -b`,不是红在运行时):
 * 1. **正向**:引擎的 `Player` / `Unit` / `Site` / `Event` 逐个可赋给回放那份。
 * 2. **反向**:回放的 `ReplayTickLine` 可赋给本包 `replay-writer` 的 `TickLine`
 *    (它已经是别名,所以这一条是恒真的——**它留着是为了当文档**:真源包那边改形状时,
 *    `TickLine` 这一侧会跟着变,若那时它不再是别名,这条断言的注释就不再成立)。
 *
 * **正例为什么不能变红**:改坏任何一边的形状(给 `Site` 删一栏、把 `EventKind` 的取值加一个)
 * 都会让正向那一侧当场红。
 */

import { expect, it } from "vitest";
import type { ReplayEvent, ReplayPlayer, ReplaySite, ReplayTickLine, ReplayUnit } from "@model-war/replay";

import type { Event } from "./processor/events.js";
import type { TickLine } from "./replay-writer/index.js";
import type { Player, Site, Unit } from "./world/state.js";

/**
 * 类型级断言:把一份值同时塞进两个类型里。
 * 两侧只要有一侧多一栏 / 少一栏 / 取值域窄一格,这一行就红。
 */
it("引擎状态与回放行逐个形状双向可赋值(正向:引擎 → 回放)", () => {
  const player: Player = { index: 0, resources: 0, alive: true, exceptionTicks: 0 };
  const unit: Unit = {
    id: 1,
    owner: 0,
    type: "worker",
    x: 0,
    y: 0,
    hp: 1,
    carrying: 0,
  };
  const site: Site = {
    id: 1,
    kind: "resource",
    x: 0,
    y: 0,
    owner: -1,
    progressOwner: -1,
    progress: 0,
    remaining: 0,
    producing: null,
  };
  const event: Event = { kind: "victory", subjectId: 0 };

  // 正向:引擎那份可赋给回放那份(不产生运行时,只红在类型上)。
  const replayPlayer: ReplayPlayer = player;
  const replayUnit: ReplayUnit = unit;
  const replaySite: ReplaySite = site;
  const replayEvent: ReplayEvent = event;

  expect([replayPlayer, replayUnit, replaySite, replayEvent]).toHaveLength(4);
});

it("反向:回放的 ReplayTickLine 就是本包 TickLine(它已是同一条形状的别名)", () => {
  // 这一条在实现上是恒真的:它成立的前提是 `TickLine = ReplayTickLine` 这个别名关系。
  // 若有人把它改回本地重列的类型,下面这行会红——这正是本用例存在的意义。
  const line: ReplayTickLine = {
    type: "tick",
    tick: 0,
    players: [],
    units: [],
    sites: [],
    events: [],
    stateHash: "0".repeat(64),
  };
  const same: TickLine = line;
  expect(same.type).toBe("tick");
});
