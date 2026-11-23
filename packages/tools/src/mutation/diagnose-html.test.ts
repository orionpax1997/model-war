/**
 * HTML 渲染的测试:它给人看,所以要钉住三件事——**自包含**、**不注入**、**不撒谎**。
 */

import { describe, expect, it } from "vitest";

import { renderDiagnosisHtml } from "./diagnose-html.ts";
import type { DiagnosisMeta } from "./diagnose-markdown.ts";
import type { ShardDiagnosis } from "./diagnose.ts";

const meta: DiagnosisMeta = {
  generatedAt: "2026-11-06T00:00:00.000Z",
  reportTimes: { demo: "2026-11-05T00:00:00.000Z" },
  missingShards: ["ghost"],
  mechanism: {
    kind: "cross-package-sandbox",
    reason: "跨包 import 指向仓库外的 dist。",
    remedy: "给 vitest 加 resolve.alias。",
  },
};

const diagnosis: ShardDiagnosis = {
  shard: "demo",
  total: 10,
  valid: 10,
  buckets: {
    killed: 4,
    timeout: 1,
    "survived-value": 2,
    "survived-structure": 1,
    "survived-logic": 1,
    uncovered: 1,
    unobservable: 0,
    other: 0,
  },
  detected: 5,
  coverageBased: 100,
  score: 50,
  scoreExcludingTimeout: 44.44,
  credibleScore: 66.67,
  staticMutants: 3,
  staticSurvivors: 3,
  staticByBucket: {
    killed: 0,
    timeout: 0,
    "survived-value": 2,
    "survived-structure": 1,
    "survived-logic": 0,
    uncovered: 0,
    unobservable: 0,
    other: 0,
  },
  files: [
    {
      file: "packages/demo/src/<script>.ts",
      total: 10,
      buckets: {
        killed: 4,
        timeout: 1,
        "survived-value": 2,
        "survived-structure": 1,
        "survived-logic": 1,
        uncovered: 1,
        unobservable: 0,
        other: 0,
      },
      staticMutants: 3,
      unobservableReason: undefined,
    },
  ],
  headline: "real-gap",
  flags: [
    {
      kind: "real-gap",
      count: 3,
      share: 0.3,
      note: "有 **3** 个真缺口。",
      action: "按 `foo.ts` 补断言,**不是**刷分。",
    },
  ],
};

const html = renderDiagnosisHtml([diagnosis], meta);

describe("自包含", () => {
  it("页面不引任何外部资源(不联网、单文件可转发)", () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/<img\b/);
    expect(html).not.toMatch(/@import/);
  });

  it("样式与脚本都内联在页面里", () => {
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
  });
});

describe("不注入", () => {
  it("来自文件名的尖括号被转义,不会被当成标签", () => {
    expect(html).not.toContain("<script>.ts");
    expect(html).toContain("&lt;script&gt;.ts");
  });
});

describe("不撒谎", () => {
  it("结论文本里的强调与代码被渲染成标记,不留原始符号", () => {
    expect(html).toContain("<strong>3</strong>");
    expect(html).toContain("<code>foo.ts</code>");
    expect(html).toContain("<strong>不是</strong>");
  });

  it("每片都在页面上,且带着它自己的分数", () => {
    expect(html).toContain('id="shard-demo"');
    expect(html).toContain("50.00%");
    expect(html).toContain("44.44%");
    expect(html).toContain("66.67%");
  });

  it("缺报告的分片被点名,而不是悄悄消失", () => {
    expect(html).toContain("ghost");
  });

  it("机制级归因与处置方向都在", () => {
    expect(html).toContain("cross-package-sandbox");
    expect(html).toContain("resolve.alias");
  });

  it("不出现抬基线的字样:它是观测,不是判据", () => {
    expect(html).not.toContain("accept-baseline");
    expect(html).not.toContain("mutate:baseline");
  });
});
