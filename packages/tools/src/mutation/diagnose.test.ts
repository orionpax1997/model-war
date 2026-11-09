/**
 * 变异诊断判据的单测:**每条判据配一条能把它弄红的反例**。
 *
 * ── 断言对象是外部可观察量 ──────────────────────────────────────────────────
 *
 * 这里断言的是「一份给定的报告被算成了什么」:桶的归属、四个分数、标志的有无。
 * 不断言内部函数形状(不测「有没有某个私有小函数」),也不 spawn 进程。
 *
 * ── 反例的形态 ──────────────────────────────────────────────────────────────
 *
 * 诊断判据最容易出的错是**默默地把一桶并进另一桶**:不可测并进真缺口(于是低分片被误诊
 * 为测试弱)、超时并进真杀(于是「测试挂死」伪装成「测试抓得住」)、值替换并进逻辑
 * (于是等价变异体被算成该补测试的靶子)。所以每条桶的判定都各有一条反例:
 * 同一份夹具报告,在不同的归因表下必须落到不同的桶。
 */

import { describe, expect, it } from "vitest";

import {
  bucketOf,
  diagnoseShard,
  flattenMutants,
  realGap,
  unknownStatuses,
  type DiagnosableReport,
  type RawMutant,
  type StructuralAttribution,
} from "./diagnose.ts";
import { compileAttributions, globToRegExp } from "./structural-attribution.ts";

/** 一只变异体。字段只给诊断要用的那几个。 */
const mutant = (status: string, mutator: string, isStatic = false): RawMutant => ({
  status,
  mutatorName: mutator,
  static: isStatic,
  coveredBy: [],
  location: { start: { line: 1, column: 1 } },
});

/**
 * 夹具报告:一个文件一只变异体,覆盖八桶里的每一桶。
 *
 * 走 `files` 的键当文件名,不塞额外字段——`DiagnosedMutant.file` 由 `flattenMutants` 填。
 */
const FIXTURE: DiagnosableReport = {
  files: {
    "packages/engine/src/a.ts": {
      mutants: [
        mutant("Killed", "BlockStatement"),
        mutant("Killed", "StringLiteral"),
        mutant("Timeout", "BlockStatement"),
        mutant("Survived", "StringLiteral", true),
        mutant("Survived", "ObjectLiteral"),
        mutant("Survived", "ConditionalExpression"),
        mutant("NoCoverage", "StringLiteral"),
        mutant("NoCoverage", "StringLiteral"),
        mutant("RuntimeError", "BlockStatement"),
      ],
    },
  },
};

/** 只把 `packages/engine/src/a.ts` 判为不可测的归因表。 */
const attribution = (reason: string): StructuralAttribution => ({
  matches: (file) => file === "packages/engine/src/a.ts",
  reasonOf: (file) => (file === "packages/engine/src/a.ts" ? reason : undefined),
});

const noAttribution: StructuralAttribution = {
  matches: () => false,
  reasonOf: () => undefined,
};

describe("桶的判定", () => {
  it("八桶各归其位:真杀 / 超时 / 值 / 结构 / 逻辑 / 未覆盖 / 不可测 / 其它", () => {
    const attributions = attribution("测不到");
    const mutants = flattenMutants(FIXTURE);
    expect(mutants.map((m) => bucketOf(m, attributions))).toEqual([
      "killed",
      "killed",
      "timeout",
      "survived-value",
      "survived-structure",
      "survived-logic",
      "unobservable",
      "unobservable",
      "other",
    ]);
  });

  it("反例:没有归因表时,同样的两只 NoCoverage 必须落到「未覆盖·真」", () => {
    const mutants = flattenMutants(FIXTURE);
    const buckets = mutants.map((m) => bucketOf(m, noAttribution));
    expect(buckets.filter((b) => b === "uncovered")).toHaveLength(2);
    expect(buckets.filter((b) => b === "unobservable")).toHaveLength(0);
  });

  it("反例:值替换与结构替换不得混进「存活·逻辑」——那一桶是补测试的靶子", () => {
    const mutants = flattenMutants(FIXTURE);
    const buckets = mutants.map((m) => bucketOf(m, noAttribution));
    expect(buckets.filter((b) => b === "survived-logic")).toHaveLength(1);
    expect(buckets.filter((b) => b === "survived-value")).toHaveLength(1);
    expect(buckets.filter((b) => b === "survived-structure")).toHaveLength(1);
  });

  it("反例:超时不得算成真杀", () => {
    const mutants = flattenMutants(FIXTURE);
    expect(
      mutants.map((m) => bucketOf(m, noAttribution)).filter((b) => b === "timeout"),
    ).toHaveLength(1);
  });
});

describe("分数与口径", () => {
  const diagnosis = diagnoseShard("fixture", FIXTURE, attribution("测不到"));

  it("Stryker 口径:分子含超时,分母不含「其它」状态", () => {
    // 有效变异体 = 8(不含 RuntimeError 那一只);已检测 = 2 真杀 + 1 超时。
    expect(diagnosis.valid).toBe(8);
    expect(diagnosis.detected).toBe(3);
    expect(diagnosis.score).toBeCloseTo(37.5, 2);
  });

  it("去超时分:把「挂死」从分子里拿掉", () => {
    expect(diagnosis.scoreExcludingTimeout).toBeCloseTo(25, 2);
    expect(diagnosis.score).toBeGreaterThan(diagnosis.scoreExcludingTimeout);
  });

  it("可信分:真杀 / (真杀 + 真缺口);真缺口不含不可测、不含值替换", () => {
    // 真缺口 = 存活·结构 1 + 存活·逻辑 1 + 未覆盖·真 0 = 2;真杀 2 → 50%。
    expect(realGap(diagnosis.buckets)).toBe(2);
    expect(diagnosis.credibleScore).toBeCloseTo(50, 2);
  });

  it("反例:不可测不得计入真缺口(否则低分片被误诊成测试弱)", () => {
    const withAttribution = diagnoseShard("f", FIXTURE, attribution("测不到"));
    const without = diagnoseShard("f", FIXTURE, noAttribution);
    expect(realGap(withAttribution.buckets)).toBe(2);
    // 没有归因表时,两只 NoCoverage 变成真缺口 → 真缺口从 2 涨到 4。
    expect(realGap(without.buckets)).toBe(4);
    expect(without.credibleScore).toBeLessThan(withAttribution.credibleScore);
  });

  it("反例:空报告不得崩,也不得算出非零分", () => {
    const empty = diagnoseShard("empty", {}, noAttribution);
    expect(empty.valid).toBe(0);
    expect(empty.score).toBe(0);
    expect(empty.total).toBe(0);
    expect(empty.flags.map((f) => f.kind)).toEqual(["clean"]);
  });
});

describe("标志", () => {
  it("静态变异体占多数且有存活时,必须摆出「口径存疑」", () => {
    const report: DiagnosableReport = {
      files: {
        "packages/schema/src/x.ts": {
          mutants: [
            mutant("Survived", "StringLiteral", true),
            mutant("Survived", "StringLiteral", true),
            mutant("Killed", "StringLiteral"),
          ],
        },
      },
    };
    const diagnosis = diagnoseShard("schema", report, noAttribution);
    expect(diagnosis.staticMutants).toBe(2);
    expect(diagnosis.staticSurvivors).toBe(2);
    expect(diagnosis.flags.map((f) => f.kind)).toContain("static-doubt");
  });

  it("反例:静态变异体全被杀时不得报「口径存疑」", () => {
    const report: DiagnosableReport = {
      files: {
        "packages/schema/src/x.ts": {
          mutants: [
            mutant("Killed", "StringLiteral", true),
            mutant("Killed", "StringLiteral", true),
            mutant("Killed", "StringLiteral"),
          ],
        },
      },
    };
    const diagnosis = diagnoseShard("schema", report, noAttribution);
    expect(diagnosis.flags.map((f) => f.kind)).not.toContain("static-doubt");
  });

  it("超时占比超阈值时必须报「超时噪声」", () => {
    const report: DiagnosableReport = {
      files: {
        "packages/engine/src/q.ts": {
          mutants: [
            mutant("Timeout", "BlockStatement"),
            mutant("Timeout", "BlockStatement"),
            mutant("Killed", "BlockStatement"),
          ],
        },
      },
    };
    const diagnosis = diagnoseShard("q", report, noAttribution);
    expect(diagnosis.flags.map((f) => f.kind)).toContain("timeout-noise");
  });

  it("反例:超时占比低时不得报「超时噪声」", () => {
    // 1/20 = 5%,正好在阈值上;再多一只就跨过去了,所以这里用 1/21 = 4.8%。
    const report: DiagnosableReport = {
      files: {
        "packages/engine/src/q.ts": {
          mutants: [
            mutant("Timeout", "BlockStatement"),
            ...Array.from({ length: 20 }, () => mutant("Killed", "BlockStatement")),
          ],
        },
      },
    };
    const diagnosis = diagnoseShard("q", report, noAttribution);
    expect(diagnosis.flags.map((f) => f.kind)).not.toContain("timeout-noise");
  });
});

describe("结构归因表", () => {
  it("`/**` 匹配零层与多层目录", () => {
    const regex = globToRegExp("packages/tools/src/**");
    expect(regex.test("packages/tools/src/gate/x.ts")).toBe(true);
    expect(regex.test("packages/tools/src/a/b/c/x.ts")).toBe(true);
    expect(regex.test("packages/tools/src")).toBe(false);
  });

  it("反例:`*` 不跨目录层", () => {
    const regex = globToRegExp("packages/tools/src/*.ts");
    expect(regex.test("packages/tools/src/x.ts")).toBe(true);
    expect(regex.test("packages/tools/src/gate/x.ts")).toBe(false);
  });

  it("反例:一张空表不得把所有文件判成不可测", () => {
    const compiled = compileAttributions([]);
    expect(compiled.matches("packages/engine/src/a.ts")).toBe(false);
    expect(compiled.reasonOf("packages/engine/src/a.ts")).toBeUndefined();
  });

  it("反例:一张命中所有文件的表不得把所有文件判成不可测——它得真匹配", () => {
    const compiled = compileAttributions([
      { kind: "spawn-only", pattern: "packages/engine/**", reason: "只被 spawn 观察" },
    ]);
    expect(compiled.matches("packages/engine/src/a.ts")).toBe(true);
    expect(compiled.matches("packages/schema/src/a.ts")).toBe(false);
    expect(compiled.reasonOf("packages/engine/src/a.ts")).toContain("spawn");
  });
});

describe("报告范围", () => {
  const oneFile: DiagnosableReport = {
    config: { mutate: ["packages/schema/src/processor/economy.ts"] },
    files: {
      "packages/schema/src/processor/economy.ts": { mutants: [mutant("Killed", "BlockStatement")] },
    },
  };
  const declared = ["packages/schema/src/**/*.ts", "!packages/schema/src/**/*.test.ts"];

  it("报告只标定字面路径、分片声明的范围带通配时,必须报「报告不是全范围跑」", () => {
    const diagnosis = diagnoseShard("x", oneFile, noAttribution, { declaredScope: declared });
    expect(diagnosis.flags.map((f) => f.kind)).toContain("scope-partial");
  });

  it("反例:报告范围与声明范围一致(都带通配)时不得报这一条", () => {
    const full: DiagnosableReport = {
      config: { mutate: declared },
      files: { "packages/schema/src/a.ts": { mutants: [mutant("Killed", "BlockStatement")] } },
    };
    const diagnosis = diagnoseShard("x", full, noAttribution, { declaredScope: declared });
    expect(diagnosis.flags.map((f) => f.kind)).not.toContain("scope-partial");
  });

  it("反例:分片本身声明的就是单个文件时不得报这一条", () => {
    const single = ["packages/gen/src/pipeline.ts"];
    const diagnosis = diagnoseShard("gen-pipeline", oneFile, noAttribution, {
      declaredScope: single,
    });
    expect(diagnosis.flags.map((f) => f.kind)).not.toContain("scope-partial");
  });
});

describe("未知状态", () => {
  it("不认识的 Stryker 状态必须被列出来,不得默默算进某一桶", () => {
    const report: DiagnosableReport = {
      files: {
        "packages/engine/src/a.ts": { mutants: [mutant("CompileError", "BlockStatement")] },
      },
    };
    expect(unknownStatuses(report)).toEqual(["CompileError"]);
    const diagnosis = diagnoseShard("a", report, noAttribution);
    expect(diagnosis.buckets.other).toBe(1);
    expect(diagnosis.valid).toBe(0);
  });
});
