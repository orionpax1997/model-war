/**
 * 规则集装载(hld §7.1「全部参数取值的真源」;hld §3.1 `engine:ruleset-loader` 的那一格)。
 *
 * 本模块**不做校验**,只做装载:`validateRuleset` 纯函数与那条唯一的 ajv 实例在 `apps/cli`
 * (hld §2.2.5「校验器只在 apps/cli 一处」),而 `apps/cli` 反过来调它把校验过的取值交给本包。
 * 引擎自己**不再写一份规则集校验**——两份校验器必然漂移,而漂移的方向通常是「引擎那份更宽松」。
 *
 * 装载落在两件事上:
 * 1. **整数闭包断言**。规则集里出现一个非整数就是装载期事故:状态演化必须全整数(NFR-1),
 *    而一个 1.5 的造价会在某个 tick 变成半格血,直到那条 tick 行被重放比对才发现。
 *    ajv 的 `integer` 声明管的是 JSON 的写法,这一条管的是「值本身是整数」这条结算前提——两者不是同一条。
 * 2. **按兵种取属性的查表**。全仓不允许硬编码兵种名到数值的那张表;查表放在这里,
 *    于是「哪个名字对应哪条线」只有这一个落点。
 */

import { RULESET_KEYS, type Ruleset, type UnitStats } from "@model-war/replay";
import type { UnitType } from "../world/state.js";

/** 装载后的规则集:一份只读视图 + 按兵种取属性的查表。 */
export type RulesetView = {
  readonly raw: Ruleset;
  readonly statsOf: (unitType: UnitType) => UnitStats;
};

/** 整数闭包断言失败时抛的错。装载期事故由调用方映射成退出码 1(02b 那一侧接线)。 */
export class RulesetLoadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RulesetLoadError";
  }
}

const isInteger = (value: number): boolean => Number.isInteger(value);

const assertIntegerKeys = (ruleset: Ruleset): void => {
  for (const key of RULESET_KEYS) {
    const value = ruleset[key];
    if (typeof value === "number" && !isInteger(value)) {
      throw new RulesetLoadError(`规则集键 ${key} 取值 ${String(value)} 不是整数`);
    }
    if (typeof value === "object") {
      for (const [field, stat] of Object.entries(value)) {
        if (!isInteger(stat)) {
          throw new RulesetLoadError(`规则集键 ${key}.${field} 取值 ${String(stat)} 不是整数`);
        }
      }
    }
  }
};

/**
 * 装载一份已被校验器放行的规则集。
 *
 * 参数取自 `rulesets/v1.json` 的**已校验值**;版本三处一致(文件名 / 目录名 / 常量)由 `apps/cli`
 * 在装载期判,引擎不重复判,也不静默降级。
 */
export const loadRuleset = (ruleset: Ruleset): RulesetView => {
  assertIntegerKeys(ruleset);
  return {
    raw: ruleset,
    statsOf: (unitType) => {
      switch (unitType) {
        case "worker":
          return ruleset.worker;
        case "melee":
          return ruleset.melee;
        case "ranged":
          return ruleset.ranged;
        case "cavalry":
          return ruleset.cavalry;
        default: {
          // 判别联合的穷尽性靠编译期兜住,不是靠运行时兜底:兵种名加了而这里没跟上,
          // 这一行就是编译错误,而不是某个 tick 里一条 undefined 的属性读。
          const unreachable: never = unitType;
          throw new RulesetLoadError(`未登记的兵种:${String(unreachable)}`);
        }
      }
    },
  };
};
