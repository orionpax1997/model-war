/**
 * 允许名单——**本包内唯一真源**,两个消费者都只从这里读:
 *
 * 1. 引擎包的禁浮点门禁(`rules/no-float.ts`,本 ticket 落地);
 * 2. 将来的参赛脚本静态校验(gen:validator,hld §6.2)——消费同一份名单,于是
 *    「参赛脚本能用什么」与「引擎能用什么」不会各答一次。
 *
 * 本模块**刻意不依赖 `rules/` 也不依赖 `gate/`**:名单要先于两个消费者存在,才谈得上
 * 「一份真源」。第二个消费者落地时,新增的 import 方向是 `rules/… → allowlist.ts`,
 * 与第一个消费者同向,allowlist 自身不 import 任何本包内模块。
 *
 * **将来由 `@model-war/schema` 生成**(hld §2.2.5:白名单符号表由 `schema` 生成,与沙箱
 * runtime 暴露的 API 面同源)。今天是一张手写的静态表;`schema` 落地后这张表改为生成物、
 * 真源随之迁到 `schema` 一侧——**生成物与手写表不得并存**,否则又多一份会漂移的副本。
 */

/**
 * 收录判据:输入全整数时,输出**必为整数**(精确整数域 → 整数值域)。
 *
 * 明确不收:
 * - `sqrt`/`pow`/`cbrt`/`log*`/`sin` 等——产出非整数;
 * - `random`——非确定源(hld §6.2 确定性污染源);
 * - `E`/`PI`/`LN2` 等——常量本身即非整数值,取出来就破坏整数闭包;
 * - `round` 收:`Math.round` 只做就近取整,整数入整数出;
 * - `min`/`max`/`imul` 收:整数入整数出(`imul` 出的是 32 位有符号整数)。
 */
export const ALLOWED_MATH_MEMBERS: readonly string[] = [
  "abs",
  "ceil",
  "clz32",
  "floor",
  "imul",
  "max",
  "min",
  "round",
  "sign",
  "trunc",
];

/** 查询用集合。与名单同源,不另存一份——两个消费者都走这里,免得各自缓存出偏差。 */
const LOOKUP = new Set(ALLOWED_MATH_MEMBERS);

/** 某个 `Math` 成员是否在允许名单内。名单之外的成员一律判违规,不在调用处开例外。 */
export const isAllowedMathMember = (member: string): boolean => LOOKUP.has(member);
