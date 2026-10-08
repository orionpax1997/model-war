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

// 参赛脚本可见面的名单:宿主桥前缀 / 禁列全局名 / 沙箱注入 API 符号表(hld §6.2)。
// 同样经生成器分发到工具包,静态校验器(D)与沙箱执行器(G)读的是同一份。
export {
  FORBIDDEN_GLOBAL_NAMES,
  HOST_BRIDGE_PREFIX,
  SANDBOX_INJECTED_API_SYMBOLS,
  SANDBOX_INJECTED_API_SYMBOL_CATALOG,
} from "./script-surface.js";
export type { InjectedApiSymbolEntry, InjectedApiSymbolKind } from "./script-surface.js";

// 「没生效」的后果:每个错误码落在「丢弃」还是「异常」,以及每类丢的是什么、累计在哪儿。
// 面向模型的「丢弃 vs 异常」对照表与错误码表由它渲染,同一份真源出两处落点。
export {
  SCRIPT_OUTCOME_BY_CODE,
  SCRIPT_OUTCOME_CATALOG,
  SCRIPT_OUTCOME_CLASSES,
} from "./script-outcome.js";
export type {
  ScriptOutcomeClass,
  ScriptOutcomeEntry,
  ScriptOutcomeKind,
} from "./script-outcome.js";

// 沙箱 runtime bundle 的工程常量:产物路径 / 产物字节 sha256 / `quickjs-wasi` 版本。
// 供 `apps/cli`(装载期比对存档 meta)与 `packages/tools`(漂移门禁)两侧共享;
// 引擎不从这里取,以免污染它「恰好一个导出符号 runMatch」的对外面(见 ADR 0007)。
export {
  QUICKJS_WASI_VERSION,
  QUICKJS_WASI_WASM_PATH,
  SANDBOX_RUNTIME_ARTIFACT_PATH,
  SANDBOX_RUNTIME_HASH,
} from "./sandbox-runtime.js";

/** 规则集版本号。必须与 `docs/rules-vN/` 目录名、`rulesets/vN.json` 的文件名三处一致,
 * 装载期错配即拒跑,不静默降级(hld §7.1)。
 */
export type RulesetVersion = "v1";

/** 规则集版本真源。各包一律引用本常量,不得各自硬编码字符串。 */
export const RULESET_VERSION: RulesetVersion = "v1";

/**
 * JSON 可表示的值。数据格式定义归本包所有(hld §2.2.5):
 * ruleset / 地图 / 存档 meta / 对局输入 / result / 回放行都是它的形状。
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

// 跨进程的两份物化件:冻结脚本存档的 `meta.json` 与单个对局的 `input.json`。
// 形状一次定死,取值随生成 / 物化管线落库(理由写在各自头注里)。
export * from "./archive-meta.js";
export * from "./match-input.js";

// 失败记录的 `failed-<runId>.json`(形状家归真源包,§2.2.5):报告侧从记录本身读失败名单,
// 不新增 `runner → gen` 的反向依赖边;键序即书写序,gen 侧照此序列化。
export * from "./failure-record.js";

// 回放 JSONL 的三行(`meta` / `tick` / `result`,hld §7.5)。形状一次定死,取值由引擎写出。
// 末行 `result` 的终局原因取值域由本模块的 `ReplayOutcomeReason` 定死(09 票销掉 `match-result`)。
export * from "./replay-line.js";

// 观测行:回放**之外**那份 `observations.jsonl` 的一行(墙钟软限 / 内存压力两类只披露的观测)。
// 与回放线同级但独立:它永远不进回放、更不进 `stateHash`(hld §5.3)。
export * from "./observation-line.js";

// 各域文件(形状 / 参数清单 / 常量表)一律从这里再导出。
export * from "./map.js";
export * from "./pending.js";
export * from "./ruleset.js";
export * from "./ruleset-keys.js";
