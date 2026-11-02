import {
  TRIAL_CANDIDATE_ID,
  TRIAL_GRID_MAP_NAMES,
  TRIAL_GRID_SEED_BASE,
  TRIAL_GRID_SEAT_COUNT,
  TRIAL_PLAN_VERSION,
  type TrialPlan,
  type TrialPlanMatch,
  type TrialPlanScript,
} from "@model-war/schema";

/** 四份夹具陪练：id 是角色限定写法（与 `loadSparringPool` 交回的同一形状）。 */
const scripts: readonly TrialPlanScript[] = [
  { role: "top", id: "top:alpha", source: "archive:alpha/r1", scriptSha256: "1".repeat(64) },
  { role: "mid", id: "mid:beta", source: "archive:beta/r2", scriptSha256: "2".repeat(64) },
  { role: "last", id: "last:gamma", source: "archive:gamma/r3", scriptSha256: "3".repeat(64) },
  {
    role: "incumbent",
    id: "incumbent:delta",
    source: "archive:delta/r4#substitute",
    scriptSha256: "4".repeat(64),
  },
] as const;

/**
 * gen 侧测试用的评测网格计划夹具（**不产摘要、不读盘**）。
 *
 * 场序与 runner 的派生规则同形（组合 → 座位轮转 → 地图），但本包不得 import runner，
 * 所以这里留一份纯数据构造：它只服务于「读观测/读汇总/回喂」这些消费端，不参与生产。
 */
export const gridPlanFixture = (): TrialPlan => {
  const maps = [
    { name: TRIAL_GRID_MAP_NAMES[0], sha256: "a".repeat(64) },
    { name: TRIAL_GRID_MAP_NAMES[1], sha256: "b".repeat(64) },
  ];
  const matches: TrialPlanMatch[] = [];
  for (let comboIndex = 0; comboIndex < scripts.length; comboIndex += 1) {
    const present = scripts.filter((_, index) => index !== comboIndex);
    const base = [TRIAL_CANDIDATE_ID, present[0]!.id, present[1]!.id, present[2]!.id] as const;
    for (let rotation = 0; rotation < TRIAL_GRID_SEAT_COUNT; rotation += 1) {
      const offset = rotation % TRIAL_GRID_SEAT_COUNT;
      const seats = [
        ...base.slice(offset),
        ...base.slice(0, offset),
      ] as unknown as TrialPlanMatch["seats"];
      for (const [mapIndex, map] of maps.entries()) {
        const matchIndex =
          comboIndex * TRIAL_GRID_SEAT_COUNT * maps.length + rotation * maps.length + mapIndex;
        matches.push({
          matchIndex,
          comboIndex,
          seed: TRIAL_GRID_SEED_BASE + matchIndex,
          seats,
          candidateSeat: seats.indexOf(TRIAL_CANDIDATE_ID) as 0 | 1 | 2 | 3,
          map: map.name,
          mapSha256: map.sha256,
        });
      }
    }
  }
  return {
    version: TRIAL_PLAN_VERSION,
    ruleset: "v2",
    rulesetSha256: "9".repeat(64),
    sandboxRuntimeHash: "8".repeat(64),
    scripts,
    maps,
    matchesPerCandidate: matches.length,
    matches,
    // 夹具的摘要只是一串 64 位十六进制（消费端不重建计划，摘要比对归 runner / 入口）。
    planSha256: "0".repeat(64),
  };
};
