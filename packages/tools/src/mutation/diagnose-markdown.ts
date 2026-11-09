/**
 * 诊断结果的 Markdown 渲染:纯函数,输入诊断结构,输出文本。
 *
 * ── 为什么报告是 Markdown 而不是 JSON ──────────────────────────────────────
 *
 * 这份报告的读者是**要做决定的人**(这个人刚把一条片子的基线往下接受过一次),
 * 而不是机器。机器读的那部分已经是 `diagnose.ts` 的类型;文本要回答的是
 * 「这片分数低,是因为测试弱、还是因为测不到、还是因为口径不对」——
 * 这三件事对应三种完全不同的下一步,混在一张 JSON 里读不出来。
 *
 * 报告落在 `reports/mutation/diagnosis.md`(产物目录,不入库),所以它是**每一次重跑就刷新**的
 * 观测产物,不是判据。判据在 `diagnose.ts` 与 `structural-attribution.ts`。
 */

import type { ShardDiagnosis } from "./diagnose.ts";

/** 报告头部要交代的元信息。 */
export type DiagnosisMeta = {
  /** 报告生成时刻(ISO)。 */
  readonly generatedAt: string;
  /** 每片报告的文件时间戳(没有报告的片不出现)。 */
  readonly reportTimes: Readonly<Record<string, string>>;
  /** 缺报告的片。 */
  readonly missingShards: readonly string[];
  /** 机制级归因(影响面不可按文件判定的那一条)。 */
  readonly mechanism: { readonly kind: string; readonly reason: string; readonly remedy: string };
};

const FLAG_LABEL: Readonly<Record<string, string>> = {
  "static-doubt": "静态变异体口径存疑",
  "timeout-noise": "超时噪声",
  unobservable: "不可测(测不到)",
  "real-gap": "真缺口(该补测试)",
  "value-survived": "值替换存活",
  "scope-partial": "报告不是全范围跑",
  clean: "无结构性成因",
};

const pct = (value: number): string => `${value.toFixed(2)}%`;

/** 摘要表:每片一行。 */
const summaryTable = (diagnoses: readonly ShardDiagnosis[]): string => {
  const header =
    "| 分片 | 有效变异体 | 真杀 | 超时 | 存活·值 | 存活·结构 | 存活·逻辑 | 未覆盖·真 | 未覆盖·不可测 | 原始分 | 去超时分 | 可信分 | 静态存活 | 头号问题 |";
  const divider = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const rows = diagnoses.map((d) => {
    const b = d.buckets;
    return (
      `| ${d.shard} | ${d.valid} | ${b.killed} | ${b.timeout} | ${b["survived-value"]} | ` +
      `${b["survived-structure"]} | ${b["survived-logic"]} | ${b.uncovered} | ${b.unobservable} | ` +
      `${pct(d.score)} | ${pct(d.scoreExcludingTimeout)} | ${pct(d.credibleScore)} | ` +
      `${d.staticSurvivors}/${d.staticMutants} | ${d.headline} |`
    );
  });
  return [header, divider, ...rows].join("\n");
};

/** 一片一节的构成表(按文件)。 */
const fileTable = (diagnosis: ShardDiagnosis, limit: number): string => {
  const header =
    "| 文件 | 变异体 | 真杀 | 超时 | 存活·值 | 存活·结构 | 存活·逻辑 | 未覆盖·真 | 未覆盖·不可测 | 静态 |";
  const divider = "|---|---|---|---|---|---|---|---|---|---|";
  const rows = diagnosis.files.slice(0, limit).map((f) => {
    const b = f.buckets;
    return (
      `| \`${f.file}\` | ${f.total} | ${b.killed} | ${b.timeout} | ${b["survived-value"]} | ` +
      `${b["survived-structure"]} | ${b["survived-logic"]} | ${b.uncovered} | ${b.unobservable} | ` +
      `${f.staticMutants} |`
    );
  });
  return [header, divider, ...rows].join("\n");
};

/** 渲染整份报告。 */
export const renderDiagnosisMarkdown = (
  diagnoses: readonly ShardDiagnosis[],
  meta: DiagnosisMeta,
  fileLimit = 12,
): string => {
  const lines: string[] = [];

  lines.push("# 变异分片可解释性诊断");
  lines.push("");
  lines.push("这份报告回答一个问题:**某片变异分数低,是因为测试弱、因为测不到、还是因为口径不对?**");
  lines.push("三种成因对应三种完全不同的下一步,混在一个数字里读不出来,所以这里把它们拆成八桶。");
  lines.push("");
  lines.push(`生成时刻:${meta.generatedAt}`);
  lines.push("");
  lines.push(
    "口径说明:`原始分` = Stryker 口径(Timeout 计入已检测),与入库基线可比;" +
      "`去超时分` = 把 Timeout 从分子里拿掉;`可信分` = 真杀 / (真杀 + 真缺口);" +
      "`静态存活` = 静态变异体里存活的 / 静态变异体总数(判定存疑的那一栏)。",
  );
  lines.push("");

  if (meta.missingShards.length > 0) {
    lines.push(
      `> 本次没有读到这些分片的报告:${meta.missingShards.join("、")}。` +
        "缺报告的片不进统计(要跑 `pnpm run mutate:<分片>` 才有)。",
    );
    lines.push("");
  }

  lines.push("## 摘要");
  lines.push("");
  lines.push(summaryTable(diagnoses));
  lines.push("");

  lines.push("## 机制级归因(影响面不可按文件判定)");
  lines.push("");
  lines.push(`**${meta.mechanism.kind}** —— ${meta.mechanism.reason}`);
  lines.push("");
  lines.push(`处置方向:${meta.mechanism.remedy}`);
  lines.push("");

  lines.push("## 逐片明细");
  lines.push("");
  for (const d of diagnoses) {
    const time = meta.reportTimes[d.shard] ?? "时间未知";
    lines.push(`### ${d.shard}`);
    lines.push("");
    lines.push(`报告时间:${time}`);
    lines.push("");
    lines.push(
      `有效变异体 ${d.valid}(另 ${d.total - d.valid} 个不进分母)、真杀 ${d.buckets.killed}、` +
        `超时 ${d.buckets.timeout}、存活 ${d.buckets["survived-value"] + d.buckets["survived-structure"] + d.buckets["survived-logic"]}` +
        `(值 ${d.buckets["survived-value"]} / 结构 ${d.buckets["survived-structure"]} / 逻辑 ${d.buckets["survived-logic"]})、` +
        `未覆盖 ${d.buckets.uncovered + d.buckets.unobservable}` +
        `(真 ${d.buckets.uncovered} / 不可测 ${d.buckets.unobservable})。`,
    );
    lines.push(
      `静态变异体 ${d.staticMutants} 个,其中存活 ${d.staticSurvivors} 个` +
        `(静态变异体在模块加载期执行,覆盖归因不可用,存活存疑)。`,
    );
    if (d.staticMutants > 0) {
      lines.push(
        `  静态部分的可信度:被杀 ${d.staticMutants - d.staticSurvivors} / 共 ${d.staticMutants}` +
          ` = ${pct(((d.staticMutants - d.staticSurvivors) / d.staticMutants) * 100)}。` +
          `实测里静态变异体**有时是能被杀的**(gen-core 153/247、runner 148/310),` +
          `所以「几乎全存活」不是常态,而是测量失效的信号。`,
      );
    }
    lines.push("");
    lines.push("**结论**");
    lines.push("");
    for (const flag of d.flags) {
      lines.push(
        `- **${FLAG_LABEL[flag.kind] ?? flag.kind}**(占 ${pct(flag.share * 100)}):${flag.note}`,
      );
      lines.push(`  - 建议:${flag.action}`);
    }
    lines.push("");
    lines.push(`**文件构成(前 ${fileLimit} 行,按「真缺口 + 超时 + 不可测」排序)**`);
    lines.push("");
    lines.push(fileTable(d, fileLimit));
    lines.push("");
  }

  lines.push("## 怎么读这份报告");
  lines.push("");
  lines.push(
    "- `存活·逻辑` 与 `未覆盖·真` 是**补测试的靶子**:行为没有被断言钉住,补测试会真的提高分数。",
  );
  lines.push(
    "- `存活·值` 多半是等价变异体,或断言只钉「表之间的关系」不钉「表的内容」——两种成因都要人判。",
  );
  lines.push(
    "- `未覆盖·不可测` 不是测试质量结论:要么把文件移出变异范围,要么换夹具让它可测。" +
      "把它算进「测试弱」会让低分片被误诊。",
  );
  lines.push(
    "- `超时` 被 Stryker 计入「已检测」,所以「测试挂死」会伪装成「测试抓得住」;" +
      "原始分与去超时分之差就是这部分。",
  );
  lines.push(
    "- **分片之间不可横向比较**(跨包覆盖在沙箱里指向仓库外,丢成 NoCoverage/Survived)。" +
      "这张表里每片各自成立,不排名。",
  );
  lines.push("");

  return `${lines.join("\n")}\n`;
};
