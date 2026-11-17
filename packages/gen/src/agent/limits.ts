/**
 * 会话级预算:步数、总墙钟、上下文守卫。**这几个数字的真源就是这里**——身份清单
 * (`agent/identity.ts`)从这里取,`rulesets/*.json` 不掺和(那里管对局规则与数值)。
 *
 * ── 为什么它们不是可调参数,而是身份 ──
 *
 * 上限改一次,模型面对的世界就变了(ADR-0029/0032):档案结构完全一样、读侧照读,但「几步
 * 用完」「一次能看多少字节」全变了。所以它们进 `harnessDigest`,改一次即断代——这不是缺陷,
 * 是「换 harness」的定义。回填方向只有一条:实测之后改这里的数,而不是放松判据。
 *
 * ── 单步墙钟不在这里 ──
 *
 * 它属于执行器(`sandbox/execute.ts` 的 `DEFAULT_STEP_WALL_CLOCK_MS`),而且**不是 deadline**
 * (ADR-0029):它只用于杀 `sleep 999` 这类挂起,取值不该影响成绩判读。身份清单引用那一份,
 * 不在这里再写一个。
 */

/** 会话的步数上限。一步 = 一次模型调用 = 一条过程记录条目。 */
export const AGENT_MAX_STEPS = 120;

/**
 * 会话的总墙钟上限(毫秒):三十分钟。
 *
 * 取三十分钟而不是一小时:步数上限内每步平均十几秒才会用满,慢模型几步就能吃满;一小时的
 * 那条线等于不存在。它与步数是两项**硬约束**:任一用尽即停,而停下不决定落档(ADR-0032)。
 */
export const AGENT_TOTAL_WALL_CLOCK_MS = 30 * 60 * 1_000;

/**
 * 上下文守卫的比例:**80%**,用一对整数表达。
 *
 * 用整数而不是 `0.8`,是为了让判据落在 `inputTokens × 5 ≥ contextLength × 4` 这种精确比较上——
 * 浮点比例在边界上会给出一个「差一 token」说不清的结果,而这条判据的全部用处就是边界。
 */
export const CONTEXT_GUARD = { numerator: 4, denominator: 5 } as const;

/**
 * 守卫是否触发:上一轮的精确输入用量已经到窗口的 80%。
 *
 * 用上一轮的读数而不是估算,理由在 ADR-0035:估算会把「再发一次大概多少 token」变成第二个
 * 会漂的真相,而这个数端点每次都告诉了我们。它的定位是**逻辑兜底**(会话持续整读大文件时
 * 本可以本地判掉的一次 400),不是主约束。
 */
export const contextGuardTrips = (inputTokens: number, contextLength: number): boolean =>
  inputTokens * CONTEXT_GUARD.denominator >= contextLength * CONTEXT_GUARD.numerator;
