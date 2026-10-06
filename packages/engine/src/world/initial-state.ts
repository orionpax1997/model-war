/**
 * 开局状态:把地图与规则集物化成一份 `GameState`(hld §4.1、gdd §5 初始条件)。
 *
 * 它**只经 `apply()` 造对象**,不直接拼状态:开局这一步与对局中出生一个单位是同一件事,
 * 走两条路就意味着「出生」有两条实现,而 HP、id 升序、携带量的默认值要各写一遍。
 *
 * 初始单位由地图声明(`spawnUnits`),引擎不硬编码:gdd §4 的点位与开局条件由地图承载,
 * 引擎只做「地图说了什么就摆什么」。
 */

import type { MapDefinition, Ruleset } from "@model-war/replay";
import { apply } from "../driver/apply.js";
import { ID_START } from "../driver/id-gen.js";
import {
  isUnitType,
  type GameState,
  type Owner,
  type PlayerIndex,
  type Site,
  type Terrain,
  type UnitType,
} from "./state.js";

const SEATS: readonly PlayerIndex[] = [0, 1, 2, 3];

/**
 * 地图书写里的墙格字符。与 `driver/random.ts` 的填充同一枚 `#`。
 *
 * 它是**地图格式**的一份事实,而地图格式的家在 `packages/schema`(`MapDefinition.terrain`
 * 的 JSON Schema 里那句 `'.'=平原,'#'=墙`)。这里不把它再命名一次成"真源":
 * 它只是把那一份说明转成布尔格时用到的字面量。
 */
const WALL_CHAR = "#";

/**
 * 地图的行字符串 → 状态的布尔格(见 `world/state.ts` 的 `Terrain` 注释)。
 *
 * 用 `split("")` 而不是 `[...row]`:地形字符只有 `#` 与 `.` 两个 ASCII,两者逐字相同,
 * 与 `driver/random.ts` 的同一处理同源。
 */
const toTerrain = (rows: readonly string[]): Terrain =>
  rows.map((row) => row.split("").map((cell) => cell === WALL_CHAR));

const isPlayerIndex = (value: number): value is PlayerIndex => SEATS.includes(value as PlayerIndex);

/** 地图声明的初始兵种名必须落在四条线之内。 */
const toUnitType = (name: string, owner: PlayerIndex): UnitType => {
  if (!isUnitType(name)) {
    throw new Error(`地图声明的初始兵种名 ${name} 不在四条兵种线之内(座位 ${String(owner)})`);
  }
  return name;
};

const toOwner = (owner: number | null): Owner =>
  owner !== null && isPlayerIndex(owner) ? owner : -1;

/**
 * 该方的主基地。地图不变量保证每方恰好一个主基地(gdd §4),所以这里缺了就是地图自身不自洽,
 * 而跨字段判据归 map-lint;本函数只做取用,不做校验。
 */
const mainBaseOf = (sites: readonly Site[], owner: PlayerIndex): Site => {
  const base = sites.find((site) => site.kind === "base" && site.owner === owner);
  if (base === undefined) {
    throw new Error(`地图没有为座位 ${String(owner)} 声明主基地`);
  }
  return base;
};

/**
 * 初始单位的取号起点:地图里所有点位号之上的第一个号,且不低于 `ID_START`。
 *
 * ── 为什么必须抬到地图号之上 ──
 * 契约要求**一个全局 id 空间**:`getObjectById(id: number): Unit | Site | null`
 * (`docs/rules-v1/api.md`,类型面真源与其一致),一个 id 查出来要么是单位要么是点位。
 * 而点位号来自地图(`create-site` 用 `change.id`、引擎不重编号),单位号从 `nextId` 起;
 * 两边各占一段**互不相交**的号段,这个输入返回值才有意义。不抬高,开局的 8 个单位就会拿到
 * 1..8、与点位号 1..8 撞个正着,同号的点位会把单位遮住——`attack` 的 `targetId`、`harvest` 的
 * `siteId`、`spawnUnit` 的 `baseId` 都按 id 在同两个数组里查,于是那些单位一个都用不到。
 *
 * ── 为什么不在 `create-unit` 里「跳号避开点位」 ──
 * 号段要由**开局一次**定下,而不是依赖「当前谁活着」或「地图此刻有几个点位」:id 语义是
 * 全局单调递增、含被销毁对象(hld §4.1)。开局把起点抬到所有地图号之上以后,对局中
 * `allocateId` 照旧只做「取号、号 + 1」,号段永远不会再落回地图号区间。
 *
 * ── 为什么落在这份初始字面量里而不是一条 `apply()` 变更 ──
 * 「抬高号段」是状态出生的一部分,不是对局中的一次写操作:它没有前一个状态可写,
 * 而给 `Change` 加一条只有开局用得上的登记,只会让「唯一写入口」那张表多一条噪声。
 */
const firstUnitId = (sites: readonly { readonly id: number }[]): number => {
  // 以 `ID_START - 1` 起手,于是没有点位的地图仍从 `ID_START` 起(地板,不塌陷)。
  let highest = ID_START - 1;
  for (const site of sites) {
    highest = Math.max(highest, site.id);
  }
  return highest + 1;
};

/**
 * 造开局状态。`units`/`sites` 已按数值 id 升序(由 `apply()` 维持,不是这里排的)。
 *
 * 四方开局条件严格对等(gdd §3.3):资金一律取规则集的 `initialResources`,不按座位打折——
 * 对等是地图几何的事,不是初始资金的事。
 */
export const createInitialState = (ruleset: Ruleset, map: MapDefinition): GameState => {
  let state: GameState = {
    tick: 0,
    size: map.size,
    terrain: toTerrain(map.terrain),
    players: SEATS.map((index) => ({
      index,
      resources: ruleset.initialResources,
      alive: true,
      exceptionTicks: 0,
    })),
    units: [],
    sites: [],
    nextId: firstUnitId(map.sites),
    outcome: null,
    firstContactTick: null,
    // 开局四席都在,无人被淘汰——四个 `null` 即「尚无淘汰时刻」。
    eliminatedAtTick: [null, null, null, null],
  };
  for (const site of map.sites) {
    state = apply(state, ruleset, {
      kind: "create-site",
      id: site.id,
      siteKind: site.kind,
      x: site.x,
      y: site.y,
      owner: toOwner(site.initialOwner),
    });
  }
  for (const spawn of map.spawnUnits) {
    const owner = toOwner(spawn.owner);
    if (!isPlayerIndex(owner)) {
      throw new Error(`地图声明的初始单位属主 ${String(spawn.owner)} 不是座位号`);
    }
    const base = mainBaseOf(state.sites, owner);
    state = apply(state, ruleset, {
      kind: "create-unit",
      owner,
      unitType: toUnitType(spawn.type, owner),
      x: base.x + spawn.offset[0],
      y: base.y + spawn.offset[1],
    });
  }
  return state;
};
