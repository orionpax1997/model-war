/**
 * 生产裁决:玩家级 `spawnUnit` 意图的 `check()` / `run()`,以及步 4 d) 的两件事——下单占线、
 * 每 tick 推进、归零出兵、被占挂起、易主取消退款(gdd §5《基地与生产》)。本文件是那一节的家。
 *
 * ── 为什么是「只读视图 + `check()` + 纯函数 `run()`」而不是就地写状态 ──
 *
 * 与 `movement.ts` / `combat.ts` 同形:本模块拿到的 `ProductionView` 每一栏都 readonly,连一个
 * 可写引用都没有,所以「`check()` 不改状态」由类型承担,不是一句口头约定;要落下的每一件事
 * 都经唯一写入口 `apply()` 的变更表(`start-production` / `advance-production` / `cancel-production`)。
 *
 * ── 资金先、扣款后:为什么「不占队列不扣款」是结构性的 ──
 *
 * `checkSpawn()` 在**产生变更之前**判「资金够不够」。不够就返回 `false`,`runSpawn()` 于是返回
 * `null`——**压根没有一条变更被造出来**,也就没有「先扣了款、再发现占不上队列」的中途状态。
 * 扣款与占队列收在同一条 `start-production` 里(理由见 `driver/apply.ts`)。
 *
 * ── 没有「产线忙」这个错误码(契约面的一处硬裁决)──
 *
 * 一条产线已有订单时再来一单,是**静默丢弃**:不扣款、不计异常、队列不变、且**不抛错误码**。
 * 错误码表(`packages/schema` 的注入面目录)里本来就没有那一码,也不该加:
 * `script-surface.ts` 头注的原话是「`ERR_BASE_BUSY` 不收」——把一个**非错误的状态**做成错误码,
 * 是让模型去 `isError` 一个它其实不该问的东西。脚本的正确写法是先读点位上的 `producing`、
 * 为空才下单(契约面「先读产线、为空才下单」)。
 *
 * ── 产线订单只有一份数据源:点位上的 `Site.producing` ──
 *
 * 本模块不引入独立队列表,也不在别处镜像一份。本 tick 的全部产线事实都从 `site.producing` 读,
 * 这正是脚本在快照里读到的那一栏(同一条形状,不是投影)。
 *
 * ── a) 易主的接缝:队列取消 + 全额退款给原主 ──
 *
 * 易主发生在步 4 的 a) 占领(见 `capture.ts` 的 `captureChangeOf`)。`cancelOnCaptureOf()` 是那条
 * 接缝:它读**原主**(由占领机的变更单显式带出的 `previousOwner`)与该基地**易主前**的订单,
 * 产出一次 `cancel-production`(队列清空 + 全额退款一条落子)。
 * 「原主已淘汰(基地回归中立)时不退款」对应的是**回归中立**那条路(点位回到 -1、没有可退的席位),
 * 归票 09;本票只做「退款对象是原主、金额是全额」。
 */

import type { RulesetView } from "../ruleset-loader/index.js";
import type { Change } from "../driver/apply.js";
import type { Intent } from "./intents.js";
import type { Owner, Player, PlayerIndex, Site, Unit, UnitType } from "../world/state.js";

/** 本模块唯一处理的那条意图。收窄判别式,不靠 `as`。 */
export type SpawnIntent = Extract<Intent, { kind: "spawnUnit" }>;

/** 判别 `spawnUnit`。其余五条不是生产(归 04–09),本票只交付这一条。 */
export const isSpawnIntent = (intent: Intent): intent is SpawnIntent => intent.kind === "spawnUnit";

/**
 * `check()` / `run()` 的只读视图。
 *
 * **类型里没有任何写入口**:它是 `GameState` 的一个结构子集,每一栏 readonly,所以步 1 与步 4
 * 可以直接把真状态传进来。它只需要点位与玩家两栏——判「基地存在 / 是基地 / 属主正确 / 资金够 /
 * 无订单」用不到单位表(出兵格的占用判定是**推进**那一步的事,不在意图校验里)。
 */
export type ProductionView = {
  readonly sites: readonly Site[];
  readonly players: readonly Player[];
};

/** 候选变更。它就是 `apply()` 已登记的 `start-production`,所以落子不需要第二种写操作。 */
export type StartProduction = Extract<Change, { kind: "start-production" }>;

/** 按数值 id 取点位。`sites` 由状态不变量保证升序,一次一条意图,线性查找即可。 */
const siteById = (view: ProductionView, id: number): Site | undefined =>
  view.sites.find((site) => site.id === id);

/** 按座位取玩家;`players` 按 `playerIndex 0..3` 对齐。 */
const playerOf = (view: ProductionView, seat: PlayerIndex): Player | undefined =>
  view.players.find((player) => player.index === seat);

/** 该兵种的造价。全整数,取自规则集,代码里不出现那个数字。 */
const costOf = (ruleset: RulesetView, unitType: UnitType): number => ruleset.statsOf(unitType).cost;

/**
 * `check()`:五条判据,返回布尔。
 *
 * 判据(次序即表):
 * 1. **基地存在**——`baseId` 命中一个点位;
 * 2. **是基地不是资源点**——只有 `kind === "base"` 是产线(资源点不是);
 * 3. **属主正确**——基地属于该座位(拿敌方 / 中立基地下单无效);
 * 4. **资金够**——`resources >= cost`,不足则这一单无效:不占队列、不扣款(结构性,理由见头注);
 * 5. **该基地当前无订单**——已有一条队列时再来一单是**静默丢弃**,不抛错误码(见头注)。
 *
 * 它**收规则集**:第 4 条要读 `cost`。判据 5 与 4 的先后无所谓(两条都只读),但摆在资金之后,
 * 是因为「重复下单」这一支的后果与资金无关——先判它会让「钱刚好够、产线忙」与「钱不够、产线空」
 * 这两条不同原因在调试时更易区分。
 */
export const checkSpawn = (
  view: ProductionView,
  seat: PlayerIndex,
  ruleset: RulesetView,
  intent: SpawnIntent,
): boolean => {
  const site = siteById(view, intent.baseId);
  if (site === undefined) {
    return false;
  }
  if (site.kind !== "base") {
    return false;
  }
  if (site.owner !== seat) {
    return false;
  }
  const player = playerOf(view, seat);
  if (player === undefined) {
    return false;
  }
  if (player.resources < costOf(ruleset, intent.unitType)) {
    return false;
  }
  if (site.producing !== null) {
    return false;
  }
  return true;
};

/**
 * `run()`:在只读基线上算出唯一一条候选变更(下单占线 + 扣款),或「不成立」(`null`)。
 *
 * 判据全部收在 `checkSpawn()` 里,所以这里的「不成立」只有一种原因:某条判据没过。
 * `remainingTicks` 的初值取自规则集 `spawnTicks`——本 tick 的 d) 会在下单之后立刻把它推进一次,
 * 所以下单那一 tick 也计入生产耗时(见步 4 的接线与 `## Answer`)。
 */
export const runSpawn = (
  view: ProductionView,
  seat: PlayerIndex,
  ruleset: RulesetView,
  intent: SpawnIntent,
): StartProduction | null => {
  if (!checkSpawn(view, seat, ruleset, intent)) {
    return null;
  }
  const stats = ruleset.statsOf(intent.unitType);
  return {
    kind: "start-production",
    siteId: intent.baseId,
    owner: seat,
    unitType: intent.unitType,
    remainingTicks: stats.spawnTicks,
    cost: stats.cost,
  };
};

/**
 * d) 一个基地本 tick 的产线变更(按数组序由调用方施加)。
 *
 * 两件事按序:
 * 1. **有订单且未到点 → 减一**(`advance-production`)。
 * 2. **到点**(本 tick 刚归零,或此前已归零并挂起)且基地属主是玩家:
 *    - 出兵格**空着** → `create-unit`(出生位置 = **基地格本身**)+ `cancel-production`(清空队列);
 *    - 出兵格**被任意单位占据(含己方)** → **挂起**:什么都不写,不换格、不跳过、不减到负数。
 *
 * ── 挂起时 `remainingTicks` 停在几:0 ──
 *
 * 「已经到点了,就等格子空出来」。所以归零那一 tick 写一次 `advance-production` 到 0;
 * 此后每 tick 再读仍是 0,不再写 `advance-production`(0 减一会得到 -1,而那条规则不存在)。
 * 于是挂起期间的 `remainingTicks` **恒为 0**,是一条可被用例钉死的确定语义。
 *
 * ── 出兵那一刻的归属 ──
 *
 * 单位属于**基地当前的 owner**(`site.owner`),不是下单时的 owner。本票不区分这两者:
 * 基地一旦易主,它的队列已随易主取消(见 `cancelOnCaptureOf`)——所以不存在「原主的单在别人家的
 * 基地里出个兵」这种情形。
 */
export const productionChangesOf = (site: Site, units: readonly Unit[]): readonly Change[] => {
  if (site.kind !== "base" || site.producing === null) {
    return [];
  }
  const { type, remainingTicks } = site.producing;
  const changes: Change[] = [];
  let remaining = remainingTicks;
  if (remaining > 0) {
    remaining -= 1;
    changes.push({
      kind: "advance-production",
      siteId: site.id,
      unitType: type,
      remainingTicks: remaining,
    });
  }
  if (remaining > 0) {
    return changes;
  }
  // 到点了。中立基地不可能是产线(下单要求属主是玩家),这一支只是防御,不改变正常路径。
  if (site.owner === -1) {
    return changes;
  }
  // 出兵格就是基地格本身;被任意单位(含己方)占据则挂起——不换格、不跳过。
  if (units.some((unit) => unit.x === site.x && unit.y === site.y)) {
    return changes;
  }
  changes.push({
    kind: "create-unit",
    owner: site.owner,
    unitType: type,
    x: site.x,
    y: site.y,
  });
  changes.push({ kind: "cancel-production", siteId: site.id });
  return changes;
};

/**
 * a) 易主的接缝:该基地若有订单,取消队列并把**全额 `cost`** 退给**原主**;无订单则 `null`。
 *
 * - **全额**:gdd 写的是「全额退款」,不按剩余 tick 折算——所以退款额取自订单兵种的 `cost`,
 *   与 `remainingTicks` 无关。
 * - **原主**来自 `previousOwner`,由占领机在算出易主时显式带出(见 `driver/apply.ts`)。
 *   这里**不**去读易主后的状态:那一刻状态里的 owner 已经是新主。
 * - **原主已淘汰(`alive === false`)也照退**:退款只是往 `Player.resources` 这个数上加一笔,
 *   退给一个已出局的席位不违反任何不变量。「原主已淘汰时不退款」对应的是**回归中立**那条路
 *   (点位回到 -1、没有可退的席位),归票 09——两条路的差别就在「有没有一个原主可退」。
 */
export const cancelOnCaptureOf = (
  site: Site,
  previousOwner: Owner,
  ruleset: RulesetView,
): Change | null => {
  if (site.producing === null) {
    return null;
  }
  if (previousOwner === -1) {
    // 无原主可退(回归中立那条路的形态):只清队列,不退款。
    return { kind: "cancel-production", siteId: site.id };
  }
  return {
    kind: "cancel-production",
    siteId: site.id,
    refund: { player: previousOwner, amount: costOf(ruleset, site.producing.type) },
  };
};
