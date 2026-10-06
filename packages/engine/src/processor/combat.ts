/**
 * 战斗裁决:一条 `attack` 意图的 `check()` 与 `run()`(hld §4.3 步 3、gdd §6.2)。
 *
 * ── 为什么本模块只算「伤害条」,不碰状态 ──
 *
 * 「同 tick 全部攻击**同时**结算」在实现上只有一个落点:**先把全部伤害算出来,再统一扣血**。
 * 若本模块顺手就地扣血,「同时」就被实现的遍历顺序破坏——在同归于尽的构造里,先被遍历到的一方
 * 打死对方,对方就再没有机会打出它那一击,先手方便白赚一条命,而管线看起来仍然跑得通。
 * 所以本模块与 `movement.ts` 同形:只读视图 + `check()` + 纯函数 `run()`,返回一条候选
 * (**伤害条**,不是变更单),两趟结算与唯一写入口 `apply()` 都留在步 3。
 *
 * ── 五条判据 ──
 *
 * 1. 攻击者存在(`unitId` 命中一个单位);
 * 2. 属主正确(`unit.owner === seat`);
 * 3. **攻击者有攻击能力**:`statsOf(type).damage > 0`。这一条**只看 `damage`,不看 `range`**——
 *    农民 `range = 1`(不为零)而 `damage = 0`,只判射程会把农民放行,而它打出的伤害是 0。
 *    「无攻击能力的意图无效丢弃」是**判据**,不是「农民」这个兵种的特例,故两条要一起判。
 * 4. 目标存在、为**敌方单位**,且不可为点位:基地不可被攻击。`targetId` 命中 `sites` 即丢弃,
 *    它与「目标不存在」是两条不同的丢弃路径(前者是「打的是一个点位」,后者是「打的是空气」)。
 * 5. 目标在射程内:切比雪夫距离 `max(|dx|, |dy|) <= statsOf(攻击者.type).range`,射程从规则集读。
 *
 * ── id 空间提示 ──
 *
 * `unit.id`(由 `nextId` 分配,从 1 起)与 `site.id`(由地图给出,本仓地图是 0..27)是**同一个
 * 数值空间的两个数组**,并不保证互斥——两者会撞号。判据 4 因此先判 `sites`:**命中点位即丢弃**,
 * 与「命中单位」互斥时点位优先。这条撞号后果记在 `## Answer`,不在本票修(改 id 分配或让 intent
 * 带上目标种类都是跨票变更)。
 */

import type { RulesetView } from "../ruleset-loader/index.js";
import type { PlayerIndex, Site, Unit } from "../world/state.js";
import type { Intent } from "./intents.js";

/** 本模块唯一处理的那条意图。收窄判别式,不靠 `as`。 */
export type AttackIntent = Extract<Intent, { kind: "attack" }>;

/** 判别 `attack`。其余五条不是战斗(归 04–09),本票只交付这一条。 */
export const isAttackIntent = (intent: Intent): intent is AttackIntent => intent.kind === "attack";

/**
 * `check()` / `run()` 的只读视图。
 *
 * **类型里没有任何写入口**:它是 `GameState` 的一个结构子集,每一栏都 readonly,所以步 1 与
 * 步 3 可以直接把真状态传进来,而传进来的那一份在类型上改不动——「check() 不改状态」由类型承担,
 * 不是一句口头约定。战斗不需要地形与 `size`(它不寻路、不判越界),故这两栏不列。
 */
export type AttackView = {
  readonly units: readonly Unit[];
  readonly sites: readonly Site[];
};

/**
 * 一条候选「伤害条」。它**不是** `Change`:伤害先算、后扣,扣血那一步才落成 `set-unit-hp`。
 * 把它做成 `Change` 就等于把「算」与「扣」合成一步,同时性从这里漏掉。
 */
export type AttackDamage = {
  readonly targetId: number;
  readonly damage: number;
};

/** 按数值 id 取单位。`units` 由状态不变量保证升序,但一次一条意图,线性查找即可。 */
const unitIn = (view: AttackView, id: number): Unit | undefined =>
  view.units.find((unit) => unit.id === id);

/**
 * `check()`:五条判据,返回布尔。
 *
 * 它**收规则集**:判据 3 要 `damage`、判据 5 要 `range`,两条都从规则集读,不是收下不看的一栏。
 */
export const checkAttack = (
  view: AttackView,
  seat: PlayerIndex,
  ruleset: RulesetView,
  intent: AttackIntent,
): boolean => {
  const attacker = unitIn(view, intent.unitId);
  if (attacker === undefined) {
    return false;
  }
  if (attacker.owner !== seat) {
    return false;
  }
  const stats = ruleset.statsOf(attacker.type);
  // 判据 3:有攻击能力看 `damage`,不看 `range`(农民 range=1、damage=0)。
  if (stats.damage <= 0) {
    return false;
  }
  // 判据 4 前半:目标不可为点位(基地不可被攻击)。**先于**单位查找判——`sites` 与 `units`
  // 会撞号,命中点位一律丢弃(点位优先),见文件头注。
  if (view.sites.some((site) => site.id === intent.targetId)) {
    return false;
  }
  const target = unitIn(view, intent.targetId);
  if (target === undefined) {
    return false;
  }
  // 判据 4 后半:目标须为敌方单位。
  if (target.owner === seat) {
    return false;
  }
  // 判据 5:切比雪夫距离 ≤ 射程。
  const distance = Math.max(Math.abs(attacker.x - target.x), Math.abs(attacker.y - target.y));
  return distance <= stats.range;
};

/**
 * `run()`:在只读基线上算一条伤害条,或「不成立」(`null`)。
 *
 * 它只回「谁掉多少血」,不改任何状态——扣血与死亡移除是步 3 的第二趟,不在这里。
 * `damage` 取自规则集(全整数),不做任何加成:gdd §6.2 无护甲、无技能、无冷却。
 */
export const runAttack = (
  view: AttackView,
  seat: PlayerIndex,
  ruleset: RulesetView,
  intent: AttackIntent,
): AttackDamage | null => {
  if (!checkAttack(view, seat, ruleset, intent)) {
    return null;
  }
  const attacker = unitIn(view, intent.unitId);
  if (attacker === undefined) {
    return null;
  }
  return { targetId: intent.targetId, damage: ruleset.statsOf(attacker.type).damage };
};
