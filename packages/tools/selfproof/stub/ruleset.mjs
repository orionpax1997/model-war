// ruleset.mjs —— packages/tools/selfproof/stub 的标定桩参数基线。
// 保留标定时的默认值；当前参数真源是 rulesets/*.json。
// selfproof 入口在模块加载前通过 STUB_SET 注入规则集覆盖值，worker 自动继承环境变量。
// 此目录保留原有 JS/MJS 格式与仿真逻辑，formatter/linter 对该目录精确忽略。

function overrides() {
  const raw = process.env.STUB_SET;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`STUB_SET is not valid JSON: ${err.message}`);
  }
}

const OV = overrides();
export const APPLIED_OVERRIDES = OV;
const ov = (key, dflt) => (Object.hasOwn(OV, key) ? OV[key] : dflt);

export const RULESET = {
  rulesetVersion: 'stub-v1 (from draft rules.md §10)'
    + (Object.keys(OV).length > 0 ? ` + override ${JSON.stringify(OV)}` : ''),

  tickLimit: 600,

  // 经济
  harvestRate: 1,
  carryLimit: 20,
  resourcePerSite: ov('resourcePerSite', 125),
  initialResources: 16,

  // 占领
  captureTicks: 10,

  // 终局分
  baseScore: 4,
  resourceScore: 1,
  unitCostDivisor: 6,

  // 兵种表：cost / hp / damage / range / speed / spawnTicks
  roster: {
    worker: { cost: 4, hp: 2, damage: 0, range: 1, speed: 1, spawnTicks: 2 },
    melee: { cost: 8, hp: 12, damage: 3, range: 1, speed: 1, spawnTicks: 4 },
    ranged: { cost: 12, hp: 4, damage: 2, range: 2, speed: 1, spawnTicks: 6 },
    cavalry: { cost: 16, hp: 6, damage: 2, range: 1, speed: 2, spawnTicks: 8 },
  },
};

export const UNIT_TYPES = ['worker', 'melee', 'ranged', 'cavalry'];

export function unitStat(type) {
  const s = RULESET.roster[type];
  if (!s) throw new Error(`unknown unit type: ${type}`);
  return s;
}

export function chebyshev(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx > dy ? dx : dy;
}
