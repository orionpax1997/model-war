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
 * ── id 空间是**一条**全局空间 ──
 *
 * `unit.id` 与 `site.id` 共用同一个数值空间:`getObjectById(id): Unit | Site | null`
 * (`docs/rules-v1/api.md`)只收一个 id,查出来要么是单位要么是点位。开局先把点位号占据低端、
 * 单位号从所有地图号之上起(见 `world/initial-state.ts` 的 `firstUnitId`),两者不撞号。
 * 判据 4 里的「命中 `sites` 即丢弃」因此是「基地不可被攻击」的**语义**,不是避让撞号;它与
 * 「两边都没命中 → 丢弃」各自独立,两条都保留。
 */

import type { RulesetView } from "../ruleset-loader/index.js";
import type { PlayerIndex, Site, Unit } from "../world/state.js";
import type { Intent } from "./intents.js";
import { attackVerdict, unitById } from "./intent-verdicts.js";

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

/**
 * `check()`:五条判据,返回布尔。
 *
 * 它**收规则集**:判据 3 要 `damage`、判据 5 要 `range`,两条都从规则集读,不是收下不看的一栏。
 * 判据的实现在 `intent-verdicts.ts`(处理器与沙箱 guest 共用同一份),这里只还原成布尔。
 */
export const checkAttack = (
  view: AttackView,
  seat: PlayerIndex,
  ruleset: RulesetView,
  intent: AttackIntent,
): boolean => attackVerdict(view, seat, ruleset, intent).ok;

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
  const attacker = unitById(view, intent.unitId);
  if (attacker === undefined) {
    return null;
  }
  return { targetId: intent.targetId, damage: ruleset.statsOf(attacker.type).damage };
};
