/**
 * 预算配置:组装层把规则集里**已启用**的轨与阈值解析好后传进引擎的那份形状。
 *
 * ── 为什么单独一格,而不住在 `run-match.ts` ──
 *
 * 这份形状有两个消费者:`runMatch` 的入参(组装层递进来)与结算管线的 `TickContext`
 * (步 5 的淘汰判定要读 `exceptionTickLimit`)。若把它留在 `run-match.ts`,结算管线
 * (`processor` 那一格)就得反过来 import `run-match`——而 `run-match` 又 import
 * `processor`,形成一条循环依赖(dependency-cruiser 的 `no-circular` 直接红)。
 * 它本身**不 import 任何东西**,所以放在一个中立的小模块里,两边都只依赖它。
 *
 * ── 字段缺席即该轨不启用 ──
 *
 * 规则集里取未定值的键,由组装层读键清单的两态字段(`calibration.state`)决定缺席;引擎不认识
 * 「未定值」这个概念(解析归组装层,见 spec《未定值与预算配置》)。所以本类型用**每个可选字段
 * 表达一条轨**,而不是用「值 0 即不启用」——「未定」与「真想设成 0」是两件事。
 *
 * 脚本体积上限不进这里:它是编译期的事,判定点在编译/校验层(编译后产物的字节数)。
 */
export type BudgetConfig = {
  /** 累计异常判负阈值(次/整局)。达它即该席位判负出局(步 5 的既有淘汰变更)。 */
  readonly exceptionTickLimit?: number;
  /** 单 tick 控制流事件计数上限(次/tick)。执行器侧判定,超限产 `tripped` 观测。 */
  readonly eventTickLimit?: number;
  /** 单 tick API 调用计数上限(次/tick)。执行器侧判定,超限产 `tripped` 观测。 */
  readonly apiCallTickLimit?: number;
  /** VM 线性内存分配上限(bytes)。 */
  readonly memoryLimit?: number;
  /** 内存判据判罚线(bytes,tick 末存活堆读数)。 */
  readonly memoryTickCeiling?: number;
  /** 单 tick 墙钟软限(ms,只观测)。 */
  readonly wallClockSoftLimit?: number;
  /** 墙钟硬超时(ms,只作废该场)。 */
  readonly wallClockHardTimeout?: number;
};
