import { describe, expect, it } from "vitest";
import { scanConditionalExpects } from "./conditional-expect.ts";
import { diagnoseVitestRules } from "./diagnose-vitest-rules.ts";

describe("条件断言扫描", () => {
  it("`expect` 写在 if 分支里,形态是守卫", () => {
    const scan = scanConditionalExpects(`it("x", () => {
      if (value) {
        expect(value).toBe(1);
      }
    });`);
    const guarded = scan.sites.filter((site) => site.shape !== "plain");
    expect(guarded).toHaveLength(1);
    expect(guarded[0]?.shape).toBe("if-guard");
    expect(guarded[0]?.conditionText).toBe("value");
  });

  it("断言全在守卫里 → 该用例可能零断言执行", () => {
    const scan = scanConditionalExpects(`it("x", () => {
      if (value) {
        expect(value).toBe(1);
      }
    });`);
    expect(scan.cases[0]?.verdict).toBe("all-conditional");
  });

  it("断言一部分在守卫里 → 部分盲区,不是零断言", () => {
    const scan = scanConditionalExpects(`it("x", () => {
      expect(a).toBe(1);
      if (value) {
        expect(value).toBe(1);
      }
    });`);
    expect(scan.cases[0]?.verdict).toBe("partly-conditional");
    expect(scan.cases[0]?.total).toBe(2);
    expect(scan.cases[0]?.conditional).toBe(1);
  });

  it("断言都在循环体里 → 逐元素检查,不算守卫", () => {
    const scan = scanConditionalExpects(`it("x", () => {
      for (const item of items) {
        expect(item).toBeGreaterThan(0);
      }
    });`);
    expect(scan.cases[0]?.verdict).toBe("loop-only");
    expect(scan.cases[0]?.inLoop).toBe(1);
    expect(scan.cases[0]?.conditional).toBe(0);
  });

  it("无条件断言 → 不算守卫", () => {
    const scan = scanConditionalExpects(`it("x", () => {
      expect(a).toBe(1);
    });`);
    expect(scan.sites[0]?.shape).toBe("plain");
    expect(scan.cases[0]?.verdict).toBe("none");
  });
});

describe("早退(规则看不见的那一类)", () => {
  it("断言在前的类型收窄惯用法不算静默跳过", () => {
    const scan = scanConditionalExpects(`it("x", () => {
      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") {
        return;
      }
      expect(outcome.failure).toBeDefined();
    });`);
    expect(scan.silentSkips).toHaveLength(0);
  });

  it("用例体本身早退 → 作用域是整条用例", () => {
    const scan = scanConditionalExpects(`it("x", () => {
      if (raw === undefined) {
        return;
      }
      expect(raw).toBeDefined();
    });`);
    expect(scan.silentSkips).toHaveLength(1);
    expect(scan.silentSkips[0]?.scope).toBe("case");
  });

  it("辅助函数里早退 → 作用域是局部", () => {
    const scan = scanConditionalExpects(`it("x", () => {
      const read = (): string | undefined => {
        if (raw === undefined) {
          return undefined;
        }
        return raw;
      };
      expect(read()).toBeDefined();
    });`);
    expect(scan.silentSkips).toHaveLength(1);
    expect(scan.silentSkips[0]?.scope).toBe("local");
  });

  it("catch 里的早退单列成 catch 分流", () => {
    const scan = scanConditionalExpects(`it("x", () => {
      try {
        run();
      } catch (cause) {
        if (cause instanceof TransportError) {
          return;
        }
        throw cause;
      }
      expect(done).toBe(true);
    });`);
    expect(scan.silentSkips[0]?.kind).toBe("catch-filter");
  });
});

describe("解析失败", () => {
  it("解析不过就不给结论(残树上的结论不可复现)", () => {
    const scan = scanConditionalExpects("const = = =;");
    expect(scan.parseErrors.length).toBeGreaterThan(0);
    expect(scan.sites).toHaveLength(0);
    expect(scan.cases).toHaveLength(0);
  });
});

describe("全仓汇总", () => {
  const zeroAssertion = `it("x", () => {
    if (value) {
      expect(value).toBe(1);
    }
  });`;
  const healthy = `it("y", () => {
    expect(a).toBe(1);
  });`;

  it("零断言用例被数出来", () => {
    const diagnosis = diagnoseVitestRules(
      new Map([
        ["a.test.ts", zeroAssertion],
        ["b.test.ts", healthy],
      ]),
    );
    expect(diagnosis.zeroAssertionCases).toHaveLength(1);
    expect(diagnosis.zeroAssertionCases[0]?.testName).toBe("x");
    expect(diagnosis.caseVerdicts["all-conditional"]).toBe(1);
    expect(diagnosis.caseVerdicts.none).toBe(1);
  });

  it("反例:把守卫里的断言改成无条件 → 零断言用例归零", () => {
    const fixed = `it("x", () => {
      expect(value).toBe(1);
    });`;
    const diagnosis = diagnoseVitestRules(new Map([["a.test.ts", fixed]]));
    expect(diagnosis.zeroAssertionCases).toHaveLength(0);
    expect(diagnosis.caseVerdicts["all-conditional"]).toBe(0);
  });

  it("解析不过的文件不进结论,但被记进 parseErrors", () => {
    const diagnosis = diagnoseVitestRules(
      new Map([
        ["bad.test.ts", "const = = =;"],
        ["ok.test.ts", healthy],
      ]),
    );
    expect(diagnosis.parseErrors).toHaveLength(1);
    expect(diagnosis.files).toHaveLength(2);
    expect(diagnosis.caseVerdicts.none).toBe(1);
  });
});
