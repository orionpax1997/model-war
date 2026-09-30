/**
 * schema 包:类型、常量、参数 key 清单与 JSON Schema 的唯一真源(hld §2.2.5)。
 * 约束:本包无运行时代码(hld §3.2),不依赖任何包。
 * 空壳阶段只落两件真源性的东西——规则集版本与 JSON 值形状;其余随各自的使用者落地。
 */

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
