/**
 * 诊断报告的渲染(纯函数):诊断结论 → Markdown。
 *
 * 与判定层分开:同一份结论可以落成不同形态的报告,判定逻辑不动。
 */

import {
  guardSitesByFile,
  shapeLabel,
  skipKindLabel,
  type VitestRulesDiagnosis,
} from "./diagnose-vitest-rules.ts";

/** 生成时刻(由入口传入,渲染层不读时钟)。 */
export type ReportMeta = {
  readonly generatedAt: string;
};

const shapeCounts = (diagnosis: VitestRulesDiagnosis): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const file of diagnosis.files) {
    for (const site of file.scan.sites) {
      if (site.shape === "plain") {
        continue;
      }
      counts.set(site.shape, (counts.get(site.shape) ?? 0) + 1);
    }
  }
  return counts;
};

/**
 * 渲染诊断报告。
 *
 * 报告要回答三个问题,顺序即重要性:
 *   ① 有没有「用例可能零断言执行」——有的话,那些用例就是假绿的来源;
 *   ② oxlint 那条规则报的命中,分别落在什么形态上(它只报位置,不给形态);
 *   ③ 规则看不见的那一类(`if (...) return;`)有几处、是什么形态。
 */
export const renderVitestRulesReport = (
  diagnosis: VitestRulesDiagnosis,
  meta: ReportMeta,
): string => {
  const lines: string[] = [];
  const totalSites = diagnosis.guardSites + diagnosis.loopSites + diagnosis.plainSites;
  const shapes = shapeCounts(diagnosis);

  lines.push("# vitest 插件规则的诊断");
  lines.push("");
  lines.push(
    "这份报告回答一个问题:**oxlint 那几条 vitest 规则报的命中,哪些是真缺陷、哪些是合法惯用法**。",
  );
  lines.push("");
  lines.push(
    "规则本身只报位置(`expect` 写在 `if` / 三元里),不报风险。位置与风险不是一回事:",
    "条件为假时那件事压根没发生,不查是对的。这里把风险拆成**可复算的判定**,",
    "于是「有没有假绿来源」从此是查出来的,不是回忆出来的。",
  );
  lines.push("");
  lines.push(`生成时刻:${meta.generatedAt}`);
  lines.push("");
  lines.push("复跑:`pnpm run observe:lint`(只读源码,不跑测试,不进任何门禁链)。");
  lines.push("");

  lines.push("## 摘要");
  lines.push("");
  lines.push("| 项 | 数 | 含义 |");
  lines.push("|---|---|---|");
  lines.push(
    `| 零断言执行的用例 | **${diagnosis.zeroAssertionCases.length}** | 该用例的**全部** \`expect\` 都在守卫里,条件为假时它一条断言都不跑,却仍然是绿的 |`,
  );
  lines.push(
    `| 用例级早退 | **${diagnosis.caseLevelSkips.length}** | 整条用例被 \`if (...) return;\` 跳过 |`,
  );
  lines.push(
    `| 守卫形态的 \`expect\` | ${diagnosis.guardSites} | oxlint \`no-conditional-expect\` 的命中面(形态分布见下) |`,
  );
  lines.push(`| 循环形态的 \`expect\` | ${diagnosis.loopSites} | 逐元素断言的常规写法,不算守卫 |`);
  lines.push(`| 无守卫的 \`expect\` | ${diagnosis.plainSites} | 无条件执行的断言 |`);
  lines.push(
    `| 局部早退 | ${diagnosis.silentSkips - diagnosis.caseLevelSkips.length} | 辅助函数里的早退,返回给调用方处理 |`,
  );
  lines.push("");

  lines.push("### 用例级判定分布");
  lines.push("");
  lines.push("| 判定 | 用例数 | 含义 |");
  lines.push("|---|---|---|");
  lines.push(
    `| \`all-conditional\` | ${diagnosis.caseVerdicts["all-conditional"]} | 全部断言都在守卫里 → 条件为假时零断言执行 |`,
  );
  lines.push(
    `| \`partly-conditional\` | ${diagnosis.caseVerdicts["partly-conditional"]} | 部分断言在守卫里 → 某些分支没被查(盲区) |`,
  );
  lines.push(
    `| \`loop-only\` | ${diagnosis.caseVerdicts["loop-only"]} | 断言都在循环体里 → 逐元素检查的常规写法 |`,
  );
  lines.push(`| \`none\` | ${diagnosis.caseVerdicts.none} | 断言都无条件执行 |`);
  lines.push(
    `| \`no-expect\` | ${diagnosis.caseVerdicts["no-expect"]} | 用例里没有断言(交给 \`vitest/expect-expect\` 那条规则管) |`,
  );
  lines.push("");

  lines.push("### 守卫形态分布");
  lines.push("");
  lines.push("| 形态 | 落点数 |");
  lines.push("|---|---|");
  for (const [shape, count] of [...shapes].sort((left, right) => right[1] - left[1])) {
    lines.push(`| ${shapeLabel(shape as never)} | ${count} |`);
  }
  lines.push("");

  lines.push("## 结论");
  lines.push("");
  if (diagnosis.zeroAssertionCases.length === 0) {
    lines.push(
      "- **没有「用例可能零断言执行」的用例。** 全仓每条用例的断言要么无条件执行,",
      "  要么是逐元素检查。oxlint 那条规则命中的落点里,**没有一条落在「整条用例的断言都在守卫里」**",
      "  这种形态上——所以那些命中不是假绿来源。",
    );
  } else {
    lines.push(
      `- **有 ${diagnosis.zeroAssertionCases.length} 条用例可能零断言执行**:条件为假时它们一条断言都不跑,却仍然是绿的。`,
      "  这些是假绿的直接来源,逐条处置(见下方清单)。",
    );
  }
  if (diagnosis.caseLevelSkips.length === 0) {
    lines.push(
      "- **没有用例级的早退。** `if (...) return;` 全部发生在局部辅助函数里,返回给调用方处理,",
      "  不会让整条用例静默变绿。",
    );
  } else {
    lines.push(
      `- **有 ${diagnosis.caseLevelSkips.length} 处用例级早退**:条件不满足时整条用例跳过,仍然是绿的。`,
    );
  }
  lines.push(
    "- 局部早退(辅助函数里)不是缺陷:helper 对不适用输入返回「没有结果」,由调用方决定怎么办。",
    "  报告把它们列出来是为了让人知道**有多少条路径没有被查**,而不是说它们写错了。",
  );
  lines.push("");

  if (diagnosis.zeroAssertionCases.length > 0) {
    lines.push("## 零断言用例清单");
    lines.push("");
    lines.push("| 文件 | 行 | 用例 |");
    lines.push("|---|---|---|");
    for (const file of diagnosis.files) {
      for (const verdict of file.scan.cases) {
        if (verdict.verdict !== "all-conditional") {
          continue;
        }
        lines.push(`| \`${file.path}\` | ${verdict.line} | ${verdict.testName} |`);
      }
    }
    lines.push("");
  }

  lines.push("## 守卫落点明细(按文件)");
  lines.push("");
  lines.push(
    "这些是 oxlint `no-conditional-expect` 命中的落点,附形态与条件文本。",
    "形态只说明「怎么执行的」,不说明「该不该查」——后者要人判,判据在前面的结论里。",
  );
  lines.push("");
  for (const [path, sites] of guardSitesByFile(diagnosis)) {
    lines.push(`### \`${path}\``);
    lines.push("");
    lines.push("| 行 | 形态 | 条件 |");
    lines.push("|---|---|---|");
    for (const site of sites) {
      lines.push(
        `| ${site.line} | ${shapeLabel(site.shape)} | \`${site.conditionText.replace(/\|/gu, "\\|")}\` |`,
      );
    }
    lines.push("");
  }

  lines.push("## 早退明细");
  lines.push("");
  lines.push("| 文件 | 行 | 形态 | 作用域 | 作用域内还有断言 | 条件 |");
  lines.push("|---|---|---|---|---|---|");
  for (const file of diagnosis.files) {
    for (const skip of file.scan.silentSkips) {
      lines.push(
        `| \`${file.path}\` | ${skip.line} | ${skipKindLabel(skip.kind)} | ${skip.scope} | ` +
          `${skip.assertsAfter ? "有" : "无"} | \`${skip.conditionText.replace(/\|/gu, "\\|")}\` |`,
      );
    }
  }
  lines.push("");

  if (diagnosis.parseErrors.length > 0) {
    lines.push("## 解析失败的文件");
    lines.push("");
    lines.push(
      "解析不过的文件没有结论:oxc 解析失败时给的是一棵残缺的树,在残树上判「断言在不在守卫里」",
    );
    lines.push("得到的是不可复现的结论,这类文件不算干净、也不算有缺陷。");
    lines.push("");
    for (const [path, message] of diagnosis.parseErrors) {
      lines.push(`- \`${path}\`:${message}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    `全仓 \`expect\` 落点共 ${totalSites} 处(无守卫 ${diagnosis.plainSites} / 守卫 ${diagnosis.guardSites} / 循环 ${diagnosis.loopSites})。`,
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
};
