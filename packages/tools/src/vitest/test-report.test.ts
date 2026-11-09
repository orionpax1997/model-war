import { describe, expect, it } from "vitest";
import {
  compareRuns,
  consistentlyFailing,
  isParseProblem,
  parseVitestResults,
  slowTail,
  type TestRun,
} from "./test-report.ts";

const outcome = (
  fullName: string,
  status: string,
  durationMs: number,
  file = "a.test.ts",
): TestRun["outcomes"][number] => ({ fullName, status, durationMs, file });

const run = (outcomes: readonly TestRun["outcomes"][number][]): TestRun => ({
  outcomes,
  totalTests: outcomes.length,
  passedTests: outcomes.filter((item) => item.status === "passed").length,
  failedTests: outcomes.filter((item) => item.status === "failed").length,
  pendingTests: 0,
  wallClockMs: 0,
});

describe("解析 vitest 的 json 报告", () => {
  it("读出每条用例的耗时与状态", () => {
    const parsed = parseVitestResults({
      numTotalTests: 2,
      numPassedTests: 1,
      numFailedTests: 1,
      numPendingTests: 0,
      startTime: 100,
      testResults: [
        {
          name: "/repo/a.test.ts",
          assertionResults: [
            { fullName: "慢的那条", status: "passed", duration: 1200 },
            { fullName: "快的那条", status: "failed", duration: 3 },
          ],
        },
      ],
    });
    expect(isParseProblem(parsed)).toBe(false);
    if (isParseProblem(parsed)) {
      return;
    }
    expect(parsed.totalTests).toBe(2);
    expect(parsed.outcomes).toHaveLength(2);
    expect(parsed.outcomes[0]?.durationMs).toBe(1200);
    expect(parsed.outcomes[1]?.status).toBe("failed");
  });

  it("形状不对时给结论而不是抛异常", () => {
    const parsed = parseVitestResults({ nothing: true });
    expect(isParseProblem(parsed)).toBe(true);
  });
});

describe("慢测试长尾", () => {
  it("按耗时倒序取前 N 条,并给分位", () => {
    const result = run([
      outcome("a", "passed", 10),
      outcome("b", "passed", 500),
      outcome("c", "passed", 300),
    ]);
    const [slow, quantiles] = slowTail(result, 2);
    expect(slow.map((entry) => entry.fullName)).toEqual(["b", "c"]);
    expect(slow[0]?.durationMs).toBe(500);
    expect(quantiles.max).toBe(500);
    expect(quantiles.p50).toBeGreaterThan(0);
  });

  it("反例:耗时全相等时,长尾仍是那些用例(不因并列而丢条目)", () => {
    const result = run([outcome("a", "passed", 100), outcome("b", "passed", 100)]);
    const [slow] = slowTail(result, 5);
    expect(slow).toHaveLength(2);
  });
});

describe("不稳定用例的判定", () => {
  it("两次状态不同 → 判不稳定", () => {
    const first = run([outcome("x", "failed", 10)]);
    const second = run([outcome("x", "passed", 10)]);
    const flaky = compareRuns(first, second);
    expect(flaky).toHaveLength(1);
    expect(flaky[0]?.firstStatus).toBe("failed");
    expect(flaky[0]?.secondStatus).toBe("passed");
  });

  it("两次都绿 → 不算不稳定", () => {
    const flaky = compareRuns(run([outcome("x", "passed", 10)]), run([outcome("x", "passed", 10)]));
    expect(flaky).toHaveLength(0);
  });

  it("两次都红 → 归「稳定失败」,不是不稳定", () => {
    const first = run([outcome("x", "failed", 10)]);
    const second = run([outcome("x", "failed", 10)]);
    expect(compareRuns(first, second)).toHaveLength(0);
    expect(consistentlyFailing(first, second)).toHaveLength(1);
  });

  it("只有一次出现的用例不参与判定", () => {
    const first = run([outcome("x", "passed", 10)]);
    const second = run([outcome("y", "passed", 10)]);
    expect(compareRuns(first, second)).toHaveLength(0);
  });

  it("同名但不同文件的两条用例不混", () => {
    const first = run([outcome("x", "failed", 10, "a.test.ts")]);
    const second = run([outcome("x", "passed", 10, "b.test.ts")]);
    expect(compareRuns(first, second)).toHaveLength(0);
  });
});
