/** 固定优化试跑的纯数据身份；CLI 执行与 gen/runner 归属校验共用。 */
export const TRIAL_SEEDS = [101, 202, 303] as const;

/** 固定候选座位；对手事实不归入候选。 */
export const TRIAL_CANDIDATE_SEAT = 0 as const;

/** 下标即座位：候选与三份实际基准目录名；不包含选拔计划或运行时配置。 */
export const TRIAL_PLAYER_IDS = [
  "candidate",
  "cell-a-melee-pressure",
  "cell-b-expansion-economy",
  "cell-c-claim-no-harvest",
] as const;
