/**
 * schema 包:类型、常量、参数 key 清单与 JSON Schema 的唯一真源(hld §2.2.5)。
 * 约束:本包无运行时代码(hld §3.2),不依赖任何包。
 *
 * **本文件是对外唯一入口**(spec《真源包的导出面》):包里按域分文件,
 * 公共面一律从这里再导出。做成多入口等于对外承诺,将来想收窄就晚了(ADR-0003)。
 * 因此域文件之间也只经本文件互相看见(仅类型 import,编译后不留痕)。
 */

// 名单类数据(hld §6.2:静态校验器与沙箱 runtime 消费同一份)。经生成器分发到工具包,
// 规则层读的是生成物而不是本包——分界线是「能不能 afford 构建」,见 ADR-0003。
export { ALLOWED_MATH_MEMBERS, BUILTIN_GLOBAL_NAMES } from "./builtin-globals.js";

/**
 * 规则集版本号。必须与 `docs/rules-vN/` 目录名、`rulesets/vN.json` 的文件名三处一致,
 * 装载期错配即拒跑,不静默降级(hld §7.1)。
 */
export type RulesetVersion = "v1";

/** 规则集版本真源。各包一律引用本常量,不得各自硬编码字符串。 */
export const RULESET_VERSION: RulesetVersion = "v1";

/**
 * JSON 可表示的值。数据格式定义归本包所有(hld §2.2.5):
 * ruleset / 地图 / 存档 meta / result / 回放行都是它的形状。
 *
 * 注意:带索引签名的对象类型只接受**type 别名**,不接受 interface
 * (interface 没有隐式索引签名,不能赋给本类型)。凡是要进入回放或 meta 的状态结构,
 * 一律用 `type` 而非 `interface` 声明。
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

// 各域文件(形状 / 参数清单 / 常量表)一律从这里再导出。
export * from "./map.js";
export * from "./pending.js";
export * from "./ruleset.js";
export * from "./ruleset-keys.js";
