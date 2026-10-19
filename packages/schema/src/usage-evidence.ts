/** 用量证据的纯数据白名单；生成写出与报告读入各自验证外部值，不共享执行代码。
 * cache/reasoning 与总量可能重叠；这些字段是证据，不是可累加的账单。
 */
const TOKEN_FIELDS = [
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "reasoning_tokens",
  "thinking_tokens",
  "cached_tokens",
  "cached_creation_tokens",
  "cache_write_tokens",
  "audio_tokens",
  "accepted_prediction_tokens",
  "rejected_prediction_tokens",
] as const;
const CACHE_CREATION_FIELDS = ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"] as const;

/** 对象路径 -> 可保留的数字键；仅允许这些有限深度的已知对象。 */
export const USAGE_NUMERIC_FIELDS = {
  "": TOKEN_FIELDS,
  prompt_tokens_details: TOKEN_FIELDS,
  completion_tokens_details: TOKEN_FIELDS,
  input_tokens_details: TOKEN_FIELDS,
  output_tokens_details: TOKEN_FIELDS,
  cache_creation: CACHE_CREATION_FIELDS,
  "billing_usage.claude_usage": TOKEN_FIELDS,
  "billing_usage.claude_usage.cache_creation": CACHE_CREATION_FIELDS,
} as const;

export const USAGE_ENUM_FIELDS = {
  usage_semantic: ["openai", "anthropic"],
  usage_source: ["openai", "anthropic"],
  "billing_usage.semantic": ["anthropic"],
  "billing_usage.source": ["claude_messages"],
} as const;

/** 每项是同一指标的备选来源，不相加；顺序保持旧档报告的优先级。 */
export const USAGE_READING_PATHS = {
  input: ["prompt_tokens", "input_tokens"],
  output: ["completion_tokens", "output_tokens", "billing_usage.claude_usage.output_tokens"],
  cacheRead: [
    "prompt_tokens_details.cached_tokens",
    "input_tokens_details.cached_tokens",
    "cache_read_input_tokens",
    "billing_usage.claude_usage.cache_read_input_tokens",
  ],
  cacheWrite: [
    "prompt_tokens_details.cached_creation_tokens",
    "prompt_tokens_details.cache_write_tokens",
    "input_tokens_details.cache_write_tokens",
    "cache_creation_input_tokens",
    "billing_usage.claude_usage.cache_creation_input_tokens",
  ],
  reasoning: [
    "completion_tokens_details.reasoning_tokens",
    "output_tokens_details.reasoning_tokens",
    "output_tokens_details.thinking_tokens",
  ],
} as const;

/** Anthropic 的三项互斥输入分量；缺任何一项都不能补零。 */
export const USAGE_ANTHROPIC_INPUT_PATHS = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;
export const USAGE_BILLING_INPUT_PATHS = [
  "billing_usage.claude_usage.input_tokens",
  "billing_usage.claude_usage.cache_read_input_tokens",
  "billing_usage.claude_usage.cache_creation_input_tokens",
] as const;
