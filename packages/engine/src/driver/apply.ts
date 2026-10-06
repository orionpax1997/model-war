/**
 * `apply()`:状态的唯一写入口(hld §3.1 `engine:driver` 那一格、hld §4.1)。
 *
 * ── 为什么是「变更单 + 纯函数」而不是「就地改状态」 ──
 *
 * 「唯一写入口」这句话要能被检查,就不能只是一个约定。改成:状态里的一切字段都是 `readonly`,
 * 而**唯一**一个能造出新状态的函数是 `apply(state, ruleset, change)`;变更的全部可能形式是一张
 * **判别联合**,它的穷尽性由编译期 `never` 兜住。于是两条事实同时成立:
 * - 「有哪些写操作」是**一张枚举**,不是散落在代码各处的赋值语句;想加一种写操作必须先在这里登记。
 * - 「某个阶段改了状态」是**数据**,不是控制流——所以结算管线里任何一步都能被断言「它只发了哪些变更」。
 *
 * 为什么 `apply` 收规则集:单位出生时的 HP 来自规则集而不是调用方传进来的数字,
 * 这样「HP 不出现在结构里」(hld §4.1)在**类型层**就成立——`create-unit` 变更单里没有 hp 这一栏可填。
 *
 * ── 两条由本模块维持的不变量 ──
 * 1. **id 升序**:插入走有序插入、删除走过滤,所以 `units`/`sites` 在**每一步之后**都是升序的,
 *    而不是只在写出前排一次(hld §4.1)。
 * 2. **id 全局单调递增**:号从 `state.nextId` 取,销毁不归还号。
 */

import type { Ruleset } from "@model-war/replay";
import { allocateId } from "./id-gen.js";
import type {
  GameState,
  Owner,
  PlayerIndex,
  Site,
  SiteKind,
  Unit,
  UnitType,
} from "../world/state.js";

/**
 * 一次状态变更。这是状态**唯一**的写入口所收的那张表。
 *
 * 02a 只登记自己用得到的四种:建点位、建单位、销毁单位、移动单位;占领进度(票 05)随后追加。
 * 剩下的机制(扣款、产线推进、异常计数)随各自的机制票追加到这张表上——**走同一条登记**,
 * 于是「唯一写入口」在整局里始终是一句能被检查的话。
 */
export type Change =
  | {
      readonly kind: "create-site";
      /**
       * 点位的号由**地图**给出,不走 `nextId`:地图数据自带 id,引擎不重编号。
       * 所以开局必须先把 `nextId` 抬到所有地图号之上(见 `world/initial-state.ts` 的
       * `firstUnitId`),否则单位号会与点位号撞——而 `getObjectById(id): Unit | Site | null`
       * 要的是一个全局 id 空间。
       */
      readonly id: number;
      readonly siteKind: SiteKind;
      readonly x: number;
      readonly y: number;
      readonly owner: Owner;
    }
  | {
      readonly kind: "create-unit";
      readonly owner: PlayerIndex;
      readonly unitType: UnitType;
      readonly x: number;
      readonly y: number;
      /** 携带量开局恒 0;采集机制那一票开始用它。 */
      readonly carrying?: number;
    }
  | { readonly kind: "destroy-unit"; readonly unitId: number }
  | { readonly kind: "move-unit"; readonly unitId: number; readonly x: number; readonly y: number }
  /**
   * 把单位血量改成某个值(票 08)。
   *
   * ── 为什么扣血要经变更表,而不在步 3 里就地写一栏 ──
   * 「唯一写入口」是对**整份 `GameState`** 成立,不只是对某几个字段。伤害结算要改 `Unit.hp`,
   * 那就必须与别的写操作走同一条登记:想写它,先在这里列一项。不开「步 3 直接展开单位对象」
   * 这条旁路,否则「有哪些写操作」就不再是一张可枚举的表。
   *
   * ── 为什么允许 hp 取到 0 或负数 ──
   * 本变更**唯**的调用点是 `step3-combat.ts`:它先在只读基线上把全部伤害算完,再按目标求和,
   * 然后把 `hp - 求和伤害` 写进来。求和可能过杀(负值),而归零者由调用方在**同一次迭代内**
   * 紧接着发一条 `destroy-unit` 移除——所以负 hp 只在本步之内瞬时存在,不会出现在任何写出的
   * tick 行里(有一条用例解析写出行断言 hp 非负)。把「扣到几」与「死不死」拆给两个变更单,
   * 是为了让「单一血池求和」这一步留在结算层,`apply()` 只负责把值落进状态。
   */
  | { readonly kind: "set-unit-hp"; readonly unitId: number; readonly hp: number }
  /**
   * 记下首触发生的 tick(票 04)。
   *
   * ── 为什么这条要进变更表,而不在步 2 里直接赋一栏 ──
   * 「唯一写入口」这句话不是只对玩家可见的状态字段成立,而是对**整份 `GameState`** 成立。
   * 首触记忆是跨 tick 的状态,那就必须与别的状态走同一条登记:想写它,先在这里列一项。
   * 不开「步 2 直接展开状态对象写一栏」这条旁路,否则「有哪些写操作」就不再是一张可枚举的表。
   */
  | { readonly kind: "mark-first-contact"; readonly tick: number }
  /**
   * 推进一个点位的占领轨道(票 05)。
   *
   * `progressOwner` / `progress` 是**更新后的**整条轨道;`newOwner` 只在本 tick 易主时出现
   * (那时 `progressOwner` 已被清成 `-1`、`progress` 清成 `0`,见 `processor/capture.ts`)。
   * 是否易主由机器算好、由这条变更承载,`apply()` 只落结果——它不判阈值,也不看规则集。
   */
  | {
      readonly kind: "advance-capture";
      readonly siteId: number;
      readonly progressOwner: Owner;
      readonly progress: number;
      readonly newOwner?: PlayerIndex;
    };

/** 按数值 id 升序插入。数组短(每 tick 几百个对象),有序插入比「先插后排」少一次全数组重排。 */
const insertById = <T extends { readonly id: number }>(
  items: readonly T[],
  item: T,
): readonly T[] => {
  let at = items.length;
  while (at > 0 && items[at - 1]!.id > item.id) {
    at -= 1;
  }
  return [...items.slice(0, at), item, ...items.slice(at)];
};

const replaceById = <T extends { readonly id: number }>(
  items: readonly T[],
  id: number,
  replace: (item: T) => T,
): readonly T[] => items.map((item) => (item.id === id ? replace(item) : item));

/**
 * 唯一写入口。返回新状态;调用方拿着旧状态继续读不算错,但**下一次**读必须用返回值。
 *
 * 「旧状态仍可读」是有意保留的:结算管线里同一阶段要先读后写(裁决先于落子),
 * 一份共享可变状态会让「读到的是不是刚落过的」变成一件靠记顺序的事。
 */
export const apply = (state: GameState, ruleset: Ruleset, change: Change): GameState => {
  switch (change.kind) {
    case "create-site":
      return { ...state, sites: insertById(state.sites, siteOf(ruleset, change)) };
    case "create-unit": {
      const taken = allocateId({ next: state.nextId });
      return {
        ...state,
        units: insertById(state.units, unitOf(ruleset, taken.id, change)),
        nextId: taken.gen.next,
      };
    }
    case "destroy-unit":
      return { ...state, units: state.units.filter((unit) => unit.id !== change.unitId) };
    case "move-unit":
      return {
        ...state,
        units: replaceById(state.units, change.unitId, (unit) => ({
          ...unit,
          x: change.x,
          y: change.y,
        })),
      };
    case "set-unit-hp":
      // 目标不存在时 `replaceById` 是一次 no-op(每个单位是一次 map),所以调用方不必先查存在。
      return {
        ...state,
        units: replaceById(state.units, change.unitId, (unit) => ({ ...unit, hp: change.hp })),
      };
    case "mark-first-contact":
      return { ...state, firstContactTick: change.tick };
    case "advance-capture":
      return {
        ...state,
        sites: replaceById(state.sites, change.siteId, (site) => ({
          ...site,
          progressOwner: change.progressOwner,
          progress: change.progress,
          ...(change.newOwner === undefined ? {} : { owner: change.newOwner }),
        })),
      };
    default: {
      // 穷尽性靠编译期兜住:新增一种变更而这里没跟上,是编译错误而不是运行期静默不改状态。
      const unreachable: never = change;
      throw new Error(`未登记的变更:${String(unreachable)}`);
    }
  }
};

/** 建点位。资源点的储量来自规则集,基地不写 `remaining` 这一栏(见 state.ts 的注释)。 */
const siteOf = (ruleset: Ruleset, change: Extract<Change, { kind: "create-site" }>): Site => ({
  id: change.id,
  kind: change.siteKind,
  x: change.x,
  y: change.y,
  owner: change.owner,
  progressOwner: -1,
  progress: 0,
  producing: null,
  ...(change.siteKind === "resource" ? { remaining: ruleset.resourcePerSite } : {}),
});

/** 建单位。血量取自规则集——变更单里根本没有 hp 这一栏可填。 */
const unitOf = (
  ruleset: Ruleset,
  id: number,
  change: Extract<Change, { kind: "create-unit" }>,
): Unit => ({
  id,
  owner: change.owner,
  type: change.unitType,
  x: change.x,
  y: change.y,
  hp: hpOf(ruleset, change.unitType),
  carrying: change.carrying ?? 0,
});

const hpOf = (ruleset: Ruleset, unitType: UnitType): number => {
  switch (unitType) {
    case "worker":
      return ruleset.worker.hp;
    case "melee":
      return ruleset.melee.hp;
    case "ranged":
      return ruleset.ranged.hp;
    case "cavalry":
      return ruleset.cavalry.hp;
    default: {
      const unreachable: never = unitType;
      throw new Error(`未登记的兵种:${String(unreachable)}`);
    }
  }
};
