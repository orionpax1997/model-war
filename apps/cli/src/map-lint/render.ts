/**
 * 地图违规 → 面向地图作者的文本。这一层的形状本身就是契约:
 * **stdout 是 `map-lint` 的全部对外输出**,人改图靠的就是这段文本。
 *
 * ── 同类合并:这一层存在的首要理由 ────────────────────────────────────────────
 * 一张 64×64 的图改坏了对称性,逐格列出就是**几千行**——没有人会去读,而读不到就等于没报。
 * 所以**同一类别的多条违规并成一行**:一行里给全部定位,作者改一轮就够。
 * 合并按**规则类别**分组(不按文本分组:同一类里不同格的文案可能不同),
 * 一行里先给全部定位、再把去重后的文案并排,不靠「取第一条的文案」把其余吞掉。
 * 与 `render-violations.ts`(参赛脚本那一侧)同一形状,只是断言对象从源码换成地图。
 *
 * ── 两层输出:机器层拿到的仍是逐条的结构化数组 ─────────────────────────────────
 * 归并不改数组,只改文本。机器层那条缝上留着位置与类别,排障与 diff 靠它。
 *
 * 这张标签表刻意写成**穷尽的 `Record`**:新增规则类别而忘了给它一句面向作者的说法时,
 * `tsc -b` 会当场报错,而不是让一句英文内部记号悄悄漏给作者。
 */

import type { MapLintRule, MapLintViolation } from "./rules.js";

const RULE_LABELS: Record<MapLintRule, string> = {
  "terrain-symmetry": "地形未四重旋转对称",
  "sites-symmetry": "点位未四重旋转对称",
  "site-overlap": "点位重叠",
  "site-on-wall": "点位压在墙上",
  "site-out-of-bounds": "点位越界",
  "terrain-shape": "地形尺寸与 size 不符",
  "variant-slot-not-orbit": "变体槽位不是完整四重轨道",
  "variant-slot-on-site": "变体槽位压住点位或八邻域",
  "variant-slot-on-spawn": "变体槽位压住初始单位",
};

/** 一个类别在渲染文本里的样子。 */
type Group = {
  readonly rule: MapLintRule;
  readonly violations: readonly MapLintViolation[];
};

/** 按类别归并,并按「先出现的定位」排组。组内按定位排,否则两轮结果 diff 出来全是噪声。 */
const groupByRule = (violations: readonly MapLintViolation[]): readonly Group[] => {
  const groups = new Map<MapLintRule, MapLintViolation[]>();
  for (const violation of violations) {
    const bucket = groups.get(violation.rule);
    if (bucket === undefined) groups.set(violation.rule, [violation]);
    else bucket.push(violation);
  }
  return [...groups.entries()]
    .map(([rule, members]) => ({
      rule,
      violations: [...members].sort((left, right) =>
        (left.where ?? "").localeCompare(right.where ?? ""),
      ),
    }))
    .sort(
      (left, right) =>
        (left.violations[0]?.where ?? "").localeCompare(right.violations[0]?.where ?? "") ||
        left.rule.localeCompare(right.rule),
    );
};

const distinctTexts = (violations: readonly MapLintViolation[]): readonly string[] => [
  ...new Set(violations.map((violation) => violation.message)),
];

const renderGroup = (group: Group): string => {
  const positions = group.violations.map((violation) => violation.where ?? "无定位").join("、");
  return (
    `- ${RULE_LABELS[group.rule]} · ${group.violations.length} 处 · 位置 ${positions}` +
    ` · ${distinctTexts(group.violations).join(" / ")}`
  );
};

/**
 * 一组违规 → 一段面向地图作者的文本。空数组渲染成「通过」那一句;
 * 返回的文本恒以换行结尾,调用方直接写 stdout 即可。
 */
export const renderMapViolations = (violations: readonly MapLintViolation[]): string => {
  if (violations.length === 0) {
    return "地图校验通过:没有违规。\n";
  }
  const groups = groupByRule(violations);
  const headline = `地图校验未通过:${violations.length} 处违规,按类别合并成 ${groups.length} 条。`;
  return `${[headline, ...groups.map(renderGroup)].join("\n")}\n`;
};
