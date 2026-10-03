/**
 * 违规 → 面向模型的文本。这一层是**生成管线唯一会读到的东西**(它只看退出码与 stdout),
 * 所以它的形状本身就是契约(spec《违规输出》)。
 *
 * ── 同类合并:这一层存在的首要理由 ──────────────────────────────────────────────
 * 五轮迭代预算是参赛脚本唯一的调试资源,而「五处同类的错误」逐行列出会吃掉其中大半轮次
 * (每一处都要模型自己合成一轮动作)。所以**同一类别的多条违规并成一行**——一行里给全位置,
 * 模型改一轮就够。这不是排版优化,是需求(user story 4)。
 *
 * 合并按**规则类别**分组,不按文本分组:同一类里不同位置的违规文案可能不同(禁列里
 * `Date` 与 `Math.random` 是两条链、一个提醒),所以一行里先给全部位置、再把去重后的文案并排,
 * 不靠「取第一条的文案」把其余名字吞掉。
 *
 * ── 为什么用中文类别名而不是 `forbidden-global` ──────────────────────────────
 * 拿到的这段文本是给**参赛模型**读的,user story 3 要的是「一句能照着改的话」而不是一串内部记号。
 * 类别名属于机器层:它进结构化违规数组、进排序的兜底键,不进面向模型层的文字。
 *
 * 这张标签表刻意写成穷尽的 `Record`:新增规则类别而忘了给它一句面向模型的说法时,
 * `tsc -b` 会当场报错,而不是让一句英文内部记号悄悄漏给模型。
 */

import type { ScriptLintRule, ScriptViolation } from "../rules/script-violation.ts";

const RULE_LABELS: Record<ScriptLintRule, string> = {
  "syntax-error": "语法错误",
  "forbidden-global": "禁列全局名",
  "host-bridge": "宿主桥前缀",
  "module-system": "模块系统",
  "script-size": "脚本体积",
};

/** 一个类别在渲染文本里的样子。 */
type Group = {
  readonly rule: ScriptLintRule;
  readonly blocking: boolean;
  readonly violations: readonly ScriptViolation[];
};

/**
 * 按类别归并,并按「先出现的位置」排组。组内按位置排,是为了让同一行的位置列表本身有序——
 * 位置列表无序的话,两轮结果里同一个违规挪个位置就会让整行文本变样,生成管线的 diff 全是噪声。
 */
const groupByRule = (violations: readonly ScriptViolation[]): readonly Group[] => {
  const groups = new Map<ScriptLintRule, ScriptViolation[]>();
  for (const violation of violations) {
    const bucket = groups.get(violation.rule);
    if (bucket === undefined) {
      groups.set(violation.rule, [violation]);
    } else {
      bucket.push(violation);
    }
  }
  return [...groups.entries()]
    .map(([rule, members]) => ({
      rule,
      // 类别内只要有一条是拦截项,整组就是拦截项:迭代期的体积提示与同类的拦截项不共处一类,
      // 而真共处了,按「只提示不拦」渲染会把一条拦截项降级掉。
      blocking: members.some((violation) => violation.blocking),
      violations: [...members].sort(
        (left, right) =>
          (left.line ?? Number.POSITIVE_INFINITY) - (right.line ?? Number.POSITIVE_INFINITY) ||
          (left.column ?? Number.POSITIVE_INFINITY) - (right.column ?? Number.POSITIVE_INFINITY),
      ),
    }))
    .sort(
      (left, right) =>
        (left.violations[0]?.line ?? Number.POSITIVE_INFINITY) -
          (right.violations[0]?.line ?? Number.POSITIVE_INFINITY) ||
        left.rule.localeCompare(right.rule),
    );
};

const positionText = (violation: ScriptViolation): string =>
  violation.line === null ? "无位置" : `${violation.line}:${violation.column ?? 0}`;

const distinctTexts = (violations: readonly ScriptViolation[]): readonly string[] => [
  ...new Set(violations.map((violation) => violation.message)),
];

const renderGroup = (group: Group): string => {
  const positions = group.violations.map(positionText).join("、");
  return (
    `- [${group.blocking ? "拦截" : "提示"}] ${RULE_LABELS[group.rule]}` +
    ` · ${group.violations.length} 处 · 位置 ${positions} · ${distinctTexts(group.violations).join(" / ")}`
  );
};

/**
 * 一组违规 → 一段面向模型的文本。同类合并发生在这里,机器层拿到的仍是逐条的结构化数组
 * (归并不改数组,只改文本)——生成管线要 diff 两轮结果,靠的是数组那一层。
 *
 * 空数组渲染成「通过」那一句;返回的文本恒以换行结尾,调用方直接写 stdout 即可。
 */
export const renderViolations = (violations: readonly ScriptViolation[]): string => {
  if (violations.length === 0) {
    return "脚本静态校验通过:没有违规。\n";
  }
  const groups = groupByRule(violations);
  // 全是提示时退出码仍可为 0(spec《脚本体积上限》),所以抬头句必须说清「拦住还是没拦」。
  const blocked = violations.some((violation) => violation.blocking);
  const headline = blocked
    ? `脚本静态校验未通过:${violations.length} 处违规,按类别合并成 ${groups.length} 条。`
    : `脚本静态校验通过,但有 ${violations.length} 处提示(不拦截),按类别合并成 ${groups.length} 条。`;
  return `${[headline, ...groups.map(renderGroup)].join("\n")}\n`;
};
