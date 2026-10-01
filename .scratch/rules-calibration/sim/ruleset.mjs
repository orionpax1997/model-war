// ruleset.mjs —— 桩模拟器的参数取值（抄自 .scratch/rules-calibration/draft/rules.md §10，
// 终值来源：票 03（经济/终局分）、04（兵种/时间表）、05（captureTicks）；
// `resourcePerSite` 经票 09 收口由 125 修正为 200，见 handoff.md §1 与 gdd §8 #7/#8）。
// 真源仍是 rulesets/*.json（尚未生成）；此处只把契约草案的终值固化一份，供 throwaway 桩使用。
//
// 【复跑支持·票 09】默认值保持 125（08 的证据基线），票 09 的复跑通过环境变量 STUB_SET 注入覆盖值：
//   STUB_SET='{"resourcePerSite":200}' node run-all.mjs --out=data-rerun-200
// 覆盖只经环境变量传播（run-all 的 worker 子进程自动继承），不引入新的传参层。

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
