/**
 * 占领进度机(gdd §3.2《占领机制》)。**这一节就是这台机器的家**,逐字照它实现:
 *
 * - 点位为**单格**,同一时刻最多一个驱动者 D(站在点位格上的单位所属方)。
 * - 单位站在点位格上即驱动占领;累积达 `captureTicks` 后所有权易主、进度清零。
 * - **全兵种占领速度一致**:农民不加速(它的价值只在经济与堵点)。
 * - D 与 `owner` 同阵营:占领进度**保留不动**。
 * - D 与 `owner` 不同:若 `progressOwner ≠ D` 则**转轨重计**(`progressOwner = D`、`progress = 1`,
 *   **无侵蚀**);否则 `progress + 1`。
 * - **无人站立:占领进度保留不动,不衰减。**
 *
 * ── 契约面的缺口(gdd §8 记录 #14)──
 *
 * 面向模型的契约面 `docs/rules-v1/rules.md` 的 §5「占领」**是占位**(原文写着「本节未排期」)。
 * 终稿契约下盲写三舱时全部撞上这个缺口,各自猜出一套机制且两种互斥。规则侧不缺机制,
 * 缺的是契约面那一节散文——正文明文归下一轮机制契约散文,本轮不手改生成物。
 * 所以:这台机器的**家是 gdd §3.2**;下一轮补 §5 散文时以 §3.2 为准,**不在契约面另立一套**。
 *
 * ── 为什么机器的输出是「一条变更或 null」而不是「新进度」 ──
 *
 * 「无人站立 / 同阵营 → 保留不动」在数据上就是**什么都不写**,而不是「写回原值」。
 * 让保留不动也产出一条变更,`apply()` 就会收到一次无副作用的写;更糟的是它让
 * 「本 tick 这条轨道动了没有」在变更流里看不出来,而回放比对只认变更落下的结果。
 * `null` = 本 tick 这条轨道不动,一句话把保留不动与推进分开。
 */

import type { RulesetView } from "../ruleset-loader/index.js";
import type { Change } from "../driver/apply.js";
import type { PlayerIndex, Site, Unit } from "../world/state.js";

/**
 * 站在该点位格上的那个单位所属的方;没人站则 `null`。
 *
 * ── 为什么是从单位派生,而不是状态里另存一栏「驻守者」 ──
 *
 * 状态里没有「点位驻守者」这一栏(见 `world/state.ts` 的 `Site`):驻守者**就是**「站在这一格上的
 * 单位」,再存一栏就是同一事实的第二份表示,而两份表示必然漂移(单位移动/死亡时忘同步)。
 * 派生是唯一一份表示。
 *
 * ── 为什么取升序遍历里的第一个(数值 id 最小者)──
 *
 * 正常路径下**单格单单位**:同一 tick 两个单位想进同一格,由票 04 的占位裁决判掉一个
 * (`processor/movement.ts` 的 `candidateInto`:目标格被基准占位即失败),所以这里遍历到的
 * 第一个也是唯一一个。唯一的例外是**开局**——`createInitialState` 按地图的 `spawnUnits`
 * 逐个摆单位,地图数据若声明了两个落在同一格的初始单位,就绕过了那条裁决。
 * 取「按单位数值 id 升序的第一个」是给这个**退化情形**的确定答案(**不是**常规路径);
 * 确定,是因为 `units` 由状态不变量保证升序(见 `world/state.ts` 对 `GameState` 的说明)。
 */
export const captureDriverAt = (site: Site, units: readonly Unit[]): PlayerIndex | null => {
  for (const unit of units) {
    if (unit.x === site.x && unit.y === site.y) {
      return unit.owner;
    }
  }
  return null;
};

/**
 * 本 tick 该点位的占领变更;`null` = **保留不动**(无人站立,或驱动者与属主同阵营)。
 *
 * 实现次序照 gdd §3.2:先按 §3.2 更新 `progress`,再判 `progress >= captureTicks` →
 * 易主 + 清零。阈值**只从 `RulesetView.raw.captureTicks` 读**,代码里不出现那个数字。
 *
 * ── 为什么清零清的是**整条轨道** ──
 *
 * 易主之后 `progress = 0` 与 `progressOwner = -1` 一起落。`progressOwner` 是这条轨道的**属主**,
 * 只清 `progress` 会余下「进度 0 但属主是某人」这种半截状态——而它在下一 tick 与
 * 「属主 = 新 owner、进度 0」**不可区分**,于是同一个可观测状态有两种内部表示,回放读起来要靠猜。
 * 清成 `-1`(无轨道)之后,「无轨道」与「有轨道但进度 0」分得开。
 * 易主那一刻驱动者往往还站在格子上,但它下一 tick 就 `D === owner`,落到「同阵营 → 保留不动」,
 * 所以清零**不会**让它反复重新累积。
 */
export const captureChangeOf = (
  site: Site,
  units: readonly Unit[],
  ruleset: RulesetView,
): Change | null => {
  const driver = captureDriverAt(site, units);
  if (driver === null || driver === site.owner) {
    // 无人站立:保留不动,不衰减。同阵营驻守:保留不动(两个分支都什么都不写)。
    return null;
  }
  // 转轨重计:进度属主不是 D 时从 1 重新起算——**无侵蚀**。属主是 D 时加一。
  const progress = site.progressOwner === driver ? site.progress + 1 : 1;
  if (progress >= ruleset.raw.captureTicks) {
    // 达阈值:易主 + 整条轨道清零(理由见上)。
    return {
      kind: "advance-capture",
      siteId: site.id,
      progressOwner: -1,
      progress: 0,
      newOwner: driver,
    };
  }
  return { kind: "advance-capture", siteId: site.id, progressOwner: driver, progress };
};

/**
 * 这条变更是不是「本 tick 易主」。步 4 用它决定要不要发 `site-captured`——
 * 判定收在机器这一侧,调用点不再自己拿 `newOwner` 的在场与否去猜。
 */
export const isCapture = (
  change: Change,
): change is Extract<Change, { kind: "advance-capture" }> & { readonly newOwner: PlayerIndex } =>
  change.kind === "advance-capture" && change.newOwner !== undefined;
