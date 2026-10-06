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
  Outcome,
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
   * 记下某座位 `economy-dead` **事件**已发的那一 tick(票 07)。
   *
   * ── 为什么这条要进变更表 ──
   * 与 `mark-first-contact` 同理:「这条事件发过没有」是跨 tick 的状态,而「唯一写入口」是对
   * **整份 `GameState`** 成立,不只对玩家可见字段。不开「步 4 直接展开状态对象写一栏」的旁路,
   * 否则「有哪些写操作」就不再是一张可枚举的表。
   * 注意它落的**不是**玩家的经济状态——判据本身是纯函数(见 `world/state.ts` 那一栏的注释),
   * 本变更只移动「事件发到第几次」的账。
   */
  | { readonly kind: "mark-economy-dead"; readonly seat: PlayerIndex; readonly tick: number }
  /**
   * 累加某座位的 `exceptionTicks`(票 02 的预置件;判据与淘汰归票 07)。
   *
   * ── 为什么这条要进变更表 ──
   * 与 `mark-first-contact` / `mark-economy-dead` 同理:`exceptionTicks` 是跨 tick 的状态,
   * 而「唯一写入口」是对**整份 `GameState`** 成立。不开「步 0 直接展开玩家对象写一栏」的旁路,
   * 否则「有哪些写操作」就不再是一张可枚举的表。
   *
   * ── 为什么它只带座位与值 ──
   * 判据(这条轨是不是真触限)由执行器在宿主侧算好并作为 `tripped` 观测上报,步 0 只把它转成
   * 本条变更;`apply()` **只落不判**——不看规则集、不判阈值、不判淘汰。`count` 是这一 tick 该
   * 座位累加的异常次数(一条 `tripped` 观测计一次)。
   */
  | { readonly kind: "count-exception-tick"; readonly seat: PlayerIndex; readonly count: number }
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
      /**
       * 易主**前**该点位的属主。由占领机(`processor/capture.ts`)在算出易主时一并带出。
       *
       * ── 为什么旧属主是这条变更带上来的,而不是让调用方事后去状态里翻 ──
       * a) 段一旦落地,`state` 里这个点位的 `owner` 已经是新主;谁在易主前拥有它,只有算易主的
       * 那一处知道。生产那一格(票 06)要靠这个值把订单退款给**原主**,若让它去读落地后的状态,
       * 「原主是谁」就成了一件靠「读的是前一份状态」隐式成立的事——那种依赖不会编译报错、
       * 也不会在任何断言里变红,只会在某天有人调整读取时机时静默退错款。带在这一栏上是显式的。
       * `apply()` 不读它:它是给下游消费者(生产那一格的退款)的事实,不是要落下的一栏。
       */
      readonly previousOwner: Owner;
      readonly newOwner?: PlayerIndex;
    }
  /**
   * 在基地产线下单(票 06):**同一个变更同时落「占住队列」与「扣款」**。
   *
   * ── 为什么两件事必须是一条变更,而不是两条 ──
   * 一条规则一次落子,中间没有可观察的半截状态。拆成「先扣款」「再占队列」两条变更,就打开了
   * 一个窗口:第一条落了、第二条因为任何原因没落,
   * 状态里就出现「扣了款却没占上队列」——它不会被任何断言发现,只会在下一 tick 表现成凭空少钱。
   * 资金是否足够由 `checkSpawn()` 在**产生这条变更之前**判掉(票 06),所以这条变更的施加是无条件的。
   */
  | {
      readonly kind: "start-production";
      readonly siteId: number;
      /** 付款方 = 下单那一刻该基地的属主(下过单这个前提由 `checkSpawn()` 保证)。 */
      readonly owner: PlayerIndex;
      readonly unitType: UnitType;
      /** 初始剩余 tick 数,取自规则集 `spawnTicks`,代码里不出现那个数字。 */
      readonly remainingTicks: number;
      /** 造价,取自规则集 `cost`,同一刻从付款方资源池里扣除。 */
      readonly cost: number;
    }
  /**
   * 推进一条已有订单(票 06):`remainingTicks` 减一。
   *
   * 与 `start-production` 分开,是因为它**只改队列、不碰资源池**;把它并进下单那一条会让
   * 「扣款」与「不扣款」两种语义挤进同一个变更,调用点每次都要多传一个「这次扣不扣」。
   */
  | {
      readonly kind: "advance-production";
      readonly siteId: number;
      readonly unitType: UnitType;
      readonly remainingTicks: number;
    }
  /**
   * 取消一条产线订单(票 06):清空队列,**可**附带一次全额退款。
   *
   * ── 为什么取消与退款是同一条变更 ──
   * 与 `start-production` 同理:一次落子,不留「队列清了、款没退」的半截状态。
   * `refund` 省略就是「取消但不退款」——那正是**回归中立**那条路的形态(点位回到 -1、
   * 没有可退的席位),归票 09;本票(基地易主)走的是带 `refund` 的那一支。
   */
  | {
      readonly kind: "cancel-production";
      readonly siteId: number;
      readonly refund?: { readonly player: PlayerIndex; readonly amount: number };
    }
  /**
   * 一次采集落子(票 07):**同一个变更同时加携带量、减矿的储量**。
   *
   * ── 为什么两件事必须是一条变更 ──
   * 与 `start-production` 的「占队列 + 扣款」同理:一条规则一次落子,中间不留可观察的半截状态。
   * 拆成「先加携带量」「再减矿」两条,若第一条落了、第二条因任何原因没落,状态里就出现
   * 「凭空多出携带量」——它不会被任何断言发现,只会在交付那一步变出一笔不存在的资源。
   * 取量由 `processor/economy.ts` 在产生这条变更之前封顶
   * (`min(harvestRate, carryLimit - carrying, remaining)`),所以本变更的施加是无条件的。
   */
  | {
      readonly kind: "harvest";
      readonly unitId: number;
      readonly siteId: number;
      /** 本 tick 的取量,全整数,取自规则集并封顶。 */
      readonly amount: number;
    }
  /**
   * 一次交付落子(票 07):**同一个变更同时把携带量清零、把资源加进玩家池**。
   *
   * 与 `harvest` 同理:一次落子,不留「携带量清了、资源没进池」或反之的半截状态。
   * `amount` 由 `processor/economy.ts` 取成单位当前的携带量,所以清零后 `carrying` 恒为 `0`。
   * `siteId` 是**交付目标基地**:资源进的是玩家全局共享池(不按基地分池),所以 `apply()`
   * **不读它**——它只是这条变更记录下来的事实(先例:`advance-capture.previousOwner`),
   * 让「交付给了哪一个基地」在变更流/回放里可审计,也让「多个相邻己方基地取数值 id 最小者」
   * 这条规则有一处可被断言的地方。
   */
  | {
      readonly kind: "transfer";
      readonly unitId: number;
      readonly siteId: number;
      readonly player: PlayerIndex;
      readonly amount: number;
    }
  /**
   * 把一个座位判为出局(票 09)。
   *
   * ── 为什么一条变更同时写两处(玩家码位与淘汰时刻) ──
   * 「这个座位出局了」与「它是在哪个 tick 出局的」是**同一件事**的两个面:名次第三条要用后者
   * 排序,而报告与事件看的是前者。拆成两条变更会让「已 `alive = false` 但 `eliminatedAtTick`
   * 仍是 `null`」成为可构造的中间态,于是名次算出一个 `?? -1` 的哨兵值。一条变更把两面
   * 一起落,中间态在类型上不存在(`Change` 里根本没有只写一面的条目)。
   */
  | { readonly kind: "eliminate-player"; readonly seat: PlayerIndex; readonly tick: number }
  /**
   * 把一个点位的残余进度与队列一起清回中立(票 09, gdd《胜利与淘汰》)。
   *
   * `owner` 回 `-1`、占领轨道清零、`producing` 取消。**队列取消不退款**——这条路径与
   * 「易主 → 退款」是两件事(给票 06 的话:基地回归中立那条路取消队列且不退款)。
   * 不做成「另发几条变更」:回归中立是一个原子结果,分几条写会让中间态里出现
   * 「已中立但还挂着一条产线」这种半截状态。
   */
  | { readonly kind: "return-site-to-neutral"; readonly siteId: number }
  /** 写上终局结果(票 09)。步 5 写 `victory` / `shortcut` / `all-eliminated`,步 7 写 `timeout`。 */
  | { readonly kind: "set-outcome"; readonly outcome: Outcome };

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
    case "mark-economy-dead":
      // 只是把「这条事件发过了」记到该座位那一格,不碰玩家对象上的任何一栏(理由见该变更注释)。
      return {
        ...state,
        economyDeadAtTick: state.economyDeadAtTick.map((tick, seat) =>
          seat === change.seat ? change.tick : tick,
        ),
      };
    case "count-exception-tick":
      // 只累加计数;阈值与淘汰的判定不在本函数(理由见该变更注释)。
      return {
        ...state,
        players: state.players.map((player) =>
          player.index === change.seat
            ? { ...player, exceptionTicks: player.exceptionTicks + change.count }
            : player,
        ),
      };
    case "harvest":
      // 加携带量与减矿一次落:没有可观察的半截状态(理由见该变更的注释)。
      return {
        ...state,
        units: replaceById(state.units, change.unitId, (unit) => ({
          ...unit,
          carrying: unit.carrying + change.amount,
        })),
        sites: replaceById(state.sites, change.siteId, (site) => ({
          ...site,
          remaining: (site.remaining ?? 0) - change.amount,
        })),
      };
    case "transfer":
      // 清携带量与入池一次落;目标基地(`siteId`)只随变更传递,资源进的是玩家池(理由见该变更注释)。
      return {
        ...state,
        units: replaceById(state.units, change.unitId, (unit) => ({
          ...unit,
          carrying: unit.carrying - change.amount,
        })),
        players: state.players.map((player) =>
          player.index === change.player
            ? { ...player, resources: player.resources + change.amount }
            : player,
        ),
      };
    case "advance-capture":
      // `previousOwner` 只随变更单传递、不由本函数落下(见该变更的注释),故这里不读它。
      return {
        ...state,
        sites: replaceById(state.sites, change.siteId, (site) => ({
          ...site,
          progressOwner: change.progressOwner,
          progress: change.progress,
          ...(change.newOwner === undefined ? {} : { owner: change.newOwner }),
        })),
      };
    case "start-production":
      // 占队列与扣款一次落:没有可观察的半截状态(理由见该变更的注释)。
      return {
        ...state,
        sites: replaceById(state.sites, change.siteId, (site) => ({
          ...site,
          producing: { type: change.unitType, remainingTicks: change.remainingTicks },
        })),
        players: state.players.map((player) =>
          player.index === change.owner
            ? { ...player, resources: player.resources - change.cost }
            : player,
        ),
      };
    case "advance-production":
      return {
        ...state,
        sites: replaceById(state.sites, change.siteId, (site) => ({
          ...site,
          producing: { type: change.unitType, remainingTicks: change.remainingTicks },
        })),
      };
    case "cancel-production": {
      const sites = replaceById(state.sites, change.siteId, (site) => ({
        ...site,
        producing: null,
      }));
      const refund = change.refund;
      if (refund === undefined) {
        return { ...state, sites };
      }
      return {
        ...state,
        sites,
        players: state.players.map((player) =>
          player.index === refund.player
            ? { ...player, resources: player.resources + refund.amount }
            : player,
        ),
      };
    }
    case "eliminate-player":
      return {
        ...state,
        players: state.players.map((player) =>
          player.index === change.seat ? { ...player, alive: false } : player,
        ),
        eliminatedAtTick: state.eliminatedAtTick.map((tick, seat) =>
          seat === change.seat ? change.tick : tick,
        ),
      };
    case "return-site-to-neutral":
      return {
        ...state,
        sites: replaceById(state.sites, change.siteId, (site) => ({
          ...site,
          owner: -1,
          progressOwner: -1,
          progress: 0,
          producing: null,
        })),
      };
    case "set-outcome":
      return { ...state, outcome: change.outcome };
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
