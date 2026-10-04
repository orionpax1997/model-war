/**
 * 参赛脚本可见面的名表**读取点**——名表本身不在本包里,规则也不在这里。
 *
 * 真源在 `@model-war/schema` 的 `script-surface.ts`(hld §6.2:白名单由 `schema` 提供,
 * 与沙箱 runtime 暴露的 API 面同源;ADR-0003 把「同源」落成同一套生成器机制)。
 * 本文件 import 的是**生成物**(`generated/script-surface.ts`,由 `pnpm run generate` 从真源产出),
 * 与 `allowlist.ts` 走的是同一条分发通道——本票没有为「D 需要的名字」另开一条。
 *
 * **本文件不实现任何规则。** 禁 `export`/`import`、禁 `__*` 前缀、禁列全局名、脚本体积上限,
 * 四条规则的形态(AST 遍历、违规产出、退出码)全属 D。这里交付的只是它们要读的三个名字,
 * 外加两个查询:查询是读取形态的封装(与 `allowlist.ts` 的 `isAllowedMathMember` 同类),
 * 「是否违规」的判定与产出都在规则侧。
 *
 * 「脚本体积上限」为什么不在这里:它是**数值**,取值在 `rulesets/*.json`(hld §6.2 末行)。
 * 名字与取值分家是 hld §3.2 那条分界线的直接应用:「谁在运行时决定这个值」归实现包,
 * 「这个值叫什么、什么形状」归真源包。体积上限的值运行时由规则集文件决定,所以它归那一格。
 *
 * 下一个碰这块的人(D)拿到的接口就是本文件里的这几个导出:规则侧一个名字都不用自己存,
 * 而「什么算宿主桥」「哪些名字被禁」「哪些符号被注入」三件事仍各自只有一处定义。
 *
 * 注入面那一张**不被任何规则消费**(真源侧头注:判「这个名字存不存在」归编译器名字解析,
 * 那一侧读类型面)。本文件只把它读成一个查询,不把它接进判定链。
 */

import {
  FORBIDDEN_GLOBAL_NAMES,
  HOST_BRIDGE_PREFIX,
  SANDBOX_INJECTED_API_SYMBOLS,
} from "./generated/script-surface.ts";

export { FORBIDDEN_GLOBAL_NAMES, HOST_BRIDGE_PREFIX, SANDBOX_INJECTED_API_SYMBOLS };

/** 查询用集合。与名表同源,不另存一份——规则层与将来的沙箱侧都走这里。 */
const FORBIDDEN_LOOKUP = new Set(FORBIDDEN_GLOBAL_NAMES);

/** 注入符号的查询用集合。与名表同源,不另存一份——规则层与将来的沙箱侧都走这里。 */
const INJECTED_LOOKUP = new Set(SANDBOX_INJECTED_API_SYMBOLS);

/** 某个标识符是否带宿主桥前缀。这是**命名约定**的判定,不是禁令:禁令由规则侧产出违规与退出码。 */
export const isHostBridgeSymbol = (symbol: string): boolean =>
  symbol.startsWith(HOST_BRIDGE_PREFIX);

/** 某个标识符(全局名或成员路径,如 `Date` / `Math.random`)是否在禁列里。 */
export const isForbiddenGlobalName = (name: string): boolean => FORBIDDEN_LOOKUP.has(name);

/**
 * 某个符号是否在沙箱注入面内。
 *
 * 注意它**不参与任何判定**:这张表不被静态校验器的任何规则消费(真源侧头注写明了理由——
 * 判「这个名字存不存在」是编译器名字解析的职责,而它读的是类型面)。本函数只是读取形态的
 * 封装,给将来的沙箱侧与面向模型的文档查询用;谁要在这里长出一条「表外的名字即违规」的规则,
 * 就是把两侧互相引用为依据,那正是真源侧写下的禁止项。
 */
export const isSandboxInjectedSymbol = (symbol: string): boolean => INJECTED_LOOKUP.has(symbol);
